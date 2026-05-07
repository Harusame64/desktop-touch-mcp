/**
 * episodic-memory-b2.test.ts — ADR-011 Phase B B-2 contract test suite.
 *
 * Pins the bit-equal contract for `include=["episodic"]` / `["episodic:N"]`
 * envelope projection (`tool_call_history.episodes`、rich shape) per Phase
 * B plan §5。
 *
 * Coverage:
 *   - B-2-1 sentinel skip: sessionId === "multi:disabled" → projection undefined
 *   - B-2-2 default N: include=["episodic"] → default N=5 で projection
 *   - B-2-3 explicit N (LIFO): 完了済 entry を末尾優先で抽出
 *   - B-2-4 in-flight skip: ok undefined / wallclockEndMs undefined entry を skip
 *   - B-2-5 boundary 含む projection: A-3 isCompoundBoundary が is_compound field
 *   - B-2-6 ring underflow: 完了済 < N で _truncation: ring_underflow
 *   - B-2-7 capacity_cap: N > capacity (50) で _truncation: capacity_cap
 *   - B-2-8 N upper bound: N > 100 で typed error EpisodicMemoryNUpperBoundExceeded
 *   - B-2-9 N=0 edge: N=0 で episodes 空配列 (skip ではない、valid request)
 *   - B-2-10 args_summary truncation: 512 char 超 args が 512 char に truncate
 *   - B-2-11 lease_token_summary format: `entityId/viewId@gen#digest8` compact
 *   - B-2-12 event_id u64 decimal string: bigint → String() で JSON.stringify safe
 *   - B-2-Wrapper-1: makeQueryWrapper 経由 envelope.tool_call_history inject
 *   - B-2-Wrapper-2: typed error path で try_next 3 件 SUGGESTS wired
 *   - B-2-Cross-session: sessionA / sessionB 並走 isolation
 *   - B-2-Sentinel-skip: sentinel sessionId で commit 経由 history 不在 (A-4 整合)
 */

