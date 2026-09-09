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
    setValue: { ok: true, error: null, code: null } as Record<string, unknown>,
    elements: {
      windowTitle: "Untitled - Notepad",
      windowClassName: "Notepad",
      windowRect: null,
      elementCount: 0,
      elements: [] as unknown[],
    } as Record<string, unknown>,
    text: "native buffer",
    /** Make the native read fail, so an UNSCOPED caller reaches the PowerShell fallback. */
    textThrows: false,
  },
  psOutput: '{"ok":true}',
  /** What `getCachedUia` hands back, if anything. */
  cached: null as string | null,
  calls: {
    nativeClick: 0,
    nativeSetValue: 0,
    nativeElements: 0,
    nativeText: 0,
    ps: [] as { script: string; timeout?: number }[],
    cacheWrites: [] as { hwnd: bigint; text: string }[],
    enumerations: 0,
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
  isExcludedWindowHandle: vi.fn(() => false),
}));

vi.mock("../../src/engine/layer-buffer.js", () => ({
  getCachedUia: () => h.cached,
  updateUiaCache: (hwnd: bigint, text: string) => { h.calls.cacheWrites.push({ hwnd, text }); },
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeUia: {
    async uiaClickElement() { h.calls.nativeClick++; return h.native.click; },
    async uiaSetValue() { h.calls.nativeSetValue++; return h.native.setValue; },
    async uiaGetElements() { h.calls.nativeElements++; return h.native.elements; },
    async uiaGetTextViaTextPattern() {
      h.calls.nativeText++;
      if (h.native.textThrows) throw new Error("native read failed");
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
  h.calls.nativeElements = 0;
  h.calls.nativeText = 0;
  h.calls.ps = [];
  h.calls.cacheWrites = [];
  h.calls.enumerations = 0;
  h.cached = null;
  h.native.click = { ok: true, element: "Start", error: null, code: null };
  h.native.setValue = { ok: true, error: null, code: null };
  h.psOutput = '{"ok":true}';
  h.native.textThrows = false;
  unambiguous();
});

describe("a handle on the write path is never traded for a title", () => {
  it("addresses the handle even when the title looks unambiguous right now", async () => {
    // The enumeration is a photograph, and the invoke happens after it. A same-titled window
    // opening in between would turn a checked title into an ambiguous one, and nothing would
    // notice. This is the one place the cost is paid without asking (gate 1, round 4).
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeClick).toBe(0);
    expect(h.calls.ps).toHaveLength(1);
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
    expect(h.calls.ps[0]!.script).toContain(NOTEPAD.toString());
  });

  it("addresses the handle with a same-titled sibling on screen, obviously", async () => {
    ambiguous();
    await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeClick).toBe(0);
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
  });

  it("writes by title only when there is no handle to write by", async () => {
    const r = await clickElement("Untitled - Notepad", "Start");
    expect(h.calls.nativeClick).toBe(1);
    expect(h.calls.ps).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("setValue keeps the handle the same way", async () => {
    h.psOutput = '{"ok":true}';
    await setElementValue("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    expect(h.calls.nativeSetValue).toBe(0);
    expect(h.calls.ps[0]!.script).toContain("FromHandle");
    // …and by title when nothing was resolved, which is where the Rust engine still earns its keep.
    h.calls.ps = [];
    await setElementValue("Untitled - Notepad", "hello", "Text");
    expect(h.calls.nativeSetValue).toBe(1);
    expect(h.calls.ps).toHaveLength(0);
  });

  it("reaches a common dialog, which is what the by-handle road was added for", async () => {
    // Save As on Win11 Notepad is in the Win32 enumeration under its own title but is not among
    // the UIA root children the title search walks (H3). Gating the write on the enumeration
    // would have sent this one back through the title road that cannot see it.
    h.windows = [{ hwnd: DIALOG, title: "Save As" }, { hwnd: OTHER, title: "Calculator" }];
    h.psOutput = '{"ok":true,"element":"Save"}';
    const r = await clickElement("Save As", "Save", undefined, undefined, { hwnd: DIALOG });
    expect(h.calls.nativeClick).toBe(0);
    expect(h.calls.ps[0]!.script).toContain(DIALOG.toString());
    expect(r).toEqual({ ok: true, element: "Save" });
  });
});

describe("a pinned read is scoped, whatever the enumeration says", () => {
  it("scopes even when the title looks unambiguous right now", async () => {
    // This used to keep the native path here, and both gates refused the predicate that decided
    // it: a Win32 caption sweep cannot vouch for what a UIA `Name` search reaches, and it is a
    // photograph taken before the read. The cost is real and is paid.
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.nativeElements).toBe(0);
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

describe("a dead handle is said out loud, not parsed as a crash", () => {
  it("the by-handle click script catches FromHandle and prints the code", async () => {
    ambiguous();
    h.psOutput = '{"ok":false,"error":"Window not found by hwnd","code":"aim_window_gone"}';
    const r = await clickElement("Untitled - Notepad", "Start", undefined, undefined, { hwnd: NOTEPAD });
    // The catch has to be IN the script: without it PowerShell dies on the exception, stdout is
    // empty, and `JSON.parse` throws — which the executor reads as an ordinary UIA failure.
    expect(h.calls.ps[0]!.script).toMatch(/try \{ \$target = .*FromHandle/);
    expect(h.calls.ps[0]!.script).toContain('"code":"aim_window_gone"');
    expect(r).toEqual({ ok: false, error: "Window not found by hwnd", code: "aim_window_gone" });
  });

  it("the by-handle setValue script carries the same catch", async () => {
    ambiguous();
    h.psOutput = '{"ok":false,"error":"Window not found by hwnd","code":"aim_window_gone"}';
    const r = await setElementValue("Untitled - Notepad", "hello", "Text", undefined, { hwnd: NOTEPAD });
    expect(h.calls.ps[0]!.script).toMatch(/try \{ \$target = .*FromHandle/);
    expect(r.code).toBe("aim_window_gone");
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

  it("still honours the caller's own claim about the title it passed", async () => {
    // `screenshot` and `get_ui_elements` have keyed the cache by handle since long before this
    // ADR; that claim is theirs to make and is left alone.
    await getUiElements("Untitled - Notepad", 3, 50, 10000, { hwnd: OTHER });
    expect(h.calls.cacheWrites.map((c) => c.hwnd)).toEqual([OTHER]);
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
    // The constant it replaced was 4000 ms; the real thing was measured at 233 ms median on the
    // Windows machine. Subtracting the estimate cost `_narration` most of its walking time —
    // 4000 ms of deadline collapsing to the 1000 ms floor.
    h.psOutput = JSON.stringify({ windowTitle: "Untitled - Notepad", elementCount: 0, elements: [] });
    const before = Date.now();
    await getUiElements("Untitled - Notepad", 3, 50, 4000, { pinnedHwnd: NOTEPAD });
    const script = h.calls.ps[0]!.script;
    // The deadline is in the script, not a number derived from it out here …
    expect(script).toContain("4000 -");
    // … and what gets subtracted is read from the clock, not assumed.
    expect(script).toContain("[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()");
    const stamp = Number(/ToUnixTimeMilliseconds\(\) - (\d+)\)/.exec(script)![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it("does not cache a tree the walk cut short", async () => {
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
  it("adds the process start to the caller's budget rather than eating it", async () => {
    h.psOutput = '{"ok":true,"text":"C:\\\\> ","controlType":"Document"}';
    await getTextViaTextPattern("Untitled - Notepad", 6000, { pinnedHwnd: NOTEPAD });
    expect(h.calls.nativeText).toBe(0);
    // 6000 ms of reading, plus the process start and the two Add-Type loads that happen before
    // the script's first statement. Sharing one number left ~2 s for the read itself, and a
    // timeout here returns null — reported as "no buffer", not as "not read in time".
    expect(h.calls.ps[0]!.timeout).toBe(10000);
  });

  it("leaves an unpinned caller's deadline alone, even when it falls back to PowerShell", async () => {
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
