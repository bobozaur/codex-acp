import * as acp from "@agentclientprotocol/sdk/unstable";
import type {ApprovalHandler} from "../CodexAppServerClient";
import type {
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    GrantedPermissionProfile,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    RequestPermissionProfile,
} from "../app-server/v2";
import {logger} from "../Logger";
import type {AcpClientConnection} from "../ACPSessionConnection";
import {
    commandDecisionOptions,
    fileChangeDecisionOptions,
    permissionProfileOptions,
    type CommandParamsWithAvailableDecisions,
    type DecisionOption,
} from "./options";
import {ApprovalOptionId} from "./option-ids";
import {
    CODEX_ADDITIONAL_PERMISSIONS_TITLE,
    CODEX_COMMAND_PERMISSION_TITLE,
    CODEX_FILE_CHANGE_PERMISSION_TITLE,
    CODEX_NETWORK_PERMISSION_TITLE,
    requestPermissionMeta,
} from "./metadata";
import type {PermissionPromptContext} from "./lifecycle";
import {AcpToolCallRenderer} from "../tool-calls/AcpToolCallRenderer";
import {subagentInteractionSignal, withSubagentUserAction} from "../subagents/SubagentInteraction";
import {CommandReporter} from "../tool-calls/reporters/CommandReporter";
import {FileChangeReporter} from "../tool-calls/reporters/FileChangeReporter";
import {SandboxPermissionReporter} from "../tool-calls/reporters/SandboxPermissionReporter";
import type {RequestId} from "../app-server";
import {getAppServerRequestId} from "../AppServerRequestContext";

export class CodexApprovalHandler implements ApprovalHandler {
    private cancellationSignal: AbortSignal | undefined;
    private readonly pendingRequestControllers = new Set<AbortController>();
    private readonly pendingRequestControllersById = new Map<RequestId, Set<AbortController>>();

    constructor(
        private readonly connection: AcpClientConnection,
        private readonly permissionContext: PermissionPromptContext,
        cancellationSignal: AbortSignal | undefined,
        private readonly renderer: AcpToolCallRenderer,
    ) {
        this.cancellationSignal = cancellationSignal;
    }

