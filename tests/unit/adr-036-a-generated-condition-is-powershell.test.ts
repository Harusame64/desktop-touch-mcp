/**
 * internal #138 — a condition written into a PowerShell script has to be PowerShell.
 *
 * `getFocusedAndPointInfo` wrapped its point read in `if (${includePointPS})`, and that string was
 * built as `includePoint ? "true" : "false"` — JavaScript's spelling. PowerShell has no `true`
 * literal: a bare `true` in a condition is an unresolved command name, and `if ()` reads it as
 * FALSE. So the block never ran, on every call, for as long as the road existed.
 *
 * **It failed in the quietest way available.** MEASURED 2026-09-20 win2 (internal `cadc06f`),
 * running the product's own generated script the way the product runs it: exit code 0, EMPTY
 * stderr, and well-formed JSON — `{"focused":{…},"atPoint":null}`. Nothing upstream could tell that
 * answer from "there is nothing at that point". The at-point half of the click-verification channel
 * was therefore dead on every build without the native addon: `_mouse-verify.ts` compares a pre and
 * a post read, and where the FOCUSED half was empty too AND nothing else had moved — which is how
 * it was measured — the verdict was `unverifiable`, with the words "no observation channel
 * available on this host" (a click that brings a window forward answers `delivered` on the
 * foreground change alone, whatever UIA said). That sentence
 * names the host for a defect in this file. `desktop_state.cursorOverElement` was permanently null
 * on the same builds, for the same reason.
 *
 * The spike that found it went looking outside first (the call, the parse, the assembly load), and
 * what settled it was running the generated string verbatim: the script ran to the end, and a
 * branch inside it was silently false. These cells read the same strings the product builds — every
 * PowerShell road in that module a test can reach without a machine.
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
    cb(null, { stdout: '{"ok":true,"focused":null,"atPoint":null,"elements":[]}', stderr: "" });
  },
}));

/** The addon would answer these calls; the switch is what sends them down the scripts. */
vi.mock("../../index.js", () => ({
  default: {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    win32EnumTopLevelWindows: () => [],
    uiaGetElements: async () => ({ windowTitle: "T", elementCount: 0, elements: [] }),
    uiaGetFocusedAndPoint: async () => ({ focused: null, atPoint: null }),
    uiaGetElementBounds: async () => null,
  },
}));

vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
vi.resetModules();
const {
  getFocusedAndPointInfo, getElementBounds, getElementChildren, getUiElements, getTextViaTextPattern,
  clickElement, setElementValue, insertTextViaTextPattern2,
  scrollElementIntoView, getScrollAncestors, scrollByPercent,
  getTextViaValuePattern, getVirtualDesktopStatus,
} = await import("../../src/engine/uia-bridge.js");

