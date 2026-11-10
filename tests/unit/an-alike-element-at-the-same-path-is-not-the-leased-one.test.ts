/**
 * internal #271: the Mac act took the element at the leased path when its role and element key
 * (frame included) matched. AX gives an element no identity of its own, so when R1 of a list was
 * removed and R2 moved up into its index and frame, R1's Delete lease pressed R2's Delete
 * (measured 2026-11-10 in Safari on main: ok:true, "deleted:r2"). An element that is not unique now
 * carries its siblings as read, and the native act refuses when they are not the same.
 */
import { describe, it, expect, vi } from "vitest";
import {
  siblingSignature, readMacAxCandidates, SIBLINGS_EACH_SIDE,
  type MacAxProviderDeps, type MacAxReadNotes,
} from "../../src/tools/mac/ax-provider.js";
import { createMacAxExecutor } from "../../src/tools/mac/ax-executor.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";

const ROOT = "k271 rows\u001f\u001f0,0,800,600";
const el = (id: string, role: string, over: Partial<NativeMacAxElement> = {}): NativeMacAxElement => ({
  id, rootKey: ROOT, elementKey: `k:${id}`, depth: id.split(".").length - 2, role,
  actions: role === "AXButton" ? ["AXPress"] : [], valueSettable: false, childCount: 0, ...over,
});
// Safari's shape: the rows flattened into one parent (measured).
const list = (names: string[]) => [
  el("a.0", "AXWindow", { childCount: 1 }),
  el("a.0.0", "AXGroup", { childCount: names.length * 2 + 1 }),
  el("a.0.0.0", "AXGroup"),
  ...names.flatMap((n, i) => [
    el(`a.0.0.${i * 2 + 1}`, "AXStaticText", { value: n }),
    // Same key for every Delete: the frame is what they differ by, and a row that moves up takes it.
    el(`a.0.0.${i * 2 + 2}`, "AXButton", { title: "Delete", elementKey: "Delete-key" }),
  ]),
];
const sig = (elements: NativeMacAxElement[], id: string) => {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return siblingSignature(byId.get(id)!, byId);
};

describe("siblingSignature", () => {
  it("is the siblings around it, in the native act's format, and tells R1's Delete from R2's", () => {
    const before = list(["R1 りんご", "R2 みかん", "R3 ぶどう"]);
    const r1 = sig(before, "a.0.0.2")!;
    // The literal the Rust test pins too (sibling_entry_tests, src/macos/ax.rs).
    expect(r1).toBe(
      [
        "7:AXGroup0:0:0:",
        "12:AXStaticText0:0:6:R1 りんご",
        "8:AXButton6:Delete0:0:",
        "12:AXStaticText0:0:6:R2 みかん",
        "8:AXButton6:Delete0:0:",
        "12:AXStaticText0:0:6:R3 ぶどう",
      ].join("")
    );
    // R1 went: R2's Delete now sits at R1's path. Its siblings there are not R1's.
    const after = list(["R2 みかん", "R3 ぶどう"]);
    expect(sig(after, "a.0.0.2")).not.toBe(r1);
  });
  it("holds SIBLINGS_EACH_SIDE on each side: a change farther away does not change it", () => {
    const names = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
    const a = list(names);
    const b = list([...names.slice(0, 11), "R12 changed"]);
    expect(SIBLINGS_EACH_SIDE).toBe(3);
    expect(sig(b, "a.0.0.2")).toBe(sig(a, "a.0.0.2"));
    expect(sig(b, "a.0.0.22")).not.toBe(sig(a, "a.0.0.22"));
  });
  it("reads a value for a static text only", () => {
    const e = [el("a.0", "AXWindow", { childCount: 2 }), el("a.0.0", "AXButton", { title: "Go", value: "1" }), el("a.0.1", "AXStaticText", { value: "x" })];
    expect(sig(e, "a.0.0")).toBe("8:AXButton2:Go0:0:12:AXStaticText0:0:1:x");
  });
  it("a separator in a page's text cannot make two spans read alike (lengths, not separators)", () => {
    const a = [el("a.0", "AXWindow", { childCount: 2 }), el("a.0.0", "AXStaticText", { value: "x\u001f" }), el("a.0.1", "AXStaticText", { value: "y" })];
    const b = [el("a.0", "AXWindow", { childCount: 2 }), el("a.0.0", "AXStaticText", { value: "x" }), el("a.0.1", "AXStaticText", { value: "\u001fy" })];
    expect(sig(a, "a.0.0")).not.toBe(sig(b, "a.0.0"));
    // Lengths count characters (code points), as Rust's chars().count(), not UTF-16 units.
    const emoji = [el("a.0", "AXWindow", { childCount: 1 }), el("a.0.0", "AXStaticText", { value: "😀" })];
    expect(sig(emoji, "a.0.0")).toBe("12:AXStaticText0:0:1:😀");
  });
  it("is undefined when the read does not hold every sibling in the span, or for a root", () => {
    const full = list(["R1", "R2"]);
    const missing = full.filter((e) => e.id !== "a.0.0.3");
    expect(sig(missing, "a.0.0.2")).toBeUndefined();
    expect(sig(full, "a.0")).toBeUndefined();
    // A parent whose count says more children than the span holds still answers from what is there.
    expect(sig(full, "a.0.0.2")).toBeDefined();
  });
});

