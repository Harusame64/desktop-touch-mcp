/**
 * internal #222 — `desktop_discover` of a window excluded from every tool surface says so.
 *
 * `normalizeTarget` rethrows `WindowExcludedError` for the key locker's own windows, so no lane reads
 * them. The ingress caught it as any other throw and answered `ingress_fetch_error`, whose advice is
 * to retry `desktop_discover` — a refusal that stays true for as long as the window is excluded,
 * dressed as a failure that passes. (Until #754 the second call served the read from before the
 * exclusion instead, internal #160.)
 */
import { describe, expect, it } from "vitest";

import { SnapshotIngress } from "../../src/engine/world-graph/candidate-ingress.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const excluded = () => new WindowExcludedError("WindowExcluded: target window belongs to the desktop-touch key locker");

describe("the ingress, when the target is excluded", () => {
  it("says window_excluded, not the retryable fetch error, and reads nothing", async () => {
    const result = await new SnapshotIngress(async () => { throw excluded(); }).getSnapshot("window:500");
    expect(result).toEqual({ candidates: [], warnings: ["window_excluded"], freshness: { from: "unavailable" } });
  });

  it("still says ingress_fetch_error for any other throw (the control)", async () => {
    const result = await new SnapshotIngress(async () => { throw new Error("WindowExcluded: a plain Error with the same words"); }).getSnapshot("window:500");
    expect(result.warnings).toEqual(["ingress_fetch_error"]);
  });
});

describe("the constraints it becomes", () => {
  it("names the window as excluded, and gives that as the reason for no entities", () => {
    expect(deriveViewConstraints(["window_excluded"], 0)).toEqual({ window: "window_excluded", entityZeroReason: "window_excluded" });
  });

  it("comes first: its remedy (another window) is not a retry, a wait or a scroll", () => {
    expect(deriveViewConstraints(["uia_provider_failed", "query_no_match", "ingress_fetch_error", "window_excluded"], 0)?.entityZeroReason).toBe("window_excluded");
  });
});

describe("through the facade", () => {
  it("answers no entities, window_excluded, and no advice to retry", async () => {
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress(async () => { throw excluded(); }), executorFn: async () => "uia" });
    const view = await facade.see({ target: { hwnd: "500" } });
    expect(view.entities).toEqual([]);
    expect(view.warnings).toContain("window_excluded");
    expect(view.warnings).not.toContain("ingress_fetch_error");
    expect(view.constraints).toMatchObject({ window: "window_excluded", entityZeroReason: "window_excluded" });
    expect(view.freshness).toEqual({ from: "unavailable" });
  });
});
