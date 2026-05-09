/**
 * run-macro-stop-on-error-inner-envelope.test.ts
 *
 * Pin the contract that `run_macro` honours `stop_on_error: true` not only
 * when a step throws but also when the step returns an `ok:false` envelope
 * in its first text block. This is the Phase 6 dogfood F1 finding
 * (`docs/llm-audit/phase6-dogfood-findings.md` §F1, originated from
 * `dogfood-scenarios/launcher-macro.md` §2.1) — before the fix,
 * `run_macro` silently continued past inner-failure steps because the
 * macro wrapper considered every non-throwing handler return as success.
 *
 * Contract (matrix §3.1 line 157 規範):
 *   - When `stop_on_error: true` (default), the macro halts on the first
 *     step that fails — failure includes both throws AND inner ok:false
 *     envelopes.
 *   - When `stop_on_error: false`, every step runs and the top-level
 *     summary surfaces a `warnings[]` array enumerating each failed step
 *     ({step, tool, code?, error?}) so callers don't need to JSON.parse
 *     each text block to detect partial failures.
 */
import { describe, it, expect } from "vitest";
import { runMacroHandler } from "../../src/tools/macro.js";

interface StepResult {
  step: number;
  tool: string;
  ok: boolean;
  text?: string[];
  error?: string;
  code?: string;
}

interface MacroSummary {
  steps_total: number;
  steps_completed: number;
  results: StepResult[];
  warnings?: Array<{ step: number; tool: string; code?: string; error?: string }>;
}

function parseSummary(result: { content: Array<{ type: string; text?: string }> }): MacroSummary {
  const first = result.content.find((b) => b.type === "text");
  if (!first?.text) throw new Error("missing text block in run_macro result");
  return JSON.parse(first.text) as MacroSummary;
}