describe("the provider and the executor carry it for an element that is not unique only", () => {
  const read = async (elements: NativeMacAxElement[]) => {
    const deps = {
      listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "k271 rows" }]),
      getFocus: vi.fn(),
      axTree: vi.fn(async () => ({ pid: 7, appTitle: "Safari", elements, truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1 })),
      now: vi.fn(() => 1000),
    };
    const notes: MacAxReadNotes = { warnings: [] };
    return readMacAxCandidates(deps as unknown as MacAxProviderDeps, { windowTitle: "k271" }, notes);
  };
  it("three alike Deletes carry their siblings; a unique button does not", async () => {
    const elements = list(["R1", "R2", "R3"]);
    elements.push(el("a.0.1", "AXButton", { title: "Add" }));
    elements[0] = el("a.0", "AXWindow", { childCount: 2 });
    const c = await read(elements);
    const deletes = c.filter((x) => x.label === "Delete");
    expect(deletes).toHaveLength(3);
    for (const d of deletes) {
      expect(d.locator?.ax?.unique).toBe(false);
      expect(d.locator?.ax?.siblings).toBe(sig(elements, d.locator!.ax!.id));
    }
    const add = c.find((x) => x.label === "Add")!;
    expect(add.locator?.ax?.unique).toBe(true);
    expect(add.locator?.ax).not.toHaveProperty("siblings");
  });
  it("an element not known unique but with no twin in the read carries none (Finder reads incomplete)", async () => {
    const elements = list(["R1"]);
    const deps = {
      listWindows: vi.fn(() => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "k271 rows" }]),
      getFocus: vi.fn(),
      axTree: vi.fn(async () => ({ pid: 7, appTitle: "Finder", elements, truncated: false, readIncomplete: true, selfReference: false, displayAsleep: false, elapsedMs: 1 })),
      now: vi.fn(() => 1000),
    };
    const c = await readMacAxCandidates(deps as unknown as MacAxProviderDeps, { windowTitle: "k271" }, { warnings: [] });
    const del = c.find((x) => x.label === "Delete")!;
    expect(del.locator?.ax?.unique).toBe(false);
    expect(del.locator?.ax).not.toHaveProperty("siblings");
  });
  it("the executor sends them as expectedSiblings, and not for a unique element", async () => {
    const perform = vi.fn(async () => ({ ok: true }));
    const exec = createMacAxExecutor({ perform, setValue: vi.fn() } as any);
    const ax = { pid: 7, id: "a.0.0.2", role: "AXButton", rootKey: ROOT, elementKey: "Delete-key" };
    await exec({ locator: { ax: { ...ax, unique: false, siblings: "S" } } } as any, "click");
    expect(perform).toHaveBeenLastCalledWith(expect.objectContaining({ expectedSiblings: "S", relocatable: false }), "AXPress");
    await exec({ locator: { ax: { ...ax, unique: true, siblings: "S" } } } as any, "click");
    expect(perform.mock.calls.at(-1)![0]).not.toHaveProperty("expectedSiblings");
  });
});
