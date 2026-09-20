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
 * answer from "there is nothing at that point": `_mouse-verify.ts` reads the null pair and reports
 * `unverifiable` with the words "no observation channel available on this host", which names the
 * host for a defect in this file. A whole configuration — every build without the native addon —
 * has never had click verification, and the product said so in a way that read as the machine's
 * fault.
 *
 * The spike that found it went looking outside first (the call, the parse, the assembly load), and
 * what settled it was running the generated string verbatim: the script ran to the end, and a
 * branch inside it was silently false. This cell reads the same strings the product builds.
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
const { getFocusedAndPointInfo, getElementBounds, getUiElements } = await import("../../src/engine/uia-bridge.js");

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
  // The class, not the one line: any `if (true)` / `if (false)` / `-eq true` reaching PowerShell is
  // a branch that silently never runs (or always does), with a zero exit and an empty stderr.
  const JS_BOOLEAN_CONDITION = /(?:if\s*\(\s*(?:true|false)\s*\)|-(?:eq|ne)\s+(?:true|false)\b)/;

  const roads: [string, () => Promise<unknown>][] = [
    ["getFocusedAndPointInfo (with the point)", () => getFocusedAndPointInfo(1, 2)],
    ["getFocusedAndPointInfo (without it)", () => getFocusedAndPointInfo(0, 0, false)],
    ["getElementBounds", () => getElementBounds("App", "Save")],
    ["getUiElements", () => getUiElements("App")],
  ];

  for (const [label, call] of roads) {
    it(`${label} writes no JavaScript boolean into a condition`, async () => {
      const script = await scriptOf(call);
      expect(script).not.toMatch(JS_BOOLEAN_CONDITION);
    });
  }

  it("the recogniser fires — it is not a regex that matches nothing", async () => {
    // The control this cell needs: the shape it looks for, in the spelling the defect had.
    expect('if (true) {\n  $x = 1\n}').toMatch(JS_BOOLEAN_CONDITION);
    expect("if ( false )").toMatch(JS_BOOLEAN_CONDITION);
    expect("$a -eq true").toMatch(JS_BOOLEAN_CONDITION);
    // …and it does not fire on the correct spelling, or it would pin nothing.
    expect("if ($true) {").not.toMatch(JS_BOOLEAN_CONDITION);
    expect("$a -eq $false").not.toMatch(JS_BOOLEAN_CONDITION);
  });
});
