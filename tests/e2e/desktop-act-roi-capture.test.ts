/**
 * desktop-act-roi-capture.test.ts — ADR-024 Seed-2 S6 headed-gated e2e.
 *
 * Live, reproducible regression asset for the visual-only roiCapture fold: spawn
 * the UIA-blind canvas fixture, discover an OCR anchor, `desktop_act` with
 * `returnCapture:"on-change"`, and assert the response carries a roiCapture whose
 * `somImage` is a real PNG crop and whose `roi` is localized (not full-window) —
 * i.e. the click's repaint, captured via the S5c frame-diff path, in ONE call.
 *
 * Gating (matches the repo convention — `const IS_HEADED = Boolean(process.env.HEADED)`,
 * `browser-cdp.test.ts:29`): this performs a REAL OS click and needs the native
 * engine (PrintWindow / SSIM / OCR) on a real GUI, so it is **HEADED-only** and
 * CI-skipped. It also skips when the fixture window cannot be spawned (no GUI).
 *
 * The bench (`benches/adr-024-seed2-roundtrip.mjs`) shares this fixture and
 * measures the round-trip numbers; this file is the assertion/regression half.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getDesktopFacade,
  desktopActRawHandler,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import { spawnVisualOnlyCanvas, type VisualOnlyCanvas } from "./helpers/visual-only-canvas.js";
import { readCaptureBytes, REF_URI_PREFIX } from "../../src/engine/screenshot-cache.js";

const IS_HEADED = Boolean(process.env.HEADED);

// Spawn the fixture up front (top-level await, as blank-window.ts does) so the
// describe gate can see whether a real GUI window came up.
const canvas: VisualOnlyCanvas | null = IS_HEADED ? await spawnVisualOnlyCanvas() : null;

function parseHandler(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected text content");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

// runIf: HEADED env AND the fixture actually appeared. On CI / headless both are
// false → the whole suite is skipped (no real OS click attempted).
describe.runIf(IS_HEADED && canvas !== null)("desktop_act roiCapture (S6 headed e2e)", () => {
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

  it("folds a localized PNG roiCapture into a single act on the visual-only canvas", async () => {
    const facade = getDesktopFacade();

    // Discover the canvas — visual-only (UIA-blind) regime + OCR anchors.
    const disc = await facade.see({ target: { windowTitle: canvas!.title } });
    const warnings = (disc as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => String(w).startsWith("uia_blind"))).toBe(true);

    // Select an anchor by its label, NOT the first OCR entity — the window's
    // (long, unique) title bar is also OCR'd, and clicking it would land on the
    // title bar (no content change → no_change → no roiCapture). The anchors are
    // the only in-canvas localized-change targets.
    const ent =
      disc.entities.find(
        (e) =>
          (e.label === "TARGET ALPHA" || e.label === "ZONE BETA") &&
          e.sources?.includes("ocr") &&
          e.primaryAction === "click",
      );
    expect(ent, "expected the TARGET ALPHA / ZONE BETA OCR anchor on the canvas").toBeDefined();

    // Act with returnCapture:on-change → the click toggles the anchor's bar, a
    // localized repaint the frame-diff path should detect.
    const result = await desktopActRawHandler({
      lease: ent!.lease,
      action: "click",
      returnCapture: "on-change",
    });
    const parsed = parseHandler(result.content);
    expect(parsed["ok"]).toBe(true);

    // ADR-024 S5b R1 (entityId stability, end-to-end) — the fold re-OCRs the ROI
    // and feeds those candidates to the diff. The clicked OCR anchor's text is
    // stable (only the bar below it toggles), so the touched entity must survive
    // with the SAME entityId the full-window discover OCR minted — i.e. it must
    // NOT read as `entity_disappeared`. A target-id / snap mismatch in
    // somElementsToCandidates would surface here as a spurious disappearance.
    expect(parsed["diff"] as string[]).not.toContain("entity_disappeared");

    const cap = parsed["roiCapture"] as
      | { roi?: { width: number; height: number }; somImage?: string | null; somImageRef?: string; entities?: unknown[]; source?: string }
      | undefined;
    expect(cap, "act should bundle roiCapture on a visual-only localized change").toBeDefined();

    // ADR-026: the crop is delivered by-ref (somImage null by default). Resolve
    // the ref and verify it reads back a real PNG crop (magic bytes 89 50 4E 47).
    expect(cap!.somImage).toBeNull();
    expect(typeof cap!.somImageRef).toBe("string");
    expect(cap!.somImageRef!.startsWith(REF_URI_PREFIX)).toBe(true);
    const captureId = cap!.somImageRef!.slice(REF_URI_PREFIX.length);
    const { data } = readCaptureBytes(captureId);
    expect(data.subarray(0, 4).toString("hex")).toBe("89504e47");

    // The same ref is attached as a resource_link content block.
    const link = result.content.find((c) => c.type === "resource_link") as { uri?: string } | undefined;
    expect(link?.uri).toBe(cap!.somImageRef);

    // entities is a (lease-less) preview array.
    expect(Array.isArray(cap!.entities)).toBe(true);

    // roi is localized — the frame-diff bbox, well under the 800×600 client area
    // (a full-window fallback would be ~the whole window). Proves the click's own
    // repaint was captured, not a whole-window grab.
    expect(cap!.roi).toBeDefined();
    expect(cap!.roi!.width * cap!.roi!.height).toBeLessThan(800 * 600 * 0.6);

    // Provenance is the frame-diff regime.
    expect(cap!.source).toBe("frame_diff");
  });
});
