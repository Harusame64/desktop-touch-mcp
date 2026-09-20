/**
 * internal #133 / #134 — a call that names an ELEMENT is never answered by the WINDOW it named.
 *
 * Both clients used to test the window element itself before its children, by the same
 * case-insensitive name substring, so a window whose title contains one of its elements' names
 * answered for that element — and such a window is ordinary ("Save" in "Save As"). MEASURED win2:
 * the acts pressed the wrong thing or refused (`c0f9364`, `750a5f3`), and the reads answered with
 * the window's own rect, its children, and a screenshot of the whole window — two of them
 * (`value_changes`, `scroll(action='to_element')`) byte-for-byte identically to a call that matched
 * NOTHING, so no caller could tell the two apart (`bdef099`, 27 arms).
 *
 * **This cell is about the PowerShell half**, which is the half written here; the native half is
 * Rust (`src/uia/actions.rs::find_element_in_window`), cannot run on this host, and is measured on
 * the machine. The two halves have to move together — a client that searches differently answers
 * differently, and ADR-036 item 16 weighs a "not found" by which client said it — so what this pins
 * is that no script generated here tests `$target` itself.
 *
 * It reads the scripts the SHIPPED functions build, not a builder exported for the test. The road is
 * chosen by the switch, not by the host: `DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1` before the import, so
 * this cell means the same thing on the machine where the addon IS built (gate 2 — it relied on the
 * addon being absent, which is true here and false on win2, where every cell would have gone red for
 * a reason that is not the defect).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const scripts: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    scripts.push(args[args.length - 1]);
    // Enough JSON for every caller here: each parses its own shape and all of them tolerate this.
    cb(null, { stdout: '{"ok":true,"elements":[],"ancestors":[]}', stderr: "" });
  },
}));

/**
 * A stand-in addon that WOULD answer every call this cell makes — so the switch below is not taken on
 * trust. Without it the cell proves nothing on this host (there is no addon here to disable), and it
 * is the machine WITH an addon that the switch has to hold for. Remove the `stubEnv` and these
 * answers win: no script is built, `scriptOf` finds none, and every cell reddens.
 */
vi.mock("../../index.js", () => ({
  default: {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    win32EnumTopLevelWindows: () => [],
    uiaGetElements: async () => ({ windowTitle: "T", elementCount: 0, elements: [] }),
    uiaGetElementBounds: async () => ({ name: "Save As", controlType: "Window", boundingRect: null, value: null }),
    uiaGetElementChildren: async () => [],
    uiaClickElement: async () => ({ ok: true, element: "Save As", error: null, code: null }),
    uiaSetValue: async () => ({ ok: true, error: null, code: null }),
    uiaInsertText: async () => ({ ok: true, error: null, code: null }),
    uiaScrollIntoView: async () => ({ ok: true, scrolled: true, error: null }),
    uiaGetScrollAncestors: async () => [],
    uiaScrollByPercent: async () => ({ ok: true, scrolled: true, error: null }),
  },
}));

vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
vi.resetModules();
const {
  clickElement, setElementValue, insertTextViaTextPattern2,
  getElementBounds, getElementChildren,
  scrollElementIntoView, getScrollAncestors, scrollByPercent,
} = await import("../../src/engine/uia-bridge.js");

beforeEach(() => { scripts.length = 0; });
// The switch is this file's, not the worker's: `vitest.config.ts` sets neither `unstubEnvs` nor
// `restoreMocks`, and it discusses turning `isolate` off — the day that happens, a file that left
// the switch set would send every later unit file down the PowerShell road and the suite would go
// green having measured the other configuration (gate 2).
afterEach(() => { vi.unstubAllEnvs(); });

