/**
 * keyboard-destination-required.test.ts — ADR-038.
 *
 * A `keyboard` write with neither `windowTitle` nor `hwnd` used to reach
 * `SendInput` with no guard and no focus, so the keys landed on whatever window
 * happened to be foreground at that instant. On 2026-08-18 that put an LLM's
 * keystrokes into the user's own input box.
 *
 * The hole was not in the guard itself — `runActionGuard` answers a null
 * descriptor with `unguarded` + pass-through — but in the fact that the three
 * handlers branch EXCLUSIVELY:
 *
 *     if (lensId) { evaluatePreToolGuards(...) } else if (isAutoGuardEnabled()) { runActionGuard(...) }
 *
 * so a call carrying a lensId never reached `runActionGuard` at all. That is why
 * these tests drive the REAL handlers (not the helper in isolation) and why the
 * lensId fixture (A2) matters as much as the plain one (A1): a check placed
 * inside either arm would pass one and fail the other.
 *
 * The sinks are mocked at the nut.js boundary, so "did a key go out?" is a
 * direct observation rather than an inference. M2 at the bottom mutates the
 * check to a no-op and asserts the sinks ARE reached — without it, a vacuous
 * check (one that sits after the sink, or is never called) would pass A1/A2 for
 * the wrong reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Sinks — the last thing before the OS. ───────────────────────────────────
const mockType = vi.fn(() => Promise.resolve());
const mockPressKey = vi.fn(() => Promise.resolve());
const mockReleaseKey = vi.fn(() => Promise.resolve());
const mockRawDown = vi.fn(() => Promise.resolve());
const mockRawUp = vi.fn(() => Promise.resolve());

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: (...a: unknown[]) => mockType(...(a as [])),
    pressKey: (...a: unknown[]) => mockPressKey(...(a as [])),
    releaseKey: (...a: unknown[]) => mockReleaseKey(...(a as [])),
  },
  rawKeyboard: {
    pressKeyDown: (...a: unknown[]) => mockRawDown(...(a as [])),
    pressKeyUp: (...a: unknown[]) => mockRawUp(...(a as [])),
  },
  withKeyboardLock: (fn: () => Promise<unknown>) => fn(),
}));

// ─── Diagnostic log — the ADR-038 Phase 0 counter. ───────────────────────────
const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return { ...actual, logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])) };
});

// ─── Auto-guard — `assertKeyboardDestination` stays REAL (it is the subject).
// Only `runActionGuard` is stubbed, so the destination-carrying fixtures do not
// drag the perception subsystem in. `isAutoGuardEnabled` is left real and driven
// by the env var, so the kill-switch case (E) exercises the production wiring.
const mockGetForegroundHwnd = vi.fn<() => bigint | null>(() => 0x100n);
const mockRunActionGuard = vi.fn(async () => ({
  block: false,
  summary: { kind: "auto", status: "ok", canContinue: true, next: "" },
}));
// The one-shot SuggestedFix surface, so the fixId fixture can observe whether a
// refused call burned the approval.
const mockValidateAndPrepareFix = vi.fn(() => ({ ok: false, errorCode: "FixNotFoundOrExpired" }));
const mockConsumeFix = vi.fn();
// Spelled out rather than spread from a shared object: the `vi.mock` factory is
// hoisted above the `const` initializers, so it may only reference them from
// inside a function body, never evaluate them. `actionGuardOverrides()` below is
// a hoisted function declaration for the same reason — M2 calls it at test time.
vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  return {
    ...actual,
    runActionGuard: (...a: unknown[]) => mockRunActionGuard(...(a as [])),
    validateAndPrepareFix: (...a: unknown[]) => mockValidateAndPrepareFix(...(a as [])),
    consumeFix: (...a: unknown[]) => mockConsumeFix(...(a as [])),
  };
});

function actionGuardOverrides() {
  return {
    runActionGuard: (...a: unknown[]) => mockRunActionGuard(...(a as [])),
    validateAndPrepareFix: (...a: unknown[]) => mockValidateAndPrepareFix(...(a as [])),
    consumeFix: (...a: unknown[]) => mockConsumeFix(...(a as [])),
  };
}

vi.mock("../../src/engine/perception/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/registry.js")>();
  return {
    ...actual,
    evaluatePreToolGuards: vi.fn(async () => ({ ok: true, policy: "allow" })),
    buildEnvelopeFor: vi.fn(() => undefined),
  };
});

vi.mock("../../src/tools/_focus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_focus.js")>();
  return {
    ...actual,
    detectFocusLoss: vi.fn(async () => null),
    checkForegroundOnce: vi.fn(async () => null),
  };
});

vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    isBgAutoEnabled: vi.fn(() => false),
    canInjectViaPostMessage: vi.fn(() => ({ supported: false })),
  };
});

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      {
        hwnd: 0x100n,
        title: "Notepad",
        region: { x: 0, y: 0, width: 100, height: 100 },
        zOrder: 0,
        isMinimized: false,
        isMaximized: false,
        isActive: true,
      },
    ]),
    getWindowClassName: vi.fn(() => "Notepad"),
    restoreAndFocusWindow: vi.fn(),
    // ADR-038 R2: the titleless-window rule asks whether the RESOLVED handle is
    // the foreground one. `getForegroundHwnd` is what production consults —
    // `enumWindowsInZOrder` cannot answer it, because it drops untitled windows.
    getForegroundHwnd: (...a: unknown[]) => mockGetForegroundHwnd(...(a as [])),
  };
});

// `resolveWindowTarget` mirrors production semantics: null when the caller named
// no target at all, and a resolved record otherwise. Fixture C overrides it to
// return the empty title a handle-addressed titleless window really produces.
type Resolved = { title: string; hwnd: bigint; warnings: string[] } | null;
const mockResolveWindowTarget = vi.fn<
  (opts: { hwnd?: string; windowTitle?: string }) => Promise<Resolved>
>(async (opts) => {
  if (opts.hwnd === undefined && opts.windowTitle === undefined) return null;
  return { title: opts.windowTitle ?? "Notepad", hwnd: 0x100n, warnings: [] };
});
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: (...a: unknown[]) => mockResolveWindowTarget(...(a as [])) };
});

import {
  keyboardTypeHandler,
  keyboardPressHandler,
  keyboardSequenceHandler,
} from "../../src/tools/keyboard.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. A1/A2 and the mutation meta-test M2 read from these same constants
// so the two can never drift into testing different calls (ADR-038 §4 M3).
// ─────────────────────────────────────────────────────────────────────────────

/** A1: destination-less `type`, no lensId — the plain hole. */
const TYPE_NO_DESTINATION = {
  text: "abcdefgh",
  method: "foreground" as const,
  use_clipboard: false,
  replaceAll: false,
  forceKeystrokes: false,
  trackFocus: false,
  settleMs: 0,
};

