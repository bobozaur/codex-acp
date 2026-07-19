import type {ModeKind} from "./app-server/ModeKind";
import type {Personality} from "./app-server/Personality";
import type {ReasoningSummary} from "./app-server/ReasoningSummary";
import type {
    ApprovalsReviewer,
    AskForApproval,
    Model,
    PermissionProfileSummary,
    SandboxPolicy,
    Thread,
    ThreadItemEntry,
    ThreadStatus,
} from "./app-server/v2";
import type {SessionInstructions} from "./ClientSystemPrompt";
export type PreservedTurnSettings = {
    approvalPolicy: AskForApproval,
    approvalsReviewer: ApprovalsReviewer,
    sandboxPolicy: SandboxPolicy,
    preservePermissionProfile: boolean,
    summary?: ReasoningSummary | null,
    personality?: Personality | null,
}

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    currentServiceTier?: string | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    instructions?: SessionInstructions,
    sessionTitle?: string | null,
    activePermissionProfileId?: string | null,
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    permissionProfiles?: PermissionProfileSummary[],
    cwd?: string,
    turnSettings?: PreservedTurnSettings,
    activeTurnId?: string | null,
    threadSnapshot?: Thread,
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
