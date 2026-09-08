/**
 * tests/unit/resolve-window.test.ts
 *
 * Unit tests for resolveWindowTarget (src/tools/_resolve-window.ts).
 *
 * Cases:
 *   hwnd path (5 cases)
 *   @active path (3 cases)
 *   plain windowTitle / no-op path (2 cases)
 *   dock-window warning (2 cases)
 *   returned shape invariants (2 cases)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const {
  mockGetForegroundHwnd, mockGetWindowTitleW, mockGetWindowRectByHwnd,
  // H3 additions
  mockEnumWindowsInZOrder, mockGetWindowOwner, mockGetWindowClassName,
  mockIsWindowEnabled, mockGetLastActivePopup,
  // R3 tool-exclusion
  mockIsExcludedWindowHandle, mockIsExcludedTitle,
} = vi.hoisted(() => ({
  mockGetForegroundHwnd:    vi.fn<() => bigint | null>(),
  mockGetWindowTitleW:      vi.fn<(hwnd: unknown) => string>(),
  mockGetWindowRectByHwnd:  vi.fn<(hwnd: unknown) => { x: number; y: number; width: number; height: number } | null>(),
  mockEnumWindowsInZOrder:  vi.fn(),
  mockGetWindowOwner:       vi.fn<(hwnd: unknown) => bigint | null>(),
  mockGetWindowClassName:   vi.fn<(hwnd: unknown) => string>(),
  mockIsWindowEnabled:      vi.fn<(hwnd: unknown) => boolean>(),
  mockGetLastActivePopup:   vi.fn<(hwnd: unknown) => bigint | null>(),
  mockIsExcludedWindowHandle: vi.fn<(hwnd: unknown) => boolean>(),
  mockIsExcludedTitle:      vi.fn<(title: string) => boolean>(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  getForegroundHwnd:    mockGetForegroundHwnd,
  getWindowTitleW:      mockGetWindowTitleW,
  getWindowRectByHwnd:  mockGetWindowRectByHwnd,
  enumWindowsInZOrder:  mockEnumWindowsInZOrder,
  getWindowOwner:       mockGetWindowOwner,
  getWindowClassName:   mockGetWindowClassName,
  isWindowEnabled:      mockIsWindowEnabled,
  getLastActivePopup:   mockGetLastActivePopup,
  isExcludedWindowHandle: mockIsExcludedWindowHandle,
  isExcludedTitle:      mockIsExcludedTitle,
}));

/**
 * ADR-035 observation. Mocked so a test can COUNT `resolve` events: the
 * invariant the log is built on is "one resolution = one event", and
 * `narrate: "rich"` broke it by resolving twice for one dispatch.
 */
const { mockLogResolve } = vi.hoisted(() => ({ mockLogResolve: vi.fn() }));
vi.mock("../../src/tools/_resolve-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-log.js")>();
  return { ...actual, logResolve: mockLogResolve };
});

// tool-exclusion.js is NOT mocked — WindowExcludedError is the real class refuseIfExcludedTarget throws.
import { resolveWindowTarget, withPinnedResolution } from "../../src/tools/_resolve-window.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetForegroundHwnd.mockReset();
  mockGetWindowTitleW.mockReset();
  mockGetWindowRectByHwnd.mockReset();
  // H3 defaults: enabled windows, no popup, no dialog in enum
  mockEnumWindowsInZOrder.mockReturnValue([]);
  mockGetWindowOwner.mockReturnValue(null);
  mockGetWindowClassName.mockReturnValue("");
  mockIsWindowEnabled.mockReturnValue(true);
  mockGetLastActivePopup.mockReturnValue(null);
  // R3: by default no window is excluded; individual exclusion tests flip this to true.
  mockIsExcludedWindowHandle.mockReset();
  mockIsExcludedWindowHandle.mockReturnValue(false);
  mockIsExcludedTitle.mockReset();
  mockIsExcludedTitle.mockReturnValue(false);
  mockLogResolve.mockReset();
  delete process.env.DESKTOP_TOUCH_DOCK_TITLE;
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_DOCK_TITLE;
});

// ─── hwnd path ────────────────────────────────────────────────────────────────

