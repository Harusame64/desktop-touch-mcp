/**
 * internal #259 — Finder's sidebar entries and list rows are AXOutline > AXRow > AXCell; the cell
 * advertises AXOpen, and Finder opens the item yet answers `attribute_unsupported` (measured
 * 2026-11-10, macOS 27.2, 5 of 5). A cell that opens is offered as a `listitem` named by its text,
 * with `invoke` only; the act sends AXOpen and, once sent, never answers "nothing was done".
 */
import { describe, it, expect, vi } from "vitest";
import { readMacAxCandidates, type MacAxProviderDeps, type MacAxReadNotes } from "../../src/tools/mac/ax-provider.js";
import { createMacAxExecutor, MacAxActError, OpenMayHaveHappenedError } from "../../src/tools/mac/ax-executor.js";
import { createMacFacade, macDiscoverHandler, macActHandler, type MacFacadeState } from "../../src/tools/mac/desktop-discover-act.js";
import { TargetGoneError } from "../../src/engine/aim.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";

const WIN = "ダウンロード\u001f\u001f0,0,900,600";
const el = (id: string, role: string, over: Partial<NativeMacAxElement> = {}): NativeMacAxElement => ({
  id, rootKey: WIN, elementKey: `k|${id}`, depth: id.split(".").length - 2, role, actions: [], valueSettable: false, childCount: 0,
  valueTruncated: false, ...over,
});
// The shape read from Finder on 2026-11-10 (ids shortened).
const elements: NativeMacAxElement[] = [
  el("a.0", "AXWindow", { title: "ダウンロード" }),
  el("a.0.0", "AXOutline", { description: "サイドバー", actions: ["AXShowMenu"] }),
  el("a.0.0.1", "AXRow", { subrole: "AXOutlineRow", actions: ["AXShowDefaultUI", "AXShowAlternateUI"] }),
  el("a.0.0.1.0", "AXCell", { actions: ["AXOpen"] }),
  el("a.0.0.1.0.0", "AXStaticText", { value: "デスクトップ" }),
  el("a.0.0.2", "AXRow", { subrole: "AXOutlineRow" }),
  el("a.0.0.2.0", "AXCell", { actions: [] }), // a section heading's cell: no AXOpen
  el("a.0.0.2.0.0", "AXStaticText", { value: "よく使う項目" }),
  el("a.0.0.3", "AXRow", { subrole: "AXOutlineRow" }),
  el("a.0.0.3.0", "AXCell", { actions: ["AXOpen"] }), // opens, but holds no text: cannot be named
  el("a.0.1", "AXOutline", { description: "リスト表示", actions: ["AXShowMenu"] }),
  el("a.0.1.0", "AXRow", { subrole: "AXOutlineRow" }),
  el("a.0.1.0.0", "AXCell", { actions: ["AXOpen"] }),
  el("a.0.1.0.0.0", "AXImage"),
  el("a.0.1.0.0.1", "AXTextField", { value: "pictkura-ci", namesFile: true, valueSettable: true, actions: ["AXOpen", "AXShowMenu", "AXConfirm"] }),
  el("a.0.1.0.1", "AXCell"),
  el("a.0.1.0.1.0", "AXStaticText", { value: "フォルダ" }),
];
let current = elements;
const tree = async () => ({ pid: 7, appTitle: "Finder", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1, elements: current });
const deps = () => ({ listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "ダウンロード" }]), getFocus: vi.fn(async () => ({ pid: 7 })), axTree: vi.fn(tree), now: () => 1 });