describe("run_macro: stop_on_error halts on inner ok:false envelope (Phase 6 F1 fix)", () => {
  it("step returns inner ok:false → stop_on_error:true halts before step 1", async () => {
    const out = await runMacroHandler({
      steps: [
        // focus_window with bogus title returns ok:false envelope (WindowNotFound).
        // This is a real production tool emitting a real failure envelope —
        // no exception thrown, classify resolves to typed code.
        { tool: "focus_window", params: { title: "__nonexistent_phase6_f1_test__" } },
        // Step that should NOT execute when stop_on_error halts properly.
        { tool: "desktop_state", params: {} },
      ],
      stop_on_error: true,
    });
    const summary = parseSummary(out);

    expect(summary.steps_total).toBe(2);
    // F1 fix: macro halts after step 0, step 1 not executed.
    expect(summary.steps_completed).toBe(1);
    expect(summary.results).toHaveLength(1);

    const step0 = summary.results[0]!;
    expect(step0.step).toBe(0);
    expect(step0.tool).toBe("focus_window");
    // F1 fix: step-level ok reflects inner envelope ok:false.
    expect(step0.ok).toBe(false);
    expect(step0.code).toBe("WindowNotFound");
    // Error preserves the inner envelope error string.
    expect(step0.error).toBeDefined();
    expect(step0.error).toContain("Window not found");
  });

  it("step returns inner ok:false → stop_on_error:false runs all + warnings[] surfaces nested code", async () => {
    const out = await runMacroHandler({
      steps: [
        { tool: "desktop_state", params: {} },
        { tool: "focus_window", params: { title: "__nonexistent_phase6_f2_test__" } },
        { tool: "desktop_state", params: {} },
      ],
      stop_on_error: false,
    });
    const summary = parseSummary(out);

    expect(summary.steps_total).toBe(3);
    expect(summary.steps_completed).toBe(3);
    expect(summary.results).toHaveLength(3);

    expect(summary.results[0]!.ok).toBe(true);
    expect(summary.results[1]!.ok).toBe(false);
    expect(summary.results[1]!.code).toBe("WindowNotFound");
    expect(summary.results[2]!.ok).toBe(true);

    // F2 fix: top-level warnings[] aggregates failed steps.
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings).toHaveLength(1);
    const w = summary.warnings![0]!;
    expect(w.step).toBe(1);
    expect(w.tool).toBe("focus_window");
    expect(w.code).toBe("WindowNotFound");
    expect(w.error).toContain("Window not found");
  });

  it("all steps succeed → no warnings[] in summary", async () => {
    const out = await runMacroHandler({
      steps: [
        { tool: "desktop_state", params: {} },
        { tool: "sleep", params: { ms: 1 } },
      ],
      stop_on_error: true,
    });
    const summary = parseSummary(out);
    expect(summary.steps_completed).toBe(2);
    expect(summary.results.every((r) => r.ok)).toBe(true);
    // No warnings field when nothing failed.
    expect(summary.warnings).toBeUndefined();
  });

  it("step throws (Zod validation) → stop_on_error:true halts (existing behavior preserved)", async () => {
    const out = await runMacroHandler({
      steps: [
        // click_element schema requires windowTitle; missing → Zod throw.
        { tool: "click_element", params: { name: "__test__" } },
        { tool: "desktop_state", params: {} },
      ],
      stop_on_error: true,
    });
    const summary = parseSummary(out);
    expect(summary.steps_completed).toBe(1);
    expect(summary.results[0]!.ok).toBe(false);
    // Schema validation throws — step-level error from catch block.
    expect(summary.results[0]!.error).toBeDefined();
  });

  it("non-JSON text block (e.g. screenshot detail='text') treated as success", async () => {
    // Screenshot success path emits structured JSON — to test the parse-failure
    // fallback we'd need a tool that emits non-JSON text on success. Such a
    // tool doesn't exist in the public surface today; this test is a smoke
    // check that desktop_state success (which DOES emit JSON ok:true) is
    // correctly recognized as ok:true.
    const out = await runMacroHandler({
      steps: [{ tool: "desktop_state", params: {} }],
      stop_on_error: true,
    });
    const summary = parseSummary(out);
    expect(summary.steps_completed).toBe(1);
    expect(summary.results[0]!.ok).toBe(true);
  });

  // Round 1 Opus P2-3 反映: warnings[] entries の shape contract pin。
  // catch path / recursion / unknown-tool / Zod-throw paths は `code` 不在で
  // `error` のみを持つ。inner ok:false path は inner envelope `code` field
  // ある時のみ `code` 含む。callers は warning.code を optional として扱う必要。
  it("warnings[] shape contract: catch-path entries omit `code`, inner-fail entries include it when present", async () => {
    const out = await runMacroHandler({
      steps: [
        // recursion path → ok:false at macro level, no code field
        { tool: "run_macro", params: { steps: [{ tool: "desktop_state", params: {} }] } },
        // unknown tool path → ok:false at macro level, no code field
        { tool: "__totally_unknown_tool_phase7_p2_3__", params: {} },
        // inner ok:false with code (focus_window emits WindowNotFound)
        { tool: "focus_window", params: { title: "__nonexistent_p2_3_test__" } },
      ],
      stop_on_error: false,
    });
    const summary = parseSummary(out);

    expect(summary.warnings).toBeDefined();
    expect(summary.warnings).toHaveLength(3);

    const recursionWarning = summary.warnings![0]!;
    expect(recursionWarning.tool).toBe("run_macro");
    expect(recursionWarning.error).toContain("run_macro cannot be called inside run_macro");
    expect(recursionWarning.code).toBeUndefined();

    const unknownWarning = summary.warnings![1]!;
    expect(unknownWarning.tool).toBe("__totally_unknown_tool_phase7_p2_3__");
    expect(unknownWarning.error).toContain("Unknown tool");
    expect(unknownWarning.code).toBeUndefined();

    const innerFailWarning = summary.warnings![2]!;
    expect(innerFailWarning.tool).toBe("focus_window");
    expect(innerFailWarning.code).toBe("WindowNotFound");
    expect(innerFailWarning.error).toBeDefined();
  });

  // Round 1 Opus P2-1 反映: F1 fix で stop_on_error: true 早期 break しても
  // outer run_macro orchestration boundary (= L1 completed event) は記録される
  // ことを後続 query/B-1 経路で anchor として参照可能。本 test は `runMacroHandler`
  // 単体経由 (= L5 wrapper 不経由、orchestration boundary は L5 wrap layer 責務で
  // 本 handler scope 外) のため anchor 直接 assert は別 test の領域、
  // ここでは partial macro でも summary が正しく完了報告 (= caller が partial
  // 結果を確認できる) ことを pin する。
  it("F1 partial-success macro: stop_on_error halt 後も summary は完了 + warnings[] surface", async () => {
    const out = await runMacroHandler({
      steps: [
        { tool: "desktop_state", params: {} },
        { tool: "focus_window", params: { title: "__nonexistent_p2_1_anchor_test__" } },
        { tool: "desktop_state", params: {} },
      ],
      stop_on_error: true,
    });
    const summary = parseSummary(out);
    // halt: 3 step 中 2 step まで完了 (step 1 失敗で break)
    expect(summary.steps_total).toBe(3);
    expect(summary.steps_completed).toBe(2);
    // halt しても summary 完了 = caller が partial 結果を確認可能
    expect(summary.results).toHaveLength(2);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings![0]!.step).toBe(1);
    // step 2 (desktop_state) は実行されていないため results に存在しない
    expect(summary.results.find((r) => r.step === 2)).toBeUndefined();
  });
});