/** A2: the same call WITH a lensId — the exclusive branch ADR-038 exists for. */
const TYPE_NO_DESTINATION_WITH_LENS = { ...TYPE_NO_DESTINATION, lensId: "L1" };

const PRESS_NO_DESTINATION = {
  keys: "enter",
  method: "foreground" as const,
  trackFocus: false,
  settleMs: 0,
};

const SEQUENCE_NO_DESTINATION = {
  steps: [{ keys: "alt+f" }],
  method: "foreground" as const,
  trackFocus: false,
  settleMs: 0,
};

const EXPECTED_SUGGEST = [
  "Pass `windowTitle` or `hwnd` so the input has an explicit destination window.",
  "Call `desktop_discover` (or `desktop_state`) to list windows and pick a target.",
  "To deliberately type into the current foreground window, set DESKTOP_TOUCH_REQUIRE_DESTINATION=0 (downgrades this stop to a warning — never a silent pass).",
];

function body(r: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(r.content[0]!.text!) as Record<string, any>;
}

/** True when ANY of the five key sinks fired. */
function anySinkCalled(): boolean {
  return [mockType, mockPressKey, mockReleaseKey, mockRawDown, mockRawUp].some(
    (m) => m.mock.calls.length > 0,
  );
}

function diagnosticEvents() {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.kind === "destination_missing");
}

function expectRefused(
  r: Record<string, any>,
  tool: string,
  reason: "no_destination" | "titleless_hwnd_not_foreground" = "no_destination",
) {
  expect(r.ok).toBe(false);
  expect(r.code).toBe("DestinationRequired");
  expect(r.suggest).toEqual(EXPECTED_SUGGEST);
  expect(r.context.tool).toBe(tool);
  // The two refusals share a code but not a cause, so the caller can tell
  // "you named nothing" from "what you named cannot be reached yet".
  expect(r.context.reason).toBe(reason);
  expect(r.context.guard.status).toBe("destination_required");
  expect(r.context.guard.canContinue).toBe(false);
  expect(r.context.guard.next).toContain("windowTitle or hwnd");
  expect(anySinkCalled()).toBe(false);
}

