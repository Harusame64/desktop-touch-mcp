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

const { withRichNarration, UIA_WRITE_NARRATION } = await import("../../src/tools/_narration.js");

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
