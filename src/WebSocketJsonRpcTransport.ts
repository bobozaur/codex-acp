import crypto from "node:crypto";
import {TextDecoder} from "node:util";
import {Readable, Writable} from "node:stream";
import {Emitter} from "vscode-jsonrpc/node";
import type {DataCallback, Disposable, Message, MessageReader, MessageWriter, PartialMessageInfo} from "vscode-jsonrpc/node";
import {tagAppServerRequest} from "./AppServerRequestContext";

const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_HANDSHAKE_BYTES = 16 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_WRITE_BYTES = 64 * 1024 * 1024;

interface PendingMessage {
    message: Message;
    frame: Buffer;
    resolve: () => void;
    reject: (error: Error) => void;
}

interface FragmentedMessage {
    opcode: number;
    fragments: Buffer[];
    length: number;
}

interface QueuedWrite {
    buffer: Buffer;
    message: Message | undefined;
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
}

export interface WebSocketJsonRpcTransport {
    reader: MessageReader & {deliver(message: Message): void};
    writer: MessageWriter;
}

export interface WebSocketJsonRpcTransportOptions {
    handshakeTimeoutMs?: number;
    maxHandshakeBytes?: number;
    maxPayloadBytes?: number;
    maxQueuedWriteBytes?: number;
}

export function createWebSocketJsonRpcTransport(
    readable: Readable,
    writable: Writable,
    options: WebSocketJsonRpcTransportOptions = {},
): WebSocketJsonRpcTransport {
    const handshakeTimeoutMs = validateNonNegativeInteger(
        "handshakeTimeoutMs",
        options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    const maxHandshakeBytes = validatePositiveInteger(
        "maxHandshakeBytes",
        options.maxHandshakeBytes ?? DEFAULT_MAX_HANDSHAKE_BYTES,
    );
    const maxPayloadBytes = validatePositiveInteger(
        "maxPayloadBytes",
        options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    );
    const maxQueuedWriteBytes = validatePositiveInteger(
        "maxQueuedWriteBytes",
        options.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES,
    );

    const readerError = new Emitter<Error>();
    const readerClose = new Emitter<void>();
    const readerPartialMessage = new Emitter<PartialMessageInfo>();
    const writerError = new Emitter<[Error, Message | undefined, number | undefined]>();
    const writerClose = new Emitter<void>();

    const websocketKey = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
        .createHash("sha1")
        .update(websocketKey + WEBSOCKET_ACCEPT_GUID)
        .digest("base64");

    let disposed = false;
    let ending = false;
    let failureInProgress = false;
    let handshakeComplete = false;
    let closeSent = false;
    let inputStorage = Buffer.alloc(0);
    let inputBuffer = inputStorage;
    let messageCallback: DataCallback | null = null;
    let fragmentedMessage: FragmentedMessage | null = null;
    let pendingOutgoingBytes = 0;
    let queuedWriteBytes = 0;
    let activeWrite: QueuedWrite | null = null;
    const pendingIncoming: Message[] = [];
    const pendingOutgoing: PendingMessage[] = [];
    const writeQueue: QueuedWrite[] = [];
    const utf8Decoder = new TextDecoder("utf-8", {fatal: true});
    const handshakeTimer = handshakeTimeoutMs === 0
        ? null
        : setTimeout(() => {
            fail(new Error(`App-server WebSocket handshake timed out after ${handshakeTimeoutMs}ms`));
        }, handshakeTimeoutMs);
    handshakeTimer?.unref();

    function fail(error: Error, message?: Message, closeCode = 1002): void {
        if (disposed || failureInProgress) {
            return;
        }
        failureInProgress = true;
        readerError.fire(error);
        writerError.fire([error, message, undefined]);
        const closePayload = handshakeComplete ? createClosePayload(closeCode) : null;
        disposeInternal(error);
        terminateWritable(closePayload);
    }

    function enqueueRaw(buffer: Buffer, message?: Message, allowWhileEnding = false): Promise<void> {
        if (disposed || (ending && !allowWhileEnding)) {
            return Promise.reject(new Error("WebSocket transport is closed"));
        }
        if (queuedWriteBytes + buffer.length > maxQueuedWriteBytes) {
            throw new Error(`WebSocket write queue exceeded ${maxQueuedWriteBytes} bytes`);
        }

        queuedWriteBytes += buffer.length;
        const promise = new Promise<void>((resolve, reject) => {
            writeQueue.push({buffer, message, resolve, reject, settled: false});
        });
        pumpWrites();
        return promise;
    }

    function pumpWrites(): void {
        if (disposed || activeWrite || writeQueue.length === 0) {
            return;
        }

        const entry = writeQueue.shift()!;
        activeWrite = entry;
        try {
            writable.write(entry.buffer, (error?: Error | null) => {
                completeWrite(entry, error ? toError(error) : null);
            });
        } catch (error) {
            completeWrite(entry, toError(error));
        }
    }

    function completeWrite(entry: QueuedWrite, error: Error | null): void {
        if (entry.settled) {
            return;
        }
        entry.settled = true;
        queuedWriteBytes -= entry.buffer.length;
        if (activeWrite === entry) {
            activeWrite = null;
        }

        if (error) {
            entry.reject(error);
            fail(error, entry.message);
            return;
        }

        entry.resolve();
        pumpWrites();
    }

    function flushPendingOutgoing(): void {
        while (!disposed && pendingOutgoing.length > 0) {
            const pending = pendingOutgoing.shift()!;
            pendingOutgoingBytes -= pending.frame.length;
            try {
                void enqueueRaw(pending.frame, pending.message).then(pending.resolve, pending.reject);
            } catch (error) {
                const writeError = toError(error);
                pending.reject(writeError);
                fail(writeError, pending.message, 1009);
            }
        }
    }

    function sendJsonMessage(message: Message): Promise<void> {
        if (disposed || ending) {
            return Promise.reject(new Error("WebSocket transport is closed"));
        }

        let outgoing: Message;
        let payload: Buffer;
        try {
            outgoing = sanitizeOutgoingMessage(message);
            const json = JSON.stringify(outgoing);
            if (json === undefined) {
                throw new Error("JSON-RPC message cannot be serialized");
            }
            payload = Buffer.from(json, "utf8");
        } catch (error) {
            const writeError = toError(error);
            writerError.fire([writeError, message, undefined]);
            return Promise.reject(writeError);
        }

        if (payload.length > maxPayloadBytes) {
            const writeError = new Error(`WebSocket message exceeds the ${maxPayloadBytes} byte payload limit`);
            writerError.fire([writeError, outgoing, undefined]);
            return Promise.reject(writeError);
        }

        const frame = encodeFrame(0x1, payload, true);
        if (!handshakeComplete) {
            if (pendingOutgoingBytes + frame.length > maxQueuedWriteBytes) {
                const writeError = new Error(`WebSocket write queue exceeded ${maxQueuedWriteBytes} bytes`);
                writerError.fire([writeError, outgoing, undefined]);
                return Promise.reject(writeError);
            }
            pendingOutgoingBytes += frame.length;
            return new Promise<void>((resolve, reject) => {
                pendingOutgoing.push({message: outgoing, frame, resolve, reject});
            });
        }

        try {
            return enqueueRaw(frame, outgoing);
        } catch (error) {
            const writeError = toError(error);
            writerError.fire([writeError, outgoing, undefined]);
            return Promise.reject(writeError);
        }
    }

    function sendControlFrame(opcode: number, payload: Buffer): void {
        try {
            void enqueueRaw(encodeFrame(opcode, payload, true)).catch((error: unknown) => {
                if (!disposed) {
                    fail(toError(error));
                }
            });
        } catch (error) {
            fail(toError(error), undefined, 1009);
        }
    }

    function dispatchMessage(message: Message): void {
        const candidate = message as {id?: unknown, method?: unknown, params?: unknown};
        if ((typeof candidate.id === "string" || typeof candidate.id === "number")
            && typeof candidate.method === "string") {
            tagAppServerRequest(candidate.params, candidate.id);
        }
        if (messageCallback) {
            messageCallback(message);
            return;
        }
        pendingIncoming.push(message);
    }

    function appendInput(chunk: Buffer): void {
        const bufferedLength = inputBuffer.length;
        const requiredLength = bufferedLength + chunk.length;
        let offset = inputBuffer.byteOffset - inputStorage.byteOffset;
        if (offset + requiredLength > inputStorage.length) {
            // Grow geometrically so a large frame arriving in many pipe reads
            // does not copy its entire incomplete payload on every read.
            const storage = requiredLength > inputStorage.length
                ? Buffer.allocUnsafe(Math.max(requiredLength, inputStorage.length * 2))
                : inputStorage;
            inputBuffer.copy(storage);
            inputStorage = storage;
            offset = 0;
        }
        chunk.copy(inputStorage, offset + bufferedLength);
        inputBuffer = inputStorage.subarray(offset, offset + requiredLength);
    }

    function handleData(chunk: Buffer | string): void {
        if (disposed) {
            return;
        }
        appendInput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

        if (!handshakeComplete) {
            const headerEnd = inputBuffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                if (inputBuffer.length > maxHandshakeBytes) {
                    fail(new Error(`App-server WebSocket handshake exceeded ${maxHandshakeBytes} bytes`));
                }
                return;
            }
            if (headerEnd + 4 > maxHandshakeBytes) {
                fail(new Error(`App-server WebSocket handshake exceeded ${maxHandshakeBytes} bytes`));
                return;
            }

            const headerText = inputBuffer.subarray(0, headerEnd).toString("utf8");
            inputBuffer = inputBuffer.subarray(headerEnd + 4);
            try {
                validateHandshake(headerText, expectedAccept);
            } catch (error) {
                fail(toError(error));
                return;
            }
            handshakeComplete = true;
            if (handshakeTimer) {
                clearTimeout(handshakeTimer);
            }
            flushPendingOutgoing();
        }

        parseFrames();
        if (inputBuffer.length === 0) {
            // Release capacity after complete messages instead of retaining the
            // largest history response for the lifetime of the connection.
            inputStorage = Buffer.alloc(0);
            inputBuffer = inputStorage;
        }
    }

    function parseFrames(): void {
        while (!disposed && inputBuffer.length >= 2) {
            const firstByte = inputBuffer[0]!;
            const secondByte = inputBuffer[1]!;
            const fin = (firstByte & 0x80) !== 0;
            const rsv = firstByte & 0x70;
            const opcode = firstByte & 0x0f;
            const masked = (secondByte & 0x80) !== 0;
            const lengthIndicator = secondByte & 0x7f;
            const isControlFrame = (opcode & 0x08) !== 0;
            let payloadLength = lengthIndicator;
            let offset = 2;

            if (rsv !== 0) {
                fail(new Error("Received a WebSocket frame with unsupported RSV bits"));
                return;
            }
            if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
                fail(new Error(`Unsupported WebSocket opcode ${opcode}`));
                return;
            }
            if (masked) {
                fail(new Error("App-server WebSocket frames must not be masked"));
                return;
            }
            if (isControlFrame && !fin) {
                fail(new Error("WebSocket control frames must not be fragmented"));
                return;
            }
            if (isControlFrame && lengthIndicator > 125) {
                fail(new Error("WebSocket control frame payload exceeds 125 bytes"));
                return;
            }

            if (lengthIndicator === 126) {
                if (inputBuffer.length < offset + 2) {
                    return;
                }
                payloadLength = inputBuffer.readUInt16BE(offset);
                offset += 2;
                if (payloadLength < 126) {
                    fail(new Error("WebSocket frame used a non-minimal payload length"));
                    return;
                }
            } else if (lengthIndicator === 127) {
                if (inputBuffer.length < offset + 8) {
                    return;
                }
                const longLength = inputBuffer.readBigUInt64BE(offset);
                if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                    fail(new Error("WebSocket frame is too large"), undefined, 1009);
                    return;
                }
                payloadLength = Number(longLength);
                offset += 8;
                if (payloadLength < 65536) {
                    fail(new Error("WebSocket frame used a non-minimal payload length"));
                    return;
                }
            }

            if (payloadLength > maxPayloadBytes) {
                fail(new Error(`WebSocket frame exceeds the ${maxPayloadBytes} byte payload limit`), undefined, 1009);
                return;
            }
            if (inputBuffer.length < offset + payloadLength) {
                return;
            }

            const payload = Buffer.from(inputBuffer.subarray(offset, offset + payloadLength));
            inputBuffer = inputBuffer.subarray(offset + payloadLength);
            handleFrame(opcode, fin, payload);
        }
    }

    function handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
        switch (opcode) {
            case 0x0:
                handleContinuationFrame(fin, payload);
                return;
            case 0x1:
                handleTextFrame(fin, payload);
                return;
            case 0x2:
                fail(new Error("Binary WebSocket messages are not supported"), undefined, 1003);
                return;
            case 0x8:
                handleCloseFrame(payload);
                return;
            case 0x9:
                sendControlFrame(0xa, payload);
                return;
            case 0xa:
                return;
        }
    }

    function handleTextFrame(fin: boolean, payload: Buffer): void {
        if (fragmentedMessage) {
            fail(new Error("Received a new text frame before the fragmented message completed"));
            return;
        }
        if (!fin) {
            fragmentedMessage = {opcode: 0x1, fragments: [payload], length: payload.length};
            return;
        }
        handleTextPayload(payload);
    }

    function handleContinuationFrame(fin: boolean, payload: Buffer): void {
        if (!fragmentedMessage) {
            fail(new Error("Received a WebSocket continuation frame without a starting frame"));
            return;
        }
        if (fragmentedMessage.length + payload.length > maxPayloadBytes) {
            fail(new Error(`Fragmented WebSocket message exceeds the ${maxPayloadBytes} byte payload limit`), undefined, 1009);
            return;
        }
        fragmentedMessage.fragments.push(payload);
        fragmentedMessage.length += payload.length;
        if (!fin) {
            return;
        }
        const message = fragmentedMessage;
        fragmentedMessage = null;
        if (message.opcode !== 0x1) {
            fail(new Error("Unsupported fragmented WebSocket message type"));
            return;
        }
        handleTextPayload(Buffer.concat(message.fragments, message.length));
    }

    function handleTextPayload(payload: Buffer): void {
        let text: string;
        try {
            text = utf8Decoder.decode(payload);
        } catch (error) {
            fail(new Error(`App-server WebSocket message is not valid UTF-8: ${toError(error).message}`), undefined, 1007);
            return;
        }

        try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("JSON-RPC message must be an object");
            }
            const message = parsed as Message & {jsonrpc?: string};
            if (message.jsonrpc === undefined) {
                message.jsonrpc = "2.0";
            }
            dispatchMessage(message);
        } catch (error) {
            fail(new Error(`Invalid app-server JSON message: ${toError(error).message}`), undefined, 1007);
        }
    }

    function handleCloseFrame(payload: Buffer): void {
        if (payload.length === 1) {
            fail(new Error("WebSocket close frame has an invalid one-byte payload"));
            return;
        }
        if (payload.length >= 2) {
            const closeCode = payload.readUInt16BE(0);
            if (!isValidCloseCode(closeCode)) {
                fail(new Error(`WebSocket close frame has invalid status code ${closeCode}`));
                return;
            }
            try {
                utf8Decoder.decode(payload.subarray(2));
            } catch (error) {
                fail(new Error(`WebSocket close reason is not valid UTF-8: ${toError(error).message}`), undefined, 1007);
                return;
            }
        }

        disposeInternal(new Error("App-server closed the WebSocket connection"));
        terminateWritable(payload);
    }

    function disposeInternal(reason?: Error): void {
        if (disposed) {
            return;
        }
        disposed = true;
        ending = true;
        inputStorage = Buffer.alloc(0);
        inputBuffer = inputStorage;
        fragmentedMessage = null;
        if (handshakeTimer) {
            clearTimeout(handshakeTimer);
        }
        readable.off("data", handleData);
        readable.off("error", handleReadableError);
        readable.off("close", handleReadableClose);
        writable.off("error", handleWritableError);
        writable.off("close", handleWritableClose);

        while (pendingOutgoing.length > 0) {
            const pending = pendingOutgoing.shift()!;
            if (reason) {
                pending.reject(reason);
            } else {
                pending.resolve();
            }
        }
        pendingOutgoingBytes = 0;

        if (activeWrite && !activeWrite.settled) {
            activeWrite.settled = true;
            if (reason) {
                activeWrite.reject(reason);
            } else {
                activeWrite.resolve();
            }
        }
        activeWrite = null;
        while (writeQueue.length > 0) {
            const entry = writeQueue.shift()!;
            if (!entry.settled) {
                entry.settled = true;
                if (reason) {
                    entry.reject(reason);
                } else {
                    entry.resolve();
                }
            }
        }
        queuedWriteBytes = 0;

        readerClose.fire();
        writerClose.fire();
    }

    function terminateWritable(closePayload: Buffer | null): void {
        const ignoreError = () => {};
        writable.on("error", ignoreError);
        writable.once("close", () => writable.off("error", ignoreError));

        if (closePayload && !closeSent && !writable.destroyed && !writable.writableEnded) {
            closeSent = true;
            try {
                writable.write(encodeFrame(0x8, closePayload, true), () => endWritable());
                return;
            } catch {
                // Fall through and end the stream without a close frame.
            }
        }
        endWritable();
    }

    function endWritable(): void {
        if (writable.destroyed || writable.writableEnded) {
            return;
        }
        try {
            writable.end();
        } catch {
            // The transport has already surfaced the failure that led here.
        }
    }

    function handleReadableError(error: Error): void {
        fail(error);
    }

    function handleReadableClose(): void {
        disposeInternal(new Error("App-server WebSocket input closed"));
    }

    function handleWritableError(error: Error): void {
        fail(error);
    }

    function handleWritableClose(): void {
        if (writable.writableFinished) {
            // Ending the proxy's stdin still lets it write its final frames to stdout.
            ending = true;
            return;
        }
        disposeInternal(new Error("App-server WebSocket output closed"));
    }

    readable.on("data", handleData);
    readable.on("error", handleReadableError);
    readable.on("close", handleReadableClose);
    writable.on("error", handleWritableError);
    writable.on("close", handleWritableClose);

    try {
        void enqueueRaw(Buffer.from(createHandshakeRequest(websocketKey), "utf8")).catch(() => {
            // The write pump reports handshake write failures through fail().
        });
    } catch (error) {
        fail(toError(error));
    }

    return {
        reader: {
            deliver: dispatchMessage,
            listen(callback: DataCallback): Disposable {
                messageCallback = callback;
                while (pendingIncoming.length > 0) {
                    callback(pendingIncoming.shift()!);
                }
                return {
                    dispose() {
                        if (messageCallback === callback) {
                            messageCallback = null;
                        }
                    },
                };
            },
            onError: readerError.event,
            onClose: readerClose.event,
            onPartialMessage: readerPartialMessage.event,
            dispose: disposeInternal,
        },
        writer: {
            write(message: Message) {
                return sendJsonMessage(message);
            },
            end() {
                if (disposed || ending) {
                    return;
                }
                ending = true;
                if (!handshakeComplete) {
                    disposeInternal(new Error("WebSocket transport ended before the handshake completed"));
                    terminateWritable(null);
                    return;
                }

                closeSent = true;
                let closeWrite: Promise<void>;
                try {
                    closeWrite = enqueueRaw(encodeFrame(0x8, Buffer.alloc(0), true), undefined, true);
                } catch (error) {
                    fail(toError(error));
                    return;
                }
                void closeWrite.then(
                    () => {
                        disposeInternal(new Error("WebSocket transport ended"));
                        endWritable();
                    },
                    () => {
                        // The write pump reports the error and terminates the stream.
                    },
                );
            },
            onError: writerError.event,
            onClose: writerClose.event,
            dispose: disposeInternal,
        },
    };
}