    async handleCommandExecution(
        params: CommandExecutionRequestApprovalParams,
    ): Promise<CommandExecutionRequestApprovalResponse> {
        const authoritativeParams = params as CommandParamsWithAvailableDecisions;
        const decisions = commandDecisionOptions(authoritativeParams);
        if (!decisions) {
            logger.error("Cancelling command approval without a complete authoritative decision set", undefined);
            return {decision: "cancel"};
        }

        try {
            const response = await this.requestPermission(params, {
                sessionId: params.threadId,
                toolCall: this.renderer.renderPermissionToolCall(CommandReporter.permission(
                    authoritativeParams,
                    this.permissionContext.commandStarted(params.threadId, params.itemId),
                    this.permissionContext.commandName(params.threadId, params.itemId),
                )),
                options: decisions.map(({option}) => option),
                ...requestPermissionMeta(
                    this.renderer.capabilities,
                    params.networkApprovalContext ? CODEX_NETWORK_PERMISSION_TITLE : CODEX_COMMAND_PERMISSION_TITLE,
                    params.reason,
                ),
            });
            return {decision: this.selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("Error requesting command execution permission", error);
            return {decision: "cancel"};
        }
    }

    async handleFileChange(params: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
        const decisions = fileChangeDecisionOptions();
        try {
            const response = await this.requestPermission(params, {
                sessionId: params.threadId,
                toolCall: this.renderer.renderPermissionToolCall(FileChangeReporter.permission(
                    params,
                    this.permissionContext.fileChange(params.threadId, params.itemId),
                )),
                options: decisions.map(({option}) => option),
                ...requestPermissionMeta(
                    this.renderer.capabilities,
                    CODEX_FILE_CHANGE_PERMISSION_TITLE,
                    params.reason,
                ),
            });
            return {decision: this.selectedDecision(response, decisions) ?? "cancel"};
        } catch (error) {
            logger.error("Error requesting file change permission", error);
            return {decision: "cancel"};
        }
    }

    async handlePermissionsRequest(
        params: PermissionsRequestApprovalParams,
    ): Promise<PermissionsRequestApprovalResponse> {
        try {
            const response = await this.requestPermission(params, {
                sessionId: params.threadId,
                toolCall: this.renderer.renderPermissionToolCall(SandboxPermissionReporter.permission(
                    params.itemId,
                    params.cwd,
                    params.environmentId,
                    params.permissions,
                )),
                options: permissionProfileOptions(),
                ...requestPermissionMeta(
                    this.renderer.capabilities,
                    CODEX_ADDITIONAL_PERMISSIONS_TITLE,
                    params.reason,
                ),
            });
            return this.permissionsResponse(params.permissions, response);
        } catch (error) {
            logger.error("Error requesting permissions", error);
            return this.rejectPermissionsResponse();
        }
    }

    setCancellationSignal(signal?: AbortSignal): void {
        this.cancellationSignal = signal;
    }

    cancelPendingRequests(): void {
        for (const controller of this.pendingRequestControllers) {
            controller.abort();
        }
        this.pendingRequestControllers.clear();
        this.pendingRequestControllersById.clear();
    }

    cancelPendingRequest(requestId: RequestId): void {
        const controllers = this.pendingRequestControllersById.get(requestId);
        if (!controllers) return;
        this.pendingRequestControllersById.delete(requestId);
        for (const controller of controllers) {
            this.pendingRequestControllers.delete(controller);
            controller.abort();
        }
    }

    private async requestPermission(
        params: object,
        request: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse> {
        const pendingRequest = this.beginRequest(params, request.sessionId);
        try {
            return await withSubagentUserAction(request.sessionId, () => this.connection.request(
                acp.methods.client.session.requestPermission,
                request,
                pendingRequest.options,
            ), request.toolCall.toolCallId, pendingRequest.options.cancellationSignal);
        } finally {
            pendingRequest.dispose();
        }
    }

    private beginRequest(params: object, sessionId: string): {options: acp.SendRequestOptions, dispose: () => void} {
        const controller = new AbortController();
        const requestId = getAppServerRequestId(params);
        const cancellationSignal = subagentInteractionSignal(sessionId, this.cancellationSignal);
        const abort = () => controller.abort();
        if (cancellationSignal?.aborted) {
            controller.abort();
        } else {
            cancellationSignal?.addEventListener("abort", abort, {once: true});
        }
        this.pendingRequestControllers.add(controller);
        if (requestId !== null) {
            const controllers = this.pendingRequestControllersById.get(requestId) ?? new Set();
            controllers.add(controller);
            this.pendingRequestControllersById.set(requestId, controllers);
        }
        return {
            options: {cancellationSignal: controller.signal},
            dispose: () => {
                this.pendingRequestControllers.delete(controller);
                if (requestId !== null) {
                    const controllers = this.pendingRequestControllersById.get(requestId);
                    controllers?.delete(controller);
                    if (controllers?.size === 0) {
                        this.pendingRequestControllersById.delete(requestId);
                    }
                }
                cancellationSignal?.removeEventListener("abort", abort);
            },
        };
    }

    private selectedDecision<T>(response: acp.RequestPermissionResponse, decisions: DecisionOption<T>[]): T | undefined {
        // A v2 client may answer with a custom outcome instead of "cancelled"; only "selected"
        // carries an `optionId` (ACP-ENUM-203).
        if (response.outcome.outcome !== "selected") return undefined;
        const optionId = response.outcome.optionId;
        return decisions.find(({option}) => option.optionId === optionId)?.decision;
    }

    private permissionsResponse(
        permissions: RequestPermissionProfile,
        response: acp.RequestPermissionResponse,
    ): PermissionsRequestApprovalResponse {
        if (response.outcome.outcome !== "selected") return this.rejectPermissionsResponse();
        switch (response.outcome.optionId) {
            case ApprovalOptionId.AllowPermissionsForTurn:
                return this.grantedPermissionsResponse(permissions, "turn", false);
            case ApprovalOptionId.AllowPermissionsForTurnWithStrictAutoReview:
                return this.grantedPermissionsResponse(permissions, "turn", true);
            case ApprovalOptionId.AllowPermissionsForSession:
                return this.grantedPermissionsResponse(permissions, "session", false);
            case ApprovalOptionId.RejectPermissions:
            default:
                return this.rejectPermissionsResponse();
        }
    }

    private grantedPermissionsResponse(
        permissions: RequestPermissionProfile,
        scope: "turn" | "session",
        strictAutoReview: boolean,
    ): PermissionsRequestApprovalResponse {
        return {permissions: this.grantedPermissions(permissions), scope, strictAutoReview};
    }

    private rejectPermissionsResponse(): PermissionsRequestApprovalResponse {
        return {permissions: {}, scope: "turn", strictAutoReview: false};
    }

    private grantedPermissions(permissions: RequestPermissionProfile): GrantedPermissionProfile {
        return {
            ...(permissions.network ? {network: permissions.network} : {}),
            ...(permissions.fileSystem ? {fileSystem: permissions.fileSystem} : {}),
        };
    }
}