/** The one script that call produced. */
async function scriptOf(call: () => Promise<unknown>): Promise<string> {
  await call().catch(() => undefined); // a parse failure downstream is not this cell's business
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

/**
 * The recursive search, when a road uses one: everything from `function FindElement` to the call
 * that starts it. Pinned as a slice of the real script rather than described, because what this
 * cell is about is WHERE the match test sits inside it.
 */
function findElementBlock(script: string): string {
  const from = script.indexOf("function FindElement");
  expect(from).toBeGreaterThan(-1);
  const to = script.indexOf("FindElement $target 0", from);
  expect(to).toBeGreaterThan(from);
  return script.slice(from, to);
}

const TITLE = "Save As";     // the shape the defect needs: the title carries the element's name
const NAME = "Save";

describe("the reads walk from the window's children, not from the window", () => {
  const reads: [string, () => Promise<unknown>, number][] = [
    ["getElementBounds", () => getElementBounds(TITLE, NAME), 12],
    ["getElementChildren", () => getElementChildren(TITLE, NAME, undefined, undefined, 2, 50, 5000), 12],
    ["scrollElementIntoView", () => scrollElementIntoView(TITLE, NAME), 12],
    ["getScrollAncestors", () => getScrollAncestors(TITLE, NAME), 14],
    ["scrollByPercent", () => scrollByPercent(TITLE, NAME, 50, -1), 14],
  ];

  for (const [label, call, maxDepth] of reads) {
    it(`${label} tests a candidate only below the window`, async () => {
      const block = findElementBlock(await scriptOf(call));
      // The match test — the line that ACCEPTS an element — is inside `if ($depth -gt 0)`, so the
      // root of the walk (`$target`, the window) is walked through and never accepted. The guard is
      // pinned with its block, not by name: deleting the `if` line alone leaves this string absent.
      expect(block).toContain("if ($depth -gt 0) {\n        $c = $el.Current\n");
      const accept = block.indexOf("$script:found = $el");
      const guard = block.indexOf("if ($depth -gt 0) {");
      const guardEnds = block.indexOf("    }\n", guard);
      expect(guard).toBeGreaterThan(-1);
      expect(accept).toBeGreaterThan(guard);
      expect(accept).toBeLessThan(guardEnds);
      // …and the walk still reaches as far as it did (the cap counts descendants now).
      expect(block).toContain(`if ($depth -gt ${maxDepth}) { return }`);
      // First match wins — parent before child. Without this the walk keeps going and answers with
      // the LAST match, which the doc above the generator promises it does not.
      expect(block).toContain("if ($script:found) { return }");
      // AND the walk starts at the window the TITLE chose. Asserted per road, not once, because the
      // third way to bring the defect back is to leave the walk alone and move its ROOT: start at
      // `$root` and the window becomes an ordinary depth-1 candidate that the guard happily accepts
      // (gate 2 — and "search from the root instead" is a real story here, it is how H3 reached the
      // common dialogs). Every assertion above passes under that mutation; this one does not.
      const script = scripts[0];
      expect(script).toContain(`$w.Current.Name -like '*${TITLE}*'`);
      expect(script).toContain("$target = $w");
    });
  }

  it("accepts an element in exactly one place, so the window cannot be answered beside the walk", async () => {
    // THE MUTATION THIS EXISTS FOR (gate 2): the defect can come back one line BELOW the walk —
    // `if (-not $script:found) { $c = $target.Current; if (<match>) { $script:found = $target } }` —
    // and every assertion above still passes, because they read the walk only. Two properties kill
    // it: the script accepts a candidate once, and nothing reads `$target`'s own properties at all.
    for (const call of [
      () => getElementBounds(TITLE, NAME),
      () => getElementChildren(TITLE, NAME, undefined, undefined, 2, 50, 5000),
      () => scrollElementIntoView(TITLE, NAME),
      () => getScrollAncestors(TITLE, NAME),
      () => scrollByPercent(TITLE, NAME, 50, -1),
    ]) {
      scripts.length = 0;
      const script = await scriptOf(call);
      expect(script.match(/\$script:found = /g) ?? []).toHaveLength(1);
      expect(script).not.toContain("$target.Current");
    }
  });

});

describe("the acts search descendants, which never includes the window", () => {
  const acts: [string, () => Promise<unknown>][] = [
    ["clickElement (by title)", () => clickElement(TITLE, NAME)],
    ["clickElement (by handle)", () => clickElement(TITLE, NAME, undefined, undefined, { hwnd: 4242n })],
    ["setElementValue (by title)", () => setElementValue(TITLE, "x", NAME)],
    ["setElementValue (by handle)", () => setElementValue(TITLE, "x", NAME, undefined, { hwnd: 4242n })],
    ["insertTextViaTextPattern2", () => insertTextViaTextPattern2(TITLE, "x", NAME)],
  ];

  for (const [label, call] of acts) {
    it(`${label} uses FindAll(Descendants) and no walk from the window`, async () => {
      const script = await scriptOf(call);
      expect(script).toContain("$target.FindAll($desc, $trueC)");
      // By value, not by alignment: the scripts space `$desc` differently and the property is which
      // SCOPE was asked for (gate 2).
      expect(script).toMatch(/\$desc\s+= \[System\.Windows\.Automation\.TreeScope\]::Descendants/);
      // `Descendants` excludes the element itself, so there is no depth-0 test to guard — and there
      // must not be a hand-rolled walk beside it that would reintroduce one.
      expect(script).not.toContain("function FindElement");
    });
  }
});
