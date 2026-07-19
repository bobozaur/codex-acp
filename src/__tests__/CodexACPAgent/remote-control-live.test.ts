import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createMessageConnection} from "vscode-jsonrpc/node";
import {describe, expect, it, onTestFinished} from "vitest";
import type {AcpClientConnection, UpdateSessionEvent} from "../../ACPSessionConnection";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {createWebSocketJsonRpcTransport} from "../../WebSocketJsonRpcTransport";
import {readThreadHistory} from "../../ThreadHistory";
import type {ThreadItem} from "../../app-server/v2";

type Message = {id: string; type: "userMessage" | "agentMessage"; text: string};
type TimedMessage = Message & {at: number};
type TimedUpdate = {update: UpdateSessionEvent; at: number};

/** Opt-in: uses existing authentication and creates only its own test thread. */
describe.skipIf(process.env["RUN_REMOTE_SYNC_TESTS"] !== "true")("live remote-control synchronization", () => {
    it("preserves live delivery, steering order, and history across ACP reconnection", async () => {
        const peers: ReturnType<typeof connect>[] = [];
        onTestFinished(async () => {await Promise.all(peers.map(peer => peer.close()));});
        let threadId: string | undefined;
        const addPeer = () => {
            const peer = connect(() => threadId);
            peers.push(peer);
            return peer;
        };
        const local = addPeer();
        const remote = addPeer();
        try {
            await local.acp.initialize({protocolVersion: 1});
            await remote.raw.initialize({
                clientInfo: {name: "acp-remote-sync-test", title: "ACP remote sync test", version: "1"},
                capabilities: {experimentalApi: true, requestAttestation: false},
            });
            remote.raw.initialized();
            const {sessionId} = await local.acp.newSession({cwd: process.cwd(), mcpServers: []});
            threadId = sessionId;
            console.log(`Remote-sync test thread: ${sessionId}`);
            await local.raw.threadSetName({threadId: sessionId, name: "ACP remote synchronization test"});
            const prompt = async (text: string) => {
                const result = await local.acp.prompt({sessionId, prompt: [{type: "text", text}]});
                expect(result.stopReason).toBe("end_turn");
            };

            // A durable rollout exists only after the first prompt.
            await prompt("Reply with exactly LOCAL_ONE. Do not use tools.");
            const seedCount = local.messages.length;
            await remote.raw.threadResume({threadId: sessionId, excludeTurns: true});
            await prompt("Reply with exactly LOCAL_TWO. Do not use tools.");
            await remote.raw.runTurn({
                threadId: sessionId,
                clientUserMessageId: "remote-idle",
                input: [{type: "text", text: "Reply with exactly REMOTE_ONE. Do not use tools.", text_elements: []}],
            });
            await local.client.waitForSessionNotifications(sessionId);

            // Steer while a real command is running. Acceptance and materialization
            // are different boundaries: neither native observer sees the message
            // until Core consumes the input, but ACP must not add a turn-long wait.
            let notifyCommandStarted!: () => void;
            const commandStarted = new Promise<void>(resolve => {notifyCommandStarted = resolve;});
            local.onCommandStarted = notifyCommandStarted;
            const busy = prompt("Run sleep 6 exactly once using exec_command with yield_time_ms 10000, then reply READY. Do not edit files or use other tools.");
            // Race with prompt completion so a missing command fails immediately.
            await Promise.race([commandStarted, busy.then(() => {
                throw new Error("Test prompt ended without the required command");
            })]);
            const expectedTurnId = local.acp.getSessionState(sessionId).currentTurnId;
            if (expectedTurnId === null) throw new Error("Test turn is no longer active");
            const steers: Array<{text: string; sentAt: number; acceptedAt: number}> = [];
            for (const marker of ["STEER_ONE", "STEER_TWO"]) {
                const text = `Include ${marker} in your final response.`;
                const sentAt = performance.now();
                await remote.raw.turnSteer({
                    threadId: sessionId, expectedTurnId, clientUserMessageId: marker,
                    input: [{type: "text", text, text_elements: []}],
                });
                steers.push({text, sentAt, acceptedAt: performance.now()});
            }
            await busy;
            await local.client.waitForSessionNotifications(sessionId);
            const history = await readThreadHistory(remote.raw, sessionId);
            const messages = history.turns.flatMap(turn => turn.items.flatMap(item => {
                const message = toMessage(item);
                return message ? [message] : [];
            }));
            expect(local.messages.map(withoutTime)).toEqual(messages);
            expect(remote.messages.map(withoutTime)).toEqual(messages.slice(seedCount));
            const mirrored = transcript(local.updates);
            const remoteUserIds = new Set(local.updates.flatMap(({update}) =>
                update.sessionUpdate === "user_message_chunk" ? [update.messageId] : []));
            expect(remoteUserIds.size).toBe(3);
            expect(mirrored).toEqual(messages.filter(message =>
                message.type === "agentMessage" || remoteUserIds.has(message.id)));

            const latencies = steers.map(steer => {
                const received = local.startedMessages.find(message => message.text === steer.text);
                expect(received).toBeDefined();
                const forwarded = local.updates.find(({update}) =>
                    update.sessionUpdate === "user_message_chunk" && update.messageId === received!.id);
                expect(forwarded).toBeDefined();
                const forwardingMs = forwarded!.at - received!.at;
                // Broad regression budget, not a claim about mobile network latency.
                expect(forwardingMs).toBeLessThan(1_000);
                return {
                    message: steer.text,
                    acceptanceMs: steer.acceptedAt - steer.sentAt,
                    materializationMs: received!.at - steer.sentAt,
                    acpForwardingMs: forwardingMs,
                };
            });
            console.log(JSON.stringify({latencies, orderedMessages: messages.length}));

            // Only disconnect this test's ACP proxy; leave the managed daemon and
            // all pre-existing threads untouched. A fresh ACP must replay the same
            // IDs, text, and ordering as the two subscribed live observers.
            await local.close();
            const reopened = addPeer();
            await reopened.acp.initialize({protocolVersion: 1});
            await reopened.acp.loadSession({sessionId, cwd: process.cwd(), mcpServers: []});
            await reopened.client.waitForSessionNotifications(sessionId);
            expect(transcript(reopened.updates)).toEqual(messages);
        } finally {
            await Promise.all(peers.map(peer => peer.close()));
        }
    }, 90_000);
});

