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

describe("everything that asks 'which window' asks the aim", () => {
  // The disease this ADR is named for: several sites answered the question separately, from the
  // same spec, and disagreed. These two both had their own ladder — one falling back to the
  // foreground window, the other to a title search — and for a bare `desktop_discover()` neither
  // found what the providers had already resolved.
  async function facadeAfterBareDiscover() {
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({
        candidates: [candidate("2624042")],
        warnings: [],
        target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
      }),
      // A foreground that is NOT the discovered window, so a site that falls back to it is visible
      // rather than accidentally right.
      getFocusedHwnd: () => 999999n,
    });
    const out = await facade.see({});
    return { facade, viewId: out.viewId };
  }

  it("Stage 5 resolves the window discover read, not the one in front now", async () => {
    const { facade, viewId } = await facadeAfterBareDiscover();
    expect(facade.resolveHwndForViewId(viewId)).toBe(2624042n);
  });

  it("the frame-diff capture resolves the same window", async () => {
    // This one matters for a different reason: it captures its PRE frame before the click, so
    // falling back to the foreground diffs a window the action never touched and reports
    // `no_change` — which is exactly what a bare discover used to do here.
    const { facade, viewId } = await facadeAfterBareDiscover();
    await expect(facade.resolveTargetHwndForFrameDiff(viewId)).resolves.toBe(2624042n);
  });

  it("still falls back when the read resolved nothing at all", async () => {
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({ candidates: [], warnings: ["no_provider_matched"] }),
      getFocusedHwnd: () => 999999n,
    });
    const out = await facade.see({});
    expect(facade.resolveHwndForViewId(out.viewId)).toBe(999999n);
  });
});

describe("the identity is the one from the read, not from the moment it was filed", () => {
  // Gate 1, 2026-09-09: the baseline was being read at `see()` time. On a cache hit that is a
  // different moment from the read, so a window that closed and had its handle recycled in between
  // would be baselined against its NEW owner — the act-time comparison then answers "same" and
  // waves through an action against a window nobody discovered. The identity is evidence about the
  // observation, so it travels with the observation.
  it("refuses an act when the handle changed hands between the read and the act", async () => {
    // End to end, which is the only way to see that the identity survives every hop: read →
    // provider result → session aim → executor factory → comparison. Each of those was a place the
    // value used to be dropped.
    const fromTheRead = { hwnd: 2624042n, pid: 1234, processName: "notepad.exe", processStartTimeMs: 111 };
    const facade = new DesktopFacade(async () => [], {
      ingress: ingressReturning({
        candidates: [candidate("2624042")],
        warnings: [],
        target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
        identity: fromTheRead,
      }),
      executorDeps: {
        uiaClick:       vi.fn(async () => {}),
        uiaSetValue:    vi.fn(async () => {}),
        cdpClick:       vi.fn(async () => {}),
        cdpFill:        vi.fn(async () => {}),
        terminalSend:   vi.fn(async () => {}),
        keyboardTypeBg: vi.fn(async () => {}),
        mouseClick:     vi.fn(async () => {}),
        // The window closed and Windows gave the number to something else.
        aimIdentity:    vi.fn(async () => ({ ...fromTheRead, pid: 9999, processName: "chrome.exe" })),
      },
    });

    const seen = await facade.see({});
    const result = await facade.touch({ lease: seen.entities[0]!.lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aim_identity_changed");
  });

  it("keeps identity and candidates together in the cache", async () => {
    const identity = { hwnd: 2624042n, pid: 1234, processName: "notepad.exe", processStartTimeMs: 111 };
    const fetchFn = vi.fn(async () => ({
      candidates: [candidate("2624042")],
      warnings: [],
      target: { hwnd: "2624042", windowTitle: "CELL BUTTONS" },
      identity,
    }));
    const ingress = new SnapshotIngress(fetchFn);
    await ingress.getSnapshot("window:__default__");
    const cached = await ingress.getSnapshot("window:__default__");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The cache hit hands back the identity read WITH those candidates. Re-reading it here would
    // describe whatever owns the handle now, which is the window the guard exists to refuse.
    expect(cached.identity).toEqual(identity);
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
