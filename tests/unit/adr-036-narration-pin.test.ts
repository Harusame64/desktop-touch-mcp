/**
 * adr-036-narration-pin.test.ts — ADR-036: rich narration and the shared title.
 *
 * `withRichNarration` wraps the three write tools whose `ambiguous_target`
 * refusal this ADR lifts. Its before/after snapshots find their window BY
 * TITLE (`snapElements` → `getUiElements`), so a call that named a handle used
 * to be stopped by the guard before the wrapper could report on the wrong
 * window — and lifting the refusal made that reachable.
 *
 * Every case here is paired with the same fixture minus the handle, so no
 * assertion can pass for a reason other than the handle being what changed it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const LIVE = "0x2222";

/** Mutable so one file can hold "two windows", "one window" and "cannot tell". */
let windows: Array<{ hwnd: bigint; title: string }> = [];
let enumThrows = false;

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

const { mockPin } = vi.hoisted(() => ({ mockPin: vi.fn() }));

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    withPinnedResolution: (<T>(p: unknown, value: unknown, fn: () => Promise<T>) => {
      mockPin(p, value);
      return fn();
    }),
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) => {
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
  return { ...actual, getUiElements: (...a: unknown[]) => mockGetUiElements(...(a as [])) };
});

// The post-state layer is not what this file is about; passthrough keeps the
// assertions on the narration rule rather than on focus snapshots.
vi.mock("../../src/tools/_post.js", () => ({
  withPostState: (_name: string, handler: (a: Record<string, unknown>) => Promise<unknown>) => handler,
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
  mockPin.mockClear();
  popupFor = {};
  windows = [
    { hwnd: 0x1111n, title: SHARED_TITLE },
    { hwnd: 0x2222n, title: SHARED_TITLE },
  ];
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

  it("says in the shipped description that the diff can be withheld", () => {
    // That description is what decides whether the model takes a verification
    // screenshot instead. It promised the diff removes the need for one; this
    // ADR made cases where it returns nothing, so the promise has to carry the
    // exception with it. Shipped wording drifting from shipped behaviour is the
    // failure this repo has had before.
    const said = narrateParam.description ?? "";
    expect(said).toContain("diffDegraded");
    expect(said).toContain("hwnd");
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
});
