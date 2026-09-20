/**
 * internal #136 — naming a window and pinning its handle must not give two different trees.
 *
 * The managed client (`System.Windows.Automation`) reaches a legacy window's title bar, menu bar
 * and caption buttons only through `UIAutomationClientsideProviders`, which synthesises them from
 * MSAA and is registered PER PROCESS. Every PowerShell road here is a fresh `powershell.exe`, so
 * the registration is not something one road can do on another's behalf: a script that does not
 * run it sees a window with no frame in it.
 *
 * MEASURED 2026-09-20 win2 (internal `bdef099`, arm R6): one fixture window answered **8**
 * children through the COM client the Rust engine uses and **2** through this one — the six
 * missing being the title bar, the menu bar, the three caption buttons and a menu item. Notepad
 * was 26 against 2 on 2026-09-09, and the registration closed it.
 *
 * Four scripts out of fourteen carried it, and the split ran THROUGH three functions rather than
 * between them: `makeClickElementScriptByHwnd` registered, `makeClickElementScript` did not; the
 * same for the value write and for `insertTextViaTextPattern2`. So the caller who pinned a handle
 * could press `Close` and the caller who named the window could not — and ADR-036 item 16 weighs
 * a not-found by which client answered, a rule that assumes both see the same tree.
 *
 * These cells read the strings the product builds, on the roads a test can reach without a
 * machine. The sweep is `if the script searches by title, it registers` rather than a list of
 * blessed roads, because the defect was a road nobody remembered to add.
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

/** The addon would answer these calls; the switch below is what sends them down the scripts. */
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

/** The line a script emits when it looks for a window by name among the root's children. */
const TITLE_SEARCH = "$w.Current.Name -like '*";
/** The call that makes the frame visible. */
const REGISTER = "RegisterClientSideProviderAssembly";
/** The warm-up the shared snippet spells, verbatim. */
const WARM_UP =
  "$null = $target.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition)";

/**
 * The mechanism, not one spelling of it: SOME `FindAll` on the window has to run before the
 * registration, or the registration does nothing and says nothing.
 *
 * The discover read does not use the shared snippet — its warm-up is
 * `$preRegisterChildren = $target.FindAll($children, $cvCond).Count`, the same RPC doing double
 * duty as the count that REPORTS whether the registration took. Pinning the literal line would
 * have made this cell demand that one road throw its measurement away, which is the cell being
 * wrong about the product rather than the other way round.
 */
