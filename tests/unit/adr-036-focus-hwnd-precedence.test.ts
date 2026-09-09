/**
 * adr-036-focus-hwnd-precedence.test.ts — the leash's own premise.
 *
 * Round 2 passed the pinned handle into the focus-loss checks that decide
 * whether a chunked `keyboard:type` keeps sending. Those tests assert on the
 * ARGUMENTS reaching a mocked `_focus.js`, which is only meaningful while
 * `detectFocusLoss` actually prefers the handle over the title. Nothing pinned
 * that, so a change there would have left the argument tests green and the
 * behaviour gone. This file pins it directly, against the real function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const NAMED = 0x1111n;
const SIBLING = 0x2222n;

const { mockEnumWindows } = vi.hoisted(() => ({ mockEnumWindows: vi.fn() }));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: mockEnumWindows,
  getWindowProcessId: vi.fn(() => 0),
}));

const { detectFocusLoss, checkForegroundOnce } = await import("../../src/tools/_focus.js");

function win(hwnd: bigint, title: string, isActive: boolean) {
  return {
    hwnd, title, isActive, zOrder: isActive ? 0 : 1,
    region: { x: 0, y: 0, width: 800, height: 600 },
    isMinimized: false, isMaximized: false,
    className: "Chrome_WidgetWin_1", ownerHwnd: null,
  };
}

beforeEach(() => mockEnumWindows.mockReset());

describe("ADR-036 — the focus check answers on the handle, not the shared title", () => {
  it("reports focus lost when a same-titled sibling took the foreground", async () => {
    // The whole point: by title this window is still "focused", and the keys
    // would keep going to the sibling.
    mockEnumWindows.mockReturnValue([win(SIBLING, SHARED_TITLE, true), win(NAMED, SHARED_TITLE, false)]);
    const lost = await checkForegroundOnce({ target: SHARED_TITLE, hwnd: NAMED });
    expect(lost).not.toBeNull();
    // Named by title, both windows answer to it — so the field that has to be
    // right here is the one the handle decided, not the one the title did.
    expect(lost!.expected).toContain(SHARED_TITLE);
    expect(lost!.stolenBy).toContain(SHARED_TITLE);
  });

  it("reports no loss for that same fixture when no handle was named", async () => {
    // The pairing — title-only callers keep the behaviour they had.
    mockEnumWindows.mockReturnValue([win(SIBLING, SHARED_TITLE, true), win(NAMED, SHARED_TITLE, false)]);
    expect(await checkForegroundOnce({ target: SHARED_TITLE })).toBeNull();
  });

  it("reports no loss while the named window is still in front", async () => {
    mockEnumWindows.mockReturnValue([win(NAMED, SHARED_TITLE, true), win(SIBLING, SHARED_TITLE, false)]);
    expect(await checkForegroundOnce({ target: SHARED_TITLE, hwnd: NAMED })).toBeNull();
  });

  it("keeps the handle's answer when the title changed underneath it", async () => {
    // Issue #257 in the shape this ADR cares about: a document-suffix rename is
    // not focus loss, and the handle is what says so.
    mockEnumWindows.mockReturnValue([win(NAMED, "pictkura — Chrome — edited", true)]);
    expect(await detectFocusLoss({ target: SHARED_TITLE, hwnd: NAMED, settleMs: 0 })).toBeNull();
  });
});
