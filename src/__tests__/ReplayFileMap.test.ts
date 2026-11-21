import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {asSdkSessionNotification, type AcpSessionUpdate} from "../AcpSessionExtensions";
import {toV2SessionUpdates} from "../AcpV2SessionUpdate";
import {loadReplayFileMap, projectReplayLocations} from "../ReplayFileMap";
import {AcpToolCallRenderer} from "../tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "../tool-calls/ClientCapabilities";
import type {ToolFacts} from "../tool-calls/ToolFacts";

const old = resolve("old-checkout/file.ts");
const current = resolve("current-checkout/file.ts");
const missing = resolve("old-checkout/missing.ts");
const unrelated = resolve("other-checkout/file.ts");
const paths = new Map<string, string | null>([[old, current], [missing, null]]);

describe("replay file map", () => {
    it("accepts only complete maps of exact absolute paths and reports invalid input once", () => {
        const directory = mkdtempSync(join(tmpdir(), "codex-acp-replay-map-"));
        const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const file = join(directory, "map.json");
            expect(loadReplayFileMap(undefined)).toBeUndefined();
            expect(diagnostic).not.toHaveBeenCalled();

            const portable = new Map(paths).set(String.raw`C:\previous\file.ts`, current)
                .set(unrelated, String.raw`D:\checkout\file.ts`);
            writeFileSync(file, JSON.stringify(Object.fromEntries(portable)));
            expect(loadReplayFileMap(file)).toEqual(portable);
            expect(diagnostic).not.toHaveBeenCalled();

            writeFileSync(file, JSON.stringify({[old]: current, [missing]: "relative-target"}));
            expect(loadReplayFileMap(file)).toBeUndefined();
            expect(diagnostic).toHaveBeenCalledTimes(1);

            diagnostic.mockClear();
            expect(loadReplayFileMap(join(directory, "unavailable.json"))).toBeUndefined();
            expect(diagnostic).toHaveBeenCalledTimes(1);
        } finally {
            diagnostic.mockRestore();
            rmSync(directory, {recursive: true, force: true});
        }
    });

    it("preserves distinct lines, metadata and order, and merges relocated duplicates", () => {
        const sameTarget = {path: current, line: 12, _meta: {annotation: "same"}};
        const anotherLine = {path: old, line: 15, _meta: {annotation: "other line"}};
        const unlisted = {path: unrelated, line: 4};
        const report = {
            sessionUpdate: "tool_call_update" as const,
            toolCallId: "read",
            locations: [{...sameTarget, path: old}, unlisted, sameTarget, sameTarget, anotherLine, anotherLine, {path: missing}],
        };
        const projected = projectReplayLocations(report, paths);
        expect(projected.locations).toEqual([unlisted, sameTarget, sameTarget, {...anotherLine, path: current}]);
        expect(projected.locations?.[0]).toBe(unlisted);
        expect(report.locations[0]?.path).toBe(old);
    });

    it.each([1, 2] as const)("projects the final standard replay locations on ACP v%i", protocol => {
        const capabilities = protocol === 1 ? ClientCapabilities.DEFAULT : ClientCapabilities.fromV2(null);
        const renderer = new AcpToolCallRenderer(capabilities);
        const wire = (update: AcpSessionUpdate) => protocol === 1
            ? [asSdkSessionNotification({sessionId: "session", update}).update]
            : toV2SessionUpdates(update);
        const facts: ToolFacts = {
            report: "start",
            toolCallId: "read",
            title: `Read ${old}`,
            kind: "read",
            locations: [unrelated],
            standard: {locations: [old], rawInput: {cwd: old}, rawOutput: old},
        };
        const live = renderer.render(facts);
        expect(live.locations).toEqual([{path: old}]);
        expect(wire(projectReplayLocations(live, paths))).toEqual(wire({...live, locations: [{path: current}]}));

        const update = renderer.render({...facts, report: "update", standard: {locations: [missing]}});
        expect(wire(projectReplayLocations(update, paths))).toMatchObject([{locations: []}]);

        const withoutLocations = renderer.render({...facts, standard: {locations: null}});
        expect(projectReplayLocations(withoutLocations, paths)).toBe(withoutLocations);
    });

    it("changes tool locations without rewriting unrelated resource links", () => {
        const report = {
            sessionUpdate: "tool_call" as const,
            toolCallId: "lookup",
            title: "Look up resource",
            locations: [{path: old}],
            content: [old, "file://remote.example/image.png"].map(uri => ({
                type: "content" as const,
                content: {type: "resource_link" as const, name: old, uri},
            })),
        };
        expect(projectReplayLocations(report, paths)).toEqual({...report, locations: [{path: current}]});
        expect(projectReplayLocations(report, new Map([[old, old]]))).toBe(report);
    });
});