const warmsUpBeforeRegistering = (script: string): boolean => {
  const reg = script.indexOf(REGISTER);
  return reg >= 0 && /\$target\.FindAll\(/.test(script.slice(0, reg));
};

/**
 * Every PowerShell road in this module a test can reach without a machine, both branches of the
 * ones that have two. The sweep asks each script what it does, so a road that searches no window
 * by title is carried here too and simply falls out of the arm.
 */
const roads: [string, () => Promise<unknown>][] = [
  ["getElementBounds", () => getElementBounds("App", "Save")],
  ["getElementChildren", () => getElementChildren("App", "Save", undefined, undefined, 2, 50, 5000)],
  ["getUiElements", () => getUiElements("App")],
  ["getUiElements (pinned)", () => getUiElements("App", 3, 50, 10000, { pinnedHwnd: 42n })],
  ["getTextViaTextPattern", () => getTextViaTextPattern("App")],
  ["getTextViaTextPattern (pinned)", () => getTextViaTextPattern("App", 6000, { pinnedHwnd: 42n })],
  ["getTextViaValuePattern", () => getTextViaValuePattern("App")],
  ["clickElement (by title)", () => clickElement("App", "Save")],
  ["clickElement (by handle)", () => clickElement("App", "Save", undefined, undefined, { hwnd: 42n })],
  ["setElementValue (by title)", () => setElementValue("App", "x", "Save")],
  ["setElementValue (by handle)", () => setElementValue("App", "x", "Save", undefined, { hwnd: 42n })],
  ["insertTextViaTextPattern2 (by title)", () => insertTextViaTextPattern2("App", "x", "Save")],
  ["insertTextViaTextPattern2 (by handle)", () => insertTextViaTextPattern2("App", "x", "Save", undefined, { hwnd: 42n })],
  ["scrollElementIntoView", () => scrollElementIntoView("App", "Save")],
  ["getScrollAncestors", () => getScrollAncestors("App", "Save")],
  ["scrollByPercent", () => scrollByPercent("App", "Save", 50, -1)],
  ["getFocusedAndPointInfo", () => getFocusedAndPointInfo(1, 2)],
  ["getVirtualDesktopStatus", () => getVirtualDesktopStatus(["42"])],
];

describe("a script that finds a window by title can see its frame", () => {
  for (const [label, call] of roads) {
    it(`${label}: if it searches by title, it registers the clientside providers`, async () => {
      const script = await scriptOf(call);
      if (!script.includes(TITLE_SEARCH)) return;   // no window search here; nothing to register for
      expect(script).toContain(REGISTER);
    });
  }

  it("the sweep is not vacuous: most of these roads DO search by title", async () => {
    // Without this, deleting the title search from every script would leave the arm above green.
    let searched = 0;
    for (const [, call] of roads) {
      scripts.length = 0;
      if ((await scriptOf(call)).includes(TITLE_SEARCH)) searched += 1;
    }
    // Ten roads resolve by title today. Pinned to a floor rather than an equality, so adding a
    // road does not redden this cell while the arm above already covers it.
    expect(searched).toBeGreaterThanOrEqual(10);
  });

  it("warms up first, on every road that registers at all", async () => {
    // ORDER IS THE WHOLE MECHANISM and getting it wrong is silent: registering straight after
    // `Add-Type` does nothing, and nothing throws (measured four ways, 2026-09-09). A mutation
    // that moves the warm-up below the registration leaves a script that runs, exits 0 and
    // returns a window without a frame — so the cell reads the two positions, not the presence.
    for (const [label, call] of roads) {
      scripts.length = 0;
      const script = await scriptOf(call);
      if (!script.includes(REGISTER)) continue;
      expect(warmsUpBeforeRegistering(script), `${label}: nothing warms this client up first`).toBe(true);
    }
  });

  it("the shared snippet still spells its own warm-up, and spells it first", async () => {
    // The arm above reads the mechanism, so it stays green if the snippet's warm-up is deleted
    // while the discover read keeps its own. This one holds the line the other twelve roads
    // depend on — there is nothing else in those scripts to fall back on.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    const warm = script.indexOf(WARM_UP);
    expect(warm).toBeGreaterThanOrEqual(0);
    expect(warm).toBeLessThan(script.indexOf(REGISTER));
  });

  it("registers for every shape of title a caller can send, not just the convenient one", async () => {
    // FOUND BY MUTATION: making the registration conditional on the title being non-empty —
    // `${safeTitle ? PS_REGISTER_CLIENTSIDE_PROVIDERS : ""}` — killed nothing, because every road
    // above is driven with the one title `"App"`. An empty title is not hypothetical: it survives
    // `escapeLike`, emits `-like '**'`, and matches the first root child, so that mutation would
    // ship a frameless tree to a real caller while the suite stayed green.
    //
    // The other two are the shapes that go through the escaping: `escapeLike` rewrites the four
    // wildcard characters and the backtick, and a title is also where a caller's own language
    // arrives.
    for (const title of ["", "*?[]`", "保存 — メモ帳", "Save (true)"]) {
      scripts.length = 0;
      const script = await scriptOf(() => getElementBounds(title, "Save"));
      expect(script, JSON.stringify(title)).toContain(REGISTER);
      expect(warmsUpBeforeRegistering(script), JSON.stringify(title)).toBe(true);
    }
  });

  it("names the assembly exactly, because a typo would be caught and swallowed", async () => {
    // The registration sits inside `try { … } catch {}`. A wrong name, version or token throws
    // there and the script goes on to return a frameless window with no sign anything failed.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script).toContain(
      "'UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'",
    );
  });

  it("registers after the window is found, not before — the warm-up has nothing to run on otherwise", async () => {
    // `$target` is the warm-up's receiver. Hoisting the registration above the search would make
    // `$null = $target.FindAll(…)` throw into its own catch, and the registration would then run
    // in the state measured to do nothing.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script.indexOf(TITLE_SEARCH)).toBeLessThan(script.indexOf(WARM_UP));
  });
});

describe("the two branches of one road agree", () => {
  // The shape of the defect: not a road that was missed, but ONE function whose two halves saw
  // different trees. A caller that pinned a handle could press a caption button; the same caller
  // naming the same window could not find it.
  const pairs: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ["clickElement", () => clickElement("App", "Save"), () => clickElement("App", "Save", undefined, undefined, { hwnd: 42n })],
    ["setElementValue", () => setElementValue("App", "x", "Save"), () => setElementValue("App", "x", "Save", undefined, { hwnd: 42n })],
    ["insertTextViaTextPattern2", () => insertTextViaTextPattern2("App", "x", "Save"), () => insertTextViaTextPattern2("App", "x", "Save", undefined, { hwnd: 42n })],
    ["getUiElements", () => getUiElements("App"), () => getUiElements("App", 3, 50, 10000, { pinnedHwnd: 42n })],
    ["getTextViaTextPattern", () => getTextViaTextPattern("App"), () => getTextViaTextPattern("App", 6000, { pinnedHwnd: 42n })],
  ];

  for (const [label, byTitle, byHandle] of pairs) {
    it(`${label}: the title branch registers exactly as the handle branch does`, async () => {
      scripts.length = 0;
      const title = await scriptOf(byTitle);
      scripts.length = 0;
      const handle = await scriptOf(byHandle);
      expect(handle).toContain(REGISTER);
      expect(title).toContain(REGISTER);
    });
  }
});

describe("one search, so the next road cannot forget", () => {
  it("the title search is written in one place", async () => {
    // The generator, `makeResolveWindowByTitlePs`, is what makes the registration unforgettable:
    // it is part of finding the window, not a line to remember afterwards. A hand-rolled copy
    // would take the registration with it only by accident, which is how four-of-fourteen
    // happened. `makeGetElementsScript` is the one exception and says why: it registers inline
    // together with the before/after child count that REPORTS whether the registration took.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/engine/uia-bridge.ts", import.meta.url), "utf8"),
    );
    const hand = source.match(/\$allWins = \$root\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Children, \$trueC\)/g) ?? [];
    expect(hand).toHaveLength(2);   // the generator, and the discover read that counts
    expect(source).toContain("function makeResolveWindowByTitlePs(");
  });
});
