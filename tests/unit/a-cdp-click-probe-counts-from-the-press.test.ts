/**
 * #1054 — the CDP click no longer waits for the move's answer, and on a page the browser does not draw (a fully
 * covered window, minimized, a background tab) the move reaches the page only with the press, after the click
 * probe is in (win2's spike2, S1: 0/3 in every state). What the hover changes then lands inside the probe's window
 * and would read as the click's effect. With `fromPress` the probe counts from the press's own `pointerdown`
 * (or `mousedown`) and drops what the hover queued before it.
 *
 * The probe's page script runs against a small fake page: a MutationObserver whose records the cell delivers by
 * hand, and a window that keeps its capture listeners so the cell can fire the press.
 */
import { describe, expect, it } from "vitest";
import { buildInstallClickProbeExpr, buildReadClickProbeExpr } from "../../src/tools/browser.js";

type Listener = () => void;

function fakePage() {
  let callback: ((records: unknown[]) => void) | null = null;
  let queued: unknown[] = [];
  const listeners = new Map<string, Listener[]>();
  class FakeObserver {
    constructor(cb: (records: unknown[]) => void) { callback = cb; }
    observe() { /* the fake delivers by hand */ }
    disconnect() { callback = null; }
    takeRecords() { const r = queued; queued = []; return r; }
  }
  const win: Record<string, unknown> = {
    addEventListener(type: string, fn: Listener, capture: boolean) {
      expect(capture).toBe(true);
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  const doc = { body: {}, activeElement: null, querySelector: () => ({}), querySelectorAll: () => [] };
  const run = (expr: string) =>
    new Function("window", "document", "location", "MutationObserver", `return (${expr.trim()});`)(win, doc, { href: "about:blank" }, FakeObserver);
  return {
    run,
    /** A mutation the page made: queued, then delivered as the observer's callback would get it. */
    mutate(n = 1) { for (let i = 0; i < n; i++) queued.push({}); const r = queued; queued = []; callback?.(r); },
    /** A mutation queued but not yet delivered when the next event comes. */
    queue(n = 1) { for (let i = 0; i < n; i++) queued.push({}); },
    fire(type: string) { for (const fn of listeners.get(type) ?? []) fn(); },
    listenerCount() { return [...listeners.values()].reduce((a, l) => a + l.length, 0); },
  };
}

describe("#1054: the CDP click's probe counts from the press", () => {
  it("does not count what the hover changed before the press", () => {
    const p = fakePage();
    expect(p.run(buildInstallClickProbeExpr("#b", true))).toMatchObject({ ok: true });
    p.mutate(3); // the move, delivered with the press, opened a tooltip
    p.fire("pointerdown");
    p.fire("mousedown");
    p.mutate(2); // the click's own effect
    expect(p.run(buildReadClickProbeExpr())).toMatchObject({ ok: true, mutationCount: 2 });
  });

  it("drops the hover's records still queued when the press comes", () => {
    const p = fakePage();
    p.run(buildInstallClickProbeExpr("#b", true));
    p.queue(4);
    p.fire("pointerdown");
    p.mutate(1);
    expect(p.run(buildReadClickProbeExpr())).toMatchObject({ mutationCount: 1 });
  });

  it("counts nothing when no press reached the page", () => {
    const p = fakePage();
    p.run(buildInstallClickProbeExpr("#b", true));
    p.mutate(5);
    expect(p.run(buildReadClickProbeExpr())).toMatchObject({ mutationCount: 0 });
  });

  it("starts on mousedown when no pointerdown comes", () => {
    const p = fakePage();
    p.run(buildInstallClickProbeExpr("#b", true));
    p.mutate(1);
    p.fire("mousedown");
    p.mutate(1);
    expect(p.run(buildReadClickProbeExpr())).toMatchObject({ mutationCount: 1 });
  });

  it("removes its press listeners when read, and when a new probe replaces it", () => {
    const p = fakePage();
    p.run(buildInstallClickProbeExpr("#b", true));
    expect(p.listenerCount()).toBe(2);
    p.run(buildInstallClickProbeExpr("#b", true));
    expect(p.listenerCount()).toBe(2);
    p.run(buildReadClickProbeExpr());
    expect(p.listenerCount()).toBe(0);
  });

  it("without fromPress (the OS click) counts every change, as before", () => {
    const p = fakePage();
    p.run(buildInstallClickProbeExpr("#b"));
    expect(p.listenerCount()).toBe(0);
    p.mutate(3);
    expect(p.run(buildReadClickProbeExpr())).toMatchObject({ mutationCount: 3 });
  });
});
