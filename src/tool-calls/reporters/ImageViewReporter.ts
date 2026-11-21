import {fileUriFromPath, isAbsoluteProtocolPath} from "../../PathUtils";
import type {ThreadItem} from "../../app-server/v2";
import {textContent} from "../AcpToolCallRenderer";
import type {ToolFacts} from "../ToolFacts";

type ImageViewItem = ThreadItem & {type: "imageView"};

/** Reports a Codex image view. The client shows the viewed image as a link. */
export class ImageViewReporter {
    static viewed(item: ImageViewItem): ToolFacts {
        return imageFacts(item, item.path, [item.path]);
    }

    static history(
        item: ImageViewItem,
        replacement: string | null | undefined,
        {fileUri, linkOnly}: {fileUri: boolean; linkOnly: boolean},
    ): ToolFacts {
        const path = replacement === undefined ? item.path : replacement;
        if (path === null) return imageFacts(item, null, []);
        // Zed opens tool locations as text buffers during replay. It can open the image on demand from the link.
        const uri = fileUri ? fileUriFromPath(path) : path;
        const locations = linkOnly || uri === null || (fileUri && !isAbsoluteProtocolPath(path)) ? [] : [path];
        return imageFacts(item, uri, locations);
    }
}

function imageFacts(item: ImageViewItem, uri: string | null, locations: string[]): ToolFacts {
    return {
        toolCallId: item.id,
        report: "start",
        name: "view_image",
        kind: "read",
        title: `View Image ${item.path}`,
        status: "completed",
        result: [uri === null ? textContent(item.path) : {type: "content", content: {type: "resource_link", name: item.path, uri}}],
        locations,
        input: {path: item.path},
    };
}
