/**
 * internal #265: a Mac window can be targeted by its windowId, which stays the same while the app
 * retitles the window (a Finder window moved to another folder kept 9199, measured 2026-11-10).
 */
import { describe, it, expect, vi } from "vitest";
import { readMacAxCandidates, windowIdOf, type MacAxProviderDeps, type MacAxReadNotes } from "../../src/tools/mac/ax-provider.js";
import { createMacFacade, macDiscoverHandler, macActHandler, type MacFacadeState } from "../../src/tools/mac/desktop-discover-act.js";
import { macScreenshotHandler } from "../../src/tools/mac/screenshot.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";
import { targetSessionKey } from "../../src/engine/world-graph/session-registry.js";

const el = (over: Partial<NativeMacAxElement> = {}): NativeMacAxElement => ({
  id: "a.0.1", rootKey: "Doc\u001f\u001f0,0,10,10", elementKey: "k", depth: 1, role: "AXButton",
  actions: [], valueSettable: false, childCount: 0, ...over,
});

// Two windows of one app: 書類 (window 9199, root a.0) and 写真 (window 9200, root a.1).
const ROOT_A = "書類\u001f\u001f0,0,10,10";
const ROOT_B = "写真\u001f\u001f0,0,10,10";
const tree = (over: object = {}) => ({
  pid: 7, appTitle: "Finder",
  elements: [
    el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: ROOT_A, windowId: 9199 }),
    el({ id: "a.0.1", rootKey: ROOT_A, actions: ["AXPress"], title: "OK" }),
    el({ id: "a.1", depth: 0, role: "AXWindow", rootKey: ROOT_B, windowId: 9200 }),
    el({ id: "a.1.1", rootKey: ROOT_B, actions: ["AXPress"], title: "Cancel" }),
    el({ id: "a.10", depth: 0, role: "AXWindow", rootKey: ROOT_B, windowId: 9201 }),
    el({ id: "a.10.1", rootKey: ROOT_B, actions: ["AXPress"], title: "Elsewhere" }),
  ],
  truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1,
  ...over,
});
const LISTED = [
  { windowId: 9199, pid: 7, layer: 0, onScreen: true, title: "書類" },
  { windowId: 9200, pid: 7, layer: 0, onScreen: true, title: "写真" },
  { windowId: 9201, pid: 7, layer: 0, onScreen: true, title: "写真" },
  { windowId: 50, pid: 8, layer: 0, onScreen: true, title: "Other" },
];
const mk = (t = tree()) => ({
  listWindows: vi.fn(() => LISTED),
  getFocus: vi.fn(async () => ({ pid: 8 })),
  axTree: vi.fn(async () => t),
  now: vi.fn(() => 1000),
});
const read = async (deps: ReturnType<typeof mk>, target: { macWindowId?: string; windowTitle?: string }) => {
  const notes: MacAxReadNotes = { warnings: [] };
  const r = await readMacAxCandidates(deps as unknown as MacAxProviderDeps, target, notes);
  return { r, notes };
};

describe("the session key", () => {
  it("a Mac window id keys its own session, apart from an hwnd of the same number", () => {
    expect(targetSessionKey({ macWindowId: "9199" })).toBe("window:mac:9199");
    expect(targetSessionKey({ hwnd: "9199" })).toBe("window:9199");
  });
});

describe("windowIdOf", () => {
  it.each([
    ["9199", 9199], ["0", undefined], ["", undefined], ["0x1F", undefined], ["-3", undefined], ["12a", undefined],
    ["99999999999999999999", undefined],
  ])("%s -> %s", (raw, expected) => {
    expect(windowIdOf({ macWindowId: raw })).toBe(expected);
  });
  it("no target, no id", () => {
    expect(windowIdOf(undefined)).toBeUndefined();
  });
});

