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
 * a post read, and where the FOCUSED half was empty too — which is how it was measured — the verdict
 * was `unverifiable`, with the words "no observation channel available on this host". That sentence
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
  // The class, not the one line. The first version of this recogniser matched `if (true)` and
  // `-eq true` and nothing else, and gate 2 wrote the mutations it let through: the absent-filter
  // defaults in this same file are `"$true"` strings, and spelling one of them `"true"` emits
  // `if ((true) -and …)` — same defect, not matched, on a road this file sweeps. So the rule is
  // the TOKEN: a bare `true` / `false` in generated PowerShell is a command name, never a boolean.
  // Quoted occurrences are exempt, because a script may legitimately carry the word in a string
  // (`'true'` as JSON, a `-like` pattern); `$true` is the correct spelling and never matches.
  const JS_BOOLEAN_TOKEN =
    /(?:\b(?:if|elseif|while)\s*\([^{]*?(?<!['"$\w-])(?:true|false)(?!['"\w]))|(?:=\s*(?:true|false)(?!['"\w]))|(?:-(?:eq|ne|and|or|not)\s+(?:true|false)(?!['"\w]))/;

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
  ];

  for (const [label, call] of roads) {
    it(`${label} writes no JavaScript boolean into a condition`, async () => {
      const script = await scriptOf(call);
      expect(script).not.toMatch(JS_BOOLEAN_TOKEN);
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
    // …and it does not fire on the correct spelling, or on the word inside a string, or it would
    // pin nothing and redden on scripts that are right.
    expect("if ($true) {").not.toMatch(JS_BOOLEAN_TOKEN);
    expect("$a -eq $false").not.toMatch(JS_BOOLEAN_TOKEN);
    expect("$j = '{\"ok\":true}'").not.toMatch(JS_BOOLEAN_TOKEN);
    expect("$c.Name -like '*true*'").not.toMatch(JS_BOOLEAN_TOKEN);
  });
});
