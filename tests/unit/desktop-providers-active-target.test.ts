import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  fetchUiaCandidates: vi.fn(),
  fetchBrowserCandidates: vi.fn(),
  fetchTerminalCandidates: vi.fn(),
  fetchVisualCandidates: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: mocks.resolveWindowTarget,
}));

vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({
  fetchUiaCandidates: mocks.fetchUiaCandidates,
}));

vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({
  fetchBrowserCandidates: mocks.fetchBrowserCandidates,
}));

vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({
  fetchTerminalCandidates: mocks.fetchTerminalCandidates,
}));

vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({
  fetchVisualCandidates: mocks.fetchVisualCandidates,
}));

import { composeCandidates } from "../../src/tools/desktop-providers/compose-providers.js";

function candidate(
  label: string,
  source: UiEntityCandidate["source"],
  targetId: string
): UiEntityCandidate {
  return {
    source,
    target: { kind: "window", id: targetId },
    label,
    role: "button",
    actionability: ["invoke", "click"],
    confidence: 0.9,
    observedAtMs: 1000,
    provisional: false,
    digest: `${source}:${label}:${targetId}`,
    rect: { x: 10, y: 20, width: 30, height: 40 },
  };
}

beforeEach(() => {
  mocks.resolveWindowTarget.mockReset();
  mocks.fetchUiaCandidates.mockReset();
  mocks.fetchBrowserCandidates.mockReset();
  mocks.fetchTerminalCandidates.mockReset();
  mocks.fetchVisualCandidates.mockReset();

  mocks.resolveWindowTarget.mockResolvedValue({
    title: "Notepad",
    hwnd: 123n,
    warnings: [],
  });
  mocks.fetchUiaCandidates.mockResolvedValue({
    candidates: [candidate("Save", "uia", "123")],
    warnings: [],
  });
  mocks.fetchBrowserCandidates.mockResolvedValue({
    candidates: [candidate("Browser", "cdp", "tab-1")],
    warnings: [],
  });
  mocks.fetchTerminalCandidates.mockResolvedValue({
    candidates: [candidate("PS C:\\>", "terminal", "123")],
    warnings: [],
  });
  mocks.fetchVisualCandidates.mockResolvedValue({
    candidates: [],
    warnings: [],
  });
});

describe("composeCandidates — active target fallback", () => {
  it("hwnd-only target resolves the live title before terminal routing", async () => {
    mocks.resolveWindowTarget.mockResolvedValue({
      title: "Windows Terminal",
      hwnd: 321n,
      warnings: [],
    });

    await composeCandidates({ hwnd: "321" });

    expect(mocks.resolveWindowTarget).toHaveBeenCalledWith({ hwnd: "321" });
    expect(mocks.fetchTerminalCandidates).toHaveBeenCalledWith({ hwnd: "321", windowTitle: "Windows Terminal" });
    expect(mocks.fetchUiaCandidates).toHaveBeenCalledWith({ hwnd: "321", windowTitle: "Windows Terminal" });
    expect(mocks.fetchVisualCandidates).toHaveBeenCalledWith({ hwnd: "321", windowTitle: "Windows Terminal" });
    expect(mocks.fetchBrowserCandidates).not.toHaveBeenCalled();
  });

  it("omitted target resolves @active and routes the resolved native window", async () => {
    const result = await composeCandidates(undefined);

    expect(mocks.resolveWindowTarget).toHaveBeenCalledWith({ windowTitle: "@active" });
    expect(mocks.fetchUiaCandidates).toHaveBeenCalledWith({ hwnd: "123", windowTitle: "Notepad" });
    expect(mocks.fetchVisualCandidates).toHaveBeenCalledWith({ hwnd: "123", windowTitle: "Notepad" });
    expect(mocks.fetchTerminalCandidates).not.toHaveBeenCalled();
    expect(mocks.fetchBrowserCandidates).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("resolved active terminal title routes through the terminal path", async () => {
    mocks.resolveWindowTarget.mockResolvedValue({
      title: "PowerShell 7",
      hwnd: 456n,
      warnings: [],
    });

    await composeCandidates({});

    expect(mocks.fetchTerminalCandidates).toHaveBeenCalledWith({ hwnd: "456", windowTitle: "PowerShell 7" });
    expect(mocks.fetchUiaCandidates).toHaveBeenCalledWith({ hwnd: "456", windowTitle: "PowerShell 7" });
    expect(mocks.fetchVisualCandidates).toHaveBeenCalledWith({ hwnd: "456", windowTitle: "PowerShell 7" });
    expect(mocks.fetchBrowserCandidates).not.toHaveBeenCalled();
  });

  it("prepends active-target resolution warnings ahead of provider warnings", async () => {
    mocks.resolveWindowTarget.mockResolvedValue({
      title: "Notepad",
      hwnd: 999n,
      warnings: ["@active resolved to the CLI host window."],
    });
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_no_elements"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [candidate("Start", "visual_gpu", "999")],
      warnings: [],
    });

    const result = await composeCandidates(undefined);

    expect(result.warnings[0]).toBe("@active resolved to the CLI host window.");
    expect(result.warnings).toContain("uia_no_elements");
    expect(result.warnings).toContain("partial_results_only");
  });

  it("returns no_provider_matched when @active cannot be resolved", async () => {
    mocks.resolveWindowTarget.mockRejectedValue(new Error("WindowNotFound"));

    const result = await composeCandidates(undefined);

    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toEqual(["no_provider_matched"]);
    expect(mocks.fetchUiaCandidates).not.toHaveBeenCalled();
    expect(mocks.fetchVisualCandidates).not.toHaveBeenCalled();
    expect(mocks.fetchTerminalCandidates).not.toHaveBeenCalled();
    expect(mocks.fetchBrowserCandidates).not.toHaveBeenCalled();
  });
});
