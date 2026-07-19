import {describe, expect, it, vi} from "vitest";
import type {ApprovalHandler, ElicitationHandler, CodexAppServerClient} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {getAppServerRequestId, tagAppServerRequest} from "../AppServerRequestContext";
import {CodexSubagentSubscriptions} from "../subagents/CodexSubagentSubscriptions";
import {createThread, itemStarted} from "./CodexACPAgent/v2-prompt-harness";

describe("Subagent cleanup ownership", () => {
    it("returns only loaded descendants with a verified chain to the root", async () => {
        const handlers = new Map<string, (event: ServerNotification) => void>();
        const metadata: Record<string, {parent: string; loaded?: boolean; id?: string}> = {
            child: {parent: "root"},
            nested: {parent: "child"},
            foreign: {parent: "another-root"},
            orphan: {parent: "foreign"},
            unloaded: {parent: "root", loaded: false},
            mismatch: {parent: "root", id: "wrong"},
        };
        const client = {
            onServerNotification: (id: string, handler: (event: ServerNotification) => void) => { handlers.set(id, handler); },
            onApprovalRequest: vi.fn(),
            onElicitationRequest: vi.fn(),
            threadRead: vi.fn(async ({threadId}: {threadId: string}) => {
                const entry = metadata[threadId]!;
                return {thread: {...createThread(), id: entry.id ?? threadId, parentThreadId: entry.parent,
                    status: {type: entry.loaded === false ? "notLoaded" : "idle"}}};
            }),
        } as unknown as CodexAppServerClient;
        const subscriptions = new CodexSubagentSubscriptions(client);
        subscriptions.subscribe({
            rootSessionId: "root", supportsSubagents: false, dispatch: vi.fn(), enqueueInteraction: vi.fn(),
            approvalHandler: {} as never, elicitationHandler: {} as never,
            waitForRootNotifications: async () => {}, waitForChildSession: async () => null,
        });
        for (const id of Object.keys(metadata)) {
            const event = itemStarted({type: "subAgentActivity", id: `activity-${id}`, model: null, reasoningEffort: null,
                agentThreadId: id, agentPath: `/root/${id}`, kind: "started"});
            handlers.get("root")!({...event, params: {...event.params, threadId: "root"}} as ServerNotification);
        }
        for (const id of Object.keys(metadata)) await subscriptions.readChildThread(id);
        vi.mocked(client.threadRead).mockClear();
        expect(subscriptions.verifiedChildThreadIds("root")).toEqual(["child", "nested"]);
        expect(subscriptions.verifiedChildThreadIds("unknown")).toEqual([]);
        expect(client.threadRead).not.toHaveBeenCalled();
    });
});


