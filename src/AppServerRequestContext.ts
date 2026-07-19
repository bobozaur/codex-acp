import type {RequestId} from "./app-server";

const requestIds = new WeakMap<object, RequestId>();

export function tagAppServerRequest(params: unknown, requestId: RequestId): void {
    if (typeof params === "object" && params !== null) {
        requestIds.set(params, requestId);
    }
}

export function getAppServerRequestId(params: unknown): RequestId | null {
    if (typeof params !== "object" || params === null) {
        return null;
    }
    return requestIds.get(params) ?? null;
}
