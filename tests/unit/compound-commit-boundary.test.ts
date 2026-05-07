/**
 * compound-commit-boundary.test.ts — ADR-011 A-3 contract test suite.
 *
 * Pins the bit-equal contract for compound commit boundary preservation
 * across the per-session history ring buffer. ADR-011 plan §4.3 +
 * `docs/walking-skeleton-expansion-plan.md` §6.1 #3 + ADR-010 §11 OQ #9.
 *
 * Coverage:
 *   - A-3-1 boundary preservation: 9-step macro (1 boundary + N non-boundary
 *     step) で ring overflow 時、boundary が `evictOldestNonBoundary` に
 *     skip され、最古 step が代替 evict される
 *   - A-3-2 buildBasedOn 同型 anchor: 同 scenario で `based_on.events` が
 *     outer boundary event_id を anchor (= 最終 step ではない)
 *   - A-3-3 step ≤ capacity regression: boundary 不在 / step ≤ 8 ケースで
 *     既存挙動完全維持 (末尾 step が anchor)
 *   - A-3-4 degraded fallback: 全 entry が boundary の異常ケースで infinite
 *     loop / panic せず、`evictOldestNonBoundary` の旧 FIFO fallback で動作
 *   - A-3-5 makeCommitWrapper 伝播: `isCompoundBoundary: true` option が
 *     `l1.pushStarted` 引数に伝播 + history entry に flag set
 *   - A-3-6 in-flight boundary skip: boundary outer 未完了 (`wallclockEndMs
 *     === undefined`) ケースで `selectLastEventForCausalProjection` が
 *     完了済 step に fallback (orchestration 進行中の anchor 安全性)
 *   - A-3-7 LIFO multi-boundary: 複数完了 boundary 同時存在 (degraded
 *     fallback path) で末尾 (= 最新) boundary を anchor
 */

import { describe, expect, it } from "vitest";
import {
  buildCausedBy,
  buildBasedOn,
  defaultL1Emitter,
  makeCommitWrapper,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _resetHistoryClockForTest,
  _seedHistoryForTest,
  type CommitL1Emitter,
  type ViewSnapshot,
  type ToolCallEvent,
  type L1ToolCallStartedArgs,
} from "../../src/tools/_envelope.js";

function resetAll(): void {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
  _resetHistoryClockForTest();
}

function makeViewSnapshot(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    focus: { hwnd: null, elementName: "btn-next" },
    dirtyRectsByMonitor: new Map([[0, 1]]),
    latestEventId: 1_000_000n,
    queryWallclockMs: Date.now(),
    ...overrides,
  };
}

function pushBoundary(
  sessionId: string,
  toolCallId: string,
  toolName = "run_macro",
  argsJson = '{"steps":["s1","s2"]}',
): void {
  defaultL1Emitter.pushStarted({
    tool: toolName,
    argsJson,
    sessionId,
    toolCallId,
    isCompoundBoundary: true,
  });
}

function completeEntry(sessionId: string, toolCallId: string, ok = true): void {
  defaultL1Emitter.pushCompleted({
    tool: "irrelevant", // pushCompleted は toolCallId で entry を引く
    elapsedMs: 1,
    ok,
    sessionId,
    toolCallId,
  });
}

function pushStep(sessionId: string, toolCallId: string, idx: number): void {
  defaultL1Emitter.pushStarted({
    tool: "step_tool",
    argsJson: `{"i":${idx}}`,
    sessionId,
    toolCallId,
  });
}

// ── A-3-1: boundary preservation under ring overflow ────────────────────────

describe("A-3-1: 9-step run_macro で boundary preserved + 最古 step が evict", () => {
  it("`buildCausedBy.your_last_action` が outer run_macro event を anchor", () => {
    resetAll();
    const sid = "sessA";
    // outer run_macro boundary を最初に push + complete
    pushBoundary(sid, `${sid}:outer`, "run_macro", '{"steps":[]}');
    completeEntry(sid, `${sid}:outer`);
    // 9 step を push + complete (boundary 1 + step 9 = 10 entry、capacity 8)
    for (let i = 1; i <= 9; i++) {
      const tcid = `${sid}:s${i}`;
      pushStep(sid, tcid, i);
      completeEntry(sid, tcid);
    }
    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    // boundary 優先選択で your_last_action が outer run_macro
    expect(causedBy?.your_last_action).toContain("run_macro");
    expect(causedBy?.tool_call_id).toBe(`${sid}:outer`);
  });
});

