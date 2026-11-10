/**
 * internal #259 — Finder's sidebar entries are AXOutline > AXRow > AXCell; the cell advertises AXOpen,
 * and Finder opens the place yet answers `attribute_unsupported` (measured 2026-11-10, macOS 27.2,
 * 5 of 5). A sidebar entry is offered as a `listitem` named by its text, with `invoke` only; the act
 * sends AXOpen with the name to check, and once sent never answers "nothing was done". List rows
 * (a file-name field; two can show one name) are not offered (gate 2 on #927).
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
  el("a.0.2", "AXButton", { title: "共有", actions: ["AXPress"] }),
];
let current = elements;
const tree = async () => ({ pid: 7, appTitle: "Finder", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1, elements: current });
const deps = () => ({ listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "ダウンロード" }]), getFocus: vi.fn(async () => ({ pid: 7 })), axTree: vi.fn(tree), now: () => 1 });

describe("Finder cells that open are offered (internal #259)", () => {
  it("offers a sidebar entry as a listitem named by its text, with invoke only; a list row stays as it was", async () => {
    const notes: MacAxReadNotes = { warnings: [] };
    const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, notes);
    const items = cs.filter((c) => c.role === "listitem").map((c) => [c.label, c.actionability]);
    expect(items).toEqual([["デスクトップ", ["invoke"]]]);
    // The text an entry is named by is not offered again beside it (gate 2 on #927); a heading's is.
    expect(cs.filter((c) => c.label === "デスクトップ").map((c) => c.role)).toEqual(["listitem"]);
    expect(cs.some((c) => c.label === "よく使う項目" && c.role === "label")).toBe(true);
    // A row's file name is still the label it was (#256), not something to open.
    expect(cs.filter((c) => c.label === "pictkura-ci").map((c) => [c.role, c.actionability])).toEqual([["label", ["read"]]]);
  });
  it("offers nothing to open in another app: Finder's answer to AXOpen was measured, no other's (gate 2 on #927)", async () => {
    const d = { ...deps(), axTree: vi.fn(async () => ({ ...(await tree()), appTitle: "Mail" })) };
    const cs = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
    expect(cs.some((c) => c.role === "listitem")).toBe(false);
  });
  it("offers neither of two entries that show one name (two volumes named Untitled)", async () => {
    current = [
      ...elements,
      el("a.0.0.9", "AXRow", { subrole: "AXOutlineRow" }),
      el("a.0.0.9.0", "AXCell", { actions: ["AXOpen"] }),
      el("a.0.0.9.0.0", "AXStaticText", { value: "デスクトップ" }),
    ];
    try {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      expect(cs.some((c) => c.role === "listitem")).toBe(false);
    } finally {
      current = elements;
    }
  });
  it("names an entry by its first static text only: an unread first text names nothing (gate 2 on #927)", async () => {
    current = [
      el("a.0", "AXWindow", { title: "ダウンロード" }),
      el("a.0.0", "AXCell", { actions: ["AXOpen"] }),
      el("a.0.0.0", "AXStaticText"), // its value could not be read
      el("a.0.0.1", "AXStaticText", { value: "サブタイトル" }),
    ];
    try {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      expect(cs.some((c) => c.role === "listitem")).toBe(false);
    } finally {
      current = elements;
    }
  });
  it("offers nothing to open from a read cut short (a twin may lie past the cut; gate 2 on #927)", async () => {
    const d = { ...deps(), axTree: vi.fn(async () => ({ ...(await tree()), truncated: true })) };
    const cs = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
    expect(cs.some((c) => c.role === "listitem")).toBe(false);
  });
  it("still offers entries from a read with a part unread, as every Finder read is (the act counts the name itself)", async () => {
    const d = { ...deps(), axTree: vi.fn(async () => ({ ...(await tree()), readIncomplete: true })) };
    const cs = await readMacAxCandidates(d as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
    expect(cs.filter((c) => c.role === "listitem").map((c) => c.label)).toEqual(["デスクトップ"]);
  });
  it("does not take a named entry for unique when a nameless twin is in the window (gate 2 on #927)", async () => {
    const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
    // a.0.0.3.0 opens but holds no text: it is the named entry's twin but for the name.
    expect(cs.find((c) => c.role === "listitem")!.locator?.ax?.unique).toBe(false);
  });
  it("makes a row that holds another entry another entity (its name is part of its identity; gate 2 on #927)", async () => {
    const digestOf = async () => {
      const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, { warnings: [] });
      return cs.find((c) => c.role === "listitem" && c.locator?.ax?.id === "a.0.0.1.0")!.digest;
    };
    const before = await digestOf();
    current = elements.map((e) => (e.id === "a.0.0.1.0.0" ? { ...e, value: "書類" } : e));
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
    const noteOpen = vi.fn();
    const out = await createMacAxExecutor({ perform, setValue: vi.fn(), noteOpen } as never)(entity, action as never);
    return { perform, out, noteOpen };
  };
  it("sends AXOpen, not AXPress, carrying the name read so the native act checks it just before (gate 2 on #927)", async () => {
    const { perform, out, noteOpen } = await run({ ok: true, performed: true });
    expect(perform.mock.calls[0]![1]).toBe("AXOpen");
    expect(perform.mock.calls[0]![0]).toMatchObject({ id: "a.0.0.1.0", expectedItemName: "デスクトップ" });
    expect(out).toBe("ax");
    expect(noteOpen).toHaveBeenCalledWith({ confirmed: true });
  });
  it("answers ok with the open unconfirmed only when it was sent and answered as Finder answers when it opened", async () => {
    const { out, noteOpen } = await run({ ok: false, reason: "attribute_unsupported", performed: true });
    expect(out).toBe("ax");
    expect(noteOpen).toHaveBeenCalledTimes(1);
    expect(noteOpen.mock.calls[0]![0]).toMatchObject({ confirmed: false });
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
    // Discover again whatever the diff says: the window is retitled (gate 2 on #927).
    expect(r.next).toBe("refresh_view");
    expect(r.landing).toBeUndefined();
  });
  it("hands the entry's name to the native act, which refuses when the row now holds another entry (gate 2 on #927)", async () => {
    // The native act compares the name on the element it found; here it answers as it does then.
    const m = mac({ ok: false, reason: "element_changed" });
    const { state, facade } = await discover(m);
    const d = parse(await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "ダウンロード" }, view: "explore" }));
    const entry = d.entities.find((e: { label?: string; role?: string }) => e.label === "デスクトップ" && e.role === "listitem");
    const r = parse(await macActHandler(m as never, facade, state, { lease: entry.lease, action: "invoke" }));
    expect((m.macAxPerform.mock.calls[0] as unknown[])[0]).toMatchObject({ expectedItemName: "デスクトップ" });
    expect(r.ok).not.toBe(true);
    expect(r.open).toBeUndefined();
  });
  it("a confirmed open says so and asks for a discover too; the act after an open carries no stale note (gate 2 on #927)", async () => {
    const m = mac({ ok: false, reason: "attribute_unsupported", performed: true });
    const { state, facade, item } = await discover(m);
    await macActHandler(m as never, facade, state, { lease: item.lease, action: "invoke" });
    m.macAxPerform.mockImplementation(async () => ({ ok: true, performed: true }));
    const again = await discover(m);
    const r = parse(await macActHandler(m as never, again.facade, again.state, { lease: again.item.lease, action: "invoke" }));
    expect(r.ok).toBe(true);
    expect(r.open).toEqual({ confirmed: true });
    expect(r.next).toBe("refresh_view");
    // A successful act that is not an open, after one, carries no open note (gate 2 on #927: a
    // refused act would never show it).
    const third = parse(await macDiscoverHandler(m as never, again.facade, again.state, { target: { windowTitle: "ダウンロード" }, view: "explore" }));
    const share = third.entities.find((e: { label?: string }) => e.label === "共有");
    const press = parse(await macActHandler(m as never, again.facade, again.state, { lease: share.lease, action: "click" }));
    expect(press.ok).toBe(true);
    expect((m.macAxPerform.mock.calls.at(-1) as unknown[])[1]).toBe("AXPress");
    expect(press.open).toBeUndefined();
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
});
