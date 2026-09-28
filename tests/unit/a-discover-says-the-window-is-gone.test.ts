/**
 * internal #211 item 9(3) — `desktop_discover` by a handle that names no window any more says so.
 *
 * MEASURED win2 (internal #212, arm 9c): following a refusal's advice to the handle of a dialog that
 * had closed, `desktop_discover(target.hwnd = <that handle>)` answered `entities: []` with no error
 * and no warning — `normalizeTarget` swallowed the resolver's `WindowNotFound` as a tolerant miss.
 * The miss stays tolerant (the visual lanes pass opaque keys in the same field); it is now named when
 * the OS answers that the handle is not a window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  windowIsAlive: vi.fn<(h: bigint) => boolean | undefined>(),
  empty: vi.fn(async () => ({ candidates: [], warnings: [] })),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({ resolveWindowTarget: mocks.resolveWindowTarget }));
vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: mocks.empty }));
vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: mocks.empty }));
vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: mocks.empty }));
vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({ fetchVisualCandidates: mocks.empty }));
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    windowIsAlive: mocks.windowIsAlive,
    getWindowIdentity: vi.fn(() => undefined),
    getWindowClassName: vi.fn(() => ""),
    getWindowTitleW: vi.fn(() => ""),
    getWindowRectByHwnd: vi.fn(() => null),
  };
});

import { composeCandidates } from "../../src/tools/desktop-providers/compose-providers.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";

beforeEach(() => {
  mocks.resolveWindowTarget.mockReset();
  mocks.windowIsAlive.mockReset();
  // What the resolver does for a handle with no visible window (`_resolve-window.ts` case 1).
  mocks.resolveWindowTarget.mockRejectedValue(new Error('WindowNotFound: no visible window with hwnd "7211920"'));
});

describe("discover by a handle that names no window", () => {
  it("warns target_window_gone when the OS says the handle is not a window — the closed dialog", async () => {
    mocks.windowIsAlive.mockReturnValue(false);
    const result = await composeCandidates({ hwnd: "7211920" });
    expect(result.warnings).toContain("target_window_gone");
    expect(mocks.windowIsAlive).toHaveBeenCalledWith(7211920n);
  });

  it("runs no lane for it, and keeps the target it named, with its identity looked for and not found (gate 2)", async () => {
    mocks.windowIsAlive.mockReturnValue(false);
    mocks.empty.mockClear();
    const result = await composeCandidates({ hwnd: "7211920" });
    expect(result).toEqual({ candidates: [], warnings: ["target_window_gone"], target: { hwnd: "7211920" }, identityRead: true });
    expect(mocks.empty).not.toHaveBeenCalled();
  });

  it("says it for a handle sent with a title too (gate 2)", async () => {
    mocks.windowIsAlive.mockReturnValue(false);
    const result = await composeCandidates({ hwnd: "7211920", windowTitle: "メモ帳" });
    expect(result.warnings).toContain("target_window_gone");
  });

  it("does not call handle zero a closed window: it names none (gate 2)", async () => {
    mocks.windowIsAlive.mockReturnValue(false);
    const result = await composeCandidates({ hwnd: "0" });
    expect(result.warnings).not.toContain("target_window_gone");
  });

  it("says nothing new when the window is there but has no visible rect (hidden, not gone)", async () => {
    mocks.windowIsAlive.mockReturnValue(true);
    const result = await composeCandidates({ hwnd: "7211920" });
    expect(result.warnings).not.toContain("target_window_gone");
  });

  it("says nothing new when the OS could not be asked", async () => {
    mocks.windowIsAlive.mockReturnValue(undefined);
    const result = await composeCandidates({ hwnd: "7211920" });
    expect(result.warnings).not.toContain("target_window_gone");
  });

  it("does not ask about an opaque key the visual lanes pass in the same field", async () => {
    mocks.resolveWindowTarget.mockRejectedValue(new Error('WindowNotFound: hwnd "hwnd-game" is not a valid integer'));
    mocks.windowIsAlive.mockReturnValue(false);
    const result = await composeCandidates({ hwnd: "hwnd-game" });
    expect(result.warnings).not.toContain("target_window_gone");
    expect(mocks.windowIsAlive).not.toHaveBeenCalled();
  });
});

describe("the constraint names it as why there are no entities", () => {
  it("sets window and entityZeroReason to target_window_gone", () => {
    expect(deriveViewConstraints(["target_window_gone"], 0)).toEqual({ window: "target_window_gone", entityZeroReason: "target_window_gone" });
  });

  it("outranks the lane failures an empty read of a gone window also brings", () => {
    expect(deriveViewConstraints(["uia_provider_failed", "target_window_gone"], 0)?.entityZeroReason).toBe("target_window_gone");
  });

  it("sets no entityZeroReason when there are entities", () => {
    expect(deriveViewConstraints(["target_window_gone"], 3)?.entityZeroReason).toBeUndefined();
  });
});
