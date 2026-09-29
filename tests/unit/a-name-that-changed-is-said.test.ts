/**
 * internal #211 (B) — rich narration says an element's Name changed (`nameDeltas`), pairing the
 * element before the act with the one after by `runtimeId`, then by a one-to-one `path`.
 *
 * MEASURED win2 (S10, 2026-09-29): Calculator's display, a Notepad toggle and a WPF label kept their
 * RuntimeId across the act; Explorer's status bar and a Chrome text leaf came back with new
 * RuntimeIds (the status bar's parent too) on the same path, one element each. Before this, a Name
 * change read as one element disappearing and another appearing, and `valueDeltas` stayed empty on
 * a calculator whose display changed (dogfood item 3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { computeUiaDiff } from "../../src/engine/uia-diff.js";
import type { UiElement } from "../../src/engine/uia-bridge.js";

const rect = { x: 0, y: 0, width: 50, height: 20 };
const el = (name: string, extra: Partial<UiElement> = {}): UiElement => ({
  name, controlType: "Text", automationId: "", isEnabled: true, boundingRect: rect, patterns: [], depth: 4, ...extra,
});

describe("pairing by RuntimeId", () => {
  it("says the display's Name changed, not that one element went and another came (Calculator)", () => {
    const d = computeUiaDiff(
      [el("表示は 8", { runtimeId: "42.4719960.4.15", path: "/Window[1]/Custom[1]/Group[1]/Text[1]" })],
      [el("表示は 15", { runtimeId: "42.4719960.4.15", path: "/Window[1]/Custom[1]/Group[1]/Text[1]" })],
    );
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "表示は 8", after: "表示は 15" }]);
    expect(d.appeared).toEqual([]);
    expect(d.disappeared).toEqual([]);
  });

  it("pairs by RuntimeId even when the element moved to another path", () => {
    const d = computeUiaDiff(
      [el("A", { runtimeId: "1.1", path: "/Pane[0]/Text[0]" })],
      [el("B", { runtimeId: "1.1", path: "/Pane[0]/Text[3]" }), el("C", { runtimeId: "1.9", path: "/Pane[0]/Text[0]" })],
    );
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "A", after: "B" }]);
    expect(d.appeared).toEqual([{ name: "C", type: "Text" }]);
    expect(d.disappeared).toEqual([]);
  });

  it("carries a ValuePattern change on a RuntimeId pair in valueDeltas, not nameDeltas", () => {
    const d = computeUiaDiff(
      [el("File name", { controlType: "Edit", runtimeId: "7.1", value: "" })],
      [el("File name", { controlType: "Edit", runtimeId: "7.1", value: "memo.txt" })],
    );
    expect(d.valueDeltas).toEqual([{ name: "File name", type: "Edit", before: "", after: "memo.txt" }]);
    expect(d.nameDeltas).toBeUndefined();
  });
});

describe("pairing a rebuilt element by its path", () => {
  const status = "/Window[0]/Pane[1]/Pane[0]/StatusBar[1]/Group[0]/Text[0]";

  it("says Explorer's status bar changed, though the app rebuilt it with a new RuntimeId", () => {
    const d = computeUiaDiff(
      [el("4 個の項目", { runtimeId: "42.1.4.100", path: status })],
      [el("2 個の項目", { runtimeId: "42.1.4.230", path: status })],
    );
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "4 個の項目", after: "2 個の項目" }]);
    expect(d.appeared).toEqual([]);
    expect(d.disappeared).toEqual([]);
  });

  it("does not pair two at one path: which is which cannot be told", () => {
    const d = computeUiaDiff(
      [el("row a", { runtimeId: "1", path: "/List[0]/Text[0]" }), el("row b", { runtimeId: "2", path: "/List[0]/Text[0]" })],
      [el("row c", { runtimeId: "3", path: "/List[0]/Text[0]" }), el("row d", { runtimeId: "4", path: "/List[0]/Text[0]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared.map((a) => a.name).sort()).toEqual(["row c", "row d"]);
    expect(d.disappeared.map((a) => a.name).sort()).toEqual(["row a", "row b"]);
  });

  it("does not pair one before with two after at the same path", () => {
    const d = computeUiaDiff(
      [el("old", { runtimeId: "1", path: "/List[0]/Text[0]" })],
      [el("new 1", { runtimeId: "2", path: "/List[0]/Text[0]" }), el("new 2", { runtimeId: "3", path: "/List[0]/Text[0]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "old", type: "Text" }]);
  });

  it("does not pair across control types at one index: the path names the type", () => {
    const d = computeUiaDiff(
      [el("Save", { controlType: "Button", runtimeId: "1", path: "/Pane[0]/Button[2]" })],
      [el("Saved", { controlType: "Text", runtimeId: "2", path: "/Pane[0]/Text[2]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared).toEqual([{ name: "Saved", type: "Text" }]);
    expect(d.disappeared).toEqual([{ name: "Save", type: "Button" }]);
  });

  it("does not pair by path what RuntimeId already paired elsewhere", () => {
    const d = computeUiaDiff(
      [el("kept", { runtimeId: "1", path: "/P[0]/Text[0]" }), el("gone", { runtimeId: "2", path: "/P[0]/Text[1]" })],
      [el("kept", { runtimeId: "1", path: "/P[0]/Text[1]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "gone", type: "Text" }]);
  });
});

describe("pairing by path is only for an element rebuilt on its own (gate 2)", () => {
  it("does not pair the rows of a list refilled with other items: they appeared and disappeared", () => {
    const row = (name: string, i: number, rid: string) => el(name, { controlType: "ListItem", runtimeId: rid, path: `/List[0]/ListItem[${i}]` });
    const d = computeUiaDiff(
      [row("a.txt", 0, "1"), row("b.txt", 1, "2")],
      [row("x.png", 0, "9"), row("y.png", 1, "8")],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared.map((a) => a.name).sort()).toEqual(["x.png", "y.png"]);
    expect(d.disappeared.map((a) => a.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("still pairs the one rebuilt element when its list siblings kept their RuntimeIds", () => {
    const d = computeUiaDiff(
      [el("keep", { runtimeId: "1", path: "/P[0]/Text[0]" }), el("3 items", { runtimeId: "2", path: "/P[0]/Text[1]" })],
      [el("keep", { runtimeId: "1", path: "/P[0]/Text[0]" }), el("2 items", { runtimeId: "7", path: "/P[0]/Text[1]" })],
    );
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "3 items", after: "2 items" }]);
  });

  it("does not pair a replaced button whose automationId says it is another (next -> finish)", () => {
    const d = computeUiaDiff(
      [el("Next", { controlType: "Button", automationId: "next", runtimeId: "1", path: "/Pane[0]/Button[2]" })],
      [el("Finish", { controlType: "Button", automationId: "finish", runtimeId: "2", path: "/Pane[0]/Button[2]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared).toEqual([{ name: "Finish", type: "Button", automationId: "finish" }]);
  });

  it("pairs one left on each side under a parent only when they sit at the same index", () => {
    const d = computeUiaDiff(
      [el("old", { runtimeId: "1", path: "/P[0]/Text[0]" })],
      [el("new", { runtimeId: "2", path: "/P[0]/Text[1]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
  });

  it("does not say the Name of an element hidden on either side changed", () => {
    const hidden = { x: 0, y: 0, width: 0, height: 0 };
    const d = computeUiaDiff(
      [el("x", { runtimeId: "1", boundingRect: hidden }), el("a", { runtimeId: "2" })],
      [el("Saved", { runtimeId: "1" }), el("b", { runtimeId: "2", boundingRect: hidden })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared).toEqual([{ name: "Saved", type: "Text" }]);
    expect(d.disappeared).toEqual([{ name: "a", type: "Text" }]);
  });

  it("does not report an unlabeled field's value change: it cannot be told from another's", () => {
    const d = computeUiaDiff(
      [el("", { controlType: "Edit", runtimeId: "1", value: "" })],
      [el("", { controlType: "Edit", runtimeId: "1", value: "abc" })],
    );
    expect(d.valueDeltas).toEqual([]);
  });
});

describe("a list refilled in another order is not a rename (win2 on #750)", () => {
  // Explorer's refresh, 3 of 5: the rows are recycled — a row keeps its RuntimeId (or its position)
  // and shows another file — and nothing was renamed. Every name is still there after.
  const row = (name: string, i: number, rid: string) => el(name, { controlType: "ListItem", runtimeId: rid, path: `/List[0]/ListItem[${i}]` });

  it("does not say a recycled row was renamed when its RuntimeId stayed (rep1's shape)", () => {
    const d = computeUiaDiff(
      [row("alpha.txt", 0, "1"), row("beta.txt", 1, "2"), row("gamma.txt", 2, "3"), row("sub1", 3, "4")],
      [row("alpha.txt", 0, "1"), row("gamma.txt", 1, "2"), row("sub1", 2, "3"), row("beta.txt", 3, "4")],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared).toEqual([]);
    expect(d.disappeared).toEqual([]);
  });

  it("does not say it when one row was rebuilt at a position another file now holds", () => {
    const d = computeUiaDiff(
      [row("alpha.txt", 0, "1"), row("beta.txt", 1, "2")],
      [row("beta.txt", 0, "1"), row("alpha.txt", 1, "9")],
    );
    expect(d.nameDeltas).toBeUndefined();
  });

  it("says a row renamed for real as one gone and one new: inside a list it cannot be told from a refill", () => {
    const d = computeUiaDiff(
      [row("alpha.txt", 0, "1"), row("draft.txt", 1, "2")],
      [row("alpha.txt", 0, "1"), row("final.txt", 1, "2")],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "draft.txt", type: "ListItem" }]);
    expect(d.appeared).toEqual([{ name: "final.txt", type: "ListItem" }]);
  });

  it("does not say a list moved to another folder renamed its rows, though every name is new (PR codex P2)", () => {
    // A virtualized list keeps its rows' RuntimeIds and fills them with the other folder's files.
    const d = computeUiaDiff(
      [row("a.txt", 0, "1"), row("b.txt", 1, "2")],
      [row("x.png", 0, "1"), row("y.png", 1, "2")],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared.map((a) => a.name).sort()).toEqual(["x.png", "y.png"]);
    expect(d.disappeared.map((a) => a.name).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("does not pair a one-row list's row with the next folder's one row by position (PR codex P2)", () => {
    const d = computeUiaDiff([row("only.txt", 0, "1")], [row("other.txt", 0, "9")]);
    expect(d.nameDeltas).toBeUndefined();
    expect(d.appeared).toEqual([{ name: "other.txt", type: "ListItem" }]);
  });

  it("does not say it of an element inside a row either (its path runs through the row)", () => {
    const cell = (name: string, rid: string) => el(name, { runtimeId: rid, path: "/List[0]/ListItem[0]/Text[0]" });
    const d = computeUiaDiff([cell("a.txt", "1")], [cell("x.png", "1")]);
    expect(d.nameDeltas).toBeUndefined();
  });

  it("does not say it when only the element after the act sits in a row", () => {
    const d = computeUiaDiff(
      [el("draft", { runtimeId: "1", path: "/Pane[0]/Text[0]" })],
      [el("final", { runtimeId: "1", path: "/List[0]/ListItem[0]/Text[0]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
  });

  it("says a row renamed on disk as one gone and one new, though Explorer's row id is its position (win2 on #750)", () => {
    // Explorer's ListItem automationIds are row numbers; alpha-renamed.txt sorts into alpha.txt's
    // place and keeps "1". The old key paired them by that id.
    const file = (name: string, i: number, rid: string) =>
      el(name, { controlType: "ListItem", automationId: String(i), runtimeId: rid, path: `/List[0]/ListItem[${i}]` });
    const d = computeUiaDiff(
      [file("sub1", 0, "a"), file("alpha.txt", 1, "b"), file("beta.txt", 2, "c")],
      [file("sub1", 0, "a"), file("alpha-renamed.txt", 1, "x"), file("beta.txt", 2, "c")],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "alpha.txt", type: "ListItem" }]);
    expect(d.appeared).toEqual([{ name: "alpha-renamed.txt", type: "ListItem", automationId: "1" }]);
  });

  it("says only the new file when one sorts in above others and Explorer renumbers the rows", () => {
    const file = (name: string, i: number, rid: string) =>
      el(name, { controlType: "ListItem", automationId: String(i), runtimeId: rid, path: `/List[0]/ListItem[${i}]` });
    const d = computeUiaDiff(
      [file("alpha.txt", 0, "a"), file("beta.txt", 1, "b"), file("gamma.txt", 2, "c")],
      [file("alpha.txt", 0, "p"), file("b2.txt", 1, "q"), file("beta.txt", 2, "r"), file("gamma.txt", 3, "s")],
    );
    expect(d).toEqual({ appeared: [{ name: "b2.txt", type: "ListItem", automationId: "1" }], disappeared: [], valueDeltas: [] });
  });

  it("does not pair by name across automationIds when only one side is in a row, either way", () => {
    const inRow = (aid: string) => el("Field", { automationId: aid, path: "/List[0]/ListItem[0]/Text[0]" });
    const outside = (aid: string) => el("Field", { automationId: aid, path: "/Pane[0]/Text[0]" });
    // Paired, the element outside the row would be said nowhere; unpaired, it is said on its side.
    // (The element inside the row is a cell, and cells are not said: see "a new row's cells".)
    const toRow = computeUiaDiff([outside("f1")], [inRow("f2")]);
    expect(toRow.disappeared).toEqual([{ name: "Field", type: "Text" }]);
    const fromRow = computeUiaDiff([inRow("f1")], [outside("f2")]);
    expect(fromRow.appeared).toEqual([{ name: "Field", type: "Text", automationId: "f2" }]);
  });

  it("still says a status line renamed under its automationId (not a collection row)", () => {
    const d = computeUiaDiff([el("3 items", { automationId: "status" })], [el("2 items", { automationId: "status" })]);
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "3 items", after: "2 items" }]);
  });

  it("does not say it of a grid's or a tree's rows", () => {
    for (const controlType of ["DataItem", "TreeItem"]) {
      const d = computeUiaDiff([el("a", { controlType, runtimeId: "1" })], [el("b", { controlType, runtimeId: "1" })]);
      expect(d.nameDeltas).toBeUndefined();
    }
  });

  it("says a counter changed under its RuntimeId though another shows its old value (PR codex P2)", () => {
    // Two Text counters named "0"; one becomes "1". Outside a list RuntimeId is kept without the name
    // test, which would have refused it: "0" is still shown by the other.
    const d = computeUiaDiff(
      [el("0", { runtimeId: "1" }), el("0", { runtimeId: "2" })],
      [el("1", { runtimeId: "1" }), el("0", { runtimeId: "2" })],
    );
    expect(d).toEqual({ appeared: [], disappeared: [], valueDeltas: [], nameDeltas: [{ type: "Text", before: "0", after: "1" }] });
  });

  it("still holds a position pair to the name test when another element shows the old name", () => {
    const d = computeUiaDiff(
      [el("0", { runtimeId: "1", path: "/P[0]/Text[0]" }), el("0", { runtimeId: "2", path: "/Q[1]/Text[0]" })],
      [el("1", { runtimeId: "8", path: "/P[0]/Text[0]" }), el("0", { runtimeId: "2", path: "/Q[1]/Text[0]" })],
    );
    expect(d.nameDeltas).toBeUndefined();
  });

  it("does not say it when the old name moved to an element that appeared (a row inserted above)", () => {
    const d = computeUiaDiff(
      [row("alpha.txt", 0, "1")],
      [row("new.txt", 0, "1"), row("alpha.txt", 1, "9")],
    );
    expect(d.nameDeltas).toBeUndefined();
    // The recycled pair is undone, so alpha.txt pairs with itself and only the new row appeared.
    expect(d.appeared).toEqual([{ name: "new.txt", type: "ListItem" }]);
    expect(d.disappeared).toEqual([]);
  });

  it("says nothing of a refresh that handed one row's RuntimeId to another file (win2 rep4 on #750)", () => {
    // Before: sub1 holds RuntimeId A. After: beta.txt holds A, sub1 a new one; same files, same order.
    const d = computeUiaDiff(
      [row("alpha.txt", 0, "1"), row("beta.txt", 1, "B"), row("sub1", 2, "A")],
      [row("alpha.txt", 0, "1"), row("beta.txt", 1, "A"), row("sub1", 2, "C")],
    );
    expect(d).toEqual({ appeared: [], disappeared: [], valueDeltas: [] });
  });

  it("undoes a recycled pair found by position too (no RuntimeId in common)", () => {
    // Two panes swapped their only rows, every element rebuilt: position pairs a->b and b->a.
    const d = computeUiaDiff(
      [el("a", { runtimeId: "1", path: "/P[0]/Text[0]" }), el("b", { runtimeId: "2", path: "/Q[1]/Text[0]" })],
      [el("b", { runtimeId: "3", path: "/P[0]/Text[0]" }), el("a", { runtimeId: "4", path: "/Q[1]/Text[0]" })],
    );
    expect(d).toEqual({ appeared: [], disappeared: [], valueDeltas: [] });
  });

  it("counts a name shown by another control type as not the same name (Calculator's history)", () => {
    const d = computeUiaDiff(
      [el("表示は 8 です", { runtimeId: "1" })],
      [el("表示は 15 です", { runtimeId: "1" }), el("表示は 8 です", { controlType: "ListItem", runtimeId: "5" })],
    );
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "表示は 8 です", after: "表示は 15 です" }]);
  });
});

describe("PR codex P2s on #750", () => {
  it("pairs the one renamed child of a parent that rebuilt all its children", () => {
    const kid = (name: string, i: number, rid: string) => el(name, { runtimeId: rid, path: `/Group[0]/Text[${i}]` });
    const d = computeUiaDiff(
      [kid("Label", 0, "1"), kid("3 items", 1, "2"), kid("Size", 2, "3")],
      [kid("Label", 0, "7"), kid("2 items", 1, "8"), kid("Size", 2, "9")],
    );
    expect(d).toEqual({ appeared: [], disappeared: [], valueDeltas: [], nameDeltas: [{ type: "Text", before: "3 items", after: "2 items" }] });
  });

  it("does not call a control replaced by another type under the same automationId a rename", () => {
    const d = computeUiaDiff(
      [el("Next", { controlType: "Button", automationId: "step" })],
      [el("Complete", { controlType: "Text", automationId: "step" })],
    );
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "Next", type: "Button" }]);
    expect(d.appeared).toEqual([{ name: "Complete", type: "Text", automationId: "step" }]);
  });

  it("does not call it a rename under one RuntimeId either", () => {
    const d = computeUiaDiff(
      [el("Next", { controlType: "Button", runtimeId: "1" })],
      [el("Complete", { controlType: "Text", runtimeId: "1" })],
    );
    expect(d.nameDeltas).toBeUndefined();
  });
});

describe("a new row's cells (win2 on #750, 7496f3d0)", () => {
  // Every Explorer row holds two Edit cells named after the columns, the same in every row.
  const rowWithCells = (name: string, i: number, rid: string) => [
    el(name, { controlType: "ListItem", automationId: String(i), runtimeId: rid, path: `/List[0]/ListItem[${i}]` }),
    el("名前", { controlType: "Edit", automationId: "System.ItemNameDisplay", runtimeId: `${rid}n`, path: `/List[0]/ListItem[${i}]/Edit[0]`, depth: 5 }),
    el("更新日時", { controlType: "Edit", automationId: "System.DateModified", runtimeId: `${rid}d`, path: `/List[0]/ListItem[${i}]/Edit[1]`, depth: 5 }),
  ];

  it("says the added file, not its cells", () => {
    const d = computeUiaDiff(
      [...rowWithCells("alpha.txt", 0, "a"), ...rowWithCells("beta.txt", 1, "b")],
      [...rowWithCells("alpha.txt", 0, "a"), ...rowWithCells("beta.txt", 1, "b"), ...rowWithCells("b-new.txt", 2, "c")],
    );
    expect(d.appeared).toEqual([{ name: "b-new.txt", type: "ListItem", automationId: "2" }]);
    expect(d.disappeared).toEqual([]);
  });

  it("says the deleted file, not its cells", () => {
    const d = computeUiaDiff(
      [...rowWithCells("alpha.txt", 0, "a"), ...rowWithCells("b-new.txt", 1, "c")],
      [...rowWithCells("alpha.txt", 0, "a")],
    );
    expect(d.disappeared).toEqual([{ name: "b-new.txt", type: "ListItem" }]);
    expect(d.appeared).toEqual([]);
  });

  it("still says an element that appeared outside any row", () => {
    const d = computeUiaDiff([], [el("Saved", { path: "/Pane[0]/Text[0]" })]);
    expect(d.appeared).toEqual([{ name: "Saved", type: "Text" }]);
  });
});

describe("a read without RuntimeId or path (an older addon)", () => {
  it("is diffed by the old key: a Name change is still a disappearance and an appearance", () => {
    const d = computeUiaDiff([el("表示は 8")], [el("表示は 15")]);
    expect(d.nameDeltas).toBeUndefined();
    expect(d.disappeared).toEqual([{ name: "表示は 8", type: "Text" }]);
    expect(d.appeared).toEqual([{ name: "表示は 15", type: "Text" }]);
  });

  it("still pairs by automationId", () => {
    const d = computeUiaDiff([el("A", { automationId: "status" })], [el("B", { automationId: "status" })]);
    expect(d.nameDeltas).toEqual([{ type: "Text", before: "A", after: "B" }]);
  });
});

describe("the rest of the diff over pairs", () => {
  it("says a paired element that became visible appeared", () => {
    const d = computeUiaDiff([el("Tip", { runtimeId: "1", boundingRect: null })], [el("Tip", { runtimeId: "1" })]);
    expect(d.appeared).toEqual([{ name: "Tip", type: "Text" }]);
  });

  it("says a paired element that became hidden disappeared", () => {
    const d = computeUiaDiff([el("Tip", { runtimeId: "1" })], [el("Tip", { runtimeId: "1", boundingRect: { x: 0, y: 0, width: 0, height: 0 } })]);
    expect(d.disappeared).toEqual([{ name: "Tip", type: "Text" }]);
  });

  it("leaves nameDeltas out when no Name changed", () => {
    const d = computeUiaDiff([el("Same", { runtimeId: "1" })], [el("Same", { runtimeId: "1" })]);
    expect(d).toEqual({ appeared: [], disappeared: [], valueDeltas: [] });
  });

  it("keeps three and counts the rest", () => {
    const before = [1, 2, 3, 4].map((i) => el(`b${i}`, { runtimeId: `${i}` }));
    const after = [1, 2, 3, 4].map((i) => el(`a${i}`, { runtimeId: `${i}` }));
    const d = computeUiaDiff(before, after);
    expect(d.nameDeltas).toHaveLength(3);
    expect(d.truncated).toEqual({ nameDeltas: 1 });
  });

  it("trims a long Name as it trims a value", () => {
    const d = computeUiaDiff([el("x", { runtimeId: "1" })], [el("y".repeat(100), { runtimeId: "1" })]);
    expect(d.nameDeltas?.[0].after).toBe("y".repeat(80) + "…");
  });
});

// ── Through the read ──────────────────────────────────────────────────────────

afterEach(() => {
  vi.doUnmock("../../index.js");
  vi.doUnmock("node:child_process");
  vi.unstubAllEnvs();
  vi.resetModules();
});

const raw = (name: string, extra: Record<string, unknown>) => ({
  name, controlType: "Text", automationId: "", className: "", isEnabled: true, boundingRect: rect, patterns: [], depth: 1, ...extra,
});

describe("the read carries RuntimeId and path", () => {
  it("on the native road, leaving out what Rust answered None", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFile: () => { throw new Error("no PowerShell here"); } }));
    const elements = [raw("a", { runtimeId: "42.1.4.15", path: "/Group[1]/Text[1]" }), raw("b", { runtimeId: null, path: null })];
    vi.doMock("../../index.js", () => ({
      default: {
        computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [],
        uiaGetElements: async () => ({ windowTitle: "T", elementCount: elements.length, elements }),
      },
    }));
    const { getUiElements } = await import("../../src/engine/uia-bridge.js");
    const r = await getUiElements("T", 64, 500, 4000);
    expect(r.elements[0]).toMatchObject({ runtimeId: "42.1.4.15", path: "/Group[1]/Text[1]" });
    expect("runtimeId" in r.elements[1] || "path" in r.elements[1]).toBe(false);
  });

  it("on the PowerShell road, numbered as the native walk numbers it", async () => {
    vi.resetModules();
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_f: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]);
        cb(null, { stdout: JSON.stringify({ windowTitle: "T", elementCount: 1, elements: [raw("a", { runtimeId: "7.1", path: "/Text[0]" })], truncated: false }), stderr: "" });
      },
    }));
    vi.doMock("../../index.js", () => ({ default: { computeChangeFraction: () => 0, dhashFromRaw: () => 0n, hammingDistance: () => 0, win32EnumTopLevelWindows: () => [] } }));
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
    const { getUiElements } = await import("../../src/engine/uia-bridge.js");
    const r = await getUiElements("T", 4, 80, 4000);
    const ps = scripts[0];
    expect(ps).toContain("$queue.Enqueue(@{ el=$target; depth=1; path='' })");
    // Counted before the offscreen skip, so an element scrolling away does not renumber the rest.
    const count = ps.indexOf("    $sib++\n");
    expect(count).toBeGreaterThan(ps.indexOf("foreach ($el in $kids) {"));
    expect(count).toBeLessThan(ps.indexOf("$offscreen = $el.Current.IsOffscreen"));
    expect(ps).toContain("if ($null -ne $parentPath -and $ctName) { $elPath = $parentPath + '/' + $ctName + '[' + $sib + ']' }");
    expect(ps).toContain("if ($null -ne $elPath) { $elObj['path'] = $elPath }");
    expect(ps).toContain("$elRid = ($el.GetRuntimeId() -join '.')");
    expect(ps).toContain("$queue.Enqueue(@{ el=$el; depth=($depth+1); path=$elPath })");
    expect(r.elements[0]).toMatchObject({ runtimeId: "7.1", path: "/Text[0]" });
  });
});
