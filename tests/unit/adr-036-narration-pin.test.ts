/**
 * adr-036-narration-pin.test.ts — ADR-036: rich narration and the shared title.
 *
 * `withRichNarration` wraps the three write tools whose `ambiguous_target`
 * refusal this ADR lifts. Its before/after snapshots found their window BY
 * TITLE (`snapElements` → `getUiElements`), so a call that named a handle used
 * to be stopped by the guard before the wrapper could report on the wrong
 * window — and lifting the refusal made that reachable. Since internal #211 B2
 * they read the resolved window by its handle; `keyboard` still delivers by
 * title, which is why the shared-title checks stay.
 *
 * Every case here is paired with the same fixture minus the handle, so no
 * assertion can pass for a reason other than the handle being what changed it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const LIVE = "0x2222";

/** Mutable so one file can hold "two windows", "one window" and "cannot tell". */
let windows: Array<{ hwnd: bigint; title: string }> = [];
let enumThrows = false;
/** Windows on the screen that `enumWindowsInZOrder` does not list (untitled, tiny). */
let shownOffList: bigint[] = [];
/** The handle could not be asked (no native binding). */
let shownUnknown = false;
/** Listed by the enumeration but cloaked by DWM (another virtual desktop). */
let cloaked: bigint[] = [];

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => {
      if (enumThrows) throw new Error("EnumWindows failed");
      return windows.map((w, i) => ({
        hwnd: w.hwnd, title: w.title, zOrder: i, isActive: i === 0,
        region: { x: 0, y: 0, width: 800, height: 600 },
        isMinimized: false, isMaximized: false,
        className: "Chrome_WidgetWin_1", ownerHwnd: null,
      }));
    }),
    // internal #211 B2 — the handle is asked what the enumeration cannot say: a window it drops
    // (untitled, under 50 px) that is still shown.
    // Shown: listed and not cloaked, or on the off-list (untitled, tiny).
    windowIsShown: vi.fn((h: bigint) => (shownUnknown ? undefined : (windows.some((w) => w.hwnd === h) && !cloaked.includes(h)) || shownOffList.includes(h))),
  };
});

/**
 * The handler's own resolver, which the wrapper now goes through. Production
 * semantics that matter here: a handle resolves to that window's live title; a
 * handle with no window throws; a window blocked by its own modal resolves to
 * the POPUP (`preferActivePopupIfBlocked`); a plain title returns null, because
 * the handler then uses the argument as-is.
 */
let popupFor: Record<string, { hwnd: bigint; title: string }> = {};

const { mockPin, mockDeferredEmit } = vi.hoisted(() => ({
  mockPin: vi.fn(),
  /** Stands in for the ADR-035 event a real resolution would hand back. */
  mockDeferredEmit: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    withPinnedResolution: (<T>(p: unknown, value: unknown, fn: () => Promise<T>, emitLog?: () => void) => {
      mockPin(p, value, emitLog);
      return fn();
    }),
    resolveWindowTarget: vi.fn(async (
      p: { hwnd?: string; windowTitle?: string },
      opts?: { logAs?: "off"; deferLog?: (emit: () => void) => void },
    ) => {
      // Production hands the event back through `deferLog` rather than writing
      // it; modelled here so the wrapper's handling of it is observable.
      opts?.deferLog?.(() => mockDeferredEmit());
      // Case 2 — `@active` resolves to the foreground window (first in z-order
      // here), which is what makes it a self-resolved handle rather than a
      // plain title.
      if (p.hwnd === undefined && p.windowTitle === "@active") {
        const fg = windows[0];
        if (!fg) return null;
        return { hwnd: fg.hwnd, title: fg.title, warnings: [], className: "X" };
      }
      if (p.hwnd === undefined) return null;
      const popup = popupFor[p.hwnd];
      if (popup) return { hwnd: popup.hwnd, title: popup.title, warnings: [], className: "#32770" };
      const w = windows.find((x) => x.hwnd === BigInt(p.hwnd!));
      if (!w) throw new Error(`WindowNotFound: no visible window with hwnd "${p.hwnd}"`);
      return { hwnd: w.hwnd, title: w.title, warnings: [], className: "Chrome_WidgetWin_1" };
    }),
  };
});

const { mockGetUiElements } = vi.hoisted(() => ({
  mockGetUiElements: vi.fn(async () => ({
    ok: true,
    elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
  })),
}));

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  // A read scoped to a handle that no longer names a window fails, as the real one does
  // ("Window not found by hwnd"); the call is still counted.
  return {
    ...actual,
    getUiElements: async (...a: unknown[]) => {
      const r = await mockGetUiElements(...(a as []));
      const pinned = (a[4] as { pinnedHwnd?: bigint } | undefined)?.pinnedHwnd;
      if (pinned !== undefined && !windows.some((w) => w.hwnd === pinned) && !shownOffList.includes(pinned)) throw new Error(`Window not found by hwnd: ${pinned}`);
      return r;
    },
  };
});

// The post-state layer is not what this file is about; passthrough keeps the
// assertions on the narration rule rather than on focus snapshots. The third argument IS
// recorded, because it is this wrapper's declaration of which argument names a window and the
// post layer's answer to "did the call name the window focus ended in?" is built from it.
const { mockPostKeys } = vi.hoisted(() => ({ mockPostKeys: vi.fn() }));
vi.mock("../../src/tools/_post.js", () => ({
  withPostState: (
    _name: string,
    handler: (a: Record<string, unknown>) => Promise<unknown>,
    keys?: { windowTitleKey?: string; hwndKey?: string },
  ) => {
    mockPostKeys(keys);
    return handler;
  },
}));

const { withRichNarration, UIA_WRITE_NARRATION, narrateParam } = await import("../../src/tools/_narration.js");

/** A handler that succeeds and carries the `post` object spliceRich writes into. */
const innerHandler = vi.fn(async () => ({
  content: [{ type: "text" as const, text: JSON.stringify({ ok: true, post: {} }) }],
}));

