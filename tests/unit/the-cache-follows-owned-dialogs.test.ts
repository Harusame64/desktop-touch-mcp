/**
 * internal #211 item 9(1) — the ingress cache follows an owned dialog's coming and going, and does
 * not outlive an act.
 *
 * MEASURED win2 (internal #212, arm 9): with Notepad's save dialog (`#32770`, owned by the main
 * window) opened and closed from outside, `desktop_discover(target.hwnd = main)` served a read
 * WITHOUT the dialog for about 30 s after it appeared, and — the reverse — the closed dialog's
 * buttons as `observed` after it had gone, until the 30 s TTL ran out. The dialog is a top-level
 * window of its own; its events carried its own handle and never matched the owner's key.
 */
import { describe, expect, it, vi } from "vitest";

import {
  SnapshotIngress,
  combineEventSources,
  createWinEventIngressSource,
  type IngressDrainContext,
  type ProviderResult,
} from "../../src/engine/world-graph/candidate-ingress.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

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

// ── Through the ingress ───────────────────────────────────────────────────────

function candidate(label: string, hwnd?: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "Notepad" },
    label,
    role: "button",
    rect: { x: 10, y: 10, width: 60, height: 20 },
    actionability: ["click"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
    ...(hwnd !== undefined && { locator: { uia: { name: label, nativeWindowHandle: hwnd } } }),
  } as unknown as UiEntityCandidate;
}

function ingress(queue: Ev[], owners: Record<string, string>, read: () => UiEntityCandidate[]) {
  const fetch = vi.fn(async (): Promise<ProviderResult> => ({ candidates: read(), warnings: [] }));
  return { ingress: new SnapshotIngress(fetch, source(queue, owners)), fetch };
}

describe("the ingress reads again after an owned dialog comes or goes", () => {
  it("reads again when the dialog appears, instead of serving the read without it", async () => {
    const queue: Ev[] = [];
    const { ingress: ing } = ingress(queue, { "777": "500" }, () => [candidate("Text")]);
    await ing.getSnapshot("window:500");
    queue.push({ type: "window_appeared", hwnd: "777" });
    expect((await ing.getSnapshot("window:500")).freshness).toMatchObject({ from: "read" });
  });

  it("reads again when a dialog the read listed closes, instead of serving its buttons", async () => {
    const queue: Ev[] = [];
    const { ingress: ing } = ingress(queue, {}, () => [candidate("Text"), candidate("メモ帳", "777"), candidate("キャンセル", "790")]);
    await ing.getSnapshot("window:500");
    // The bus reports top-level windows only: the dialog's own handle, not its buttons'.
    queue.push({ type: "window_disappeared", hwnd: "777" });
    expect((await ing.getSnapshot("window:500")).freshness).toMatchObject({ from: "read" });
  });

  it("keeps a mark that lands while a read is in flight, instead of the read writing it off (gate 2)", async () => {
    let release!: () => void;
    let calls = 0;
    const fetch = vi.fn(async (): Promise<ProviderResult> => {
      calls++;
      if (calls === 2) await new Promise<void>((r) => { release = r; });
      return { candidates: [candidate("Text")], warnings: [] };
    });
    const ing = new SnapshotIngress(fetch);
    await ing.getSnapshot("window:500");
    ing.invalidate("window:500", "manual");
    const inFlight = ing.getSnapshot("window:500");      // read #2 starts
    await vi.waitFor(() => expect(calls).toBe(2));
    ing.invalidate("window:500", "manual");              // the act lands mid-read
    release();
    await inFlight;
    expect((await ing.getSnapshot("window:500")).freshness).toMatchObject({ from: "read" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("still serves the cache when an unrelated window comes and goes", async () => {
    const queue: Ev[] = [];
    const { ingress: ing, fetch } = ingress(queue, { "901": "600" }, () => [candidate("Text"), candidate("メモ帳", "777")]);
    await ing.getSnapshot("window:500");
    queue.push({ type: "window_appeared", hwnd: "901" }, { type: "window_disappeared", hwnd: "999" });
    expect((await ing.getSnapshot("window:500")).freshness).toMatchObject({ from: "cache" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Through the facade ────────────────────────────────────────────────────────

describe("an act ends the cached read it was made against", () => {
  async function actThenSee(execute: () => Promise<"uia">, opts: Record<string, unknown> = {}) {
    const fetch = vi.fn(async (): Promise<ProviderResult> => ({ candidates: [candidate("OK")], warnings: [] }));
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress(fetch), executorFn: execute, ...opts });
    const view = await facade.see({ target: { hwnd: "500" } });
    const result = await facade.touch({ lease: view.entities[0].lease });
    const after = await facade.see({ target: { hwnd: "500" } });
    return { result, after, fetch };
  }

  it("reads again after an act that pressed", async () => {
    const { result, fetch } = await actThenSee(async () => "uia");
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads again after an act that was refused, so the refusal is not repeated from the same read", async () => {
    const { result, fetch } = await actThenSee(async () => "uia", { isModalBlocking: () => true });
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads again after an act whose executor threw", async () => {
    const fetch = vi.fn(async (): Promise<ProviderResult> => ({ candidates: [candidate("OK")], warnings: [] }));
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress(fetch), executorFn: async () => { throw new Error("boom"); } });
    const view = await facade.see({ target: { hwnd: "500" } });
    await facade.touch({ lease: view.entities[0].lease }).catch(() => undefined);
    await facade.see({ target: { hwnd: "500" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves the cache to a second read with no act between (the control)", async () => {
    const fetch = vi.fn(async (): Promise<ProviderResult> => ({ candidates: [candidate("OK")], warnings: [] }));
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress(fetch), executorFn: async () => "uia" });
    await facade.see({ target: { hwnd: "500" } });
    await facade.see({ target: { hwnd: "500" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
