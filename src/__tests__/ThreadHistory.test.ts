import {describe, expect, it, vi} from "vitest";
import type {Thread, ThreadItemEntry, Turn} from "../app-server/v2";
import {hydrateThreadHistory, readThreadHistory} from "../ThreadHistory";
import {createCodexMockTestFixture, createTestModel} from "./acp-test-utils";

function turn(id: string): Turn {
    return {id, rootTurnId: null, items: [], itemsView: "notLoaded", status: "completed", error: null,
        startedAt: null, completedAt: null, durationMs: null};
}

function entry(turnId: string, id: string, text: string): ThreadItemEntry {
    return {turnId, startedAtMs: null, completedAtMs: null, item: {type: "agentMessage", id, text, phase: null,
        memoryCitation: null, delivery: null, questions: null}};
}

function fixture() {
    const mock = createCodexMockTestFixture();
    const client = mock.getCodexAppServerClient();
    const thread = {id: "history-thread", cwd: "/workspace", historyMode: "paginated", turns: []} as unknown as Thread;
    const read = vi.spyOn(client, "threadRead").mockResolvedValue({thread});
    const turns = vi.spyOn(client, "threadTurnsList").mockResolvedValue({data: [], nextCursor: null, backwardsCursor: null});
    const items = vi.spyOn(client, "threadItemsList").mockResolvedValue({data: [], nextCursor: null, backwardsCursor: null});
    return {mock, client, thread, read, turns, items};
}

describe("thread history pagination", () => {
    it("loads every page in transcript order and preserves repeated text and turn-local item IDs", async () => {
        const {client, thread, read, turns, items} = fixture();
        turns.mockResolvedValueOnce({data: [turn("turn-2")], nextCursor: "older-turns", backwardsCursor: null})
            .mockResolvedValueOnce({data: [turn("turn-1")], nextCursor: null, backwardsCursor: null});
        items.mockResolvedValueOnce({data: [entry("turn-2", "same-id", "Same text")], nextCursor: "older-items", backwardsCursor: null})
            .mockResolvedValueOnce({data: [entry("turn-1", "last", "Last"), entry("turn-1", "same-id", "Same text")], nextCursor: null, backwardsCursor: null});

        const result = await hydrateThreadHistory(client, thread, {
            turnsBackwardsCursor: "resume-turn", itemsBackwardsCursor: "resume-item",
        });

        await expect(JSON.stringify({
            turns: result.turns,
            requests: {turns: turns.mock.calls, items: items.mock.calls},
        }, null, 2)).toMatchFileSnapshot("./data/thread-history-pages.json");
        expect(read).not.toHaveBeenCalled();
    });

    it("honors empty resume anchors even if a new turn has since arrived", async () => {
        const {client, thread, turns, items} = fixture();
        turns.mockResolvedValue({data: [turn("new-turn")], nextCursor: null, backwardsCursor: null});
        const result = await hydrateThreadHistory(client, thread, {
            turnsBackwardsCursor: null, itemsBackwardsCursor: null,
        });
        expect(result.turns).toEqual([]);
        expect(turns).not.toHaveBeenCalled();
        expect(items).not.toHaveBeenCalled();
    });

    it("captures unanchored turns before reading items so a new turn cannot appear empty", async () => {
        const {client, thread, turns, items} = fixture();
        let releaseTurns!: () => void;
        turns.mockImplementationOnce(async () => {
            await new Promise<void>(resolve => { releaseTurns = resolve; });
            return {data: [turn("captured-turn")], nextCursor: null, backwardsCursor: null};
        });
        items.mockResolvedValue({
            data: [entry("later-turn", "later", "After snapshot"), entry("captured-turn", "captured", "Included")],
            nextCursor: null, backwardsCursor: null,
        });
        const loading = hydrateThreadHistory(client, thread);
        expect(items).not.toHaveBeenCalled();
        releaseTurns();
        const result = await loading;
        expect(result.turns.map(t => ({id: t.id, items: t.items.map(i => i.id)})))
            .toEqual([{id: "captured-turn", items: ["captured"]}]);
    });

    it("fails a repeated cursor instead of hanging or returning truncated history", async () => {
        const {client, thread, items} = fixture();
        items.mockResolvedValue({data: [], nextCursor: "same-cursor", backwardsCursor: null});
        await expect(hydrateThreadHistory(client, thread)).rejects.toThrow("repeated cursor");
        expect(items).toHaveBeenCalledTimes(2);
    });

    it("propagates page failures instead of claiming an incomplete transcript was loaded", async () => {
        const {client, thread, items} = fixture();
        items.mockResolvedValueOnce({data: [entry("turn-1", "a", "Partial")], nextCursor: "next", backwardsCursor: null})
            .mockRejectedValueOnce(new Error("connection lost"));
        await expect(hydrateThreadHistory(client, thread)).rejects.toThrow("connection lost");
    });

    it("uses the legacy history endpoint for legacy threads", async () => {
        const {client, thread, read, turns, items} = fixture();
        thread.historyMode = "legacy";
        await readThreadHistory(client, thread.id);
        expect(read.mock.calls).toEqual([
            [{threadId: thread.id, includeTurns: false}],
            [{threadId: thread.id, includeTurns: true}],
        ]);
        expect(turns).not.toHaveBeenCalled();
        expect(items).not.toHaveBeenCalled();
    });

    it.each(["loadSession", "resumeSession"] as const)("%s avoids full-history responses and restores the active turn", async method => {
        const {mock, client, thread, read, turns, items} = fixture();
        thread.status = {type: "active", activeFlags: []};
        const activeTurn = {...turn("active-turn"), status: "inProgress" as const};
        turns.mockResolvedValue({data: [activeTurn], nextCursor: null, backwardsCursor: null});
        items.mockResolvedValue({data: [entry(activeTurn.id, "active-item", "Existing prefix")], nextCursor: null, backwardsCursor: null});
        vi.spyOn(client, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(client, "listModels").mockResolvedValue({data: [createTestModel()], nextCursor: null});
        const resume = vi.spyOn(client, "threadResume").mockResolvedValue({
            thread, model: "model-id", modelProvider: "openai", reasoningEffort: "medium",
            serviceTier: null, cwd: "/workspace", instructionSources: [], disabledPluginIds: [], collaborationMode: null, approvalPolicy: "never",
            approvalsReviewer: "user", sandbox: {type: "dangerFullAccess"},
            activePermissionProfile: {id: "team", extends: ":workspace"},
            turnsBackwardsCursor: "resume-turn", itemsBackwardsCursor: "resume-item",
        });
        const result = await mock.getCodexAcpClient()[method]({sessionId: thread.id, cwd: "/workspace", mcpServers: []});
        expect(resume).toHaveBeenCalledWith(expect.objectContaining({excludeTurns: true}));
        expect(read).toHaveBeenCalledExactlyOnceWith({threadId: thread.id, includeTurns: false});
        expect(result.activeTurnId).toBe(activeTurn.id);
        expect(result.activePermissionProfileId).toBe("team");
        expect(result.turnSettings?.preservePermissionProfile).toBe(true);
        if (method === "resumeSession") {
            expect(result.threadSnapshot?.turns[0]?.items[0]).toMatchObject({text: "Existing prefix"});
        }
    });
});