const narrated = withRichNarration("click_element", innerHandler as never, UIA_WRITE_NARRATION);

function richOf(result: { content?: Array<{ type: string; text: string }> }): Record<string, any> {
  const text = result.content?.[0]?.text;
  return text ? (JSON.parse(text).post?.rich ?? {}) : {};
}

beforeEach(() => {
  mockGetUiElements.mockClear();
  innerHandler.mockClear();
  enumThrows = false;
  shownOffList = [];
  shownUnknown = false;
  cloaked = [];
  mockPin.mockClear();
  mockDeferredEmit.mockClear();
  popupFor = {};
  windows = [
    { hwnd: 0x1111n, title: SHARED_TITLE },
    { hwnd: 0x2222n, title: SHARED_TITLE },
  ];
});

/**
 * Several cases here swap `resolveWindowTarget`'s implementation to model a
 * desktop that moves mid-call, and restored it inline at the end of the test —
 * which is skipped if the awaited call throws, leaking the stub into every later
 * test in the file. Restored here instead, where nothing can skip it.
 */
let pristineResolver: ((p: never) => Promise<unknown>) | undefined;
beforeEach(async () => {
  const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
  pristineResolver ??= resolver.getMockImplementation() as never;
  resolver.mockImplementation(pristineResolver as never);
});
afterEach(async () => {
  const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
  if (pristineResolver) resolver.mockImplementation(pristineResolver as never);
});