describe("resolveWindowTarget — hwnd path", () => {
  it("resolves a valid hwnd to title and BigInt hwnd", async () => {
    mockGetWindowTitleW.mockReturnValue("Untitled - Notepad");
    const result = await resolveWindowTarget({ hwnd: "1000" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Untitled - Notepad");
    expect(result!.hwnd).toBe(1000n);
  });

  it("returns empty title when getWindowTitleW returns empty but rect exists", async () => {
    mockGetWindowTitleW.mockReturnValue("");
    mockGetWindowRectByHwnd.mockReturnValue({ x: 0, y: 0, width: 100, height: 100 });
    const result = await resolveWindowTarget({ hwnd: "2000" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("");
    expect(result!.hwnd).toBe(2000n);
  });

  it("throws WindowNotFound when hwnd string is not a valid integer", async () => {
    await expect(resolveWindowTarget({ hwnd: "not-a-number" })).rejects.toThrow(
      /WindowNotFound.*not a valid integer/
    );
  });

  it("throws WindowNotFound when no visible window with given hwnd (empty title + null rect)", async () => {
    mockGetWindowTitleW.mockReturnValue("");
    mockGetWindowRectByHwnd.mockReturnValue(null);
    await expect(resolveWindowTarget({ hwnd: "9999" })).rejects.toThrow(
      /WindowNotFound.*9999/
    );
  });

  it("returns empty warnings array when no dock title is set", async () => {
    mockGetWindowTitleW.mockReturnValue("Calculator");
    const result = await resolveWindowTarget({ hwnd: "3000" });
    expect(result!.warnings).toEqual([]);
  });
});

// ─── @active path ─────────────────────────────────────────────────────────────

describe("resolveWindowTarget — @active path", () => {
  it("resolves @active to foreground window hwnd and title", async () => {
    mockGetForegroundHwnd.mockReturnValue(5000n);
    mockGetWindowTitleW.mockReturnValue("Google Chrome");
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(5000n);
    expect(result!.title).toBe("Google Chrome");
  });

  it("throws WindowNotFound when getForegroundHwnd returns null", async () => {
    mockGetForegroundHwnd.mockReturnValue(null);
    await expect(resolveWindowTarget({ windowTitle: "@active" })).rejects.toThrow(
      /WindowNotFound.*@active/
    );
  });

  it("returns empty warnings when @active does not match dock title", async () => {
    mockGetForegroundHwnd.mockReturnValue(6000n);
    mockGetWindowTitleW.mockReturnValue("Notepad");
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result!.warnings).toEqual([]);
  });
});

// ─── plain windowTitle / no-op ───────────────────────────────────────────────

describe("resolveWindowTarget — no-op path", () => {
  it("returns null for plain windowTitle", async () => {
    const result = await resolveWindowTarget({ windowTitle: "Notepad" });
    expect(result).toBeNull();
  });

  it("returns null when no params provided", async () => {
    const result = await resolveWindowTarget({});
    expect(result).toBeNull();
  });
});


// ─── ADR-035: one resolution, one event ──────────────────────────────────────

describe("resolveWindowTarget — logAs:\"off\" (ADR-035 event count)", () => {
  /**
   * `withRichNarration` resolves the target BEFORE the action to know what to
   * snapshot, and again after, and hands the second answer to the handler. Every
   * one of those went through the same logging path, so one dispatch wrote two
   * identical events on a rich call and one on a minimal call — a bias
   * correlated with a narration parameter, in the histogram ADR-035 Phase C is
   * still using to choose a predicate. The probe is silenced; the resolution the
   * handler is given is not.
   *
   * Each case is paired with the same fixture at the default, so the assertion
   * cannot pass because the path stopped logging altogether.
   */

  it("a plain-title miss logs once by default and not at all when silenced", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 500n, title: "Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    expect(await resolveWindowTarget({ windowTitle: "Does Not Exist" })).toBeNull();
    expect(mockLogResolve).toHaveBeenCalledTimes(1);

    mockLogResolve.mockReset();
    expect(await resolveWindowTarget({ windowTitle: "Does Not Exist" }, { logAs: "off" })).toBeNull();
    expect(mockLogResolve).not.toHaveBeenCalled();
  });

  it("a plain top-level match logs once by default and not at all when silenced", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 400n, title: "名前を付けて保存 - App", className: "AppClass", ownerHwnd: null, isMinimized: false },
    ]);
    expect(await resolveWindowTarget({ windowTitle: "名前を付けて保存" })).toBeNull();
    expect(mockLogResolve).toHaveBeenCalledTimes(1);
    expect(mockLogResolve.mock.calls[0][0]).toMatchObject({ resolver: "pickPlainTopLevelWindowByTitle" });

    mockLogResolve.mockReset();
    expect(await resolveWindowTarget({ windowTitle: "名前を付けて保存" }, { logAs: "off" })).toBeNull();
    expect(mockLogResolve).not.toHaveBeenCalled();
  });

  it("the dialog rescue logs once by default and not at all when silenced", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 200n, title: "名前を付けて保存",    className: "#32770",  ownerHwnd: 100n, isMinimized: false },
    ]);
    const first = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(first!.hwnd).toBe(200n);
    expect(mockLogResolve).toHaveBeenCalledTimes(1);
    expect(mockLogResolve.mock.calls[0][0]).toMatchObject({ resolver: "resolveWindowTargetDialog" });

    mockLogResolve.mockReset();
    const again = await resolveWindowTarget({ windowTitle: "名前を付けて保存" }, { logAs: "off" });
    // Silencing changes the RECORD, never the answer.
    expect(again!.hwnd).toBe(200n);
    expect(again!.warnings).toContain("dialog_resolved_via_owner_chain");
    expect(mockLogResolve).not.toHaveBeenCalled();
  });

  it("deferLog hands the event to the caller instead of writing it", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 200n, title: "名前を付けて保存",    className: "#32770",  ownerHwnd: 100n, isMinimized: false },
    ]);
    let held: (() => void) | undefined;
    const r = await resolveWindowTarget({ windowTitle: "名前を付けて保存" }, {
      deferLog: (emit) => { held = emit; },
    });
    expect(r!.hwnd).toBe(200n);
    expect(mockLogResolve).not.toHaveBeenCalled();
    held!();
    expect(mockLogResolve).toHaveBeenCalledTimes(1);
    expect(mockLogResolve.mock.calls[0][0]).toMatchObject({ resolver: "resolveWindowTargetDialog" });
  });

  it("a deferred event is written when the pin is taken and dropped when it is not", async () => {
    // Silencing the probe alone left a residue: on the Case 4 dialog rescue a
    // rich call still wrote one event more than a minimal one whenever the
    // desktop moved under the re-check (`target_changed`) or the handler bailed
    // before resolving (the IME fast-fail) — a resolution nothing dispatched on.
    // The event now travels with the pin and is written only where it acquires
    // a dispatch.
    const pinned = { title: "Ledger", hwnd: 0x2222n, warnings: [], className: "X" };

    const taken = vi.fn();
    await withPinnedResolution({ windowTitle: "Ledger" }, pinned, async () =>
      resolveWindowTarget({ windowTitle: "Ledger" }), taken);
    expect(taken).toHaveBeenCalledTimes(1);

    const untaken = vi.fn();
    await withPinnedResolution({ windowTitle: "Ledger" }, pinned, async () => "handler bailed", untaken);
    expect(untaken).not.toHaveBeenCalled();

    // Single use on the event as well as on the answer: a handler that resolves
    // twice must not double-count the one resolution it was handed.
    const once = vi.fn();
    await withPinnedResolution({ windowTitle: "Ledger" }, pinned, async () => {
      await resolveWindowTarget({ windowTitle: "Ledger" });
      await resolveWindowTarget({ windowTitle: "Ledger" });
    }, once);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("the wrapper's key matches the shape a handler actually asks with", async () => {
    // Load-bearing and, until this, untested: the wrapper builds `resolveArgs`
    // by OMITTING absent keys, and the handlers pass their optional params
    // through PRESENT-BUT-UNDEFINED. `resolutionKey` coalesces, so the two
    // agree — but that agreement holds last round's whole handoff up and rests
    // on four call sites staying in step.
    const pinned = { title: "Ledger", hwnd: 0x2222n, warnings: [], className: "X" };

    expect(await withPinnedResolution({ windowTitle: "Ledger" }, pinned, async () =>
      resolveWindowTarget({ hwnd: undefined, windowTitle: "Ledger" }))).toBe(pinned);

    expect(await withPinnedResolution({ hwnd: "8738", windowTitle: "Ledger" }, pinned, async () =>
      resolveWindowTarget({ hwnd: "8738", windowTitle: "Ledger" }))).toBe(pinned);

    // And a different question does not take it. `@active` is the reason the
    // key is not enough on its own, but it is still the first line.
    mockEnumWindowsInZOrder.mockReturnValue([]);
    expect(await withPinnedResolution({ windowTitle: "Ledger" }, pinned, async () =>
      resolveWindowTarget({ windowTitle: "Ledger II" }))).toBeNull();
  });

  it("consuming a handed-forward resolution adds no event of its own", async () => {
    // The handler's `resolveWindowTarget` takes the pin and returns before any
    // resolver runs, so the event belongs to the wrapper's re-check that put it
    // there. Counting it here as well would restore the double-count from the
    // other side.
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 200n, title: "名前を付けて保存",    className: "#32770",  ownerHwnd: 100n, isMinimized: false },
    ]);
    const pinned = { title: "名前を付けて保存", hwnd: 200n, warnings: [], className: "#32770" };
    mockLogResolve.mockReset();
    const seen = await withPinnedResolution(
      { windowTitle: "名前を付けて保存" },
      pinned,
      async () => resolveWindowTarget({ windowTitle: "名前を付けて保存" }),
    );
    expect(seen).toBe(pinned);
    expect(mockLogResolve).not.toHaveBeenCalled();
  });
});

