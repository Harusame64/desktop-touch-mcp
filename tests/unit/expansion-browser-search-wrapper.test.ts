/**
 * expansion-browser-search-wrapper.test.ts — swimlane 2 (L5 query wrapper)
 * contract test. Mechanical copy of PR #140 / #141 query wrapper pattern.
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

describe("expansion swimlane 2 (browser_search): query wrapper raw shape default", () => {
  it("default 経路 → envelope shape を hoist", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"results":[]}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_search");
    const result = await wrapped({
      by: "text",
      pattern: "Submit",
      port: 9222,
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});

describe("expansion swimlane 2 (browser_search): include=envelope returns envelope shape", () => {
  it("include=[envelope] → 4 fields", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_search");
    const result = await wrapped({
      by: "text",
      pattern: "Submit",
      port: 9222,
      include: ["envelope"],
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeDefined();
    expect(parsed.as_of).toBeDefined();
    expect(parsed.confidence).toBeDefined();
  });
});

describe("expansion swimlane 2 (browser_search): query wrapper does NOT emit L1 events", () => {
  it("query-axis = read-only", async () => {
    resetAll();
    let invoked = false;
    const handler = async () => {
      invoked = true;
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    };
    const wrapped = makeQueryWrapper(handler, "browser_search");
    await wrapped({ by: "text", pattern: "x", port: 9222 } as Record<string, unknown>);
    expect(invoked).toBe(true);
  });
});

describe("expansion swimlane 2 (browser_search): trunk completion contract — mechanical copy", () => {
  it("S4 fast path で envelope shape only", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_search");
    const result = await wrapped({
      by: "regex",
      pattern: "^test",
      port: 9222,
      include: ["envelope"],
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.caused_by).toBeUndefined();
  });
});
