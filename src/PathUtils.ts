import {realpathSync} from "node:fs";
import path from "node:path";

/** ACP paths are native POSIX or fully qualified Windows paths, never file URIs. */
export function isAbsoluteProtocolPath(value: string): boolean {
    return !value.includes("\0") && (path.posix.isAbsolute(value) || isWindowsAbsolutePath(value));
}

/** Converts a recorded path to a file URI independent of the adapter's OS. */
export function fileUriFromPath(value: string): string | null {
    if (value.includes("\0")) return null;
    try {
        if (value.startsWith("file://")) return new URL(value).href;
        if (isWindowsAbsolutePath(value)) {
            const portablePath = value.replaceAll("\\", "/");
            if (portablePath.startsWith("//")) {
                const share = portablePath.indexOf("/", 2);
                const host = portablePath.slice(2, share);
                return new URL(`file://${encodeURIComponent(host)}${encodePath(portablePath.slice(share))}`).href;
            }
            return `file:///${portablePath.slice(0, 2)}${encodePath(portablePath.slice(2))}`;
        }
        return path.posix.isAbsolute(value) ? `file://${encodePath(path.posix.normalize(value))}` : null;
    } catch {
        return null;
    }
}

function encodePath(value: string): string {
    return value.split("/").map(encodeURIComponent).join("/");
}

export function isAbsolutePathLike(value: string): boolean {
    return isAbsoluteProtocolPath(value.trim());
}

/** A cwd Codex can match in its native index. Imported or missing Windows paths need portable comparison. */
export function nativeSessionListCwd(value: string): string | null {
    if (!isAbsoluteProtocolPath(value)) return null;
    if (isWindowsAbsolutePath(value)) return process.platform === "win32" ? canonicalNativePath(value) : null;
    return process.platform !== "win32" && path.posix.isAbsolute(value) ? value : null;
}

export function canonicalNativePath(value: string): string | null {
    if (!path.isAbsolute(value)) return null;
    try {
        return realpathSync.native(value);
    } catch {
        return null;
    }
}

/** Matches a cwd when the list cannot send it to Codex's native index. */
export function sessionListCwdMatcher(cwd: string): (storedCwd: string) => boolean {
    if (!isAbsolutePathLike(cwd)) return storedCwd => arePathBasenamesEqual(storedCwd, cwd);
    const key = normalizePathForComparison(cwd);
    return storedCwd => normalizePathForComparison(storedCwd) === key;
}

export function arePathsEqual(left: string, right: string): boolean {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function arePathBasenamesEqual(left: string, right: string): boolean {
    const leftBase = path.posix.basename(normalizePathForComparison(left));
    const rightBase = path.posix.basename(normalizePathForComparison(right));
    if (shouldComparePathCaseInsensitive(left) || shouldComparePathCaseInsensitive(right)) {
        return leftBase.toLowerCase() === rightBase.toLowerCase();
    }
    return leftBase === rightBase;
}

export function normalizePathForComparison(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return "";
    }

    if (isWindowsAbsolutePath(trimmed)) {
        const normalized = path.win32.normalize(trimmed).replace(/\\/g, "/");
        return trimTrailingPathSeparators(normalized).toLowerCase();
    }

    const pathForComparison = path.posix.isAbsolute(trimmed)
        ? trimmed
        : trimmed.replace(/\\/g, "/");
    const normalized = path.posix.normalize(pathForComparison);
    return trimTrailingPathSeparators(normalized);
}

function isWindowsAbsolutePath(value: string): boolean {
    const portableValue = value.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(portableValue) || /^\/\/[^/]+\/[^/]+/.test(portableValue);
}

function shouldComparePathCaseInsensitive(value: string): boolean {
    return isWindowsAbsolutePath(value) || /^[A-Za-z]:/.test(value) || value.includes("\\");
}

function trimTrailingPathSeparators(value: string): string {
    let trimmed = value;
    while (trimmed.endsWith("/") && !isRootPath(trimmed)) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
}

function isRootPath(value: string): boolean {
    return value === "/"
        || /^[A-Za-z]:\/$/.test(value)
        || /^\/\/[^/]+\/[^/]+\/$/.test(value);
}
