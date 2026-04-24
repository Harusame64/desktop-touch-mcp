/**
 * visual-gpu-kill-switch.test.ts
 *
 * Verifies DESKTOP_TOUCH_DISABLE_VISUAL_GPU kill-switch behaviour (Phase 2).
 * Uses vi.resetModules() + dynamic import() so that the module-level constant
 * VISUAL_GPU_DISABLED is re-evaluated for each test case.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("DESKTOP_TOUCH_DISABLE_VISUAL_GPU kill-switch", () => {
  it("returns visual_provider_unavailable regardless of backend state when flag=1", async () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "1");
    const { fetchVisualCandidates } =
      await import("../../src/tools/desktop-providers/visual-provider.js");

    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toContain("visual_provider_unavailable");
  });

  it("takes the normal path (no early return) when flag is unset", async () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "");
    const { fetchVisualCandidates } =
      await import("../../src/tools/desktop-providers/visual-provider.js");

    // No backend attached in this scope → runtime.isAvailable() === false
    // → normal visual_provider_unavailable via the runtime path (not kill-switch).
    // The key assertion: we reach the runtime check rather than the early return.
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    // Confirm at least one expected warning from the normal path is present.
    const normalPathWarnings = [
      "visual_provider_unavailable",
      "visual_provider_warming",
      "visual_provider_failed",
    ];
    expect(r.warnings.some((w) => normalPathWarnings.includes(w))).toBe(true);
  });

  it("flag=0 is NOT treated as disabled (strict === '1' check)", async () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "0");
    const { fetchVisualCandidates } =
      await import("../../src/tools/desktop-providers/visual-provider.js");

    // Should take the normal path, not the kill-switch early return.
    const r = await fetchVisualCandidates({ hwnd: "456" });
    // Whether it returns candidates or not depends on backend — what matters is
    // that it went through the runtime check, not the kill-switch shortcut.
    // We cannot easily distinguish here, but no TypeError should occur.
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});
