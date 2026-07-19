import {PassThrough} from "node:stream";
import {createMessageConnection, StreamMessageReader, StreamMessageWriter} from "vscode-jsonrpc/node";
import {describe, expect, it, onTestFinished} from "vitest";
import {CodexAppServerClient} from "../CodexAppServerClient";
import type {ThreadGoal, ThreadGoalSetResponse} from "../app-server/v2";

describe("CodexAppServerClient connection lifecycle", () => {
    it.each(["close", "dispose"] as const)("rejects outstanding completion waits on connection %s", async (termination) => {
        const fixture = createFixture();
        const results = Promise.allSettled([
            fixture.client.awaitTurnCompleted("thread", "turn"),
            fixture.client.awaitCompactionCompleted("thread"),
        ]);

        fixture.terminate(termination);

        expect(await results).toEqual(Array.from({length: 2}, () => ({
            status: "rejected",
            reason: expect.any(Error),
        })));
    });

    it.each(["close", "dispose"] as const)("rejects completion waits registered after connection %s", async (termination) => {
        const fixture = createFixture();
        fixture.terminate(termination);

        const results = await Promise.allSettled([
            fixture.client.awaitTurnCompleted("thread", "turn"),
            fixture.client.awaitCompactionCompleted("thread"),
        ]);

        expect(results).toEqual(Array.from({length: 2}, () => ({
            status: "rejected",
            reason: expect.any(Error),
        })));
    });

    it("rejects pending JSON-RPC requests when the transport closes", async () => {
        const fixture = createFixture();
        const received = deferred();
        fixture.server.onRequest("thread/read", () => {
            received.resolve();
            return new Promise(() => {});
        });
        const result = Promise.allSettled([fixture.client.threadRead({threadId: "thread"})]);
        await received.promise;

        fixture.terminate("close");

        expect(await result).toEqual([{
            status: "rejected",
            reason: expect.objectContaining({message: "Pending response rejected since connection got disposed"}),
        }]);
    });

    it("rejects a goal operation waiting for its update after the RPC response", async () => {
        const fixture = createFixture();
        const responseHandled = deferred();
        const goal = createGoal("paused");
        fixture.server.onRequest("thread/goal/set", (): ThreadGoalSetResponse => ({goal}));
        const result = Promise.allSettled([fixture.client.runGoalSet(
            {threadId: "thread", objective: goal.objective},
            undefined,
            undefined,
            () => responseHandled.resolve(),
        )]);
        await responseHandled.promise;

        fixture.terminate("dispose");

        expect(await result).toEqual([{
            status: "rejected",
            reason: expect.any(Error),
        }]);
    });

    it("rejects a goal operation waiting for its running turn to finish", async () => {
        const fixture = createFixture();
        const responseHandled = deferred();
        const turnStarted = deferred();
        const goal = createGoal("active");
        fixture.server.onRequest("thread/goal/set", (): ThreadGoalSetResponse => ({goal}));
        const result = Promise.allSettled([fixture.client.runGoalSet(
            {threadId: "thread", objective: goal.objective},
            () => turnStarted.resolve(),
            undefined,
            () => responseHandled.resolve(),
        )]);
        await responseHandled.promise;
        await fixture.server.sendNotification("thread/goal/updated", {threadId: "thread", goal});
        await fixture.server.sendNotification("turn/started", {
            threadId: "thread",
            turn: {id: "turn", status: "inProgress", items: []},
        });
        await turnStarted.promise;

        fixture.terminate("close");

        expect(await result).toEqual([{
            status: "rejected",
            reason: expect.any(Error),
        }]);
    });

    it("rejects a goal clear waiting for its notification after the RPC response", async () => {
        const fixture = createFixture();
        const responseHandled = deferred();
        fixture.server.onRequest("thread/goal/clear", () => ({cleared: true}));
        fixture.client.onClientTransportEvent((event) => {
            if (event.eventType === "response") responseHandled.resolve();
        });
        const result = Promise.allSettled([fixture.client.runGoalClear({threadId: "thread"})]);
        await responseHandled.promise;

        fixture.terminate("dispose");

        expect(await result).toEqual([{
            status: "rejected",
            reason: expect.any(Error),
        }]);
    });

    it("settles compaction shutdown without an unhandled rejection while its RPC is pending", async () => {
        const fixture = createFixture();
        const received = deferred();
        fixture.server.onRequest("thread/compact/start", () => {
            received.resolve();
            return new Promise(() => {});
        });
        const result = Promise.allSettled([fixture.client.runCompact({threadId: "thread"})]);
        await received.promise;

        fixture.terminate("dispose");

        expect(await result).toEqual([{
            status: "rejected",
            reason: expect.any(Error),
        }]);
    });
});

function createFixture() {
    const clientInput = new PassThrough();
    const serverInput = new PassThrough();
    const connection = createMessageConnection(new StreamMessageReader(clientInput), new StreamMessageWriter(serverInput));
    const server = createMessageConnection(new StreamMessageReader(serverInput), new StreamMessageWriter(clientInput));
    const client = new CodexAppServerClient(connection);
    connection.listen();
    server.listen();
    onTestFinished(() => {
        connection.dispose();
        server.dispose();
        clientInput.destroy();
        serverInput.destroy();
    });
    return {
        client,
        server,
        terminate(kind: "close" | "dispose") {
            if (kind === "close") clientInput.emit("close");
            else connection.dispose();
        },
    };
}

function createGoal(status: ThreadGoal["status"]): ThreadGoal {
    return {
        threadId: "thread",
        objective: "Complete the task",
        status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
    };
}

function deferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}
