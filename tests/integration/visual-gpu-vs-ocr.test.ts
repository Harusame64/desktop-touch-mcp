/**
 * visual-gpu-vs-ocr.test.ts — capability gap measurement between the
 * Visual GPU lane (PoC stub) and the PrintWindow → OCR (SoM) pipeline.
 *
 * Purpose: provide numeric evidence of what the Outlook PWA case (and any
 * UIA-blind native / PWA window) looks like under each path today.
 *
 * Gating:
 *   RUN_VISUAL_GPU_AUDIT=1          enable the test body (OFF by default)
 *   VISUAL_GPU_AUDIT_TITLE="<title>" window title substring to audit
 *     (default: "Outlook")
 *
 * The default is OFF because:
 *   - runSomPipeline() spawns win-ocr.exe and requires a live target window.
 *   - PrintWindow captures real pixels and is non-deterministic.
 *
 * Example:
 *   RUN_VISUAL_GPU_AUDIT=1 VISUAL_GPU_AUDIT_TITLE="Outlook" ^
 *     npx vitest run --project integration tests/integration/visual-gpu-vs-ocr.test.ts
 *
 * The test is intentionally lenient (no hard thresholds). Its job is to
 * produce a report, not to fail CI. Numbers are written to stderr via
 * console.error so they appear in the vitest output regardless of verbosity.
 */

import { describe, it, expect } from "vitest";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import { fetchOcrCandidates }    from "../../src/tools/desktop-providers/ocr-provider.js";
import { getVisualRuntime, _resetVisualRuntimeForTest } from "../../src/engine/vision-gpu/runtime.js";
import { PocVisualBackend }      from "../../src/engine/vision-gpu/poc-backend.js";
import { enumWindowsInZOrder }   from "../../src/engine/win32.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const RUN        = process.env["RUN_VISUAL_GPU_AUDIT"] === "1";
const TITLE_FRAG = process.env["VISUAL_GPU_AUDIT_TITLE"] ?? "Outlook";

describe.skipIf(!RUN)("Visual GPU vs PrintWindow→OCR capability report", () => {
  it(`measures both lanes against a live "${TITLE_FRAG}" window`, async () => {
    // ── Locate the target window ──────────────────────────────────────────────
    const wins = enumWindowsInZOrder();
    const win  = wins.find((w) => w.title.toLowerCase().includes(TITLE_FRAG.toLowerCase()));
    if (!win) {
      console.error(`[visual-audit] No window found matching "${TITLE_FRAG}" — skipping measurement.`);
      expect(true).toBe(true);
      return;
    }
    console.error(`[visual-audit] Target: hwnd=${win.hwnd} title="${win.title}" region=${JSON.stringify(win.region)}`);

    // ── Visual GPU lane ───────────────────────────────────────────────────────
    // Attach a PocVisualBackend so the provider runs the full warm path, but
    // deliberately do NOT invoke pushDirtySignal — this is exactly the
    // production state Outlook sees today.
    const rt = getVisualRuntime();
    const backend = new PocVisualBackend({ coldWarmupMs: 5 });
    await rt.attach(backend);
    await rt.ensureWarm({ kind: "game", id: String(win.hwnd) });

    const visualResult = await fetchVisualCandidates({ hwnd: String(win.hwnd), windowTitle: win.title });

    // ── OCR SoM lane ──────────────────────────────────────────────────────────
    const ocrResult = await fetchOcrCandidates({ hwnd: String(win.hwnd), windowTitle: win.title });

    // ── Report ────────────────────────────────────────────────────────────────
    const summary = summarise(visualResult.candidates, ocrResult.candidates);
    console.error("[visual-audit] ───────────────────────────────────────────────");
    console.error(`[visual-audit] Visual GPU   count=${visualResult.candidates.length}  warnings=${JSON.stringify(visualResult.warnings)}`);
    console.error(`[visual-audit] OCR (SoM)    count=${ocrResult.candidates.length}     warnings=${JSON.stringify(ocrResult.warnings)}`);
    console.error(`[visual-audit] OCR avg-confidence=${summary.ocrAvgConfidence.toFixed(3)} min=${summary.ocrMinConfidence.toFixed(3)} max=${summary.ocrMaxConfidence.toFixed(3)}`);
    console.error(`[visual-audit] OCR top labels: ${summary.topLabels.join(" | ")}`);
    console.error("[visual-audit] ───────────────────────────────────────────────");

    // ── Assertions (documentation-only, not quality gates) ────────────────────
    // The Visual GPU lane is expected to be empty until P3-D wiring lands.
    expect(visualResult.candidates.length).toBe(0);
    // OCR lane is expected to produce *some* candidates on any non-blank window.
    // We do not assert a count — the integration is informative, not gating.
    expect(Array.isArray(ocrResult.candidates)).toBe(true);

    await rt.dispose();
    _resetVisualRuntimeForTest();
  }, /* testTimeout override */ 60_000);
});

function summarise(
  _visual: UiEntityCandidate[],
  ocr: UiEntityCandidate[],
): { ocrAvgConfidence: number; ocrMinConfidence: number; ocrMaxConfidence: number; topLabels: string[] } {
  if (ocr.length === 0) {
    return { ocrAvgConfidence: 0, ocrMinConfidence: 0, ocrMaxConfidence: 0, topLabels: [] };
  }
  const confs = ocr.map((c) => c.confidence);
  const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
  const min = Math.min(...confs);
  const max = Math.max(...confs);
  const topLabels = [...ocr]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8)
    .map((c) => `${(c.label ?? "").slice(0, 24)}(${c.confidence.toFixed(2)})`);
  return { ocrAvgConfidence: avg, ocrMinConfidence: min, ocrMaxConfidence: max, topLabels };
}
