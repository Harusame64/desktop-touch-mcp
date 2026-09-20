/**
 * internal #136 — naming a window and pinning its handle must not give two different trees.
 *
 * The managed client (`System.Windows.Automation`) reaches a legacy window's title bar, menu bar
 * and caption buttons only through `UIAutomationClientsideProviders`, which synthesises them from
 * MSAA and is registered PER PROCESS. Every PowerShell road here is a fresh `powershell.exe`, so
 * the registration is not something one road can do on another's behalf: a script that does not
 * run it sees a window with no frame in it.
 *
 * MEASURED on the managed side, which is the side this change moves: a WinForms window answers
 * **2** descendants before registering and **10** after, the six new ones being the title bar, the
 * menu bar and the caption buttons; Notepad answered 2 here where the engine answered 26
 * (2026-09-09).
 *
 * A second comparison against the engine (win2, 2026-09-20, internal `bdef099`, arm R6, 8 against
 * 2) was withdrawn the same day and is NOT cited: its native half came from an addon built
 * 2026-08-29. The withdrawal reached the source comment first and this header second, which is the
 * shape of the defect it is about — a number copied out of a measurement carries none of the
 * measurement's conditions with it, and a reader opens the cells to find out why a rule exists.
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
/** The other door to a window: a handle the caller already holds. */
const FROM_HANDLE = "[System.Windows.Automation.AutomationElement]::FromHandle(";
/**
 * The roads that resolve no window at all, listed rather than inferred.
 *
 * `getFocusedAndPointInfo` asks the desktop what is focused and what is under a point;
 * `getVirtualDesktopStatus` asks about handles it is given. Neither has a window to register
 * against, and both are named here so that a road which STOPS resolving a window has to be added
 * deliberately instead of falling silently out of the sweep.
 */
const EXEMPT = ["getFocusedAndPointInfo", "getVirtualDesktopStatus"];
/** The call that makes the frame visible. */
const REGISTER = "RegisterClientSideProviderAssembly";
/** The warm-up the shared snippet spells, verbatim. */
const WARM_UP =
  "$null = $target.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition)";

/**
 * The mechanism, not one spelling of it: SOME UIA call has to run before the registration.
 *
 * MEASURED 2026-09-20 win2 (internal `f3ce315`): a script that registers straight after
 * `Add-Type`, with nothing before it, throws `NullReferenceException` — it does not fail quietly.
 * A title search is enough on its own, and the ten elements it then finds are the same ten a
 * spelled-out warm-up produces, so the title roads pay no extra round trip for it.
 *
 * Hence `$root.FindAll` counts as well as `$target.FindAll`. The discover read is a third
 * spelling again: its warm-up is `$preRegisterChildren = $target.FindAll($children, $cvCond).Count`,
 * one RPC doing double duty as the count that REPORTS whether the registration took. Pinning any
 * one line would make this cell demand that a road throw something away.
 */
