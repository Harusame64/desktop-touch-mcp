/**
 * ADR-036 — the two halves, and the one place they are deliberately NOT symmetric.
 *
 * Round 3 of gate 2 found the same shape five times over: a seam closed on the read side and
 * left open on its twin. Closing them turned up the exception, and gate 1 named it:
 *
 *   - **the read half gates its scoping.** Scoping every read costs a PowerShell round trip on
 *     every `desktop_discover` (184 ms against 517 ms, measured), and `normalizeTarget` fills a
 *     handle from the foreground even for a bare call, so the read asks first whether the title
 *     already names only the pinned window.
 *   - **the write half does not, and must not.** The same gate was written here and refused:
 *     the check is not atomic, and it compares Win32 captions against a search that matches UIA
 *     `Name`. A read that goes to the wrong window comes back describing it; a write does not
 *     come back at all. So a handle stays authoritative, and the round trip is the price.
 *   - **a dead handle** is said out loud rather than parsed as a crash: `FromHandle` THROWS
 *     rather than returning null, and an uncaught throw became a blind mouse click at the rect
 *     the window used to occupy.
 *   - **attribution**: a tree read by title is not filed under a handle nobody scoped it to.
 *
 * Everything below the bridge is mocked: no PowerShell, no native binding, no window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** What `enumWindowsInZOrder` reports — the evidence both halves consult. */
  windows: [] as { hwnd: bigint; title: string }[],
  native: {
    click: { ok: true, element: "Start", error: null, code: null } as Record<string, unknown>,
    /** Make the native click throw, so a title click reaches the PowerShell fallback. */
    clickThrows: false,
    setValue: { ok: true, error: null, code: null } as Record<string, unknown>,
    elements: {
      windowTitle: "Untitled - Notepad",
      windowClassName: "Notepad",
      windowRect: null,
      elementCount: 0,
      elements: [] as unknown[],
    } as Record<string, unknown>,
    text: "native buffer",
    /** Make the native read fail, so the caller reaches the PowerShell fallback. */
    textThrows: false,
    /**
     * Make the whole engine fail. Since the engine takes a handle (ADR-036 PR 2) a pinned call
     * stays native, so the PowerShell script — which still exists for builds without the addon —
     * is reached only this way.
     */
    engineThrows: false,
  },
  psOutput: '{"ok":true}',
  /** What `getCachedUia` hands back, if anything. */
  cached: null as string | null,
  /** `isExcludedWindowHandle` — true while a key locker is armed, or on a PID it cannot read. */
  excludedHandle: false,
  /** `isWindowGone` — the window behind the handle has been destroyed. */
  windowGone: false,
  calls: {
    nativeClick: 0,
    nativeSetValue: 0,
    nativeInsertText: 0,
    nativeElements: 0,
    nativeText: 0,
    ps: [] as { script: string; timeout?: number }[],
    cacheWrites: [] as { hwnd: bigint; text: string }[],
    cacheProbes: [] as bigint[],
    enumerations: 0,
    nativeHwnds: [] as (string | undefined)[],
  },
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    options: { timeout?: number },
    cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
  ) => {
    h.calls.ps.push({ script: args[args.length - 1]!, timeout: options?.timeout });
    cb(null, { stdout: h.psOutput, stderr: "" });
  },
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => { h.calls.enumerations++; return h.windows; }),
  isExcludedTitle: vi.fn(() => false),
  isExcludedWindowHandle: vi.fn(() => h.excludedHandle),
  isWindowGone: vi.fn(() => h.windowGone),
}));

