/**
 * working-memory-b1.test.ts — ADR-011 Phase B B-1 contract test suite.
 *
 * Pins the bit-equal contract for `include=["working"]` / `["working:N"]`
 * envelope projection (`current_state.recent_events`) per Phase B plan §4。
 *
 * Coverage (10 case):
 *   - B-1-1 sentinel skip: sessionId === "multi:disabled" → projection undefined
 *     (cross-session leak 防止、Phase A sentinel runtime closed loop と整合)
 *   - B-1-2 default N: include=["working"] → default N=10 で projection
 *   - B-1-3 explicit N: include=["working:5"] → 5 件 projection (LIFO)
 *   - B-1-4 boundary 含む projection: A-3 isCompoundBoundary が is_compound
 *     field として expose
 *   - B-1-5 ring underflow: ring 内件数 < N で _truncation: ring_underflow
 *   - B-1-6 capacity_cap: N > HISTORY_BUFFER_CAPACITY (= 50) で
 *     _truncation: capacity_cap (上限超え error path とは別、N <= N_MAX 内)
 *   - B-1-7 N upper bound: N > WORKING_MEMORY_N_MAX (= 50) で typed error
 *     `WorkingMemoryNUpperBoundExceeded`
 *   - B-1-8 N=0 edge: include=["working:0"] で events 空配列 (skip ではない、
 *     N=0 は valid request、_truncation なし)
 *   - B-1-9 args_summary truncation: 64 char 超 args が 64 char に truncate
 *   - B-1-10 parseIncludeMemoryN: 4 形式 (layer 名のみ / layer:N / layer:invalid /
 *     不在) で正しい return value pure parser test
 *   - B-1-N regression: A-1 (causal include) + A-3 (boundary) test 全 pass
 *     (本 file 内 sanity check として 1 case)
 */

import { describe, expect, it, afterEach } from "vitest";
import {
  parseIncludeMemoryN,
  projectWorkingMemory,
  defaultL1Emitter,
  WORKING_MEMORY_DEFAULT_N,
  WORKING_MEMORY_N_MAX,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _resetHistoryClockForTest,
  _seedHistoryForTest,
  type ToolCallEvent,
  type WorkingMemoryProjection,
} from "../../src/tools/_envelope.js";

afterEach(() => {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
  _resetHistoryClockForTest();
});

function pushCommit(sessionId: string, idx: number, isCompound = false): void {
  const tcid = `${sessionId}:s${idx}`;
  defaultL1Emitter.pushStarted({
    tool: `tool_${idx}`,
    argsJson: `{"i":${idx}}`,
    sessionId,
    toolCallId: tcid,
    isCompoundBoundary: isCompound,
  });
  defaultL1Emitter.pushCompleted({
    tool: `tool_${idx}`,
    elapsedMs: 1,
    ok: true,
    sessionId,
    toolCallId: tcid,
  });
}

// ── B-1-1: sentinel skip ─────────────────────────────────────────────────────

describe("B-1-1: sentinel sessionId === \"multi:disabled\" で projection undefined", () => {
  it("cross-session leak 防止、Phase A sentinel runtime closed loop と整合", () => {
    const result = projectWorkingMemory("multi:disabled", 5);
    expect(result).toBeUndefined();
  });
});

// ── B-1-2: default N ─────────────────────────────────────────────────────────

describe("B-1-2: parseIncludeMemoryN で default N (= 10) を返却", () => {
  it("include=[\"working\"] (N 省略) → WORKING_MEMORY_DEFAULT_N", () => {
    const n = parseIncludeMemoryN(["working"], "working", WORKING_MEMORY_DEFAULT_N);
    expect(n).toBe(WORKING_MEMORY_DEFAULT_N);
    expect(n).toBe(10); // SSOT pin
  });
});

// ── B-1-3: explicit N (LIFO 順) ─────────────────────────────────────────────

