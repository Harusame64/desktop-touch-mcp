/**
 * internal #288 — a frozen window UIA could not read is named as frozen, not as a failed provider.
 *
 * MEASURED by win2 (2026-10-27, published v2.3.3, a frozen Settings window): by its handle, UIA read
 * blind, OCR refused the frozen window, and the zero reason was `window_frozen`. By its title, UIA
 * answered "Window not found" (the cloaked window is not among UI Automation's top-level children),
 * the OCR lane — the only one that asked whether the window is frozen — was skipped as
 * `uia_not_blind`, and the reason was `all_providers_failed`, which tells the caller to change
 * providers. Both windows titled 設定 were cloaked: the frozen content (68014) and the packaged app's
 * frame (264580, ApplicationFrameHost, never frozen).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  findOcrWindowsByTitle: vi.fn(),
  enumWindowsInZOrder: vi.fn(),
  isWindowProcessFrozen: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: mocks.resolveWindowTarget,
  findPlainTopLevelWindowsByTitle: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({ fetchVisualCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/ocr-provider.js", () => ({ fetchOcrCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: vi.fn() }));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getUiElements: vi.fn().mockResolvedValue({ elements: [], elementCount: 0, windowRect: null }),
  detectUiaBlind: vi.fn().mockReturnValue({ blind: false }),
}));
vi.mock("../../src/engine/ocr-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>()),
  findOcrWindowsByTitle: mocks.findOcrWindowsByTitle,
}));
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: mocks.enumWindowsInZOrder,
  isWindowProcessFrozen: mocks.isWindowProcessFrozen,
}));

import { composeCandidates } from "../../src/tools/desktop-providers/compose-providers.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";
import { fetchUiaCandidates } from "../../src/tools/desktop-providers/uia-provider.js";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import { fetchOcrCandidates } from "../../src/tools/desktop-providers/ocr-provider.js";

const CONTENT = { hwnd: 68014n, title: "設定", isCloaked: true };      // SystemSettings, frozen
const FRAME = { hwnd: 264580n, title: "設定", isCloaked: true };       // ApplicationFrameHost, never frozen
const STEAM = { hwnd: 5000n, title: "Steam Settings", isCloaked: false }; // shown and running
const FROZEN = new Set([CONTENT.hwnd]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWindowTarget.mockResolvedValue(null);
  mocks.isWindowProcessFrozen.mockImplementation((h: bigint) => FROZEN.has(h));
  mocks.enumWindowsInZOrder.mockReturnValue([FRAME, CONTENT, STEAM]);
  vi.mocked(fetchVisualCandidates).mockResolvedValue({ candidates: [], warnings: [] });
  vi.mocked(fetchOcrCandidates).mockResolvedValue({ candidates: [], warnings: [] });
});

const uiaFails = () => vi.mocked(fetchUiaCandidates).mockResolvedValue({ candidates: [], warnings: ["uia_provider_failed"] });
const reasonOf = (warnings: string[]) => deriveViewConstraints(warnings, 0)?.entityZeroReason;

describe("UIA could not read the target: discover asks whether the hidden window it names is frozen", () => {
  it("by title: every window the title names is hidden and one is frozen → window_frozen, even with the frame first", async () => {
    uiaFails();
    mocks.findOcrWindowsByTitle.mockReturnValue([FRAME, CONTENT]);
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(mocks.findOcrWindowsByTitle).toHaveBeenCalledWith("設定");
    expect(result.warnings).toContain("target_window_frozen");
    expect(reasonOf(result.warnings)).toBe("window_frozen");
    expect(fetchOcrCandidates).not.toHaveBeenCalled();
  });

  it("by title: a shown window has the title too → not asked (UIA failed on that one; the frozen one is another app)", async () => {
    uiaFails();
    mocks.findOcrWindowsByTitle.mockReturnValue([CONTENT, STEAM]);
    const result = await composeCandidates({ windowTitle: "settings" });
    expect(result.warnings).not.toContain("target_window_frozen");
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
  });

  it("by title: hidden but running (Xbox) → the reason stays all_providers_failed", async () => {
    uiaFails();
    mocks.findOcrWindowsByTitle.mockReturnValue([FRAME]);
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(result.warnings).not.toContain("target_window_frozen");
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
  });

  it("by title: nothing has the title, or it is @active → nothing is asked", async () => {
    uiaFails();
    mocks.findOcrWindowsByTitle.mockReturnValue([]);
    expect(reasonOf((await composeCandidates({ windowTitle: "設定" })).warnings)).toBe("all_providers_failed");
    expect(reasonOf((await composeCandidates({ windowTitle: "@active" })).warnings)).toBe("all_providers_failed");
    expect(mocks.findOcrWindowsByTitle).toHaveBeenCalledTimes(1);
    expect(mocks.isWindowProcessFrozen).not.toHaveBeenCalled();
  });

  it("by handle: the pinned window is the one asked about, not the title's", async () => {
    uiaFails();
    const result = await composeCandidates({ hwnd: String(CONTENT.hwnd), windowTitle: "Steam" });
    expect(mocks.findOcrWindowsByTitle).not.toHaveBeenCalled();
    expect(reasonOf(result.warnings)).toBe("window_frozen");
  });

  it("by handle: a shown window whose process is suspended (a debugger) is not called frozen", async () => {
    uiaFails();
    FROZEN.add(STEAM.hwnd);
    try {
      const result = await composeCandidates({ hwnd: String(STEAM.hwnd) });
      expect(result.warnings).not.toContain("target_window_frozen");
    } finally {
      FROZEN.delete(STEAM.hwnd);
    }
  });

  it("a test that throws is no answer: the reason stays all_providers_failed", async () => {
    uiaFails();
    mocks.findOcrWindowsByTitle.mockImplementation(() => { throw new Error("enum failed"); });
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
  });

  it("UIA read the window: the test is not made (OCR is not the lane for it, and nothing changes)", async () => {
    vi.mocked(fetchUiaCandidates).mockResolvedValue({ candidates: [], warnings: [] });
    mocks.findOcrWindowsByTitle.mockReturnValue([CONTENT]);
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(mocks.isWindowProcessFrozen).not.toHaveBeenCalled();
    expect(result.warnings).not.toContain("target_window_frozen");
  });
});