describe("Subagent interactions", () => {
    const cases = [
        ["handleCommandExecution", {decision: "cancel"}],
        ["handleFileChange", {decision: "cancel"}],
        ["handlePermissionsRequest", {permissions: {}, scope: "turn", strictAutoReview: false}],
        ["handleElicitation", {action: "cancel", content: null, _meta: null}],
        ["handleUserInput", {answers: {}}],
    ] as const;

    it.each([
        ["root", "idle", ["child"]],
        ["another-root", "idle", []],
        [null, "idle", []],
        ["root", "notLoaded", []],
    ] as const)("observes child thread ownership (parent: %s, status: %s)", (parentThreadId, status, owned) => {
        const send = vi.fn();
        const dispatch = vi.fn();
        const {subscriptions, notifications} = interactionSubscriptions(() => false);
        subscriptions.subscribe({
            rootSessionId: "root", supportsSubagents: true, dispatch, enqueueInteraction: vi.fn(),
            approvalHandler: {handleCommandExecution: send, handleFileChange: send, handlePermissionsRequest: send},
            elicitationHandler: {handleElicitation: send, handleUserInput: send},
            waitForRootNotifications: async () => {}, waitForChildSession: async () => "child",
        });
        discoverChild(notifications);
        dispatch.mockClear();
        const thread = {...createThread(), id: "child", parentThreadId, status: {type: status}};
        notifications.get("child")!({method: "thread/started", params: {thread: {...thread, id: "foreign"}}});
        expect(dispatch).not.toHaveBeenCalled();
        const event = {method: "thread/started" as const, params: {thread}};
        notifications.get("child")!(event);
        expect(dispatch).toHaveBeenCalledWith(event);
        expect(subscriptions.verifiedChildThreadIds("root")).toEqual(owned);
    });

    it.each(cases)("does not send resolved %s after awaiting child announcement", async (method, cancelled) => {
        const announced = deferred();
        const release = deferred();
        let resolved = false;
        const send = vi.fn().mockRejectedValue(new Error("Resolved request reached the interaction handler"));
        const {subscriptions, handlers, notifications} = interactionSubscriptions(() => resolved);
        subscriptions.subscribe({
            rootSessionId: "root", supportsSubagents: true, dispatch: vi.fn(), enqueueInteraction: vi.fn(),
            approvalHandler: {handleCommandExecution: send, handleFileChange: send, handlePermissionsRequest: send},
            elicitationHandler: {handleElicitation: send, handleUserInput: send},
            waitForRootNotifications: async () => {}, waitForChildSession: async () => "child",
            withUserAction: async (_sessionId, _itemId, request) => {
                announced.resolve();
                await release.promise;
                return request();
            },
        });
        discoverChild(notifications);
        const response = handlers.get("child")![method]!({threadId: "child", turnId: "turn", itemId: "item"} as never);
        await announced.promise;
        resolved = true;
        release.resolve();
        await expect(response).resolves.toEqual(cancelled);
        expect(send).not.toHaveBeenCalled();
    });

    it("preserves the shared request ID when attributing a child interaction to its root", async () => {
        const params = {threadId: "child", turnId: "turn", itemId: "item"};
        tagAppServerRequest(params, "shared-request");
        const send = vi.fn().mockResolvedValue({decision: "cancel"});
        const {subscriptions, handlers, notifications} = interactionSubscriptions(() => false);
        subscriptions.subscribe({
            rootSessionId: "root", supportsSubagents: false, dispatch: vi.fn(), enqueueInteraction: vi.fn(),
            approvalHandler: {handleCommandExecution: send, handleFileChange: send, handlePermissionsRequest: send},
            elicitationHandler: {handleElicitation: send, handleUserInput: send},
            waitForRootNotifications: async () => {}, waitForChildSession: async () => null,
        });
        discoverChild(notifications);
        await handlers.get("child")!.handleCommandExecution!(params as never);
        const [routed] = send.mock.calls[0]!;
        expect(routed.threadId).toBe("root");
        expect(getAppServerRequestId(routed)).toBe("shared-request");
    });
});

function interactionSubscriptions(isResolved: () => boolean) {
    const notifications = new Map<string, (event: ServerNotification) => void>();
    const handlers = new Map<string, Partial<ApprovalHandler & ElicitationHandler>>();
    const register = (id: string, handler: Partial<ApprovalHandler & ElicitationHandler>) => {
        handlers.set(id, {...handlers.get(id), ...handler});
    };
    const client = {
        onServerNotification: (id: string, handler: (event: ServerNotification) => void) => { notifications.set(id, handler); },
        onApprovalRequest: register,
        onElicitationRequest: register,
        isServerRequestResolved: isResolved,
    } as unknown as CodexAppServerClient;
    return {subscriptions: new CodexSubagentSubscriptions(client), handlers, notifications};
}

function discoverChild(notifications: Map<string, (event: ServerNotification) => void>): void {
    const event = itemStarted({type: "subAgentActivity", id: "activity-child", model: null, reasoningEffort: null,
        agentThreadId: "child", agentPath: "/root/child", kind: "started"});
    notifications.get("root")!({...event, params: {...event.params, threadId: "root"}} as ServerNotification);
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return {promise, resolve};
}