describe("ADR-036 — rich narration does not describe a window it cannot address", () => {
  it("withholds the diff when a handle was named and the title is shared", async () => {
    const r = await narrated({
      windowTitle: SHARED_TITLE, hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    expect(richOf(r).diffSource).toBe("none");
    // Not merely relabelled: the snapshots that would have described the
    // sibling were never taken.
    expect(mockGetUiElements).not.toHaveBeenCalled();
    // And the action itself still ran — this withholds a report, not a write.
    expect(innerHandler).toHaveBeenCalled();
  });

  it("narrates the same call when it names no handle", async () => {
    // The pairing that makes the case above about the handle: identical two-window
    // fixture, no `hwnd`, and the diff comes back as usual.
    const r = await narrated({
      windowTitle: SHARED_TITLE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
    expect(mockGetUiElements).toHaveBeenCalledTimes(2);   // before + after
  });

  it("narrates a handle-named call whose title is unique", async () => {
    windows = [{ hwnd: 0x2222n, title: SHARED_TITLE }];
    const r = await narrated({
      windowTitle: SHARED_TITLE, hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
    expect(mockGetUiElements).toHaveBeenCalledTimes(2);
  });

  it("withholds the diff when the UIA read came back cut short", async () => {
    // A tree the PowerShell walk stopped early is a PREFIX, and this wrapper diffs two of them.
    // Two prefixes that end in different places read as elements appearing and disappearing
    // that never moved — a change the user never made, described confidently. Before the walk
    // measured its own start, a 4 s deadline left it 1 s and this was routine (2ゲート目の指摘).
    windows = [{ hwnd: 0x2222n, title: SHARED_TITLE }];
    // Once: the before-snapshot is enough to withhold, so the after-snapshot is never taken —
    // and a persistent override would leak into every later cell in this file.
    mockGetUiElements.mockResolvedValueOnce({
      ok: true, truncated: true,
      elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
    } as never);
    const r = await narrated({
      windowTitle: SHARED_TITLE, hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    // A walk that ran out of time is a slow window, not a large one: `timeout`, not the
    // `tree_truncated` a filled cap gets (internal #211 B, gate 2).
    expect(richOf(r).diffDegraded).toBe("timeout");
    expect(richOf(r).diffSource).toBe("none");
    // The write still happened; what is withheld is the description of it.
    expect(innerHandler).toHaveBeenCalled();
  });

  it("reads at discover's caps by element count, the PowerShell road at its own (internal #211 B)", async () => {
    // Calculator's display sits at depth 4-5 and Explorer's status bar at 5 (win2 S3/S10), below
    // the old depth 3 / 80 read.
    await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    const [, depth, max, , options] = mockGetUiElements.mock.calls[0] as unknown as [string, number, number, number, Record<string, unknown>];
    expect([depth, max]).toEqual([64, 500]);
    expect(options).toMatchObject({ fetchValues: true, fallbackLimits: { maxDepth: 4, maxElements: 80 } });
  });

  it("withholds the diff when a native read filled its 500 cap: it is a prefix too (internal #211 B)", async () => {
    mockGetUiElements.mockResolvedValueOnce({
      ok: true, elementCount: 500, via: "native",
      elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
    } as never);
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("tree_truncated");
    expect(innerHandler).toHaveBeenCalled();
  });

  it("does not withhold one element short of the cap", async () => {
    const read = { ok: true, elementCount: 499, via: "native", elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] };
    mockGetUiElements.mockResolvedValueOnce(read as never).mockResolvedValueOnce(read as never);
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
  });

  it("measures a PowerShell read against the PowerShell road's 80", async () => {
    mockGetUiElements.mockResolvedValueOnce({
      ok: true, elementCount: 80, via: "powershell",
      elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
    } as never);
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("tree_truncated");
  });

  it("withholds a diff across the two roads: they read to different caps (gate 2)", async () => {
    mockGetUiElements
      .mockResolvedValueOnce({ ok: true, elementCount: 1, via: "native", elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never)
      .mockResolvedValueOnce({ ok: true, elementCount: 1, via: "powershell", elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("timeout");
    expect(richOf(r).diffSource).toBe("none");
  });

  it("withholds when the AFTER read filled its cap", async () => {
    mockGetUiElements
      .mockResolvedValueOnce({ ok: true, elementCount: 1, via: "native", elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never)
      .mockResolvedValueOnce({ ok: true, elementCount: 500, via: "native", elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("tree_truncated");
    expect(mockGetUiElements).toHaveBeenCalledTimes(2);
  });

  it("withholds when the enumeration cannot say whether the title is shared", async () => {
    // Documented trade: the caller named a handle, so a report that cannot be
    // shown to describe that window is withheld rather than guessed at.
    enumThrows = true;
    const r = await narrated({
      windowTitle: SHARED_TITLE, hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    expect(mockGetUiElements).not.toHaveBeenCalled();
  });

  it("narrates the window the HANDLE names, not the title the caller typed", async () => {
    // The schemas say hwnd takes precedence, so the handler ignores this title
    // entirely. Both windows here are unique, so the shared-title check sees
    // nothing wrong — and the snapshots would have described a window the
    // action never touched, with nothing in the report to say so.
    windows = [
      { hwnd: 0x1111n, title: "Notes" },
      { hwnd: 0x2222n, title: "Ledger" },
    ];
    const r = await narrated({
      windowTitle: "Notes", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(mockGetUiElements).toHaveBeenCalledTimes(2);
    for (const call of mockGetUiElements.mock.calls) {
      expect(call[0]).toBe("Ledger");
    }
  });

  it("narrates the caller's title when no handle was named", async () => {
    // The pairing: same two unique windows, no `hwnd`, and the argument is the
    // right thing to narrate because it is also what the handler will use.
    windows = [
      { hwnd: 0x1111n, title: "Notes" },
      { hwnd: 0x2222n, title: "Ledger" },
    ];
    const r = await narrated({ windowTitle: "Notes", name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    for (const call of mockGetUiElements.mock.calls) {
      expect(call[0]).toBe("Notes");
    }
  });

  it("withholds when the handle is not in the enumeration — closed, or untitled", async () => {
    // `enumWindowsInZOrder` drops untitled windows, so those two cases are one
    // from here. Either way there is no window this layer can name, and the
    // caller's title is not a fallback: it names a different window.
    windows = [{ hwnd: 0x1111n, title: "Notes" }];
    const r = await narrated({
      windowTitle: "Notes", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("no_target");
    expect(mockGetUiElements).not.toHaveBeenCalled();
    expect(innerHandler).toHaveBeenCalled();
  });

  it("narrates the POPUP when the handler is redirected to it, not the window that was named", async () => {
    // `resolveWindowTarget` prefers the active popup when the named window is
    // blocked by its own modal — `click_element(hwnd=<Notepad>)` with Save As
    // open acts on the dialog. Resolving the handle by itself narrated the
    // disabled parent and returned an empty diff for a click that changed
    // something.
    windows = [
      { hwnd: 0x2222n, title: "Untitled - Notepad" },
      { hwnd: 0x4444n, title: "Save As" },
    ];
    popupFor[LIVE] = { hwnd: 0x4444n, title: "Save As" };
    const r = await narrated({
      windowTitle: "Untitled - Notepad", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    for (const call of mockGetUiElements.mock.calls) {
      expect(call[0]).toBe("Save As");
    }
  });

  it("withholds when the handle cannot be resolved at all", async () => {
    // A handle the resolver rejects (not a valid integer, or no window): there
    // is nothing to describe, and the caller's title names a different window.
    windows = [{ hwnd: 0x1111n, title: "Notes" }];
    const r = await narrated({
      windowTitle: "Notes", hwnd: "not-a-number", name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("no_target");
    expect(mockGetUiElements).not.toHaveBeenCalled();
    expect(innerHandler).toHaveBeenCalled();
  });

  it("the SHARED-TITLE check reads the resolved title too, not the argument", async () => {
    // Both halves have to move together. With the check on the argument, a
    // handle on a unique window plus a title matching three windows withheld a
    // diff that was perfectly safe — and the mirror case emitted one that was not.
    windows = [
      { hwnd: 0x2222n, title: "Ledger" },
      { hwnd: 0x1111n, title: "Chrome" },
      { hwnd: 0x3333n, title: "Chrome" },
    ];
    const r = await narrated({
      windowTitle: "Chrome", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    for (const call of mockGetUiElements.mock.calls) {
      expect(call[0]).toBe("Ledger");
    }
  });

  it("withholds when the window moves between the snapshot and the action", async () => {
    // The handler resolves again after this wrapper does, and the desktop can
    // move in between — a modal closing is the ordinary case. Then the
    // snapshots describe one window and the action lands on another: the defect
    // this block exists to remove, arriving through the back door.
    windows = [
      { hwnd: 0x2222n, title: "Untitled - Notepad" },
      { hwnd: 0x4444n, title: "Save As" },
    ];
    popupFor[LIVE] = { hwnd: 0x4444n, title: "Save As" };
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    let calls = 0;
    resolver.mockImplementation(async (p: never) => {
      calls += 1;
      // Second call — after the snapshot — the modal has closed.
      if (calls >= 2) return { hwnd: 0x2222n, title: "Untitled - Notepad", warnings: [], className: "Notepad" } as never;
      return first(p);
    });
    const r = await narrated({
      windowTitle: "Untitled - Notepad", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("target_changed");
    // Not `window_closed`: neither window closed, and a caller reading that
    // would give up on a window that is still there.
    expect(richOf(r).diffDegraded).not.toBe("window_closed");
    // The action still ran: this withholds a report, not a write.
    expect(innerHandler).toHaveBeenCalled();
  });

  it("withholds under @active when the resolved title is shared", async () => {
    // Consuming the pin fixes the handler's `resolveWindowTarget` and not the
    // whole of targeting: `keyboard` takes its `explicitHwnd` from the PUBLIC
    // argument, so with `@active` its focus and delivery stay title-based. With
    // the title shared the keys can land on a sibling while these snapshots
    // describe the window that was in front a moment ago.
    windows = [
      { hwnd: 0x1111n, title: "PKDRIFT" },
      { hwnd: 0x2222n, title: "PKDRIFT" },
    ];
    const r0 = await narrated({ windowTitle: "@active", name: "OK", narrate: "rich" } as never);
    expect(richOf(r0).diffDegraded).toBe("ambiguous_title");
    expect(mockGetUiElements).not.toHaveBeenCalled();
  });

  it("catches a flip under @active when the title is unique", async () => {
    windows = [
      { hwnd: 0x1111n, title: "PKDRIFT-A" },
      { hwnd: 0x2222n, title: "PKDRIFT-B" },
    ];
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    let calls = 0;
    resolver.mockImplementation(async (p: never) => {
      calls += 1;
      // The foreground moves to the other window between the snapshot and the action.
      return calls >= 2
        ? { hwnd: 0x1111n, title: "PKDRIFT-A", warnings: [], className: "X" } as never
        : { hwnd: 0x2222n, title: "PKDRIFT-B", warnings: [], className: "X" } as never;
    });
    const r = await narrated({ windowTitle: "@active", name: "OK", narrate: "rich" } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("target_changed");
  });

  it("hands the checked resolution to the handler instead of leaving it to resolve again", async () => {
    // Between this wrapper's resolution and the handler's, `_post` takes a full
    // focus enumeration — so "they will agree, it is only microseconds" was not
    // true. The answer travels beside the args, and is dropped afterwards
    // whatever happened, so it cannot be inherited by a later call.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(mockPin).toHaveBeenCalledTimes(1);
    expect(mockPin.mock.calls[0]![1]).toMatchObject({ hwnd: 0x2222n, title: "Ledger" });
  });

  it("drops the handed-forward resolution even when the diff is withheld", async () => {
    windows = [{ hwnd: 0x1111n, title: "Notes" }];
    await narrated({ windowTitle: "Notes", hwnd: "not-a-number", name: "OK", narrate: "rich" } as never);
    expect(mockPin).not.toHaveBeenCalled();
  });

  it("counts the string the SNAPSHOTS search with, not the window's live title", async () => {
    // The two are the same until the window is renamed between the wrapper's
    // two resolutions. Then `again.title` is what the window is called now and
    // `windowTitle` is what both `snapElements` calls will search for — and only
    // the second one can say whether those searches are ambiguous. Counting the
    // live title answers a question nobody asked, and a mutation to it survived
    // the suite until this was measured.
    windows = [{ hwnd: 0x2222n, title: "Alpha" }];
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    let calls = 0;
    resolver.mockImplementation(async () => {
      calls += 1;
      // Same HANDLE both times — so this is not `target_changed` — renamed in
      // between, which is what pulls the two strings apart.
      return calls >= 2
        ? { hwnd: 0x2222n, title: "Beta", warnings: [], className: "X" } as never
        : { hwnd: 0x2222n, title: "Alpha", warnings: [], className: "X" } as never;
    });
    // Two more windows called "Alpha" arrive while the before-snapshot is read,
    // so the argument's title is shared and the live one is not.
    mockGetUiElements.mockImplementationOnce(async () => {
      windows = [
        { hwnd: 0x2222n, title: "Beta" },
        { hwnd: 0x9999n, title: "Alpha" },
        { hwnd: 0xAAAAn, title: "Alpha" },
      ];
      return { ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never;
    });
    // …and they close again while the action runs, so the count AFTER the action
    // sees nothing wrong. Without that the third count masks this one and the
    // mutation survives — which it did, until the fixture was built to separate
    // them. The before-snapshot was taken while the title was ambiguous, so it
    // may describe the wrong window whatever the desktop looks like afterwards.
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x2222n, title: "Beta" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Alpha", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
  });

  it("says in the shipped description that the diff can be withheld, and in which cases", () => {
    // That description is what decides whether the model takes a verification
    // screenshot instead. It promised the diff removes the need for one; this
    // ADR made cases where it returns nothing, so the promise has to carry the
    // exception with it. Shipped wording drifting from shipped behaviour is the
    // failure this repo has had before — and the first version of this test
    // asserted only `diffDegraded` and `hwnd`, so it survived TWO rounds of
    // behaviour change underneath it: `@active` (no handle named at all) and a
    // brand-new `target_changed` value that appeared in no shipped text.
    // Naming the cases is what makes it a drift detector rather than a spell
    // check.
    const said = narrateParam.description ?? "";
    expect(said).toContain("diffDegraded");
    expect(said).toContain("ambiguous_title");
    expect(said).toContain("target_changed");
    expect(said).toContain("fix_target_unknown");
    expect(said).toContain("@active");
    // …and WHERE each guarantee holds. This is one string registered on all
    // nineteen narrated tools, and it promised a withhold "whether you named the
    // hwnd or the server did" — which three of them implement. `mouse_click`,
    // `mouse_drag` and `scroll` take an `hwnd` and narrate by title anyway, so a
    // flat promise sent exactly those callers away without a screenshot.
    // All three, with the availability said rather than the name hidden. The
    // previous version dropped `set_element_value` on the grounds of "this
    // ADR's naming audit" — which does not exist: there is no lint, no test and
    // no doc, and `desktop_act`'s own parameter description names the tool on
    // the shipping default. Hiding it also made `set_element_value`'s OWN
    // `narrate` text list two other tools and omit itself while withholding
    // identically. A comment is not a check, and this one was not even a rule.
    expect(said).toMatch(/click_element and keyboard \(and set_element_value where the server registers it\)/);
    // Named, because the string ships on SIX registered tools and not the
    // nineteen `withRichNarration` wraps — and two of the six (browser_click,
    // browser_navigate) have neither `windowTitle` nor `hwnd`, so a sentence
    // telling "other tools" to check theirs was addressed to arguments they do
    // not have. The tools it is actually about are the two that take a handle
    // and snapshot by title anyway.
    expect(said).toMatch(/mouse_click and mouse_drag accept an hwnd/);
    expect(said).toMatch(/verify those with a screenshot/);
    expect(said).not.toMatch(/Other tools resolve nothing here/);
    // "On any tool here, retrying with a fixId withholds it" was false for
    // `browser_click`, which carries this same string, accepts a `fixId`, and
    // keeps its diff — its wrapper has no `windowTitleKey`, so there is nothing
    // to withhold and its CDP tab diff does not depend on a title. A
    // model reading the flat claim would have thrown away a valid verification.
    expect(said).not.toMatch(/On any tool here/);
    expect(said).toMatch(/browser tools\s+keep their diff on a fixId retry/);
  });

  it("leaves title-only tools alone when the enumeration fails", async () => {
    // `hwndKey` is what arms the check: tools wrapped without it (mouse, scroll,
    // window_dock …) must not lose their narration because of this ADR.
    const titleOnly = withRichNarration("mouse_click", innerHandler as never, { windowTitleKey: "windowTitle" });
    enumThrows = true;
    const r = await titleOnly({ windowTitle: SHARED_TITLE, narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("does not resolve — or pin — for a tool that declares no handle key", async () => {
    // The blast radius nobody had looked at. `withRichNarration` wraps nineteen
    // tools; only three declare `hwndKey`. Resolving on the TITLE argument alone
    // reached `mouse_click`, `scroll`, `focus_window` and the browser set, whose
    // schemas do take `hwnd` while this wrapper reads it through `hwndKey` and
    // therefore cannot see it — so the wrapper narrated the window the title
    // resolved to while the handler acted on the caller's handle, with no
    // degrade marker. `@active` is the sharpest form: it resolves to the
    // FOREGROUND, which is a different window from the one a handle names.
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const titleOnly = withRichNarration("mouse_click", innerHandler as never, { windowTitleKey: "windowTitle" });
    windows = [
      { hwnd: 0x1111n, title: "Foreground app" },
      { hwnd: 0x2222n, title: "The clicked one" },
    ];
    resolver.mockClear();
    const r = await titleOnly({ windowTitle: "@active", hwnd: LIVE, narrate: "rich" } as never);
    expect(resolver).not.toHaveBeenCalled();
    expect(mockPin).not.toHaveBeenCalled();
    // The snapshots stay on the argument, which is what this tool did before
    // this ADR and what it will keep doing until the handle rules are extended
    // to it deliberately.
    expect(mockGetUiElements.mock.calls.map((c) => c[0])).toEqual(["@active", "@active"]);
    expect(richOf(r).diffDegraded).toBeUndefined();
  });

  it("still resolves for the same fixture on a tool that DOES declare one", async () => {
    // The pairing: identical arguments, `UIA_WRITE_NARRATION` instead. Without
    // it the test above passes for any wrapper that resolves nothing at all.
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    windows = [
      { hwnd: 0x1111n, title: "Foreground app" },
      { hwnd: 0x2222n, title: "The clicked one" },
    ];
    resolver.mockClear();
    await narrated({ windowTitle: "@active", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(resolver).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledTimes(1);
  });

  it("defers the re-check's ADR-035 event to the pin instead of writing it", async () => {
    // Silencing the probe was half the fix. The re-check earns an event only if
    // it becomes the resolution the handler acts on, and that is decided AFTER
    // it runs — so it hands the event over and `withPinnedResolution` carries it
    // to the moment the handler takes the pin.
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    resolver.mockClear();
    await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(resolver.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The probe is silenced outright; the re-check hands its event over.
    expect(resolver.mock.calls[0]![1]).toEqual({ logAs: "off" });
    expect(typeof (resolver.mock.calls[1]![1] as { deferLog?: unknown } | undefined)?.deferLog)
      .toBe("function");
    // …and the event reaches `withPinnedResolution`, the only place it can be
    // written or dropped. Nothing has written it yet.
    expect(mockPin.mock.calls[0]![2]).toBeTypeOf("function");
    expect(mockDeferredEmit).not.toHaveBeenCalled();
  });

  it("drops that event when the target moved — nothing was dispatched on it", async () => {
    // The path the first version of this fix got wrong: on `target_changed` the
    // re-check's answer is thrown away, the handler resolves for itself, and a
    // rich call wrote one event more than a minimal one. Not pinning is what
    // drops it.
    windows = [
      { hwnd: 0x2222n, title: "Untitled - Notepad" },
      { hwnd: 0x4444n, title: "Save As" },
    ];
    popupFor[LIVE] = { hwnd: 0x4444n, title: "Save As" };
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    let calls = 0;
    resolver.mockImplementation(async (p: never) => {
      calls += 1;
      if (calls >= 2) return { hwnd: 0x2222n, title: "Untitled - Notepad", warnings: [], className: "Notepad" } as never;
      return first(p);
    });
    const r = await narrated({
      windowTitle: "Untitled - Notepad", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("target_changed");
    expect(mockPin).not.toHaveBeenCalled();
  });

  it("catches a flip to a window that took the same title after the count", async () => {
    // The comment here used to call comparing titles "equivalent today", on the
    // grounds that the ambiguity check one screen up has already withheld any
    // shared title. It counted windows BEFORE the UIA snapshot; this flip
    // happens after it. Measured both ways: on the handle the diff is withheld,
    // on the title it is emitted AND the stale resolution is handed forward,
    // forcing the action onto the window that moved.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    let calls = 0;
    resolver.mockImplementation(async (p: never) => {
      calls += 1;
      return calls >= 2
        ? { hwnd: 0x9999n, title: "Ledger", warnings: [], className: "X" } as never
        : first(p);
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("target_changed");
    expect(mockPin).not.toHaveBeenCalled();
  });

  it("withholds under fixId even when the argument names exactly one window", async () => {
    // A shared argument title was never what is wrong with `fixId`. The handler
    // acts on the STORED FIX's `windowTitle`, and a fix exists because the guard
    // found a narrower window than the argument named — so the two normally
    // differ, and the argument being unique makes the snapshots MORE confident
    // about the wrong window rather than less.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await narrated({
      windowTitle: "Ledger", fixId: "fix-1", name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("fix_target_unknown");
    expect(richOf(r).diffSource).toBe("none");
    // The snapshots that would have described the argument's window were never
    // taken, and the action still ran.
    expect(mockGetUiElements).not.toHaveBeenCalled();
    expect(innerHandler).toHaveBeenCalled();
  });

  it("narrates the same call without the fixId", async () => {
    // The pairing that makes the case above about `fixId` and not about the
    // fixture.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await narrated({
      windowTitle: "Ledger", name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("an EMPTY fixId is not a fixId — the handlers read it that way and so does this", async () => {
    // Both schemas accept `fixId: ""`, and the handlers test `if (fixId)`. A
    // wrapper testing for PRESENCE withheld a correct diff from an ordinary
    // call and told it `fix_target_unknown`, which was not true of it. A
    // wrapper and its handler disagreeing about what one argument means is the
    // shape this ADR is about.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, fixId: "", name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("withholds when a sibling takes the title DURING the snapshot", async () => {
    // The ambiguity gate ran once, before `snapElements` — an await long enough
    // for another window to open. The handle re-check cannot see that: the
    // resolution did not move, the title became shared. And a shared title is
    // exactly what `keyboard` cannot survive, because its `explicitHwnd` comes
    // from the public argument, so its focus and delivery stay title-based
    // while these snapshots read whichever window the title matched.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    mockGetUiElements.mockImplementationOnce(async () => {
      windows = [
        { hwnd: 0x2222n, title: "Ledger" },
        { hwnd: 0x7777n, title: "Ledger" },
      ];
      return { ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never;
    });
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    expect(mockPin).not.toHaveBeenCalled();
    expect(innerHandler).toHaveBeenCalled();
  });

  it("withholds when the ACTION itself creates the sibling", async () => {
    // Both earlier counts run before the action, so neither can see a window the
    // action opened — a state-changing shortcut doing exactly that is the
    // ordinary case. The reads follow the handle since internal #211 B2, but
    // `keyboard` delivers by title, so the rest of the keys can go to the new
    // window while the diff describes the one read (gate 2 on B2 put this back).
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [
        { hwnd: 0x2222n, title: "Ledger" },
        { hwnd: 0x8888n, title: "Ledger" },
      ];
      // The same shape the default handler returns: `spliceRich` writes into
      // `post`, and a result without one silently keeps no rich block at all.
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    // Asked before the after-read now: nothing the read could return changes the
    // answer, so it is not paid for.
    expect(mockGetUiElements).toHaveBeenCalledTimes(1);
  });

  it("narrates the same shape when nothing was pinned: a plain-title call is not delivered by a pin", async () => {
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x2222n, title: "Ledger" }, { hwnd: 0x8888n, title: "Ledger" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    mockGetUiElements.mockResolvedValue({ ok: true, windowHwnd: "8738", via: "native", elementCount: 1, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    try {
      const r = await narrated({ windowTitle: "Ledger", name: "OK", narrate: "rich" } as never);
      expect(richOf(r).diffSource).toBe("uia");
    } finally {
      mockGetUiElements.mockReset();
      mockGetUiElements.mockImplementation(async () => ({ ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] }) as never);
    }
  });

  it("says window_closed when the window a read was pinned to is hidden, not only destroyed (gate 2 on B2)", async () => {
    // A dialog that hides on OK is still a window, and would still read by its handle.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [];   // the enumeration lists visible windows only
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("window_closed");
    expect(mockGetUiElements).toHaveBeenCalledTimes(1);
  });

  it("says ambiguous_title when the window closed and two others wear its title", async () => {
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x3333n, title: "Ledger" }, { hwnd: 0x4444n, title: "Ledger" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    mockGetUiElements.mockResolvedValue({ ok: true, windowHwnd: "8738", via: "native", elementCount: 1, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    windows = [{ hwnd: 8738n, title: "Ledger" }];
    try {
      const r = await narrated({ windowTitle: "Ledger", name: "OK", narrate: "rich" } as never);
      expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    } finally {
      mockGetUiElements.mockReset();
      mockGetUiElements.mockImplementation(async () => ({ ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] }) as never);
    }
  });

  it("narrates a window the enumeration drops but the handle says is shown (win2 X2/X3 on #752)", async () => {
    // The action cleared its window's title, or shrank it to 40x40: `enumWindowsInZOrder` skips
    // untitled and tiny windows, and the window is still on the screen.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [];
      shownOffList = [0x2222n];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("says window_closed for a window moved to another virtual desktop, though still listed (PR codex P2)", async () => {
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      cloaked = [0x2222n];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("window_closed");
  });

  it("drops the window's cached tree even when the before-read was cut (PR codex P2)", async () => {
    const { updateUiaCache, getCachedUia } = await import("../../src/engine/layer-buffer.js");
    updateUiaCache(0x2222n, "{\"elements\":[\"from discover, before the action\"]}");
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    mockGetUiElements.mockResolvedValueOnce({ ok: true, truncated: true, elements: [] } as never);
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("timeout");
    expect(getCachedUia(0x2222n)).toBeNull();
  });

  it("drops the cached tree of the window a plain-title before-read reported", async () => {
    const { updateUiaCache, getCachedUia } = await import("../../src/engine/layer-buffer.js");
    updateUiaCache(8738n, "{\"elements\":[\"before the action\"]}");
    windows = [{ hwnd: 8738n, title: "Ledger" }];
    mockGetUiElements.mockResolvedValue({ ok: true, windowHwnd: "8738", via: "native", elementCount: 1, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    try {
      await narrated({ windowTitle: "Ledger", name: "OK", narrate: "rich" } as never);
      expect(getCachedUia(8738n)).toBeNull();
    } finally {
      mockGetUiElements.mockReset();
      mockGetUiElements.mockImplementation(async () => ({ ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] }) as never);
    }
  });

  it("drops the cached tree when a plain-title before-read was cut, by the handle it reported (PR codex P2)", async () => {
    const { updateUiaCache, getCachedUia } = await import("../../src/engine/layer-buffer.js");
    updateUiaCache(8738n, "{\"elements\":[\"from discover, before the action\"]}");
    windows = [{ hwnd: 8738n, title: "Ledger" }];
    mockGetUiElements.mockResolvedValueOnce({ ok: true, truncated: true, windowHwnd: "8738", elements: [] } as never);
    const r = await narrated({ windowTitle: "Ledger", name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("timeout");
    expect(getCachedUia(8738n)).toBeNull();
  });

  it("goes by the enumeration alone when the handle cannot be asked", async () => {
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [];
      shownUnknown = true;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("window_closed");
  });

  it("withholds when the enumeration after the action cannot answer", async () => {
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      enumThrows = true;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("ambiguous_title");
    expect(mockGetUiElements).toHaveBeenCalledTimes(1);
  });

  it("does not leave the pre-action tree in the cache for other readers (gate 2 on B2)", async () => {
    const { updateUiaCache, getCachedUia } = await import("../../src/engine/layer-buffer.js");
    updateUiaCache(0x2222n, "{\"elements\":[\"before the action\"]}");
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(getCachedUia(0x2222n)).toBeNull();
  });

  it("narrates a plain-title call whose window the action renamed (Explorer's folder change, B2)", async () => {
    mockGetUiElements.mockResolvedValue({ ok: true, windowHwnd: "8738", via: "native", elementCount: 1, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never);
    windows = [{ hwnd: 8738n, title: "exfolder" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 8738n, title: "sub1" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    try {
      const r = await narrated({ windowTitle: "exfolder", name: "sub1", narrate: "rich" } as never);
      expect(richOf(r).diffDegraded).toBeUndefined();
      expect(richOf(r).diffSource).toBe("uia");
    } finally {
      mockGetUiElements.mockReset();
      mockGetUiElements.mockImplementation(async () => ({ ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] }) as never);
    }
  });

  it("narrates by handle when the sibling arrives during the AFTER-snapshot itself (B2)", async () => {
    // The interval a title search left open: a window opening inside the read was
    // read by that very search. A read by handle is not a search.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    mockGetUiElements
      .mockImplementationOnce(async () => ({
        ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
      } as never))
      .mockImplementationOnce(async () => {
        windows = [
          { hwnd: 0x2222n, title: "Ledger" },
          { hwnd: 0x8888n, title: "Ledger" },
        ];
        return { ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] } as never;
      });
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("narrates a window the action renamed: the after-read follows the handle, not the title (B2)", async () => {
    // Typing into Notepad makes "タイトルなし - メモ帳" read "*ab - メモ帳"; opening a folder
    // renames Explorer after it. A title search found nothing (win2: Explorer's folder change
    // came back `timeout`, #750).
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x2222n, title: "*Ledger (edited)" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("reads the after-snapshot by the handle the before-read reported when nothing was pinned (B2)", async () => {
    // A plain-title call pins nothing; the before-read's own answer names the window.
    mockGetUiElements.mockResolvedValue({
      ok: true, windowHwnd: "30583", via: "native", elementCount: 1,
      elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
    } as never);
    windows = [{ hwnd: 30583n, title: SHARED_TITLE }];
    try {
      const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
      expect(richOf(r).diffSource).toBe("uia");
      const [first, second] = mockGetUiElements.mock.calls as unknown as unknown[][];
      expect(first[4]).not.toHaveProperty("pinnedHwnd");
      expect(second[4]).toMatchObject({ pinnedHwnd: 30583n });
    } finally {
      mockGetUiElements.mockReset();
      mockGetUiElements.mockImplementation(async () => ({ ok: true, elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }] }) as never);
    }
  });

  it("says window_closed when the window a plain-title before-read reported has gone (B2)", async () => {
    mockGetUiElements.mockResolvedValueOnce({
      ok: true, windowHwnd: "30583", via: "native", elementCount: 1,
      elements: [{ name: "Field", controlType: "Edit", automationId: "f1", value: "" }],
    } as never);
    windows = [{ hwnd: 30583n, title: SHARED_TITLE }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: SHARED_TITLE, name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("window_closed");
  });

  it("withholds when the action swaps the window for a same-titled replacement", async () => {
    // The count cannot see this: a dialog that advances by DESTROYING its window
    // and creating the next one leaves exactly one window with exactly that
    // title. The title search that takes the after-snapshot would then read the
    // replacement's tree against the original's, and every appeared/disappeared
    // in the diff would be an artefact of the swap.
    windows = [{ hwnd: 0x2222n, title: "Wizard" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x5555n, title: "Wizard" }];   // same title, new handle
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({
      windowTitle: "Wizard", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    // `target_changed`, not `window_closed`: a window answering to that title is
    // on the screen, and a caller told it had closed would give up on it.
    expect(richOf(r).diffDegraded).toBe("target_changed");
  });

  it("says window_closed when nothing answers to the title any more", async () => {
    // The other half of the same check, and the reason it is two answers: here
    // there is nothing left to reacquire.
    windows = [{ hwnd: 0x2222n, title: "Wizard" }];
    innerHandler.mockImplementationOnce(async () => {
      windows = [{ hwnd: 0x5555n, title: "Something else" }];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({
      windowTitle: "Wizard", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBe("window_closed");
  });

  it("does not withhold merely because the foreground moved under @active", async () => {
    // The reason this asks the HANDLE rather than re-resolving the query. Under
    // `@active` the snapshots search the RESOLVED title, so the foreground
    // moving away — which a state-changing action does routinely — breaks
    // nothing. Re-resolving `@active` here would have withheld every one of
    // those.
    windows = [
      { hwnd: 0x2222n, title: "Editor" },
      { hwnd: 0x3333n, title: "Console" },
    ];
    innerHandler.mockImplementationOnce(async () => {
      // The action brings the OTHER window to the front; the target is intact.
      windows = [
        { hwnd: 0x3333n, title: "Console" },
        { hwnd: 0x2222n, title: "Editor" },
      ];
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, post: {} }) }] } as never;
    });
    const r = await narrated({ windowTitle: "@active", name: "OK", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
  });

  it("narrates the same call when no sibling appears", async () => {
    // The pairing: the second count is not simply refusing everything.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(mockPin).toHaveBeenCalledTimes(1);
  });

  it("withholds on a title-only tool too, because its handler retargets the same way", async () => {
    // Scoping this to `hwndKey` was a second wrong guess at the same question.
    // `hwndKey` says who owns the targeting; what makes the diff wrong is that
    // the handler ADOPTS the fix's `windowTitle` while these snapshots follow
    // the argument — and `mouse.ts` does exactly that ("Apply fix args (override
    // user-supplied x/y/windowTitle)"). So `mouse_click` went back to a
    // confident diff of a window nobody touched: the sentence this ADR is about,
    // reintroduced by the fix for it.
    const titleOnly = withRichNarration("mouse_click", innerHandler as never, { windowTitleKey: "windowTitle" });
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await titleOnly({ windowTitle: "Ledger", fixId: "fix-1", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBe("fix_target_unknown");
    expect(richOf(r).diffSource).toBe("none");
    expect(mockGetUiElements).not.toHaveBeenCalled();
  });

  it("narrates a fixId call the handler will never see", async () => {
    // `keyboard` registers a FLATTENED union, so the wire accepts `fixId` for
    // `action:"press"`, which declares none — and the handler's re-parse strips
    // it. Nothing retargets, the one-shot fix is never consumed, and withholding
    // there took a CORRECT diff away under a reason untrue of the call: the same
    // wrapper-and-handler disagreement as `fixId: ""`, moved to a dispatcher
    // variant. The registration answers it per call now.
    const { keyboardFixRetargets } = await import("../../src/tools/keyboard.js");
    expect(keyboardFixRetargets({ action: "press" })).toBe(false);
    expect(keyboardFixRetargets({ action: "type" })).toBe(true);
    expect(keyboardFixRetargets({ action: "sequence" })).toBe(true);

    const dispatcher = withRichNarration("keyboard", innerHandler as never, {
      ...UIA_WRITE_NARRATION, fixRetargets: keyboardFixRetargets,
    });
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const press = await dispatcher({
      action: "press", windowTitle: "Ledger", hwnd: LIVE, fixId: "fix-1", narrate: "rich",
    } as never);
    expect(richOf(press).diffDegraded).toBeUndefined();
    expect(richOf(press).diffSource).toBe("uia");

    // The pairing: the variants that DO adopt the fix keep the withhold.
    mockGetUiElements.mockClear();
    const typed = await dispatcher({
      action: "type", windowTitle: "Ledger", hwnd: LIVE, fixId: "fix-1", narrate: "rich",
    } as never);
    expect(richOf(typed).diffDegraded).toBe("fix_target_unknown");
    expect(mockGetUiElements).not.toHaveBeenCalled();
  });

  it("leaves a tool that snapshots no window at all untouched", async () => {
    // The other side of the scope. The browser set declares `fixId` and is
    // narrated with no title key, so it never takes a snapshot by title and has
    // nothing to withhold — it returns above this, at `no_target`, exactly as
    // before.
    const noTitle = withRichNarration("browser_click", innerHandler as never, {});
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await noTitle({ fixId: "fix-1", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(mockGetUiElements).not.toHaveBeenCalled();
  });

  it("withholds rather than falling back to the argument if a handle ever resolves to nothing", async () => {
    // Case 1 of the resolver returns or throws today, never `null`, so this is
    // the fail-safe for a Case 1 that can — and an untested fail-safe is a
    // comment. Falling through to the caller's title here would narrate a
    // window chosen by a string while the handler acted on a handle.
    const resolver = vi.mocked((await import("../../src/tools/_resolve-window.js")).resolveWindowTarget);
    const first = resolver.getMockImplementation()!;
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    resolver.mockImplementation(async () => null as never);
    const r = await narrated({ windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich" } as never);
    resolver.mockImplementation(first);
    expect(richOf(r).diffDegraded).toBe("no_target");
    expect(mockGetUiElements).not.toHaveBeenCalled();
    expect(innerHandler).toHaveBeenCalled();
  });
});

// ── The declared key reaches the post layer ──────────────────────────────────
describe("ADR-036: the argument that names a window is the one the tool declared", () => {
  it("hands its own keys down, so a tool that calls the destination `title` is not read for `windowTitle`", () => {
    // `focus_window`'s schema names the partial title `title` (window.ts), and it declares that
    // here. A post layer reading a fixed `windowTitle` saw nothing on the one tool whose entire
    // job is to name a window. The two calls are the pairing: same wrapper, different
    // declaration, and what reaches the post layer follows the declaration.
    mockPostKeys.mockClear();
    withRichNarration("focus_window", innerHandler as never, { windowTitleKey: "title" });
    expect(mockPostKeys).toHaveBeenCalledWith({ windowTitleKey: "title", hwndKey: undefined });

    mockPostKeys.mockClear();
    withRichNarration("click_element", innerHandler as never, UIA_WRITE_NARRATION);
    expect(mockPostKeys).toHaveBeenCalledWith({ windowTitleKey: "windowTitle", hwndKey: "hwnd" });

    // A tool that declares nothing declares nothing — the post layer applies its own default,
    // which is what keeps `notification_show({title})` from being read as naming a window.
    mockPostKeys.mockClear();
    withRichNarration("clipboard", innerHandler as never, {});
    expect(mockPostKeys).toHaveBeenCalledWith({ windowTitleKey: undefined, hwndKey: undefined });
  });
});
