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
  mockDeferredEmit.mockClear();
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

  it("narrates the same call when no sibling appears", async () => {
    // The pairing: the second count is not simply refusing everything.
    windows = [{ hwnd: 0x2222n, title: "Ledger" }];
    const r = await narrated({
      windowTitle: "Ledger", hwnd: LIVE, name: "OK", narrate: "rich",
    } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(mockPin).toHaveBeenCalledTimes(1);
  });

  it("leaves a fixId call on a title-only tool exactly where it was", async () => {
    // `fixId` is declared by tools far outside this ADR — `mouse_click` is one —
    // so reading the key on all nineteen changed a tool this release says it
    // does not change. That is the same spill as the `argTitle` widening, one
    // commit later, and the scope is `hwndKey` again.
    const titleOnly = withRichNarration("mouse_click", innerHandler as never, { windowTitleKey: "windowTitle" });
    windows = [
      { hwnd: 0x1111n, title: SHARED_TITLE },
      { hwnd: 0x2222n, title: SHARED_TITLE },
    ];
    const r = await titleOnly({ windowTitle: SHARED_TITLE, fixId: "fix-1", narrate: "rich" } as never);
    expect(richOf(r).diffDegraded).toBeUndefined();
    expect(richOf(r).diffSource).toBe("uia");
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
