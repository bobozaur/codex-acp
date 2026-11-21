import type {SessionSource, Thread, ThreadSourceKind} from "./app-server/v2";

export const SESSION_LIST_SOURCE_KINDS = [
    "cli",
    "vscode",
    "appServer",
    "unknown",
] as const satisfies readonly (SessionSource & ThreadSourceKind)[];

export function hasSessionListSource({source, threadSource}: Pick<Thread, "source" | "threadSource">): boolean {
    // Codex masks internal sources as "unknown" in thread/read. Use the marker when it is present.
    if (source === "unknown" && (threadSource === "guardian_review" || threadSource === "memory_consolidation")) return false;
    return SESSION_LIST_SOURCE_KINDS.some(kind => kind === source);
}