// ─── dock-window warnings ────────────────────────────────────────────────────

describe("resolveWindowTarget — dock-window warnings", () => {
  it("emits HwndMatchesDockWindow warning when hwnd matches dock title", async () => {
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    mockGetWindowTitleW.mockReturnValue("Claude CLI");
    const result = await resolveWindowTarget({ hwnd: "7000" });
    expect(result!.warnings.some(w => w.includes("HwndMatchesDockWindow"))).toBe(true);
  });

  it("emits dock warning when @active resolves to dock window", async () => {
    process.env.DESKTOP_TOUCH_DOCK_TITLE = "Claude";
    mockGetForegroundHwnd.mockReturnValue(8000n);
    mockGetWindowTitleW.mockReturnValue("Claude CLI");
    const result = await resolveWindowTarget({ windowTitle: "@active" });
    expect(result!.warnings.some(w => w.toLowerCase().includes("cli host"))).toBe(true);
  });
});

// ─── H3: common dialog resolution ───────────────────────────────────────────

describe("resolveWindowTarget — common dialog (H3 case 4)", () => {
  it("falls back to #32770 dialog when plain title has no top-level match", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 100n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
      { hwnd: 200n, title: "名前を付けて保存",    className: "#32770",  ownerHwnd: 100n, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(200n);
    expect(result!.warnings).toContain("dialog_resolved_via_owner_chain");
  });

  it("falls back to owned popup when plain title has no top-level match and no #32770", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 300n, title: "Open File",  className: "DirectUIHWND", ownerHwnd: 100n, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "Open File" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(300n);
    expect(result!.warnings).toContain("dialog_resolved_via_owner_chain");
  });

  it("returns null (defers to caller) when a plain top-level window matches", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 400n, title: "名前を付けて保存 - App", className: "AppClass", ownerHwnd: null, isMinimized: false },
    ]);
    // Plain top-level match exists → existing behaviour: return null
    const result = await resolveWindowTarget({ windowTitle: "名前を付けて保存" });
    expect(result).toBeNull();
  });

  it("returns null when no match found (no top-level, no dialog)", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 500n, title: "Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    const result = await resolveWindowTarget({ windowTitle: "Does Not Exist" });
    expect(result).toBeNull();
  });
});

