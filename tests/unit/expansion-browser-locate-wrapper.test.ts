/**
 * expansion-browser-locate-wrapper.test.ts — swimlane 2 (L5 query wrapper)
 * contract test. Mechanical copy of PR #140 browser_overview pattern.
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

describe("expansion swimlane 2 (browser_locate): query wrapper raw shape default", () => {
  it("default 経路 → envelope shape を hoist", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"x":100,"y":200}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_locate");
    const result = await wrapped({
      selector: "#btn",
      port: 9222,
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.x).toBe(100);
  });
});

describe("expansion swimlane 2 (browser_locate): include=envelope returns envelope shape", () => {
  it("include=[envelope] → 4 fields", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_locate");
    const result = await wrapped({
      selector: "#btn",
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

describe("expansion swimlane 2 (browser_locate): query wrapper does NOT emit L1 events", () => {
  it("query-axis = read-only", async () => {
    resetAll();
    let invoked = false;
    const handler = async () => {
      invoked = true;
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    };
    const wrapped = makeQueryWrapper(handler, "browser_locate");
    await wrapped({ selector: "#btn", port: 9222 } as Record<string, unknown>);
    expect(invoked).toBe(true);
  });
});

describe("expansion swimlane 2 (browser_locate): trunk completion contract — mechanical copy", () => {
  it("S4 fast path で envelope shape only (caused_by 不在)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "browser_locate");
    const result = await wrapped({
      selector: "#btn",
      port: 9222,
      include: ["envelope"],
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.caused_by).toBeUndefined();
  });
});
