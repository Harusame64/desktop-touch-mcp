/**
 * semantic-memory-b3.test.ts — ADR-011 Phase B B-3 contract test suite.
 *
 * Pins the bit-equal contract for `include=["semantic"]` / `["semantic:K"]`
 * envelope projection (`learned_ui_pattern.patterns`) per Phase B plan §6。
 *
 * Coverage (16 case):
 *   - B-3-1 sentinel skip: sessionId === "multi:disabled" → projection undefined
 *   - B-3-2 default K: include=["semantic"] → default K=3
 *   - B-3-3 rule-based 抽出: 同 windowTitle 連続 3+ ok=true → 1 pattern
 *   - B-3-4 windowTitle 変化で run reset
 *   - B-3-5 ok=false で run 中断 (failed run は pattern 化しない)
 *   - B-3-6 windowTitle undefined entry skip (window 不明 = run 中断)
 *   - B-3-7 minStepCount 未満は pattern 化しない
 *   - B-3-8 ring 末尾 run も拾う
 *   - B-3-9 pattern dedupe (同 fingerprint で count merge + last_seen update)
 *   - B-3-10 LRU eviction (capacity 超過で oldest evict)
 *   - B-3-11 K upper bound: K > 10 で typed error + try_next 3 件
 *   - B-3-12 K=0 edge → patterns: [] empty
 *   - B-3-13 _truncation: ring_underflow / capacity_cap
 *   - B-3-14 wrapper end-to-end: envelope.learned_ui_pattern inject
 *   - B-3-15 cross-session: sessionA / sessionB 並走 (pattern store は global LRU だが session-scoped pattern_id 設計)
 *   - B-3-16 env parser pure (parseMemoryPersistMode / parseMemoryRedactMode 4 case it.each)
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  parseIncludeMemoryN,
  extractSemanticPatterns,
  projectSemanticMemory,
  defaultL1Emitter,
  makeQueryWrapper,
  SEMANTIC_MEMORY_DEFAULT_K,
  SEMANTIC_MEMORY_K_MAX,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _resetHistoryClockForTest,
  _setHistoryClockForTest,
  type ToolCallEvent,
  type UiPatternRecord,
} from "../../src/tools/_envelope.js";
import {
  uiPatternStore,
  parseMemoryPersistMode,
  parseMemoryRedactMode,
} from "../../src/store/ui-pattern-store.js";

afterEach(() => {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
  _resetHistoryClockForTest();
  uiPatternStore._resetForTest();
  uiPatternStore._setCapacityForTest(100); // restore default
});

beforeEach(() => {
  uiPatternStore._resetForTest();
});

function makeEvent(
  toolCallId: string,
  toolName: string,
  windowTitle: string | undefined,
  ok: boolean | undefined = true,
  wallclockEndMs: number | undefined = Date.now(),
): ToolCallEvent {
  return {
    toolCallId,
    toolName,
    argsSummary: `{"tcid":"${toolCallId}"}`,
    eventIdStarted: 1n,
    eventIdCompleted: 2n,
    wallclockStartMs: Date.now() - 10,
    wallclockEndMs,
    monotonicStartMs: performance.now(),
    ok,
    leaseToken: undefined,
    windowTitle,
  };
}

// ── B-3-1: sentinel skip ────────────────────────────────────────────────────

describe("B-3-1: sentinel sessionId === \"multi:disabled\" で projection undefined", () => {
  it("cross-session leak 防止、A-2 sentinel runtime closed loop と整合", () => {
    const result = projectSemanticMemory("multi:disabled", 3, uiPatternStore);
    expect(result).toBeUndefined();
  });
});

// ── B-3-2: default K ────────────────────────────────────────────────────────

describe("B-3-2: parseIncludeMemoryN で default K=3", () => {
  it("include=[\"semantic\"] (K 省略) → SEMANTIC_MEMORY_DEFAULT_K", () => {
    const k = parseIncludeMemoryN(["semantic"], "semantic", SEMANTIC_MEMORY_DEFAULT_K);
    expect(k).toBe(SEMANTIC_MEMORY_DEFAULT_K);
    expect(k).toBe(3); // SSOT pin
  });
});

// ── B-3-3: rule-based 抽出 (同 windowTitle 連続 3+ ok=true) ──────────────────

describe("B-3-3: 同 windowTitle 連続 3+ commit ok=true → 1 pattern 抽出", () => {
  it("Notepad で 3 連続成功 → 1 pattern", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
      makeEvent("s:3", "keyboard", "Notepad"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.window_title).toBe("Notepad");
    expect(patterns[0]?.step_count).toBe(3);
    expect(patterns[0]?.success_count).toBe(3);
    expect(patterns[0]?.failure_count).toBe(0);
    // example_actions は frequency 順 (keyboard 2 + focus_window 1)
    expect(patterns[0]?.example_actions[0]).toBe("keyboard");
    expect(patterns[0]?.example_actions).toContain("focus_window");
  });
});

// ── B-3-4: windowTitle 変化で run reset ─────────────────────────────────────

describe("B-3-4: windowTitle 変化で run reset、別 pattern として記録", () => {
  it("Notepad 3 連続 + Chrome 3 連続 → 2 pattern", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
      makeEvent("s:3", "keyboard", "Notepad"),
      makeEvent("s:4", "focus_window", "Chrome"),
      makeEvent("s:5", "keyboard", "Chrome"),
      makeEvent("s:6", "browser_navigate", "Chrome"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.window_title).toBe("Notepad");
    expect(patterns[1]?.window_title).toBe("Chrome");
  });
});

// ── B-3-5: ok=false で run 中断 (failed run は pattern 化しない) ─────────────

describe("B-3-5: ok=false で run 中断、failed run は pattern 化しない", () => {
  it("3 連続成功 + 1 失敗 + 2 連続成功 → 1 pattern (前半 3 件のみ)", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
      makeEvent("s:3", "keyboard", "Notepad"),
      makeEvent("s:4", "click_element", "Notepad", false), // failure
      makeEvent("s:5", "keyboard", "Notepad"),
      makeEvent("s:6", "keyboard", "Notepad"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.step_count).toBe(3); // 前半 3 件のみ
    expect(patterns[0]?.success_count).toBe(3);
  });
});

// ── B-3-6: windowTitle undefined entry skip ────────────────────────────────

describe("B-3-6: windowTitle undefined entry で run 中断 (window 不明 = pattern 化不能)", () => {
  it("3 連続成功 + windowTitle 不明 1 件 + 3 連続成功 → 2 pattern", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
      makeEvent("s:3", "keyboard", "Notepad"),
      makeEvent("s:4", "tool_x", undefined),
      makeEvent("s:5", "focus_window", "Chrome"),
      makeEvent("s:6", "keyboard", "Chrome"),
      makeEvent("s:7", "keyboard", "Chrome"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.window_title).toBe("Notepad");
    expect(patterns[1]?.window_title).toBe("Chrome");
  });
});

// ── B-3-7: minStepCount 未満は pattern 化しない ─────────────────────────────

describe("B-3-7: minStepCount (default 3) 未満の run は pattern 化しない", () => {
  it("Notepad 2 連続のみ → patterns: [] (3 未満)", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toEqual([]);
  });

  it("minStepCount=2 で 2 連続も pattern 化", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Notepad"),
      makeEvent("s:2", "keyboard", "Notepad"),
    ];
    const patterns = extractSemanticPatterns(events, { minStepCount: 2 });
    expect(patterns).toHaveLength(1);
  });
});

// ── B-3-8: ring 末尾 run も拾う ────────────────────────────────────────────

describe("B-3-8: ring 末尾の run flush (Notepad 3 連続が末尾)", () => {
  it("Chrome 3 連続 + Notepad 3 連続 (末尾) → 2 pattern (末尾も flush)", () => {
    const events = [
      makeEvent("s:1", "focus_window", "Chrome"),
      makeEvent("s:2", "keyboard", "Chrome"),
      makeEvent("s:3", "browser_navigate", "Chrome"),
      makeEvent("s:4", "focus_window", "Notepad"),
      makeEvent("s:5", "keyboard", "Notepad"),
      makeEvent("s:6", "keyboard", "Notepad"),
    ];
    const patterns = extractSemanticPatterns(events);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.window_title).toBe("Chrome");
    expect(patterns[1]?.window_title).toBe("Notepad");
  });
});

// ── B-3-9: pattern dedupe (同 fingerprint で count merge + last_seen update) ─

describe("B-3-9: 同 fingerprint pattern を 2 度 record → success_count merge + last_seen refresh", () => {
  it("同 windowTitle + tool seq で 2 度抽出 → 1 entry、count = 6", () => {
    const r1: UiPatternRecord = {
      pattern_id: "pat-A",
      window_title: "Notepad",
      step_count: 3,
      last_seen_at_ms: 1000,
      success_count: 3,
      failure_count: 0,
      example_actions: ["keyboard", "focus_window"],
    };
    const r2: UiPatternRecord = {
      ...r1,
      last_seen_at_ms: 2000,
      success_count: 3,
    };
    uiPatternStore.recordPattern(r1);
    uiPatternStore.recordPattern(r2);
    expect(uiPatternStore._sizeForTest()).toBe(1);
    const top = uiPatternStore.getTopK(5);
    expect(top[0]?.success_count).toBe(6);
    expect(top[0]?.last_seen_at_ms).toBe(2000);
  });
});

// ── B-3-10: LRU eviction ────────────────────────────────────────────────────

describe("B-3-10: pattern store LRU で capacity 超過時 oldest evict", () => {
  it("capacity=3 で 4 件 record → oldest 1 件 evict、最新 3 件保持", () => {
    uiPatternStore._setCapacityForTest(3);
    for (let i = 1; i <= 4; i++) {
      uiPatternStore.recordPattern({
        pattern_id: `pat-${i}`,
        window_title: `Win${i}`,
        step_count: 3,
        last_seen_at_ms: 1000 + i,
        success_count: 3,
        failure_count: 0,
        example_actions: ["tool"],
      });
    }
    expect(uiPatternStore._sizeForTest()).toBe(3);
    const top = uiPatternStore.getTopK(10);
    // 最新 last_seen_at_ms 順 (4, 3, 2)、最古 1 は evict
    expect(top.map((p) => p.pattern_id)).toEqual(["pat-4", "pat-3", "pat-2"]);
  });
});

// ── B-3-11: K upper bound + try_next ────────────────────────────────────────

describe("B-3-11: K > SEMANTIC_MEMORY_K_MAX (= 10) で typed error + try_next 3 件", () => {
  it("SEMANTIC_MEMORY_K_MAX === 10 (SSOT pin)", () => {
    expect(SEMANTIC_MEMORY_K_MAX).toBe(10);
  });

  it("include=[\"semantic:11\"] → typed error SemanticMemoryKUpperBoundExceeded", async () => {
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => "sessE",
    });
    const result = await wrapped({ include: ["semantic:11"] } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.if_unexpected?.most_likely_cause).toBe("SemanticMemoryKUpperBoundExceeded");
    expect(parsed?.if_unexpected?.try_next).toHaveLength(3);
  });
});

// ── B-3-12: K=0 edge ────────────────────────────────────────────────────────

describe("B-3-12: K=0 で patterns 空配列 (skip ではない、valid request)", () => {
  it("ring + store ありでも K=0 → patterns: []", () => {
    uiPatternStore.recordPattern({
      pattern_id: "pat-A",
      window_title: "Notepad",
      step_count: 3,
      last_seen_at_ms: Date.now(),
      success_count: 3,
      failure_count: 0,
      example_actions: ["keyboard"],
    });
    // ring を作るために 1 entry seed (projectSemanticMemory は ring 不在で
    // `{patterns: []}` 即返、ring ありで store top-K を読む)
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: "sessZ",
      toolCallId: "sessZ:1",
    });
    const result = projectSemanticMemory("sessZ", 0, uiPatternStore)!;
    expect(result.patterns).toEqual([]);
    expect(result._truncation).toBeUndefined();
  });
});

// ── B-3-13: _truncation notation ────────────────────────────────────────────

describe("B-3-13: store size < K で _truncation: ring_underflow", () => {
  it("store 2 件 + K=5 → patterns 2 + _truncation { reason: ring_underflow }", () => {
    for (let i = 1; i <= 2; i++) {
      uiPatternStore.recordPattern({
        pattern_id: `pat-${i}`,
        window_title: `Win${i}`,
        step_count: 3,
        last_seen_at_ms: 1000 + i,
        success_count: 3,
        failure_count: 0,
        example_actions: ["tool"],
      });
    }
    // ring を作る (sentinel skip 経路を避ける)
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: "sessU",
      toolCallId: "sessU:1",
    });
    const result = projectSemanticMemory("sessU", 5, uiPatternStore)!;
    expect(result.patterns).toHaveLength(2);
    expect(result._truncation).toEqual({
      requested: 5,
      returned: 2,
      reason: "ring_underflow",
    });
  });
});

// ── B-3-14: wrapper end-to-end ──────────────────────────────────────────────

describe("B-3-14: makeQueryWrapper 経由 envelope.learned_ui_pattern inject", () => {
  it("include=[\"semantic:3\"] + ring に Notepad 3 連続 → envelope.learned_ui_pattern.patterns[0] = Notepad pattern", async () => {
    const sid = "sessW";
    // ring に 3 件 push (windowTitle = Notepad)
    for (let i = 1; i <= 3; i++) {
      defaultL1Emitter.pushStarted({
        tool: i === 1 ? "focus_window" : "keyboard",
        argsJson: `{"i":${i}}`,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
        windowTitle: "Notepad",
      });
      defaultL1Emitter.pushCompleted({
        tool: i === 1 ? "focus_window" : "keyboard",
        elapsedMs: 1,
        ok: true,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
      });
    }
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.learned_ui_pattern).toBeDefined();
    expect(parsed?.learned_ui_pattern?.patterns).toHaveLength(1);
    expect(parsed?.learned_ui_pattern?.patterns?.[0]?.window_title).toBe("Notepad");
    expect(parsed?.learned_ui_pattern?.patterns?.[0]?.step_count).toBe(3);
    expect(parsed?.learned_ui_pattern?.patterns?.[0]?.success_rate).toBe(1);
  });
});

// ── B-3-15: cross-session ────────────────────────────────────────────────────

describe("B-3-15: cross-session sessionA / sessionB 並走 (pattern_id は windowTitle ベース、session 跨ぎ dedupe — intentional、§10 OQ #10 security tier framework follow-up で per-session-key option 検討)", () => {
  it("session A + B 同 windowTitle で 3+ 成功 → store の同 pattern を共有 (success_count merge — intentional cross-session merge、redact env で window_title plaintext leak は P1-2 fix で防御)", () => {
    // session A: Notepad 3 件
    const eventsA = [
      makeEvent("a:1", "focus_window", "Notepad"),
      makeEvent("a:2", "keyboard", "Notepad"),
      makeEvent("a:3", "keyboard", "Notepad"),
    ];
    const patternsA = extractSemanticPatterns(eventsA);
    for (const p of patternsA) uiPatternStore.recordPattern(p);
    // session B: 同 Notepad で同 sequence 3 件
    const eventsB = [
      makeEvent("b:1", "focus_window", "Notepad"),
      makeEvent("b:2", "keyboard", "Notepad"),
      makeEvent("b:3", "keyboard", "Notepad"),
    ];
    const patternsB = extractSemanticPatterns(eventsB);
    for (const p of patternsB) uiPatternStore.recordPattern(p);
    // 同 fingerprint で merge → 1 entry、count = 6
    expect(uiPatternStore._sizeForTest()).toBe(1);
    expect(uiPatternStore.getTopK(1)[0]?.success_count).toBe(6);
  });
});

// ── B-3-16: env parser pure ─────────────────────────────────────────────────

describe("B-3-16: parseMemoryPersistMode / parseMemoryRedactMode pure parser", () => {
  it.each<[string | undefined, boolean]>([
    ["1", true],
    ["0", false],
    [undefined, false],
    ["true", false],
    ["", false],
    ["yes", false],
  ])("parseMemoryPersistMode(%j) === %j", (input, expected) => {
    expect(parseMemoryPersistMode(input)).toBe(expected);
  });

  it.each<[string | undefined, boolean]>([
    ["1", true],
    ["0", false],
    [undefined, false],
    ["true", false],
    ["", false],
  ])("parseMemoryRedactMode(%j) === %j", (input, expected) => {
    expect(parseMemoryRedactMode(input)).toBe(expected);
  });
});

// ── B-3-17: cursor advances on wrapper query (P1-1 regression) ──────────────

describe("B-3-17: wrapper の semantic extraction cursor advance (Round 2 P1-1 fix regression)", () => {
  it("同 ring を 2 回 query → 同 events の re-extract で success_count 累積しない", async () => {
    const sid = "sessP1";
    // 3 件 push (Notepad ok=true 連続) → 1 query で 1 pattern 抽出される
    for (let i = 1; i <= 3; i++) {
      defaultL1Emitter.pushStarted({
        tool: i === 1 ? "focus_window" : "keyboard",
        argsJson: `{"i":${i}}`,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
        windowTitle: "Notepad",
      });
      defaultL1Emitter.pushCompleted({
        tool: i === 1 ? "focus_window" : "keyboard",
        elapsedMs: 1,
        ok: true,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
      });
    }
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    // Query 1: 3 events → 1 pattern (success_count = 3)
    await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
    // Query 2: cursor が末尾に進んでいるので新規 events ゼロ → 再 extract せず
    await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
    // Query 3: 同上
    const result3 = await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
    const block3 = result3.content?.[0];
    const parsed3 = JSON.parse((block3 as { type: "text"; text: string }).text);
    // success_rate は 1.0 (success_count / (success_count + failure_count) = 3/3)
    // 累積 bug があれば success_count は 3+3+3 = 9 になるが、cursor で構造的解消
    expect(parsed3?.learned_ui_pattern?.patterns?.[0]?.success_rate).toBe(1);
    // store top-1 で success_count = 3 を直接 pin
    const top = uiPatternStore.getTopK(1);
    expect(top[0]?.success_count).toBe(3);
  });
});

// ── B-3-18: env redact (P1-2 regression) ────────────────────────────────────

describe("B-3-18: DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1 で window_title hash redact (Round 2 P1-2 fix regression)", () => {
  it("env on で projection 出力の window_title が plaintext でなく hash 表記になる", async () => {
    const sid = "sessP2";
    process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES = "1";
    try {
      for (let i = 1; i <= 3; i++) {
        defaultL1Emitter.pushStarted({
          tool: i === 1 ? "focus_window" : "keyboard",
          argsJson: `{"i":${i}}`,
          sessionId: sid,
          toolCallId: `${sid}:${i}`,
          windowTitle: "Sensitive Document.txt - Notepad",
        });
        defaultL1Emitter.pushCompleted({
          tool: i === 1 ? "focus_window" : "keyboard",
          elapsedMs: 1,
          ok: true,
          sessionId: sid,
          toolCallId: `${sid}:${i}`,
        });
      }
      const handler = async () => ({
        content: [{ type: "text" as const, text: '{"ok":true}' }],
      });
      const wrapped = makeQueryWrapper(handler, "test_query", {
        causedByProjector: async () => undefined,
        getSessionId: () => sid,
      });
      const result = await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
      const block = result.content?.[0];
      const parsed = JSON.parse((block as { type: "text"; text: string }).text);
      const wt = parsed?.learned_ui_pattern?.patterns?.[0]?.window_title;
      // plaintext を含まない、`redacted:` プレフィックス + hex8 hash
      expect(wt).toMatch(/^redacted:[0-9a-f]{8}$/);
      expect(wt).not.toContain("Sensitive");
      expect(wt).not.toContain("Notepad");
    } finally {
      delete process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES;
    }
  });

  it("env off で projection 出力の window_title は plaintext のまま (default)", async () => {
    const sid = "sessP2off";
    delete process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES;
    for (let i = 1; i <= 3; i++) {
      defaultL1Emitter.pushStarted({
        tool: i === 1 ? "focus_window" : "keyboard",
        argsJson: `{"i":${i}}`,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
        windowTitle: "Notepad",
      });
      defaultL1Emitter.pushCompleted({
        tool: i === 1 ? "focus_window" : "keyboard",
        elapsedMs: 1,
        ok: true,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
      });
    }
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.learned_ui_pattern?.patterns?.[0]?.window_title).toBe("Notepad");
  });
});

// ── B-3-19: parseIncludeMemoryN edge for semantic axis (Round 2 P2-1 fix) ───

describe("B-3-19: include=[\"semantic:<edge>\"] empty / negative / non-numeric K", () => {
  it.each<[string, number | undefined]>([
    ["semantic:", SEMANTIC_MEMORY_DEFAULT_K], // empty K → default
    ["semantic:abc", SEMANTIC_MEMORY_DEFAULT_K], // non-numeric → default
    ["semantic:-1", SEMANTIC_MEMORY_DEFAULT_K], // negative → default (parseIncludeMemoryN は `n >= 0` で reject して default fallback)
  ])("parseIncludeMemoryN([%j], 'semantic') 戻り値が default fallback", (token, expected) => {
    const k = parseIncludeMemoryN([token], "semantic", SEMANTIC_MEMORY_DEFAULT_K);
    expect(k).toBe(expected);
  });
});

// ── B-3-21: cursor lifecycle eviction (Round 2 Codex P2 fix) ────────────────

describe("B-3-21: ring TTL/LRU eviction で _semanticExtractionCursors も clean (Codex P2 fix regression)", () => {
  it("TTL 経過で ring 消滅 → 同 sessionId の cursor も削除、短命 session 大量発生で Map unbounded growth しない", async () => {
    const sid = "sessTTL";
    let mockNow = 1000;
    _setHistoryClockForTest(() => mockNow);
    try {
      // 3 件 push (Notepad ok=true) + query で cursor 生成
      for (let i = 1; i <= 3; i++) {
        defaultL1Emitter.pushStarted({
          tool: i === 1 ? "focus_window" : "keyboard",
          argsJson: `{"i":${i}}`,
          sessionId: sid,
          toolCallId: `${sid}:${i}`,
          windowTitle: "Notepad",
        });
        defaultL1Emitter.pushCompleted({
          tool: i === 1 ? "focus_window" : "keyboard",
          elapsedMs: 1,
          ok: true,
          sessionId: sid,
          toolCallId: `${sid}:${i}`,
        });
      }
      const handler = async () => ({
        content: [{ type: "text" as const, text: '{"ok":true}' }],
      });
      const wrapped = makeQueryWrapper(handler, "test_query", {
        causedByProjector: async () => undefined,
        getSessionId: () => sid,
      });
      // Query で cursor 設定
      await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
      // pattern store には 1 件、cursor も 1 件
      expect(uiPatternStore._sizeForTest()).toBe(1);

      // TTL 経過 (24h + 1ms) を mock 時刻で進める
      mockNow += 24 * 3600 * 1000 + 1;

      // 別 session の push を trigger (= evictHistoryIfNeeded 走る)
      defaultL1Emitter.pushStarted({
        tool: "focus_window",
        argsJson: "{}",
        sessionId: "sessTTLOther",
        toolCallId: "sessTTLOther:1",
        windowTitle: "Other",
      });

      // 同 sessionId で再度 push → 新規 ring (前回 cursor は eviction で消滅
      // しているはず、stale cursor で fallback rescan が走らない)
      for (let i = 1; i <= 3; i++) {
        defaultL1Emitter.pushStarted({
          tool: i === 1 ? "focus_window" : "keyboard",
          argsJson: `{"j":${i}}`,
          sessionId: sid,
          toolCallId: `${sid}:revived:${i}`,
          windowTitle: "Notepad",
        });
        defaultL1Emitter.pushCompleted({
          tool: i === 1 ? "focus_window" : "keyboard",
          elapsedMs: 1,
          ok: true,
          sessionId: sid,
          toolCallId: `${sid}:revived:${i}`,
        });
      }
      // Query → 復活 ring に対し正しく fresh extraction (stale cursor で
      // 全 events を再 extract する fallback と違い、正しく 1 pattern として merge)
      const result = await wrapped({ include: ["semantic:3"] } as Record<string, unknown>);
      const block = result.content?.[0];
      const parsed = JSON.parse((block as { type: "text"; text: string }).text);
      // 同 windowTitle + tool seq なので同 pattern_id、merge 済 (1 pattern entry)
      expect(parsed?.learned_ui_pattern?.patterns).toHaveLength(1);
      // success_count = 3 (初回) + 3 (復活時) = 6 が intentional cross-eviction merge
      const top = uiPatternStore.getTopK(1);
      expect(top[0]?.success_count).toBe(6);
    } finally {
      _resetHistoryClockForTest();
    }
  });
});

// ── B-3-20: pattern_id collision avoidance for long titles (Round 2 P2-4 fix) ─

describe("B-3-20: 長 path 同 prefix で異なる windowTitle が誤 merge しない (Round 2 P2-4 fix regression)", () => {
  it("先頭 32 char 一致の長 path 2 件 + 同 tool seq → pattern_id 別 → 別 entry", () => {
    // 先頭 32 char 一致の 2 件 windowTitle
    const wt1 = "C:\\Users\\harus\\Documents\\very-long-filename-1.txt - Notepad";
    const wt2 = "C:\\Users\\harus\\Documents\\very-long-filename-2.txt - Notepad";
    const events1 = [
      makeEvent("a:1", "focus_window", wt1),
      makeEvent("a:2", "keyboard", wt1),
      makeEvent("a:3", "keyboard", wt1),
    ];
    const events2 = [
      makeEvent("b:1", "focus_window", wt2),
      makeEvent("b:2", "keyboard", wt2),
      makeEvent("b:3", "keyboard", wt2),
    ];
    const r1 = extractSemanticPatterns(events1);
    const r2 = extractSemanticPatterns(events2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    // FNV-1a hash で full title を比較するので、別 file の title は別 fingerprint
    expect(r1[0].pattern_id).not.toBe(r2[0].pattern_id);
  });
});