// ── A-3-2: buildBasedOn 同型 anchor (DRY 共有ヘルパ) ────────────────────────

describe("A-3-2: buildBasedOn が boundary outer event_id を anchor", () => {
  it("based_on.events が outer run_macro の event_id を反映 (= 最終 step ではない)", () => {
    resetAll();
    const sid = "sessB";
    // boundary を seed (eventIdStarted / eventIdCompleted 固定値で識別可能に)
    const boundaryEntry: ToolCallEvent = {
      toolCallId: `${sid}:outer`,
      toolName: "run_macro",
      argsSummary: '{"steps":[]}',
      eventIdStarted: 4242n,
      eventIdCompleted: 4243n,
      wallclockStartMs: Date.now() - 100,
      wallclockEndMs: Date.now() - 50,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    _seedHistoryForTest(sid, boundaryEntry);
    // 普通の step (より新しい event_id) を後続で seed
    const stepEntry: ToolCallEvent = {
      toolCallId: `${sid}:s1`,
      toolName: "step_tool",
      argsSummary: '{"i":1}',
      eventIdStarted: 9000n,
      eventIdCompleted: 9001n,
      wallclockStartMs: Date.now() - 30,
      wallclockEndMs: Date.now() - 10,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
      // isCompoundBoundary 省略 = 通常 step
    };
    _seedHistoryForTest(sid, stepEntry);

    const basedOn = buildBasedOn(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(basedOn).toBeDefined();
    // helper 共有で causedBy / basedOn divergence 防止 — outer の eventId
    // 4242 / 4243 が anchor、最終 step の 9000 / 9001 ではない
    expect(basedOn?.events).toEqual(["4242", "4243"]);
  });
});

// ── A-3-3: regression — step ≤ capacity で既存挙動維持 ─────────────────────

describe("A-3-3: regression — boundary 不在 / step ≤ 8 で末尾 fallback", () => {
  it("通常の commit のみ 5 件 push → buildCausedBy が末尾 step を anchor (現行挙動)", () => {
    resetAll();
    const sid = "sessC";
    for (let i = 1; i <= 5; i++) {
      const tcid = `${sid}:s${i}`;
      pushStep(sid, tcid, i);
      completeEntry(sid, tcid);
    }
    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    expect(causedBy?.tool_call_id).toBe(`${sid}:s5`);
  });

  it("通常の commit のみ 9 件 push → 最古 1 件 evict、末尾 step が anchor", () => {
    resetAll();
    const sid = "sessD";
    for (let i = 1; i <= 9; i++) {
      const tcid = `${sid}:s${i}`;
      pushStep(sid, tcid, i);
      completeEntry(sid, tcid);
    }
    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    expect(causedBy?.tool_call_id).toBe(`${sid}:s9`);
  });
});

// ── A-3-4: degraded fallback — 全 entry が boundary ──────────────────────────

describe("A-3-4: degraded fallback で全 entry が boundary でも panic / 無限ループしない", () => {
  it("9 件 boundary push → 最古 boundary が旧 FIFO fallback で evict、最新 8 件保持", () => {
    resetAll();
    const sid = "sessE";
    // 9 件全て boundary として push (本 plan non-goal、現行 recursion 防止下では
    // 発生不可だが、`evictOldestNonBoundary` の degraded fallback path を pin)
    for (let i = 1; i <= 9; i++) {
      const tcid = `${sid}:b${i}`;
      pushBoundary(sid, tcid, "run_macro", `{"i":${i}}`);
      completeEntry(sid, tcid);
    }
    // 最古 boundary `${sid}:b1` は旧 FIFO で evict、最新 boundary `${sid}:b9`
    // が anchor (selectLastEventForCausalProjection の LIFO 採用)
    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    expect(causedBy?.tool_call_id).toBe(`${sid}:b9`);
  });
});

// ── A-3-5: makeCommitWrapper 経由 isCompoundBoundary 伝播 ───────────────────

describe("A-3-5: makeCommitWrapper で isCompoundBoundary が l1.pushStarted に伝播", () => {
  it("options.isCompoundBoundary:true → fake emitter pushStarted args に flag", async () => {
    resetAll();
    const captured: L1ToolCallStartedArgs[] = [];
    const fakeEmitter: CommitL1Emitter = {
      pushStarted(args) {
        captured.push(args);
      },
      pushCompleted() {
        // no-op
      },
    };
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "run_macro", {
      getSessionId: () => "sessF",
      l1Emitter: fakeEmitter,
      isCompoundBoundary: true,
    });
    await wrapped({} as Record<string, unknown>);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tool).toBe("run_macro");
    expect(captured[0]?.isCompoundBoundary).toBe(true);
  });

  it("options.isCompoundBoundary 省略 → flag は undefined (boundary でない、regression なし)", async () => {
    resetAll();
    const captured: L1ToolCallStartedArgs[] = [];
    const fakeEmitter: CommitL1Emitter = {
      pushStarted(args) {
        captured.push(args);
      },
      pushCompleted() {
        // no-op
      },
    };
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeCommitWrapper(handler, "mouse_click", {
      getSessionId: () => "sessG",
      l1Emitter: fakeEmitter,
      // isCompoundBoundary 省略 = 通常 commit
    });
    await wrapped({} as Record<string, unknown>);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.isCompoundBoundary).toBeUndefined();
  });
});

