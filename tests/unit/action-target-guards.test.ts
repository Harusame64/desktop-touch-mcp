/**
 * tests/unit/action-target-guards.test.ts
 *
 * Verifies the ephemeral lens spec built by resolveActionTarget carries the
 * right guard list per action kind.
 *
 * Specifically: keyboard actions must NOT include safe.keyboardTarget in the
 * auto-guard path. When the MCP server runs as a child of a foreground-locked
 * host (MSIX / AppContainer), the foreground fluent cannot be trusted after a
 * SetForegroundWindow call, so safe.keyboardTarget would turn every
 * keyboard_type into needs_escalation. target.identityStable plus
 * focusWindowForKeyboard's best-effort focus handle the remaining safety.
 */

import { describe, it, expect, vi } from "vitest";

// Mock Win32 so the test does not enumerate real windows.
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => [
    { hwnd: "100", title: "Untitled - Notepad", zOrder: 0, isActive: true },
  ]),
}));

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: vi.fn(() => []),
  buildWindowIdentity: vi.fn(() => ({
    hwnd: "100",
    pid: 1234,
    processName: "notepad.exe",
    processStartTimeMs: 1700000000000,
    titleResolved: "Untitled - Notepad",
  })),
}));

// Import after mocking so the mocks are applied.
import { resolveActionTarget } from "../../src/engine/perception/action-target.js";

describe("resolveActionTarget ephemeral spec guards", () => {
  it("keyboard action kind omits safe.keyboardTarget from spec.guards", async () => {
    const result = await resolveActionTarget(
      { kind: "window", titleIncludes: "Notepad" },
      { actionKind: "keyboard" }
    );
    expect(result.lens).not.toBeNull();
    expect(result.lens!.spec.guards).not.toContain("safe.keyboardTarget");
  });

  it("keyboard action kind keeps target.identityStable in spec.guards", async () => {
    const result = await resolveActionTarget(
      { kind: "window", titleIncludes: "Notepad" },
      { actionKind: "keyboard" }
    );
    expect(result.lens).not.toBeNull();
    expect(result.lens!.spec.guards).toContain("target.identityStable");
  });

  it("mouseClick action kind includes safe.clickCoordinates + target.identityStable", async () => {
    const result = await resolveActionTarget(
      { kind: "window", titleIncludes: "Notepad" },
      { actionKind: "mouseClick" }
    );
    expect(result.lens).not.toBeNull();
    expect(result.lens!.spec.guards).toContain("safe.clickCoordinates");
    expect(result.lens!.spec.guards).toContain("target.identityStable");
    expect(result.lens!.spec.guards).not.toContain("safe.keyboardTarget");
  });

  it("uiaInvoke action kind still excludes safe.keyboardTarget", async () => {
    const result = await resolveActionTarget(
      { kind: "window", titleIncludes: "Notepad" },
      { actionKind: "uiaInvoke" }
    );
    expect(result.lens).not.toBeNull();
    expect(result.lens!.spec.guards).not.toContain("safe.keyboardTarget");
    expect(result.lens!.spec.guards).toContain("target.identityStable");
  });
});
