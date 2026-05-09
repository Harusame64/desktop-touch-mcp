/**
 * issue-184-foreground-refusal-pin.test.ts
 *
 * Phase 3 epic #184 closure pin (PR #202 carry-over).
 *
 * Verifies that the production handlers consult the
 * `focusWindowForKeyboard` / applyHoming / terminal foreground ladder
 * and surface the typed `ForegroundRestricted` ok:false envelope when
 * Win11 foreground-stealing protection refuses BOTH the default
 * SetForegroundWindow and the AttachThreadInput escalation.
 *
 * Scope (PR #208 / issue #184): this file contributes the
 * keyboard:type pin. The remaining three tools differ in how
 * tightly the keyboard:type pattern transfers (Opus PR #208 Round
 * 1 P2-1 — "representative" claim精度):
 *
 *   - keyboard:press shares the SAME helper (`focusWindowForKeyboard`)
 *     so the structural pattern (vi.mock + restoreAndFocusWindow
 *     ladder + ForegroundRestricted assertions) is reusable as-is —
 *     a near-mechanical copy of the cases below.
 *   - mouse_click uses a DIFFERENT helper (`applyHoming`) inside the
 *     homing block, so the test needs an additional cache + position
 *     mock surface — the assertion shape transfers but the scaffolding
 *     does not.
 *   - terminal:send has an INLINE 5-retry + auto-escalate ladder
 *     (no shared helper), and needs `findTerminalWindow` mocking on
 *     top of the foreground enum mocks — assertion shape transfers,
 *     scaffolding is handler-specific.
 *
 * Issue #207 carries the remaining three with their per-handler
 * scaffolding scopes documented row by row. Pinning all four in this
 * PR would inflate scope without commensurate contract coverage gain
 * (CLAUDE.md "scope discipline").
 *
 * Coverage gap (Opus PR #209 Round 1 P2-2 — visualised here as the
 * SSOT for the family): the success-path case below (case 3, "does
 * NOT early-return when the target reaches foreground after the
 * default attempt") only exercises `focusWindowForKeyboard`'s
 * success branch. It does NOT cover:
 *   - mouse_click's `applyHoming` success branch — different helper,
 *     different post-wait re-enum logic
 *   - terminal:send's inline 5-retry + `break` on first success —
 *     no shared helper, the break-on-success path is structurally
 *     unique
 * If a future regression makes one of those success paths
 * incorrectly emit `ForegroundRestricted`, only the refusal cases in
 * `tests/unit/issue-207-foreground-refusal-{press,mouse,terminal}.test.ts`
 * would still pass (they assert `ok:false`). A targeted success-path
 * pin per tool (currently undone) is the natural follow-up and
 * should be filed as a new issue if the gap becomes a real concern.
 *
 * Mocking mirrors `tests/unit/focus-window-handler.test.ts` —
 * `enumWindowsInZOrder` returns a deterministic window list, the
 * post-wait re-enumeration keeps the target out of the foreground
 * across both default and force-escalate attempts, so
 * `focusWindowForKeyboard.forceRefused` becomes true and the handler
 * must early-return `ForegroundRestricted`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (declared before imports per vi.mock hoisting) ───

// Partial mock — keep constant exports (VK_CONTROL / WM_CHAR / etc.) live
// so transitive imports through bg-input.ts continue to resolve. Only the
// foreground-control surface is stubbed.
vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => ""),
  };
});

// `_action-guard` controls whether the auto-guard machinery runs;
// disabling it via `isAutoGuardEnabled: () => false` keeps the test
// out of the perception subsystem so the foreground-refusal early
// return is exercised in isolation.
vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
  validateAndPrepareFix: vi.fn(() => null),
  consumeFix: vi.fn(),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("")),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn() },
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
  checkForegroundOnce: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({
    title: windowTitle,
    warnings: [],
  })),
}));

import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import * as win32 from "../../src/engine/win32.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);

function fakeWindow(title: string, isActive: boolean, hwnd = 100n) {
  return {
    hwnd,
    title,
    isActive,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "test.exe",
  };
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRestore.mockReturnValue({ x: 100, y: 100, width: 800, height: 600 });
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

describe("issue #184: keyboard:type foreground-refusal contract pin (PR #202 carry-over)", () => {
  it("returns ok:false ForegroundRestricted when default + force escalation both refused", async () => {
    // Setup: target window exists, but the foreground stays on a
    // different window across both restoreAndFocusWindow attempts —
    // simulating Win11 foreground-stealing protection refusing both
    // the default SetForegroundWindow and the AttachThreadInput
    // escalation. focusWindowForKeyboard's `reachedForeground` stays
    // false on both passes → `forceRefused = true`.
    const target = fakeWindow("PowerShell", false, 100n);
    const sticky = fakeWindow("Sticky Foreground", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial enum (target not foreground)
      .mockReturnValueOnce([target, sticky]) // post-default re-enum (still sticky)
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (still sticky)

    const r = parseResult(await keyboardTypeHandler({
      text: "hello",
      windowTitle: "PowerShell",
      method: "foreground",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      trackFocus: false,
      settleMs: 0,
      // forceFocus omitted → caller's force=false → focusWindowForKeyboard
      // tries default SetForegroundWindow first, then auto-escalates to
      // force=true (AttachThreadInput). Both refused → forceRefused=true.
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    // Issue #202 contract pin: hint + attemptedForce + autoEscalated emit
    // for caller machine-readable branching.
    expect(typeof r.context).toBe("object");
    expect(r.context.attemptedForce).toBe(false);
    expect(r.context.autoEscalated).toBe(true);
    expect(typeof r.context.hint).toBe("string");
    expect(r.context.hint).toMatch(/SetForegroundWindow.*AttachThreadInput/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // restoreAndFocusWindow called twice: once with force:false (default),
    // once with force:true (auto-escalate). The third call (Step 1
    // post-typing focus restore) is not reached because the early-return
    // surfaces ForegroundRestricted before keyboard.type runs.
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenNthCalledWith(1, 100n, { force: false });
    expect(mockRestore).toHaveBeenNthCalledWith(2, 100n, { force: true });
  });

  it("hint文言が force:true caller では default ladder skip を反映", async () => {
    // forceFocus=true caller path: focusWindowForKeyboard skips the
    // default SetForegroundWindow entirely and goes straight to the
    // AttachThreadInput escalation. The hint must reflect that —
    // saying "both default and ... escalation refused" would be
    // false when only the escalation was attempted (Opus PR #206
    // Round 2 P2-1 semantic precision).
    const target = fakeWindow("PowerShell", false, 100n);
    const sticky = fakeWindow("Sticky", true, 200n);
    mockEnum
      .mockReturnValueOnce([target, sticky]) // initial
      .mockReturnValueOnce([target, sticky]); // post-force re-enum (still sticky)

    const r = parseResult(await keyboardTypeHandler({
      text: "hello",
      windowTitle: "PowerShell",
      method: "foreground",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundRestricted");
    expect(r.context.attemptedForce).toBe(true);
    expect(r.context.autoEscalated).toBe(false);
    // The hint should NOT claim default SetForegroundWindow was tried.
    expect(r.context.hint).not.toMatch(/default SetForegroundWindow/);
    expect(r.context.hint).toMatch(/AttachThreadInput/);
    // Only one restore call (initial force=true), no escalation step.
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: true });
  });

  it("does NOT early-return when the target reaches foreground after the default attempt", async () => {
    // Sanity: when default SetForegroundWindow succeeds, no escalation,
    // no ForegroundRestricted. The handler proceeds past Step 1 and
    // ultimately runs keyboard.type. This pins the success path so a
    // future regression that flipped `reachedForeground` would surface.
    const target = fakeWindow("PowerShell", false, 100n);
    mockEnum
      .mockReturnValueOnce([target]) // initial enum (target not foreground)
      .mockReturnValueOnce([{ ...target, isActive: true }]); // post-default re-enum (now foreground)

    const r = parseResult(await keyboardTypeHandler({
      text: "hello",
      windowTitle: "PowerShell",
      method: "foreground",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      trackFocus: false,
      settleMs: 0,
    }));

    // ok could be true or false depending on downstream nutjs / clipboard
    // mocks, but it MUST NOT be the early-return ForegroundRestricted.
    expect(r.code).not.toBe("ForegroundRestricted");
    // Only one restore call (initial default), no auto-escalation.
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockRestore).toHaveBeenCalledWith(100n, { force: false });
  });
});
