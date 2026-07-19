import crypto from "node:crypto";
import {PassThrough, Writable} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Message} from "vscode-jsonrpc/node";
import {
    createWebSocketJsonRpcTransport,
    type WebSocketJsonRpcTransport,
    type WebSocketJsonRpcTransportOptions,
} from "../WebSocketJsonRpcTransport";

const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface DecodedFrame {
    fin: boolean;
    opcode: number;
    masked: boolean;
    payload: Buffer;
}

interface TransportFixture {
    readable: PassThrough;
    writable: PassThrough;
    transport: WebSocketJsonRpcTransport;
    clientBytes: () => Buffer;
    clientFrames: () => DecodedFrame[];
    handshakeResponse: () => Buffer;
    completeHandshake: () => void;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("WebSocketJsonRpcTransport", () => {
    it("queues messages written before the handshake and resolves after the frame is written", async () => {
        const fixture = createFixture();
        const write = fixture.transport.writer.write(rpcMessage({id: 7, method: "thread/read", params: {threadId: "one"}}));

        let resolved = false;
        void write.then(() => {
            resolved = true;
        });
        await nextTurn();

        expect(resolved).toBe(false);
        expect(fixture.clientFrames()).toEqual([]);

        fixture.completeHandshake();
        await write;

        expect(resolved).toBe(true);
        expect(fixture.clientFrames()).toHaveLength(1);
        expect(fixture.clientFrames()[0]).toMatchObject({fin: true, opcode: 0x1, masked: true});
        expect(JSON.parse(fixture.clientFrames()[0]!.payload.toString("utf8"))).toEqual({
            id: 7,
            method: "thread/read",
            params: {threadId: "one"},
        });
    });

    it("accepts a split handshake whose final chunk is coalesced with a text frame", async () => {
        const fixture = createFixture();
        const messages: Message[] = [];
        fixture.transport.reader.listen((message) => messages.push(message));
        const response = fixture.handshakeResponse();
        const incoming = serverFrame(0x1, Buffer.from(JSON.stringify({method: "thread/started", params: {threadId: "one"}})));

        fixture.readable.write(response.subarray(0, 19));
        expect(messages).toEqual([]);
        fixture.readable.write(Buffer.concat([response.subarray(19), incoming]));
        await nextTurn();

        expect(messages).toEqual([{
            jsonrpc: "2.0",
            method: "thread/started",
            params: {threadId: "one"},
        }]);
    });

    it("receives a near-limit history response in pipe chunks with a linear copy budget", () => {
        const fixture = createFixture();
        const messages: Message[] = [];
        fixture.transport.reader.listen((message) => messages.push(message));
        fixture.completeHandshake();
        const response = {id: 1, result: {text: "x".repeat(16 * 1024 * 1024 - 256)}};
        const frame = serverFrame(0x1, Buffer.from(JSON.stringify(response)));
        const concatenate = vi.spyOn(Buffer, "concat");
        const copy = vi.spyOn(Buffer.prototype, "copy");
        let copiedBytes = 0;

        try {
            for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
                fixture.readable.write(frame.subarray(offset, offset + 64 * 1024));
                // Count copied bytes instead of wall-clock time so repeated
                // full-frame accumulation fails even on fast machines.
                copiedBytes += concatenate.mock.results.reduce((total, result) => (
                    total + (result.type === "return" ? result.value.length : 0)
                ), 0) + copy.mock.results.reduce((total, result) => (
                    total + (result.type === "return" ? result.value : 0)
                ), 0);
                // Do not retain earlier buffers in the spies while measuring.
                concatenate.mockClear();
                copy.mockClear();
            }
        } finally {
            concatenate.mockRestore();
            copy.mockRestore();
            fixture.transport.reader.dispose();
        }

        expect(messages).toEqual([{jsonrpc: "2.0", ...response}]);
        expect(copiedBytes).toBeLessThanOrEqual(frame.length * 4);
    });

    it("preserves coalesced messages when extended headers arrive across pipe reads", () => {
        const fixture = createFixture();
        const messages: Message[] = [];
        fixture.transport.reader.listen((message) => messages.push(message));
        fixture.completeHandshake();
        const responses = [
            {id: 1, result: "first"},
            {id: 2, result: "x".repeat(256)},
            {id: 3, result: "🙂".repeat(20_000)},
            {id: 4, result: "last"},
        ];
        const frames = responses.map((response) => serverFrame(0x1, Buffer.from(JSON.stringify(response))));

        fixture.readable.write(Buffer.concat([frames[0]!, frames[1]!.subarray(0, 1)]));
        fixture.readable.write(frames[1]!.subarray(1, 2));
        fixture.readable.write(frames[1]!.subarray(2, 3));
        fixture.readable.write(frames[1]!.subarray(3, -1));
        expect(messages).toEqual([{jsonrpc: "2.0", ...responses[0]}]);
        fixture.readable.write(Buffer.concat([frames[1]!.subarray(-1), frames[2]!.subarray(0, 2)]));
        fixture.readable.write(frames[2]!.subarray(2, 9));
        fixture.readable.write(frames[2]!.subarray(9, -1));
        expect(messages).toHaveLength(2);
        fixture.readable.write(Buffer.concat([frames[2]!.subarray(-1), frames[3]!]));

        expect(messages).toEqual(responses.map((response) => ({jsonrpc: "2.0", ...response})));
        fixture.transport.reader.dispose();
    });

    it("reassembles fragmented text messages", async () => {
        const fixture = createFixture();
        const messages: Message[] = [];
        fixture.transport.reader.listen((message) => messages.push(message));
        fixture.completeHandshake();
        const json = Buffer.from(JSON.stringify({method: "item/completed", params: {item: {id: "item-1"}}}));

        fixture.readable.write(serverFrame(0x1, json.subarray(0, 17), {fin: false}));
        fixture.readable.write(serverFrame(0x0, json.subarray(17, 39), {fin: false}));
        fixture.readable.write(serverFrame(0x0, json.subarray(39)));
        await nextTurn();

        expect(messages).toEqual([{
            jsonrpc: "2.0",
            method: "item/completed",
            params: {item: {id: "item-1"}},
        }]);
    });

    it("replies to ping frames with a masked pong carrying the same payload", async () => {
        const fixture = createFixture();
        fixture.completeHandshake();
        const payload = Buffer.from("health-check");

        fixture.readable.write(serverFrame(0x9, payload));
        await nextTurn();

        expect(fixture.clientFrames()).toEqual([{
            fin: true,
            opcode: 0xa,
            masked: true,
            payload,
        }]);
    });

    it("echoes a valid close frame and disposes both sides", async () => {
        const fixture = createFixture();
        let readerClosed = 0;
        let writerClosed = 0;
        fixture.transport.reader.onClose(() => readerClosed += 1);
        fixture.transport.writer.onClose(() => writerClosed += 1);
        fixture.completeHandshake();
        const payload = Buffer.alloc(2 + Buffer.byteLength("done"));
        payload.writeUInt16BE(1000);
        payload.write("done", 2);

        fixture.readable.write(serverFrame(0x8, payload));
        await nextTurn();

        expect(readerClosed).toBe(1);
        expect(writerClosed).toBe(1);
        expect(fixture.clientFrames()).toEqual([{
            fin: true,
            opcode: 0x8,
            masked: true,
            payload,
        }]);
        expect(fixture.writable.writableEnded).toBe(true);
    });

    it("surfaces malformed JSON to both error channels and sends an error close", async () => {
        const fixture = createFixture();
        const readerErrors: Error[] = [];
        const writerErrors: Error[] = [];
        let readerClosed = 0;
        let writerClosed = 0;
        fixture.transport.reader.onError((error) => readerErrors.push(error));
        fixture.transport.writer.onError(([error]) => writerErrors.push(error));
        fixture.transport.reader.onClose(() => readerClosed += 1);
        fixture.transport.writer.onClose(() => writerClosed += 1);
        fixture.completeHandshake();

        fixture.readable.write(serverFrame(0x1, Buffer.from("{not-json")));
        await nextTurn();

        expect(readerErrors).toHaveLength(1);
        expect(writerErrors).toHaveLength(1);
        expect(readerErrors[0]!.message).toContain("Invalid app-server JSON message");
        expect(writerErrors[0]).toBe(readerErrors[0]);
        expect(readerClosed).toBe(1);
        expect(writerClosed).toBe(1);
        expect(fixture.clientFrames()).toHaveLength(1);
        expect(fixture.clientFrames()[0]).toMatchObject({opcode: 0x8, masked: true});
        expect(fixture.clientFrames()[0]!.payload.readUInt16BE(0)).toBe(1007);
    });

    it("fails and disposes when the handshake times out", async () => {
        vi.useFakeTimers();
        const fixture = createFixture({handshakeTimeoutMs: 50});
        const readerErrors: Error[] = [];
        const writerErrors: Error[] = [];
        let closed = 0;
        fixture.transport.reader.onError((error) => readerErrors.push(error));
        fixture.transport.writer.onError(([error]) => writerErrors.push(error));
        fixture.transport.reader.onClose(() => closed += 1);
        fixture.transport.writer.onClose(() => closed += 1);

        await vi.advanceTimersByTimeAsync(50);

        expect(readerErrors[0]!.message).toContain("handshake timed out after 50ms");
        expect(writerErrors[0]).toBe(readerErrors[0]);
        expect(closed).toBe(2);
        expect(fixture.writable.writableEnded).toBe(true);
    });

    it("surfaces stream errors and disposes the whole transport", () => {
        const fixture = createFixture();
        const streamError = new Error("stdout failed");
        const readerErrors: Error[] = [];
        const writerErrors: Error[] = [];
        let closed = 0;
        fixture.transport.reader.onError((error) => readerErrors.push(error));
        fixture.transport.writer.onError(([error]) => writerErrors.push(error));
        fixture.transport.reader.onClose(() => closed += 1);
        fixture.transport.writer.onClose(() => closed += 1);

        fixture.readable.emit("error", streamError);

        expect(readerErrors).toEqual([streamError]);
        expect(writerErrors).toEqual([streamError]);
        expect(closed).toBe(2);
        expect(fixture.writable.writableEnded).toBe(true);
    });

    it.each([
        {
            name: "an oversized data frame",
            options: {maxPayloadBytes: 4},
            frame: () => serverFrame(0x1, Buffer.from("12345")),
            error: "payload limit",
            closeCode: 1009,
        },
        {
            name: "a fragmented control frame",
            options: {},
            frame: () => serverFrame(0x9, Buffer.from("ping"), {fin: false}),
            error: "control frames must not be fragmented",
            closeCode: 1002,
        },
        {
            name: "a masked server frame",
            options: {},
            frame: () => serverFrame(0x1, Buffer.from("{}"), {masked: true}),
            error: "must not be masked",
            closeCode: 1002,
        },
    ])("rejects $name", async ({options, frame, error, closeCode}) => {
        const fixture = createFixture(options);
        const errors: Error[] = [];
        fixture.transport.reader.onError((transportError) => errors.push(transportError));
        fixture.completeHandshake();

        fixture.readable.write(frame());
        await nextTurn();

        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain(error);
        const close = fixture.clientFrames()[0]!;
        expect(close).toMatchObject({opcode: 0x8, masked: true});
        expect(close.payload.readUInt16BE(0)).toBe(closeCode);
    });

    it("waits for writable callbacks, preserves ordering, and rejects callback errors", async () => {
        const readable = new PassThrough();
        const writable = new ControlledWritable();
        const transport = createWebSocketJsonRpcTransport(readable, writable);
        const writerErrors: Error[] = [];
        transport.writer.onError(([error]) => writerErrors.push(error));

        expect(writable.writes).toHaveLength(1);
        const handshake = writable.writes[0]!.toString("utf8");
        writable.completeNext();
        readable.write(createHandshakeResponse(handshake));

        const first = transport.writer.write(rpcMessage({id: 1, method: "first"}));
        const second = transport.writer.write(rpcMessage({id: 2, method: "second"}));
        await nextTurn();
        expect(writable.writes).toHaveLength(2);

        writable.completeNext();
        await first;
        expect(writable.writes).toHaveLength(3);

        const writeError = new Error("stream write failed");
        writable.completeNext(writeError);
        await expect(second).rejects.toBe(writeError);
        expect(writerErrors).toEqual([writeError]);
    });
});

