/**
 * internal #247 — a window whose app Windows has frozen is not read as if it showed its contents.
 *
 * MEASURED by win2 (2026-10-04, internal `spike/247-cloaked-windows`): hidden Settings had every
 * thread suspended, read 0 UIA elements, and `desktop_discover` OCRed its last frame into 28
 * elements — the account name among them — while two captures 5 s apart differed by 0 px. The
 * window list showed it as an ordinary window. A window on another virtual desktop is hidden too and
 * still running (its capture is current), so the test is the frozen process (`IsFrozen`, 0x58 vs
 * 0x68/0x8/0x0), not the hiding.
 *
 * This file holds the parts above the capture: the window list, the discover constraints, and the
 * OCR lane. The capture entries are in `a-frozen-window-is-not-captured-for-ocr.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runSomPipeline: vi.fn() }));

vi.mock("../../src/engine/ocr-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>();
  return { ...actual, runSomPipeline: mocks.runSomPipeline };
});

import { createCachedProductionWindowsProvider } from "../../src/tools/desktop-register.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";
import { fetchOcrCandidates } from "../../src/tools/desktop-providers/ocr-provider.js";
import { WindowFrozenError } from "../../src/engine/window-frozen.js";
import type { WindowZInfo } from "../../src/engine/win32.js";

function win(hwnd: bigint, over: Partial<WindowZInfo> = {}): WindowZInfo {
  return {
    hwnd,
    title: `w${hwnd}`,
    zOrder: 0,
    region: { x: 0, y: 1, width: 884, height: 591 },
    isActive: false,
    isMinimized: false,
    isMaximized: false,
    ...over,
  } as WindowZInfo;
}

describe("the window list says which windows are hidden, and which of those are frozen", () => {
  const listed = (wins: WindowZInfo[], frozen: Record<string, boolean | null>) => {
    const isFrozen = vi.fn((h: bigint) => frozen[String(h)] ?? null);
    const provider = createCachedProductionWindowsProvider({
      ttlMs: 0,
      enumerate: () => wins,
      resolveProcessName: () => undefined,
      isFrozen,
    });
    return { rows: provider(), isFrozen };
  };

  it("marks a hidden, frozen window with both, and a hidden running one with isCloaked only", () => {
    const { rows } = listed(
      [win(527016n, { isCloaked: true }), win(67756n, { isCloaked: true })],
      { "527016": true, "67756": false },
    );
    expect(rows[0]).toMatchObject({ hwnd: "527016", isCloaked: true, isFrozen: true });
    expect(rows[1]).toMatchObject({ hwnd: "67756", isCloaked: true });
    expect(rows[1]).not.toHaveProperty("isFrozen");
  });

  it("adds neither to a window that is not hidden, and does not ask whether it is frozen", () => {
    const { rows, isFrozen } = listed([win(657818n), win(1n, { isCloaked: false })], { "657818": true, "1": true });
    for (const row of rows) {
      expect(row).not.toHaveProperty("isCloaked");
      expect(row).not.toHaveProperty("isFrozen");
    }
    expect(isFrozen).not.toHaveBeenCalled();
  });

  it("does not say frozen when it cannot tell", () => {
    const { rows } = listed([win(9n, { isCloaked: true })], { "9": null });
    expect(rows[0]).toMatchObject({ isCloaked: true });
    expect(rows[0]).not.toHaveProperty("isFrozen");
  });
});

describe("discover's constraints name a frozen window", () => {
  it("answers entityZeroReason window_frozen when nothing was read", () => {
    expect(deriveViewConstraints(["uia_blind_too_few_elements", "target_window_frozen"], 0)).toMatchObject({
      window: "window_frozen",
      entityZeroReason: "window_frozen",
    });
  });

  it("gives way to an excluded or a gone window, whose remedies are the ones that hold", () => {
    expect(deriveViewConstraints(["window_excluded", "target_window_frozen"], 0)?.entityZeroReason).toBe("window_excluded");
    expect(deriveViewConstraints(["target_window_frozen", "target_window_gone"], 0)?.entityZeroReason).toBe("target_window_gone");
  });
});

describe("the OCR lane reads nothing from a frozen window, and says why", () => {
  it("answers skipped with target_window_frozen, not a failed provider", async () => {
    mocks.runSomPipeline.mockReset().mockRejectedValue(new WindowFrozenError("runSomPipeline"));
    const result = await fetchOcrCandidates({ hwnd: "527016" });
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toContain("target_window_frozen");
    expect(result.warnings).not.toContain("ocr_provider_failed");
    expect(JSON.stringify(result)).toContain("window_frozen");
  });

  it("still answers ocr_provider_failed for any other throw", async () => {
    mocks.runSomPipeline.mockReset().mockRejectedValue(new Error("capture failed"));
    const result = await fetchOcrCandidates({ hwnd: "527016" });
    expect(result.warnings).toContain("ocr_provider_failed");
    expect(result.warnings).not.toContain("target_window_frozen");
  });
});