import { describe, expect, it, afterEach } from "vitest";
import {
  parseIncludeMemoryN,
  projectEpisodicMemory,
  defaultL1Emitter,
  makeQueryWrapper,
  genericQueryCausedByProjector,
  EPISODIC_MEMORY_DEFAULT_N,
  EPISODIC_MEMORY_N_MAX,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _resetHistoryClockForTest,
  _seedHistoryForTest,
  type ToolCallEvent,
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

// ── B-2-1: sentinel skip ────────────────────────────────────────────────────

describe("B-2-1: sentinel sessionId === \"multi:disabled\" で projection undefined", () => {
  it("cross-session leak 防止、A-2 sentinel runtime closed loop と整合", () => {
    const result = projectEpisodicMemory("multi:disabled", 5);
    expect(result).toBeUndefined();
  });
});

// ── B-2-2: default N ────────────────────────────────────────────────────────

describe("B-2-2: parseIncludeMemoryN で default N=5 を返却", () => {
  it("include=[\"episodic\"] (N 省略) → EPISODIC_MEMORY_DEFAULT_N", () => {
    const n = parseIncludeMemoryN(["episodic"], "episodic", EPISODIC_MEMORY_DEFAULT_N);
    expect(n).toBe(EPISODIC_MEMORY_DEFAULT_N);
    expect(n).toBe(5); // SSOT pin
  });
});

// ── B-2-3: explicit N (LIFO 順) + rich shape ────────────────────────────────

describe("B-2-3: include=[\"episodic:3\"] で 3 件 LIFO projection (rich shape)", () => {
  it("ring に 5 件 push、N=3 で末尾 3 件 (新しい順)、completed only", () => {
    const sid = "sessA";
    for (let i = 1; i <= 5; i++) pushCommit(sid, i);
    const result = projectEpisodicMemory(sid, 3)!;
    expect(result.episodes).toHaveLength(3);
    expect(result.episodes[0]?.tool).toBe("tool_5"); // LIFO 末尾
    expect(result.episodes[2]?.tool).toBe("tool_3");
    // rich shape field の存在 pin
    expect(result.episodes[0]?.tool_call_id).toBe(`${sid}:s5`);
    expect(typeof result.episodes[0]?.started_at_ms).toBe("number");
    expect(typeof result.episodes[0]?.elapsed_ms).toBe("number");
    expect(result.episodes[0]?.ok).toBe(true);
    expect(result._truncation).toBeUndefined();
  });
});

// ── B-2-4: in-flight skip (completed only) ──────────────────────────────────

describe("B-2-4: in-flight entry (ok=undefined / wallclockEndMs=undefined) を skip", () => {
  it("3 件完了 + 1 件 in-flight push → episodes は完了済 3 件のみ", () => {
    const sid = "sessB";
    // 完了済 3 件
    for (let i = 1; i <= 3; i++) pushCommit(sid, i);
    // in-flight (pushStarted のみ、pushCompleted せず)
    defaultL1Emitter.pushStarted({
      tool: "tool_inflight",
      argsJson: '{"in_flight":true}',
      sessionId: sid,
      toolCallId: `${sid}:inflight`,
    });

    const result = projectEpisodicMemory(sid, 5)!;
    // completed 3 件のみ、in-flight 1 件は skip
    expect(result.episodes).toHaveLength(3);
    for (const ep of result.episodes) {
      expect(ep.ok).toBe(true);
      expect(typeof ep.elapsed_ms).toBe("number");
      expect(ep.tool_call_id).not.toContain("inflight");
    }
    // ring 4 件のうち完了済 3 件のみ → ring_underflow (5 要求に対し 3 返却)
    expect(result._truncation).toEqual({
      requested: 5,
      returned: 3,
      reason: "ring_underflow",
    });
  });
});

// ── B-2-5: boundary 含む projection ─────────────────────────────────────────

describe("B-2-5: A-3 isCompoundBoundary が is_compound field として expose", () => {
  it("boundary commit が is_compound: true、通常 commit は false", () => {
    const sid = "sessC";
    pushCommit(sid, 1, true); // boundary
    pushCommit(sid, 2, false);
    pushCommit(sid, 3, false);
    const result = projectEpisodicMemory(sid, 3)!;
    expect(result.episodes).toHaveLength(3);
    expect(result.episodes[2]?.is_compound).toBe(true); // s1 (LIFO で末尾)
    expect(result.episodes[0]?.is_compound).toBe(false); // s3
    expect(result.episodes[1]?.is_compound).toBe(false);
  });
});

// ── B-2-6: ring underflow (件数不足) ────────────────────────────────────────

describe("B-2-6: ring 内完了済 < N で _truncation: ring_underflow", () => {
  it("完了 2 件 + N=10 要求 → episodes 2 件 + _truncation { reason: ring_underflow }", () => {
    const sid = "sessD";
    for (let i = 1; i <= 2; i++) pushCommit(sid, i);
    const result = projectEpisodicMemory(sid, 10)!;
    expect(result.episodes).toHaveLength(2);
    expect(result._truncation).toEqual({
      requested: 10,
      returned: 2,
      reason: "ring_underflow",
    });
  });
});

// ── B-2-7: capacity_cap (N > capacity 50) ──────────────────────────────────

describe("B-2-7: N > HISTORY_BUFFER_CAPACITY (50) で _truncation: capacity_cap", () => {
  it("ring 50 件埋め + N=80 要求 → episodes 50 件 + _truncation { reason: capacity_cap }", () => {
    const sid = "sessE";
    for (let i = 1; i <= 60; i++) pushCommit(sid, i); // overflow で末尾 50 件保持
    const result = projectEpisodicMemory(sid, 80)!; // N=80 > capacity 50
    expect(result.episodes).toHaveLength(50);
    expect(result._truncation).toEqual({
      requested: 80,
      returned: 50,
      reason: "capacity_cap",
    });
  });
});

// ── B-2-8: N upper bound (SSOT pin) ─────────────────────────────────────────

describe("B-2-8: EPISODIC_MEMORY_N_MAX SSOT pin (= 100、layer-constraints §5 整合)", () => {
  it("EPISODIC_MEMORY_N_MAX === 100", () => {
    expect(EPISODIC_MEMORY_N_MAX).toBe(100);
  });
});

// ── B-2-9: N=0 edge ─────────────────────────────────────────────────────────

describe("B-2-9: N=0 で episodes 空配列 (valid request、skip ではない)", () => {
  it("ring 5 件 + N=0 → episodes 0 件、_truncation なし", () => {
    const sid = "sessF";
    for (let i = 1; i <= 5; i++) pushCommit(sid, i);
    const result = projectEpisodicMemory(sid, 0)!;
    expect(result.episodes).toEqual([]);
    expect(result._truncation).toBeUndefined();
  });
});

// ── B-2-10: args_summary truncation (512 char) ──────────────────────────────

describe("B-2-10: args_summary 512 char truncate (Working 64 char より rich)", () => {
  it("600 char args → 512 char に truncate", () => {
    const sid = "sessG";
    const longArgs = "x".repeat(600);
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
    const result = projectEpisodicMemory(sid, 1)!;
    expect(result.episodes[0]?.args_summary).toHaveLength(512);
    expect(result.episodes[0]?.args_summary).toBe("x".repeat(512));
  });
});

// ── B-2-11: lease_token_summary format ──────────────────────────────────────

describe("B-2-11: lease_token_summary が `entityId/viewId@gen#digest8` compact format", () => {
  it("lease token あり → compact string、なし → field 省略", () => {
    const sid = "sessH";
    // lease token 付き entry
    const withLease: ToolCallEvent = {
      toolCallId: `${sid}:lease`,
      toolName: "desktop_act",
      argsSummary: '{"action":"click"}',
      eventIdStarted: 1n,
      eventIdCompleted: 2n,
      wallclockStartMs: Date.now() - 10,
      wallclockEndMs: Date.now() - 5,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: {
        entityId: "elem-123",
        viewId: "view-abc",
        targetGeneration: "42",
        evidenceDigestPrefix8: "deadbeef",
      },
    };
    // lease token なし entry
    const noLease: ToolCallEvent = {
      toolCallId: `${sid}:nolease`,
      toolName: "mouse_click",
      argsSummary: '{"x":100}',
      eventIdStarted: 3n,
      eventIdCompleted: 4n,
      wallclockStartMs: Date.now() - 30,
      wallclockEndMs: Date.now() - 25,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, withLease);
    _seedHistoryForTest(sid, noLease);
    const result = projectEpisodicMemory(sid, 2)!;
    expect(result.episodes).toHaveLength(2);
    // LIFO: episodes[0] = noLease (末尾)、episodes[1] = withLease
    expect(result.episodes[0]?.lease_token_summary).toBeUndefined();
    expect(result.episodes[1]?.lease_token_summary).toBe("elem-123/view-abc@42#deadbeef");
  });
});

// ── B-2-12: event_id u64 decimal string (JSON.stringify safe) ───────────────

describe("B-2-12: event_id_started/completed が u64 decimal string (Phase A bigint→string SSOT)", () => {
  it("bigint event_id → String() で expose、JSON.stringify safe", () => {
    const sid = "sessI";
    const bigEventId = 18446744073709551000n; // u64 close to max (> Number.MAX_SAFE_INTEGER)
    const entry: ToolCallEvent = {
      toolCallId: `${sid}:big`,
      toolName: "tool_big",
      argsSummary: '{"big":true}',
      eventIdStarted: bigEventId,
      eventIdCompleted: bigEventId + 1n,
      wallclockStartMs: Date.now() - 10,
      wallclockEndMs: Date.now() - 5,
      monotonicStartMs: performance.now(),
      ok: true,
      leaseToken: undefined,
    };
    _seedHistoryForTest(sid, entry);
    const result = projectEpisodicMemory(sid, 1)!;
    const ep = result.episodes[0];
    expect(typeof ep?.event_id_started).toBe("string");
    expect(ep?.event_id_started).toBe("18446744073709551000");
    expect(ep?.event_id_completed).toBe("18446744073709551001");
    // JSON.stringify safe (bigint だと TypeError)
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// ── B-2-Wrapper-1: makeQueryWrapper end-to-end ──────────────────────────────

describe("B-2-Wrapper-1: makeQueryWrapper 経由 envelope.tool_call_history inject", () => {
  it("include=[\"episodic:3\"] → envelope.tool_call_history.episodes に 3 件 inject", async () => {
    const sid = "sessW";
    for (let i = 1; i <= 3; i++) pushCommit(sid, i);
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["episodic:3"] } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.tool_call_history).toBeDefined();
    expect(parsed?.tool_call_history?.episodes).toHaveLength(3);
    expect(parsed?.tool_call_history?.episodes?.[0]?.tool).toBe("tool_3"); // LIFO
    expect(parsed?.tool_call_history?._truncation).toBeUndefined();
  });

  it("include=[\"working:2\",\"episodic:2\"] → 両 layer projection 同居 (current_state + tool_call_history)", async () => {
    const sid = "sessWE";
    for (let i = 1; i <= 3; i++) pushCommit(sid, i);
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({
      include: ["working:2", "episodic:2"],
    } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    // Working = compact (5 field)
    expect(parsed?.current_state?.recent_events).toHaveLength(2);
    // Episodic = rich (rich shape field 含む)
    expect(parsed?.tool_call_history?.episodes).toHaveLength(2);
    expect(typeof parsed?.tool_call_history?.episodes?.[0]?.started_at_ms).toBe("number");
    expect(typeof parsed?.tool_call_history?.episodes?.[0]?.elapsed_ms).toBe("number");
  });
});

// ── B-2-Wrapper-2: typed error path で try_next wired ───────────────────────

describe("B-2-Wrapper-2: N > 100 で typed error EpisodicMemoryNUpperBoundExceeded + try_next 3 件", () => {
  it("include=[\"episodic:101\"] → typed error + try_next 3 件 (SUGGESTS wired)", async () => {
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => "sessErr",
    });
    const result = await wrapped({ include: ["episodic:101"] } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.if_unexpected?.most_likely_cause).toBe("EpisodicMemoryNUpperBoundExceeded");
    expect(Array.isArray(parsed?.if_unexpected?.try_next)).toBe(true);
    expect(parsed?.if_unexpected?.try_next).toHaveLength(3);
    for (const tn of parsed.if_unexpected.try_next) {
      expect(typeof tn?.action).toBe("string");
      expect(tn.action.length).toBeGreaterThan(0);
    }
  });
});

// ── B-2-Cross-session: sessionA / sessionB 並走 isolation ───────────────────

describe("B-2-Cross-session: sessionA / sessionB 並走 projection 分離", () => {
  it("session 別 ring で projection が混ざらない", () => {
    for (let i = 1; i <= 2; i++) pushCommit("sessA", i);
    for (let i = 1; i <= 4; i++) pushCommit("sessB", i);
    const a = projectEpisodicMemory("sessA", 10)!;
    const b = projectEpisodicMemory("sessB", 10)!;
    expect(a.episodes).toHaveLength(2);
    expect(b.episodes).toHaveLength(4);
    for (const e of a.episodes) expect(e.tool_call_id.startsWith("sessA:")).toBe(true);
    for (const e of b.episodes) expect(e.tool_call_id.startsWith("sessB:")).toBe(true);
  });
});

// ── B-2-Sentinel-skip: A-4 sentinel skip 一貫性 ─────────────────────────────

describe("B-2-Sentinel-skip: sentinel sessionId 配下では Episodic projection も undefined", () => {
  it("sentinel ring に entry 不在 (A-4 hotfix sentinel skip 一貫性、commit 経路でも history 不在)", () => {
    // sentinel ring に commit が記録されないことが A-4 で保証されているため、
    // projectEpisodicMemory("multi:disabled", N) は B-2-1 と同じ undefined return
    expect(projectEpisodicMemory("multi:disabled", 5)).toBeUndefined();
  });
});

// ── B-2-N: regression sanity ────────────────────────────────────────────────

describe("B-2-N: ring 不在 sessionId で projection 空配列", () => {
  it("history ring 不在 sessionId → { episodes: [] }", () => {
    const result = projectEpisodicMemory("non-existent-session", 5);
    expect(result).toEqual({ episodes: [] });
  });
});
