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

/** ADR-036 item 5 — swapped by the cell that makes the window move mid-read. */
const rectRef = vi.hoisted(() => ({ value: { x: 100, y: 200, width: 600, height: 400 } as { x: number; y: number; width: number; height: number } }));

// ADR-036 — the two reads the ingress takes WITH the observation, so the cell below can tell
// "stamped on the result" from "the machine could not answer". Everything else in `win32` stays
// real: only these four are asked for on this path.
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getWindowIdentity: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 111 })),
    getWindowClassName: vi.fn(() => "Notepad"),
    getWindowTitleW: vi.fn(() => "Untitled - Notepad"),
    getWindowRectByHwnd: vi.fn(() => rectRef.value),
  };
});

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

// ── H4: visual escalation warnings ───────────────────────────────────────────
// H4 targets dogfood incidents Z-1 (Outlook PWA — S2) and Z-2 (Electron Codex — S5):
//   single-giant-pane / UIA-blind + no CDP → desktop_see returned 0 entities with
//   no explanation. These tests verify that compose surfaces escalation warnings
//   so LLM / operator can understand why and fall back to OCR / V1 tools.

describe("composeCandidates — H4 visual escalation (uia-blind + visual state)", () => {
  it("emits visual_not_attempted when uia is blind (single-giant-pane) and visual is unavailable", async () => {
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_blind_single_pane", "uia_no_elements"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["visual_provider_unavailable"],
    });
    const result = await composeCandidates({ hwnd: "999" });
    expect(result.warnings).toContain("uia_blind_single_pane");
    expect(result.warnings).toContain("visual_provider_unavailable");
    expect(result.warnings).toContain("visual_not_attempted");
  });

  it("emits visual_not_attempted when uia is blind (too-few-elements) and visual is unavailable", async () => {
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_blind_too_few_elements", "uia_no_elements"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["visual_provider_warming"],
    });
    const result = await composeCandidates({ hwnd: "999" });
    expect(result.warnings).toContain("uia_blind_too_few_elements");
    expect(result.warnings).toContain("visual_not_attempted");
  });

  it("emits visual_attempted_empty when uia is blind and visual is warm-but-empty", async () => {
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_blind_single_pane"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [],
      warnings: [],
    });
    const result = await composeCandidates({ hwnd: "999" });
    expect(result.warnings).toContain("visual_attempted_empty");
    expect(result.warnings).not.toContain("visual_not_attempted");
  });

  it("does NOT emit escalation warnings when uia tree is healthy", async () => {
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [candidate("Save", "uia", "123")],
      warnings: [],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({ candidates: [], warnings: [] });
    const result = await composeCandidates({ hwnd: "123" });
    expect(result.warnings).not.toContain("visual_not_attempted");
    expect(result.warnings).not.toContain("visual_attempted_empty");
  });

  it("tells the caller the backend cannot look only where the visual lane was the one that could answer", async () => {
    // Measured on a real machine (win2, 2026-09-10) and it is why this filter exists: with the
    // default backend, a window whose UIA tree answered COMPLETELY — nine entities — carried the
    // same warning and the same constraint as one whose buttons are painted. That is a fact about
    // the deployment, not about the read, and on a default build it would ride on every
    // desktop_discover response of every user. Noise on every response is how a caller learns to
    // stop reading warnings.
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [candidate("Save", "uia", "123")],
      warnings: [],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["visual_backend_cannot_recognise"],
    });
    const healthy = await composeCandidates({ hwnd: "123" });
    expect(healthy.warnings).not.toContain("visual_backend_cannot_recognise");

    // Blind primary: now the silence cost the caller something, and it is said.
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_blind_single_pane"],
    });
    const blind = await composeCandidates({ hwnd: "999" });
    expect(blind.warnings).toContain("visual_backend_cannot_recognise");
    expect(blind.warnings).toContain("visual_not_attempted");
  });

  it("emits visual_attempted_empty_cdp_fallback for browser target with cdp failure and empty visual", async () => {
    mocks.fetchBrowserCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["cdp_provider_failed"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({ candidates: [], warnings: [] });
    const result = await composeCandidates({ tabId: "tab-1" });
    expect(result.warnings).toContain("cdp_provider_failed");
    expect(result.warnings).toContain("visual_attempted_empty_cdp_fallback");
  });

  it("does NOT emit visual escalation for browser target when CDP succeeds", async () => {
    mocks.fetchBrowserCandidates.mockResolvedValue({
      candidates: [candidate("Button", "cdp", "tab-1")],
      warnings: [],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({ candidates: [], warnings: [] });
    const result = await composeCandidates({ tabId: "tab-1" });
    expect(result.warnings).not.toContain("visual_attempted_empty_cdp_fallback");
  });

  it("escalation warning is not duplicated when already present in merged result", async () => {
    // Edge case: if somehow "visual_not_attempted" arrives from uia or visual mock
    mocks.fetchUiaCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["uia_blind_single_pane", "visual_not_attempted"],
    });
    mocks.fetchVisualCandidates.mockResolvedValue({
      candidates: [],
      warnings: ["visual_provider_unavailable"],
    });
    const result = await composeCandidates({ hwnd: "999" });
    const count = result.warnings.filter((w) => w === "visual_not_attempted").length;
    expect(count).toBe(1);
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

  it("stamps the identity and the window origin on the result it hands back", async () => {
    // ADR-036 items 2 and 5. Both are evidence about THIS observation and both are read here,
    // before the lanes run — read at store time instead, a cache hit would pair candidates from
    // one moment with an identity and an origin from another. Nothing else on this path can
    // notice if the stamp is dropped: the fields are optional, so the types stay green and the
    // session simply stops correcting and stops comparing.
    const result = await composeCandidates({ hwnd: "999" });

    expect(result.identityRead).toBe(true);
    expect(result.identity).toMatchObject({ pid: 1234, className: "Notepad", titleFingerprint: "Untitled - Notepad" });
    expect(result.origin).toEqual({ kind: "measured", rect: { x: 100, y: 200, width: 600, height: 400 } });
  });

  it("records no origin at all when the window moved while the lanes were running", async () => {
    // ADR-036 item 5, the hazard this rung introduces if the origin is sampled once (gate 1): the
    // lanes take seconds, and a window that moves while they run leaves the candidates describing
    // its NEW position and the origin its old one. The correction would then treat a move that
    // happened before the coordinates were measured as one that happened after, and shift an
    // already-correct point a second time — a wrong press in a case the code got right before this
    // existed. There is no single origin for those coordinates, so the aim records none.
    const positions = [
      { x: 100, y: 200, width: 600, height: 400 },
      { x: 100, y: 129, width: 600, height: 400 },
    ];
    let n = 0;
    rectRef.value = positions[0]!;
    const win32 = await import("../../src/engine/win32.js");
    vi.mocked(win32.getWindowRectByHwnd).mockImplementation(() => positions[Math.min(n++, 1)]!);

    const result = await composeCandidates({ hwnd: "999" });

    // Positive evidence that the coordinates are unusable, NOT an absent rectangle: an absence
    // would read as "nobody looked" and let the blind press through.
    expect(result.origin).toEqual({ kind: "moved_during_read" });
    // The identity is NOT dropped with it: a stale identity fails safe (the act-time comparison
    // answers "changed" and refuses), so only the origin is read twice.
    expect(result.identity).toMatchObject({ pid: 1234 });
    vi.mocked(win32.getWindowRectByHwnd).mockImplementation(() => rectRef.value);
  });

  it("does not keep an origin the second read could not confirm", async () => {
    // The window closed, or the read failed, between the two samples. "Could not ask" is not
    // "unchanged": keeping the first rectangle would hand the correction a delta measured against
    // a window nothing could see any more.
    const first = { x: 100, y: 200, width: 600, height: 400 };
    let n = 0;
    const win32 = await import("../../src/engine/win32.js");
    vi.mocked(win32.getWindowRectByHwnd).mockImplementation(() => (n++ === 0 ? first : null));

    const result = await composeCandidates({ hwnd: "999" });

    expect(result.origin).toBeUndefined();
    vi.mocked(win32.getWindowRectByHwnd).mockImplementation(() => rectRef.value);
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
