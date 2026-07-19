import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import crossSpawn from "cross-spawn";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {createWebSocketJsonRpcTransport} from "./WebSocketJsonRpcTransport";
import {logger} from "./Logger";
import type {ProviderStartupConfig} from "./CodexConfigOverride";

const require = createRequire(import.meta.url);

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    /**
     * Settles once the connection handled the process output, or disposal discarded its remaining messages.
     * `CodexAppServerSupervisor` waits for it before it disposes the connection of a dead process.
     */
    readonly drained?: Promise<void>;
}

/** A notification that the adapter feeds into the connection after the last message of the process. */
const DRAINED_MARKER_METHOD = "codex-acp/stdoutDrained";

export interface StartCodexConnectionOptions {
    /**
     * Dispose the connection when the process exits (default). `CodexAppServerSupervisor` turns it off: it disposes
     * the connection itself, after the last output of the process was read.
     */
    disposeOnExit?: boolean;
    /** Provider startup overrides need a dedicated process; an existing daemon keeps its own configuration. */
    providerStartupConfig?: ProviderStartupConfig;
    /** Reconnect to a healthy daemon without waiting for its remote relay to become ready again. */
    reuseSharedDaemon?: boolean;
}

export function startStdioCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const spawnEnv = env ?? process.env;

    return connectCodex(spawnCodex(codexPath, appServerStartupArgs, spawnEnv), options, false);
}

export function startCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const provider = options.providerStartupConfig;
    if (provider && (provider.args.length > 0 || Object.keys(provider.env).length > 0)) {
        return startStdioCodexConnection(codexPath, env, appServerStartupArgs, options);
    }
    const spawnEnv = env ?? process.env;
    if (!options.reuseSharedDaemon || !sharedDaemonIsRunning(codexPath, spawnEnv)) {
        const result = runCodexSync(codexPath, ["remote-control", "start", ...appServerStartupArgs.slice(1)], spawnEnv, 30_000);
        if (result.error) throw new Error(`Failed to start Codex remote control: ${result.error.message}`);
        if (result.status !== 0) {
            logger.log("Codex remote control start exited non-zero; continuing with app-server proxy", {
                exitCode: result.status,
                details: [result.stderr, result.stdout].filter(Boolean).join("\n").trim(),
            });
        }
    }
    return connectCodex(spawnCodex(codexPath, ["app-server", "proxy"], spawnEnv), options, true);
}

function runCodexSync(codexPath: string | undefined, args: string[], env: NodeJS.ProcessEnv, timeout: number) {
    return codexPath
        ? crossSpawn.sync(codexPath, args, {env, encoding: "utf8", timeout})
        : spawnSync(process.execPath, [require.resolve("@openai/codex/bin/codex.js"), ...args],
            {env, encoding: "utf8", timeout});
}

function sharedDaemonIsRunning(codexPath: string | undefined, env: NodeJS.ProcessEnv): boolean {
    const status = runCodexSync(codexPath, ["app-server", "daemon", "version"], env, 5_000);
    if (status.error || status.status !== 0) return false;
    try {
        return JSON.parse(status.stdout).status === "running";
    } catch {
        return false;
    }
}

function spawnCodex(codexPath: string | undefined, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    if (codexPath) {
        return process.platform === "win32"
            ? crossSpawn(codexPath, args, {env}) as ChildProcessWithoutNullStreams
            : spawn(codexPath, args, {env});
    }
    return spawn(process.execPath, [require.resolve("@openai/codex/bin/codex.js"), ...args], {env});
}

function connectCodex(
    codex: ChildProcessWithoutNullStreams,
    options: StartCodexConnectionOptions,
    proxy: boolean,
): CodexConnection {
    attachLogs(codex);
    // A write to a process that is dying fails with EPIPE. Without a listener that error would end the adapter.
    codex.stdin.on("error", (error) => logger.log(`[STDIN ERROR] ${error.message}`));
    codex.stdout.on("error", (error) => logger.log(`[STDOUT ERROR] ${error.message}`));

    let {reader, writer} = proxy
        ? createWebSocketJsonRpcTransport(codex.stdout, codex.stdin)
        : {reader: createJSONRPCReader(codex.stdout), writer: createJSONRPCWriter(codex.stdin)};

    const transportClosed = new rpc.Emitter<void>();
    let closePending = false;
    if (proxy) {
        const deferClose = () => {
            if (closePending) return;
            closePending = true;
            reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message);
        };
        reader.onClose(deferClose);
        writer.onClose(deferClose);
        // The connection queues incoming frames. Deliver their close only after those frames were handled.
        reader = {...reader, onClose: transportClosed.event};
        writer = {...writer, onClose: transportClosed.event};
    }
    const connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // vscode-jsonrpc handles the messages that it read one by one, after the read. The marker comes after the last
    // message of the process, so its handler runs only when every earlier message was handled.
    const drained = new Promise<void>(resolve => {
        connection.onNotification(DRAINED_MARKER_METHOD, () => {
            resolve();
            if (closePending) transportClosed.fire();
        });
        // Explicit disposal discards queued messages, so no output remains to drain.
        connection.onDispose(() => resolve());
    });
    codex.stdout.on("end", () => reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message));

    if (options.disposeOnExit ?? true) {
        // Terminate all current activities on process termination
        codex.on("exit", _ => {
            connection.dispose();
        });
    }

    return {connection: connection, process: codex, drained};
}

/**
 * Logs the traffic of the app-server.
 * The listeners stay attached when logging is off, so that stderr keeps draining,
 * but a chunk is turned into a string only when the logger writes it.
 */
export function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        if (logger.enabled) logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        if (logger.enabled) logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        if (logger.enabled) logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
