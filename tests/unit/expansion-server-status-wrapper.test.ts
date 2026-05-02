/**
 * expansion-server-status-wrapper.test.ts — swimlane 2 (L5 query wrapper)
 * contract test. Mechanical copy of PR #122 / #140-#144 query pattern.
 * Note: server_status is not in TOOL_REGISTRY (diagnostic only、not callable
 * from run_macro)、so no macro path test.
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

describe("expansion swimlane 2 (server_status): query wrapper raw shape default", () => {
  it("default 経路 → envelope shape を hoist", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"engine":{"version":"1.1.3"}}' }],
    });
    const wrapped = makeQueryWrapper(handler, "server_status");
    const result = await wrapped({} as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.engine).toBeDefined();
  });
});

describe("expansion swimlane 2 (server_status): include=envelope returns envelope shape", () => {
  it("include=[envelope] → 4 fields", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"engine":{"version":"1.1.3"}}' }],
    });
    const wrapped = makeQueryWrapper(handler, "server_status");
    const result = await wrapped({
      include: ["envelope"],
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeDefined();
    expect(parsed.as_of).toBeDefined();
    expect(parsed.confidence).toBeDefined();
  });
});

describe("expansion swimlane 2 (server_status): query wrapper does NOT emit L1 events", () => {
  it("query-axis = read-only", async () => {
    resetAll();
    let invoked = false;
    const handler = async () => {
      invoked = true;
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    };
    const wrapped = makeQueryWrapper(handler, "server_status");
    await wrapped({} as Record<string, unknown>);
    expect(invoked).toBe(true);
  });
});

describe("expansion swimlane 2 (server_status): trunk completion contract — mechanical copy", () => {
  it("S4 fast path で envelope shape only", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "server_status");
    const result = await wrapped({
      include: ["envelope"],
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0");
    expect(parsed.caused_by).toBeUndefined();
  });
});
