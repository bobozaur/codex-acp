import {beforeEach, describe, expect, it, vi} from "vitest";
import {createObjectDump, stopTestCodexDaemon} from "./acp-test-utils";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import path from "node:path";
import crossSpawn from "cross-spawn";

vi.mock("cross-spawn", () => ({default: vi.fn()}));

describe("createObjectDump anonymizer", () => {
    it("anonymizes both direct keys and dotted paths", () => {
        const payload = {
            id: "123",
            meta: {
                token: "secret-token",
                nested: {
                    token: "deep-secret",
                },
            },
            items: [
                {secret: "first-item", visible: "keep"},
                {secret: "second-item"},
            ],
        };

        const dump = createObjectDump(payload, [
            "id",
            "meta.token",
            "meta.nested.token",
            "items.0.secret",
        ]);
        const parsed = JSON.parse(dump);

        expect(parsed.id).toBe("id");
        expect(parsed.meta.token).toBe("token");
        expect(parsed.meta.nested.token).toBe("token");
        expect(parsed.items[0].secret).toBe("secret");
        expect(parsed.items[0].visible).toBe("keep");
        expect(parsed.items[1].secret).toBe("second-item");
    });
});

describe("isolated test daemon cleanup", () => {
    const home = path.join(process.cwd(), "tmp", "daemon-cleanup-test", "codex-home");
    beforeEach(() => vi.mocked(crossSpawn).mockReset());

    it.each([undefined, "fixture-codex"])("stops the fixture daemon using CODEX_PATH=%s", async codexPath => {
        const child = mockStopProcess();
        const stopped = stopTestCodexDaemon(home, {CODEX_PATH: codexPath, CODEX_HOME: "shared-home"});
        expect(crossSpawn).toHaveBeenCalledWith(codexPath ?? process.execPath,
            codexPath ? ["remote-control", "stop"] : [expect.stringContaining("codex.js"), "remote-control", "stop"],
            expect.objectContaining({env: {CODEX_PATH: codexPath, CODEX_HOME: home}, timeout: 10_000, killSignal: "SIGKILL"}));
        child.emit("close", 0, null);
        await expect(stopped).resolves.toBeUndefined();
    });

    it.each([[1, null], [null, "SIGKILL"]] as const)("surfaces failed daemon teardown (%s, %s)", async (code, signal) => {
        const child = mockStopProcess();
        const stopped = stopTestCodexDaemon(home, {});
        child.stderr.emit("data", "stop failed");
        child.emit("close", code, signal);
        await expect(stopped).rejects.toThrow(`Failed to stop isolated Codex daemon (${signal ?? code}): stop failed`);
    });

    it("rejects a home outside the isolated fixture directories before starting Codex", async () => {
        await expect(stopTestCodexDaemon(path.join(process.cwd(), "shared-home")))
            .rejects.toThrow("Refusing to stop a Codex daemon outside an isolated test home");
        expect(crossSpawn).not.toHaveBeenCalled();
    });
});

function mockStopProcess() {
    const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough()});
    vi.mocked(crossSpawn).mockReturnValue(child as unknown as ReturnType<typeof crossSpawn>);
    return child;
}
