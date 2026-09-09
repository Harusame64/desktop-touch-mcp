// ADR-014 v2 R3 Key Locker — normalizeTarget WindowExcludedError propagation (Codex R1 P1-A).
//
// When an explicit key-locker hwnd reaches desktop_discover, resolveWindowTarget throws
// WindowExcludedError. normalizeTarget MUST re-throw it (not swallow it as a normal resolution
// miss) — otherwise the original excluded hwnd flows into the provider fan-out and the OCR lane
// reads the dialog by handle. This suite mocks resolveWindowTarget + all providers and asserts
// composeCandidates propagates the refusal, while a PLAIN resolution error keeps the legacy
// tolerant passthrough.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockResolveWindowTarget } = vi.hoisted(() => ({
  mockResolveWindowTarget: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({ resolveWindowTarget: mockResolveWindowTarget }));
vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({ fetchVisualCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/ocr-provider.js", () => ({ fetchOcrCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: vi.fn() }));
vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: vi.fn() }));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getUiElements:  vi.fn().mockResolvedValue({ elements: [], elementCount: 0, windowRect: null }),
  detectUiaBlind: vi.fn().mockReturnValue({ blind: false }),
}));

import { composeCandidates } from "../../src/tools/desktop-providers/compose-providers.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import { fetchUiaCandidates } from "../../src/tools/desktop-providers/uia-provider.js";
import { fetchVisualCandidates } from "../../src/tools/desktop-providers/visual-provider.js";
import { fetchOcrCandidates } from "../../src/tools/desktop-providers/ocr-provider.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchUiaCandidates).mockResolvedValue({ candidates: [], warnings: [] });
  vi.mocked(fetchVisualCandidates).mockResolvedValue({ candidates: [], warnings: [] });
  vi.mocked(fetchOcrCandidates).mockResolvedValue({ candidates: [], warnings: [] });
});

describe("composeCandidates — a handle that cannot be read (ADR-036, left open)", () => {
  // The PR-side review asked for these to be refused. They are not, and the reason is a
  // measurement rather than a preference: `TargetSpec.hwnd` is a string that carries two meanings,
  // and the visual / GPU lanes address snapshots by opaque keys like `"hwnd-game"`. Refusing every
  // unreadable handle turned six tests red across `benchmark-gates`, `poc-backend` and
  // `dirty-signal` — all of them legitimate uses of the field as a key.
  //
  // So this pins the CURRENT behaviour and names what is wrong with it, rather than pinning a
  // half-fix: an unreadable handle still reaches the providers, which warn and read by title. The
  // act that follows is unpinned. Closing it means separating the two meanings (ADR-036 item 2).
  it("passes an unreadable handle through to the providers, which is the hole", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    const result = await composeCandidates({ hwnd: "hwnd-game" });
    expect(result.candidates).toEqual([]);
    expect(fetchUiaCandidates).toHaveBeenCalled();
  });
});

describe("composeCandidates — R3 WindowExcludedError propagation", () => {
  it("propagates WindowExcludedError from a hwnd target (does NOT swallow it)", async () => {
    mockResolveWindowTarget.mockRejectedValue(new WindowExcludedError("WindowExcluded: key locker"));
    await expect(composeCandidates({ hwnd: "500" })).rejects.toBeInstanceOf(WindowExcludedError);
    // The refusal short-circuits BEFORE the OCR lane could read the dialog by handle.
    expect(fetchOcrCandidates).not.toHaveBeenCalled();
  });

  it("keeps the legacy tolerant passthrough for a plain (non-excluded) resolution error", async () => {
    mockResolveWindowTarget.mockRejectedValue(new Error("WindowNotFound: stale hwnd"));
    const result = await composeCandidates({ hwnd: "500" });
    // Non-excluded errors are swallowed → composeCandidates proceeds with the original target.
    expect(result.candidates).toEqual([]);
  });
});
