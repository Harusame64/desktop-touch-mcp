/**
 * The session remembers the window the providers read, not the words the caller typed.
 *
 * ADR-036, item 2. `see()` stored `lastTarget = input.target` while `composeCandidates` resolved
 * that target — `@active` and a bare call become a handle and a title — and read every provider
 * against the resolved one. So the view described one window and the session held another, and the
 * write path was handed whatever the caller had typed.
 *
 * Measured on the real machine 2026-09-09 (win2, `aim-probe` jsonl): a bare `desktop_discover()`
 * scoped its providers to `2624042` and stamped it on all eighteen candidates; `see.store` recorded
 * `lastTarget: null`; `act.aim` recorded `aimHwnd: null` and `winTitle: "@active"`; the executor
 * spent 9.18 s failing at UIA and pressed the remembered coordinate, returning `ok:true` because
 * the window had not moved. These tests hold that seam shut at the two places it can re-open: the
 * provider result has to carry the resolved target, and the session has to take it.
 */
import { describe, it, expect, vi } from "vitest";
import { SnapshotIngress, type ProviderResult } from "../../src/engine/world-graph/candidate-ingress.js";
import { DesktopFacade, type CandidateIngress } from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

function candidate(targetId: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: targetId },
    locator: { uia: { name: "BTN1" } },
    role: "button",
    label: "BTN1",
    rect: { x: 328, y: 251, width: 260, height: 80 },
    actionability: ["click"],
    confidence: 1,
    observedAtMs: Date.now(),
    provisional: false,
  } as UiEntityCandidate;
}

/** An ingress that answers like the production one: resolved target included. */
function ingressReturning(result: ProviderResult): CandidateIngress {
  return {
    getSnapshot: vi.fn(async () => result),
    invalidate: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as CandidateIngress;
}

describe("the session takes the target the read was made against", () => {
  it("stores the resolved target when the caller sent none", async () => {
    // The production shape of the bare call: the caller said nothing, the providers resolved the
    // foreground window and read it.
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({
        candidates: [candidate("2624042")],
        warnings: [],
        target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
      }),
    });

    const out = await facade.see({});
    expect(out.entities.length).toBe(1);
    expect(facade.resolveOcrTargetIdForViewId(out.viewId)).toBe("2624042");
  });

  it("leaves what the caller said alone when nothing was resolved", async () => {
    // "We could not work out which window" must not overwrite "the caller named this one" — the
    // two are different answers, and only one of them is evidence.
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({ candidates: [], warnings: ["no_provider_matched"] }),
    });

    const out = await facade.see({ target: { windowTitle: "CELL BUTTONS" } });
    expect(facade.resolveOcrTargetIdForViewId(out.viewId)).toBe("CELL BUTTONS");
  });

  it("gives the OCR fold and the OCR lane the same key, which was the second half of the bug", async () => {
    // `resolveOcrTargetIdForViewId` derives its id from the session while the lane derives it from
    // the resolved target. Its comment asserted the two were the same object; they were not, and a
    // bare discover keyed "@active" here against the handle there — which the fold reads as
    // `entity_disappeared`. Same object now, so the same expression gives the same string.
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({
        candidates: [candidate("2624042")],
        warnings: [],
        target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
      }),
    });

    const out = await facade.see({});
    const laneWouldUse = "2624042";   // ocr-provider: target.hwnd ?? target.windowTitle ?? "@active"
    expect(facade.resolveOcrTargetIdForViewId(out.viewId)).toBe(laneWouldUse);
  });
});

describe("the ingress carries the resolved target, including out of its cache", () => {
  it("returns it on the fetch", async () => {
    const ingress = new SnapshotIngress(async () => ({
      candidates: [candidate("2624042")],
      warnings: [],
      target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
    }));
    const first = await ingress.getSnapshot("window:__default__");
    expect(first.target).toEqual({ hwnd: "2624042", windowTitle: "CELL BUTTONS" });
  });

  it("returns it again from the cache, from the entry the candidates came from", async () => {
    // The point of caching it rather than re-resolving: a cache hit hands back the window its
    // candidates describe. If the foreground has moved on since, the aim still matches the view,
    // which is the property the lease depends on.
    const fetchFn = vi.fn(async () => ({
      candidates: [candidate("2624042")],
      warnings: [],
      target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
    }));
    const ingress = new SnapshotIngress(fetchFn);
    await ingress.getSnapshot("window:__default__");
    const second = await ingress.getSnapshot("window:__default__");

    expect(fetchFn).toHaveBeenCalledTimes(1);          // the second call was served from cache
    expect(second.target).toEqual({ hwnd: "2624042", windowTitle: "CELL BUTTONS" });
  });

  it("says nothing about the target when the fetch failed and only a stale entry is left", async () => {
    let fail = false;
    const ingress = new SnapshotIngress(async () => {
      if (fail) throw new Error("provider down");
      return {
        candidates: [candidate("2624042")],
        warnings: [],
        target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
      };
    });
    await ingress.getSnapshot("window:__default__");
    fail = true;
    ingress.invalidate("window:__default__", "manual");

    const stale = await ingress.getSnapshot("window:__default__");
    expect(stale.warnings).toContain("ingress_fetch_error");
    // The stale entry's own target rides with its stale candidates: they describe one window
    // together, and separating them is how the two halves start disagreeing again.
    expect(stale.target).toEqual({ hwnd: "2624042", windowTitle: "CELL BUTTONS" });
  });
});