describe("reading a window by its id", () => {
  it("reads the app that owns the window, and only that window's root", async () => {
    const d = mk();
    const { r, notes } = await read(d, { macWindowId: "9200" });
    expect(d.axTree).toHaveBeenCalledWith({ pid: 7, windowId: 9200 });
    expect(d.getFocus).not.toHaveBeenCalled();
    // a.1 is the window; a.10 shares its title and the "a.1" prefix as text, and is another window.
    expect(r.map((c) => c.label)).toEqual(["Cancel"]);
    expect(r[0]!.target).toEqual({ kind: "window", id: "window:9200" });
    expect(notes.windowTitle).toBe("写真");
    expect(notes.warnings).toEqual([]);
  });

  it("follows the window when its title is not the one it had", async () => {
    // The list still says 書類 for 9199, the tree has it retitled: the id decides, not either title.
    const d = mk(tree({
      elements: [
        el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: "ダウンロード\u001f\u001f0,0,10,10", windowId: 9199 }),
        el({ id: "a.0.1", rootKey: "ダウンロード\u001f\u001f0,0,10,10", actions: ["AXPress"], title: "OK" }),
      ],
    }));
    const { r, notes } = await read(d, { macWindowId: "9199" });
    expect(r.map((c) => c.label)).toEqual(["OK"]);
    expect(notes.windowTitle).toBe("ダウンロード");
  });

  it("a closed window: no_window_with_id, nothing read", async () => {
    const d = mk();
    const { r, notes } = await read(d, { macWindowId: "4242" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["no_window_with_id"]);
    expect(d.axTree).not.toHaveBeenCalled();
  });

  it("a window above the app layer is not a target", async () => {
    const d = mk();
    d.listWindows.mockReturnValue([{ windowId: 9199, pid: 7, layer: 24, onScreen: true, title: "書類" }]);
    const { r, notes } = await read(d, { macWindowId: "9199" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["no_window_with_id"]);
  });

  it("listed but no root is that window: window_id_not_in_tree, and nothing of the other windows", async () => {
    const d = mk(tree({
      elements: [
        el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: ROOT_A }),
        el({ id: "a.0.1", rootKey: ROOT_A, actions: ["AXPress"], title: "OK" }),
      ],
    }));
    const { r, notes } = await read(d, { macWindowId: "9200" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["window_id_not_in_tree"]);
    expect(notes.windowTitle).toBeUndefined();
  });

  it("a sheet's own id reads the sheet, under its window's root", async () => {
    const d = mk(tree({
      elements: [
        ...tree().elements,
        el({ id: "a.1.2", rootKey: ROOT_B, role: "AXSheet", description: "保存", windowId: 9463 }),
        el({ id: "a.1.2.0", rootKey: ROOT_B, actions: ["AXPress"], title: "削除" }),
      ],
    }));
    d.listWindows.mockReturnValue([...LISTED, { windowId: 9463, pid: 7, layer: 0, onScreen: true, title: "保存" }]);
    const { r, notes } = await read(d, { macWindowId: "9463" });
    expect(d.axTree).toHaveBeenCalledWith({ pid: 7, windowId: 9463 });
    expect(r.map((c) => c.label)).toEqual(["削除"]);
    expect(notes.windowTitle).toBe("保存");
    expect(notes.warnings).toEqual(["sheet_open"]);
  });

  it("an element below a root that carries the id by mistake is not the window", async () => {
    const d = mk(tree({
      elements: [
        el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: ROOT_A }),
        el({ id: "a.0.1", rootKey: ROOT_A, actions: ["AXPress"], title: "OK", windowId: 9199 }),
      ],
    }));
    const { r, notes } = await read(d, { macWindowId: "9199" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["window_id_not_in_tree"]);
  });

  it("not in the tree: the menu bar is not offered either", async () => {
    const d = mk(tree({
      elements: [
        el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: ROOT_A }),
        el({ id: "a.0.1", rootKey: ROOT_A, actions: ["AXPress"], title: "OK" }),
        el({ id: "a.1", depth: 0, role: "AXMenuBar", rootKey: "\u001f\u001f" }),
        el({ id: "a.1.0", depth: 1, role: "AXMenuBarItem", rootKey: "\u001f\u001f", title: "Apple" }),
        el({ id: "a.1.1", depth: 1, role: "AXMenuBarItem", rootKey: "\u001f\u001f", title: "ファイル" }),
        el({ id: "a.1.1.0", depth: 2, role: "AXMenu", rootKey: "\u001f\u001f" }),
        el({ id: "a.1.1.0.0", depth: 3, role: "AXMenuItem", rootKey: "\u001f\u001f", title: "閉じる", actions: ["AXPress"] }),
      ],
    }));
    // The same read with the window in it offers the menu item: the fixture does reach the bar.
    const withWindow = { ...d, axTree: vi.fn(async () => tree({ elements: [...(await d.axTree()).elements, el({ id: "a.2", depth: 0, role: "AXWindow", rootKey: ROOT_B, windowId: 9200 })] })) };
    const seen: MacAxReadNotes = { warnings: [] };
    const offered = await readMacAxCandidates(withWindow as unknown as MacAxProviderDeps, { macWindowId: "9200" }, seen, undefined, true);
    expect(offered.map((c) => c.label)).toEqual(["ファイル > 閉じる"]);
    const notes: MacAxReadNotes = { warnings: [] };
    const r = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { macWindowId: "9200" }, notes, undefined, true);
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["window_id_not_in_tree"]);
  });

  it("off screen and not in the tree: window_not_shown, not a read to retry", async () => {
    const d = mk();
    d.listWindows.mockReturnValue([...LISTED, { windowId: 9463, pid: 7, layer: 0, onScreen: false, title: "保存" }]);
    const { r, notes } = await read(d, { macWindowId: "9463" });
    expect(r).toEqual([]);
    expect(notes.warnings).toEqual(["window_not_shown"]);
  });

  it("a sheet in another window is not reported for this one", async () => {
    const d = mk(tree({
      elements: [
        ...tree().elements,
        el({ id: "a.1.2", rootKey: ROOT_B, role: "AXSheet" }),
        el({ id: "a.1.2.0", rootKey: ROOT_B, actions: ["AXPress"], title: "削除" }),
      ],
    }));
    expect((await read(d, { macWindowId: "9199" })).notes.warnings).toEqual([]);
    expect((await read(d, { macWindowId: "9200" })).notes.warnings).toEqual(["sheet_open"]);
  });
});

