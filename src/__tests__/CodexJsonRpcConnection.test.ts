import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {FakeChild} from "./app-server-recovery/fake-app-server";
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {NO_PROVIDER_STARTUP_CONFIG} from "../CodexConfigOverride";
import type {CodexConnection} from "../CodexJsonRpcConnection";

const mocks = vi.hoisted(() => ({spawn: vi.fn(), spawnSync: vi.fn()}));
vi.mock("node:child_process", async importOriginal => ({
    ...await importOriginal<typeof import("node:child_process")>(),
    spawn: mocks.spawn,
    spawnSync: mocks.spawnSync,
}));
vi.mock("cross-spawn", () => ({default: Object.assign(mocks.spawn, {sync: mocks.spawnSync})}));

let connection: CodexConnection | null = null;

beforeEach(() => {
    mocks.spawn.mockReset().mockImplementation(() => new FakeChild() as unknown as ChildProcessWithoutNullStreams);
    mocks.spawnSync.mockReset().mockReturnValue({status: 0, stdout: "", stderr: ""});
});

afterEach(() => {
    connection?.connection.dispose();
    connection?.process.stdin.destroy();
    connection?.process.stdout.destroy();
    connection?.process.stderr.destroy();
    connection = null;
});

describe("Codex connection transport selection", () => {
    it("starts remote control and connects a proxy without provider overrides", () => {
        connection = startCodexConnection("codex", {}, ["app-server", "-c", "hooks={}"], {
            providerStartupConfig: NO_PROVIDER_STARTUP_CONFIG,
        });

        expect(mocks.spawnSync.mock.calls.map(call => call[1])).toEqual([["remote-control", "start", "-c", "hooks={}"]]);
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["app-server", "proxy"]);
    });

    it.each([
        {args: ["-c", "model_provider=\"gateway\""], env: {}},
        {args: [], env: {PROVIDER_HEADER: "test-value"}},
    ])("uses dedicated stdio for provider startup overrides: %j", providerStartupConfig => {
        const args = ["app-server", ...providerStartupConfig.args];
        const env = {...providerStartupConfig.env};
        connection = startCodexConnection("codex", env, args, {providerStartupConfig, reuseSharedDaemon: true});

        expect(mocks.spawnSync).not.toHaveBeenCalled();
        expect(mocks.spawn).toHaveBeenCalledWith("codex", args, {env});
    });

    it("rechecks daemon readiness on every shared reconnect and starts it again after it stops", () => {
        mocks.spawnSync.mockReturnValueOnce({status: 0, stdout: JSON.stringify({status: "running"}), stderr: ""});
        connection = startCodexConnection("codex", {}, undefined, {reuseSharedDaemon: true});
        expect(mocks.spawnSync.mock.calls.map(call => call[1])).toEqual([["app-server", "daemon", "version"]]);
        connection.connection.dispose();

        mocks.spawnSync.mockReturnValueOnce({status: 0, stdout: JSON.stringify({status: "stopped"}), stderr: ""});
        connection = startCodexConnection("codex", {}, undefined, {reuseSharedDaemon: true});

        expect(mocks.spawnSync.mock.calls.map(call => call[1])).toEqual([
            ["app-server", "daemon", "version"],
            ["app-server", "daemon", "version"],
            ["remote-control", "start"],
        ]);
        expect(mocks.spawn.mock.calls.map(call => call[1])).toEqual([
            ["app-server", "proxy"], ["app-server", "proxy"],
        ]);
    });

    it.each([
        {status: 0, stdout: JSON.stringify({status: "stale"}), stderr: ""},
        {status: 1, stdout: "", stderr: "unavailable"},
        {status: 0, stdout: "invalid JSON", stderr: ""},
        {status: null, stdout: "", stderr: "", error: new Error("status check timed out")},
    ])("starts remote control when readiness cannot establish a running daemon: %j", status => {
        mocks.spawnSync.mockReturnValueOnce(status);
        connection = startCodexConnection("codex", {}, undefined, {reuseSharedDaemon: true});

        expect(mocks.spawnSync.mock.calls.map(call => call[1])).toEqual([
            ["app-server", "daemon", "version"], ["remote-control", "start"],
        ]);
        expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["app-server", "proxy"]);
    });
});
