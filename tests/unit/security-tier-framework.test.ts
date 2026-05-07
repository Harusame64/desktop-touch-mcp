/**
 * security-tier-framework.test.ts — ADR-011 Phase B §10 OQ #10 Resolved
 * (B-3 / B-4 既存 gate に接続する軽量 framework)。
 *
 * Coverage:
 *   - TIER-1 parseIncludeMemorySecurity: keyword 4 case (strict/balanced/open/不在)
 *   - TIER-2 resolveEffectiveSecurityTier: 3 tier × env 2x2 = 12 combo + default
 *   - TIER-3 strict は env を超えて max security へ動かせる (env=open でも redact ON)
 *   - TIER-4 open は env を超えて open 側へ動かせない (env=strict のままで上書き不能)
 *   - TIER-5 envelope.security_tier_active expose (any memory layer + tier-only request)
 *   - TIER-6 B-3 redact gate: tier=strict で env 設定無視で redact ON
 *   - TIER-7 B-4 procedural gate: tier=strict で expose suppressed (effective.procedural=off)
 *   - TIER-8 B-1/B-2 は tier 影響なし (working/episodic projection は tier 関係なく動く)
 *   - TIER-9 sentinel session で tier 計算は走るが projection 全体 skip
 *   - TIER-10 tier-only request (memory_strict のみ) で envelope に tier_active expose、layer projection は不在
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  parseIncludeMemorySecurity,
  resolveEffectiveSecurityTier,
  defaultL1Emitter,
  makeQueryWrapper,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _resetHistoryClockForTest,
  type SecurityTier,
} from "../../src/tools/_envelope.js";
import { uiPatternStore } from "../../src/store/ui-pattern-store.js";
import { macroOutcomeStore } from "../../src/store/macro-outcome-store.js";

afterEach(() => {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
  _resetHistoryClockForTest();
  uiPatternStore._resetForTest();
  macroOutcomeStore._resetForTest();
  delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;
  delete process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES;
});

beforeEach(() => {
  uiPatternStore._resetForTest();
  macroOutcomeStore._resetForTest();
});

// ── TIER-1: parseIncludeMemorySecurity ─────────────────────────────────────

describe("TIER-1: parseIncludeMemorySecurity keyword 解析", () => {
  it.each<[string[] | undefined, SecurityTier | undefined]>([
    [["memory_strict"], "strict"],
    [["memory_balanced"], "balanced"],
    [["memory_open"], "open"],
    [["semantic:3"], undefined],
    [undefined, undefined],
    [[], undefined],
    [["memory_strict", "memory_open"], "strict"], // 最初 match 採用
  ])("parseIncludeMemorySecurity(%j) === %j", (input, expected) => {
    expect(parseIncludeMemorySecurity(input)).toBe(expected);
  });
});

// ── TIER-2: resolveEffectiveSecurityTier 全 combo ───────────────────────────

describe("TIER-2: resolveEffectiveSecurityTier (3 tier × env 2x2)", () => {
  it("strict は env 設定無視で max security 強制", () => {
    expect(
      resolveEffectiveSecurityTier("strict", { persist: true, redact: false }),
    ).toEqual({
      tier: "strict",
      effective: {
        redact_window_titles: true,
        persist: false,
        procedural: "off",
      },
    });
    expect(
      resolveEffectiveSecurityTier("strict", { persist: false, redact: true }),
    ).toEqual({
      tier: "strict",
      effective: {
        redact_window_titles: true,
        persist: false,
        procedural: "off",
      },
    });
  });

  it("balanced = env 既定値踏襲", () => {
    expect(
      resolveEffectiveSecurityTier("balanced", {
        persist: true,
        redact: false,
      }),
    ).toEqual({
      tier: "balanced",
      effective: {
        redact_window_titles: false,
        persist: true,
        procedural: "expose",
      },
    });
    expect(
      resolveEffectiveSecurityTier("balanced", {
        persist: false,
        redact: true,
      }),
    ).toEqual({
      tier: "balanced",
      effective: {
        redact_window_titles: true,
        persist: false,
        procedural: "expose",
      },
    });
  });

  it("open = env ceiling の範囲内、binary axes は balanced と同等", () => {
    expect(
      resolveEffectiveSecurityTier("open", { persist: false, redact: true }),
    ).toEqual({
      tier: "open",
      effective: {
        redact_window_titles: true, // env=ON は OFF にできない
        persist: false, // env=OFF は ON にできない
        procedural: "expose",
      },
    });
  });

  it("request undefined → balanced default で resolve", () => {
    expect(
      resolveEffectiveSecurityTier(undefined, {
        persist: true,
        redact: false,
      }),
    ).toEqual({
      tier: "balanced",
      effective: {
        redact_window_titles: false,
        persist: true,
        procedural: "expose",
      },
    });
  });
});

// ── TIER-3: strict は env を超えて max security ────────────────────────────

describe("TIER-3: strict 強制動作 (env=open でも全 max security)", () => {
  it("env redact=OFF + persist=ON → strict で redact=true / persist=false / procedural=off", () => {
    const result = resolveEffectiveSecurityTier("strict", {
      persist: true,
      redact: false,
    });
    expect(result.effective.redact_window_titles).toBe(true);
    expect(result.effective.persist).toBe(false);
    expect(result.effective.procedural).toBe("off");
  });
});

// ── TIER-4: open は env を超えて open 側へ動かせない ───────────────────────

describe("TIER-4: open security floor 原則 (env strict のまま上書き不能)", () => {
  it("env redact=ON → open でも redact=true (env を緩められない)", () => {
    const result = resolveEffectiveSecurityTier("open", {
      persist: false,
      redact: true,
    });
    expect(result.effective.redact_window_titles).toBe(true);
    expect(result.effective.persist).toBe(false);
  });
});

// ── TIER-5: envelope.security_tier_active expose ───────────────────────────

describe("TIER-5: envelope.security_tier_active expose (memory layer 1+ or memory_* keyword)", () => {
  it("include=[\"working\"] → security_tier_active 出る (memory layer opt-in 経路)", async () => {
    const sid = "sessTIER5a";
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["working:3"] } as Record<
      string,
      unknown
    >);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    // memory_* keyword 不在 → tier=balanced default、env 全 OFF → 全 effective false/expose
    expect(parsed?.security_tier_active).toEqual({
      tier: "balanced",
      effective: {
        redact_window_titles: false,
        persist: false,
        procedural: "expose",
      },
    });
  });

  it("include=[\"memory_strict\"] のみ (layer 不在) → security_tier_active のみ expose、layer projection 不在", async () => {
    const sid = "sessTIER5b";
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["memory_strict"] } as Record<
      string,
      unknown
    >);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("strict");
    expect(parsed?.current_state).toBeUndefined();
    expect(parsed?.tool_call_history).toBeUndefined();
    expect(parsed?.learned_ui_pattern).toBeUndefined();
    expect(parsed?.successful_macros).toBeUndefined();
  });

  it("include なし → security_tier_active 不在 (memory 経路触らない)", async () => {
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => "sessTIER5c",
    });
    const result = await wrapped({} as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active).toBeUndefined();
  });
});

// ── TIER-6: B-3 redact gate (tier=strict 強制) ─────────────────────────────

describe("TIER-6: B-3 semantic redact gate (tier=strict 強制 ON)", () => {
  it("env redact OFF + tier=strict → projection で window_title hash 化", async () => {
    delete process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES;
    const sid = "sessTIER6";
    for (let i = 1; i <= 3; i++) {
      defaultL1Emitter.pushStarted({
        tool: i === 1 ? "focus_window" : "keyboard",
        argsJson: `{"i":${i}}`,
        sessionId: sid,
        toolCallId: `${sid}:${i}`,
        windowTitle: "Sensitive.txt - Notepad",
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
    const result = await wrapped({
      include: ["semantic:3", "memory_strict"],
    } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("strict");
    expect(
      parsed?.learned_ui_pattern?.patterns?.[0]?.window_title,
    ).toMatch(/^redacted:[0-9a-f]{8}$/);
  });
});

// ── TIER-7: B-4 procedural gate (tier=strict expose suppress) ──────────────

describe("TIER-7: B-4 procedural gate (tier=strict で suppress)", () => {
  it("3 回成功 record + tier=strict → successful_macros undefined (expose suppressed)", async () => {
    const sid = "sessTIER7";
    for (let i = 0; i < 3; i++) {
      macroOutcomeStore.recordOutcome({
        tools: ["desktop_state"],
        success: true,
        containsDestructive: false,
      });
    }
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({
      include: ["procedural:3", "memory_strict"],
    } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("strict");
    expect(parsed?.security_tier_active?.effective?.procedural).toBe("off");
    // procedural projection は suppressed
    expect(parsed?.successful_macros).toBeUndefined();
  });

  it("balanced (default) → procedural projection 出る", async () => {
    const sid = "sessTIER7b";
    for (let i = 0; i < 3; i++) {
      macroOutcomeStore.recordOutcome({
        tools: ["desktop_state"],
        success: true,
        containsDestructive: false,
      });
    }
    defaultL1Emitter.pushStarted({
      tool: "test",
      argsJson: "{}",
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({ include: ["procedural:3"] } as Record<
      string,
      unknown
    >);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("balanced");
    expect(parsed?.successful_macros?.suggestions).toHaveLength(1);
  });
});

// ── TIER-8: B-1/B-2 は tier 影響なし ───────────────────────────────────────

describe("TIER-8: B-1 working / B-2 episodic は tier 関係なく projection 動く", () => {
  it("tier=strict でも working memory projection は普通に出る", async () => {
    const sid = "sessTIER8";
    defaultL1Emitter.pushStarted({
      tool: "focus_window",
      argsJson: "{}",
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    defaultL1Emitter.pushCompleted({
      tool: "focus_window",
      elapsedMs: 1,
      ok: true,
      sessionId: sid,
      toolCallId: `${sid}:1`,
    });
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => sid,
    });
    const result = await wrapped({
      include: ["working:3", "memory_strict"],
    } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    // tier=strict で active、working memory projection は影響なく出る
    expect(parsed?.security_tier_active?.tier).toBe("strict");
    expect(parsed?.current_state?.recent_events).toBeDefined();
  });
});

// ── TIER-9: sentinel session ───────────────────────────────────────────────

describe("TIER-9: sentinel session でも tier 計算は走るが projection skip", () => {
  it("sessionId=multi:disabled + memory_strict → tier_active expose、projection 全 skip", async () => {
    const handler = async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    });
    const wrapped = makeQueryWrapper(handler, "test_query", {
      causedByProjector: async () => undefined,
      getSessionId: () => "multi:disabled",
    });
    const result = await wrapped({
      include: ["semantic:3", "procedural:3", "memory_strict"],
    } as Record<string, unknown>);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("strict");
    expect(parsed?.learned_ui_pattern).toBeUndefined();
    expect(parsed?.successful_macros).toBeUndefined();
  });
});

// ── TIER-10: env ON + tier=balanced で持続的設定踏襲 ──────────────────────

describe("TIER-10: env ON + tier=balanced で env 設定踏襲", () => {
  it("env REDACT_TITLES=1 + tier=balanced → projection で window_title hash 化", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES = "1";
    const sid = "sessTIER10";
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
    const result = await wrapped({ include: ["semantic:3"] } as Record<
      string,
      unknown
    >);
    const block = result.content?.[0];
    const parsed = JSON.parse((block as { type: "text"; text: string }).text);
    expect(parsed?.security_tier_active?.tier).toBe("balanced");
    expect(parsed?.security_tier_active?.effective?.redact_window_titles).toBe(
      true,
    );
    expect(
      parsed?.learned_ui_pattern?.patterns?.[0]?.window_title,
    ).toMatch(/^redacted:[0-9a-f]{8}$/);
  });
});