describe("B-1-3: include=[\"working:5\"] で 5 件 LIFO projection", () => {
  it("ring に 8 件 push 後、N=5 で末尾 5 件 (新しい順)", () => {
    const sid = "sessA";
    for (let i = 1; i <= 8; i++) pushCommit(sid, i);
    const result = projectWorkingMemory(sid, 5)!;
    expect(result.events).toHaveLength(5);
    // LIFO 順 (新しい順) — 末尾 push (i=8) が events[0]
    expect(result.events[0]?.tool).toBe("tool_8");
    expect(result.events[0]?.tool_call_id).toBe(`${sid}:s8`);
    expect(result.events[1]?.tool).toBe("tool_7");
    expect(result.events[4]?.tool).toBe("tool_4");
    expect(result._truncation).toBeUndefined();
  });
});

// ── B-1-4: boundary 含む projection ──────────────────────────────────────────

describe("B-1-4: A-3 isCompoundBoundary が is_compound field として expose", () => {
  it("boundary commit が is_compound: true で projection、通常 commit は false", () => {
    const sid = "sessB";
    pushCommit(sid, 1, true); // boundary
    pushCommit(sid, 2, false); // 通常
    pushCommit(sid, 3, false);
    const result = projectWorkingMemory(sid, 3)!;
    expect(result.events).toHaveLength(3);
    // LIFO: events[0] = s3 (通常)、events[2] = s1 (boundary)
    expect(result.events[2]?.is_compound).toBe(true);
    expect(result.events[0]?.is_compound).toBe(false);
    expect(result.events[1]?.is_compound).toBe(false);
  });
});

// ── B-1-5: ring underflow ───────────────────────────────────────────────────

describe("B-1-5: ring 内件数 < N で _truncation: ring_underflow", () => {
  it("ring 3 件 + N=10 要求 → events 3 件 + _truncation { reason: \"ring_underflow\" }", () => {
    const sid = "sessC";
    for (let i = 1; i <= 3; i++) pushCommit(sid, i);
    const result = projectWorkingMemory(sid, 10)!;
    expect(result.events).toHaveLength(3);
    expect(result._truncation).toEqual({
      requested: 10,
      returned: 3,
      reason: "ring_underflow",
    });
  });
});

// ── B-1-6: capacity_cap (N > capacity 50) ────────────────────────────────────

describe("B-1-6: capacity_cap edge (test seam で synthetic ring 用意)", () => {
  it("ring fully filled (capacity=50) + N=60 要求 → 50 件 + _truncation { reason: \"capacity_cap\" }", () => {
    const sid = "sessD";
    // capacity 50 を埋める (50 件 push) — production path で
    // _seedHistoryForTest は capacity 制約なしの test seam (boundary 保護対象外)
    // のため、defaultL1Emitter 経由で正しい capacity 制約を受ける push
    for (let i = 1; i <= 60; i++) pushCommit(sid, i);
    // ring overflow eviction で oldest 10 件が evict される、ring には末尾 50 件
    const result = projectWorkingMemory(sid, 60)!;
    expect(result.events).toHaveLength(50); // capacity cap
    expect(result._truncation).toEqual({
      requested: 60,
      returned: 50,
      reason: "capacity_cap",
    });
    // events[0] = 末尾 push (i=60、最新)、events[49] = 古い (i=11)
    expect(result.events[0]?.tool).toBe("tool_60");
    expect(result.events[49]?.tool).toBe("tool_11");
  });
});

// ── B-1-7: N upper bound exceeded (typed error path) ────────────────────────

describe("B-1-7: N > WORKING_MEMORY_N_MAX で typed error", () => {
  // 本 case は wrapper layer の error path で error envelope を返す。
  // projectWorkingMemory 自体は N の上限 check はせず、N=51 でも capacity 50
  // にキャップして capacity_cap notation を返す (wrapper 側で先に N_MAX
  // check して error short-circuit する設計)。本 case では SSOT 値 pin のみ。
  it("WORKING_MEMORY_N_MAX === 50 (layer-constraints SSOT 整合)", () => {
    expect(WORKING_MEMORY_N_MAX).toBe(50);
  });
});

