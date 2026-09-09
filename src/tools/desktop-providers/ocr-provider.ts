/**
 * ocr-provider.ts — OCR candidate provider for UIA-blind native windows.
 *
 * Invoked only when the UIA lane detected a blind target (uia_blind_*).
 * Runs the full SoM pipeline and maps SomElement[] to UiEntityCandidate[].
 *
 * Design notes (from Opus review, commit 2-5):
 *   - EntityLocator.ocr does NOT exist; locator is omitted for OCR candidates.
 *     The executor routes all source:"ocr" entities to mouse click.
 *   - confidence comes from SomElement.confidence (calibrateOcrConfidence minimum).
 *   - UIA candidates are passed as a dictionary for snap-correction inside runSomPipeline.
 *
 * Warnings:
 *   ocr_provider_failed  — runSomPipeline threw or returned 0 elements on error
 *   ocr_attempted_empty  — pipeline ran successfully but returned 0 candidates
 *   target_hwnd_unparseable — the target carried an hwnd this could not read, so the OCR ran
 *                             against the foreground window while the candidates carry the
 *                             caller's handle as their target id (ADR-036)
 */

import type { Rect, UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import type { OcrDictionaryEntry } from "../../engine/ocr-bridge.js";
import { detectOcrLanguage } from "../../engine/ocr-bridge.js";
import { getOcrVisualAdapter } from "../../engine/vision-gpu/ocr-adapter-registry.js";

export async function fetchOcrCandidates(
  target: TargetSpec | undefined,
  dictionary: OcrDictionaryEntry[] = [],
  // ADR-024 Seed-2 S4 — optional image-local ROI forwarded to `runSomPipeline`
  // so the visual-only post-action path OCRs only the changed region. Omitted
  // by the existing discover lane caller → full-window OCR unchanged.
  roi?: Rect,
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return { candidates: [], warnings: [] };
  }

  const windowTitle = target.windowTitle ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";
  // ADR-036 — the same parse the UIA halves use. This line sat outside the try below, so a
  // malformed handle threw straight out of the provider while the UIA side quietly read by
  // title: one bad value, two different answers to "which window".
  //
  // Leniency here has its own cost, though: with no handle the title falls back to `@active`
  // and this OCRs the FOREGROUND window while labelling the candidates with the handle the
  // caller asked for. Loud is better than wrong, so it says so (2ゲート目の指摘).
  const hwnd        = parseTargetHwnd(target) ?? null;
  const hwndWarnings = hwnd === null && target?.hwnd ? ["target_hwnd_unparseable"] : [];

  try {
    const { runSomPipeline } = await import("../../engine/ocr-bridge.js");
    const somResult = await runSomPipeline(windowTitle, hwnd, detectOcrLanguage(), 2, "auto", false, dictionary, roi);

    if (somResult.elements.length === 0) {
      return { candidates: [], warnings: [...hwndWarnings, "ocr_attempted_empty"] };
    }

    const candidates: UiEntityCandidate[] = somResult.elements.map((el): UiEntityCandidate => ({
      source: "ocr",
      target: { kind: "window", id: targetId },
      // ADR-029: the handle the capture actually resolved, so the viewport gate
      // judges that window instead of re-resolving `targetId` (often a title
      // query) at act time.
      ...(somResult.resolvedHwnd !== undefined && { originHwnd: somResult.resolvedHwnd }),
      // locator omitted — EntityLocator has no .ocr slot; executor routes to mouse click
      role: "label",
      label: el.text,
      rect: el.region, // screen-absolute (SomElement.region)
      actionability: ["click"],
      confidence: el.confidence ?? 0.7,
      observedAtMs: Date.now(),
      provisional: false,
    }));

    // Phase 1 dataplane hook: feed this SoM run into the visual lane so the
    // next desktop_discover returns the same entities under source:"visual_gpu".
    // Pass somResult.elements so the adapter skips a duplicate runSomPipeline call.
    // Fire-and-forget: adapter has its own debounce; errors never block OCR return.
    try {
      const adapter = getOcrVisualAdapter(target);
      void adapter.pollOnce(target, dictionary, somResult.elements, somResult.resolvedHwnd).catch(() => {
        /* adapter logs its own errors; never block the OCR return */
      });
    } catch (err) {
      console.error("[ocr-provider] visual adapter hook failed:", err);
      // Continue — primary OCR result is unaffected.
    }

    return { candidates, warnings: [...hwndWarnings] };
  } catch (err) {
    console.error("[ocr-provider] fetchOcrCandidates failed:", err);
    return { candidates: [], warnings: [...hwndWarnings, "ocr_provider_failed"] };
  }
}
