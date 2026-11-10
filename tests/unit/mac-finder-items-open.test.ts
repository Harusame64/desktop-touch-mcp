/**
 * internal #259 — Finder's sidebar entries and list rows are AXOutline > AXRow > AXCell; the cell
 * advertises AXOpen, and Finder opens the item yet answers `attribute_unsupported` (measured
 * 2026-11-10, macOS 27.2, 5 of 5). A cell that opens is offered as a `listitem` named by its text,
 * with `invoke` only; the act sends AXOpen and, once sent, never answers "nothing was done".
 */
import { describe, it, expect, vi } from "vitest";
import { readMacAxCandidates, type MacAxProviderDeps, type MacAxReadNotes } from "../../src/tools/mac/ax-provider.js";
import { createMacAxExecutor, MacAxActError } from "../../src/tools/mac/ax-executor.js";
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
const tree = async () => ({ pid: 7, appTitle: "Finder", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1, elements });
const deps = () => ({ listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "ダウンロード" }]), getFocus: vi.fn(async () => ({ pid: 7 })), axTree: vi.fn(tree), now: () => 1 });

describe("Finder cells that open are offered (internal #259)", () => {
  it("offers a sidebar entry and a list row as listitems named by their text, with invoke only", async () => {
    const notes: MacAxReadNotes = { warnings: [] };
    const cs = await readMacAxCandidates(deps() as unknown as MacAxProviderDeps, { windowTitle: "ダウンロード" }, notes);
    const items = cs.filter((c) => c.role === "listitem").map((c) => [c.label, c.actionability]);
    expect(items).toEqual([["デスクトップ", ["invoke"]], ["pictkura-ci", ["invoke"]]]);
  });
});

describe("the act on a cell sends AXOpen (internal #259)", () => {
  const entity = { locator: { ax: { pid: 7, id: "a.0.0.1.0", role: "AXCell", rootKey: WIN, elementKey: "k", unique: false } } } as never;
  const run = async (answer: { ok: boolean; reason?: string }) => {
    const perform = vi.fn(async () => answer);
    const out = await createMacAxExecutor({ perform, setValue: vi.fn() } as never)(entity, "invoke");
    return { perform, out };
  };
  it("sends AXOpen, not AXPress", async () => {
    const { perform, out } = await run({ ok: true });
    expect(perform.mock.calls[0]![1]).toBe("AXOpen");
    expect(out).toEqual({ kind: "ax" });
  });
  it("answers ok with the open unconfirmed when the app answers an error after it was sent (Finder: attribute_unsupported)", async () => {
    for (const reason of ["attribute_unsupported", "invalid_ui_element", "cannot_complete"]) {
      const { out } = await run({ ok: false, reason });
      expect(out).toMatchObject({ kind: "ax", landing: { confirmed: false } });
    }
  });
  it("refuses, nothing done, when the open was never sent", async () => {
    await expect(run({ ok: false, reason: "element_not_found" })).rejects.toBeInstanceOf(TargetGoneError);
    await expect(run({ ok: false, reason: "element_changed" })).rejects.toBeInstanceOf(TargetGoneError);
    await expect(run({ ok: false, reason: "action_not_advertised" })).rejects.toBeInstanceOf(MacAxActError);
  });
});

describe("desktop_act on a Finder item (internal #259)", () => {
  const mac = (answer: { ok: boolean; reason?: string }) => ({
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
  it("invoke opens it, and an unconfirmed open answers ok with landing.confirmed false", async () => {
    const m = mac({ ok: false, reason: "attribute_unsupported" });
    const { state, facade, item } = await discover(m);
    expect(item?.primaryAction).toBe("invoke");
    const r = parse(await macActHandler(m as never, facade, state, { lease: item.lease, action: "invoke" }));
    expect(m.macAxPerform).toHaveBeenCalledTimes(1);
    expect((m.macAxPerform.mock.calls[0] as unknown[])[1]).toBe("AXOpen");
    expect(r.ok).toBe(true);
    expect(r.landing?.confirmed).toBe(false);
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
    const entity = { locator: { ax: { pid: 7, id: "a.0.0.1.0", role: "AXCell", rootKey: WIN, elementKey: "k", unique: false } } } as never;
    await expect(createMacAxExecutor({ perform, setValue: vi.fn() } as never)(entity, "click")).rejects.toBeInstanceOf(MacAxActError);
    expect(perform).not.toHaveBeenCalled();
  });
});