// ── A-3-6: in-flight boundary skip ─────────────────────────────────────────

describe("A-3-6: outer boundary 未完了 + step 後続で完了済 step に fallback", () => {
  it("boundary wallclockEndMs undefined → 完了済 step を anchor (orchestration 進行中の安全性)", () => {
    resetAll();
    const sid = "sessH";
    // outer boundary push のみ (complete しない = 進行中)
    const inflightBoundary: ToolCallEvent = {
      toolCallId: `${sid}:outer`,
      toolName: "run_macro",
      argsSummary: '{"steps":[]}',
      eventIdStarted: 100n,
      eventIdCompleted: undefined,
      wallclockStartMs: Date.now() - 50,
      wallclockEndMs: undefined,
      monotonicStartMs: performance.now(),
      ok: undefined,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    _seedHistoryForTest(sid, inflightBoundary);
    // step を完了済で push
    const completedStep: ToolCallEvent = {
      toolCallId: `${sid}:s1`,
      toolName: "step_tool",
      argsSummary: '{"i":1}',
      eventIdStarted: 200n,
      eventIdCompleted: 201n,
      wallclockStartMs: Date.now() - 30,
      wallclockEndMs: Date.now() - 10,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, completedStep);

    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    // 完了済 boundary が無い → 末尾 fallback (= 完了済 step)
    expect(causedBy?.tool_call_id).toBe(`${sid}:s1`);
  });
});

// ── A-3-7: LIFO multi-boundary (degraded path) ──────────────────────────────

describe("A-3-7: 複数完了 boundary 同時存在で末尾 (= 最新) boundary を anchor", () => {
  it("boundary 2 件完了 + step 1 件 → 末尾 boundary を anchor (causal continuity)", () => {
    resetAll();
    const sid = "sessI";
    const oldBoundary: ToolCallEvent = {
      toolCallId: `${sid}:b1`,
      toolName: "run_macro",
      argsSummary: '{"i":1}',
      eventIdStarted: 1n,
      eventIdCompleted: 2n,
      wallclockStartMs: Date.now() - 200,
      wallclockEndMs: Date.now() - 180,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    const newerBoundary: ToolCallEvent = {
      toolCallId: `${sid}:b2`,
      toolName: "run_macro",
      argsSummary: '{"i":2}',
      eventIdStarted: 3n,
      eventIdCompleted: 4n,
      wallclockStartMs: Date.now() - 100,
      wallclockEndMs: Date.now() - 80,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    const trailingStep: ToolCallEvent = {
      toolCallId: `${sid}:s1`,
      toolName: "step_tool",
      argsSummary: '{"i":1}',
      eventIdStarted: 5n,
      eventIdCompleted: 6n,
      wallclockStartMs: Date.now() - 30,
      wallclockEndMs: Date.now() - 10,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, oldBoundary);
    _seedHistoryForTest(sid, newerBoundary);
    _seedHistoryForTest(sid, trailingStep);

    // P3-1 (Round 1 Opus): monotonic timeout (default 200ms) flake 軽減 —
    // slow CI で push N 件後の Date.now() delta が 200ms 超過すると
    // boundary が undefined return される。長 timeout で structural pin。
    const causedBy = buildCausedBy(sid, makeViewSnapshot(), { causalWindowTimeoutMs: 60_000 });
    expect(causedBy).toBeDefined();
    // LIFO: 末尾 boundary (b2) が anchor、b1 ではない、trailing step でもない
    expect(causedBy?.tool_call_id).toBe(`${sid}:b2`);
  });
});