function createHandshakeRequest(websocketKey: string): string {
    return [
        "GET / HTTP/1.1",
        "Host: localhost",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${websocketKey}`,
        "",
        "",
    ].join("\r\n");
}

function validateHandshake(headerText: string, expectedAccept: string): void {
    const lines = headerText.split("\r\n");
    const statusLine = lines.shift() ?? "";
    if (!/^HTTP\/1\.[01] 101(?:\s|$)/i.test(statusLine)) {
        throw new Error(`App-server WebSocket handshake failed: ${statusLine}`);
    }

    const headers = new Map<string, string>();
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator < 0) {
            continue;
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }

    if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new Error("App-server WebSocket handshake did not include Upgrade: websocket");
    }
    const connectionTokens = headers.get("connection")?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
    if (!connectionTokens.includes("upgrade")) {
        throw new Error("App-server WebSocket handshake did not include Connection: Upgrade");
    }
    const actualAccept = headers.get("sec-websocket-accept");
    if (actualAccept !== expectedAccept) {
        throw new Error("App-server WebSocket handshake returned an invalid Sec-WebSocket-Accept header");
    }
}

function sanitizeOutgoingMessage(message: Message): Message {
    if (message && typeof message === "object") {
        const copy = {...message};
        delete (copy as Record<string, unknown>)["jsonrpc"];
        return copy;
    }
    return message;
}

function encodeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
    let headerLength = 2;
    if (payload.length >= 126 && payload.length < 65536) {
        headerLength += 2;
    } else if (payload.length >= 65536) {
        headerLength += 8;
    }
    if (masked) {
        headerLength += 4;
    }

    const frame = Buffer.alloc(headerLength + payload.length);
    let offset = 0;
    frame[offset++] = 0x80 | opcode;
    if (payload.length < 126) {
        frame[offset++] = (masked ? 0x80 : 0) | payload.length;
    } else if (payload.length < 65536) {
        frame[offset++] = (masked ? 0x80 : 0) | 126;
        frame.writeUInt16BE(payload.length, offset);
        offset += 2;
    } else {
        frame[offset++] = (masked ? 0x80 : 0) | 127;
        frame.writeBigUInt64BE(BigInt(payload.length), offset);
        offset += 8;
    }

    if (!masked) {
        payload.copy(frame, offset);
        return frame;
    }

    const mask = crypto.randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < payload.length; index += 1) {
        frame[offset + index] = payload[index]! ^ mask[index % 4]!;
    }
    return frame;
}

function createClosePayload(code: number): Buffer {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    return payload;
}

function isValidCloseCode(code: number): boolean {
    return code >= 1000
        && code <= 4999
        && ![1004, 1005, 1006, 1015].includes(code);
}

function validatePositiveInteger(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function validateNonNegativeInteger(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