describe("Finder cells that open are offered (internal #259)", () => {
  it("offers a sidebar entry and a list row as listitems named by their text, with invoke only", async () => {
    const notes: MacAxReadNotes = { warnings: [] };
    const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, notes);
    const items = cs.filter((c) => c.role === "listitem").map((c) => [c.label, c.actionability]);
    expect(items).toEqual([["デスクトップ", ["invoke"]], ["pictkura-ci", ["invoke"]]]);
    // The text an item is named by is not offered again beside it (gate 2 on #927); a heading's is.
    expect(cs.filter((c) => c.label === "デスクトップ" || c.label === "pictkura-ci").map((c) => c.role)).toEqual(["listitem", "listitem"]);
    expect(cs.some((c) => c.label === "よく使う項目" && c.role === "label")).toBe(true);
  });
  it("makes a row that holds another item another entity (its name is part of its identity; gate 2 on #927)", async () => {
    const digestOf = async () => {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      return cs.find((c) => c.role === "listitem" && c.locator?.ax?.id === "a.0.1.0.0")!.digest;
    };
    const before = await digestOf();
    current = elements.map((e) => (e.id === "a.0.1.0.0.1" ? { ...e, value: "installer.dmg" } : e));
    try {
      expect(await digestOf()).not.toBe(before);
    } finally {
      current = elements;
    }
  });
  it("still reads an item's text when the item itself is not offered (a disabled sidebar entry; gate 2 on #927)", async () => {
    current = [
      el("a.0", "AXWindow", { title: "ダウンロード" }),
      el("a.0.0", "AXCell", { actions: ["AXOpen"], enabled: false }),
      el("a.0.0.0", "AXStaticText", { value: "NAS" }),
    ];
    try {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      expect(cs.map((c) => [c.label, c.role])).toEqual([["NAS", "label"]]);
    } finally {
      current = elements;
    }
  });
  it("keeps a cell that presses as it was: not a list item, pressed by click (a web table cell; gate 2 on #927)", async () => {
    current = [
      el("a.0", "AXWindow", { title: "ダウンロード" }),
      el("a.0.0", "AXCell", { title: "Total", actions: ["AXPress", "AXOpen"] }),
    ];
    try {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      expect(cs.map((c) => [c.label, c.role, c.actionability])).toEqual([["Total", "unknown", ["click", "invoke"]]]);
    } finally {
      current = elements;
    }
  });
});

