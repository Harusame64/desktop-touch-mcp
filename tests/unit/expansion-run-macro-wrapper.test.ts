/**
 * expansion-run-macro-wrapper.test.ts — swimlane 1 (L5 commit wrapper)
 * contract test for run_macro orchestration tool.
 * Note: run_macro は TOOL_REGISTRY から除外 (recursion 防止) のため、
 * macro path test なし。L1 event 発火は orchestration boundary marker。
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

describe("expansion swimlane 1 (run_macro): wrap → L1 events recorded (lease 不在 variant)", () => {
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
      content: [{ type: "text", text: '{"steps_total":2,"steps_completed":2,"results":[]}' }],
    });
    const wrapped = makeCommitWrapper(handler, "run_macro", { l1Emitter: fakeEmitter });
    const result = await wrapped({
      steps: [{ tool: "sleep", params: { ms: 100 } }],
      stop_on_error: true,
    } as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0].tool).toBe("run_macro");
    expect(events[0].leaseToken).toBeUndefined();
    expect(events[1].kind).toBe("completed");
    expect(result.content).toBeDefined();
  });
});

describe("expansion swimlane 1 (run_macro): include 未指定時 raw shape return", () => {
  it("default 経路 → envelope shape を hoist して raw client 互換", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"steps_total":1,"steps_completed":1}' }],
    });
    const wrapped = makeCommitWrapper(handler, "run_macro", {});
    const result = await wrapped({
      steps: [{ tool: "sleep", params: { ms: 100 } }],
      stop_on_error: true,
    } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBeUndefined();
    expect(parsed.steps_total).toBe(1);
  });
});

describe("expansion swimlane 1 (run_macro): include=causal で caused_by.your_last_action に run_macro 記録", () => {
  it("run_macro wrap → history buffer に entry → buildCausedBy で your_last_action = run_macro(...)", async () => {
    resetAll();
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "run_macro", {
      getSessionId: () => "sessRM",
    });
    await wrapped({
      steps: [{ tool: "sleep", params: { ms: 100 } }],
      stop_on_error: true,
    } as Record<string, unknown>);
    const causedBy = buildCausedBy("sessRM", makeViewSnapshot());
    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toContain("run_macro");
    expect(causedBy?.tool_call_id).toMatch(/^sessRM:\d+$/);
    const basedOn = buildBasedOn("sessRM", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });
});

describe("expansion swimlane 1 (run_macro): trunk completion contract — mechanical copy", () => {
  it("S5 contract が run_macro wrap でそのまま機能 (orchestration commit pipeline)", async () => {
    resetAll();
    const handler = vi.fn(async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
    }));
    const wrapped = makeCommitWrapper(handler, "run_macro", {});
    const result = await wrapped({
      steps: [{ tool: "sleep", params: { ms: 50 } }],
      stop_on_error: true,
    } as Record<string, unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content).toBeDefined();
  });
});
