/**
 * desktop-act-roi-carry-forward.test.ts — ADR-024 Seed-2 S5b-3 R1 (headed e2e).
 *
 * The LIVE half of the R1 carry-forward pin (the deterministic half is
 * `tests/unit/guarded-touch.test.ts` "S5b-3 R1 carry-forward"). It spawns the
 * visual-only canvas with a SMALL anchor font — the regime where ROI-crop OCR is
 * least reliable (a crop ≈ a text line defeats Windows OCR's line segmentation,
 * the S5b-2 root-cause that forced the carry-forward pivot) — and proves that a
 * real `desktop_act` STILL reports no `entity_disappeared`.
 *
 * Why this matters end-to-end: the fold's diff baseline carries the FULL-WINDOW
 * discover OCR entities forward rather than re-OCRing the ROI, so the touched
 * anchor keeps its identity even when the ROI-OCR would read nothing. The
 * companion `desktop-act-roi-capture.test.ts` runs the same flow at the default
 * 34pt; this file stresses the small-text regime that historically broke.
 *
 * Gating mirrors the repo convention (`const IS_HEADED = Boolean(process.env.HEADED)`,
 * `browser-cdp.test.ts:29`): a REAL OS click on a real GUI + the native engine, so
 * HEADED-only and CI-skipped (also skipped when the fixture cannot be spawned).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getDesktopFacade,
  desktopActRawHandler,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import { spawnVisualOnlyCanvas, type VisualOnlyCanvas } from "./helpers/visual-only-canvas.js";

const IS_HEADED = Boolean(process.env.HEADED);

// Small anchor font (11pt) = the ROI-OCR-hostile regime. Full-window discover OCR
// still reads it (line context); a tight ROI crop is where it degrades.
const canvas: VisualOnlyCanvas | null = IS_HEADED ? await spawnVisualOnlyCanvas({ fontSize: 11 }) : null;

function parseHandler(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected text content");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe.runIf(IS_HEADED && canvas !== null)("desktop_act R1 carry-forward on small text (S5b-3 headed e2e)", () => {
  let prevAutoGuard: string | undefined;
  beforeAll(() => {
    prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  });
  afterAll(() => {
    if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
    canvas?.close();
    _resetFacadeForTest();
  });

  it("touched small-text anchor keeps its identity (no entity_disappeared) on a real folded act", async () => {
    const facade = getDesktopFacade();

    // Discover the canvas — visual-only (UIA-blind) + small OCR anchors.
    const disc = await facade.see({ target: { windowTitle: canvas!.title } });
    const warnings = (disc as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => String(w).startsWith("uia_blind"))).toBe(true);

    // The full-window discover OCR must still find the small anchor (it has line
    // context); selecting by label avoids the (also-OCR'd) title bar.
    const ent = disc.entities.find(
      (e) =>
        (e.label === "TARGET ALPHA" || e.label === "ZONE BETA") &&
        e.sources?.includes("ocr") &&
        e.primaryAction === "click",
    );
    expect(
      ent,
      "full-window discover OCR should read the small-text anchor (carry-forward source)",
    ).toBeDefined();

    const result = await desktopActRawHandler({
      lease: ent!.lease,
      action: "click",
      returnCapture: "on-change",
    });
    const parsed = parseHandler(result.content);
    expect(parsed["ok"]).toBe(true);

    // THE R1 INVARIANT: the diff baseline is carry-forward of the discover OCR, so
    // the touched anchor keeps the entityId the full-window OCR minted — it must
    // NOT read as disappeared, EVEN THOUGH a ROI-crop OCR on this small text would
    // be unreliable. A regression that re-coupled the diff to ROI-OCR would surface
    // here as a spurious entity_disappeared.
    expect(parsed["diff"] as string[]).not.toContain("entity_disappeared");

    // The roiCapture still rides along (the change region was painted) — its
    // entity preview may legitimately be empty on this small-text crop; the diff
    // correctness above does not depend on it.
    const cap = parsed["roiCapture"] as { entities?: unknown[]; source?: string } | undefined;
    if (cap) {
      expect(Array.isArray(cap.entities)).toBe(true);
      expect(cap.source).toBe("frame_diff");
    }
  });
});
