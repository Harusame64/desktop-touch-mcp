/**
 * internal #288 — a frozen window UIA could not read is named as frozen, not as a failed provider.
 *
 * MEASURED by win2 (2026-10-27, published v2.3.3, a frozen Settings window): by its handle, UIA read
 * blind, OCR refused the frozen window, and the zero reason was `window_frozen`. By its title, UIA
 * answered "Window not found" (the cloaked window is not among UI Automation's top-level children),
 * the OCR lane — the only one that asked whether the window is frozen — was skipped as
 * `uia_not_blind`, and the reason was `all_providers_failed`, which tells the caller to change
 * providers. In `windows[]` the title's first window in Z-order was the frozen content (68014), the
 * frame (264580) after it, as for the Xbox pair.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  findOcrWindowByTitle: vi.fn(),
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
  findOcrWindowByTitle: mocks.findOcrWindowByTitle,
}));
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
  isWindowProcessFrozen: mocks.isWindowProcessFrozen,
}));

import { composeCandidates } from "../../src/tools/desktop-providers/compose-providers.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";
import { fetchUiaCandidates } from "../../src/tools/desktop-providers/uia-provider.js";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import { fetchOcrCandidates } from "../../src/tools/desktop-providers/ocr-provider.js";

const FROZEN = 68014n;
const FRAME = 264580n;
const frozen = (h: bigint) => h === FROZEN;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWindowTarget.mockResolvedValue(null);
  mocks.isWindowProcessFrozen.mockImplementation(frozen);
  vi.mocked(fetchVisualCandidates).mockResolvedValue({ candidates: [], warnings: [] });
  vi.mocked(fetchOcrCandidates).mockResolvedValue({ candidates: [], warnings: [] });
});

const uiaFails = () => vi.mocked(fetchUiaCandidates).mockResolvedValue({ candidates: [], warnings: ["uia_provider_failed"] });
const reasonOf = (warnings: string[]) => deriveViewConstraints(warnings, 0)?.entityZeroReason;

describe("UIA could not read the target: discover still asks whether its window is frozen", () => {
  it("by title: the title's window is frozen → window_frozen, with nothing captured", async () => {
    uiaFails();
    mocks.findOcrWindowByTitle.mockReturnValue({ hwnd: FROZEN, title: "設定" });
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(mocks.findOcrWindowByTitle).toHaveBeenCalledWith("設定");
    expect(result.warnings).toContain("target_window_frozen");
    expect(reasonOf(result.warnings)).toBe("window_frozen");
    expect(fetchOcrCandidates).not.toHaveBeenCalled();
  });

  it("by title: the title's window is running → the reason stays all_providers_failed", async () => {
    uiaFails();
    mocks.findOcrWindowByTitle.mockReturnValue({ hwnd: FRAME, title: "設定" });
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(result.warnings).not.toContain("target_window_frozen");
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
    expect(fetchOcrCandidates).not.toHaveBeenCalled();
  });

  it("by title: nothing has the title → the reason stays all_providers_failed", async () => {
    uiaFails();
    mocks.findOcrWindowByTitle.mockReturnValue(undefined);
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
    expect(mocks.isWindowProcessFrozen).not.toHaveBeenCalled();
  });

  it("by handle: the pinned window is the one asked about, not the title's", async () => {
    uiaFails();
    mocks.findOcrWindowByTitle.mockReturnValue({ hwnd: FRAME, title: "設定" });
    const result = await composeCandidates({ hwnd: String(FROZEN), windowTitle: "設定" });
    expect(mocks.isWindowProcessFrozen).toHaveBeenCalledWith(FROZEN);
    expect(mocks.findOcrWindowByTitle).not.toHaveBeenCalled();
    expect(reasonOf(result.warnings)).toBe("window_frozen");
  });

  it("a test that throws is no answer: the reason stays all_providers_failed", async () => {
    uiaFails();
    mocks.findOcrWindowByTitle.mockImplementation(() => { throw new Error("enum failed"); });
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(reasonOf(result.warnings)).toBe("all_providers_failed");
  });

  it("UIA read the window: the test is not made (OCR is not the lane for it, and nothing changes)", async () => {
    vi.mocked(fetchUiaCandidates).mockResolvedValue({ candidates: [], warnings: [] });
    mocks.findOcrWindowByTitle.mockReturnValue({ hwnd: FROZEN, title: "設定" });
    const result = await composeCandidates({ windowTitle: "設定" });
    expect(mocks.isWindowProcessFrozen).not.toHaveBeenCalled();
    expect(result.warnings).not.toContain("target_window_frozen");
  });
});