function createFixture(options: WebSocketJsonRpcTransportOptions = {}): TransportFixture {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: Buffer[] = [];
    writable.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const transport = createWebSocketJsonRpcTransport(readable, writable, options);
    const clientBytes = () => Buffer.concat(chunks);
    const request = () => clientBytes().toString("utf8");

    return {
        readable,
        writable,
        transport,
        clientBytes,
        clientFrames: () => {
            const bytes = clientBytes();
            const requestEnd = bytes.indexOf("\r\n\r\n");
            return requestEnd < 0 ? [] : decodeFrames(bytes.subarray(requestEnd + 4));
        },
        handshakeResponse: () => createHandshakeResponse(request()),
        completeHandshake: () => readable.write(createHandshakeResponse(request())),
    };
}

function createHandshakeResponse(request: string): Buffer {
    const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
    if (!key) {
        throw new Error("Missing WebSocket key in client handshake");
    }
    const accept = crypto
        .createHash("sha1")
        .update(key + WEBSOCKET_ACCEPT_GUID)
        .digest("base64");
    return Buffer.from([
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
    ].join("\r\n"));
}

function serverFrame(
    opcode: number,
    payload: Buffer,
    options: {fin?: boolean; masked?: boolean} = {},
): Buffer {
    const fin = options.fin ?? true;
    const masked = options.masked ?? false;
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
    frame[offset++] = (fin ? 0x80 : 0) | opcode;
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

    const mask = Buffer.from([1, 2, 3, 4]);
    mask.copy(frame, offset);
    offset += mask.length;
    for (let index = 0; index < payload.length; index += 1) {
        frame[offset + index] = payload[index]! ^ mask[index % mask.length]!;
    }
    return frame;
}