function fakeMac(t = tree()) {
  return {
    macPermissions: vi.fn(() => ({ accessibility: true, screenCapture: true })),
    macListWindows: vi.fn(() => LISTED),
    macGetFocus: vi.fn(async () => ({ pid: 8 })),
    macAxTree: vi.fn(async () => t),
    macAxPerform: vi.fn(async () => ({ ok: true })),
    macAxSetValue: vi.fn(),
    macAxInsertText: vi.fn(),
  };
}
const body = (r: any) => JSON.parse(r.content.find((b: any) => b.type === "text").text);

describe("desktop_discover / desktop_act with target.windowId", () => {
  it("answers the window's current title and its id, and the act's read stays on that window", async () => {
    const mac = fakeMac();
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(mac as any, state);
    const d = body(await macDiscoverHandler(mac as any, facade, state, { target: { windowId: 9200 } } as any));
    expect(d.target.title).toBe("写真");
    expect(d.target.windowId).toBe(9200);
    expect(d.entities.map((e: any) => e.label)).toEqual(["Cancel"]);
    // The id is not handed to the facade as an hwnd: it would ask a Win32 cache and answer attention.
    expect(d.attention).toBeUndefined();
    mac.macAxTree.mockClear();
    mac.macGetFocus.mockClear();
    const a = body(await macActHandler(mac as any, facade, state, { lease: d.entities[0].lease, action: "click" }));
    expect(a.ok).toBe(true);
    expect(mac.macAxPerform).toHaveBeenCalledTimes(1);
    // The read after the act is of the same window by the id, not of whatever is frontmost (pid 8).
    expect(mac.macAxTree).toHaveBeenCalledWith({ pid: 7, windowId: 9200 });
    expect(mac.macGetFocus).not.toHaveBeenCalled();
    expect(a.postReadWarnings).toBeUndefined();
  });

  it("a discover by id does not move the app a discover without a target pinned for its acts", async () => {
    const other = tree({
      pid: 8,
      elements: [el({ id: "a.0", depth: 0, role: "AXWindow", rootKey: "Other\u001f\u001f0,0,10,10", windowId: 50 }),
        el({ id: "a.0.1", rootKey: "Other\u001f\u001f0,0,10,10", actions: ["AXPress"], title: "Front" })],
    });
    const mac = fakeMac();
    mac.macAxTree.mockImplementation(async (o: any) => (o.pid === 8 ? other : tree()));
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(mac as any, state);
    const front = body(await macDiscoverHandler(mac as any, facade, state, {} as any));
    expect(front.entities.map((e: any) => e.label)).toEqual(["Front"]);
    await macDiscoverHandler(mac as any, facade, state, { target: { windowId: 9200 } } as any);
    mac.macAxTree.mockClear();
    mac.macGetFocus.mockResolvedValue({ pid: 7 });
    await macActHandler(mac as any, facade, state, { lease: front.entities[0].lease, action: "click" });
    expect(mac.macAxTree.mock.calls.map((c: any) => c[0].pid)).toEqual([8]);
  });

  it("an act that closes the window: its entities disappeared, the read is not called unsure", async () => {
    const mac = fakeMac();
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(mac as any, state);
    const d = body(await macDiscoverHandler(mac as any, facade, state, { target: { windowId: 9200 } } as any));
    mac.macListWindows.mockReturnValue(LISTED.filter((w) => w.windowId !== 9200));
    const a = body(await macActHandler(mac as any, facade, state, { lease: d.entities[0].lease, action: "click" }));
    expect(a.ok).toBe(true);
    expect(a.diff).toContain("entity_disappeared");
    expect(a.postReadWarnings).toBeUndefined();
  });

  it("a closed window: empty title, no_window_with_id", async () => {
    const mac = fakeMac();
    const state: MacFacadeState = { phase: "discover" };
    const d = body(await macDiscoverHandler(mac as any, createMacFacade(mac as any, state), state, { target: { windowId: 4242 } } as any));
    expect(d.target.title).toBe("");
    expect(d.target.windowId).toBe(4242);
    expect(d.warnings).toContain("no_window_with_id");
    expect(d.entities).toEqual([]);
  });

  it("refuses a title and an id together", async () => {
    const mac = fakeMac();
    const state: MacFacadeState = { phase: "discover" };
    const d = body(await macDiscoverHandler(mac as any, createMacFacade(mac as any, state), state, { target: { windowId: 9200, windowTitle: "書類" } } as any));
    expect(d.ok).toBe(false);
    expect(d.code).toBe("InvalidArgs");
    expect(mac.macAxTree).not.toHaveBeenCalled();
  });

  it("an empty title beside an id is no title", async () => {
    const mac = fakeMac();
    const state: MacFacadeState = { phase: "discover" };
    const d = body(await macDiscoverHandler(mac as any, createMacFacade(mac as any, state), state, { target: { windowId: 9200, windowTitle: "" } } as any));
    expect(d.target.windowId).toBe(9200);
    expect(d.entities.map((e: any) => e.label)).toEqual(["Cancel"]);
  });
});

