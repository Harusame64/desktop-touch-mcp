/**
 * internal #211 item 9(1) — the ingress cache follows an owned dialog's coming and going, and does
 * not outlive an act.
 *
 * MEASURED win2 (internal #212, arm 9): with Notepad's save dialog (`#32770`, owned by the main
 * window) opened and closed from outside, `desktop_discover(target.hwnd = main)` served a read
 * WITHOUT the dialog for about 30 s after it appeared, and — the reverse — the closed dialog's
 * buttons as `observed` after it had gone, until the 30 s TTL ran out. The dialog is a top-level
 * window of its own; its events carried its own handle and never matched the owner's key.
 *
 * internal #218: the ingress no longer serves a cached read — every discover reads, a dialog's
 * coming and going included — so nothing in production drains this source now. The cells below pin
 * the adapter alone; what the ingress and the facade do is in `candidate-ingress.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  combineEventSources,
  createWinEventIngressSource,
  type IngressDrainContext,
} from "../../src/engine/world-graph/candidate-ingress.js";

type Ev = { type: string; hwnd?: string; windowTitle?: string };

/** An event source over a fixed queue, with owners from a little table. */
function source(queue: Ev[], owners: Record<string, string> = {}) {
  return createWinEventIngressSource({
    events: async () => queue.splice(0),
    owner: (h: bigint) => (owners[h.toString()] !== undefined ? BigInt(owners[h.toString()]) : null),
  });
}

const keys = (...k: string[]) => new Set(k);
const listing = (lists: Record<string, string[]>): IngressDrainContext => ({
  listsWindow: (key, hwnd) => (lists[key] ?? []).includes(hwnd),
});

describe("the WinEvent source dirties the owner's key", () => {
  it("when a window it owns appears — the save dialog", async () => {
    const out = [...await source([{ type: "window_appeared", hwnd: "777" }], { "777": "500" }).drain(keys("window:500"))];
    expect(out).toEqual([{ key: "window:500", reason: "winevent" }]);
  });

  it("at EVERY owner up the chain, for a box opened by a dialog — a read of the dialog lists it too (gate 2)", async () => {
    const out = [...await source([{ type: "window_appeared", hwnd: "888" }], { "888": "777", "777": "500" }).drain(keys("window:500", "window:777", "window:600"))];
    expect(out).toEqual([{ key: "window:777", reason: "winevent" }, { key: "window:500", reason: "winevent" }]);
  });

  it("does not ask the OS about owners when no key names a window by handle", async () => {
    const owner = vi.fn(() => 500n);
    const src = createWinEventIngressSource({ events: async () => [{ type: "window_appeared", hwnd: "777" }], owner });
    expect([...await src.drain(keys("title:Notepad"))]).toEqual([]);
    expect(owner).not.toHaveBeenCalled();
  });

  it("keeps the rest of the batch when one event cannot be read (gate 2)", async () => {
    const src = createWinEventIngressSource({
      events: async () => [{ type: "window_appeared", hwnd: "777" }, { type: "window_disappeared", hwnd: "500" }],
      owner: () => { throw new Error("torn read"); },
    });
    expect([...await src.drain(keys("window:500"))]).toEqual([{ key: "window:500", reason: "winevent" }]);
  });

  it("not for an unowned window, or one owned by another window", async () => {
    const out = [...await source(
      [{ type: "window_appeared", hwnd: "900" }, { type: "window_appeared", hwnd: "901" }],
      { "901": "600" },
    ).drain(keys("window:500"))];
    expect(out).toEqual([]);
  });

  it("when a window its cached read listed disappears — the closed dialog", async () => {
    const out = [...await source([{ type: "window_disappeared", hwnd: "777" }]).drain(
      keys("window:500", "window:600"),
      listing({ "window:500": ["777"] }),
    )];
    expect(out).toEqual([{ key: "window:500", reason: "winevent" }]);
  });

  it("not when a window no read listed disappears", async () => {
    const out = [...await source([{ type: "window_disappeared", hwnd: "999" }]).drain(keys("window:500"), listing({ "window:500": ["777"] }))];
    expect(out).toEqual([]);
  });

  it("does not ask whose a gone window was: its owner is not readable once it is gone", async () => {
    const owner = vi.fn(() => 500n);
    const src = createWinEventIngressSource({ events: async () => [{ type: "window_disappeared", hwnd: "777" }], owner });
    expect([...await src.drain(keys("window:500"), listing({}))]).toEqual([]);
    expect(owner).not.toHaveBeenCalled();
  });

  it("hands the ingress's listing through the composite source production wires", async () => {
    const combined = combineEventSources([source([{ type: "window_disappeared", hwnd: "777" }])]);
    const out = [...await combined.drain(keys("window:500"), listing({ "window:500": ["777"] }))];
    expect(out).toEqual([{ key: "window:500", reason: "winevent" }]);
  });

  it("still dirties a key on its own window's event, once per key", async () => {
    const out = [...await source(
      [{ type: "window_appeared", hwnd: "500" }, { type: "window_appeared", hwnd: "777" }],
      { "777": "500" },
    ).drain(keys("window:500"))];
    expect(out).toEqual([{ key: "window:500", reason: "winevent" }]);
  });
});

