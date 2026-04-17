/**
 * tests/unit/action-guard.test.ts
 * Unit tests for runActionGuard (10 cases required by plan A-3).
 *
 * Mocks resolveActionTarget and evaluateGuards to stay pure (no Win32).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockResolveActionTarget, mockEvaluateGuards } = vi.hoisted(() => ({
  mockResolveActionTarget: vi.fn(),
  mockEvaluateGuards: vi.fn(),
}));

vi.mock("../../src/engine/perception/action-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/action-target.js")>();
  return {
    ...actual,
    resolveActionTarget: mockResolveActionTarget,
  };
});

vi.mock("../../src/engine/perception/guards.js", () => ({
  evaluateGuards: mockEvaluateGuards,
}));

// Import after mocking
import { runActionGuard, isAutoGuardEnabled } from "../../src/tools/_action-guard.js";
import type { PerceptionLens, LensSpec } from "../../src/engine/perception/types.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";

function makeFakeLens(): PerceptionLens {
  const spec: LensSpec = {
    name: "__auto__",
    target: { kind: "window", match: { titleIncludes: "notepad" } },
    maintain: ["target.exists"],
    guards: ["target.identityStable"],
    guardPolicy: "block",
    maxEnvelopeTokens: 0,
    salience: "background",
  };
  return {
    lensId: "auto-test-lens",
    spec,
    binding: { hwnd: "12345", windowTitle: "Untitled - Notepad" },
    boundIdentity: { hwnd: "12345", pid: 1, processName: "notepad.exe", processStartTimeMs: 0, titleResolved: "Untitled - Notepad" },
    fluentKeys: [],
    registeredAtSeq: 0,
    registeredAtMs: Date.now(),
  };
}

function makeOkGuardResult() {
  return { ok: true, policy: "block" as const, attention: "ok" as const, results: [], failedGuard: undefined };
}

function makeFailGuardResult(failedKind: string) {
  const failedGuard = { kind: failedKind as import("../../src/engine/perception/types.js").GuardKind, ok: false, confidence: 0, reason: "test" };
  return { ok: false, policy: "block" as const, attention: "guard_failed" as const, results: [failedGuard], failedGuard };
}

describe("isAutoGuardEnabled", () => {
  it("returns true by default", () => {
    delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    expect(isAutoGuardEnabled()).toBe(true);
  });

  it("returns false when DESKTOP_TOUCH_AUTO_GUARD=0", () => {
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    expect(isAutoGuardEnabled()).toBe(false);
    delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  });
});

describe("runActionGuard", () => {
  beforeEach(() => {
    delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    mockResolveActionTarget.mockReset();
    mockEvaluateGuards.mockReset();
  });

  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  });

  it("returns unguarded when env flag is OFF", async () => {
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    const result = await runActionGuard({
      toolName: "mouse_click",
      actionKind: "mouseClick",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    expect(result.block).toBe(false);
    expect(result.summary.status).toBe("unguarded");
    expect(mockResolveActionTarget).not.toHaveBeenCalled();
  });

  it("returns unguarded when descriptor is null", async () => {
    const result = await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: null,
    });
    expect(result.block).toBe(false);
    expect(result.summary.status).toBe("unguarded");
  });

  it("blocks with needs_escalation for browserTab + keyboard", async () => {
    const result = await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "browserTab", port: 9222 },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("needs_escalation");
    expect(mockResolveActionTarget).not.toHaveBeenCalled();
  });

  it("blocks with target_not_found when resolve returns 0 candidates", async () => {
    mockResolveActionTarget.mockResolvedValue({
      lens: null, localStore: null, identity: null, candidates: 0, warnings: [],
    });
    const result = await runActionGuard({
      toolName: "mouse_click",
      actionKind: "mouseClick",
      descriptor: { kind: "window", titleIncludes: "missing-app" },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("target_not_found");
  });

  it("blocks ambiguous_target for keyboard with multiple candidates", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 3, warnings: [],
    });
    const result = await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("ambiguous_target");
  });

  it("continues for mouseClick with multiple candidates (coordinate disambiguates)", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 2, warnings: ["2 windows match"],
    });
    mockEvaluateGuards.mockReturnValue(makeOkGuardResult());
    const result = await runActionGuard({
      toolName: "mouse_click",
      actionKind: "mouseClick",
      descriptor: { kind: "coordinate", x: 100, y: 100, windowTitle: "notepad" },
      clickCoordinates: { x: 100, y: 100 },
    });
    expect(result.block).toBe(false);
    expect(result.summary.status).toBe("ok");
  });

  it("maps identity_changed guard failure to correct status", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeFailGuardResult("target.identityStable"));
    const result = await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("identity_changed");
  });

  it("maps unsafe_coordinates guard failure to correct status", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeFailGuardResult("safe.clickCoordinates"));
    const result = await runActionGuard({
      toolName: "mouse_click",
      actionKind: "mouseClick",
      descriptor: { kind: "coordinate", x: 999, y: 999 },
      clickCoordinates: { x: 999, y: 999 },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("unsafe_coordinates");
  });

  it("maps browser_not_ready guard failure to correct status", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeFailGuardResult("browser.ready"));
    const result = await runActionGuard({
      toolName: "browser_click_element",
      actionKind: "browserCdp",
      descriptor: { kind: "browserTab", port: 9222 },
    });
    expect(result.block).toBe(true);
    expect(result.summary.status).toBe("browser_not_ready");
  });

  it("returns ok when all guards pass", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeOkGuardResult());
    const result = await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    expect(result.block).toBe(false);
    expect(result.summary.status).toBe("ok");
    expect(result.summary.canContinue).toBe(true);
  });

  it("propagates foregroundVerified into the guard context", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeOkGuardResult());
    await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
      foregroundVerified: true,
    });
    const ctxArg = mockEvaluateGuards.mock.calls.at(-1)?.[3];
    expect(ctxArg).toMatchObject({ foregroundVerified: true, toolName: "keyboard_type" });
  });

  it("does not set foregroundVerified when caller omits it", async () => {
    const lens = makeFakeLens();
    mockResolveActionTarget.mockResolvedValue({
      lens, localStore: new FluentStore(), identity: null, candidates: 1, warnings: [],
    });
    mockEvaluateGuards.mockReturnValue(makeOkGuardResult());
    await runActionGuard({
      toolName: "keyboard_type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    const ctxArg = mockEvaluateGuards.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(ctxArg).toBeDefined();
    expect("foregroundVerified" in ctxArg).toBe(false);
  });
});

