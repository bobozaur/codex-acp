import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {Model, Thread, ThreadItem, ThreadItemEntry, Turn, TurnSteerParams} from "../../app-server/v2";
import type {SessionState} from "../../CodexAcpServer";
import type {UpdateSessionEvent} from "../../ACPSessionConnection";
import {ModelId} from "../../ModelId";
import {OPENAI_PROVIDER_ID, type SessionMetadataWithThread} from "../../CodexAcpClient";
import {CodexEventHandler} from "../../CodexEventHandler";
import {
    createCodexMockTestFixture,
    createTestModel,
    stubGatewayModelListing,
    type CodexMockTestFixture,
} from "../acp-test-utils";

stubGatewayModelListing(["model-id"]);

describe("CodexACPAgent - remote-control synchronization", () => {
    it("streams phone messages before the first ACP prompt only to their session", async () => {
        const fixture = createCodexMockTestFixture();
        await openNewSessions(fixture, ["session-1", "session-2"]);

        fixture.sendServerNotification(userMessageStarted(
            "session-1",
            "remote-user-1",
            "phone-1",
            "message for session one",
        ));
        fixture.sendServerNotification(userMessageStarted(
            "session-2",
            "remote-user-2",
            "phone-2",
            "message for session two",
        ));
        await waitForNotifications(fixture, ["session-1", "session-2"]);

        expect(userMessageUpdates(fixture)).toEqual([
            {
                sessionId: "session-1",
                messageId: "remote-user-1",
                text: "message for session one",
            },
            {
                sessionId: "session-2",
                messageId: "remote-user-2",
                text: "message for session two",
            },
        ]);
    });

    it("recovers completed agent text without duplicating an already streamed prefix", async () => {
        const fixture = createCodexMockTestFixture();
        await openNewSessions(fixture, ["session-1"]);

        const notifications: ServerNotification[] = [
            agentMessageCompleted("session-1", "completed-only", "Complete response"),
            agentMessageStarted("session-1", "partial"),
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: "session-1",
                    turnId: "turn-1",
                    itemId: "partial",
                    delta: "Partial",
                },
            },
            agentMessageCompleted("session-1", "partial", "Partial response finished"),
            agentMessageStarted("session-1", "revised"),
            agentMessageDelta("session-1", "turn-1", "revised", "Draft response"),
            agentMessageCompleted("session-1", "revised", "Final response"),
        ];
        for (const notification of notifications) {
            fixture.sendServerNotification(notification);
        }
        await waitForNotifications(fixture, ["session-1"]);

        expect(agentMessageUpdates(fixture)).toEqual([
            {sessionId: "session-1", messageId: "completed-only", text: "Complete response"},
            {sessionId: "session-1", messageId: "partial", text: "Partial"},
            {sessionId: "session-1", messageId: "partial", text: " response finished"},
            {sessionId: "session-1", messageId: "revised", text: "Draft response"},
            {sessionId: "session-1", messageId: "revised", text: "\n\nFinal response"},
        ]);
    });

    it("drains queued active-turn deltas without replaying the snapshot prefix", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "resumed-session";
        const activeTurnId = "active-turn";
        const itemId = "active-agent-message";

        await openResumedSession(fixture, sessionId, activeTurnId, {
            snapshotItems: [{
                type: "agentMessage",
                id: itemId,
                text: "Snapshot prefix",
                phase: "commentary",
                memoryCitation: null,
                delivery: null,
                questions: null,
            }],
            queuedNotifications: [
                agentMessageDelta(sessionId, activeTurnId, itemId, "Snapshot prefix"),
                agentMessageDelta(sessionId, activeTurnId, itemId, " plus live text"),
            ],
            clearAcpEvents: false,
        });

        expect(agentMessageUpdates(fixture)).toEqual([
            {
                sessionId,
                messageId: itemId,
                text: "Snapshot prefix",
            },
            {
                sessionId,
                messageId: itemId,
                text: " plus live text",
            },
        ]);
    });

    it("keeps snapshot deduplication until a slow buffered notification has finished", async () => {
        const fixture = createCodexMockTestFixture();
        const handleNotification = CodexEventHandler.prototype.handleSessionScopedNotification;
        vi.spyOn(CodexEventHandler.prototype, "handleSessionScopedNotification").mockImplementation(
            async function (this: CodexEventHandler, notification) {
                if (notification.method === "item/started" && notification.params.item.type === "userMessage") {
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                return await handleNotification.call(this, notification);
            },
        );
        const sessionId = "slow-replay";
        const turnId = "active-turn";
        const itemId = "active-agent";
        await openResumedSession(fixture, sessionId, turnId, {
            snapshotItems: [{
                type: "agentMessage", id: itemId, text: "Snapshot prefix",
                phase: "commentary", memoryCitation: null, delivery: null, questions: null,
            }],
            queuedNotifications: [
                userMessageStarted(sessionId, "remote-user", "phone", "New remote message", turnId),
                agentMessageDelta(sessionId, turnId, itemId, "Snapshot prefix"),
                agentMessageDelta(sessionId, turnId, itemId, " plus live text"),
            ],
            clearAcpEvents: false,
        });
        expect(agentMessageUpdates(fixture)).toEqual([
            {sessionId, messageId: itemId, text: "Snapshot prefix"},
            {sessionId, messageId: itemId, text: " plus live text"},
        ]);
        fixture.sendServerNotification(agentMessageDelta(sessionId, turnId, itemId, "Snapshot prefix"));
        await waitForNotifications(fixture, [sessionId]);
        expect(agentMessageUpdates(fixture).at(-1)).toEqual({
            sessionId, messageId: itemId, text: "Snapshot prefix",
        });
    });

    it("hands live events to the replacement bridge after reloading an open session", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "reload-session";
        const turnId = "active-turn";
        const itemId = "active-agent";
        await openNewSessions(fixture, [sessionId]);
        const client = fixture.getCodexAcpClient();
        const model = createTestModel();
        vi.spyOn(client, "getGoal").mockResolvedValue(null);
        vi.spyOn(client, "loadSession").mockImplementation(async (_request, onSubscribed) => {
            const thread = createThread(sessionId, [{
                ...createTurn(turnId, "inProgress"),
                items: [{
                    type: "agentMessage", id: itemId, text: "Snapshot prefix",
                    phase: "commentary", memoryCitation: null, delivery: null, questions: null,
                }],
            }]);
            fixture.sendServerNotification(agentMessageDelta(sessionId, turnId, itemId, " plus live text"));
            fixture.sendServerNotification({
                method: "turn/completed", params: {threadId: sessionId, turn: createTurn(turnId, "completed")},
            });
            onSubscribed?.();
            return {
                sessionId, thread, history: threadHistory(thread), threadSnapshot: thread, activeTurnId: turnId,
                currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
                models: [model], collaborationMode: "default", modelProvider: "test-provider",
                currentServiceTier: null, additionalDirectories: [],
            };
        });
        await fixture.getCodexAcpAgent().loadSession({sessionId, cwd: "", mcpServers: []});
        await waitForNotifications(fixture, [sessionId]);
        expect(agentMessageUpdates(fixture)).toEqual([
            {sessionId, messageId: itemId, text: "Snapshot prefix"},
            {sessionId, messageId: itemId, text: " plus live text"},
        ]);
        expect(fixture.getCodexAcpAgent().getSessionState(sessionId).currentTurnId).toBeNull();
    });

    it.each([
        ["loadSession", false], ["loadSession", true], ["resumeSession", false], ["resumeSession", true],
    ] as const)("keeps the open subscription when %s fails (native attachment: %s)", async (method, subscribed) => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "already-open";
        const agent = fixture.getCodexAcpAgent();
        await openNewSessions(fixture, [sessionId]);
        const client = fixture.getCodexAcpClient();
        const detach = vi.spyOn(client, "detachSession");
        vi.spyOn(client, method).mockImplementationOnce(async (_request, onSubscribed) => {
            if (subscribed) onSubscribed?.();
            fixture.sendServerNotification(userMessageStarted(sessionId, "during-setup", "phone", "During setup"));
            throw new Error("Setup rejected");
        });

        await expect(agent[method]({sessionId, cwd: "", mcpServers: []})).rejects.toThrow("Setup rejected");
        fixture.sendServerNotification(userMessageStarted(sessionId, "after-setup", "phone", "After setup"));
        await waitForNotifications(fixture, [sessionId]);

        expect(userMessageUpdates(fixture)).toEqual([
            {sessionId, messageId: "during-setup", text: "During setup"},
            {sessionId, messageId: "after-setup", text: "After setup"},
        ]);
        expect(detach).not.toHaveBeenCalled();
    });

    it("does not shut down a foreign thread after its first open rejects", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "foreign-thread";
        const agent = fixture.getCodexAcpAgent();
        await openNewSessions(fixture, ["existing-thread"]);
        const client = fixture.getCodexAcpClient();
        vi.spyOn(client, "resumeSession").mockRejectedValueOnce(new Error("Setup rejected before subscribing"));
        const close = vi.spyOn(client, "closeSession");

        await expect(agent.resumeSession({sessionId, cwd: "", mcpServers: []})).rejects.toThrow("Setup rejected");
        await expect(agent.closeSession({sessionId})).resolves.toEqual({});
        expect(close).not.toHaveBeenCalled();
    });

    it("detaches an active thread after a history read fails without interrupting shared work", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "foreign-thread";
        const agent = fixture.getCodexAcpAgent();
        const model = createTestModel();
        await openNewSessions(fixture, ["existing-thread"], model);
        vi.spyOn(fixture.getCodexAcpClient(), "loadSession").mockImplementationOnce(async (_request, onSubscribed) => {
            onSubscribed?.();
            const turnId = "remote-turn";
            fixture.sendServerNotification(userMessageStarted(sessionId, "during-setup", "phone", "During setup", turnId));
            const thread = createThread(sessionId, [createTurn(turnId, "inProgress")]);
            const history = (async function* () { throw new Error("History read failed"); })();
            return {
                sessionId, thread, history, threadSnapshot: thread, activeTurnId: turnId,
                currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
                models: [model], collaborationMode: "default", modelProvider: "test-provider",
                currentServiceTier: null, additionalDirectories: [],
            };
        });
        fixture.clearCodexConnectionDump();

        await expect(agent.loadSession({sessionId, cwd: "", mcpServers: []})).rejects.toThrow("History read failed");
        const teardown = fixture.getCodexConnectionEvents([]).flatMap(event => event.eventType === "request"
            && (event.method === "turn/interrupt" || event.method.startsWith("thread/backgroundTerminals/")
                || event.method === "thread/unsubscribe") ? [event.method] : []);
        expect(teardown).toEqual(["thread/unsubscribe"]);
        expect(() => agent.getSessionState(sessionId)).toThrow("not found");
        await waitForNotifications(fixture, [sessionId]);
        expect(userMessageUpdates(fixture)).toEqual([]);
    });

    it("rebinds remote event delivery after replacing the app-server client", async () => {
        const replacementFixture = createCodexMockTestFixture();
        const replacement = replacementFixture.getCodexAcpClient();
        const fixture = createCodexMockTestFixture(async () => replacement);
        await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        await openNewSessions(fixture, ["session-1"]);
        vi.spyOn(replacement, "initialize").mockResolvedValue();
        const model = createTestModel();
        vi.spyOn(replacement, "resumeSession").mockResolvedValue({
            sessionId: "session-1",
            currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
            models: [model],
            collaborationMode: "default",
            modelProvider: "test-provider",
            currentServiceTier: null,
            additionalDirectories: [],
        });
        await fixture.getCodexAcpAgent().setProvider({
            providerId: OPENAI_PROVIDER_ID, apiType: "openai", baseUrl: "https://gateway.example/v1",
        });
        replacementFixture.sendServerNotification(userMessageStarted(
            "session-1", "new-server-user", "phone", "Message after restart",
        ));
        fixture.sendServerNotification(userMessageStarted(
            "session-1", "old-server-user", "old-phone", "Stale old-server message",
        ));
        await replacement.waitForSessionNotifications("session-1");
        await waitForNotifications(fixture, ["session-1"]);
        expect(userMessageUpdates(fixture)).toEqual([
            {sessionId: "session-1", messageId: "new-server-user", text: "Message after restart"},
        ]);
    });

    it.each([
        {operation: "loadSession" as const, nativeSubagents: false},
        {operation: "loadSession" as const, nativeSubagents: true},
        {operation: "resumeSession" as const, nativeSubagents: false},
        {operation: "resumeSession" as const, nativeSubagents: true},
    ])("stops stale $operation history after close and reopen (native children: $nativeSubagents)", async ({operation, nativeSubagents}) => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        if (nativeSubagents) {
            await agent.initialize({
                protocolVersion: 1,
                clientCapabilities: {
                    _meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions"]}}},
                },
            });
        }
        const sessionId = "reopened-history";
        await openNewSessions(fixture, [sessionId]);
        vi.spyOn(client, "getGoal").mockResolvedValue(null);
        const model = createTestModel();
        const message = (id: string, text: string): ThreadItem => ({
            type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null,
            delivery: null, questions: null,
        });
        const threadWithItems = (id: string, items: ThreadItem[]): Thread => createThread(id, [{
            ...createTurn(`turn-${id}`, "completed"), items,
        }]);
        const oldItems: ThreadItem[] = nativeSubagents
            ? [{
                type: "subAgentActivity", id: "old-child-started", kind: "started",
                agentThreadId: "old-child", agentPath: "/root/old_child", model: null, reasoningEffort: null,
            }]
            : [message("old-message", "Stale history")];
        const oldThread = threadWithItems(sessionId, oldItems);
        const newThread = threadWithItems(sessionId, [message("new-message", "Current history")]);
        vi.spyOn(client, "readSessionTurnItems").mockImplementation(async () =>
            (async function* () { yield [message("old-message", "Stale child history")]; })(),
        );
        let opens = 0;
        vi.spyOn(client, operation).mockImplementation(async (
            _request: unknown,
            onSubscribed?: () => void,
        ): Promise<SessionMetadataWithThread> => {
            onSubscribed?.();
            const thread = opens++ === 0 ? oldThread : newThread;
            return {
                sessionId, thread, history: threadHistory(thread), threadSnapshot: thread, activeTurnId: null,
                currentModelId: ModelId.create(model.id, model.defaultReasoningEffort).toString(),
                models: [model], collaborationMode: "default", modelProvider: "test-provider",
                currentServiceTier: null, additionalDirectories: [],
            };
        });
        const entered = deferred();
        const release = deferred();
        const historyMapper = agent as unknown as {
            createHistoryUpdates(item: ThreadItem, state: SessionState): Promise<UpdateSessionEvent[]>;
        };
        const createUpdates = historyMapper.createHistoryUpdates.bind(agent);
        vi.spyOn(historyMapper, "createHistoryUpdates").mockImplementation(async (item, state) => {
            if (item.id === "old-message") {
                entered.resolve();
                await release.promise;
            }
            return await createUpdates(item, state);
        });
        const oldOpen = agent[operation]({sessionId, cwd: "", mcpServers: []});
        const rejectedOldOpen = expect(oldOpen).rejects.toThrow("Invalid request");
        await entered.promise;
        const close = vi.spyOn(client, "closeSession");
        await agent.closeSession({sessionId});
        await agent[operation]({sessionId, cwd: "", mcpServers: []});
        const reopenedState = agent.getSessionState(sessionId);
        fixture.clearAcpConnectionDump();
        release.resolve();
        await rejectedOldOpen;
        await waitForNotifications(fixture, [sessionId]);
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
        expect(agent.getSessionState(sessionId)).toBe(reopenedState);
        expect(close).toHaveBeenCalledOnce();
        fixture.sendServerNotification(userMessageStarted(sessionId, "current-user", "phone", "Current live message"));
        await waitForNotifications(fixture, [sessionId]);
        expect(userMessageUpdates(fixture)).toEqual([
            {sessionId, messageId: "current-user", text: "Current live message"},
        ]);
    });

    it("applies remote settings and publishes config controls only for the matching session", async () => {
        const fixture = createCodexMockTestFixture();
        const model = createTestModel({
            id: "remote-model",
            supportedReasoningEfforts: [
                {reasoningEffort: "medium", description: "Balanced"},
                {reasoningEffort: "high", description: "Thorough"},
            ],
            additionalSpeedTiers: ["fast"],
        });
        await openNewSessions(fixture, ["session-1", "session-2"], model);

        fixture.sendServerNotification({
            method: "thread/settings/updated",
            params: {
                threadId: "session-1",
                threadSettings: {
                    cwd: "/remote/workspace",
                    approvalPolicy: "on-request",
                    approvalsReviewer: "user",
                    sandboxPolicy: {type: "readOnly", networkAccess: false},
                    activePermissionProfile: null,
                    model: model.id,
                    modelProvider: "test-provider",
                    serviceTier: "fast",
                    effort: "high",
                    summary: "auto",
                    collaborationMode: {
                        mode: "plan",
                        settings: {
                            model: model.id,
                            reasoning_effort: "high",
                            developer_instructions: null,
                        },
                    },
                    personality: "pragmatic",
                },
            },
        });
        await waitForNotifications(fixture, ["session-1"]);

        expect(fixture.getCodexAcpAgent().getSessionState("session-1")).toMatchObject({
            cwd: "/remote/workspace",
            currentModelId: "remote-model[high]",
            collaborationMode: "plan",
            fastModeEnabled: true,
            agentMode: {id: "read-only"},
        });
        expect(fixture.getCodexAcpAgent().getSessionState("session-2")).toMatchObject({
            cwd: "",
            currentModelId: "remote-model[medium]",
            collaborationMode: "default",
            fastModeEnabled: false,
            agentMode: {id: "agent"},
        });
        expect(configOptionUpdates(fixture)).toEqual([{
            sessionId: "session-1",
            values: {
                mode: "read-only",
                collaboration_mode: "plan",
                model: "remote-model",
                reasoning_effort: "high",
                "fast-mode": "on",
            },
        }]);
    });

    it("preserves completed dynamic tool content and terminal status", async () => {
        const fixture = createCodexMockTestFixture();
        await openNewSessions(fixture, ["session-1"]);

        fixture.sendServerNotification({
            method: "item/completed",
            params: {
                threadId: "session-1",
                turnId: "turn-1",
                completedAtMs: 0,
                item: {
                    type: "dynamicToolCall",
                    id: "dynamic-tool",
                    namespace: "apps",
                    tool: "list",
                    arguments: {includeDisabled: false},
                    status: "completed",
                    contentItems: [{type: "inputText", text: "Two apps found"}],
                    success: true,
                    durationMs: 25,
                },
            },
        });
        await waitForNotifications(fixture, ["session-1"]);

        expect(toolCallUpdates(fixture)).toEqual([{
            sessionId: "session-1",
            update: expect.objectContaining({
                sessionUpdate: "tool_call",
                toolCallId: "dynamic-tool",
                kind: "execute",
                title: "list",
                status: "completed",
                content: [{
                    type: "content",
                    content: {type: "text", text: "Two apps found"},
                }],
            }),
        }]);
    });

    it("steers a resumed active turn and suppresses only the matching local echo", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionId = "resumed-session";
        const activeTurnId = "active-turn";
        await openResumedSession(fixture, sessionId, activeTurnId);

        const appServer = fixture.getCodexAppServerClient();
        const turnStart = vi.spyOn(appServer, "turnStart").mockRejectedValue(
            new Error("turn/start must not be used while a resumed turn is active"),
        );
        const turnSteer = vi.spyOn(appServer, "turnSteer").mockImplementation(
            async (params: TurnSteerParams) => {
                fixture.sendServerNotification(userMessageStarted(
                    sessionId,
                    "local-echo",
                    params.clientUserMessageId ?? null,
                    "same text",
                    activeTurnId,
                ));
                return {turnId: activeTurnId};
            },
        );
        vi.spyOn(appServer, "awaitTurnCompleted").mockResolvedValue({
            threadId: sessionId,
            turn: createTurn(activeTurnId, "completed"),
        });

        await fixture.getCodexAcpAgent().prompt({
            sessionId,
            prompt: [{type: "text", text: "same text"}],
        });
        await waitForNotifications(fixture, [sessionId]);

        expect(turnStart).not.toHaveBeenCalled();
        expect(turnSteer).toHaveBeenCalledOnce();
        const steerParams = turnSteer.mock.calls[0]![0];
        expect(steerParams).toMatchObject({
            threadId: sessionId,
            expectedTurnId: activeTurnId,
            input: [{type: "text", text: "same text"}],
        });
        expect(steerParams.clientUserMessageId).toEqual(expect.any(String));
        expect(steerParams.clientUserMessageId).not.toHaveLength(0);
        expect(userMessageUpdates(fixture)).toEqual([]);

        fixture.sendServerNotification(userMessageStarted(
            sessionId,
            "remote-same-text",
            "phone-client-id",
            "same text",
            activeTurnId,
        ));
        await waitForNotifications(fixture, [sessionId]);

        expect(userMessageUpdates(fixture)).toEqual([
            {
                sessionId,
                messageId: "remote-same-text",
                text: "same text",
            },
        ]);
    });

    it("waits for remote resolution of unsupported server requests", async () => {
        const fixture = createCodexMockTestFixture();
        const responsePromise = fixture.sendServerRequest(
            "item/tool/call",
            {
                threadId: "remote-session",
                turnId: "turn-1",
                callId: "dynamic-call",
                namespace: "apps",
                tool: "lookup",
                arguments: {},
            },
            "dynamic-request",
        );
        let settled = false;
        void responsePromise.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        fixture.sendServerNotification({
            method: "serverRequest/resolved",
            params: {threadId: "remote-session", requestId: "dynamic-request"},
        });
        await expect(responsePromise).resolves.toEqual({contentItems: [], success: false});
    });
});

