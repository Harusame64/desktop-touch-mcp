/**
 * ADR-024 Seed-2 S5 — `buildRoiPreviewEntities` unit tests.
 *
 * Pins the OQ-10 dedup contract: an ROI-OCR element is dropped only when it
 * BOTH overlaps a discover entity AND carries the same label — so an in-place
 * text change (same bounds, different text) is preserved (Codex PR #429 P2).
 */

import { describe, it, expect } from "vitest";

import {
  buildRoiPreviewEntities,
  somElementsToCandidates,
  type RoiOcrElement,
  type DiscoverEntityRef,
} from "../../src/tools/_roi-preview.js";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const RECT_A = { x: 100, y: 100, width: 40, height: 20 };

describe("buildRoiPreviewEntities (S5 OQ-10 dedup + mapping)", () => {
  it("maps an OCR element to a lease-less preview entity", () => {
    const els: RoiOcrElement[] = [{ text: "Save", region: RECT_A }];
    const out = buildRoiPreviewEntities(els, []);
    expect(out).toEqual([
      { label: "Save", role: "label", rect: RECT_A, actionability: ["click"] },
    ]);
  });

  it("drops an element that overlaps a discover entity with the SAME label", () => {
    const els: RoiOcrElement[] = [{ text: "Save", region: RECT_A }];
    const discover: DiscoverEntityRef[] = [{ rect: { ...RECT_A }, label: "Save" }];
    expect(buildRoiPreviewEntities(els, discover)).toEqual([]);
  });

  it("KEEPS an in-place text change (same rect, different label)", () => {
    // The act flipped a status label "Off" → "On" at the same bounds. This is
    // exactly the change roiCapture exists to surface — it must NOT be deduped.
    const els: RoiOcrElement[] = [{ text: "On", region: RECT_A }];
    const discover: DiscoverEntityRef[] = [{ rect: { ...RECT_A }, label: "Off" }];
    const out = buildRoiPreviewEntities(els, discover);
    expect(out).toEqual([
      { label: "On", role: "label", rect: RECT_A, actionability: ["click"] },
    ]);
  });

  it("normalizes labels (trim + case) when matching for dedup", () => {
    const els: RoiOcrElement[] = [{ text: "  SAVE ", region: RECT_A }];
    const discover: DiscoverEntityRef[] = [{ rect: { ...RECT_A }, label: "save" }];
    expect(buildRoiPreviewEntities(els, discover)).toEqual([]);
  });

  it("keeps an element with the same label but non-overlapping geometry", () => {
    const els: RoiOcrElement[] = [{ text: "Save", region: RECT_A }];
    const discover: DiscoverEntityRef[] = [
      { rect: { x: 500, y: 500, width: 40, height: 20 }, label: "Save" },
    ];
    expect(buildRoiPreviewEntities(els, discover)).toHaveLength(1);
  });

  it("keeps a partial overlap below the 0.5 IoU threshold even with same label", () => {
    // 25% area overlap → IoU ≈ 0.143 < 0.5 → not the same entity → kept.
    const els: RoiOcrElement[] = [{ text: "Save", region: { x: 0, y: 0, width: 10, height: 10 } }];
    const discover: DiscoverEntityRef[] = [
      { rect: { x: 5, y: 5, width: 10, height: 10 }, label: "Save" },
    ];
    expect(buildRoiPreviewEntities(els, discover)).toHaveLength(1);
  });

  it("returns [] for no OCR elements", () => {
    expect(buildRoiPreviewEntities([], [{ rect: RECT_A, label: "x" }])).toEqual([]);
  });
});

describe("somElementsToCandidates (S5b diff baseline mapping)", () => {
  const target = { kind: "window" as const, id: "hwnd-42" };

  it("mirrors the discover OCR candidate shape field-for-field", () => {
    const out = somElementsToCandidates(
      [{ text: "Save", region: RECT_A, confidence: 0.9 }],
      target,
      123,
    );
    expect(out).toEqual([
      {
        source: "ocr",
        target,
        role: "label",
        label: "Save",
        rect: RECT_A,
        actionability: ["click"],
        confidence: 0.9,
        observedAtMs: 123,
        provisional: false,
      },
    ]);
  });

  it("defaults confidence to 0.7 when the element omits it (matches fetchOcrCandidates)", () => {
    const out = somElementsToCandidates([{ text: "X", region: RECT_A }], target, 0);
    expect(out[0]?.confidence).toBe(0.7);
  });

  it("produces the SAME entityId as the discover OCR lane for the same label+rect+target (R1 structural half)", () => {
    // The discover OCR lane builds candidates exactly like ocr-provider's
    // fetchOcrCandidates. entityId = sha1(window:id | label | snapRect) — NOT
    // observedAtMs — so the ROI-crop candidate and the full-window discover
    // candidate for the same on-screen text must resolve to the same entityId.
    // (The real-OCR end-to-end half is the S5b-2 headed test.)
    const discoverOcr: UiEntityCandidate = {
      source: "ocr",
      target,
      role: "label",
      label: "TARGET ALPHA",
      rect: RECT_A,
      actionability: ["click"],
      confidence: 0.7,
      observedAtMs: 999, // different time — must NOT affect entityId
      provisional: false,
    };
    const roiOcr = somElementsToCandidates(
      [{ text: "TARGET ALPHA", region: { ...RECT_A } }],
      target,
      1,
    );
    const [discoverEntity] = resolveCandidates([discoverOcr], "gen-1");
    const [roiEntity] = resolveCandidates(roiOcr, "gen-1");
    expect(roiEntity?.entityId).toBe(discoverEntity?.entityId);
  });

  it("returns [] for no elements", () => {
    expect(somElementsToCandidates([], target, 0)).toEqual([]);
  });
});
