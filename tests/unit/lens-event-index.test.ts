/**
 * tests/unit/lens-event-index.test.ts
 *
 * Unit tests for LensEventIndex — event-to-lens routing.
 */

import { describe, it, expect } from "vitest";
import {
  createLensEventIndex,
  addLensToIndex,
  removeLensFromIndex,
  rebuildLensEventIndex,
  lensesForHwnd,
  lensesForForegroundEvent,
} from "../../src/engine/perception/lens-event-index.js";
import type { PerceptionLens, WindowIdentity, LensSpec } from "../../src/engine/perception/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const baseIdentity: WindowIdentity = {
  hwnd: "100",
  pid: 1234,
  processName: "notepad.exe",
  processStartTimeMs: 1700000000000,
  titleResolved: "Untitled",
};

function makeLens(
  lensId: string,
  hwnd: string,
  maintain: string[],
  pid = 1234
): PerceptionLens {
  const identity: WindowIdentity = { ...baseIdentity, hwnd, pid };
  return {
    lensId,
    spec: {
      name: lensId,
      target: { kind: "window", match: { titleIncludes: "test" } },
      maintain: maintain as LensSpec["maintain"],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    },
    binding: { hwnd, windowTitle: "Test" },
    boundIdentity: identity,
    fluentKeys: maintain.map(m => `window:${hwnd}.${m}`),
    registeredAtSeq: 0,
    registeredAtMs: Date.now(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LensEventIndex — add / remove", () => {
  it("adds a lens to byHwnd", () => {
    const index = createLensEventIndex();
    const lens = makeLens("perc-1", "100", ["target.foreground"]);
    addLensToIndex(index, lens);
    expect(index.byHwnd.get("100")?.has("perc-1")).toBe(true);
  });

  it("adds a lens to byPid", () => {
    const index = createLensEventIndex();
    const lens = makeLens("perc-1", "100", ["target.foreground"], 9999);
    addLensToIndex(index, lens);
    expect(index.byPid.get(9999)?.has("perc-1")).toBe(true);
  });

  it("marks foregroundSensitive when lens maintains target.foreground", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
    expect(index.foregroundSensitive.has("perc-1")).toBe(true);
    expect(index.modalSensitive.has("perc-1")).toBe(false);
  });

  it("marks modalSensitive when lens maintains modal.above", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["modal.above"]));
    expect(index.modalSensitive.has("perc-1")).toBe(true);
  });

  it("marks zOrderSensitive when lens maintains target.zOrder", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.zOrder"]));
    expect(index.zOrderSensitive.has("perc-1")).toBe(true);
  });

  it("lens can be in multiple sensitivity sets", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground", "modal.above", "target.zOrder"]));
    expect(index.foregroundSensitive.has("perc-1")).toBe(true);
    expect(index.modalSensitive.has("perc-1")).toBe(true);
    expect(index.zOrderSensitive.has("perc-1")).toBe(true);
  });

  it("removes a lens from all buckets", () => {
    const index = createLensEventIndex();
    const lens = makeLens("perc-1", "100", ["target.foreground", "modal.above", "target.zOrder"], 1234);
    addLensToIndex(index, lens);
    removeLensFromIndex(index, lens);
    expect(index.byHwnd.get("100")).toBeUndefined();
    expect(index.byPid.get(1234)).toBeUndefined();
    expect(index.foregroundSensitive.has("perc-1")).toBe(false);
    expect(index.modalSensitive.has("perc-1")).toBe(false);
    expect(index.zOrderSensitive.has("perc-1")).toBe(false);
  });

  it("removing one lens leaves others in the same hwnd bucket", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
    addLensToIndex(index, makeLens("perc-2", "100", ["target.title"]));
    removeLensFromIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
    expect(index.byHwnd.get("100")?.has("perc-2")).toBe(true);
    expect(index.byHwnd.get("100")?.has("perc-1")).toBe(false);
  });
});

describe("LensEventIndex — rebuild", () => {
  it("rebuilds from a collection of lenses", () => {
    const lenses = [
      makeLens("perc-1", "100", ["target.foreground", "modal.above"]),
      makeLens("perc-2", "200", ["target.title"]),
    ];
    const index = rebuildLensEventIndex(lenses);
    expect(index.byHwnd.get("100")?.has("perc-1")).toBe(true);
    expect(index.byHwnd.get("200")?.has("perc-2")).toBe(true);
    expect(index.foregroundSensitive.has("perc-1")).toBe(true);
    expect(index.modalSensitive.has("perc-1")).toBe(true);
    expect(index.foregroundSensitive.has("perc-2")).toBe(false);
  });
});

describe("LensEventIndex — routing", () => {
  it("lensesForHwnd returns only lenses bound to that hwnd", () => {
    const index = createLensEventIndex();
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
    addLensToIndex(index, makeLens("perc-2", "200", ["target.foreground"]));
    const result = lensesForHwnd(index, "100");
    expect(result.has("perc-1")).toBe(true);
    expect(result.has("perc-2")).toBe(false);
  });

  it("lensesForHwnd returns empty set for unknown hwnd", () => {
    const index = createLensEventIndex();
    expect(lensesForHwnd(index, "999").size).toBe(0);
  });

  it("lensesForForegroundEvent includes direct hwnd match AND all foreground-sensitive lenses", () => {
    const index = createLensEventIndex();
    // perc-1 is bound to hwnd 100 and is foreground-sensitive
    addLensToIndex(index, makeLens("perc-1", "100", ["target.foreground"]));
    // perc-2 is bound to hwnd 200 and is foreground-sensitive (its window lost foreground)
    addLensToIndex(index, makeLens("perc-2", "200", ["target.foreground"]));
    // perc-3 is bound to hwnd 300 but NOT foreground-sensitive
    addLensToIndex(index, makeLens("perc-3", "300", ["target.title"]));

    const result = lensesForForegroundEvent(index, "100");
    // perc-1: direct hwnd match
    expect(result.has("perc-1")).toBe(true);
    // perc-2: foreground-sensitive (needs to update its foreground=false)
    expect(result.has("perc-2")).toBe(true);
    // perc-3: not foreground-sensitive and not bound to hwnd 100
    expect(result.has("perc-3")).toBe(false);
  });
});