function decodeFrames(buffer: Buffer): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    let cursor = 0;
    while (cursor < buffer.length) {
        if (buffer.length - cursor < 2) {
            throw new Error("Incomplete WebSocket frame header");
        }
        const first = buffer[cursor++]!;
        const second = buffer[cursor++]!;
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let payloadLength = second & 0x7f;
        if (payloadLength === 126) {
            payloadLength = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (payloadLength === 127) {
            payloadLength = Number(buffer.readBigUInt64BE(cursor));
            cursor += 8;
        }
        const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
        if (mask) {
            cursor += 4;
        }
        const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLength));
        cursor += payloadLength;
        if (mask) {
            for (let index = 0; index < payload.length; index += 1) {
                payload[index] = payload[index]! ^ mask[index % mask.length]!;
            }
        }
        frames.push({fin, opcode, masked, payload});
    }
    return frames;
}

function rpcMessage(value: Record<string, unknown>): Message {
    return {jsonrpc: "2.0", ...value} as Message;
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

class ControlledWritable extends Writable {
    readonly writes: Buffer[] = [];
    private readonly callbacks: Array<(error?: Error | null) => void> = [];

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.writes.push(Buffer.from(chunk));
        this.callbacks.push(callback);
    }

    completeNext(error?: Error): void {
        const callback = this.callbacks.shift();
        if (!callback) {
            throw new Error("No pending write callback");
        }
        callback(error);
    }
}
