/**
 * mouse-click-commit-wrapper.test.ts — expansion swimlane 1 contract test
 * (mouse_click lease 不在 commit variant、walking skeleton expansion phase
 * の最初の本格 PR、`docs/walking-skeleton-expansion-plan.md` §3 30-minute
 * time-attack template 適用例).
 *
 * Pins the bit-equal contract for `mouse_click` wrap via `makeCommitWrapper`
 * — mechanical copy of `tests/unit/click-element-commit-wrapper.test.ts`
 * (PR #117 G6 contract test、tool name のみ置換).
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

// ── expansion-1: mouse_click wrap → L1 ToolCallStarted/Completed event 記録 ────

describe("expansion-1: mouse_click wrap → L1 events recorded (lease 不在 variant)", () => {
  it("makeCommitWrapper flow 通過、ToolCallStarted/Completed 両 event push、lease_token undefined", async () => {
    resetAll();
    const events: Array<{ kind: "started" | "completed"; tool: string; leaseToken?: unknown }> = [];
    const fakeEmitter: CommitL1Emitter = {
      pushStarted: ({ tool, sessionId, toolCallId, leaseToken }) => {
        events.push({ kind: "started", tool, leaseToken });
        defaultL1Emitter.pushStarted({
          tool,
          argsJson: "{}",
          sessionId,
          toolCallId,
          leaseToken,
        });
      },
      pushCompleted: ({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId }) => {
        events.push({ kind: "completed", tool });
        defaultL1Emitter.pushCompleted({
          tool,
          elapsedMs,
          ok,
          errorCode,
          sessionId,
          toolCallId,
        });
      },
    };
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"data":{"clicked":{"x":100,"y":200}}}' }],
    });
    const wrapped = makeCommitWrapper(handler, "mouse_click", {
      l1Emitter: fakeEmitter,
    });
    const result = await wrapped({ x: 100, y: 200 } as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("started");
    expect(events[0].tool).toBe("mouse_click");
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(events[1].tool).toBe("mouse_click");
    expect(result.content).toBeDefined();
  });
});

// ── expansion-2: 既存 raw client 互換 (compat hoist) ──────────────────────────

describe("expansion-2: include 未指定時 raw shape return (既存 raw client 互換)", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"clicked":{"x":50,"y":60}}' }],
    });
    const wrapped = makeCommitWrapper(handler, "mouse_click", {});
    const result = await wrapped({} as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.clicked).toEqual({ x: 50, y: 60 });
  });
});

// ── expansion-3: include=causal 経路 → caused_by.your_last_action = "mouse_click(...)" ──

describe("expansion-3: include=causal で caused_by.your_last_action に mouse_click 記録", () => {
  it("mouse_click wrap → history buffer に entry → buildCausedBy で your_last_action = mouse_click(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "mouse_click", {
      getSessionId: () => "sessA",
    });
    await wrapped({ x: 200, y: 300 } as Record<string, unknown>);
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("mouse_click");
    expect(causedBy?.tool_call_id).toMatch(/^sessA:\d+$/);
    const basedOn = buildBasedOn("sessA", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

// ── expansion contract: mechanical copy from S6 click_element PoC works ────

describe("expansion contract: makeCommitWrapper mechanical copy works for mouse_click", () => {
  it("S5/S6 contract が mouse_click wrap でそのまま機能 (lease validator omit のみ)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "mouse_click", {
      // walking-skeleton-expansion-plan.md §3 30-minute time-attack:
      // getSessionId / argsSummary / clock も default 利用、leaseValidator のみ omit
    });
    const result = await wrapped({ x: 1, y: 2 } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
  });
});
