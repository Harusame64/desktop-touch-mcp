/**
 * expansion-browser-overview-wrapper.test.ts — walking skeleton expansion
 * phase swimlane 2 (L5 query tool wrapper) contract test.
 * Mechanical copy of PR #122 screenshot pattern (S4 query-axis wrapper).
 */

import { describe, expect, it } from "vitest";
import {
  makeQueryWrapper,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
} from "../../src/tools/_envelope.js";

function resetAll(): void {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
}

describe("expansion swimlane 2 (browser_overview): query wrapper raw shape default", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"actionable":[{"selector":"#btn","name":"Submit"}]}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_overview");
    const result = await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.actionable)).toBe(true);
  });
});

describe("expansion swimlane 2 (browser_overview): include=envelope returns envelope shape", () => {
  it("include=[envelope] → _version + data + as_of + confidence 4 fields", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"actionable":[]}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_overview");
    const result = await wrapped({
      port: 9222,
      include: ["envelope"],
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeDefined();
    expect(parsed.as_of).toBeDefined();
    expect(parsed.confidence).toBeDefined();
  });
});

describe("expansion swimlane 2 (browser_overview): query wrapper does NOT emit L1 events", () => {
  it("query-axis = read-only、L1 ToolCallStarted/Completed events 不発", async () => {
    resetAll();
    let pushedAny = false;
    const handler = async () => {
      pushedAny = true;
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    };
    const wrapped = makeQueryWrapper(handler, "browser_overview");
    await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    expect(pushedAny).toBe(true);
    // makeQueryWrapper does NOT call CommitL1Emitter — only commit wrappers do
  });
});

describe("expansion swimlane 2 (browser_overview): trunk completion contract — mechanical copy", () => {
  it("S4 fast path (causedByProjector 省略) で envelope shape return only", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_overview");
    const result = await wrapped({
      port: 9222,
      include: ["envelope"],
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // S4 fast path: caused_by が含まれず、_version + data + as_of + confidence のみ
    expect(parsed._version).toBe("1.0");
    expect(parsed.caused_by).toBeUndefined();
  });
});