const ENV_KEYS = [
  "DESKTOP_TOUCH_REQUIRE_DESTINATION",
  "DESKTOP_TOUCH_AUTO_GUARD",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the window the resolver hands back IS the foreground one.
  mockGetForegroundHwnd.mockReturnValue(0x100n);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("ADR-038 — a keyboard write without a destination is refused", () => {
  it("A1: type without windowTitle / hwnd stops before any key is sent", async () => {
    const r = body(await keyboardTypeHandler(TYPE_NO_DESTINATION));
    expectRefused(r, "keyboard:type");
    expect(diagnosticEvents()).toEqual([
      { kind: "destination_missing", tool: "keyboard:type", hasLens: false, hadHwndParam: false, reason: "no_destination", decision: "block" },
    ]);
  });

  it("A2: a lensId does not buy a way past it (the exclusive-branch hole)", async () => {
    const r = body(await keyboardTypeHandler(TYPE_NO_DESTINATION_WITH_LENS));
    expectRefused(r, "keyboard:type");
    expect(diagnosticEvents()).toEqual([
      { kind: "destination_missing", tool: "keyboard:type", hasLens: true, hadHwndParam: false, reason: "no_destination", decision: "block" },
    ]);
    // The lens arm must never have been consulted — the refusal is upstream of
    // the branch, not inside one of its two sides.
    expect(mockRunActionGuard).not.toHaveBeenCalled();
  });

  it("A3: press without windowTitle / hwnd stops before any key is sent", async () => {
    const r = body(await keyboardPressHandler(PRESS_NO_DESTINATION));
    expectRefused(r, "keyboard:press");
    expect(diagnosticEvents()[0]).toMatchObject({ tool: "keyboard:press", decision: "block" });
  });

  it("A4: sequence without windowTitle / hwnd stops before any key is sent", async () => {
    const r = body(await keyboardSequenceHandler(SEQUENCE_NO_DESTINATION));
    expectRefused(r, "keyboard:sequence");
    expect(diagnosticEvents()[0]).toMatchObject({ tool: "keyboard:sequence", decision: "block" });
  });

  it("A3-lens / A4-lens: press and sequence close the lens arm too", async () => {
    const p = body(await keyboardPressHandler({ ...PRESS_NO_DESTINATION, lensId: "L1" }));
    expectRefused(p, "keyboard:press");
    const s = body(await keyboardSequenceHandler({ ...SEQUENCE_NO_DESTINATION, lensId: "L1" }));
    expectRefused(s, "keyboard:sequence");
  });

  it("B: windowTitle is a destination — the call proceeds to the normal guard path", async () => {
    const r = body(
      await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, windowTitle: "Notepad" }),
    );
    expect(r.ok).toBe(true);
    expect(mockRunActionGuard).toHaveBeenCalledTimes(1);
    expect(mockType).toHaveBeenCalledTimes(1);
    expect(mockType).toHaveBeenCalledWith("abcdefgh");
    expect(diagnosticEvents()).toEqual([]);
  });

  it("C: hwnd alone is a destination, even when the window has no title", async () => {
    // A titleless window addressed by handle resolves to `title: ""`. The check
    // reads the hwnd the caller passed, not the title that came back, so this
    // must proceed — an empty title is not a missing destination.
    mockResolveWindowTarget.mockResolvedValueOnce({ title: "", hwnd: 0x100n, warnings: [] });
    const r = body(await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, hwnd: "256" }));
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalledTimes(1);
    expect(diagnosticEvents()).toEqual([]);
  });

  it("D: REQUIRE_DESTINATION=0 downgrades the stop to a warning — never a silent pass", async () => {
    process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION = "0";
    const r = body(await keyboardTypeHandler(TYPE_NO_DESTINATION));
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalledTimes(1);
    expect(r.hints.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("DestinationRequired downgraded to a warning")]),
    );
    expect(diagnosticEvents()).toEqual([
      { kind: "destination_missing", tool: "keyboard:type", hasLens: false, hadHwndParam: false, reason: "no_destination", decision: "warn" },
    ]);
  });

  it("E: AUTO_GUARD=0 keeps the old pass-through, and adds no warning of ours", async () => {
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    const r = body(await keyboardTypeHandler(TYPE_NO_DESTINATION));
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalledTimes(1);
    const warnings: string[] = r.hints?.warnings ?? [];
    expect(warnings.some((w) => w.includes("DestinationRequired"))).toBe(false);
    // Still counted — the Phase 0 sample has to include the calls this build
    // lets through, or it only measures the refusals.
    expect(diagnosticEvents()).toEqual([
      { kind: "destination_missing", tool: "keyboard:type", hasLens: false, hadHwndParam: false, reason: "no_destination", decision: "unguarded" },
    ]);
  });

  it("F: foreground_flash keeps its own ForegroundFlashRequiresTarget code", async () => {
    const r = body(
      await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, method: "foreground_flash" as any }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundFlashRequiresTarget");
    expect(anySinkCalled()).toBe(false);
    // The public code is untouched, but the shape is still destination-less, so
    // the Phase 0 sample records it rather than going blind on the flash path.
    expect(diagnosticEvents()).toEqual([
      { kind: "destination_missing", tool: "keyboard:type", hasLens: false, hadHwndParam: false, reason: "no_destination", decision: "block" },
    ]);
  });

  it("F2: flash refusing a call that DOES have a destination is not counted", async () => {
    // `foreground_flash` needs a TITLE specifically, which is a narrower demand
    // than this ADR's. Counting its refusal of an hwnd-addressed foreground
    // window would put calls the ADR considers targeted into the
    // destination-less sample and skew the Phase 0 read (Opus review R2).
    mockResolveWindowTarget.mockResolvedValueOnce({ title: "", hwnd: 123n, warnings: [] });
    mockGetForegroundHwnd.mockReturnValue(123n);
    const r = body(
      await keyboardTypeHandler({
        ...TYPE_NO_DESTINATION,
        method: "foreground_flash" as any,
        hwnd: "123",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ForegroundFlashRequiresTarget");
    expect(anySinkCalled()).toBe(false);
    expect(diagnosticEvents()).toEqual([]);
  });

  it("F3: a refused flash call does not burn its fixId either", async () => {
    mockValidateAndPrepareFix.mockReturnValueOnce({
      ok: true,
      fix: { args: {} },
    } as never);
    const r = body(
      await keyboardTypeHandler({
        ...TYPE_NO_DESTINATION,
        method: "foreground_flash" as any,
        fixId: "fix-3",
      }),
    );
    expect(r.code).toBe("ForegroundFlashRequiresTarget");
    expect(mockConsumeFix).not.toHaveBeenCalled();
  });

  // ── The titleless-window rule (Codex review R1). ──────────────────────────
  // Everything downstream of this check is driven by the resolved TITLE: focus
  // runs under `if (effectiveWindowTitle)` and the guard descriptor is null
  // without one. So a handle that resolves to a titleless window is neither
  // focused nor guarded and the keys still land on the foreground — which is
  // only the caller's intent when that window ALREADY is the foreground.

  it("C2a: windowTitle:'@active' resolving to a titleless FOREGROUND window passes", async () => {
    mockResolveWindowTarget.mockResolvedValueOnce({ title: "", hwnd: 123n, warnings: [] });
    mockGetForegroundHwnd.mockReturnValue(123n);
    const r = body(
      await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, windowTitle: "@active" }),
    );
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalledTimes(1);
    expect(diagnosticEvents()).toEqual([]);
  });

  it("C2b: an explicit hwnd resolving to a titleless NON-foreground window is refused", async () => {
    // The delivery would land on whatever IS foreground — the exact accident
    // this ADR exists to stop, reached through an argument that looks targeted.
    mockResolveWindowTarget.mockResolvedValueOnce({ title: "", hwnd: 123n, warnings: [] });
    mockGetForegroundHwnd.mockReturnValue(0x999n);
    const r = body(await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, hwnd: "123" }));
    expectRefused(r, "keyboard:type", "titleless_hwnd_not_foreground");
    expect(r.error).toContain("not in the foreground");
    expect(diagnosticEvents()).toEqual([
      {
        kind: "destination_missing",
        tool: "keyboard:type",
        hasLens: false,
        hadHwndParam: true,
        reason: "titleless_hwnd_not_foreground",
        decision: "block",
      },
    ]);
  });

  it("C2c: an explicit hwnd resolving to a titleless FOREGROUND window passes", async () => {
    // Delivery lands exactly where the caller pointed, so the refusal in C2b is
    // about reachability — not about hwnd as a way of naming a target.
    mockResolveWindowTarget.mockResolvedValueOnce({ title: "", hwnd: 123n, warnings: [] });
    mockGetForegroundHwnd.mockReturnValue(123n);
    const r = body(await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, hwnd: "123" }));
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalledTimes(1);
    expect(diagnosticEvents()).toEqual([]);
  });

  it("G: a refused call does not burn the one-shot fixId it was given", async () => {
    // `consumeFix` used to run in the prologue, before the destination check.
    // A call refused here would have spent an approval it never got to use, and
    // the retry the error asks for would fail with FixAlreadyConsumed.
    mockValidateAndPrepareFix.mockReturnValueOnce({
      ok: true,
      fix: { args: {} },
    } as never);
    const r = body(await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, fixId: "fix-1" }));
    expectRefused(r, "keyboard:type");
    expect(mockValidateAndPrepareFix).toHaveBeenCalledWith("fix-1", "keyboard");
    expect(mockConsumeFix).not.toHaveBeenCalled();
  });

  it("G2: a call that proceeds DOES burn the fixId (the control for G)", async () => {
    mockValidateAndPrepareFix.mockReturnValueOnce({
      ok: true,
      fix: { args: { windowTitle: "Notepad" } },
    } as never);
    const r = body(await keyboardTypeHandler({ ...TYPE_NO_DESTINATION, fixId: "fix-2" }));
    expect(r.ok).toBe(true);
    expect(mockConsumeFix).toHaveBeenCalledWith("fix-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 — mutation meta-test.
//
// A1/A2 pass if the sink is never reached. That is also what happens if the
// handler is broken in some unrelated way, or if the check were placed after a
// sink that no fixture exercises. Neutering the check and re-running the SAME
// two fixtures separates the two readings: with the check gone the keys must go
// out, in BOTH branches. If either of these stays silent, the corresponding
// A-case was passing for a reason other than the one it claims.
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-038 M2 — with the check neutered, the fixtures reach the sink", () => {
  /** Re-import the handlers with `assertKeyboardDestination` forced to `{ok:true}`. */
  async function withCheckNeutered<T>(
    fn: (h: typeof import("../../src/tools/keyboard.js")) => Promise<T>,
  ): Promise<T> {
    vi.resetModules();
    vi.doMock("../../src/tools/_action-guard.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
      return { ...actual, ...actionGuardOverrides(), assertKeyboardDestination: () => ({ ok: true }) };
    });
    try {
      return await fn(await import("../../src/tools/keyboard.js"));
    } finally {
      vi.doUnmock("../../src/tools/_action-guard.js");
      vi.resetModules();
    }
  }

  it("A1 and A2 both send keys once assertKeyboardDestination always says ok", async () => {
    await withCheckNeutered(async ({ keyboardTypeHandler: mutated }) => {
      mockType.mockClear();
      const a1 = body(await mutated(TYPE_NO_DESTINATION));
      expect(a1.ok).toBe(true);
      expect(mockType).toHaveBeenCalledTimes(1);

      mockType.mockClear();
      const a2 = body(await mutated(TYPE_NO_DESTINATION_WITH_LENS));
      expect(a2.ok).toBe(true);
      expect(mockType).toHaveBeenCalledTimes(1);
    });
  });

  it("A3 (press) reaches the key sink once the check is neutered", async () => {
    await withCheckNeutered(async ({ keyboardPressHandler: mutated }) => {
      mockPressKey.mockClear();
      const r = body(await mutated(PRESS_NO_DESTINATION));
      expect(r.ok).toBe(true);
      expect(mockPressKey).toHaveBeenCalledTimes(1);
    });
  });

  it("A4 (sequence) reaches the key sink once the check is neutered", async () => {
    await withCheckNeutered(async ({ keyboardSequenceHandler: mutated }) => {
      mockRawDown.mockClear();
      const r = body(await mutated(SEQUENCE_NO_DESTINATION));
      expect(r.ok).toBe(true);
      expect(mockRawDown).toHaveBeenCalledTimes(1);
    });
  });
});
