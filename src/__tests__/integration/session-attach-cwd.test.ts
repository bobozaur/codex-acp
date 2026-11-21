import {once} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect, it} from "vitest";
import {startStdioCodexConnection} from "../../CodexJsonRpcConnection";
import {createBaseTestFixture, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

describeIntegration("integration: saved session working directory", () => {
    it.each(["loadSession", "resumeSession"] as const)("%s keeps the cold thread in its saved directory", async method => {
        const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-attach-cwd-")));
        writeCodexHomeConfig(home);
        const savedCwd = path.join(home, "saved");
        const alias = path.join(home, "alias");
        const otherCwd = path.join(home, "other");
        fs.mkdirSync(savedCwd);
        fs.mkdirSync(otherCwd);
        fs.symlinkSync(savedCwd, alias, "junction");

        const threadId = "00000000-0000-4000-8000-000000000001";
        const timestamp = "2026-01-01T00:00:00Z";
        const dir = path.join(home, "sessions", "2026", "01", "01");
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`), [
            {timestamp, type: "session_meta", payload: {
                id: threadId, timestamp, cwd: savedCwd, originator: "codex_cli_rs", cli_version: "0.166.0", source: "cli", model_provider: "openai",
            }},
            {timestamp, type: "event_msg", payload: {type: "user_message", message: "Earlier prompt", images: [], local_images: [], text_elements: []}},
        ].map(entry => JSON.stringify(entry)).join("\n") + "\n");

        const codex = startStdioCodexConnection(path.resolve("node_modules/.bin/codex"), {...process.env, CODEX_HOME: home});
        const fixture = createBaseTestFixture({connection: codex.connection, getExitCode: () => codex.process.exitCode});
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        try {
            await client.initialize({});
            const open = (cwd: string) => client[method]({sessionId: threadId, cwd, mcpServers: []});
            await expect(open(otherCwd)).rejects.toMatchObject({code: -32602, data: {cwd: savedCwd}});
            expect((await appServer.threadLoadedList({})).data).not.toContain(threadId);

            expect(await open(alias)).toMatchObject({sessionId: threadId, cwd: savedCwd});
            expect((await appServer.threadRead({threadId})).thread.cwd).toBe(savedCwd);
            const resume = fixture.getCodexConnectionEvents([]).find(event => event.eventType === "request" && event.method === "thread/resume");
            expect(resume?.params).toMatchObject({threadId, excludeTurns: true, config: {projects: {[savedCwd]: {trust_level: "trusted"}}}});
            expect(resume?.params).not.toHaveProperty("cwd");
        } finally {
            codex.process.kill();
            await once(codex.process, "exit");
            fs.rmSync(home, {recursive: true, force: true});
        }
    });
});