describe("resolveWindowTarget — disabled-owner popup prefer (H3 case 5)", () => {
  it("prefers active popup when owner is disabled and popup is owned by it", async () => {
    mockGetWindowTitleW.mockImplementation((h) =>
      h === 100n ? "Untitled - Notepad" : h === 200n ? "名前を付けて保存" : ""
    );
    mockIsWindowEnabled.mockImplementation((h) => h !== 100n);  // 100 = disabled
    mockGetLastActivePopup.mockReturnValue(200n);
    mockGetWindowOwner.mockReturnValue(100n);   // popup is owned by 100
    mockGetWindowClassName.mockReturnValue("SomeClass");

    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(200n);
    expect(result!.title).toBe("名前を付けて保存");
    expect(result!.warnings).toContain("parent_disabled_prefer_popup");
  });

  it("prefers active popup when popup is #32770 class (regardless of owner chain)", async () => {
    mockGetWindowTitleW.mockImplementation((h) =>
      h === 100n ? "Notepad" : h === 200n ? "Save" : ""
    );
    mockIsWindowEnabled.mockImplementation((h) => h !== 100n);
    mockGetLastActivePopup.mockReturnValue(200n);
    mockGetWindowOwner.mockReturnValue(null);   // no explicit owner
    mockGetWindowClassName.mockReturnValue("#32770");  // but it's a dialog class

    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(200n);
    expect(result!.warnings).toContain("parent_disabled_prefer_popup");
  });

  it("does NOT prefer popup when owner window is enabled", async () => {
    mockGetWindowTitleW.mockReturnValue("Notepad");
    mockIsWindowEnabled.mockReturnValue(true);  // owner is enabled → no modal
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(100n);
    expect(result!.warnings).not.toContain("parent_disabled_prefer_popup");
  });

  it("does NOT prefer popup when popup is same hwnd as owner (GetLastActivePopup self)", async () => {
    mockGetWindowTitleW.mockReturnValue("Notepad");
    mockIsWindowEnabled.mockReturnValue(false);
    mockGetLastActivePopup.mockReturnValue(100n);  // returns self = no popup
    const result = await resolveWindowTarget({ hwnd: "100" });
    expect(result!.hwnd).toBe(100n);
    expect(result!.warnings).not.toContain("parent_disabled_prefer_popup");
  });
});

