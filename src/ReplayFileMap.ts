import {readFileSync} from "node:fs";
import {isDeepStrictEqual} from "node:util";
import type {AcpSessionUpdate} from "./AcpSessionExtensions";
import {isAbsoluteProtocolPath} from "./PathUtils";
import {isRecord} from "./permissions/json";

type ToolCallReport = Extract<AcpSessionUpdate, {sessionUpdate: "tool_call" | "tool_call_update"}>;

export type ReplayFileMap = ReadonlyMap<string, string | null>;

export function loadReplayFileMap(file: string | undefined): ReplayFileMap | undefined {
    if (!file) return undefined;

    try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isRecord(value)) {
            const entries = Object.entries(value);
            const paths = new Map<string, string | null>();
            for (const [from, to] of entries) {
                if (!isAbsoluteProtocolPath(from) || (to !== null && (typeof to !== "string" || !isAbsoluteProtocolPath(to)))) {
                    break;
                }
                paths.set(from, to);
            }
            if (paths.size === entries.length) return paths;
        }
    } catch {
        // A missing or unreadable optional file must not prevent session restore.
    }
    console.error("Ignoring CODEX_ACP_REPLAY_FILE_MAP. Expected a readable JSON object mapping absolute paths to absolute paths or null.");
    return undefined;
}

/** Project ACP tool locations after the renderer has applied client-specific overrides. */
export function projectReplayLocations(
    report: ToolCallReport,
    paths: ReplayFileMap | undefined,
): ToolCallReport {
    const original = report.locations;
    if (paths === undefined || !original?.some(({path}) => {
        const destination = paths.get(path);
        return destination !== undefined && destination !== path;
    })) return report;

    // Keep every original location that stays at its path. Compare only equal target paths,
    // and discard a relocated duplicate before discarding an original location.
    const byPath = new Map<string, NonNullable<ToolCallReport["locations"]>>();
    for (const location of original) {
        const to = paths.get(location.path);
        if (to !== undefined && to !== location.path) continue;
        const samePath = byPath.get(location.path) ?? [];
        samePath.push(location);
        byPath.set(location.path, samePath);
    }

    const locations: NonNullable<ToolCallReport["locations"]> = [];
    for (const location of original) {
        const to = paths.get(location.path);
        if (to === null) continue;
        if (to === undefined || to === location.path) {
            locations.push(location);
            continue;
        }

        const projected = {...location, path: to};
        const samePath = byPath.get(to) ?? [];
        if (samePath.some(previous => isDeepStrictEqual(previous, projected))) continue;
        locations.push(projected);
        samePath.push(projected);
        byPath.set(to, samePath);
    }

    return {...report, locations};
}
