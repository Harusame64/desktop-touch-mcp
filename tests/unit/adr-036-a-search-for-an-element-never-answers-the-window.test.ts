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
 * It reads the scripts the SHIPPED functions build (the native addon is absent off Windows, so the
 * PowerShell road is the one taken), not a builder exported for the test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const {
  clickElement, setElementValue, insertTextViaTextPattern2,
  getElementBounds, getElementChildren,
  scrollElementIntoView, getScrollAncestors, scrollByPercent,
} = await import("../../src/engine/uia-bridge.js");

beforeEach(() => { scripts.length = 0; });

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
    });
  }

  it("names the window's own title as the shape that used to answer", async () => {
    // Not a tautology: it pins that the window IS reachable as `$target` — the search has something
    // to refuse — and that the title is what put it there.
    const script = await scriptOf(() => getElementBounds(TITLE, NAME));
    expect(script).toContain(`$w.Current.Name -like '*${TITLE}*'`);
    expect(script).toContain("$target = $w");
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
      expect(script).toContain("$desc  = [System.Windows.Automation.TreeScope]::Descendants");
      // `Descendants` excludes the element itself, so there is no depth-0 test to guard — and there
      // must not be a hand-rolled walk beside it that would reintroduce one.
      expect(script).not.toContain("function FindElement");
    });
  }
});
