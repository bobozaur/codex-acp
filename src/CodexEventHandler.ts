import type {
    ServerNotification
} from "./app-server";
import type {
    SessionFailure,
    SessionFailureAction,
    SessionFailureCategory,
    SessionState,
} from "./CodexAcpServer";
import {type Error as AcpError, type PlanEntry, RequestError} from "@agentclientprotocol/sdk/unstable";
import {ACPSessionConnection, type AcpClientConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import {normalizeSessionTitle} from "./SessionTitle";
import type {
    AccountRateLimitsUpdatedNotification,
    AccountUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    ConfigWarningNotification,
    DeprecationNoticeNotification,
    ErrorNotification,
    FileChangePatchUpdatedNotification,
    GuardianWarningNotification,
    HookCompletedNotification,
    HookStartedNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    Thread,
    ThreadItem,
    ModelReroutedNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ThreadRealtimeAudioChunk,
    ThreadRealtimeTranscriptDeltaNotification,
    ThreadRealtimeTranscriptDoneNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    Turn,
    TurnDiffUpdatedNotification,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import {toTokenCount} from "./TokenCount";
import { stripShellPrefix } from "./CommandUtils";
import {AcpToolCallRenderer} from "./tool-calls/AcpToolCallRenderer";
import {commandUsesTerminal} from "./tool-calls/reporters/CommandReporter";
import {CompactionReporter} from "./tool-calls/reporters/CompactionReporter";
import {DynamicToolReporter} from "./tool-calls/reporters/DynamicToolReporter";
import {FileChangeReporter} from "./tool-calls/reporters/FileChangeReporter";
import {FileCitationStream, renderFileCitations} from "./CodexFileCitations";
import {CodexItemStreamState} from "./CodexItemStreamState";
import {PLAIN_TOOL_CALL_ITEM_TYPES} from "./CodexSessionToolCalls";
import {ImageGenerationReporter} from "./tool-calls/reporters/ImageGenerationReporter";
import {ImageViewReporter} from "./tool-calls/reporters/ImageViewReporter";
import {McpToolReporter} from "./tool-calls/reporters/McpToolReporter";
import {WebSearchReporter} from "./tool-calls/reporters/WebSearchReporter";
import {CodexPlanStream, structuredPlanUpdate} from "./CodexPlanStream";
import {isWorkspaceRoutingUnavailableMessage} from "./CodexThreadErrors";
import {
    createCodexMessageMeta,
    createAgentMessageChunk,
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
    createUserMessageChunk,
    userInputToContentBlocks,
} from "./ContentChunks";
import {goalSessionInfoUpdate, sameThreadGoalSnapshot, toThreadGoalSnapshot} from "./ThreadGoalSnapshot";
import {logger} from "./Logger";
import {recordOrNull} from "./permissions/json";
import {
    AIR_EXTENSION_VERSION,
    AIR_EXTENSION_VERSION_KEY,
    AIR_META_KEY,
    AIR_SESSION_FAILURE_KEY,
    JETBRAINS_META_KEY,
    withAirMetadata,
} from "./AirExtension";
import type {SubagentEventRouter} from "./subagents/SubagentEventRouter";
import {StandardSubagentEventRouter} from "./subagents/StandardSubagentEventRouter";
import type {SubagentState} from "./subagents/AcpSubagents";
import {mergeRateLimitSnapshot} from "./RateLimitsMap";
import {AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES} from "./AgentFileChangeReport";
import {createSessionNotice} from "./SessionNotice";
import {isStaleAutomaticTitleEcho} from "./SessionIndexTitles";
import {readableServiceErrorMessage} from "./ServiceErrorMessage";

export { stripShellPrefix };

export type CompletedPlan = {
    itemId: string;
    text: string;
};

type CodexFailureKind =
    | "transport_lost" | "auth_required" | "rate_limited" | "quota_exhausted" | "overloaded"
    | "context_exhausted" | "budget_exhausted" | "policy_denied" | "bad_request"
    | "provider_error" | "internal_error";

type SessionFailurePolicy = {
    category: SessionFailureCategory;
    actions: SessionFailureAction[];
};

const MAX_SESSION_FAILURE_TITLE_LENGTH = 240;

const SESSION_FAILURE_POLICY: Record<CodexFailureKind, SessionFailurePolicy> = {
    transport_lost: {
        category: "connection",
        actions: ["retry", "new_session"],
    },
    auth_required: {
        category: "access",
        actions: ["login"],
    },
    rate_limited: {
        category: "limit",
        actions: ["retry"],
    },
    quota_exhausted: {
        category: "limit",
        actions: [],
    },
    overloaded: {
        category: "service",
        actions: ["retry"],
    },
    context_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    budget_exhausted: {
        category: "limit",
        actions: ["new_session"],
    },
    policy_denied: {
        category: "request",
        actions: [],
    },
    bad_request: {
        category: "request", actions: [],
    },
    provider_error: {
        category: "service",
        actions: ["retry"],
    },
    internal_error: {
        category: "service",
        actions: ["retry", "new_session"],
    },
};

const SYNTHETIC_FAILURE_TITLE: Record<"transport_lost" | "internal_error", string> = {
    transport_lost: "Connection to Codex was lost.",
    internal_error: "Codex encountered an internal error.",
};

/**
 * Records sharing an id form one logical banner whose revisions must increase; a new id restarts at 1.
 */
function nextSessionFailureRevision(previous: SessionFailure | undefined, id: string): number {
    return previous?.id === id ? previous.revision + 1 : 1;
}

type StringCodexErrorInfo = Extract<CodexErrorInfo, string>;
type StructuredCodexErrorInfo = Exclude<CodexErrorInfo, string>;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type StructuredCodexErrorKind = KeysOfUnion<StructuredCodexErrorInfo>;

/**
 * Known error codes map to ACP categories; extensible upstream codes fall back to provider_error.
 */
const STRING_CODEX_ERROR_CATEGORIES: Partial<Record<StringCodexErrorInfo, CodexFailureKind>> = {
    contextWindowExceeded: "context_exhausted",
    sessionBudgetExceeded: "budget_exhausted",
    usageLimitExceeded: "quota_exhausted",
    rateLimitExceeded: "rate_limited",
    flexUnavailable: "provider_error",
    serverOverloaded: "overloaded",
    cyberPolicy: "policy_denied",
    misalignmentPolicyViolation: "policy_denied",
    tooManyDenials: "provider_error",
    internalServerError: "internal_error",
    unauthorized: "auth_required",
    badRequest: "bad_request",
    threadRollbackFailed: "provider_error",
    sandboxError: "provider_error",
    other: "provider_error",
} satisfies Record<StringCodexErrorInfo, CodexFailureKind>;

const STRUCTURED_CODEX_ERROR_CATEGORIES: Partial<Record<StructuredCodexErrorKind, CodexFailureKind>> = {
    httpConnectionFailed: "transport_lost",
    responseStreamConnectionFailed: "transport_lost",
    responseStreamDisconnected: "transport_lost",
    responseTooManyFailedAttempts: "transport_lost",
    activeTurnNotSteerable: "provider_error",
} satisfies Record<StructuredCodexErrorKind, CodexFailureKind>;

/** Prompt failures whose text the client has already received as an agent message. */
const failuresShownAsMessages = new WeakSet<RequestError>();

/** Whether a prompt failure's text has already been sent to the client as an agent message. */
export function failureWasShownAsMessage(error: unknown): boolean {
    return error instanceof RequestError && failuresShownAsMessages.has(error);
}

export class CodexEventHandler {

    private readonly sessionState: SessionState;
    private readonly supportsTypedSessionFailures: boolean;
    private readonly sessionFailureEpoch: string;
    private readonly pendingErrors: ErrorNotification[] = [];
    private readonly failuresById = new Map<string, SessionFailure>();
    private readonly activeFailureIdByScope = new Map<string, string>();
    private readonly failureTurnIdById = new Map<string, string | undefined>();
    private readonly allocatedFailureScopes = new Set<string>();
    private lastSessionNotice: {key: string; failure: SessionFailure} | undefined;
    private nextNoticeId = 1;
    private failure: RequestError | null = null;
    private terminalTurnError: {turnId: string; error: ErrorNotification["error"]} | null = null;
    private completedPlan: CompletedPlan | null = null;
    private readonly session: ACPSessionConnection;
    private readonly renderer: AcpToolCallRenderer;
    private readonly itemStreams = new CodexItemStreamState();
    private readonly plans: CodexPlanStream;
    private disposed = false;
    private readonly turnDiffs = new Map<string, string>();
    private readonly oversizedTurnDiffs = new Set<string>();
    /** Latest diff of each subagent turn, keyed by child thread and turn; `null` marks an oversized diff. */
    private readonly childTurnDiffs = new Map<string, {rootTurnId: string; diff: string | null}>();
    /** The last root turn that ended, for subagent turns that outlive it. */
    private latestRootTurnId: string | null = null;
    private collectTurnDiffs: boolean;
    private readonly subagents: SubagentEventRouter;
    /** Connection-level `authStatus` sink; the app-server account push feeds it. */
    private readonly onAccountUpdated: ((notification: AccountUpdatedNotification) => void) | undefined;
    private readonly agentMessageMetadata = new Map<string, Pick<Extract<ThreadItem, {type: "agentMessage"}>, "phase" | "memoryCitation">>();
    private readonly emittedAgentMessageText = new Map<string, string>();
    private readonly pendingLocalUserMessageIds = new Set<string>();
    private readonly reviewTurnIds = new Set<string>();
    private readonly renderedUserMessageItemIds = new Set<string>();
    private readonly startedItemIds = new Set<string>();
    private readonly completedItemIds = new Set<string>();
    private readonly emittedToolCallIds = new Set<string>();
    private readonly snapshotPendingAgentText = new Map<string, string>();
    private readonly snapshotPendingReasoningSummaryText = new Map<string, string>();
    private readonly snapshotPendingReasoningRawText = new Map<string, string>();
    private readonly emittedReasoningSummaryText = new Map<string, string>();
    private readonly emittedReasoningRawText = new Map<string, string>();
    private readonly realtimeTranscripts = new Map<string, {messageId: string, text: string}>();
    private realtimeAudioMessageId: string | null = null;
    private standaloneMessageSequence = 0;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        supportsTypedSessionFailures: boolean,
        sessionFailureEpoch: string,
        subagents: SubagentEventRouter,
        onAccountUpdated: ((notification: AccountUpdatedNotification) => void) | undefined,
        collectTurnDiffs: boolean,
        private readonly supportsCompaction: boolean,
        private readonly supportsNotices: boolean,
    ) {
        this.onAccountUpdated = onAccountUpdated;
        this.sessionState = sessionState;
        this.supportsTypedSessionFailures = supportsTypedSessionFailures;
        this.sessionFailureEpoch = sessionFailureEpoch;
        this.session = new ACPSessionConnection(connection, sessionState.sessionId);
        this.renderer = new AcpToolCallRenderer(sessionState.clientCapabilities);
        this.plans = new CodexPlanStream(this.session, sessionState.clientCapabilities);
        this.subagents = subagents;
        this.collectTurnDiffs = collectTurnDiffs;
        if (sessionState.sessionFailure !== undefined) {
            this.failuresById.set(sessionState.sessionFailure.id, sessionState.sessionFailure);
        }
    }

    setCollectTurnDiffs(collect: boolean): void {
        this.collectTurnDiffs = collect;
        this.turnDiffs.clear();
        this.oversizedTurnDiffs.clear();
        this.childTurnDiffs.clear();
        this.latestRootTurnId = null;
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    /** Runtime outcomes, not AIR capability negotiation, determine standard v2 failures. */
    getTurnFailure(turn: Turn): AcpError | null {
        if (turn.status !== "failed") return null;
        const error = turn.error ?? (this.terminalTurnError?.turnId === turn.id ? this.terminalTurnError.error : null);
        if (this.isAuthenticationRequiredError(error?.codexErrorInfo ?? null)) {
            return {code: -32000, message: "Authentication required"};
        }
        return {code: -32603, message: readableServiceErrorMessage(error?.message ?? "Codex turn failed.")};
    }

    private recordTerminalTurnError(notification: ServerNotification): void {
        if (notification.method === "error" && notification.params.threadId === this.sessionState.sessionId
            && !notification.params.willRetry) {
            this.terminalTurnError = {turnId: notification.params.turnId, error: notification.params.error};
        }
    }

    /** The root turn's diff followed by the diffs of the subagent turns that ran during it. */
    getTurnDiff(turnId: string): string {
        const diffs = [this.turnDiffs.get(turnId) ?? ""];
        for (const child of this.childTurnDiffs.values()) {
            if (child.rootTurnId === turnId && child.diff !== null) diffs.push(child.diff);
        }
        return diffs
            .filter(diff => diff.trim() !== "")
            .reduce((all, diff) => all === "" || all.endsWith("\n") ? all + diff : `${all}\n${diff}`, "");
    }

    isTurnDiffOversized(turnId: string): boolean {
        return this.oversizedTurnDiffs.has(turnId)
            || [...this.childTurnDiffs.values()].some(child => child.rootTurnId === turnId && child.diff === null);
    }

    getTerminalSessionFailureMeta(
        turnId: string | null,
        allowUnattributed = false,
    ): Record<string, unknown> | null {
        const failure = this.sessionState.sessionFailure;
        if (!this.supportsTypedSessionFailures
            || failure === undefined
            || (this.failureTurnIdById.get(failure.id) === undefined
                ? !allowUnattributed
                : turnId === null || this.failureTurnIdById.get(failure.id) !== turnId)) {
            return null;
        }
        return this.createSessionFailureMeta(failure);
    }

    recordSyntheticTerminalFailure(kind: "transport_lost" | "internal_error", turnId: string | null): void {
        this.recordSessionFailure(kind, turnId ?? undefined, "error", SYNTHETIC_FAILURE_TITLE[kind]);
    }

    /**
     * Handles notifications while no ACP prompt owns the session. The app-server subscription remains
     * installed until the ACP session closes, so terminal errors need a durable session-level path instead
     * of entering a turn buffer that may never be flushed.
     */
    async handleSessionScopedNotification(notification: ServerNotification): Promise<void> {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (this.subagents instanceof StandardSubagentEventRouter && typeof threadId === "string"
            && threadId !== this.sessionState.sessionId) {
            await this.handleNotification(notification);
            return;
        }
        this.recordTerminalTurnError(notification);
        if (notification.method !== "error") {
            await this.handleNotification(notification);
            return;
        }
        if (!this.supportsTypedSessionFailures) {
            // Preserve the legacy behavior for clients that did not negotiate typed failures.
            await this.handleNotification(notification);
            return;
        }
        await this.finishCompactionsForNotification(notification);
        if (this.isAuthenticationRequiredError(notification.params.error.codexErrorInfo)) return;
        if (notification.params.willRetry) {
            await this.publishUpdate(this.createSessionFailureUpdate(this.recordRetryWarning(notification.params, false)));
            return;
        }
        const failure = this.recordSessionFailure(
            this.sessionFailureKind(notification.params.error),
            notification.params.turnId,
            "error",
            notification.params.error.message,
            undefined,
            false,
        );
        await this.publishUpdate(this.createSessionFailureUpdate(failure));
    }

    async flushPendingErrors(): Promise<void> {
        if (this.sessionState.currentTurnId === null || this.pendingErrors.length === 0) {
            return;
        }
        const errors = this.pendingErrors.splice(0);
        for (const error of errors) {
            const update = await this.createErrorEvent(error);
            if (update) {
                await this.publishUpdate(update);
            }
        }
    }

    async flushPendingErrorsAsSessionScoped(): Promise<void> {
        if (!this.supportsTypedSessionFailures || this.pendingErrors.length === 0) {
            return;
        }
        const errors = this.pendingErrors.splice(0);
        for (const error of errors) {
            await this.handleSessionScopedNotification({method: "error", params: error});
        }
    }

    async clearSessionFailure(): Promise<void> {
        const failure = this.sessionState.sessionFailure;
        delete this.sessionState.sessionFailure;
        if (!failure || this.session.protocolVersion !== 2) return;
        await this.session.patchSessionMetadata(metadata => {
            const jetbrains = recordOrNull(metadata[JETBRAINS_META_KEY]);
            const air = recordOrNull(jetbrains?.[AIR_META_KEY]);
            const published = recordOrNull(air?.[AIR_SESSION_FAILURE_KEY]);
            if (!air || published?.["id"] !== failure.id || published?.["revision"] !== failure.revision) return null;
            const {[AIR_SESSION_FAILURE_KEY]: _failure, ...currentAir} = air;
            return {[JETBRAINS_META_KEY]: {...jetbrains, [AIR_META_KEY]: currentAir}};
        });
    }

    async completeSuccessfulTurn(turnId: string | null): Promise<void> {
        this.lastSessionNotice = undefined;
        if (!this.supportsTypedSessionFailures || turnId === null) return;
        const active = this.sessionState.sessionFailure;
        if (active?.id !== this.activeFailureIdByScope.get(turnId) || active?.severity !== "warning") return;
        this.activeFailureIdByScope.delete(turnId);
        await this.clearSessionFailure();
    }

    async handleFailedTurn(turn: Turn): Promise<void> {
        if (turn.status === "failed" && this.isAuthenticationRequiredError(turn.error?.codexErrorInfo ?? null)) {
            this.failure = RequestError.authRequired();
            return;
        }
        const activeFailure = this.sessionState.sessionFailure;
        if (!this.supportsTypedSessionFailures
            || turn.status !== "failed"
            || this.failure !== null
            || this.failureTurnIdById.get(activeFailure?.id ?? "") === turn.id && activeFailure?.severity === "error") {
            return;
        }
        const error = turn.error ?? {
            message: "Turn failed",
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
        };
        this.recordTypedSessionFailure({
            threadId: this.sessionState.sessionId,
            turnId: turn.id,
            willRetry: false,
            error,
        });
    }

    takeCompletedPlan(): CompletedPlan | null {
        const plan = this.completedPlan;
        this.completedPlan = null;
        return plan;
    }

    async handleNotification(notification: ServerNotification) {
        const threadId = (notification.params as {threadId?: unknown}).threadId;
        if (this.subagents instanceof StandardSubagentEventRouter && this.subagents.isRetired()
            && typeof threadId === "string" && threadId !== this.sessionState.sessionId) return;
        this.recordTerminalTurnError(notification);
        if (notification.method === "item/started"
            && notification.params.threadId === this.sessionState.sessionId
            && isModelOutputItem(notification.params.item)) {
            this.sessionState.promptTokenUsage?.observeModelOutput();
        }
        // Before subagent routing, which drops updates of ended children and of spawns that never materialized.
        if (notification.method === "turn/diff/updated" && notification.params.threadId !== this.sessionState.sessionId) {
            this.recordChildTurnDiff(notification.params);
        }
        if (this.subagents instanceof StandardSubagentEventRouter && !await this.subagents.prepareNotification(notification)) {
            for (const event of this.subagents.takeBufferedNotifications()) await this.handleNotification(event);
            return;
        }
        await this.flushPendingErrors();
        await this.finishCompactionsForNotification(notification);
        const closingChildren = this.subagents.closingChildSessions(notification);
        for (const child of closingChildren) {
            if (this.subagents instanceof StandardSubagentEventRouter) {
                const turnId = notification.method === "turn/completed" ? notification.params.turn.id : undefined;
                for (const update of this.subagents.openToolCalls(child.threadId)?.finishOutstanding(turnId) ?? []) {
                    await this.session.update(update, child.sessionId);
                }
            }
            await this.finishOutstandingCompactions(
                child.state === "cancelled" ? "cancelled" : "failed",
                child.sessionId,
            );
            await this.sessionState.asyncTasks.reconcile(child.threadId, child.sessionId);
        }
        const handledBySubagents = await this.subagents.handle(notification);
        for (const buffered of this.subagents.takeBufferedNotifications()) {
            await this.handleNotification(buffered);
        }
        const ignoredBySubagents = !handledBySubagents && this.subagents.shouldIgnore(notification);
        let updateEvent: UpdateSessionEvent | null | undefined;
        if (!handledBySubagents
            && !ignoredBySubagents
            && notification.method === "item/started"
            && notification.params.item.type === "commandExecution") {
            updateEvent = await this.createUpdateEvent(notification);
        }
        if (!handledBySubagents) {
            await this.sessionState.asyncTasks.handleNotification(
                notification,
                this.subagents.notificationSessionId(notification),
                toolCallTitle(updateEvent),
            );
        }
        if (handledBySubagents) return;
        if (ignoredBySubagents) return;
        const updateEvents = updateEvent === undefined
            ? await this.createUpdateEvents(notification)
            : updateEvent === null ? [] : [updateEvent];
        for (const event of updateEvents) {
            await this.publishUpdate(event, this.subagents.notificationSessionId(notification));
        }
    }

    async waitForNativeSubagentSession(childThreadId: string): Promise<string | null> {
        return await this.subagents.waitForMaterializedSession(childThreadId);
    }

    async waitForNativeSubagents(signal: AbortSignal): Promise<void> {
        if (await this.subagents.wait(signal) === "timed_out") {
            await this.finishOutstandingNativeSubagents("failed");
        }
    }

    async finishOutstandingNativeSubagents(state: SubagentState): Promise<void> {
        await this.finishOutstandingCompactions(state === "cancelled" ? "cancelled" : "failed");
        await this.subagents.finishOutstanding(state);
    }

    async finishOutstandingCompactions(status: "failed" | "cancelled", sessionId?: string): Promise<void> {
        if (!this.supportsCompaction) return;
        for (const {sessionId: targetSessionId, update} of this.sessionState.compactions.finishOutstanding(status, sessionId)) {
            await this.session.update(update, targetSessionId);
        }
    }

    private async finishCompactionsForNotification(notification: ServerNotification): Promise<void> {
        if (!this.supportsCompaction) return;
        let updates: UpdateSessionEvent[];
        const sessionId = this.subagents.notificationSessionId(notification);
        if (notification.method === "turn/completed") {
            const turn = notification.params.turn;
            if (turn.status === "inProgress") return;
            updates = this.sessionState.compactions.finishTurn(
                sessionId,
                turn.id,
                turn.status === "interrupted" ? "cancelled" : "failed",
                turn.error?.message ?? "Codex ended the turn before compaction completed.",
            );
        } else if (notification.method === "error" && !notification.params.willRetry) {
            updates = this.sessionState.compactions.finishTurn(
                sessionId,
                notification.params.turnId,
                "failed",
                notification.params.error.message,
            );
        } else {
            return;
        }
        for (const update of updates) await this.session.update(update, sessionId);
    }

    async flushPendingPlanUpdates(): Promise<void> {
        await this.plans.flush();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.plans.dispose();
        if (this.pendingErrors.length > 0) {
            logger.log("Discarding app-server errors that arrived before a turn started", {
                sessionId: this.sessionState.sessionId,
                count: this.pendingErrors.length,
                turnIds: this.pendingErrors.map(error => error.turnId),
            });
            this.pendingErrors.splice(0);
        }
        this.disposed = true;
        this.turnDiffs.clear();
        this.oversizedTurnDiffs.clear();
        this.childTurnDiffs.clear();
        this.finishSnapshotReplay();
    }

    /** Subagent threads report their own turn diffs; the root turn's file-change report must include them. */
    private recordChildTurnDiff(params: TurnDiffUpdatedNotification): void {
        if (this.disposed || !this.collectTurnDiffs) return;
        const key = `${params.threadId}\n${params.turnId}`;
        // A child turn stays with the root turn it started under, even if its diff updates arrive later.
        const rootTurnId = this.childTurnDiffs.get(key)?.rootTurnId
            ?? this.sessionState.currentTurnId
            ?? this.latestRootTurnId;
        if (rootTurnId === null) return;
        const oversized = Buffer.byteLength(params.diff, "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES;
        this.childTurnDiffs.set(key, {rootTurnId, diff: oversized ? null : params.diff});
    }

    clearFailure(): void {
        this.failure = null;
        this.completedPlan = null;
        if (this.sessionState.currentTurnId === null && this.pendingErrors.length > 0) {
            logger.log("Discarding session-scoped app-server errors before a new ACP prompt", {
                sessionId: this.sessionState.sessionId,
                count: this.pendingErrors.length,
                turnIds: this.pendingErrors.map(error => error.turnId),
            });
            this.pendingErrors.splice(0);
        }
    }

    registerLocalUserMessage(clientUserMessageId: string): void {
        this.pendingLocalUserMessageIds.add(clientUserMessageId);
    }

    discardLocalUserMessage(clientUserMessageId: string): void {
        this.pendingLocalUserMessageIds.delete(clientUserMessageId);
    }

    seedThreadSnapshot(thread: Thread): void {
        for (const turn of thread.turns) {
            this.seedSnapshotItems(turn.items, turn.status !== "inProgress", thread.id);
            if (turn.status === "inProgress") {
                for (const item of turn.items) this.observeReviewMode(item, thread.id, turn.id);
            }
        }
    }

    seedHistoryItems(items: ThreadItem[]): void {
        this.seedSnapshotItems(items, false, this.sessionState.sessionId);
    }

    private seedSnapshotItems(items: ThreadItem[], turnCompleted: boolean, threadId: string): void {
        for (const item of items) {
            this.startedItemIds.add(`${threadId}:${item.id}`);
            if (turnCompleted) {
                this.completedItemIds.add(`${threadId}:${item.id}`);
            }
            switch (item.type) {
                case "userMessage":
                    this.renderedUserMessageItemIds.add(`${threadId}:${item.id}`);
                    break;
                case "agentMessage":
                    if (!turnCompleted) {
                        this.rememberAgentMessage(item, threadId);
                        this.emittedAgentMessageText.set(`${threadId}:${item.id}`, item.text);
                        this.snapshotPendingAgentText.set(`${threadId}:${item.id}`, item.text);
                    }
                    break;
                case "reasoning":
                    if (!turnCompleted) {
                        this.emittedReasoningSummaryText.set(`${threadId}:${item.id}`, this.reasoningSummaryText(item));
                        this.emittedReasoningRawText.set(`${threadId}:${item.id}`, this.reasoningRawText(item));
                        this.snapshotPendingReasoningSummaryText.set(`${threadId}:${item.id}`, this.reasoningSummaryText(item));
                        this.snapshotPendingReasoningRawText.set(`${threadId}:${item.id}`, this.reasoningRawText(item));
                    }
                    break;
                case "commandExecution":
                    this.emittedToolCallIds.add(`${threadId}:${item.id}`);
                    this.streamsFor(threadId).commands.started(item);
                    break;
                case "fileChange":
                case "mcpToolCall":
                case "dynamicToolCall":
                case "collabAgentToolCall":
                case "subAgentActivity":
                case "webSearch":
                case "imageView":
                case "imageGeneration":
                case "contextCompaction":
                    this.emittedToolCallIds.add(`${threadId}:${item.id}`);
                    break;
                case "hookPrompt":
                case "functionCallOutput":
                case "plan":
                case "sleep":
                case "enteredReviewMode":
                case "exitedReviewMode":
                    break;
            }
        }
    }

    finishSnapshotReplay(): void {
        this.snapshotPendingAgentText.clear();
        this.snapshotPendingReasoningSummaryText.clear();
        this.snapshotPendingReasoningRawText.clear();
    }

    private async createUpdateEvents(notification: ServerNotification): Promise<UpdateSessionEvent[]> {
        if (notification.method === "item/started" || notification.method === "item/completed") {
            this.observeReviewMode(notification.params.item, notification.params.threadId, notification.params.turnId);
        }
        if (notification.method === "item/started" && notification.params.item.type === "userMessage") {
            this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
            return this.createUserMessageEvents(notification.params.item, notification.params.threadId, notification.params.turnId);
        }
        if (notification.method === "item/completed" && notification.params.item.type === "userMessage") {
            this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
            if (this.completedItemIds.has(`${notification.params.threadId}:${notification.params.item.id}`)) {
                return [];
            }
            const updates = this.createUserMessageEvents(notification.params.item, notification.params.threadId, notification.params.turnId);
            this.completedItemIds.add(`${notification.params.threadId}:${notification.params.item.id}`);
            return updates;
        }
        const update = await this.createUpdateEvent(notification);
        return update ? [update] : [];
    }

    private async createUpdateEvent(notification: ServerNotification): Promise<UpdateSessionEvent | null> {
        /*
        TODO split UpdateSessionEvent to improve completion
        createUpdateEvent({
            sessionUpdate: "" , <- completion of UpdateSessionEvent["sessionUpdate"]
            params: {}, <- quickfix to generate required fields (rest of)
        });
         */
        switch (notification.method) {
            case "item/agentMessage/delta":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return await this.createTextEvent(notification.params);
            case "item/plan/delta":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return this.plans.delta(notification.params.itemId, notification.params.delta);
            case "item/started": {
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                const update = await this.createItemEvent(notification.params);
                this.trackOpenToolCall(notification.params.item, notification.params.threadId, notification.params.turnId);
                return update;
            }
            case "item/completed":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                this.openToolCalls(notification.params.threadId).complete(notification.params.item.id);
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return await this.updatePlan(notification.params);
            case "turn/diff/updated":
                if (notification.params.threadId === this.sessionState.sessionId) {
                    this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                    if (!this.disposed && this.collectTurnDiffs) {
                        if (Buffer.byteLength(notification.params.diff, "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES) {
                            this.turnDiffs.delete(notification.params.turnId);
                            this.oversizedTurnDiffs.add(notification.params.turnId);
                        } else {
                            // Codex 0.154 emits an empty snapshot when its tracker transitions
                            // from a non-empty aggregate to no diff, which clears stale state here.
                            this.oversizedTurnDiffs.delete(notification.params.turnId);
                            this.turnDiffs.set(notification.params.turnId, notification.params.diff);
                        }
                    }
                }
                return null;
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.interruptTurnId = notification.params.turn.id;
                // A review's child turn starts under its own id, while the review's items, errors and
                // completion keep the parent id already set from the `review/start` response.
                this.sessionState.currentTurnId ??= notification.params.turn.id;
                await this.flushPendingErrors();
                return null;
            case "turn/completed":
                this.reviewTurnIds.delete(`${notification.params.threadId}:${notification.params.turn.id}`);
                await this.plans.flush();
                this.plans.clearTurn();
                // Subagents can keep running after the root turn ends; their turns still belong to it.
                this.latestRootTurnId = this.sessionState.currentTurnId ?? this.latestRootTurnId;
                if (this.sessionState.currentTurnId === notification.params.turn.id) {
                    this.sessionState.currentTurnId = null;
                    this.sessionState.interruptTurnId = null;
                }
                if (this.session.protocolVersion === 2 && notification.params.turn.status === "failed") {
                    for (const update of this.sessionState.openToolCalls.finishOutstanding()) {
                        await this.session.update(update, this.subagents.notificationSessionId(notification));
                    }
                }
                this.sessionState.toolCallReports.releaseOpen(this.subagents.notificationSessionId(notification));
                // An item that missed its item/completed (e.g. dropped by a provider restart
                // mid-turn) must not linger past its own turn and get failed by a later restart.
                this.sessionState.openToolCalls.clear();
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "thread/name/updated":
                if (isStaleAutomaticTitleEcho(this.sessionState, normalizeSessionTitle(notification.params.threadName))) {
                    this.sessionState.titleGen?.observeRename();
                    return null;
                }
                this.sessionState.sessionTitle = normalizeSessionTitle(notification.params.threadName);
                this.sessionState.sessionTitleSource = notification.params.threadName == null
                    ? "unset"
                    : "explicit";
                this.sessionState.titleGen?.observeRename();
                return {
                    sessionUpdate: "session_info_update",
                    title: this.sessionState.sessionTitle,
                };
            case "thread/status/changed":
                return this.createCodexSessionInfoUpdate({
                    threadStatus: notification.params.status,
                });
            case "thread/archived":
                return this.createCodexSessionInfoUpdate({
                    archived: true,
                });
            case "thread/unarchived":
                return this.createCodexSessionInfoUpdate({
                    archived: false,
                });
            case "thread/closed":
                return this.createCodexSessionInfoUpdate({
                    closed: true,
                });
            case "item/commandExecution/outputDelta":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return this.renderer.render(this.streamsFor(notification.params.threadId).commands.outputDelta(notification.params.itemId, notification.params.delta));
            case "item/mcpToolCall/progress":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                // AIR does not show MCP progress.
                if (this.renderer.capabilities.airToolCallContract) return null;
                return this.renderer.render(McpToolReporter.progress(
                    notification.params.itemId,
                    notification.params.message,
                ));
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "account/updated":
                this.onAccountUpdated?.(notification.params);
                return null;
            case "configWarning":
                return await this.createConfigWarningEvent(notification.params);
            case "warning":
                return this.createWarningEvent(notification.params);
            case "guardianWarning":
                return this.createGuardianWarningEvent(notification.params);
            case "deprecationNotice":
                return this.createDeprecationNoticeEvent(notification.params);
            case "item/autoApprovalReview/started":
                return this.renderer.render(this.streamsFor(notification.params.threadId).guardianReviews.started(notification.params));
            case "item/autoApprovalReview/completed":
                return this.renderer.render(this.streamsFor(notification.params.threadId).guardianReviews.completed(notification.params));
            case "thread/compacted":
                return this.supportsCompaction
                    ? this.sessionState.compactions.completeLegacy(
                        this.subagents.notificationSessionId(notification), notification.params.turnId,
                    )
                    : this.createContextCompactedEvent();
            case "item/reasoning/summaryTextDelta":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return this.createReasoningDeltaEvent(notification.params, "summary");
            case "item/reasoning/textDelta":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return this.createReasoningDeltaEvent(notification.params, "raw");
            case "item/reasoning/summaryPartAdded":
                this.completeRetryIncidentOnTurnProgress(notification.params.threadId);
                return this.createReasoningSectionBreakEvent(notification.params);
            case "model/rerouted":
                return this.createModelReroutedEvent(notification.params);
            case "fuzzyFileSearch/sessionUpdated":
                return this.renderer.render(this.itemStreams.fuzzySearches.updated(notification.params));
            case "fuzzyFileSearch/sessionCompleted":
                return this.renderer.render(this.itemStreams.fuzzySearches.completed(notification.params));
            case "thread/goal/updated":
                return this.createThreadGoalUpdatedEvent(notification.params);
            case "thread/goal/cleared":
                return this.createThreadGoalClearedEvent(notification.params);
            case "item/commandExecution/terminalInteraction":
                return this.renderer.render(this.streamsFor(notification.params.threadId).commands.terminalInput(
                    notification.params.itemId,
                    notification.params.stdin,
                ));
            case "thread/attachment/updated":
                // Persisted attachment metadata has no ACP session update counterpart.
                return null;
            case "account/gatewayOAuth/changed":
                // Gateway login state is account-scoped and has no ACP session update counterpart.
                return null;
            case "skills/changed":
                // The server lists the skills again and publishes the commands. The change itself is no update.
                return null;
            // ignored events
            // Read markers and predictions have no ACP session update counterpart.
            case "thread/readState/changed":
            case "thread/prediction/updated":
                return null;
            case "item/fileChange/patchUpdated":
                return await this.createFileChangePatchEvent(notification.params);
            case "hook/started":
                return this.createHookStartedEvent(notification.params);
            case "hook/completed":
                return this.createHookCompletedEvent(notification.params);
            case "thread/realtime/transcript/delta":
                return this.createRealtimeTranscriptDeltaEvent(notification.params);
            case "thread/realtime/transcript/done":
                return this.createRealtimeTranscriptDoneEvent(notification.params);
            case "thread/realtime/error":
                return createAgentTextMessageChunk(
                    `Realtime error: ${notification.params.message}\n\n`,
                    this.nextStandaloneMessageId("realtime-error"),
                );
            case "thread/realtime/started":
                return this.createCodexSessionInfoUpdate({realtime: {
                    status: "started",
                    sessionId: notification.params.realtimeSessionId,
                    version: notification.params.version,
                }});
            case "thread/realtime/itemAdded":
                return this.createCodexSessionInfoUpdate({realtimeItem: notification.params.item});
            case "thread/realtime/outputAudio/delta":
                return this.createRealtimeAudioEvent(notification.params.audio);
            case "thread/realtime/closed":
                this.realtimeAudioMessageId = null;
                return this.createCodexSessionInfoUpdate({realtime: {
                    status: "closed",
                    reason: notification.params.reason,
                }});
            case "thread/deleted":
                return this.createCodexSessionInfoUpdate({deleted: true});
            case "remoteControl/status/changed":
                return this.createCodexSessionInfoUpdate({remoteControl: notification.params});
            case "model/verification":
                return this.createCodexSessionInfoUpdate({modelVerification: notification.params.verifications});
            case "model/safetyBuffering/updated":
                return this.createCodexSessionInfoUpdate({modelSafetyBuffering: notification.params});
            // ignored events
            case "command/exec/outputDelta":
            case "thread/reverted":
            case "thread/queue/changed":
            case "project/changed":
            case "thread/project/updated":
            case "thread/environment/connected":
            case "thread/environment/disconnected":
            case "turn/moderationMetadata":
            case "item/fileChange/outputDelta":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
            case "mcpServer/event/stream/notification":
            case "serverRequest/resolved":
            case "modelProvider/authRecoveryStarted":
            case "modelProvider/authRecoveryCompleted":
            case "windows/worldWritableWarning":
            case "thread/realtime/item/started":
            case "thread/realtime/item/transcript/delta":
            case "thread/realtime/item/completed":
            case "thread/realtime/sdp":
            case "windowsSandbox/setupCompleted":
            case "account/login/completed":
            case "mcpServer/oauthLogin/completed":
            case "externalAgentConfig/import/completed":
            case "rawResponseItem/completed":
            case "rawResponse/completed":
            case "thread/started":
            case "app/list/updated":
            case "thread/settings/updated":
            case "externalAgentConfig/import/progress":
            case "process/outputDelta":
            case "process/exited":
            case "autoApprovalReview/strictReviewRequired":
                return null;
        }
    }

    /** These fact builders produce partial owned namespaces, unlike raw metadata patches. */
    private publishUpdate(update: UpdateSessionEvent, sessionId = this.sessionState.sessionId): Promise<void> {
        if (this.session.protocolVersion !== 2 || update.sessionUpdate !== "session_info_update" || update._meta == null) {
            return this.session.update(update, sessionId);
        }
        const {_meta, sessionUpdate: _tag, ...fields} = update;
        return this.session.forSession(sessionId).patchSessionMetadata(current => {
            const metadata = {..._meta};
            const codex = recordOrNull(_meta["codex"]);
            if (codex) metadata["codex"] = {...recordOrNull(current["codex"]), ...codex};
            const air = recordOrNull(recordOrNull(_meta[JETBRAINS_META_KEY])?.[AIR_META_KEY]);
            if (air) metadata[JETBRAINS_META_KEY] = withAirMetadata(current, air)[JETBRAINS_META_KEY];
            return metadata;
        }, fields);
    }

    private createCodexSessionInfoUpdate(codexMetadata: Record<string, unknown>): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: {
                codex: codexMetadata,
            },
        };
    }

    private async createTextEvent(event: AgentMessageDeltaNotification): Promise<UpdateSessionEvent | null> {
        if (this.completedItemIds.has(`${event.threadId}:${event.itemId}`)) return null;
        const delta = this.reconcileSnapshotDelta(this.snapshotPendingAgentText, `${event.threadId}:${event.itemId}`, event.delta);
        if (delta.length === 0) return null;
        this.appendEmittedText(this.emittedAgentMessageText, `${event.threadId}:${event.itemId}`, delta);
        const streams = this.streamsFor(event.threadId);
        let citations = streams.agentMessageCitations.get(event.itemId);
        if (citations === undefined) {
            citations = new FileCitationStream(this.sessionState.cwd);
            streams.agentMessageCitations.set(event.itemId, citations);
        }
        return this.createAgentMessageText(citations.push(delta), event.itemId, event.threadId);
    }

    /**
     * Sends the text a file citation held back, once the message is complete. A message that
     * arrives whole, without deltas (an async question, for one), is sent in full.
     */
    private flushAgentMessageText(item: ThreadItem & { type: "agentMessage" }, threadId: string): UpdateSessionEvent | null {
        const streams = this.streamsFor(threadId);
        const citations = streams.agentMessageCitations.get(item.id);
        streams.agentMessageCitations.delete(item.id);
        const suffix = missingTextSuffix(this.emittedAgentMessageText.get(`${threadId}:${item.id}`) ?? "", item.text, true);
        this.emittedAgentMessageText.delete(`${threadId}:${item.id}`);
        const text = citations ? citations.push(suffix) + citations.flush() : renderFileCitations(suffix, this.sessionState.cwd);
        return this.createAgentMessageText(text, item.id, threadId);
    }

    private createAgentMessageText(text: string, itemId: string, threadId: string): UpdateSessionEvent | null {
        if (text.length === 0) return null;
        const phase = this.streamsFor(threadId).agentMessagePhases.get(itemId) ?? null;
        const meta = createCodexMessageMeta(
            phase, this.agentMessageMetadata.get(`${threadId}:${itemId}`)?.memoryCitation, this.sessionState.clientCapabilities.airClient,
        );
        return createAgentTextMessageChunk(text, itemId, meta);
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.summary.trim() || "Configuration warning", event.details);
        }
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)));
        }
        const text = event.details ? `${event.summary}\n\n${event.details}` : event.summary;
        return createAgentTextMessageChunk(`Config warning: ${text}\n\n`);
    }

    private createDeprecationNoticeEvent(event: DeprecationNoticeNotification): UpdateSessionEvent | null {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.summary.trim() || "Deprecated configuration", event.details);
        }
        // Legacy clients without typed failures have never received deprecation notices.
        if (!this.supportsTypedSessionFailures) return null;
        return this.createSessionFailureUpdate(
            this.recordSessionNotice(...this.sessionNoticeContent(event.summary, event.details)),
        );
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        if (this.supportsNotices) {
            return createSessionNotice("warning", event.message.trim() || "Codex warning");
        }
        if (this.supportsTypedSessionFailures) {
            return this.createSessionFailureUpdate(this.recordSessionNotice(event.message));
        }
        return createAgentTextMessageChunk(`Warning: ${event.message}\n\n`);
    }

    private createGuardianWarningEvent(event: GuardianWarningNotification): UpdateSessionEvent {
        return createAgentTextMessageChunk(
            `Guardian warning: ${event.message}\n\n`,
            this.nextStandaloneMessageId("guardian-warning"),
        );
    }

    private createFileChangePatchEvent(event: FileChangePatchUpdatedNotification): UpdateSessionEvent {
        return this.renderer.render({
            ...FileChangeReporter.started({
                type: "fileChange", id: event.itemId, status: "inProgress", changes: event.changes,
            }, this.sessionState.clientCapabilities.diffPatchFormat),
            report: "update",
        });
    }

    private createHookStartedEvent(event: HookStartedNotification): UpdateSessionEvent {
        this.emittedToolCallIds.add(`${event.threadId}:hook:${event.run.id}`);
        return {
            sessionUpdate: "tool_call",
            toolCallId: `hook:${event.run.id}`,
            kind: "other",
            title: `Hook: ${event.run.eventName}`,
            status: "in_progress",
            rawInput: this.hookRawData(event.run),
            content: this.hookContent(event.run.entries),
        };
    }

    private createHookCompletedEvent(event: HookCompletedNotification): UpdateSessionEvent {
        const toolCallId = `hook:${event.run.id}`;
        const hadStart = this.emittedToolCallIds.delete(`${event.threadId}:${toolCallId}`);
        if (hadStart) {
            return {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: event.run.status === "completed" ? "completed" : "failed",
                rawOutput: this.hookRawData(event.run),
                content: this.hookContent(event.run.entries),
            };
        }
        return {
            sessionUpdate: "tool_call",
            toolCallId,
            kind: "other",
            title: `Hook: ${event.run.eventName}`,
            status: event.run.status === "completed" ? "completed" : "failed",
            rawOutput: this.hookRawData(event.run),
            content: this.hookContent(event.run.entries),
        };
    }

    private hookRawData(run: HookStartedNotification["run"]): Record<string, unknown> {
        return {
            eventName: run.eventName,
            handlerType: run.handlerType,
            executionMode: run.executionMode,
            scope: run.scope,
            source: run.source,
            sourcePath: run.sourcePath,
            status: run.status,
            statusMessage: run.statusMessage,
            durationMs: run.durationMs?.toString() ?? null,
        };
    }

    private hookContent(entries: HookStartedNotification["run"]["entries"]): Array<{
        type: "content";
        content: {type: "text"; text: string};
    }> {
        return entries.map(entry => ({
            type: "content",
            content: {type: "text", text: `${entry.kind}: ${entry.text}`},
        }));
    }

    private createRealtimeTranscriptDeltaEvent(event: ThreadRealtimeTranscriptDeltaNotification): UpdateSessionEvent {
        const transcript = this.realtimeTranscripts.get(event.role) ?? {
            messageId: this.nextStandaloneMessageId(`realtime-${event.role}`),
            text: "",
        };
        transcript.text += event.delta;
        this.realtimeTranscripts.set(event.role, transcript);
        return event.role === "user"
            ? createUserMessageChunk({type: "text", text: event.delta}, transcript.messageId)
            : createAgentTextMessageChunk(event.delta, transcript.messageId);
    }

    private createRealtimeTranscriptDoneEvent(event: ThreadRealtimeTranscriptDoneNotification): UpdateSessionEvent | null {
        const transcript = this.realtimeTranscripts.get(event.role);
        this.realtimeTranscripts.delete(event.role);
        const messageId = transcript?.messageId ?? this.nextStandaloneMessageId(`realtime-${event.role}`);
        const suffix = missingTextSuffix(transcript?.text ?? "", event.text, true);
        if (suffix.length === 0) {
            return null;
        }
        return event.role === "user"
            ? createUserMessageChunk({type: "text", text: suffix}, messageId)
            : createAgentTextMessageChunk(suffix, messageId);
    }

    private createRealtimeAudioEvent(audio: ThreadRealtimeAudioChunk): UpdateSessionEvent {
        const messageId = audio.itemId
            ?? this.realtimeAudioMessageId
            ?? this.nextStandaloneMessageId("realtime-audio");
        this.realtimeAudioMessageId = messageId;
        return createAgentMessageChunk({
            type: "audio",
            data: audio.data,
            mimeType: `audio/pcm;rate=${audio.sampleRate};channels=${audio.numChannels}`,
            _meta: {
                codex: {
                    sampleRate: audio.sampleRate,
                    numChannels: audio.numChannels,
                    samplesPerChannel: audio.samplesPerChannel,
                    itemId: audio.itemId,
                },
            },
        }, messageId);
    }

    private nextStandaloneMessageId(kind: string): string {
        this.standaloneMessageSequence += 1;
        return `${kind}:${this.standaloneMessageSequence}`;
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        if (!this.supportsNotices) {
            return createAgentTextThoughtChunk(`Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`);
        }
        return createSessionNotice(
            "info",
            "Model rerouted",
            `Switched from ${event.fromModel} to ${event.toModel} (${event.reason}).`,
        );
    }

    private createThreadGoalUpdatedEvent(event: ThreadGoalUpdatedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        const goalSnapshot = toThreadGoalSnapshot(event.goal);
        if (sameThreadGoalSnapshot(this.sessionState.currentGoal, goalSnapshot)) {
            return null;
        }
        this.sessionState.currentGoal = goalSnapshot;

        return goalSessionInfoUpdate(goalSnapshot, this.sessionState.clientCapabilities.airClient);
    }

    private createThreadGoalClearedEvent(_event: ThreadGoalClearedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        if (this.sessionState.currentGoal === null) {
            return null;
        }
        this.sessionState.currentGoal = null;

        return goalSessionInfoUpdate(null, this.sessionState.clientCapabilities.airClient);
    }

    private createReasoningDeltaEvent(
        event: ReasoningSummaryTextDeltaNotification | ReasoningTextDeltaNotification,
        kind: "summary" | "raw",
    ): UpdateSessionEvent | null {
        if (this.completedItemIds.has(`${event.threadId}:${event.itemId}`)) {
            return null;
        }
        const pending = kind === "summary"
            ? this.snapshotPendingReasoningSummaryText
            : this.snapshotPendingReasoningRawText;
        const emitted = kind === "summary"
            ? this.emittedReasoningSummaryText
            : this.emittedReasoningRawText;
        const delta = this.reconcileSnapshotDelta(pending, `${event.threadId}:${event.itemId}`, event.delta);
        if (delta.length === 0) {
            return null;
        }
        this.appendEmittedText(emitted, `${event.threadId}:${event.itemId}`, delta);
        return this.createAgentThoughtEvent(delta, event.itemId);
    }

    private createReasoningSectionBreakEvent(event: ReasoningSummaryPartAddedNotification): UpdateSessionEvent | null {
        if (this.completedItemIds.has(`${event.threadId}:${event.itemId}`)) {
            return null;
        }
        const delta = this.reconcileSnapshotDelta(
            this.snapshotPendingReasoningSummaryText,
            `${event.threadId}:${event.itemId}`,
            "\n\n",
        );
        if (delta.length === 0) {
            return null;
        }
        this.appendEmittedText(this.emittedReasoningSummaryText, `${event.threadId}:${event.itemId}`, delta);
        return this.createAgentThoughtEvent(delta, event.itemId);
    }

    private createAgentThoughtEvent(text: string, messageId: string): UpdateSessionEvent {
        return createAgentTextThoughtChunk(text, messageId);
    }

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        if (this.startedItemIds.has(`${event.threadId}:${event.item.id}`)) {
            return null;
        }
        this.startedItemIds.add(`${event.threadId}:${event.item.id}`);
        this.emittedToolCallIds.add(`${event.threadId}:${event.item.id}`);
        switch (event.item.type) {
            case "fileChange":
                return this.renderer.render(FileChangeReporter.started(
                    event.item,
                    this.sessionState.clientCapabilities.diffPatchFormat,
                ));
            case "commandExecution":
                return this.renderer.render(this.streamsFor(event.threadId).commands.started(event.item));
            case "mcpToolCall":
                return this.renderer.render(McpToolReporter.started(event.item));
            case "dynamicToolCall":
                return this.renderer.render(DynamicToolReporter.started(event.item));
            case "webSearch":
                return this.renderer.render(WebSearchReporter.started(event.item));
            case "imageView":
                this.streamsFor(event.threadId).emittedImageViewItems.add(event.item.id);
                return this.renderer.render(ImageViewReporter.viewed(event.item));
            case "imageGeneration":
                this.streamsFor(event.threadId).activeImageGenerationItems.add(event.item.id);
                return this.renderer.render(ImageGenerationReporter.started(event.item));
            case "collabAgentToolCall":
                return this.renderer.render(this.subagents.legacyCollaborationStarted(event.item));
            case "agentMessage":
                this.rememberAgentMessage(event.item, event.threadId);
                return null;
            case "contextCompaction":
                return this.supportsCompaction
                    ? this.sessionState.compactions.start(
                        this.subagents.notificationSessionId({method: "item/started", params: event}),
                        event.turnId, event.item.id,
                    )
                    : this.renderer.render(CompactionReporter.started(event.item));
            case "subAgentActivity":
                return this.renderer.render(this.subagents.legacyActivityStarted(event.item));
            case "sleep":
            case "functionCallOutput":
            case "userMessage":
            case "hookPrompt":
            case "reasoning":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "plan":
                return null;
        }
    }

    private async completeItemEvent(event: ItemCompletedNotification): Promise<UpdateSessionEvent | null> {
        if (this.completedItemIds.has(`${event.threadId}:${event.item.id}`)) {
            return null;
        }
        this.completedItemIds.add(`${event.threadId}:${event.item.id}`);
        this.snapshotPendingAgentText.delete(`${event.threadId}:${event.item.id}`);
        this.snapshotPendingReasoningSummaryText.delete(`${event.threadId}:${event.item.id}`);
        this.snapshotPendingReasoningRawText.delete(`${event.threadId}:${event.item.id}`);
        const hadStart = this.emittedToolCallIds.delete(`${event.threadId}:${event.item.id}`);
        switch (event.item.type) {
            case "fileChange":
                return this.renderer.render(FileChangeReporter.completed(event.item));
            case "dynamicToolCall":
                return this.renderer.render(hadStart
                    ? DynamicToolReporter.completed(event.item)
                    : DynamicToolReporter.started(event.item));
            case "mcpToolCall":
                return this.renderer.render(McpToolReporter.completed(event.item));
            case "commandExecution":
                return this.renderer.render(this.streamsFor(event.threadId).commands.completed(event.item, true));
            case "imageView":
                if (this.streamsFor(event.threadId).emittedImageViewItems.delete(event.item.id)) {
                    return null;
                }
                return this.renderer.render(ImageViewReporter.viewed(event.item));
            case "imageGeneration":
                return this.renderer.render(this.streamsFor(event.threadId).activeImageGenerationItems.delete(event.item.id)
                    ? ImageGenerationReporter.completed(event.item)
                    : ImageGenerationReporter.whole(event.item));
            case "reasoning":
                return this.createCompletedReasoningEvent(event.item, event.threadId);
            case "webSearch":
                return this.renderer.render(WebSearchReporter.completed(event.item));
            case "collabAgentToolCall":
                return this.renderer.render(this.subagents.legacyCollaborationCompleted(event.item));
            case "agentMessage":
                this.rememberAgentMessage(event.item, event.threadId);
                const update = this.flushAgentMessageText(event.item, event.threadId);
                this.agentMessageMetadata.delete(`${event.threadId}:${event.item.id}`);
                return update;
            case "plan":
                return await this.createCompletedPlanEvent(event.item);
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return this.supportsCompaction
                    ? this.sessionState.compactions.complete(
                        this.subagents.notificationSessionId({method: "item/completed", params: event}),
                        event.turnId, event.item.id,
                    )
                    : this.renderer.render(CompactionReporter.completed(event.item));
            case "subAgentActivity":
                return this.renderer.render(this.subagents.legacyActivityCompleted(event.item));
            //ignored types
            case "sleep":
            case "functionCallOutput":
            case "userMessage":
            case "hookPrompt":
            case "enteredReviewMode":
                return null;
        }
    }

    private streamsFor(threadId: string): CodexItemStreamState {
        return this.subagents instanceof StandardSubagentEventRouter
            ? this.subagents.itemStreams(threadId) ?? this.itemStreams : this.itemStreams;
    }

    private rememberAgentMessage(item: ThreadItem & { type: "agentMessage" }, threadId: string): void {
        this.streamsFor(threadId).agentMessagePhases.set(item.id, item.phase);
        this.agentMessageMetadata.set(`${threadId}:${item.id}`, {
            phase: item.phase,
            memoryCitation: item.memoryCitation,
        });
    }

    private createCompletedReasoningEvent(item: ThreadItem & { type: "reasoning" }, threadId: string): UpdateSessionEvent | null {
        const hasSummary = item.summary.some(part => part.length > 0);
        const text = hasSummary ? this.reasoningSummaryText(item) : this.reasoningRawText(item);
        const emitted = hasSummary
            ? this.emittedReasoningSummaryText.get(`${threadId}:${item.id}`) ?? ""
            : this.emittedReasoningRawText.get(`${threadId}:${item.id}`) ?? "";
        const suffix = missingTextSuffix(emitted, text);
        this.emittedReasoningSummaryText.delete(`${threadId}:${item.id}`);
        this.emittedReasoningRawText.delete(`${threadId}:${item.id}`);
        if (suffix.length === 0) {
            return null;
        }
        return this.createAgentThoughtEvent(suffix, item.id);
    }

    private reasoningSummaryText(item: ThreadItem & {type: "reasoning"}): string {
        return item.summary.filter(part => part.length > 0).join("\n\n");
    }

    private reasoningRawText(item: ThreadItem & {type: "reasoning"}): string {
        return item.content.filter(part => part.length > 0).join("\n\n");
    }

    private appendEmittedText(target: Map<string, string>, itemId: string, text: string): void {
        target.set(itemId, `${target.get(itemId) ?? ""}${text}`);
    }

    private reconcileSnapshotDelta(target: Map<string, string>, itemId: string, delta: string): string {
        const pending = target.get(itemId);
        if (pending === undefined) {
            return delta;
        }
        if (pending.startsWith(delta)) {
            const remaining = pending.slice(delta.length);
            if (remaining.length === 0) {
                target.delete(itemId);
            } else {
                target.set(itemId, remaining);
            }
            return "";
        }
        if (delta.startsWith(pending)) {
            target.delete(itemId);
            return delta.slice(pending.length);
        }

        let overlap = Math.min(pending.length, delta.length);
        while (overlap > 0 && !pending.endsWith(delta.slice(0, overlap))) {
            overlap -= 1;
        }
        target.delete(itemId);
        return delta.slice(overlap);
    }

    private observeReviewMode(item: ThreadItem, threadId: string, turnId: string): void {
        if (item.type === "enteredReviewMode") this.reviewTurnIds.add(`${threadId}:${turnId}`);
        else if (item.type === "exitedReviewMode") this.reviewTurnIds.delete(`${threadId}:${turnId}`);
    }

    private createUserMessageEvents(item: Extract<ThreadItem, {type: "userMessage"}>, threadId: string, turnId: string): UpdateSessionEvent[] {
        if (this.renderedUserMessageItemIds.has(`${threadId}:${item.id}`)) {
            return [];
        }
        this.startedItemIds.add(`${threadId}:${item.id}`);
        this.renderedUserMessageItemIds.add(`${threadId}:${item.id}`);
        if (item.clientId && this.pendingLocalUserMessageIds.delete(item.clientId)) {
            return [];
        }
        // Codex's own reviewer prompt is internal; v1 retains its existing transcript contract.
        if (this.session.protocolVersion === 2 && item.clientId === null && this.reviewTurnIds.has(`${threadId}:${turnId}`)) {
            return [];
        }
        return item.content.flatMap(input =>
            userInputToContentBlocks(input).map(block => createUserMessageChunk(block, item.id))
        );
    }

    private async createCompletedPlanEvent(item: ThreadItem & { type: "plan" }): Promise<UpdateSessionEvent | null> {
        const completed = await this.plans.completed(item.id, item.text);
        if (completed === null) return null;
        this.completedPlan = {itemId: item.id, text: completed.text};
        return completed.update;
    }

    private createExitedReviewModeEvent(item: ThreadItem & { type: "exitedReviewMode" }): UpdateSessionEvent | null {
        const text = item.review.trim();
        if (text.length === 0) {
            return null;
        }
        return createAgentTextMessageChunk(text, item.id);
    }

    private createContextCompactedEvent(): UpdateSessionEvent {
        if (!this.supportsNotices) {
            return createAgentTextMessageChunk("*Context compacted to fit the model's context window.*\n\n");
        }
        return createSessionNotice(
            "info",
            "Context compacted",
            "Conversation compacted to fit the model's context window.",
        );
    }

    private openToolCalls(threadId: string) {
        return this.subagents instanceof StandardSubagentEventRouter
            ? this.subagents.openToolCalls(threadId) ?? this.sessionState.openToolCalls : this.sessionState.openToolCalls;
    }

    private trackOpenToolCall(item: ThreadItem, threadId: string, turnId: string): void {
        if (!PLAIN_TOOL_CALL_ITEM_TYPES.has(item.type)) return;
        const hasTerminal = item.type === "commandExecution" && commandUsesTerminal(item);
        this.openToolCalls(threadId).start(item.id, hasTerminal, turnId);
    }

    private async updatePlan(event: TurnPlanUpdatedNotification): Promise<UpdateSessionEvent> {
        const plan: PlanEntry[] = event.plan.map(value => ({
                status: value.status == "inProgress" ? "in_progress" : value.status,
                content: value.step,
                priority: "medium"
            })
        );
        return structuredPlanUpdate(plan, this.sessionState.clientCapabilities);
    }

    private async createErrorEvent(params: ErrorNotification): Promise<UpdateSessionEvent | null> {
        const error = params.error.codexErrorInfo;
        if (this.sessionState.currentTurnId === null) {
            this.pendingErrors.push(params);
            logger.log("Buffered app-server error until the active turn is known", {
                sessionId: this.sessionState.sessionId,
                turnId: params.turnId,
                willRetry: params.willRetry,
            });
            return null;
        }
        // ACP authRequired starts the client login flow. A second access update
        // or chat message would show the same refusal as a false session error.
        if (this.isAuthenticationRequiredError(error)) {
            if (!params.willRetry && params.turnId === this.sessionState.currentTurnId) {
                this.failure = RequestError.authRequired();
            }
            return null;
        }
        if (params.turnId !== this.sessionState.currentTurnId) {
            if (this.supportsTypedSessionFailures) {
                const failure = params.willRetry
                    ? this.recordRetryWarning(params)
                    : this.recordSessionFailure(
                        this.sessionFailureKind(params.error),
                        params.turnId,
                        "error",
                        params.error.message,
                    );
                return this.createSessionFailureUpdate(failure);
            }
            return this.createCodexSessionInfoUpdate({
                error: {...params.error, turnId: params.turnId, willRetry: params.willRetry},
            });
        }
        if (params.willRetry) {
            if (this.supportsTypedSessionFailures) {
                return this.createSessionFailureUpdate(this.recordRetryWarning(params));
            }
            return this.createCodexSessionInfoUpdate({
                error: {
                    ...params.error,
                    turnId: params.turnId,
                    willRetry: true,
                },
            });
        }
        if (this.supportsTypedSessionFailures) {
            // app-server guarantees willRetry=false interrupts this turn; the terminal failure is
            // returned once on PromptResponse._meta rather than duplicated as a session update.
            this.recordTypedSessionFailure(params);
            return null;
        }
        if (error === "usageLimitExceeded") {
            this.failure = RequestError.internalError(
                this.createTurnErrorData(params.error),
            );
        }
        if (this.failure !== null) {
            failuresShownAsMessages.add(this.failure);
        }
        return createAgentTextMessageChunk(`${readableServiceErrorMessage(params.error.message)}\n\n`);
    }

    private recordTypedSessionFailure(params: ErrorNotification): void {
        const kind = this.sessionFailureKind(params.error);
        this.recordSessionFailure(kind, params.turnId, "error", params.error.message);
    }

    private recordSessionFailure(
        kind: CodexFailureKind,
        turnId: string | undefined,
        severity: "warning" | "error",
        title: string,
        actionsOverride?: SessionFailureAction[],
        attributeToTurn = true,
    ): NonNullable<SessionState["sessionFailure"]> {
        const policy = SESSION_FAILURE_POLICY[kind];
        const scope = turnId ?? this.sessionState.sessionId;
        const id = this.activeFailureIdByScope.get(scope)
            ?? this.allocateFailureId(scope, turnId);
        const previous = this.failuresById.get(id);
        const failure: NonNullable<SessionState["sessionFailure"]> = {
            id,
            revision: nextSessionFailureRevision(previous, id),
            category: policy.category,
            severity,
            title: readableServiceErrorMessage(title),
            actions: actionsOverride ?? policy.actions,
        };
        this.failuresById.set(id, failure);
        this.failureTurnIdById.set(id, attributeToTurn ? turnId : undefined);
        this.activeFailureIdByScope.set(scope, id);
        this.sessionState.sessionFailure = failure;
        this.lastSessionNotice = undefined;
        return failure;
    }

    private allocateFailureId(scope: string, turnId: string | undefined): string {
        if (turnId !== undefined && !this.allocatedFailureScopes.has(scope)) {
            this.allocatedFailureScopes.add(scope);
            return `${turnId}:error`;
        }
        this.allocatedFailureScopes.add(scope);
        return `${scope}:error:${this.sessionFailureEpoch}:${this.nextNoticeId++}`;
    }

    /**
     * A retry warning remains the active incident until Codex produces turn content again. That content is
     * the only positive signal available from app-server that the turn recovered; a later error then starts
     * a new incident instead of overwriting the historical reconnect entry. Terminal errors remain active so
     * duplicate late notifications cannot append duplicate transcript rows.
     */
    private completeRetryIncidentOnTurnProgress(threadId: string): void {
        if (this.subagents instanceof StandardSubagentEventRouter && threadId !== this.sessionState.sessionId) return;
        const turnId = this.sessionState.currentTurnId;
        if (turnId === null) return;
        const activeId = this.activeFailureIdByScope.get(turnId);
        if (activeId === undefined || this.failuresById.get(activeId)?.severity !== "warning") return;
        this.activeFailureIdByScope.delete(turnId);
        if (this.sessionState.sessionFailure?.id === activeId) {
            void this.clearSessionFailure().catch(error => logger.error("Failed to clear session failure metadata", error));
        }
    }

    private recordRetryWarning(params: ErrorNotification, attributeToTurn = true): SessionFailure {
        const kind = this.sessionFailureKind(params.error);
        return this.recordSessionFailure(
            kind,
            params.turnId,
            "warning",
            params.error.message,
            [],
            attributeToTurn,
        );
    }

    private recordSessionNotice(title: string, details?: string): SessionFailure {
        const key = `${title}\u0000${details ?? ""}`;
        const previous = this.lastSessionNotice?.key === key
            ? this.lastSessionNotice.failure
            : undefined;
        const id = previous?.id
            ?? `${this.sessionState.sessionId}:notice:${this.sessionFailureEpoch}:${this.nextNoticeId++}`;
        const notice: SessionFailure = {
            id,
            revision: nextSessionFailureRevision(previous, id),
            category: "unknown",
            severity: "warning",
            title,
            ...(details === undefined ? {} : {details}),
            actions: [],
        };
        this.lastSessionNotice = {key, failure: notice};
        return notice;
    }

    private sessionNoticeContent(summary: string, details: string | null): [title: string, details?: string] {
        if (details === null) return [summary];
        const combinedTitle = `${summary} — ${details}`;
        return combinedTitle.length <= MAX_SESSION_FAILURE_TITLE_LENGTH
            ? [combinedTitle]
            : [summary, details];
    }

    private createSessionFailureMeta(
        failure: NonNullable<SessionState["sessionFailure"]>,
    ): Record<string, unknown> {
        return {
            [JETBRAINS_META_KEY]: {
                [AIR_META_KEY]: {
                    [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
                    [AIR_SESSION_FAILURE_KEY]: failure,
                },
            },
        };
    }

    private createSessionFailureUpdate(
        failure: NonNullable<SessionState["sessionFailure"]>,
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: this.createSessionFailureMeta(failure),
        };
    }

    private sessionFailureKind({message, codexErrorInfo: error}: ErrorNotification["error"]): CodexFailureKind {
        if (this.isAuthenticationRequiredError(error)) return "auth_required";
        if (isWorkspaceRoutingUnavailableMessage(message)) return "transport_lost";
        if (this.getHttpStatusCode(error) === 429) return "rate_limited";
        if (typeof error === "string") {
            return Object.hasOwn(STRING_CODEX_ERROR_CATEGORIES, error)
                ? STRING_CODEX_ERROR_CATEGORIES[error] ?? "provider_error"
                : "provider_error";
        }
        if (error !== null) {
            for (const kind of Object.keys(STRUCTURED_CODEX_ERROR_CATEGORIES) as StructuredCodexErrorKind[]) {
                if (kind in error) {
                    return STRUCTURED_CODEX_ERROR_CATEGORIES[kind] ?? "provider_error";
                }
            }
        }
        return "provider_error";
    }

    private isAuthenticationRequiredError(error: CodexErrorInfo | null): boolean {
        return error === "unauthorized" || this.getHttpStatusCode(error) === 401;
    }

    private getHttpStatusCode(error: CodexErrorInfo | null): number | null {
        if (error === null || typeof error !== "object") return null;
        const details: unknown = Object.values(error)[0];
        if (details === null || typeof details !== "object" || !("httpStatusCode" in details)) return null;
        return typeof details.httpStatusCode === "number" ? details.httpStatusCode : null;
    }

    private createTurnErrorData(error: ErrorNotification["error"]): {
        message: string;
        codexErrorInfo?: CodexErrorInfo;
        additionalDetails?: string;
    } {
        const data: {
            message: string;
            codexErrorInfo?: CodexErrorInfo;
            additionalDetails?: string;
        } = {
            message: error.additionalDetails ?? error.message,
        };
        if (error.codexErrorInfo !== null) {
            data.codexErrorInfo = error.codexErrorInfo;
        }
        if (error.additionalDetails !== null) {
            data.additionalDetails = error.additionalDetails;
        }
        return data;
    }

    private handleTokenUsageUpdated(params: ThreadTokenUsageUpdatedNotification): void {
        this.sessionState.lastTokenUsage = toTokenCount(params.tokenUsage.last);
        this.sessionState.totalTokenUsage = toTokenCount(params.tokenUsage.total);
        this.sessionState.promptTokenUsage?.observe(this.sessionState.totalTokenUsage, this.sessionState.lastTokenUsage);
        this.sessionState.modelContextWindow = params.tokenUsage.modelContextWindow;
    }

    private createUsageUpdate(params: ThreadTokenUsageUpdatedNotification): UpdateSessionEvent | null {
        let used: number | undefined;
        let size: number | null;
        if (params.threadId === this.sessionState.sessionId) {
            this.handleTokenUsageUpdated(params);
            used = this.sessionState.lastTokenUsage?.totalTokens;
            size = this.sessionState.modelContextWindow;
        } else if (this.subagents.isNativeSubagentThread(params.threadId)) {
            // The usage of a native subagent belongs to its own session, where handleNotification routes the
            // update. It must not change the usage of this session or its turn.
            used = params.tokenUsage.last.totalTokens;
            size = params.tokenUsage.modelContextWindow;
        } else {
            return null;
        }
        if (used == null || size == null || size <= 0) {
            return null;
        }

        return {
            sessionUpdate: "usage_update",
            used,
            size,
        };
    }

    private handleRateLimitsUpdated(params: AccountRateLimitsUpdatedNotification): void {
        if (!this.sessionState.rateLimits) {
            this.sessionState.rateLimits = new Map();
        }
        const limitId = params.rateLimits.limitId ?? "codex";
        const existingEntry = this.sessionState.rateLimits.get(limitId);
        const snapshot = existingEntry
            ? mergeRateLimitSnapshot(existingEntry.snapshot, params.rateLimits)
            : {...params.rateLimits, limitId};
        this.sessionState.rateLimits.set(limitId, {
            limitId: limitId,
            limitName: snapshot.limitName ?? existingEntry?.limitName ?? limitId,
            snapshot,
        });
    }

}

