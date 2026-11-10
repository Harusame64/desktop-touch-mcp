/**
 * internal #215 — a window's session is keyed by its handle as parsed, not as spelled.
 *
 * `hwnd: "500"` and `hwnd: "0x1F4"` are one window. They were two sessions, so reading the window
 * again under one spelling left the leases from the other current: an act could go ahead on a
 * lease from a view the caller had already replaced.
 */
import { describe, expect, it, vi } from "vitest";

import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const save = {
  source: "uia", target: { kind: "window", id: "500" }, label: "Save", role: "button",
  rect: { x: 10, y: 10, width: 60, height: 20 }, actionability: ["invoke"], confidence: 0.9,
  observedAtMs: 0, provisional: false, locator: { uia: { name: "Save" } },
} as unknown as UiEntityCandidate;

describe("one window, one session, however its handle is spelled (internal #215)", () => {
  it("makes a lease from the decimal spelling stale once the hex spelling is read", async () => {
    const execute = vi.fn(async () => "uia" as const);
    const facade = new DesktopFacade(async () => [save], { executorFn: execute });
    const first = await facade.see({ target: { hwnd: "500" } });
    const second = await facade.see({ target: { hwnd: "0x1F4" } });
    expect(second.viewId).not.toBe(first.viewId);

    const old = await facade.touch({ lease: first.entities.find((e) => e.label === "Save")!.lease });
    expect(old.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    const fresh = await facade.touch({ lease: second.entities.find((e) => e.label === "Save")!.lease });
    expect(fresh.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
