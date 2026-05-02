/**
 * expansion-focus-window-wrapper.test.ts — walking skeleton expansion phase
 * swimlane 1 (L5 commit tool wrapper) contract test.
 *
 * Pins the bit-equal contract for `focus_window` wrap via `makeCommitWrapper`
 * per `docs/walking-skeleton-expansion-plan.md` §3 (30 分タイムアタック
 * template) — mechanical copy of PR #121 mouse_click wrap pattern
 * (`tests/unit/expansion-mouse-click-wrapper.test.ts`), the raw shape (3a)
 * family for title-driven window focus.
 *
 * Trunk contract conformance:
 *   - L5 wrapper のみで mechanical コピー成立 (engine-perception layer 改変ゼロ)
 *   - lease 不在 commit variant (`leaseValidator` 省略、title-driven focus)
 *   - run_macro 経路と server.tool 経路で同 instance 共有
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

// ── E1: focus_window wrap → L1 ToolCallStarted/Completed event 記録 ──────────

describe("expansion swimlane 1 (focus_window): wrap → L1 events recorded (lease 不在 variant)", () => {
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
      content: [{ type: "text", text: '{"ok":true,"focused":"Notepad","region":{"x":0,"y":0,"width":800,"height":600}}' }],
    });
    // Lease 不在 commit variant: leaseValidator omitted (focus_window is
    // title-driven without a lease 4-tuple, sub-plan §3.1 line 153 expansion
    // 30 分 template、PR #121 mouse_click pattern mechanical copy)
    const wrapped = makeCommitWrapper(handler, "focus_window", {
      l1Emitter: fakeEmitter,
    });
    const result = await wrapped({
      title: "Notepad",
    } as Record<string, unknown>);
    // Started + Completed 両 event push されている
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("started");
    expect(events[0].tool).toBe("focus_window");
    // lease 不在 variant のため lease_token undefined
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(events[1].tool).toBe("focus_window");
    expect(result.content).toBeDefined();
  });
});

// ── E2: include 未指定時 raw shape return (既存 raw client 互換) ─────────────

describe("expansion swimlane 1 (focus_window): include 未指定時 raw shape return", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"focused":"Notepad"}' }],
    });
    const wrapped = makeCommitWrapper(handler, "focus_window", {});
    const result = await wrapped({
      title: "Notepad",
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // _version 不在 = raw shape (compat hoist で envelope flatten)
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.focused).toBe("Notepad");
  });
});

// ── E3: include=causal 経路 → caused_by.your_last_action = "focus_window(...)" ─

describe("expansion swimlane 1 (focus_window): include=causal で caused_by.your_last_action に focus_window 記録", () => {
  it("focus_window wrap → history buffer に entry → buildCausedBy で your_last_action = focus_window(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "focus_window", {
      getSessionId: () => "sessFW",
    });
    await wrapped({
      title: "Notepad",
    } as Record<string, unknown>);
    // history buffer に entry が記録されているか確認
    const causedBy = buildCausedBy("sessFW", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("focus_window");
    expect(causedBy?.tool_call_id).toMatch(/^sessFW:\d+$/);
    // based_on も並列で動作確認
    const basedOn = buildBasedOn("sessFW", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    // events は string[] (u64 decimal) で JSON-safe
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

// ── E4: trunk completion contract: L5 wrapper のみで mechanical copy 成立 ────

describe("expansion swimlane 1 (focus_window): trunk completion contract — mechanical copy", () => {
  it("S5 contract が focus_window wrap でそのまま機能 (lease validator omit のみで lease 不在 variant)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "focus_window", {
      // sub-plan §3.1: getSessionId / argsSummary / clock も default 利用
      // = mechanical コピー最小、leaseValidator のみ omit
    });
    const result = await wrapped({
      title: "Notepad",
    } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
    // L1 emitter は default で動作 (production では nativeL1 push、test では history buffer のみ)
  });
});