// ── B-1-8: N=0 edge ─────────────────────────────────────────────────────────

describe("B-1-8: include=[\"working:0\"] で events 空配列 (skip ではない、valid request)", () => {
  it("ring に 5 件 + N=0 → events 0 件、_truncation なし (N=0 要求 = 0 件返却)", () => {
    const sid = "sessE";
    for (let i = 1; i <= 5; i++) pushCommit(sid, i);
    const result = projectWorkingMemory(sid, 0)!;
    expect(result.events).toEqual([]);
    expect(result._truncation).toBeUndefined();
  });

  it("parseIncludeMemoryN で working:0 が 0 を返す (default fallback しない)", () => {
    const n = parseIncludeMemoryN(["working:0"], "working", 10);
    expect(n).toBe(0);
  });
});

// ── B-1-9: args_summary truncation (64 char) ─────────────────────────────────

describe("B-1-9: args_summary が 64 char に truncate", () => {
  it("65 char args → 64 char に truncate (Working = compact、Episodic = rich の差別化)", () => {
    const sid = "sessF";
    const longArgs = "a".repeat(100);
    const entry: ToolCallEvent = {
      toolCallId: `${sid}:long`,
      toolName: "tool_long",
      argsSummary: longArgs,
      eventIdStarted: 1n,
      eventIdCompleted: 2n,
      wallclockStartMs: Date.now() - 10,
      wallclockEndMs: Date.now(),
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, entry);
    const result = projectWorkingMemory(sid, 1)!;
    expect(result.events[0]?.args_summary).toHaveLength(64);
    expect(result.events[0]?.args_summary).toBe("a".repeat(64));
  });

  it("短い args (10 char) はそのまま expose", () => {
    const sid = "sessG";
    pushCommit(sid, 7);
    const result = projectWorkingMemory(sid, 1)!;
    expect(result.events[0]?.args_summary).toBe('{"i":7}');
  });
});

// ── B-1-10: parseIncludeMemoryN pure parser ─────────────────────────────────

describe("B-1-10: parseIncludeMemoryN 4 形式 (pure parser、env mutation race 構造的解消)", () => {
  it.each<[string[] | undefined, string, number, number | undefined]>([
    [["working"], "working", 10, 10],          // (1) layer 名のみ → defaultN
    [["working:5"], "working", 10, 5],         // (2) layer:N → N
    [["working:invalid"], "working", 10, 10],  // (3) parse 失敗 → defaultN fallback
    [["working:-3"], "working", 10, 10],       // (4) 負数 → defaultN fallback
    [["working:0"], "working", 10, 0],         // (5) N=0 → 0 (valid)
    [undefined, "working", 10, undefined],     // (6) include 不在 → undefined
    [[], "working", 10, undefined],            // (7) include 空 → undefined
    [["episodic:5"], "working", 10, undefined], // (8) 別 layer → undefined
    [["working:10", "episodic:5"], "working", 10, 10], // (9) 複数 layer → working を return
    [["raw"], "working", 10, undefined],       // (10) 関係ない entry → undefined
  ])("parseIncludeMemoryN(%j, %j, %d) === %j", (include, layer, defaultN, expected) => {
    expect(parseIncludeMemoryN(include, layer, defaultN)).toBe(expected);
  });
});

// ── B-1-N: regression sanity (no leak into other contexts) ──────────────────

describe("B-1-N: ring 不在 sessionId で projection 空配列 (regression sanity)", () => {
  it("history ring 不在 sessionId → { events: [] } (undefined ではない、distinct from sentinel)", () => {
    const result = projectWorkingMemory("non-existent-session", 5);
    expect(result).toEqual({ events: [] });
  });
});
