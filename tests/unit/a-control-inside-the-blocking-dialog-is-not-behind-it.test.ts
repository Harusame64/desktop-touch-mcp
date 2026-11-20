/**
 * internal #419 — `__occludedDialogIndexForEl` (the in-page helper every modal preflight reads: browser_click's
 * selector and by-axis paths, desktop_act's CDP click) answered the dialog's index for an element INSIDE that dialog
 * whenever a part of the same dialog covered its centre — a styled box over a checkbox, the dialog's own footer —
 * so the element was refused as "behind" the dialog it belongs to (/code-review on #1002; win2 measured the
 * desktop_act side, cell M7). The helper is run here, not string-matched: the rule lives inside a page script.
 */
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { occluderIndexHelperJs } from "../../src/tools/browser-resolver.js";

type Rect = { left: number; top: number; width: number; height: number };
class FakeEl {
  children: FakeEl[] = [];
  style = { position: "static", display: "block", visibility: "visible" };
  constructor(readonly name: string, readonly parentElement: FakeEl | null, readonly rect: Rect = { left: 400, top: 300, width: 20, height: 20 }) {
    parentElement?.children.push(this);
  }
  contains(n: FakeEl | null): boolean {
    for (let x = n; x; x = x.parentElement) if (x === this) return true;
    return false;
  }
  getBoundingClientRect() { return this.rect; }
}
const FULL: Rect = { left: 0, top: 0, width: 1000, height: 800 };

function occludedIndex(el: FakeEl, hit: FakeEl, dialogs: FakeEl[], body: FakeEl): number | null {
  const document = { body, querySelectorAll: () => dialogs, elementFromPoint: () => hit };
  const window = { innerWidth: 1000, innerHeight: 800, getComputedStyle: (s: FakeEl) => s.style };
  return runInNewContext(`(function() {\n${occluderIndexHelperJs()}\n  return __occludedDialogIndexForEl(el);\n})()`, { document, window, el });
}
function backdrop(body: FakeEl): FakeEl {
  const b = new FakeEl("backdrop", body, FULL);
  b.style.position = "fixed";
  return b;
}

describe("the occluding dialog of an element (internal #419)", () => {
  it("is none for a checkbox inside the dialog under a styled box of the same dialog", () => {
    const body = new FakeEl("body", null, FULL);
    backdrop(body);
    const dialog = new FakeEl("dialog", body, { left: 200, top: 100, width: 600, height: 400 });
    const label = new FakeEl("label", dialog);
    const input = new FakeEl("input", label);
    const box = new FakeEl("span.box", label);
    expect(occludedIndex(input, box, [dialog], body)).toBeNull();
  });

  it("is the dialog for an element of the page under its backdrop (control)", () => {
    const body = new FakeEl("body", null, FULL);
    const target = new FakeEl("button", body);
    const bd = backdrop(body);
    const dialog = new FakeEl("dialog", body, { left: 200, top: 100, width: 600, height: 400 });
    expect(occludedIndex(target, bd, [dialog], body)).toBe(0);
  });

  it("is the dialog for an element of the page under the dialog box itself (control)", () => {
    const body = new FakeEl("body", null, FULL);
    const target = new FakeEl("button", body);
    const dialog = new FakeEl("dialog", body, { left: 200, top: 100, width: 600, height: 400 });
    const text = new FakeEl("p", dialog);
    expect(occludedIndex(target, text, [dialog], body)).toBe(0);
  });

  it("is the covering dialog for an element inside ANOTHER dialog", () => {
    const body = new FakeEl("body", null, FULL);
    const help = new FakeEl("help", body, { left: 0, top: 0, width: 300, height: 800 });
    const inHelp = new FakeEl("a", help);
    const modal = new FakeEl("modal", body, { left: 200, top: 100, width: 600, height: 400 });
    const modalText = new FakeEl("p", modal);
    expect(occludedIndex(inHelp, modalText, [help, modal], body)).toBe(1);
  });
});