const warmsUpBeforeRegistering = (script: string): boolean => {
  const reg = script.indexOf(REGISTER);
  return reg >= 0 && /\$(?:root|target)\.FindAll\(/.test(script.slice(0, reg));
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
    it(`${label}: if it resolves a window, it registers the clientside providers`, async () => {
      const script = await scriptOf(call);
      // The rule is about resolving a WINDOW, by either door — the by-handle roads search no
      // title and must register all the same, which is where this whole thing started. A road
      // that resolves no window is exempt, and naming which ones out loud is the difference
      // between an exemption and a cell that quietly asserts nothing (gate 2 found two roads
      // returning early here, covered by no other cell).
      if (!script.includes(TITLE_SEARCH) && !script.includes(FROM_HANDLE)) {
        expect(EXEMPT, `${label} resolves no window — name it exempt, or give it the rule`)
          .toContain(label);
        // …and today it does not register. Not an endorsement: whether the element-at-point read
        // should see the frame is open — a point over a title bar answers differently on a client
        // that cannot see one — and this line is what reddens when someone decides it.
        expect(script).not.toContain(REGISTER);
        return;
      }
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
    // ELEVEN roads resolve by title today: the ten on the generator plus `makeGetElementsScript`'s
    // own inline branch. The floor was pinned at ten and the comment said ten (gate 2), which left
    // room for a road to lose its title search with every cell green — the per-road arm above
    // exempts exactly the roads that do not search. Pinned to a floor rather than an equality so
    // that ADDING a road does not redden a cell that already covers it.
    expect(searched).toBeGreaterThanOrEqual(11);
  });

  it("the miss is still a one-line exit, and the registration is on the other side of it", async () => {
    // FOUND BY MUTATION (gate 2): moving the registration INSIDE the not-found branch —
    //   if (-not $target) { Write-Output '…'; <register>; exit }
    // left all 31 cells green. The script still contains the registration, still has a `FindAll`
    // before it, still has the title search before that, still lacks the spelled-out warm-up. The
    // mutant registers only when the window was NOT found: it ships precisely the frameless tree
    // this change exists to remove, with the suite green.
    //
    // Pinned as the verbatim guard line, because what the mutation destroys is the line, not an
    // ordering: in the mutant the one-line `if (-not $target) { … ; exit }` no longer exists.
    const miss = `if (-not $target) { Write-Output '{"error":"Window not found"}'; exit }`;
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script.indexOf(miss)).toBeGreaterThanOrEqual(0);
    expect(script.indexOf(miss)).toBeLessThan(script.indexOf(REGISTER));
  });

  it("warms up first, on every road that registers at all", async () => {
    // ORDER IS THE WHOLE MECHANISM: registering straight after `Add-Type` does not take. Whether
    // it also fails QUIETLY is an open contradiction between two rounds, and the account of it is
    // on `PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL` — not restated here, because restating a disputed
    // finding in a second place is how it came to be shipped in four. Either way the mutation this
    // cell is for survives the script, so the cell reads the two positions, not the presence.
    for (const [label, call] of roads) {
      scripts.length = 0;
      const script = await scriptOf(call);
      if (!script.includes(REGISTER)) continue;
      expect(warmsUpBeforeRegistering(script), `${label}: nothing warms this client up first`).toBe(true);
    }
  });

  it("the roads that resolve by handle still spell their own warm-up, and spell it first", async () => {
    // `FromHandle` is not a search, so those scripts have nothing else before the registration —
    // and whether `FromHandle` alone satisfies the client was NOT measured (the round that
    // settled the title roads left it open). The warm-up stays there until it is.
    const script = await scriptOf(() => clickElement("App", "Save", undefined, undefined, { hwnd: 42n }));
    const warm = script.indexOf(WARM_UP);
    expect(warm).toBeGreaterThanOrEqual(0);
    expect(warm).toBeLessThan(script.indexOf(REGISTER));
  });

  it("the title roads pay no warm-up of their own, because the search is one", async () => {
    // Not a saving worth a cell on its own — it is here because the spelled-out warm-up came out
    // of this file once already, and a future reader adding it back to `makeResolveWindowByTitlePs`
    // should have to read why it is not needed rather than measure it again (win2, `f3ce315`:
    // same ten elements with and without, on the fixture where registration does anything at all).
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script).not.toContain(WARM_UP);
    expect(warmsUpBeforeRegistering(script)).toBe(true);
  });

  it("registers for every shape of title a caller can send, not just the convenient one", async () => {
    // FOUND BY MUTATION: making the registration conditional on the title being non-empty —
    // `${safeTitle ? PS_REGISTER_CLIENTSIDE_PROVIDERS_CALL : ""}` — killed nothing, because every road
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

  it("keeps the reflection lookup out of the pipeline", async () => {
    // FOUND BY MUTATION (gate 2): dropping `$regMethod = ` is a plausible tidy-up, and it is not
    // cosmetic — a bare `[…].GetMethod(…)` writes the MethodInfo to stdout, which is the channel
    // every one of these roads parses as JSON. All ten title roads would start failing at
    // `JSON.parse`, and no cell noticed.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script).toMatch(/\$regMethod = \[System\.Windows\.Automation\.ClientSettings\]\.GetMethod\(/);
  });

  it("names the assembly exactly, because a typo would be caught and swallowed", async () => {
    // The registration sits inside `try { … } catch {}`. A wrong name, version or token throws
    // there and the script goes on to return a frameless window with no sign anything failed.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script).toContain(
      "'UIAutomationClientsideProviders, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'",
    );
  });

  it("registers after the window is found, not before — there is nothing else to warm it up", async () => {
    // On a title road the search IS the warm-up, so hoisting the registration above it leaves the
    // registration as the process's first UIA call — the state measured to throw
    // `NullReferenceException` rather than to fail quietly.
    const script = await scriptOf(() => getElementBounds("App", "Save"));
    expect(script.indexOf(TITLE_SEARCH)).toBeLessThan(script.indexOf(REGISTER));
  });
});