function connect(getThreadId: () => string | undefined) {
    // Proxy only: never restart, stop, or reconfigure the shared daemon.
    const codexPath = process.env["CODEX_PATH"];
    const child = codexPath
        ? spawn(codexPath, ["app-server", "proxy"])
        : spawn(process.execPath, [createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"), "app-server", "proxy"]);
    child.stderr.on("data", () => {});
    const {reader, writer} = createWebSocketJsonRpcTransport(child.stdout, child.stdin);
    const connection = createMessageConnection(reader, writer);
    connection.listen();
    const raw = new CodexAppServerClient(connection);
    const client = new CodexAcpClient(raw);
    const updates: TimedUpdate[] = [];
    const acpConnection: AcpClientConnection = {
        notify: async (method: string, params: unknown) => {
            if (method !== "session/update") return;
            const notification = params as {sessionId: string; update: UpdateSessionEvent};
            if (notification.sessionId === getThreadId()) updates.push({update: notification.update, at: performance.now()});
        },
        request: async (method: string) => {throw new Error(`Unexpected interactive request: ${method}`);},
    };
    const acp = new CodexAcpServer(acpConnection, client, undefined, () => child.exitCode);
    let closing: Promise<void> | undefined;
    const peer = {
        raw, client, acp, updates,
        messages: [] as TimedMessage[],
        startedMessages: [] as TimedMessage[],
        onCommandStarted: () => {},
        close(): Promise<void> {
            return closing ??= (async () => {
                const exit = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
                connection.end();
                const fallback = setTimeout(() => child.kill(), 1_000);
                try { await exit; } finally {clearTimeout(fallback); connection.dispose();}
            })();
        },
    };
    raw.onClientTransportEvent(event => {
        if (event.eventType !== "notification" || (event.method !== "item/started" && event.method !== "item/completed")) return;
        if (event.params.threadId !== getThreadId()) return;
        if (event.method === "item/started" && event.params.item.type === "commandExecution") peer.onCommandStarted();
        const message = toMessage(event.params.item);
        if (!message) return;
        const entry = {...message, at: performance.now()};
        if (event.method === "item/started") peer.startedMessages.push(entry);
        else peer.messages.push(entry);
    });
    return peer;
}

function toMessage(item: ThreadItem): Message | null {
    if (item.type === "agentMessage") return {id: item.id, type: item.type, text: item.text};
    if (item.type === "userMessage") return {
        id: item.id, type: item.type,
        text: item.content.flatMap(input => input.type === "text" ? [input.text] : []).join(""),
    };
    return null;
}

function withoutTime({at: _at, ...message}: TimedMessage): Message {
    return message;
}

function transcript(updates: TimedUpdate[]): Message[] {
    const messages = new Map<string, Message>();
    for (const {update} of updates) {
        if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") continue;
        if (update.content.type !== "text" || !update.messageId) throw new Error("Expected an identified text message");
        const previous = messages.get(update.messageId);
        messages.set(update.messageId, {
            id: update.messageId,
            type: update.sessionUpdate === "user_message_chunk" ? "userMessage" : "agentMessage",
            text: (previous?.text ?? "") + update.content.text,
        });
    }
    return [...messages.values()];
}
