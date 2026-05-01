/**
 * click-element-commit-wrapper.test.ts — S6 G6 contract test (click_element
 * lease 不在 commit variant、walking skeleton trunk completion PoC).
 *
 * Pins the bit-equal contract for `click_element` wrap via `makeCommitWrapper`
 * per `docs/adr-010-p1-s6-plan.md` §3.5 (G6-S6-1〜3).
 *
 * G6 contract: trunk-completion 判定の証明 = expansion tool 1 件追加が
 * L5 wrapper (= makeCommitWrapper) 修正のみで完了する性質の runtime 実証。
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

// ── G6-S6-1: click_element wrap → L1 ToolCallStarted/Completed event 記録 ────

describe("G6-S6-1: click_element wrap → L1 events recorded (lease 不在 variant)", () => {
  it("makeCommitWrapper flow 通過、ToolCallStarted/Completed 両 event push、lease_token undefined", async () => {
    resetAll();
    const events: Array<{ kind: "started" | "completed"; tool: string; leaseToken?: unknown }> = [];
    const fakeEmitter: CommitL1Emitter = {
      pushStarted: ({ tool, sessionId, toolCallId, leaseToken }) => {
        events.push({ kind: "started", tool, leaseToken });
        // Also feed defaultL1Emitter so history buffer gets seeded for G6-S6-3
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
      content: [{ type: "text", text: '{"ok":true,"data":{"clicked":"button-next"}}' }],
    });
    // Lease 不在 commit variant: leaseValidator omitted (sub-plan §1.1 G、
    // S6 click_element PoC pattern)
    const wrapped = makeCommitWrapper(handler, "click_element", {
      l1Emitter: fakeEmitter,
    });
    const result = await wrapped({ name: "Next" } as Record<string, unknown>);
    // Started + Completed 両 event push されている
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("started");
    expect(events[0].tool).toBe("click_element");
    // lease 不在 variant のため lease_token undefined
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(events[1].tool).toBe("click_element");
    // Result is raw shape (default compat hoist) — handler payload only
    expect(result.content).toBeDefined();
  });
});

// ── G6-S6-2: 既存 raw client 互換 (compat hoist) ──────────────────────────

describe("G6-S6-2: include 未指定時 raw shape return (既存 raw client 互換)", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"clicked":"btn"}' }],
    });
    const wrapped = makeCommitWrapper(handler, "click_element", {});
    const result = await wrapped({} as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // _version 不在 = raw shape (compat hoist で envelope flatten)
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.clicked).toBe("btn");
  });
});

// ── G6-S6-3: include=causal 経路 → caused_by.your_last_action = "click_element(...)" ──

describe("G6-S6-3: include=causal で caused_by.your_last_action に click_element 記録", () => {
  it("click_element wrap → history buffer に entry → buildCausedBy で your_last_action = click_element(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "click_element", {
      getSessionId: () => "sessA",
    });
    await wrapped({ name: "Submit" } as Record<string, unknown>);
    // history buffer に entry が記録されているか確認
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("click_element");
    expect(causedBy?.tool_call_id).toMatch(/^sessA:\d+$/);
    // based_on も並列で動作確認
    const basedOn = buildBasedOn("sessA", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    // events は string[] (u64 decimal) で JSON-safe
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

// ── trunk completion contract: L5 wrapper のみで mechanical コピー成立 ────

describe("trunk completion contract: makeCommitWrapper mechanical copy works for click_element", () => {
  it("S5 contract が click_element wrap でそのまま機能 (lease validator omit のみで lease 不在 variant)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "click_element", {
      // sub-plan §2.3: getSessionId / argsSummary / clock も default 利用
      // = mechanical コピー最小、leaseValidator のみ omit
    });
    const result = await wrapped({ name: "OK" } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
    // L1 emitter は default で動作 (production では nativeL1 push、test では history buffer のみ)
  });
});