vi.mock("../../src/engine/layer-buffer.js", () => ({
  getCachedUia: (hwnd: bigint) => { h.calls.cacheProbes.push(hwnd); return h.cached; },
  updateUiaCache: (hwnd: bigint, text: string) => { h.calls.cacheWrites.push({ hwnd, text }); },
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeUia: {
    async uiaClickElement(o: { hwnd?: string }) {
      h.calls.nativeClick++; h.calls.nativeHwnds.push(o?.hwnd);
      // Two different failures, and cells on both sides of this rebase need both: `clickThrows` is
      // one call failing, after which the PowerShell script finishes the act and the answer says
      // `powershell`; `engineThrows` is "no engine at all", which is how the fallback roads open.
      if (h.native.clickThrows) throw new Error("native click failed");
      if (h.native.engineThrows) throw new Error("engine unavailable");
      return h.native.click;
    },
    async uiaSetValue(o: { hwnd?: string }) {
      h.calls.nativeSetValue++; h.calls.nativeHwnds.push(o?.hwnd);
      if (h.native.engineThrows) throw new Error("engine unavailable");
      return h.native.setValue;
    },
    async uiaInsertText(o: { hwnd?: string }) {
      h.calls.nativeInsertText++; h.calls.nativeHwnds.push(o?.hwnd);
      if (h.native.engineThrows) throw new Error("engine unavailable");
      return h.native.setValue;
    },
    async uiaGetElements(o: { hwnd?: string }) {
      h.calls.nativeElements++; h.calls.nativeHwnds.push(o?.hwnd);
      if (h.native.engineThrows) throw new Error("engine unavailable");
      return h.native.elements;
    },
    async uiaGetTextViaTextPattern(o: { hwnd?: string }) {
      h.calls.nativeText++; h.calls.nativeHwnds.push(o?.hwnd);
      if (h.native.textThrows || h.native.engineThrows) throw new Error("native read failed");
      return h.native.text;
    },
  },
}));

const { clickElement, setElementValue, getUiElements, getTextViaTextPattern } =
  await import("../../src/engine/uia-bridge.js");

const NOTEPAD = 0x1111n;
const TWIN    = 0x2222n;
const OTHER   = 0x3333n;
const DIALOG  = 0x4444n;

/** One window answering to the title — the common case, where scoping changes nothing. */
function unambiguous(): void {
  h.windows = [
    { hwnd: NOTEPAD, title: "Untitled - Notepad" },
    { hwnd: OTHER,   title: "Calculator" },
  ];
}
/** Two windows answering to the title — the case this ADR exists for. */
function ambiguous(): void {
  h.windows = [
    { hwnd: NOTEPAD, title: "Untitled - Notepad" },
    { hwnd: TWIN,    title: "Untitled - Notepad" },
  ];
}

beforeEach(() => {
  h.calls.nativeClick = 0;
  h.calls.nativeSetValue = 0;
  h.calls.nativeInsertText = 0;
  h.calls.nativeElements = 0;
  h.calls.nativeText = 0;
  h.calls.ps = [];
  h.calls.cacheWrites = [];
  h.calls.cacheProbes = [];
  h.calls.enumerations = 0;
  h.cached = null;
  h.excludedHandle = false;
  h.windowGone = false;
  h.native.click = { ok: true, element: "Start", error: null, code: null };
  h.native.setValue = { ok: true, error: null, code: null };
  h.psOutput = '{"ok":true}';
  h.native.textThrows = false;
  h.native.clickThrows = false;
  h.native.engineThrows = false;
  h.calls.nativeHwnds = [];
  unambiguous();
});

describe("each answer says which client gave it (ADR-036 item 16, gate 2 on #624)", () => {
  // The two clients can see different trees and name one element differently, so a click's
  // "not found" is weighed by who read the element and who looked for it.
  it("a title click answered by the native engine says native, even when it failed", async () => {
    h.native.click = { ok: false, element: null, error: "Element not found", code: null };
    expect(await clickElement("Untitled - Notepad", "Start")).toMatchObject({ ok: false, via: "native" });
  });

  it("a native click that threw, finished by the PowerShell script, says powershell", async () => {
    h.native.clickThrows = true;
    h.psOutput = '{"ok":false,"error":"Element not found"}';
    expect(await clickElement("Untitled - Notepad", "Start")).toMatchObject({ ok: false, error: "Element not found", via: "powershell" });
    expect(h.calls.ps).toHaveLength(1);
  });

  it("a read says which client read it — and a pinned read now stays in the engine", async () => {
    expect(await getUiElements("Untitled - Notepad")).toMatchObject({ via: "native" });
    // This is the assertion the branch inverts, and it is most of what the branch buys: a scoped
    // read used to skip the engine, because `uiaGetElements` took a title and nothing else, so a
    // pinned read cost the PowerShell road while every write on the session addressed the handle.
    expect(await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD }))
      .toMatchObject({ via: "native" });
    expect(h.calls.nativeHwnds).toEqual([undefined, NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("a pinned read falls back to the by-handle script when there is no engine, and says powershell", async () => {
    // The fallback keeps the scoping: what it must never do is trade the handle for the title.
    h.native.engineThrows = true;
    h.psOutput = '{"elements":[],"elementCount":0,"windowRect":null,"clientProviders":"registered"}';
    expect(await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD }))
      .toMatchObject({ via: "powershell" });
    expect(h.calls.ps).toHaveLength(1);
    expect(h.calls.ps[0]!.script).toContain(NOTEPAD.toString());
  });
});

