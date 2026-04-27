/**
 * tests/unit/keyboard-guard-evaluation.test.ts
 *
 * Unit tests for evaluateKeyboardGuards (Focus Leash Phase A — PR #64 fix).
 *
 * Codex flagged that BG path (terminal-class auto-pick) was returning success
 * before the foreground guard block ran, silently bypassing lensId / auto-guard
 * for default-auto terminal calls. The helper centralizes guard evaluation so
 * BG path can call it before WM_CHAR send. These tests cover every branch:
 *   - explicit lensId: pass / block / unblock-with-warn
 *   - no lensId + auto-guard:
 *       skipAutoGuard=true → no call
 *       isAutoGuardEnabled=false → no call
 *       isAutoGuardEnabled=true + block / pass
 *       foregroundVerified=true / false propagation to runActionGuard
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock perception registry — only the two guard helpers used by the helper.
vi.mock("../../src/engine/perception/registry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/engine/perception/registry.js")
  >("../../src/engine/perception/registry.js");
  return {
    ...actual,
    evaluatePreToolGuards: vi.fn(),
    buildEnvelopeFor: vi.fn(),
  };
});

// Mock _action-guard — preserve other exports (validateAndPrepareFix, consumeFix).
vi.mock("../../src/tools/_action-guard.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_action-guard.js")
  >("../../src/tools/_action-guard.js");
  return {
    ...actual,
    runActionGuard: vi.fn(),
    isAutoGuardEnabled: vi.fn(),
  };
});

import { evaluateKeyboardGuards } from "../../src/tools/keyboard.js";
import {
  evaluatePreToolGuards,
  buildEnvelopeFor,
} from "../../src/engine/perception/registry.js";
import {
  runActionGuard,
  isAutoGuardEnabled,
} from "../../src/tools/_action-guard.js";

// Shape helpers — tests don't depend on the exact perception envelope contents,
// just that the same value flows through.
const FAKE_ENV = { kind: "fake-perception-envelope" } as any;
const FAKE_AG_SUMMARY = { kind: "fake-action-guard-summary", next: "" } as any;

describe("evaluateKeyboardGuards (Focus Leash Phase A — PR #64 Codex fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAutoGuardEnabled).mockReturnValue(false);
    vi.mocked(buildEnvelopeFor).mockReturnValue(FAKE_ENV);
  });

  describe("with lensId", () => {
    it("guard.ok=true → returns { ok:true, perceptionEnv }", async () => {
      vi.mocked(evaluatePreToolGuards).mockResolvedValue({
        ok: true,
        policy: "allow",
      } as any);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: "L1",
        skipAutoGuard: false,
        effectiveWindowTitle: "PowerShell",
        foregroundVerified: true,
        warnings: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.perceptionEnv).toBe(FAKE_ENV);
      expect(evaluatePreToolGuards).toHaveBeenCalledWith(
        "L1",
        "keyboard:type",
        {},
      );
      // auto-guard path must be untouched when lensId is provided
      expect(runActionGuard).not.toHaveBeenCalled();
    });

    it("guard blocked → returns { ok:false, errorResult }", async () => {
      vi.mocked(evaluatePreToolGuards).mockResolvedValue({
        ok: false,
        policy: "block",
        failedGuard: { reason: "modal_blocking" },
      } as any);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: "L1",
        skipAutoGuard: false,
        effectiveWindowTitle: "PowerShell",
        foregroundVerified: true,
        warnings: ["pre-existing-warning"],
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errorResult).toBeDefined();
    });

    it("guard.ok=false but policy != block → treated as pass (warn-only)", async () => {
      vi.mocked(evaluatePreToolGuards).mockResolvedValue({
        ok: false,
        policy: "warn",
      } as any);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:press",
        lensId: "L2",
        skipAutoGuard: false,
        effectiveWindowTitle: "cmd",
        foregroundVerified: true,
        warnings: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.perceptionEnv).toBe(FAKE_ENV);
    });
  });

  describe("without lensId — auto-guard path", () => {
    it("skipAutoGuard=true → returns { ok:true } no perception, no calls", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: true,
        effectiveWindowTitle: "Notepad",
        foregroundVerified: false,
        warnings: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.perceptionEnv).toBeUndefined();
      expect(runActionGuard).not.toHaveBeenCalled();
      expect(evaluatePreToolGuards).not.toHaveBeenCalled();
    });

    it("isAutoGuardEnabled=false → returns { ok:true } no perception, no calls", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(false);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "Notepad",
        foregroundVerified: false,
        warnings: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.perceptionEnv).toBeUndefined();
      expect(runActionGuard).not.toHaveBeenCalled();
    });

    it("auto-guard pass → returns { ok:true, perceptionEnv: ag.summary }", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: false,
        summary: FAKE_AG_SUMMARY,
      } as any);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "PowerShell",
        foregroundVerified: true,
        warnings: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.perceptionEnv).toBe(FAKE_AG_SUMMARY);
    });

    it("auto-guard block → returns { ok:false, errorResult }", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: true,
        summary: { ...FAKE_AG_SUMMARY, next: "Modal blocking input" },
      } as any);
      const out = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "Notepad",
        foregroundVerified: false,
        warnings: ["w1"],
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.errorResult).toBeDefined();
    });

    it("foregroundVerified=true is forwarded to runActionGuard (BG path semantic)", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: false,
        summary: FAKE_AG_SUMMARY,
      } as any);
      await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "PowerShell",
        foregroundVerified: true,
        warnings: [],
      });
      const call = vi.mocked(runActionGuard).mock.calls[0][0];
      expect(call.foregroundVerified).toBe(true);
    });

    it("foregroundVerified=false is omitted (not forwarded as false)", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: false,
        summary: FAKE_AG_SUMMARY,
      } as any);
      await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "Notepad",
        foregroundVerified: false,
        warnings: [],
      });
      const call = vi.mocked(runActionGuard).mock.calls[0][0];
      // Original code uses `...(foregroundVerified && {foregroundVerified:true})`,
      // so when foregroundVerified=false the key is absent (undefined on the object).
      expect(call.foregroundVerified).toBeUndefined();
    });

    it("descriptor is null when effectiveWindowTitle missing", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: false,
        summary: FAKE_AG_SUMMARY,
      } as any);
      await evaluateKeyboardGuards({
        toolName: "keyboard:press",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: undefined,
        foregroundVerified: false,
        warnings: [],
      });
      const call = vi.mocked(runActionGuard).mock.calls[0][0];
      expect(call.descriptor).toBeNull();
    });

    it("toolName flows through to runActionGuard", async () => {
      vi.mocked(isAutoGuardEnabled).mockReturnValue(true);
      vi.mocked(runActionGuard).mockResolvedValue({
        block: false,
        summary: FAKE_AG_SUMMARY,
      } as any);
      await evaluateKeyboardGuards({
        toolName: "keyboard:press",
        lensId: undefined,
        skipAutoGuard: false,
        effectiveWindowTitle: "x",
        foregroundVerified: true,
        warnings: [],
      });
      const call = vi.mocked(runActionGuard).mock.calls[0][0];
      expect(call.toolName).toBe("keyboard:press");
      expect(call.actionKind).toBe("keyboard");
    });
  });
});
