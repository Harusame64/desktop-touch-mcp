import { describe, it, expect, vi } from "vitest";
import {
  menuBarItems, readMacAxCandidates, type MacAxProviderDeps, type MacAxReadNotes,
} from "../../src/tools/mac/ax-provider.js";
import { createMacFacade, macDiscoverHandler, macActHandler, type MacFacadeState } from "../../src/tools/mac/desktop-discover-act.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";

// internal #258: Calculator's モード button (a SwiftUI menu) answers AXPress with success and opens
// nothing; 表示 > 科学計算 in the menu bar takes AXPress with the app in the background (measured
// 2026-11-09, macOS 27.2). The menu bar is offered on request, items named by their path.

const WIN = "計算機\u001f\u001f0,0,230,408";
const BAR = "\u001f\u001f0,0,1512,33";
const el = (over: Partial<NativeMacAxElement>): NativeMacAxElement => ({
  id: "a.0", rootKey: WIN, elementKey: "k", depth: 0, role: "AXGroup", actions: [], valueSettable: false, childCount: 0, ...over,
});
const menu = (id: string, depth: number, role: string, title: string, over: Partial<NativeMacAxElement> = {}) =>
  el({ id, depth, role, title, rootKey: BAR, elementKey: `k|${title}`, actions: role === "AXMenu" ? [] : ["AXPress", "AXCancel"], ...over });

const elements: NativeMacAxElement[] = [
  el({ id: "a.0", role: "AXWindow", title: "計算機", childCount: 1 }),
  el({ id: "a.0.0", depth: 1, role: "AXButton", description: "モード", actions: ["AXPress", "AXShowMenu"] }),
  el({ id: "a.1", rootKey: BAR, role: "AXMenuBar", childCount: 3 }),
  menu("a.1.0", 1, "AXMenuBarItem", "Apple", { childCount: 1 }),
  menu("a.1.0.0", 2, "AXMenu", "", { childCount: 1 }),
  menu("a.1.0.0.0", 3, "AXMenuItem", "システム終了…"),
  menu("a.1.1", 1, "AXMenuBarItem", "表示", { childCount: 1 }),
  menu("a.1.1.0", 2, "AXMenu", "", { childCount: 5 }),
  menu("a.1.1.0.0", 3, "AXMenuItem", "科学計算"),
  menu("a.1.1.0.1", 3, "AXMenuItem", ""), // a separator: no title
  menu("a.1.1.0.2", 3, "AXMenuItem", "フルスクリーンにする", { enabled: false }),
  menu("a.1.1.0.3", 3, "AXMenuItem", "小数位", { childCount: 1 }),
  menu("a.1.1.0.3.0", 4, "AXMenu", "", { childCount: 1 }),
  menu("a.1.1.0.3.0.0", 5, "AXMenuItem", "2桁"),
  menu("a.1.1.0.4", 3, "AXMenuItem", "見るだけ", { actions: [] }),
  menu("a.1.2", 1, "AXMenuBarItem", "ヘルプ", { childCount: 0 }),
];

describe("menuBarItems (internal #258)", () => {
  it("names each pressable leaf by its path, and leaves out the Apple menu, titles, submenus and separators", () => {
    expect([...menuBarItems(elements).entries()]).toEqual([
      ["a.1.1.0.0", "表示 > 科学計算"],
      ["a.1.1.0.2", "表示 > フルスクリーンにする"],
      ["a.1.1.0.3.0.0", "表示 > 小数位 > 2桁"],
    ]);
  });
  it("is empty when the read holds no menu bar", () => {
    expect(menuBarItems(elements.filter((e) => !e.id.startsWith("a.1"))).size).toBe(0);
  });
});

describe("readMacAxCandidates with the menu bar", () => {
  const deps = () => ({
    listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "計算機" }]),
    getFocus: vi.fn(async () => ({ pid: 7 })),
    axTree: vi.fn(async (o: { includeMenuBar?: boolean }) => ({
      pid: 7, appTitle: "計算機", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1,
      elements: o.includeMenuBar ? elements : elements.filter((e) => !e.id.startsWith("a.1")),
    })),
    now: vi.fn(() => 1000),
  });
  const labels = (r: { label?: string; role: string }[]) => r.map((c) => `${c.role}:${c.label}`);

  it("asks for the menu bar only when asked, and offers its enabled leaves beside the window's controls", async () => {
    const d = deps();
    const notes: MacAxReadNotes = { warnings: [] };
    const off = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { windowTitle: "計算機" }, notes);
    expect(d.axTree).toHaveBeenLastCalledWith({ pid: 7 });
    expect(labels(off)).toEqual(["button:モード"]);
    const on = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { windowTitle: "計算機" }, notes, undefined, true);
    expect(d.axTree).toHaveBeenLastCalledWith({ pid: 7, includeMenuBar: true });
    expect(labels(on)).toEqual(["button:モード", "menuitem:表示 > 科学計算", "menuitem:表示 > 小数位 > 2桁"]);
    expect(on.find((c) => c.label === "表示 > 科学計算")!.actionability).toEqual(["click", "invoke"]);
  });
  it("without a title lists each menu item once, by its path", async () => {
    const d = deps();
    const r = await readMacAxCandidates(d as unknown as MacAxProviderDeps, undefined, { warnings: [] }, undefined, true);
    expect(labels(r)).toEqual(["button:モード", "menuitem:表示 > 科学計算", "menuitem:表示 > 小数位 > 2桁"]);
  });
});

describe("desktop_discover menuBar and the act on its lease", () => {
  const ok = { ok: true };
  const mac = () => {
    const tree = vi.fn(async (o: { includeMenuBar?: boolean }) => ({
      pid: 7, appTitle: "計算機", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1,
      elements: o.includeMenuBar ? elements : elements.filter((e) => !e.id.startsWith("a.1")),
    }));
    return {
      macPermissions: () => ({ accessibility: true, screenCapture: true }),
      macListWindows: () => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "計算機" }],
      macGetFocus: async () => ({ pid: 7 }),
      macAxTree: tree,
      macAxPerform: vi.fn(async () => ok),
      macAxSetValue: vi.fn(async () => ok),
      macAxInsertText: vi.fn(async () => ok),
    };
  };
  const parse = (r: { content: { text?: string }[] }) => JSON.parse(r.content[0]!.text!);

  it("presses a menu item through the lease, reading the menu bar again for the act; a plain view's act does not", async () => {
    const m = mac();
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(m as never, state);
    const d = parse(await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "計算機" }, menuBar: true, view: "explore" }));
    const sci = d.entities.find((e: { label?: string }) => e.label === "表示 > 科学計算");
    expect(sci?.primaryAction).toBe("click");
    m.macAxTree.mockClear();
    const a = parse(await macActHandler(m as never, facade, state, { lease: sci.lease, action: "click" }));
    expect(a.ok).toBe(true);
    expect(m.macAxPerform).toHaveBeenCalledWith(expect.objectContaining({ id: "a.1.1.0.0", expectedRole: "AXMenuItem" }), "AXPress");
    expect(m.macAxTree.mock.calls.length).toBeGreaterThan(0);
    expect(m.macAxTree.mock.calls.every((c) => c[0].includeMenuBar === true)).toBe(true);
    expect(state.actMenuBar).toBe(false);

    const p = parse(await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "計算機" } }));
    const mode = p.entities.find((e: { label?: string }) => e.label === "モード");
    m.macAxTree.mockClear();
    await macActHandler(m as never, facade, state, { lease: mode.lease, action: "click" });
    expect(m.macAxTree.mock.calls.every((c) => c[0].includeMenuBar !== true)).toBe(true);
  });
});