describe("the act on a list item sends AXOpen with the name to check (internal #259)", () => {
  const entity = { role: "listitem", label: "デスクトップ", locator: { ax: { pid: 7, id: "a.0.0.1.0", role: "AXCell", rootKey: WIN, elementKey: "k", unique: false } } } as never;
  const run = async (answer: { ok: boolean; reason?: string; performed?: boolean }, action = "invoke") => {
    const perform = vi.fn(async (_t: unknown, _a: string) => answer);
    const noteOpenUnconfirmed = vi.fn();
    const out = await createMacAxExecutor({ perform, setValue: vi.fn(), noteOpenUnconfirmed } as never)(entity, action as never);
    return { perform, out, noteOpenUnconfirmed };
  };
  it("sends AXOpen, not AXPress, carrying the name read so the native act checks it just before (gate 2 on #927)", async () => {
    const { perform, out, noteOpenUnconfirmed } = await run({ ok: true, performed: true });
    expect(perform.mock.calls[0]![1]).toBe("AXOpen");
    expect(perform.mock.calls[0]![0]).toMatchObject({ id: "a.0.0.1.0", expectedItemName: "デスクトップ" });
    expect(out).toBe("ax");
    expect(noteOpenUnconfirmed).not.toHaveBeenCalled();
  });
  it("answers ok with the open unconfirmed only when it was sent and answered as Finder answers when it opened", async () => {
    const { out, noteOpenUnconfirmed } = await run({ ok: false, reason: "attribute_unsupported", performed: true });
    expect(out).toBe("ax");
    expect(noteOpenUnconfirmed).toHaveBeenCalledTimes(1);
  });
  it("says the item may have opened when it was sent and answered anything else (an app slow to answer: cannot_complete)", async () => {
    for (const reason of ["cannot_complete", "invalid_ui_element", "failure", "something_new"]) {
      const e = await run({ ok: false, reason, performed: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(OpenMayHaveHappenedError);
      expect((e as OpenMayHaveHappenedError).callerDetail).toMatch(/may have opened/);
    }
  });
  it("refuses as nothing done when it was never sent — whatever the reason, the flag decides, not the string", async () => {
    await expect(run({ ok: false, reason: "element_changed" })).rejects.toBeInstanceOf(TargetGoneError); // another item in the row
    await expect(run({ ok: false, reason: "element_not_found" })).rejects.toBeInstanceOf(TargetGoneError);
    await expect(run({ ok: false, reason: "action_not_advertised" })).rejects.toBeInstanceOf(MacAxActError);
    // Finder's own answer, but not sent: not a success.
    await expect(run({ ok: false, reason: "attribute_unsupported" })).rejects.toBeInstanceOf(MacAxActError);
  });
  it("refuses any verb but invoke on a list item before anything is sent, type and setValue too (gate 2 on #927)", async () => {
    for (const action of ["click", "auto", "type", "setValue"]) {
      const perform = vi.fn(async () => ({ ok: true, performed: true }));
      const setValue = vi.fn(async () => ({ ok: true }));
      await expect(createMacAxExecutor({ perform, setValue } as never)(entity, action as never, "x")).rejects.toBeInstanceOf(MacAxActError);
      expect(perform).not.toHaveBeenCalled();
      expect(setValue).not.toHaveBeenCalled();
    }
  });
});

describe("desktop_act on a Finder item (internal #259)", () => {
  const mac = (answer: { ok: boolean; reason?: string; performed?: boolean }) => ({
    macPermissions: () => ({ accessibility: true, screenCapture: true }),
    macListWindows: () => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "ダウンロード" }],
    macGetFocus: async () => ({ pid: 7 }),
    macAxTree: vi.fn(tree),
    macAxPerform: vi.fn(async () => answer),
    macAxSetValue: vi.fn(async () => ({ ok: true })),
    macAxInsertText: vi.fn(async () => ({ ok: true })),
  });
  const parse = (r: unknown) => JSON.parse((r as { content: { text?: string }[] }).content[0]!.text!);
  const discover = async (m: ReturnType<typeof mac>) => {
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(m as never, state);
    const d = parse(await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "ダウンロード" }, view: "explore" }));
    const item = d.entities.find((e: { label?: string; role?: string }) => e.label === "デスクトップ" && e.role === "listitem");
    return { state, facade, item };
  };
  it("invoke opens it, and an unconfirmed open answers ok with open.confirmed false", async () => {
    const m = mac({ ok: false, reason: "attribute_unsupported", performed: true });
    const { state, facade, item } = await discover(m);
    expect(item?.primaryAction).toBe("invoke");
    const r = parse(await macActHandler(m as never, facade, state, { lease: item.lease, action: "invoke" }));
    expect(m.macAxPerform).toHaveBeenCalledTimes(1);
    expect((m.macAxPerform.mock.calls[0] as unknown[])[1]).toBe("AXOpen");
    expect(r.ok).toBe(true);
    expect(r.open?.confirmed).toBe(false);
    expect(r.landing).toBeUndefined();
  });
  it("hands the row's name to the native act, which refuses when the row now holds another item (gate 2 on #927)", async () => {
    // The native act compares the name on the element it found; here it answers as it does then.
    const m = mac({ ok: false, reason: "element_changed" });
    const { state, facade } = await discover(m);
    const d = parse(await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "ダウンロード" }, view: "explore" }));
    const row = d.entities.find((e: { label?: string }) => e.label === "pictkura-ci");
    const r = parse(await macActHandler(m as never, facade, state, { lease: row.lease, action: "invoke" }));
    expect((m.macAxPerform.mock.calls[0] as unknown[])[0]).toMatchObject({ expectedItemName: "pictkura-ci" });
    expect(r.ok).not.toBe(true);
    expect(r.open).toBeUndefined();
  });
  it("a confirmed open, and the act after it, carry no open note", async () => {
    const m = mac({ ok: false, reason: "attribute_unsupported", performed: true });
    const { state, facade, item } = await discover(m);
    await macActHandler(m as never, facade, state, { lease: item.lease, action: "invoke" });
    m.macAxPerform.mockImplementation(async () => ({ ok: true, performed: true }));
    const again = await discover(m);
    const r = parse(await macActHandler(m as never, again.facade, again.state, { lease: again.item.lease, action: "invoke" }));
    expect(r.ok).toBe(true);
    expect(r.open).toBeUndefined();
  });
  it("auto and click never open it: nothing is sent", async () => {
    for (const action of ["auto", "click"]) {
      const m = mac({ ok: true });
      const { state, facade, item } = await discover(m);
      const r = parse(await macActHandler(m as never, facade, state, { lease: item.lease, action }));
      expect(m.macAxPerform).not.toHaveBeenCalled();
      expect(r).toMatchObject({ ok: false, reason: "action_not_offered" });
    }
  });
  it("the executor refuses anything but invoke on a cell, should the loop let one through", async () => {
    const perform = vi.fn(async () => ({ ok: true }));
    const entity = { role: "listitem", locator: { ax: { pid: 7, id: "a.0.0.1.0", role: "AXCell", rootKey: WIN, elementKey: "k", unique: false } } } as never;
    await expect(createMacAxExecutor({ perform, setValue: vi.fn() } as never)(entity, "click")).rejects.toBeInstanceOf(MacAxActError);
    expect(perform).not.toHaveBeenCalled();
  });
});