// ─── R3 tool-exclusion refusal (Cases 1/2 bypass the enumerator) ─────────────

describe("ADR-036 — a resolution handed forward to the handler", () => {
  // `withRichNarration` resolves before the action so it knows what to snapshot,
  // and the handler resolves again afterwards. Between the two the desktop can
  // move — and `_post` takes a whole focus enumeration in there. The answer
  // travels beside the args, because putting the handle INTO the args would
  // make the handler believe the caller named one, which decides the guard
  // descriptor, the pinning rules and the wording of the refusal.
  //
  // Scoped to the invocation rather than the module: a call that never reaches
  // its resolver must not leave an answer where a concurrent one can take it.
  const pinned = { hwnd: 0xbeefn, title: "Pinned", warnings: [], className: "X" };

  it("is consumed by a matching call, once, inside the scope", async () => {
    await withPinnedResolution({ hwnd: "1", windowTitle: "whatever" }, pinned as never, async () => {
      await expect(resolveWindowTarget({ hwnd: "1", windowTitle: "whatever" })).resolves.toBe(pinned);
      // Single use: a second ask inside the same scope goes to the real
      // resolver, which refuses this fixture's non-window — the evidence that
      // the answer was not handed out twice.
      await expect(resolveWindowTarget({ hwnd: "1", windowTitle: "whatever" })).rejects.toThrow(/WindowNotFound/);
    });
  });

  it("is not eaten by a call asking a different question", async () => {
    await withPinnedResolution({ hwnd: "1", windowTitle: "whatever" }, pinned as never, async () => {
      await expect(resolveWindowTarget({ hwnd: "2", windowTitle: "whatever" })).rejects.toThrow(/WindowNotFound/);
      await expect(resolveWindowTarget({ hwnd: "1", windowTitle: "whatever" })).resolves.toBe(pinned);
    });
  });

  it("does not leak outside its own invocation", async () => {
    // The shape that made the module-global a P1: a call that exits before its
    // resolver, while something else asks the same question.
    await withPinnedResolution({ hwnd: "1" }, pinned as never, async () => {
      // …exits without resolving.
    });
    await expect(resolveWindowTarget({ hwnd: "1" })).rejects.toThrow(/WindowNotFound/);
  });

  it("does not leak into a concurrent invocation asking the same question", async () => {
    let sawPinned: unknown;
    await Promise.all([
      withPinnedResolution({ hwnd: "1" }, pinned as never, async () => {
        // Yield, so the other call runs while this pin is armed.
        await new Promise<void>((r) => setTimeout(r, 0));
      }),
      (async () => {
        await new Promise<void>((r) => setTimeout(r, 0));
        sawPinned = await resolveWindowTarget({ hwnd: "1" }).catch((e: Error) => e);
      })(),
    ]);
    expect(sawPinned).toBeInstanceOf(Error);
    expect(String(sawPinned)).toMatch(/WindowNotFound/);
  });
});