describe("a handle on the write path is never traded for a title", () => {
  it("tells the engine which window, instead of leaving it", async () => {
    // The whole of PR 2. Before it, a handle meant a PowerShell round trip — 184 ms against
    // 517 ms — because the engine took a title and nothing else, so pinning the aim cost the
    // Rust walker on every act and every pinned read.
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeClick).toBe(1);
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("falls back to the by-handle script when there is no engine, still by handle", async () => {
    h.native.engineThrows = true;
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.ps).toHaveLength(1);
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
    expect(h.calls.ps[0]!.script).toContain(NOTEPAD.toString());
  });

  it("addresses the handle with a same-titled sibling on screen, on either road", async () => {
    ambiguous();
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    h.native.engineThrows = true;
    h.calls.ps = [];
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
  });

  it("writes by title only when there is no handle to write by", async () => {
    const r = await clickElement("Untitled - Notepad", "Start");
    expect(h.calls.nativeClick).toBe(1);
    expect(h.calls.ps).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("insertText carries the handle too, when the caller resolved one", async () => {
    // Gate 2: the engine and its declaration took a handle here, and the bridge dropped it — a road
    // that accepts a handle and then resolves by title is the defect this ADR exists to remove. The
    // one production caller now passes its resolved handle through this channel as well (PR 側
    // codex, P1 on #631; `set_element_value` channel 2, where the debt follows the channel), so the
    // road and that caller agree — this cell pins the road, and the observation suite pins the call.
    const { insertTextViaTextPattern2 } = await import("../../src/engine/uia-bridge.js");
    await insertTextViaTextPattern2("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("insertText's fallback resolves by handle too, because it is the half that writes", async () => {
    // PR 側 codex, P1 on #631: the engine refuses when TextPattern2 is the road, so this script runs
    // on a real machine. Resolving it by title would insert into a same-titled sibling while the
    // caller held an authoritative handle — the last road that still traded the handle away.
    const { insertTextViaTextPattern2 } = await import("../../src/engine/uia-bridge.js");
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    await insertTextViaTextPattern2("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    expect(script).toMatch(/try \{ \$target = .*FromHandle/);
    expect(script).toContain(NOTEPAD.toString());
    expect(script).toContain('"code":"aim_window_gone"');
    // …and it does not fall back to walking the root's children by title.
    expect(script).not.toContain("RootElement");
  });

  it("insertText's fallback guards the element walk, not just the handle lookup", async () => {
    // PR 側 codex, P2 on #631: `FromHandle` was caught, but `FindAll` and `$el.Current` throw
    // ElementNotAvailableException for the same reason — a window closing mid-lookup — and died
    // with a PowerShell exception, so the caller got a parse error instead of the gone code. The
    // click and the value write have caught the whole stretch since their own round; this is the
    // road that did not.
    const { insertTextViaTextPattern2 } = await import("../../src/engine/uia-bridge.js");
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    await insertTextViaTextPattern2("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    // The walk is inside a try whose catch answers the gone code — not merely the FromHandle line.
    expect(script).toMatch(/try \{\n\$all = \$target\.FindAll[\s\S]*?\n\} catch \{[^\n]*aim_window_gone/);
  });

  it("the title road guards the same walk, and still does not claim the window left", async () => {
    // The guard is not the sentinel. A title search that stops matching is a search that found
    // nothing, so this road answers `WindowNotFound` — the same code its own miss prints — and the
    // executor's gone-code check stays blind to it on purpose (a title call keeps no gone code).
    const { insertTextViaTextPattern2 } = await import("../../src/engine/uia-bridge.js");
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    await insertTextViaTextPattern2("Untitled - Notepad", "hello", "Text", undefined);
    const script = h.calls.ps[0]!.script;
    expect(script).toMatch(/try \{\n\$all = \$target\.FindAll[\s\S]*?\n\} catch \{[^\n]*WindowNotFound/);
    expect(script).not.toContain("aim_window_gone");
  });

  it("setValue keeps the handle the same way", async () => {
    h.psOutput = '{"ok":true}';
    await setElementValue("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
    // …and says nothing about a window nobody named.
    h.calls.nativeHwnds = [];
    await setElementValue("Untitled - Notepad", "hello", "Text");
    expect(h.calls.nativeHwnds).toEqual([undefined]);
  });

  it("reaches a common dialog through the engine, which is what the handle was added for", async () => {
    // Save As on Win11 Notepad is in the Win32 enumeration under its own title but is not among
    // the UIA root children the title search walks (H3). Gating the write on the enumeration
    // would have sent this one back through the title road that cannot see it.
    h.windows = [{ hwnd: DIALOG, title: "Save As" }, { hwnd: OTHER, title: "Calculator" }];
    h.native.click = { ok: true, element: "Save", error: null, code: null };
    const r = await clickElement("Save As", "Save", undefined, undefined, { hwnd: DIALOG });
    // This is the assertion the branch inverts. Before it, a pinned click paid a PowerShell round
    // trip and answered `via:"powershell"`; now the handle goes to the engine, so the dialog is
    // reached without leaving it.
    expect(h.calls.nativeHwnds).toEqual([DIALOG.toString()]);
    expect(h.calls.ps).toHaveLength(0);
    expect(r).toEqual({ ok: true, element: "Save", via: "native" });
  });
});

describe("a pinned read is scoped, whatever the enumeration says", () => {
  it("stays in the engine and tells it the handle", async () => {
    // Two gates refused the predicate that used to decide this by title — a Win32 caption sweep
    // cannot vouch for what a UIA Name search reaches — so every pinned read was scoped, and
    // scoping meant PowerShell. Now it means one more field.
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.nativeElements).toBe(1);
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("still scopes by handle when it has to fall back to the script", async () => {
    h.native.engineThrows = true;
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
    expect(h.calls.ps[0]!.script).toContain(NOTEPAD.toString());
  });

  it("keeps the native path for a read that pinned nothing", async () => {
    // A handle passed only to key the cache is not a scoping request, and `screenshot` passes
    // exactly that — taking the Rust engine away from it was a regression once already.
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { hwnd: NOTEPAD });
    expect(h.calls.nativeElements).toBe(1);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("does not consult the window list at all — there is no question left to ask", async () => {
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    await getTextViaTextPattern("Untitled - Notepad", 6000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.enumerations).toBe(0);
  });
});

describe("the budget never outlives the wait that kills the process", () => {
  it("floors at zero, not at a walk that would run past the deadline", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    // `workspace.ts` asks for 2000 ms. A 1000 ms floor plus a slow start ends the walk at
    // ~2044 ms against a 2000 ms kill: empty stdout, a parse error, and the whole read lost —
    // which is what `truncated` exists to avoid. An empty tree that says it was cut short is a
    // thing a caller can act on; nothing is not.
    h.psOutput = JSON.stringify({ windowTitle: "x", elementCount: 0, truncated: true, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 2000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.ps[0]!.script).toContain("[Math]::Max(0, 2000 -");
  });

  it("clamps the elapsed term too, so a backwards clock cannot lengthen the walk", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    // The outer `Max(0, …)` only stops the budget going negative. If the clock steps BACKWARDS
    // between the timestamp taken here and the read inside the script, `(now − spawnedAt)` is
    // negative and the budget grows by that much — past the deadline, so the walk outlives the
    // kill and the whole read is lost. Measured on the real machine by running the emitted
    // expression: a 2 s backwards jump against a 2000 ms deadline produced a 2909 ms budget.
    h.psOutput = JSON.stringify({ windowTitle: "x", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 2000, { pinnedHwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    // Not clamped to zero: that fixes the sign and drops the real startup out of the sum, so the
    // script walks `deadline − margin` on top of a start that happened. A measurement that came
    // out negative is nonsense, and nonsense falls back to the conservative estimate.
    expect(script).toContain("if ($elapsedMs -lt 0) { $elapsedMs = 4000 }");
    expect(script).toContain("$budgetMs = [Math]::Max(0, 2000 - $elapsedMs - 1000)");
  });

  it("probes and writes the cache under one key", async () => {
    // The two had opposite precedence for a while, so a caller passing both would write under
    // one and look under the other: a permanent miss, and a title-derived tree answering a
    // scoped request.
    h.psOutput = JSON.stringify({ windowTitle: "x", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, {
      hwnd: OTHER, pinnedHwnd: NOTEPAD, cached: true,
    });
    expect(h.calls.cacheProbes).toEqual([NOTEPAD]);
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([NOTEPAD]);
  });
});

describe("an ordinary closed window is not called a security refusal", () => {
  it("says the aim is gone when the handle names nothing, even while a locker is armed", async () => {
    // `isExcludedWindowHandle` fails CLOSED on a PID it cannot read, and a destroyed window
    // reads as PID 0. Both answers refuse; only one of them is true, and the executor rethrows
    // an exclusion without trying anything else — telling the caller it may not touch a window
    // that no longer exists, instead of telling it to discover again.
    h.excludedHandle = true;
    h.windowGone = true;
    await expect(getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD }))
      .rejects.toThrow(/is gone/);
  });

  it("still refuses an excluded window that is very much alive", async () => {
    h.excludedHandle = true;
    h.windowGone = false;
    await expect(getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD }))
      .rejects.toThrow(/key locker/);
  });
});

describe("a dead handle is said out loud, not parsed as a crash", () => {
  it("the by-handle click script catches FromHandle and prints the code", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":false,"error":"Window not found by hwnd","code":"aim_window_gone"}';
    const r = await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    // The catch has to be IN the script: without it PowerShell dies on the exception, stdout is
    // empty, and `JSON.parse` throws — which the executor reads as an ordinary UIA failure.
    expect(h.calls.ps[0]!.script).toMatch(/try \{ \$target = .*FromHandle/);
    expect(h.calls.ps[0]!.script).toContain('"code":"aim_window_gone"');
    expect(r).toEqual({ ok: false, error: "Window not found by hwnd", code: "aim_window_gone", via: "powershell" });
  });

  it("both write scripts register the providers too, or discover shows what act cannot press", async () => {
    // The registration is process-local and every call is a fresh powershell.exe, so a discover
    // that registered and an act that did not are two views of one window. Measured: discover
    // returned Notepad's `Close`, the act could not find it, and the executor pressed the
    // entity's rect with the mouse — `ok:true`, the truth only in `downgrade`, and `Minimize`'s
    // rect already at -32000,-32000. Warm-up first: registering before UIA is up does nothing,
    // silently.
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    for (const run of [
      () => clickElement("Untitled - Notepad", "Close", undefined, undefined, { hwnd: NOTEPAD }),
      () => setElementValue("Untitled - Notepad", "x", "Field", undefined, { hwnd: NOTEPAD }),
    ]) {
      h.calls.ps = [];
      await run();
      const script = h.calls.ps[0]!.script;
      const warmUp = script.indexOf("$null = $target.FindAll");
      const register = script.indexOf("RegisterClientSideProviderAssembly");
      expect(register, "the write road must register too").toBeGreaterThan(-1);
      expect(warmUp).toBeGreaterThan(-1);
      expect(warmUp, "warm-up first, or the registration is a silent no-op").toBeLessThan(register);
    }
  });

  it("the engine says the same thing, on the road that is now primary", async () => {
    // Gate 2 on this branch: every cell above holds the PowerShell road, which is the fallback
    // now. The engine answers a dead handle with a sentence, and the code is what the executor
    // weighs — without it a pinned act on a closed window came back `aim_route_failed`, whose
    // advice is not "do not press the rect". The Rust side sets the code on the handle road only.
    h.native.click = { ok: false, element: null, error: "Window not found by hwnd: 4369", code: "aim_window_gone" };
    const r = await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.ps).toHaveLength(0);
    expect(r).toEqual({ ok: false, error: "Window not found by hwnd: 4369", code: "aim_window_gone", via: "native" });
  });

  it("a failure raised after the window was found keeps no gone code", async () => {
    // PR 側 codex, P2 on #631: `BuildUpdatedCache` can fault on a window that is perfectly alive (a
    // provider hiccup, an RPC fault), and calling that "gone" would send the caller to re-discover a
    // window that is still there. The Rust side marks that case and withholds the code; this pins the
    // shape the bridge must pass through untouched — no code, so the ladder answers aim_route_failed.
    h.native.click = { ok: false, element: null, error: "UIA cache build failed: 0x80004005", code: null };
    const r = await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(r).toMatchObject({ ok: false, via: "native" });
    expect(r.code).toBeUndefined();
  });

  it("a title call keeps no gone code, because a title that matches nothing is not a window that left", async () => {
    h.native.click = { ok: false, element: null, error: "Window not found: Untitled - Notepad", code: null };
    const r = await clickElement("Untitled - Notepad", "Start");
    expect(r).toMatchObject({ ok: false, via: "native" });
    expect(r.code).toBeUndefined();
  });

  it("the by-handle setValue script carries the same catch", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":false,"error":"Window not found by hwnd","code":"aim_window_gone"}';
    const r = await setElementValue("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    expect(h.calls.ps[0]!.script).toMatch(/try \{ \$target = .*FromHandle/);
    expect(r.code).toBe("aim_window_gone");
  });
});

describe("the pre-invoke stretch is guarded too, and the payload is serialised", () => {
  it("catches a window that goes between FromHandle and the invoke", async () => {
    // FindAll, `$el.Current` and TryGetCurrentPattern all throw ElementNotAvailableException
    // when the window closes mid-script. Only FromHandle was caught, so that death arrived as a
    // PowerShell exception, reached the caller as a JSON parse error, and read as an ordinary
    // UIA failure — the route that used to end at a blind press of the remembered rect.
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    // The whole lookup sits inside a try that answers with the gone-aim code, not just the
    // FromHandle line above it.
    const fromHandleCatch = script.indexOf("catch { Write-Output");
    const findAll = script.indexOf("$all   = $target.FindAll");
    const lookupCatch = script.indexOf('} catch { Write-Output \'{"ok":false,"error":"Window not found by hwnd"');
    expect(findAll).toBeGreaterThan(fromHandleCatch);
    expect(lookupCatch).toBeGreaterThan(findAll);
  });

  it("reads the element name before invoking, and serialises the answer", async () => {
    // Two failures in one line before this: a name with a quote made invalid JSON, so the parse
    // threw AFTER the invoke had happened; and reading the name after `Invoke()` throws for
    // exactly the controls worth invoking — a Close or an OK that destroys itself.
    h.native.engineThrows = true;
    ambiguous();
    h.psOutput = '{"ok":true}';
    await clickElement("Untitled - Notepad", "Close", undefined, undefined, { hwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    expect(script).toContain("$elementName = ''");
    // The CODE line, not the comment above it that mentions the same call — the comment sits
    // earlier in the script and an `indexOf` cannot tell them apart.
    expect(script.indexOf("$elementName = [string]$found.Current.Name"))
      .toBeLessThan(script.indexOf("\n    $ip.Invoke()"));
    expect(script).toContain("ConvertTo-Json -Compress");
    expect(script).not.toContain(`'{"ok":true,"element":"' +`);
  });
});

describe("a tree is filed under a handle only when the read was scoped to it", () => {
  it("files under the window that was read, not the one the caller keyed by", async () => {
    // The two parameters are different requests, and when they disagree the read is the one
    // that can vouch for itself: it went through `FromHandle`. A caller's key is a claim about
    // a title; a scoped read is evidence about a window.
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { hwnd: OTHER, pinnedHwnd: NOTEPAD });
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([NOTEPAD]);
  });

  it("files a scoped tree under the handle it was scoped to", async () => {
    ambiguous();
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([NOTEPAD]);
  });

  it("does not file a tree that may have been cut short, on the engine's road either", async () => {
    // The PowerShell road refuses to cache a truncated tree; the engine reports no `truncated`, so
    // the proxy is the cap — a walk holding exactly as many elements as it was allowed may have
    // stopped early. Before this branch a pinned read took the PowerShell road, where the refusal
    // already lived; gate 2 found the native road caching unconditionally, which would serve a
    // prefix to `screenshot` for the whole TTL.
    h.native.elements = {
      windowTitle: "Untitled - Notepad", elementCount: 2,
      elements: [{ name: "a" }, { name: "b" }] as never,
    } as never;
    await getUiElements("Untitled - Notepad", 3, 2, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.cacheWrites).toHaveLength(0);
    // …and a read that came back under the cap is filed as before.
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([NOTEPAD]);
  });

  it("still honours the caller's own claim about the title it passed", async () => {
    // `screenshot` and `get_ui_elements` have keyed the cache by handle since long before this
    // ADR; that claim is theirs to make and is left alone.
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { hwnd: OTHER });
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([OTHER]);
  });
});

describe("the frame of the window is in the tree, or the read says it is not", () => {
  it("warms UIA up BEFORE registering the clientside providers, because the order is the fix", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    // Measured four ways on Windows: no registration 2 elements, registration alone 2, warm-up
    // alone 2, warm-up THEN registration 26. Registering straight after `Add-Type` returns
    // without error and changes nothing — the failure this ordering prevents is invisible.
    h.psOutput = JSON.stringify({ windowTitle: "x", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 8000, { pinnedHwnd: NOTEPAD });
    const script = h.calls.ps[0]!;
    const warmUp = script.script.indexOf("$preRegisterChildren = $target.FindAll");
    const register = script.script.indexOf("RegisterClientSideProviderAssembly");
    expect(warmUp).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(-1);
    expect(warmUp, "the warm-up must come first or the registration is a no-op").toBeLessThan(register);
  });

  it("carries the verdict back, rather than assuming the call worked", async () => {
    h.native.engineThrows = true;   // clientProviders is a property of the fallback road; the engine never needed the registration
    h.psOutput = JSON.stringify({
      windowTitle: "x", elementCount: 1, clientProviders: "noop",
      elements: [{ name: "Pane" }],
    });
    const r = await getUiElements("Untitled - Notepad", 3, 50, 8000, { pinnedHwnd: NOTEPAD });
    expect(r.clientProviders).toBe("noop");
  });
});

describe("a cache hit does not pay for a question it did not need to ask", () => {
  it("probes the cache before sweeping every top-level window", async () => {
    // The scoping gate is an `enumWindowsInZOrder()` sweep — a handful of syscalls per window —
    // and it exists to decide how to READ. A hit does not read (2ゲート目の指摘).
    h.cached = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    const r = await getUiElements("Untitled - Notepad", 3, 50, 10000, {
      hwnd: NOTEPAD, pinnedHwnd: NOTEPAD, cached: true,
    });
    expect(r._cacheHit).toBe(true);
    expect(h.calls.enumerations).toBe(0);
    expect(h.calls.nativeElements).toBe(0);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("still reads when there is nothing cached", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, {
      hwnd: NOTEPAD, pinnedHwnd: NOTEPAD, cached: true,
    });
    expect(h.calls.ps).toHaveLength(1);
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([NOTEPAD]);
  });
});

describe("the walk measures its own start instead of being told what it cost", () => {
  it("hands the script the caller's whole deadline and a timestamp to subtract", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    // The constant it replaced was 4000 ms; the real thing was measured at 233 ms median on the
    // Windows machine. Subtracting the estimate cost `_narration` most of its walking time —
    // 4000 ms of deadline collapsing to the 1000 ms floor.
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    const before = Date.now();
    await getUiElements("Untitled - Notepad", 3, 50, 4000, { pinnedHwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    // The deadline is in the script, not a number derived from it out here …
    expect(script).toContain("4000 -");
    // … and what gets subtracted is read from the clock, not assumed. Epoch milliseconds the
    // long way round, because `ToUnixTimeMilliseconds` wants .NET 4.6 and a script that throws
    // comes back as a parse error.
    expect(script).toContain("[datetime]::UtcNow - [datetime]::new(1970,1,1)");
    // No date string in the expression. The cast form was measured to be culture-invariant, so
    // this is not guarding today's behaviour — it is guarding the tidy-up that turns a string
    // into `::Parse`, which is +543 years in th-TH, negative in fa-IR, and an exception in
    // ar-SA (empty stdout, and the failure arrives wearing a parse error's face).
    expect(script).not.toContain("'1970-01-01'");
    const stamp = Number(/TotalMilliseconds - (\d+)/.exec(script)![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it("does not cache a tree the walk cut short", async () => {
    h.native.engineThrows = true;   // only the fallback walk has a clock to run out of
    // A prefix of a window is not the window, and the cache serves it for the whole TTL.
    h.psOutput = JSON.stringify({
      windowTitle: "Untitled - Notepad", elementCount: 1, truncated: true,
      elements: [{ name: "Start" }],
    });
    const r = await getUiElements("Untitled - Notepad", 3, 50, 4000, { pinnedHwnd: NOTEPAD });
    expect(r.truncated).toBe(true);
    expect(h.calls.cacheWrites).toHaveLength(0);
  });
});

describe("the terminal buffer read gets a deadline it can finish inside", () => {
  it("reads the pinned terminal through the engine, handle and all", async () => {
    // The buffer read had to leave the engine for the same reason the tree read did: a title and
    // nothing else. Reading one terminal while the keys go to its same-titled twin is the split
    // this ADR closed, and it was closed by paying PowerShell until the engine could be told.
    const text = await getTextViaTextPattern("Untitled - Notepad", 6000, { pinnedHwnd: NOTEPAD });
    expect(text).toBe("native buffer");
    expect(h.calls.nativeHwnds).toEqual([NOTEPAD.toString()]);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("adds the process start to the caller's budget rather than eating it", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    h.psOutput = '{"ok":true,"text":"C:\\\\> ","controlType":"Document"}';
    await getTextViaTextPattern("Untitled - Notepad", 6000, { pinnedHwnd: NOTEPAD });
    // 6000 ms of reading, plus the process start and the two Add-Type loads that happen before
    // the script's first statement. Sharing one number left ~2 s for the read itself, and a
    // timeout here returns null — reported as "no buffer", not as "not read in time".
    expect(h.calls.ps[0]!.timeout).toBe(10000);
  });

  it("leaves an unpinned caller's deadline alone, even when it falls back to PowerShell", async () => {
    // The engine takes a handle now, so a pinned call stays native. The script below is the
    // fallback for a build without the addon — where every protection still has to hold.
    h.native.engineThrows = true;
    // `terminal.ts` reads a baseline and a post-read around every send and treats 6000 as a hard
    // deadline. The headroom exists for the read this ADR added; quietly adding four seconds to
    // every existing caller is not its business (2ゲート目の指摘).
    h.native.textThrows = true;
    h.psOutput = '{"ok":true,"text":"C:\\> ","controlType":"Document"}';
    await getTextViaTextPattern("Untitled - Notepad", 6000);
    expect(h.calls.ps[0]!.timeout).toBe(6000);
  });

  it("keeps the native path for an unpinned read, where its deadline is untouched", async () => {
    const text = await getTextViaTextPattern("Untitled - Notepad", 6000);
    expect(text).toBe("native buffer");
    expect(h.calls.ps).toHaveLength(0);
  });
});
