import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {Thread, ThreadItemEntry, ThreadResumeResponse, Turn} from "./app-server/v2";

type HistoryClient = Pick<CodexAppServerClient, "threadRead" | "threadTurnsList" | "threadItemsList">;
type HistoryCursors = Pick<ThreadResumeResponse, "turnsBackwardsCursor" | "itemsBackwardsCursor">;
const HISTORY_PAGE_SIZE = 100;

export async function readThreadHistory(client: HistoryClient, threadId: string): Promise<Thread> {
    const {thread} = await client.threadRead({threadId, includeTurns: false});
    return await hydrateThreadHistory(client, thread);
}

/** Hydrate bounded pages, keeping a resumed thread anchored to its resume cursors. */
export async function hydrateThreadHistory(
    client: HistoryClient,
    thread: Thread,
    cursors?: HistoryCursors,
): Promise<Thread> {
    if (thread.historyMode !== "paginated") {
        return (await client.threadRead({threadId: thread.id, includeTurns: true})).thread;
    }

    // Keep item payloads out of turn pages: even one tool-heavy turn can exceed
    // the transport's message limit. Items are paged separately across the thread.
    const turnsPromise = readPages<Turn>(cursors?.turnsBackwardsCursor, cursor => client.threadTurnsList({
        threadId: thread.id,
        ...(cursor !== undefined ? {cursor} : {}),
        limit: HISTORY_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "notLoaded",
    }));
    // Without resume anchors, capture the set of turns before reading their
    // items. Otherwise the item read could finish before a returned turn exists.
    if (cursors?.turnsBackwardsCursor === undefined || cursors?.itemsBackwardsCursor === undefined) {
        await turnsPromise;
    }
    const [turns, entries] = await Promise.all([
        turnsPromise,
        readPages<ThreadItemEntry>(cursors?.itemsBackwardsCursor, cursor => client.threadItemsList({
            threadId: thread.id,
            ...(cursor !== undefined ? {cursor} : {}),
            limit: HISTORY_PAGE_SIZE,
            sortDirection: "desc",
        })),
    ]);

    const turnsById = new Map<string, Turn>();
    for (const turn of turns.reverse()) {
        turnsById.set(turn.id, {...turn, items: [], itemsView: "full"});
    }
    const seenItems = new Map<string, Set<string>>();
    for (const {turnId, item} of entries.reverse()) {
        const turn = turnsById.get(turnId);
        // An unanchored read excludes turns created after its captured turn list.
        // Never attach their items to an older turn.
        if (!turn) continue;
        const seen = seenItems.get(turnId) ?? new Set<string>();
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        seenItems.set(turnId, seen);
        turn.items.push(item);
    }
    return {...thread, turns: [...turnsById.values()]};
}

async function readPages<T>(
    initialCursor: string | null | undefined,
    read: (cursor: string | undefined) => Promise<{data: T[]; nextCursor: string | null}>,
): Promise<T[]> {
    // An explicit null resume cursor denotes an empty snapshot. Undefined is
    // an unanchored metadata read (or a server predating the resume cursors).
    if (initialCursor === null) return [];
    let cursor = initialCursor;
    const seenCursors = new Set<string>();
    const result: T[] = [];
    while (true) {
        if (cursor !== undefined) {
            if (seenCursors.has(cursor)) throw new Error("Thread history pagination returned a repeated cursor");
            seenCursors.add(cursor);
        }
        const page = await read(cursor);
        result.push(...page.data);
        if (page.nextCursor === null) return result;
        cursor = page.nextCursor;
    }
}