describe("resolveWindowTarget — R3 key-locker exclusion", () => {
  it("refuses an explicit hwnd that resolves to an excluded window (Case 1)", async () => {
    mockGetWindowTitleW.mockReturnValue("desktop-touch key locker");
    mockIsExcludedWindowHandle.mockReturnValue(true);
    await expect(resolveWindowTarget({ hwnd: "500" })).rejects.toThrow(/WindowExcluded/);
    // The refusal is checked against the RESOLVED hwnd (500n), after any popup preferral.
    expect(mockIsExcludedWindowHandle).toHaveBeenCalledWith(500n);
  });

  it("allows an explicit hwnd that is NOT excluded", async () => {
    mockGetWindowTitleW.mockReturnValue("Untitled - Notepad");
    mockIsExcludedWindowHandle.mockReturnValue(false);
    const result = await resolveWindowTarget({ hwnd: "500" });
    expect(result).not.toBeNull();
    expect(result!.hwnd).toBe(500n);
  });

  it("refuses @active when the foreground window is excluded (Case 2)", async () => {
    mockGetForegroundHwnd.mockReturnValue(600n);
    mockIsExcludedWindowHandle.mockReturnValue(true);
    await expect(resolveWindowTarget({ windowTitle: "@active" })).rejects.toThrow(/WindowExcluded/);
    expect(mockIsExcludedWindowHandle).toHaveBeenCalledWith(600n);
  });

  it("throws the typed WindowExcludedError (so normalizeTarget can single it out)", async () => {
    const { WindowExcludedError } = await import("../../src/engine/tool-exclusion.js");
    mockGetWindowTitleW.mockReturnValue("desktop-touch key locker");
    mockIsExcludedWindowHandle.mockReturnValue(true);
    await expect(resolveWindowTarget({ hwnd: "500" })).rejects.toBeInstanceOf(WindowExcludedError);
  });

  it("refuses a plain windowTitle that names an excluded window (Case 3 front door)", async () => {
    mockIsExcludedTitle.mockReturnValue(true);
    await expect(resolveWindowTarget({ windowTitle: "desktop-touch key locker" }))
      .rejects.toThrow(/WindowExcluded/);
    expect(mockIsExcludedTitle).toHaveBeenCalledWith("desktop-touch key locker");
  });

  it("does NOT refuse a plain windowTitle that names a normal window", async () => {
    mockIsExcludedTitle.mockReturnValue(false);
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 400n, title: "Untitled - Notepad", className: "Notepad", ownerHwnd: null, isMinimized: false },
    ]);
    // Plain top-level match → existing pass-through (null), never refused.
    const result = await resolveWindowTarget({ windowTitle: "Notepad" });
    expect(result).toBeNull();
  });
});

// ─── return shape invariants ──────────────────────────────────────────────────

describe("resolveWindowTarget — return shape", () => {
  it("always returns a warnings array (not undefined)", async () => {
    mockGetWindowTitleW.mockReturnValue("Paint");
    const result = await resolveWindowTarget({ hwnd: "1111" });
    expect(Array.isArray(result!.warnings)).toBe(true);
  });

  it("hwnd on resolved value is BigInt (not string or number)", async () => {
    mockGetWindowTitleW.mockReturnValue("Calc");
    const result = await resolveWindowTarget({ hwnd: "9876" });
    expect(typeof result!.hwnd).toBe("bigint");
  });
});