beforeEach(() => { scripts.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

async function scriptOf(call: () => Promise<unknown>): Promise<string> {
  await call().catch(() => undefined);
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

describe("the point read runs at all", () => {
  it("asks for the point with PowerShell's own true", async () => {
    const script = await scriptOf(() => getFocusedAndPointInfo(480, 261));
    expect(script).toContain("if ($true) {");
    // …and the block it guards is the one that reads the point, so a false condition loses exactly
    // the answer this function exists for.
    expect(script).toContain("[System.Windows.Automation.AutomationElement]::FromPoint($pt)");
    expect(script).toContain("$pt = [System.Windows.Point]::new(480, 261)");
  });

  it("asks for nothing at the point with PowerShell's own false", async () => {
    const script = await scriptOf(() => getFocusedAndPointInfo(0, 0, false));
    expect(script).toContain("if ($false) {");
  });
});

describe("no generated condition is written in JavaScript", () => {
  // The class, not the one line, and narrowed TWICE by gate 2.
  //
  // The first version read `if (true)` and `-eq true` and nothing else, and let through the nearest
  // sibling: this file's absent-filter defaults are `"$true"` strings, and spelling one `"true"`
  // emits `if ((true) -and …)`, the same defect on a road this cell sweeps.
  //
  // The second version read any bare `true` anywhere inside a condition — and **a window whose
  // TITLE contains the word would have reddened a correct script**, because every title search
  // emits `if ($w.Current.Name -like '*<title>*')` and `escapeLike` passes letters through. A cell
  // that fails on the user's data is worse than the defect it looks for. So the condition arm is
  // anchored to the START of the condition, where a literal would sit (`if (true)`, `if ((true)`,
  // `if (-not true)`), and the other two arms are an assignment and a PowerShell operator.
  //
  // Case-insensitive, because PowerShell is: `If (True)` and `-EQ true` are the same defect, and
  // the flagless version passed them (gate 2 again). The operator arm takes any `-word` rather
  // than a list of five, so `-ceq` / `-ieq` / `-contains` are not four more escapes.
  //
  // `$true` is the correct spelling and never matches; a quoted word only escapes where it is not
  // in one of the three positions — which is the honest scope, not "quoted is exempt".
  const JS_BOOLEAN_TOKEN =
    /(?:\b(?:if|elseif|while)\s*\(\s*[(!-]*\s*(?:true|false)\b)|(?:\(\s*(?:true|false)\s*\))|(?:=\s*(?:true|false)(?!['"\w]))|(?:-[a-z]+\s+(?:true|false)(?!['"\w]))/i;

  // Every PowerShell road this module builds that a test can reach without a machine. Gate 2's
  // other half: "the class" was claimed over three roads out of a dozen.
  const roads: [string, () => Promise<unknown>][] = [
    ["getFocusedAndPointInfo (with the point)", () => getFocusedAndPointInfo(1, 2)],
    ["getFocusedAndPointInfo (without it)", () => getFocusedAndPointInfo(0, 0, false)],
    ["getElementBounds", () => getElementBounds("App", "Save")],
    ["getElementChildren", () => getElementChildren("App", "Save", undefined, undefined, 2, 50, 5000)],
    ["getUiElements", () => getUiElements("App")],
    ["getTextViaTextPattern", () => getTextViaTextPattern("App")],
    ["clickElement (by title)", () => clickElement("App", "Save")],
    ["clickElement (by handle)", () => clickElement("App", "Save", undefined, undefined, { hwnd: 42n })],
    ["setElementValue", () => setElementValue("App", "x", "Save")],
    ["insertTextViaTextPattern2", () => insertTextViaTextPattern2("App", "x", "Save")],
    ["scrollElementIntoView", () => scrollElementIntoView("App", "Save")],
    ["getScrollAncestors", () => getScrollAncestors("App", "Save")],
    ["scrollByPercent", () => scrollByPercent("App", "Save", 50, -1)],
    // The three gate 2 found unswept while the sentence said "every road": the by-handle value
    // write has its own filters — the exact site this recogniser was rebuilt for — and the other
    // two are exported builders with scripts of their own.
    ["setElementValue (by handle)", () => setElementValue("App", "x", "Save", undefined, { hwnd: 42n })],
    ["getTextViaValuePattern", () => getTextViaValuePattern("App")],
    ["getVirtualDesktopStatus", () => getVirtualDesktopStatus(["42"])],
    // The by-handle BRANCHES inside roads already listed: each builds a different preamble, and the
    // last round's sentence covered the functions while leaving these (gate 2).
    ["getUiElements (pinned)", () => getUiElements("App", 3, 50, 10000, { pinnedHwnd: 42n })],
    ["getTextViaTextPattern (pinned)", () => getTextViaTextPattern("App", 6000, { pinnedHwnd: 42n })],
    ["insertTextViaTextPattern2 (by handle)", () => insertTextViaTextPattern2("App", "x", "Save", undefined, { hwnd: 42n })],
  ];

  /**
   * Everything between single quotes is the caller's, not the script's: a window title, a value to
   * write, an AutomationId. `escapeLike` escapes `` ` * ? [ ] `` and `escapePS` doubles `'`, and
   * neither touches `(`, `)`, `-` or `=` — so `Save (true)`, `app?debug=true` and `well-known true`
   * all reach the script verbatim inside quotes, and all three would fail a sweep that reads them
   * (gate 2, measured). Stripping the spans first is what makes "quoted is exempt" true rather than
   * approximately true; `''` inside a PowerShell single-quoted string is an escaped quote, which is
   * why the pattern consumes pairs.
   */
  const outsideQuotes = (script: string) => script.replace(/'(?:[^']|'')*'/g, "''");

  for (const [label, call] of roads) {
    it(`${label} writes no JavaScript boolean into a condition`, async () => {
      const script = await scriptOf(call);
      expect(outsideQuotes(script)).not.toMatch(JS_BOOLEAN_TOKEN);
    });
  }

  it("the recogniser fires — it is not a regex that matches nothing", async () => {
    // The control this cell needs: the shape it looks for, in the spelling the defect had.
    expect("if (true) {\n  $x = 1\n}").toMatch(JS_BOOLEAN_TOKEN);
    expect("if ( false )").toMatch(JS_BOOLEAN_TOKEN);
    expect("$a -eq true").toMatch(JS_BOOLEAN_TOKEN);
    // The mutations gate 2 wrote, which the first recogniser let through:
    expect("if ((true) -and (true)) { }").toMatch(JS_BOOLEAN_TOKEN);   // an absent filter spelled wrong
    expect("$includePoint = true").toMatch(JS_BOOLEAN_TOKEN);          // the flag-variable form
    expect("while (true) { }").toMatch(JS_BOOLEAN_TOKEN);
    expect("if (-not true) { }").toMatch(JS_BOOLEAN_TOKEN);
    // A bare literal as an OPERAND rather than the whole condition — the shape a wrongly spelled
    // absent filter takes when another filter comes first, which escaped the anchored version
    // (measured on `makeSetValueScriptByHwnd` with `idFilter` spelled `"true"`).
    expect("if (($c.Name -like '*x*') -and (true)) { }").toMatch(JS_BOOLEAN_TOKEN);
    // …and it does not fire on the correct spelling, or on the word inside a string, or it would
    // pin nothing and redden on scripts that are right.
    expect("if ($true) {").not.toMatch(JS_BOOLEAN_TOKEN);
    expect("$a -eq $false").not.toMatch(JS_BOOLEAN_TOKEN);
    expect("$j = '{\"ok\":true}'").not.toMatch(JS_BOOLEAN_TOKEN);
    // THE FALSE POSITIVE THIS CELL MUST NOT HAVE, in the shape the product emits it (gate 2): a
    // window titled `truestore.json — Notepad` goes through `escapeLike` unchanged and lands in
    // every title search's condition. The earlier recogniser reddened on it.
    expect(outsideQuotes("if ($w.Current.Name -like '*truestore.json*') { $target = $w; break }")).not.toMatch(JS_BOOLEAN_TOKEN);
    // The shapes the quote-stripping is for, each of which a caller can put in a title or a value:
    for (const callers of [
      "if ($w.Current.Name -like '*Save (true)*') { }",
      "$vp.SetValue('(true)')",
      "if ($c.AutomationId -eq '(false)') { }",
      "if ($w.Current.Name -like '*app?debug=true*') { }",
      "if ($w.Current.Name -like '*well-known true*') { }",
    ]) {
      expect(outsideQuotes(callers), callers).not.toMatch(JS_BOOLEAN_TOKEN);
    }
    expect("$c.Name -like '*true*'").not.toMatch(JS_BOOLEAN_TOKEN);
    // PowerShell does not care about case, and neither does the defect.
    expect("If (True) { }").toMatch(JS_BOOLEAN_TOKEN);
    expect("WHILE (true) { }").toMatch(JS_BOOLEAN_TOKEN);
    expect("$a -EQ true").toMatch(JS_BOOLEAN_TOKEN);
    expect("$a -ceq true").toMatch(JS_BOOLEAN_TOKEN);
    expect("if ($True) { }").not.toMatch(JS_BOOLEAN_TOKEN);
  });
});
