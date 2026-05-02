/**
 * expansion-scroll-wrapper.test.ts — walking skeleton expansion phase
 * swimlane 1 (L5 commit tool wrapper) contract test.
 *
 * Pins the bit-equal contract for `scroll` wrap via `makeCommitWrapper`
 * per `docs/walking-skeleton-expansion-plan.md` §3 (30 分タイムアタック
 * template) — mechanical copy of PR #126 clipboard wrap pattern
 * (`tests/unit/expansion-clipboard-wrapper.test.ts`), the discriminatedUnion
 * (3b) family for wheel/UIA/CDP/OCR scroll dispatch.
 *
 * Trunk contract conformance:
 *   - L5 wrapper のみで mechanical コピー成立 (engine-perception layer 改変ゼロ)
 *   - lease 不在 commit variant (`leaseValidator` 省略、wheel/UIA/CDP scroll)
 *   - run_macro 経路と server.registerTool 経路で同 instance 共有
 *     (PR #112 shared registration handler pattern)
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

// ── E1: scroll wrap → L1 ToolCallStarted/Completed event 記録 ─────────────────

describe("expansion swimlane 1 (scroll): wrap → L1 events recorded (lease 不在 variant)", () => {
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
      content: [{ type: "text", text: '{"ok":true,"scrolled":"down","steps":3}' }],
    });
    // Lease 不在 commit variant: leaseValidator omitted (scroll wheel/UIA/CDP/OCR
    // dispatch without a lease 4-tuple, sub-plan §3.1 line 153 expansion 30 分
    // template、PR #126 clipboard pattern mechanical copy)
    const wrapped = makeCommitWrapper(handler, "scroll", {
      l1Emitter: fakeEmitter,
    });
    const result = await wrapped({
      action: "raw",
      direction: "down",
      amount: 3,
    } as Record<string, unknown>);
    // Started + Completed 両 event push されている
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("started");
    expect(events[0].tool).toBe("scroll");
    // lease 不在 variant のため lease_token undefined
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(events[1].tool).toBe("scroll");
    expect(result.content).toBeDefined();
  });
});

// ── E2: include 未指定時 raw shape return (既存 raw client 互換) ─────────────

describe("expansion swimlane 1 (scroll): include 未指定時 raw shape return", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"scrolled":"down","steps":3}' }],
    });
    const wrapped = makeCommitWrapper(handler, "scroll", {});
    const result = await wrapped({
      action: "raw",
      direction: "down",
      amount: 3,
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // _version 不在 = raw shape (compat hoist で envelope flatten)
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.scrolled).toBe("down");
    expect(parsed.steps).toBe(3);
  });
});

// ── E3: include=causal 経路 → caused_by.your_last_action = "scroll(...)" ─────

describe("expansion swimlane 1 (scroll): include=causal で caused_by.your_last_action に scroll 記録", () => {
  it("scroll wrap → history buffer に entry → buildCausedBy で your_last_action = scroll(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "scroll", {
      getSessionId: () => "sessSC",
    });
    await wrapped({
      action: "raw",
      direction: "down",
      amount: 1,
    } as Record<string, unknown>);
    // history buffer に entry が記録されているか確認
    const causedBy = buildCausedBy("sessSC", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("scroll");
    expect(causedBy?.tool_call_id).toMatch(/^sessSC:\d+$/);
    // based_on も並列で動作確認
    const basedOn = buildBasedOn("sessSC", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    // events は string[] (u64 decimal) で JSON-safe
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

// ── E4: trunk completion contract: L5 wrapper のみで mechanical copy 成立 ────

describe("expansion swimlane 1 (scroll): trunk completion contract — mechanical copy", () => {
  it("S5 contract が scroll wrap でそのまま機能 (lease validator omit のみで lease 不在 variant)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "scroll", {
      // sub-plan §3.1: getSessionId / argsSummary / clock も default 利用
      // = mechanical コピー最小、leaseValidator のみ omit
    });
    const result = await wrapped({
      action: "raw",
      direction: "up",
      amount: 1,
    } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
    // L1 emitter は default で動作 (production では nativeL1 push、test では history buffer のみ)
  });
});
