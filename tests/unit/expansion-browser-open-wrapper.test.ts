/**
 * expansion-browser-open-wrapper.test.ts — walking skeleton expansion phase
 * swimlane 1 (L5 commit tool wrapper) contract test.
 *
 * Pins the bit-equal contract for `browser_open` wrap via `makeCommitWrapper`
 * per `docs/walking-skeleton-expansion-plan.md` §3 (30 分タイムアタック
 * template) — mechanical copy of PR #130 notification_show / PR #133
 * workspace_launch (raw shape 3a OS-level commit、windowTitleKey 省略).
 *
 * Trunk contract conformance:
 *   - L5 wrapper のみで mechanical コピー成立 (engine-perception layer 改変ゼロ)
 *   - lease 不在 commit variant (`leaseValidator` 省略、CDP connect)
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

// ── E1: browser_open wrap → L1 ToolCallStarted/Completed event 記録 ─────────

describe("expansion swimlane 1 (browser_open): wrap → L1 events recorded (lease 不在 variant)", () => {
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
      content: [{ type: "text", text: '{"ok":true,"tabs":[{"id":"abc","url":"about:blank","title":"New Tab","active":true}]}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_open", {
      l1Emitter: fakeEmitter,
    });
    const result = await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("started");
    expect(events[0].tool).toBe("browser_open");
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(events[1].tool).toBe("browser_open");
    expect(result.content).toBeDefined();
  });
});

// ── E2: include 未指定時 raw shape return (既存 raw client 互換) ─────────────

describe("expansion swimlane 1 (browser_open): include 未指定時 raw shape return", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"tabs":[]}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_open", {});
    const result = await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.tabs)).toBe(true);
  });
});

// ── E3: include=causal 経路 → caused_by.your_last_action = "browser_open(...)" ─

describe("expansion swimlane 1 (browser_open): include=causal で caused_by.your_last_action に browser_open 記録", () => {
  it("browser_open wrap → history buffer に entry → buildCausedBy で your_last_action = browser_open(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "browser_open", {
      getSessionId: () => "sessBO",
    });
    await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    const causedBy = buildCausedBy("sessBO", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("browser_open");
    expect(causedBy?.tool_call_id).toMatch(/^sessBO:\d+$/);
    const basedOn = buildBasedOn("sessBO", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

// ── E4: trunk completion contract: L5 wrapper のみで mechanical copy 成立 ────

describe("expansion swimlane 1 (browser_open): trunk completion contract — mechanical copy", () => {
  it("S5 contract が browser_open wrap でそのまま機能 (lease validator omit のみで lease 不在 variant)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "browser_open", {});
    const result = await wrapped({
      port: 9222,
    } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
  });
});
