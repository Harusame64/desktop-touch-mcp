/**
 * ocr-provider.ts — OCR candidate provider for UIA-blind native windows.
 *
 * Invoked only when the UIA lane detected a blind target (uia_blind_*).
 * Runs the full SoM pipeline and maps SomElement[] to UiEntityCandidate[].
 *
 * Design notes (from Opus review, commit 2-5):
 *   - EntityLocator.ocr does NOT exist; locator is omitted for OCR candidates.
 *     The executor routes all source:"ocr" entities to mouse click.
 *   - sourceId is omitted to avoid resolver deprecation warnings.
 *   - confidence comes from SomElement.confidence (calibrateOcrConfidence minimum).
 *   - UIA candidates are passed as a dictionary for snap-correction inside runSomPipeline.
 *
 * Warnings:
 *   ocr_provider_failed  — runSomPipeline threw or returned 0 elements on error
 *   ocr_attempted_empty  — pipeline ran successfully but returned 0 candidates
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import type { OcrDictionaryEntry } from "../../engine/ocr-bridge.js";

export async function fetchOcrCandidates(
  target: TargetSpec | undefined,
  dictionary: OcrDictionaryEntry[] = [],
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return { candidates: [], warnings: [] };
  }

  const windowTitle = target.windowTitle ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";
  const hwnd        = target.hwnd ? BigInt(target.hwnd) : null;

  try {
    const { runSomPipeline } = await import("../../engine/ocr-bridge.js");
    const somResult = await runSomPipeline(windowTitle, hwnd, "ja", 2, "auto", false, dictionary);

    if (somResult.elements.length === 0) {
      return { candidates: [], warnings: ["ocr_attempted_empty"] };
    }

    const candidates: UiEntityCandidate[] = somResult.elements.map((el): UiEntityCandidate => ({
      source: "ocr",
      target: { kind: "window", id: targetId },
      // locator omitted — EntityLocator has no .ocr slot; executor routes to mouse click
      role: "label",
      label: el.text,
      rect: el.region, // screen-absolute (SomElement.region)
      actionability: ["click"],
      confidence: el.confidence ?? 0.7,
      observedAtMs: Date.now(),
      provisional: false,
    }));

    return { candidates, warnings: [] };
  } catch (err) {
    console.error("[ocr-provider] fetchOcrCandidates failed:", err);
    return { candidates: [], warnings: ["ocr_provider_failed"] };
  }
}