function deferred(): {promise: Promise<void>; resolve: () => void} {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return {promise, resolve};
}

async function openNewSessions(
    fixture: CodexMockTestFixture,
    sessionIds: string[],
    model: Model = createTestModel(),
): Promise<void> {
    const codexClient = fixture.getCodexAcpClient();
    const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();
    let nextSession = 0;

    vi.spyOn(codexClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(codexClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexClient, "newSession").mockImplementation(async () => {
        const sessionId = sessionIds[nextSession++];
        if (!sessionId) {
            throw new Error("Unexpected newSession call");
        }
        return {
            sessionId,
            currentModelId,
            models: [model],
            collaborationMode: "default",
            modelProvider: "test-provider",
            currentServiceTier: null,
            additionalDirectories: [],
            activeTurnId: null,
            threadSnapshot: createThread(sessionId),
        };
    });

    for (const sessionId of sessionIds) {
        const response = await fixture.getCodexAcpAgent().newSession({cwd: "", mcpServers: []});
        expect(response.sessionId).toBe(sessionId);
    }
    await flushAsyncWork();
    fixture.clearAcpConnectionDump();
}

async function openResumedSession(
    fixture: CodexMockTestFixture,
    sessionId: string,
    activeTurnId: string,
    options: ResumedSessionOptions = {},
): Promise<void> {
    const codexClient = fixture.getCodexAcpClient();
    const model = createTestModel();
    const currentModelId = ModelId.create(model.id, model.defaultReasoningEffort).toString();
    const activeTurn: Turn = {
        ...createTurn(activeTurnId, "inProgress"),
        items: options.snapshotItems ?? [],
    };

    vi.spyOn(codexClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
    vi.spyOn(codexClient, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(codexClient, "getGoal").mockResolvedValue(null);
    vi.spyOn(codexClient, "resumeSession").mockImplementation(async (_request, onSubscribed) => {
        for (const notification of options.queuedNotifications ?? []) {
            fixture.sendServerNotification(notification);
        }
        onSubscribed?.();
        return {
            sessionId,
            currentModelId,
            models: [model],
            collaborationMode: "default",
            modelProvider: "test-provider",
            currentServiceTier: null,
            additionalDirectories: [],
            activeTurnId,
            threadSnapshot: createThread(sessionId, [activeTurn]),
        };
    });

    await fixture.getCodexAcpAgent().resumeSession({
        sessionId,
        cwd: "",
        mcpServers: [],
    });
    await waitForNotifications(fixture, [sessionId]);
    if (options.clearAcpEvents !== false) {
        fixture.clearAcpConnectionDump();
    }
}

interface ResumedSessionOptions {
    snapshotItems?: Turn["items"];
    queuedNotifications?: ServerNotification[];
    clearAcpEvents?: boolean;
}

function createThread(id: string, turns: Turn[] = []): Thread {
    return {
        id,
        sessionId: id,
        forkedFromId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "legacy",
        originator: null,
        modelProvider: "test-provider",
        model: null,
        reasoningEffort: null,
        createdAt: 0,
        updatedAt: 0,
        recencyAt: null,
        status: turns.some(turn => turn.status === "inProgress")
            ? {type: "active", activeFlags: []}
            : {type: "idle"},
        path: null,
        cwd: "/test/cwd",
        cliVersion: "0.0.0",
        source: "appServer",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns,
    };
}

async function* threadHistory(thread: Thread): AsyncGenerator<ThreadItemEntry[]> {
    yield thread.turns.flatMap(turn => turn.items.map(item => ({
        turnId: turn.id,
        item,
        startedAtMs: item.startedAtMs ?? null,
        completedAtMs: item.completedAtMs ?? null,
    })));
}

function createTurn(id: string, status: "inProgress" | "completed"): Turn {
    return {
        id,
        rootTurnId: null,
        items: [],
        itemsView: "full",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function userMessageStarted(
    threadId: string,
    itemId: string,
    clientId: string | null,
    text: string,
    turnId = "turn-1",
): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId,
            startedAtMs: 0,
            item: {
                type: "userMessage",
                id: itemId,
                clientId,
                content: [{type: "text", text, text_elements: []}],
            },
        },
    };
}

function agentMessageStarted(threadId: string, itemId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: "turn-1",
            startedAtMs: 0,
            item: {
                type: "agentMessage",
                id: itemId,
                text: "",
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        },
    };
}

function agentMessageCompleted(threadId: string, itemId: string, text: string): ServerNotification {
    return {
        method: "item/completed",
        params: {
            threadId,
            turnId: "turn-1",
            completedAtMs: 0,
            item: {
                type: "agentMessage",
                id: itemId,
                text,
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        },
    };
}

function agentMessageDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    delta: string,
): ServerNotification {
    return {
        method: "item/agentMessage/delta",
        params: {threadId, turnId, itemId, delta},
    };
}

async function waitForNotifications(fixture: CodexMockTestFixture, sessionIds: string[]): Promise<void> {
    await Promise.all(sessionIds.map(sessionId =>
        fixture.getCodexAcpClient().waitForSessionNotifications(sessionId)
    ));
    await flushAsyncWork();
}

function userMessageUpdates(fixture: CodexMockTestFixture) {
    return fixture.getAcpConnectionEvents([]).flatMap((event) => {
        const request = event.args[0];
        const update = request?.update;
        if (event.method !== "sessionUpdate" || update?.sessionUpdate !== "user_message_chunk") {
            return [];
        }
        return [{
            sessionId: request.sessionId,
            messageId: update.messageId,
            text: update.content.text,
        }];
    });
}

function agentMessageUpdates(fixture: CodexMockTestFixture) {
    return fixture.getAcpConnectionEvents([]).flatMap((event) => {
        const request = event.args[0];
        const update = request?.update;
        if (event.method !== "sessionUpdate" || update?.sessionUpdate !== "agent_message_chunk") {
            return [];
        }
        return [{
            sessionId: request.sessionId,
            messageId: update.messageId,
            text: update.content.text,
        }];
    });
}

function configOptionUpdates(fixture: CodexMockTestFixture) {
    return fixture.getAcpConnectionEvents([]).flatMap((event) => {
        const request = event.args[0];
        const update = request?.update;
        if (event.method !== "sessionUpdate" || update?.sessionUpdate !== "config_option_update") {
            return [];
        }
        return [{
            sessionId: request.sessionId,
            values: Object.fromEntries(update.configOptions.map((option: {id: string; currentValue: unknown}) => [
                option.id,
                option.currentValue,
            ])),
        }];
    });
}

function toolCallUpdates(fixture: CodexMockTestFixture) {
    return fixture.getAcpConnectionEvents([]).flatMap((event) => {
        const request = event.args[0];
        const update = request?.update;
        if (event.method !== "sessionUpdate"
            || (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update")) {
            return [];
        }
        return [{sessionId: request.sessionId, update}];
    });
}

async function flushAsyncWork(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}
