/**
 * compound-commit-boundary.test.ts — ADR-011 A-3 contract test suite.
 *
 * Pins the bit-equal contract for compound commit boundary preservation
 * across the per-session history ring buffer. ADR-011 plan §4.3 +
 * `docs/walking-skeleton-expansion-plan.md` §6.1 #3 + ADR-010 §11 OQ #9.
 *
 * Coverage:
 *   - A-3-1 boundary preservation: 51-step macro (1 boundary + 51 step、
 *     capacity 50 ring overflow trigger) で boundary が
 *     `evictOldestNonBoundary` に skip され、最古 step が代替 evict される
 *     (Round 1 Opus P1-2 反映、capacity 8 → 50 拡張対応)
 *   - A-3-2 buildBasedOn 同型 anchor: 同 scenario で `based_on.events` が
 *     outer boundary event_id を anchor (= 最終 step ではない)
 *   - A-3-3 step ≤ capacity regression: boundary 不在 / step ≤ 50 ケースで
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

describe("A-3-1: 9-step run_macro で boundary preserved + outer が anchor (capacity 50 内 overflow なし、B-1 land 後)", () => {
  it("`buildCausedBy.your_last_action` が outer run_macro event を anchor (B-1 land で capacity 8 → 50 拡張、9 件では overflow せず boundary 優先 LIFO 選択を pin)", () => {
    resetAll();
    const sid = "sessA";
    // outer run_macro boundary を最初に push + complete
    pushBoundary(sid, `${sid}:outer`, "run_macro", '{"steps":[]}');
    completeEntry(sid, `${sid}:outer`);
    // 9 step を push + complete (boundary 1 + step 9 = 10 entry、capacity 50 内
    // で overflow なし)。本 test は **selectLastEventForCausalProjection の
    // boundary 優先 LIFO 選択**を pin、overflow 機械検証ではない。capacity 50
    // ring overflow 契約は B-1 land 後 `tests/unit/working-memory-b1.test.ts`
    // B-1-6 (60 件 push capacity_cap notation) で別軸機械検証 (Round 1 Opus
    // P1-2 反映、51 件 push に変更すると nativeL1 production binding 経由で
    // eventIdHighWater が進み、後続 test の frontier check に副作用が出る
    // ため 9 件 push 維持)。
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

describe("A-3-3: regression — boundary 不在 / step ≤ 50 で末尾 fallback (B-1 capacity 50)", () => {
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

  it("通常の commit のみ 9 件 push → 末尾 step が anchor (capacity 50 内、overflow なし、boundary 不在 regression pin)", () => {
    // B-1 land で capacity 8 → 50 拡張、9 件 push では ring overflow 発生せず。
    // 本 case は **boundary 不在 + ring 内全件保持** のケースで末尾 step
    // が anchor になる挙動を pin (旧 capacity 8 時代の「最古 1 件 evict」
    // 検証は capacity 50 では機械検証不能、別 test で 51 件 push 経路を pin)。
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
  it("9 件 boundary push (capacity 50 内 overflow なし) → 末尾 boundary が anchor (LIFO 選択 pin)", () => {
    // B-1 land で capacity 50 拡張採用後、9 件 boundary では overflow せず
    // ring 全保持。本 case は `selectLastEventForCausalProjection` の **LIFO
    // で末尾 boundary を anchor 選択** する経路を pin、`evictOldestNonBoundary`
    // 旧 FIFO fallback の機械検証ではない。
    //
    // 全 entry が boundary の異常ケース (現行 recursion 防止下では発生不可、
    // 本 plan non-goal)。capacity 50 内で 51 件 push する degraded fallback
    // overflow 検証は **51 件 push が nativeL1 production binding 経由で
    // eventIdHighWater 副作用を出すため別 test seam で対応** (本 test では
    // 9 件で LIFO 選択 contract のみ pin、Round 1 Opus P1-2 反映)。
    resetAll();
    const sid = "sessE";
    for (let i = 1; i <= 9; i++) {
      const tcid = `${sid}:b${i}`;
      pushBoundary(sid, tcid, "run_macro", `{"i":${i}}`);
      completeEntry(sid, tcid);
    }
    // 全 9 件 boundary preserved、末尾 boundary `${sid}:b9` が anchor
    // (selectLastEventForCausalProjection の LIFO 採用)。
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

// ── A-3-A4-stale-shadow: A-4 retrospective fix (Codex P1 #1、PR #157 follow-up) ─

describe("A-3-A4-stale-shadow: timeout 切れ boundary が末尾通常 commit を shadow しない", () => {
  // Codex Round 1 P1 (A-4 retrospective、PR #157 follow-up):
  // selectLastEventForCausalProjection が完了済 boundary を常に LIFO 優先採用
  // していたため、boundary が causal window timeout (200ms) を超えた状態で
  // ring 末尾に新しい通常 commit が居ても、buildCausedBy が boundary を
  // anchor にして timeout 切れで undefined return → **末尾 commit の causal
  // projection が shadow されて消失** する runtime regression。
  //
  // 修正後挙動: boundary が timeout 切れの場合は末尾 fallback、通常 commit
  // が causal window 内なら projection 維持。
  it("timeout 切れ boundary + ring 末尾の新しい通常 commit → 通常 commit を anchor、causal projection 維持", () => {
    _resetHistoryBuffersForTest();
    _resetToolCallSeqForTest();
    const sid = "sessStaleA4";
    // boundary B (timeout 切れ): monotonicStartMs を現在から 5000ms 過去に設定
    const staleBoundary: ToolCallEvent = {
      toolCallId: `${sid}:outer`,
      toolName: "run_macro",
      argsSummary: '{"steps":[]}',
      eventIdStarted: 1n,
      eventIdCompleted: 2n,
      wallclockStartMs: Date.now() - 5000,
      wallclockEndMs: Date.now() - 4900,
      monotonicStartMs: performance.now() - 5000,
      ok: true,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    // 通常 commit C (causal window 内): monotonicStartMs を現在に近く
    const freshCommit: ToolCallEvent = {
      toolCallId: `${sid}:c1`,
      toolName: "mouse_click",
      argsSummary: '{"x":100}',
      eventIdStarted: 3n,
      eventIdCompleted: 4n,
      wallclockStartMs: Date.now() - 10,
      wallclockEndMs: Date.now() - 5,
      monotonicStartMs: performance.now() - 10,
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, staleBoundary);
    _seedHistoryForTest(sid, freshCommit);

    // default timeout 200ms で実行
    const causedBy = buildCausedBy(sid, makeViewSnapshot());
    // boundary は timeout 切れで anchor から外れ、末尾通常 commit C が anchor
    expect(causedBy).toBeDefined();
    expect(causedBy?.tool_call_id).toBe(`${sid}:c1`);
    expect(causedBy?.your_last_action).toContain("mouse_click");

    // buildBasedOn も同型 (helper DRY 共有、divergence なし)
    const basedOn = buildBasedOn(sid, makeViewSnapshot());
    expect(basedOn).toBeDefined();
    expect(basedOn?.events).toEqual(["3", "4"]); // C の event_id
  });

  it("boundary が timeout 内 → boundary 優先 LIFO 維持 (regression 防止、A-3-1/A-3-2 既存挙動)", () => {
    _resetHistoryBuffersForTest();
    _resetToolCallSeqForTest();
    const sid = "sessFreshA4";
    const freshBoundary: ToolCallEvent = {
      toolCallId: `${sid}:outer`,
      toolName: "run_macro",
      argsSummary: '{"steps":[]}',
      eventIdStarted: 1n,
      eventIdCompleted: 2n,
      wallclockStartMs: Date.now() - 50,
      wallclockEndMs: Date.now() - 30,
      monotonicStartMs: performance.now() - 50, // timeout 内
      ok: true,
      leaseToken: undefined,
      isCompoundBoundary: true,
    };
    const trailingStep: ToolCallEvent = {
      toolCallId: `${sid}:s1`,
      toolName: "mouse_click",
      argsSummary: '{"x":100}',
      eventIdStarted: 3n,
      eventIdCompleted: 4n,
      wallclockStartMs: Date.now() - 10,
      wallclockEndMs: Date.now() - 5,
      monotonicStartMs: performance.now() - 10,
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, freshBoundary);
    _seedHistoryForTest(sid, trailingStep);

    const causedBy = buildCausedBy(sid, makeViewSnapshot());
    // boundary timeout 内 → LIFO 優先で boundary を anchor (A-3 既存挙動維持)
    expect(causedBy).toBeDefined();
    expect(causedBy?.tool_call_id).toBe(`${sid}:outer`);
  });
});
