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
 *   target_hwnd_unparseable — the target carried an hwnd this could not read. The OCR then runs
 *                             against `target.windowTitle` if there is one and against the
 *                             FOREGROUND window if there is not — either way not necessarily the
 *                             window the caller named, while the candidates still carry the
 *                             caller's raw handle string as their target id (ADR-036)
 */

import type { Rect, UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import type { OcrDictionaryEntry } from "../../engine/ocr-bridge.js";
import { detectOcrLanguage } from "../../engine/ocr-bridge.js";
import { getOcrVisualAdapter } from "../../engine/vision-gpu/ocr-adapter-registry.js";
import { probeLane } from "../../engine/aim-probe.js";

export async function fetchOcrCandidates(
  target: TargetSpec | undefined,
  dictionary: OcrDictionaryEntry[] = [],
  // ADR-024 Seed-2 S4 — optional image-local ROI forwarded to `runSomPipeline`
  // so the visual-only post-action path OCRs only the changed region. Omitted
  // by the existing discover lane caller → full-window OCR unchanged.
  roi?: Rect,
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return probeLane("ocr", "skipped", { why: "no_target" }, { candidates: [], warnings: [] });
  }

  const windowTitle = target.windowTitle ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";
  // ADR-036 — the same parse the UIA halves use. This line sat outside the try below, so a
  // malformed handle threw straight out of the provider while the UIA side quietly read by
  // title: one bad value, two different answers to "which window".
  //
  // Leniency here has its own cost, though. With the handle unread, the window is whatever
  // `windowTitle` finds — the caller's title if it passed one, and the FOREGROUND window when it
  // did not (`@active`) — while the candidates keep the caller's raw handle string as their
  // target id. Neither is necessarily the window that was asked for, so the warning says the
  // handle was unreadable rather than naming a window it cannot vouch for (2ゲート目の指摘).
  const hwnd        = parseTargetHwnd(target) ?? null;
  const hwndWarnings = hwnd === null && target?.hwnd ? ["target_hwnd_unparseable"] : [];
  // ADR-036 item 14a — what this lane asks for, known before the capture, so one that throws still
  // says it.
  const asked = {
    windowTitle,
    targetId,
    scoped: hwnd !== null,
    pinnedHwnd: hwnd !== null ? hwnd.toString() : null,
    roi: roi ?? null,
  };

  try {
    const { runSomPipeline } = await import("../../engine/ocr-bridge.js");
    const somResult = await runSomPipeline(windowTitle, hwnd, detectOcrLanguage(), 2, "auto", false, dictionary, roi);
    // The handle the capture resolved — the one every entity below carries as `originHwnd` — beside
    // the one it was asked for, so a row shows the day those two differ.
    const read = { ...asked, resolvedHwnd: somResult.resolvedHwnd ?? null, elementCount: somResult.elements.length };

    if (somResult.elements.length === 0) {
      return probeLane("ocr", "read", read, { candidates: [], warnings: [...hwndWarnings, "ocr_attempted_empty"] });
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

    return probeLane("ocr", "read", read, { candidates, warnings: [...hwndWarnings] });
  } catch (err) {
    console.error("[ocr-provider] fetchOcrCandidates failed:", err);
    return probeLane("ocr", "failed", asked, { candidates: [], warnings: [...hwndWarnings, "ocr_provider_failed"] });
  }
}
