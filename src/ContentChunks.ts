import type {ContentBlock} from "@agentclientprotocol/sdk/unstable";
import type {MemoryCitation, UserInput} from "./app-server/v2";
import type {UpdateSessionEvent} from "./ACPSessionConnection";
import {AIR_MESSAGE_PHASE_KEY, airOnlyMeta} from "./AirExtension";

type AcpMeta = Record<string, unknown>;

/** The Codex phase of an agent message. Only AIR gets it, in `_meta.jetbrains.air.phase`. */
export function createMessagePhaseMeta(phase: string | null | undefined, airClient: boolean): AcpMeta | undefined {
    if (!phase) {
        return undefined;
    }
    return airOnlyMeta(airClient, AIR_MESSAGE_PHASE_KEY, phase);
}

export function createCodexMessageMeta(
    phase: string | null | undefined,
    memoryCitation: MemoryCitation | null | undefined,
    airClient: boolean,
): AcpMeta | undefined {
    const phaseMeta = createMessagePhaseMeta(phase, airClient);
    return memoryCitation ? {...phaseMeta, codex: {memoryCitation}} : phaseMeta;
}

export function createUserMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "user_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "user_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentThoughtChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_thought_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentTextMessageChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentMessageChunk({type: "text", text}, messageId, meta);
}

export function createAgentTextThoughtChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentThoughtChunk({type: "text", text}, messageId, meta);
}

export function userInputToContentBlocks(input: UserInput): ContentBlock[] {
    switch (input.type) {
        case "text":
            return input.text.length > 0 ? [{type: "text", text: input.text}] : [];
        case "image": {
            if (!("url" in input)) return [{type: "text", text: `image:${input.fileId}`}];
            const image = dataUrlImageContent(input.url);
            return image ? [image] : [{type: "text", text: formatUriAsLink("image", input.url)}];
        }
        case "localImage": {
            const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
            return [{type: "text", text: formatUriAsLink(null, uri)}];
        }
        case "audio": {
            const audio = dataUrlAudioContent(input.url);
            return audio ? [audio] : [{type: "text", text: formatUriAsLink("audio", input.url)}];
        }
        case "localAudio": {
            const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
            return [{type: "text", text: formatUriAsLink(null, uri)}];
        }
        case "skill":
            return [{type: "text", text: `skill:${input.name} (${input.path})`}];
        case "mention":
            return [{type: "text", text: formatUriAsLink(input.name, input.path)}];
    }
}

function dataUrlImageContent(url: string): ContentBlock | null {
    const match = /^data:(image\/[^;,]+);base64,([\s\S]*)$/i.exec(url);
    if (!match) {
        return null;
    }
    return {
        type: "image",
        mimeType: match[1]!,
        data: match[2]!,
        uri: url,
    };
}

function dataUrlAudioContent(url: string): ContentBlock | null {
    const match = /^data:(audio\/[^;,]+);base64,([\s\S]*)$/i.exec(url);
    if (!match) {
        return null;
    }
    return {
        type: "audio",
        mimeType: match[1]!,
        data: match[2]!,
    };
}

function formatUriAsLink(name: string | null, uri: string): string {
    if (name && name.length > 0) {
        return `[@${name}](${uri})`;
    }
    if (uri.startsWith("file://")) {
        const path = uri.replace("file://", "");
        const fileName = path.split("/").pop() ?? path;
        return `[@${fileName}](${uri})`;
    }
    return uri;
}
