/**
 * expansion-browser-form-wrapper.test.ts — walking skeleton expansion phase
 * swimlane 1 (L5 commit tool wrapper) contract test.
 * Mechanical copy of PR #134 browser_open / PR #135 browser_navigate /
 * PR #136 browser_click pattern.
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeCommitWrapper,
  defaultL1Emitter,
  buildCausedBy,
  buildBasedOn,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  type CommitL1Emitter,
  type ViewSnapshot,
} from "../../src/tools/_envelope.js";

function resetAll(): void {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
}

function makeViewSnapshot(): ViewSnapshot {
  return {
    focus: { hwnd: null, elementName: "test-element" },
    dirtyRectsByMonitor: new Map([[0, 1]]),
    latestEventId: 100n,
    queryWallclockMs: Date.now(),
  };
}

describe("expansion swimlane 1 (browser_form): wrap → L1 events recorded", () => {
  it("makeCommitWrapper flow 通過、両 event push、lease_token undefined", async () => {
    resetAll();
    const events: Array<{ kind: "started" | "completed"; tool: string; leaseToken?: unknown }> = [];
    const fakeEmitter: CommitL1Emitter = {
      pushStarted: ({ tool, sessionId, toolCallId, leaseToken }) => {
        events.push({ kind: "started", tool, leaseToken });
        defaultL1Emitter.pushStarted({ tool, argsJson: "{}", sessionId, toolCallId, leaseToken });
      },
      pushCompleted: ({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId }) => {
        events.push({ kind: "completed", tool });
        defaultL1Emitter.pushCompleted({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId });
      },
    };
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"fields":[]}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_form", { l1Emitter: fakeEmitter });
    const result = await wrapped({
      selector: "form",
      port: 9222,
    } as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0].tool).toBe("browser_form");
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(result.content).toBeDefined();
  });
});

describe("expansion swimlane 1 (browser_form): include 未指定時 raw shape return", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"fields":[]}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_form", {});
    const result = await wrapped({
      selector: "form",
      port: 9222,
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.fields)).toBe(true);
  });
});

describe("expansion swimlane 1 (browser_form): include=causal で caused_by.your_last_action に browser_form 記録", () => {
  it("browser_form wrap → history buffer に entry → buildCausedBy で your_last_action = browser_form(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_form", {
      getSessionId: () => "sessBM",
    });
    await wrapped({
      selector: "form",
      port: 9222,
    } as Record<string, unknown>);
    const causedBy = buildCausedBy("sessBM", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("browser_form");
    expect(causedBy?.tool_call_id).toMatch(/^sessBM:\d+$/);
    const basedOn = buildBasedOn("sessBM", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

describe("expansion swimlane 1 (browser_form): trunk completion contract — mechanical copy", () => {
  it("S5 contract が browser_form wrap でそのまま機能", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "browser_form", {});
    const result = await wrapped({
      selector: "form",
      port: 9222,
    } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
  });
});