/**
 * Items that Codex reports for the input of a turn, for other agents, or before a model request, rather than
 * as output of its model. Codex starts a context compaction before its request, which can send the
 * current usage again. When a compaction is the first request of a prompt on a thread with an unknown
 * start total and nothing was sent again before it, its own usage is taken as the start total; that
 * undercount is the lesser error compared with counting the history's last request.
 */
const NON_MODEL_OUTPUT_ITEM_TYPES: ReadonlySet<ThreadItem["type"]> = new Set([
    "userMessage",
    "hookPrompt",
    "enteredReviewMode",
    "subAgentActivity",
    "contextCompaction",
]);

function isModelOutputItem(item: ThreadItem): boolean {
    return !NON_MODEL_OUTPUT_ITEM_TYPES.has(item.type);
}

function toolCallTitle(update: UpdateSessionEvent | null | undefined): string | undefined {
    if (update?.sessionUpdate !== "tool_call") return undefined;
    return update.title;
}

function missingTextSuffix(emitted: string, completed: string, preserveRevision = false): string {
    if (emitted.length === 0) {
        return completed;
    }
    if (completed.startsWith(emitted)) {
        return completed.slice(emitted.length);
    }
    if (emitted.endsWith(completed)) {
        return "";
    }

    let overlap = Math.min(emitted.length, completed.length);
    while (overlap > 0 && !emitted.endsWith(completed.slice(0, overlap))) {
        overlap -= 1;
    }
    if (overlap > 0) {
        return completed.slice(overlap);
    }
    return preserveRevision ? `\n\n${completed}` : "";
}