describe("screenshot windowId", () => {
  const shotDeps = (over: object = {}) => ({
    permissions: vi.fn(() => ({ accessibility: false, screenCapture: true })),
    listWindows: vi.fn((onScreenOnly?: boolean) => LISTED.map((w) => ({ ...w, bounds: { x: 0, y: 0, width: 200, height: 100 } })).filter((w) => !onScreenOnly || w.onScreen)),
    getFocus: vi.fn(async () => ({})),
    capture: vi.fn(async () => ({ ok: true, data: Buffer.alloc(16), width: 2, height: 2, frame: { x: 0, y: 0, width: 200, height: 100 }, onScreen: true, elapsedMs: 1 })),
    encodePng: vi.fn(async () => ({ png: Buffer.from("PNG"), width: 100, height: 50 })),
    ...over,
  });
  it("captures that window, without Accessibility and without asking which is frontmost", async () => {
    const d = shotDeps();
    const b = body(await macScreenshotHandler(d as any, { windowId: 9201 }));
    expect(d.capture).toHaveBeenCalledWith(expect.objectContaining({ windowId: 9201 }));
    expect(d.getFocus).not.toHaveBeenCalled();
    expect(b.windowId).toBe(9201);
    expect(b.warnings ?? []).not.toContain("several_windows_match");
  });
  it("a closed window is WindowNotFound and nothing is captured", async () => {
    const d = shotDeps();
    const b = body(await macScreenshotHandler(d as any, { windowId: 4242 }));
    expect(b.code).toBe("WindowNotFound");
    expect(d.capture).not.toHaveBeenCalled();
  });
  it("refuses a title and an id together", async () => {
    const d = shotDeps();
    const b = body(await macScreenshotHandler(d as any, { windowId: 9199, windowTitle: "書類" }));
    expect(b.code).toBe("InvalidArgs");
    expect(d.listWindows).not.toHaveBeenCalled();
  });
});
