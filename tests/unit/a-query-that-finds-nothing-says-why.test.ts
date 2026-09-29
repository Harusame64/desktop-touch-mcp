/**
 * internal #211 (S9, win2, 2026-09-29) — a discover `query` that matches nothing says so.
 *
 * `query:"J40"` on Excel came back as an empty list with nothing else: the cell was off-screen (not
 * in the UIA tree at any cap), its value is not exposed by UIA at all, and the read was also cut at
 * its cap. The caller could not tell which, and guessed between tools. The reply's constraints now
 * carry `query: "no_match"`, and the description names the two recoveries that worked in S9.
 */
import { describe, expect, it, vi } from "vitest";

import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";

function candidate(label: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "Book1 - Excel" },
    label,
    role: "button",
    rect: { x: 10, y: 10, width: 60, height: 20 },
    actionability: ["click"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
  } as unknown as UiEntityCandidate;
}

const facade = () => new DesktopFacade(async () => [candidate("A1"), candidate("B1")], { executorFn: async () => "uia" });

describe("a query that matches nothing", () => {
  it("says query_no_match in the constraints, and gives it as the reason the list is empty", async () => {
    const view = await facade().see({ target: { windowTitle: "Book1 - Excel" }, query: "J40" });
    expect(view.entities).toEqual([]);
    expect(view.constraints).toEqual({ query: "no_match", entityZeroReason: "query_no_match" });
  });

  it("does not put it in warnings[], which says the read may be partial (gate 2)", async () => {
    const view = await facade().see({ target: { windowTitle: "Book1 - Excel" }, query: "J40" });
    expect(view.warnings ?? []).not.toContain("query_no_match");
  });

  it("says nothing of the kind when the query matches", async () => {
    const view = await facade().see({ target: { windowTitle: "Book1 - Excel" }, query: "A1" });
    expect(view.entities.map((e) => e.label)).toEqual(["A1"]);
    expect(view.constraints).toBeUndefined();
  });

  it("says nothing of the kind over a read that returned nothing: that is its own reason (gate 2)", async () => {
    const view = await new DesktopFacade(async () => [], { executorFn: async () => "uia" }).see({ target: { windowTitle: "Book1 - Excel" }, query: "J40" });
    expect(view.constraints?.query).toBeUndefined();
  });

  // Since internal #218 `SnapshotIngress` reads on every call; an injected ingress may still remember,
  // so the facade still tells it the read it missed on is over.
  function spyIngress() {
    const invalidate = vi.fn();
    const ingress = {
      getSnapshot: async () => ({ candidates: [candidate("A1")], warnings: [] }),
      invalidate,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    };
    return { ingress, invalidate };
  }

  it("ends the read it missed on, so a call after scrolling reads again instead of the cache (gate 2)", async () => {
    const { ingress, invalidate } = spyIngress();
    const f = new DesktopFacade(async () => [], { executorFn: async () => "uia", ingress });
    await f.see({ target: { hwnd: "500" }, query: "J40" });
    expect(invalidate).toHaveBeenCalledWith("window:500", "manual");
  });

  it("leaves the read alone when the query matched (the control)", async () => {
    const { ingress, invalidate } = spyIngress();
    const f = new DesktopFacade(async () => [], { executorFn: async () => "uia", ingress });
    await f.see({ target: { hwnd: "500" }, query: "A1" });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("the reason's rank", () => {
  it("comes after a gone window", () => {
    expect(deriveViewConstraints(["target_window_gone", "query_no_match"], 0)?.entityZeroReason).toBe("target_window_gone");
  });

  it("comes after a lane that failed or read blind, whose remedy is not scrolling (gate 2)", () => {
    expect(deriveViewConstraints(["uia_provider_failed", "query_no_match"], 0)?.entityZeroReason).toBe("all_providers_failed");
    expect(deriveViewConstraints(["uia_blind_single_pane", "visual_provider_warming", "query_no_match"], 0)?.entityZeroReason).toBe("uia_blind_visual_unready");
  });
});