describe("the frame it can now see does not answer for the window", () => {
  /**
   * GATE 2, and the reason this change is not just an addition.
   *
   * Registering puts a synthesised `TitleBar` into every one of these walks as a depth-1 child
   * whose `Name` is the window's caption, and every search here takes the FIRST match of
   * `-like '*needle*'`.
   *
   * MEASURED 2026-09-20 win2 (internal `e105936`), on three builds with one fixture and one
   * instrument — and it narrowed the claim these cells were written for. The frame is NOT ahead of
   * the client area: the children come back `MenuBar, Button, TitleBar, MenuItem, …`. So the cell
   * that puts the needle in BOTH the caption and a control finds the control on every build and
   * shows nothing. The regression is one cell over: a needle that occurs ONLY in the caption.
   * `getElementBounds(window, "SAVEQ")` on a window called `RCD136-SAVEQ-…` answered a 23-pixel
   * strip across the top, and `wait_until` answered `ok:true` with it, where both used to say not
   * found.
   *
   * **Those are two different questions and only one of them is this defect**: the needle in both
   * places asks which match comes first; the needle in one place asks what a miss lands on. The
   * first arm was the one asked for and it would have passed on a broken build.
   *
   * Both are worth keeping, and the reason is worth writing down rather than inferring: the order
   * above is a property of THAT FIXTURE, not of legacy windows. Nobody has checked whether a
   * window exists whose synthesised title bar comes first — and on such a window the defect shows
   * up in the first arm as well. "The frame is third" is a measurement of one window.
   *
   * That is internal #134's defect one element deeper: a search that found nothing used to say so,
   * and came to answer with the window instead. The guard is the same shape as #134's and lives in
   * one constant.
   */
  const GUARD = "$c.ControlType.ProgrammaticName -eq 'ControlType.TitleBar'";

  const searching: [string, () => Promise<unknown>][] = [
    ["getElementBounds", () => getElementBounds("Save As", "Save")],
    ["getElementChildren", () => getElementChildren("Save As", "Save", undefined, undefined, 2, 50, 5000)],
    ["clickElement (by title)", () => clickElement("Save As", "Save")],
    ["clickElement (by handle)", () => clickElement("Save As", "Save", undefined, undefined, { hwnd: 42n })],
    ["setElementValue (by title)", () => setElementValue("Save As", "x", "Save")],
    ["setElementValue (by handle)", () => setElementValue("Save As", "x", "Save", undefined, { hwnd: 42n })],
    ["insertTextViaTextPattern2", () => insertTextViaTextPattern2("Save As", "x", "Save")],
    ["scrollElementIntoView", () => scrollElementIntoView("Save As", "Save")],
    ["getScrollAncestors", () => getScrollAncestors("Save As", "Save")],
    ["scrollByPercent", () => scrollByPercent("Save As", "Save", 50, -1)],
  ];

  for (const [label, call] of searching) {
    it(`${label}: refuses a title bar that is only repeating the window's name`, async () => {
      scripts.length = 0;
      const script = await scriptOf(call);
      expect(script).toContain(GUARD);
      // The caption is read ONCE, before the walk — not per element, which on a 26-element tree
      // is 26 cross-process property reads per search.
      expect(script).toContain("try { $targetName = $target.Current.Name } catch {}");
      expect(script.indexOf("$targetName = $target.Current.Name")).toBeLessThan(script.indexOf(GUARD));
    });
  }

  it("refuses the match and never the subtree, or the frame this change unlocked stays locked", async () => {
    // The guard refuses the MATCH. `Close` and `Minimize` are the title bar's CHILDREN and they
    // are the whole point of registering, so a guard written as an early `return` — prune the
    // subtree rather than decline the candidate — hands back exactly the defect this change set
    // out to fix.
    //
    // FOUND BY MUTATION: the first version of this cell compared the guard's POSITION against the
    // recursion's, and the pruning mutation sits before the recursion too, so all 56 cells stayed
    // green while `Close` became unreachable again. Position was standing in for structure.
    //
    // So: every occurrence of the guard, on every road, is an `-and -not (…)` clause of a match
    // condition. There is no other legal place for it.
    for (const [label, call] of searching) {
      scripts.length = 0;
      const script = await scriptOf(call);
      let at = script.indexOf(GUARD);
      let found = 0;
      while (at >= 0) {
        found += 1;
        expect(script.slice(Math.max(0, at - 11), at), `${label}: the guard is not part of a match test`)
          .toBe("-and -not (");
        at = script.indexOf(GUARD, at + 1);
      }
      expect(found, `${label}: no guard at all`).toBeGreaterThan(0);
      // …and the walk still recurses into whatever it declined.
      if (script.includes("function FindElement(")) {
        expect(script).toContain("foreach ($k in $kids) { FindElement $k ($depth+1) }");
      }
    }
  });

  it("leaves the title bar addressable, by type and by a name that is not the caption", async () => {
    // MEASURED 2026-09-20 win2 (internal `e105936`, arm D4): the first version of this guard was
    // in every search unconditionally, and it took the title bar away from the one call that
    // unambiguously wants it. `getElementBounds(window, name: undefined, controlType: "TitleBar")`
    // answered the title bar's rectangle before the guard and `null` after — because with no name
    // given the name filter is `$true`, so a guard about a NAME landing on the wrong element fired
    // on a caller who had named nothing. Dragging a window by its caption is a real call, and this
    // road was the only way to find what to drag.
    //
    // A guard that removes the thing it is guarding is the same defect one turn later: #134 made a
    // search stop answering with the window, and this nearly made it stop answering with the
    // window's title bar to anyone at all.
    for (const [label, call] of [
      ["by control type alone", () => getElementBounds("Save As", undefined, undefined, "TitleBar")],
      ["by name AND control type", () => getElementBounds("Save As", "Save", undefined, "TitleBar")],
      ["by automationId alone", () => getElementBounds("Save As", undefined, "TitleBar")],
    ] as [string, () => Promise<unknown>][]) {
      scripts.length = 0;
      const script = await scriptOf(call);
      expect(script, label).not.toContain(GUARD);
      // …and the caption read goes with it: a search that does not need the guard does not pay
      // for it either.
      expect(script, label).not.toContain("$targetName = $target.Current.Name");
    }
  });

  it("refuses only the mirror, not every title bar and not an unnamed window", async () => {
    // Narrow on purpose, and the narrowness is the part a later reader would file off: a title bar
    // whose name is NOT the caption still matches, and a window whose own name could not be read
    // refuses nothing (`$targetName -ne ''`) rather than refusing everything.
    const script = await scriptOf(() => getElementBounds("Save As", "Save"));
    expect(script).toContain("$targetName -ne ''");
    expect(script).toContain("$c.Name -eq $targetName");
    // …and it is an AND with the control type, not a bare name compare, so a Button called the
    // same as its window is still findable.
    expect(script).toMatch(/ControlType\.TitleBar' -and \$targetName -ne '' -and \$c\.Name -eq \$targetName/);
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
