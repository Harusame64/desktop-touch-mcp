/**
 * internal #222 — `desktop_discover` of a window excluded from every tool surface says so.
 *
 * `normalizeTarget` threw `WindowExcludedError` for the key locker's own windows, so no lane read
 * them — and the ingress caught it as any other throw and answered `ingress_fetch_error`, whose
 * advice is to retry `desktop_discover`: a refusal that stays true for as long as the window is
 * excluded, dressed as a failure that passes. (Until #754 the second call served the read from
 * before the exclusion instead, internal #160.) A bare call with the locker in front answered
 * `no_provider_matched`, the same advice (gate 2).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  windowIsAlive: vi.fn<(h: bigint) => boolean | undefined>(),
  lane: vi.fn(async () => ({ candidates: [], warnings: [] })),
  identity: vi.fn(() => undefined),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({ resolveWindowTarget: mocks.resolveWindowTarget }));
vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: mocks.lane }));
vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: mocks.lane }));
vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: mocks.lane }));
vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({ fetchVisualCandidates: mocks.lane }));
vi.mock("../../src/tools/desktop-providers/ocr-provider.js", () => ({ fetchOcrCandidates: mocks.lane }));
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    windowIsAlive: mocks.windowIsAlive,
    getWindowIdentity: mocks.identity,
    getWindowClassName: vi.fn(() => ""),
    getWindowTitleW: vi.fn(() => ""),
    getWindowRectByHwnd: vi.fn(() => null),
  };
});

import { composeCandidates, composeCandidatesOnly } from "../../src/tools/desktop-providers/compose-providers.js";
import { SnapshotIngress } from "../../src/engine/world-graph/candidate-ingress.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import { deriveViewConstraints } from "../../src/tools/desktop-constraints.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const excluded = () => new WindowExcludedError("WindowExcluded: target window belongs to the desktop-touch key locker");

beforeEach(() => {
  mocks.resolveWindowTarget.mockReset().mockRejectedValue(excluded());
  mocks.windowIsAlive.mockReset().mockReturnValue(true);
  mocks.lane.mockClear();
  mocks.identity.mockClear();
});

describe("composeCandidates, when the target is excluded", () => {
  it("says window_excluded by handle, runs no lane, and records the identity as looked for", async () => {
    expect(await composeCandidates({ hwnd: "500" })).toEqual({ candidates: [], warnings: ["window_excluded"], target: { hwnd: "500" }, identityRead: true });
    expect(mocks.lane).not.toHaveBeenCalled();
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("says it by title", async () => {
    expect(await composeCandidates({ windowTitle: "Key Locker" })).toEqual({ candidates: [], warnings: ["window_excluded"], target: { windowTitle: "Key Locker" }, identityRead: true });
    expect(mocks.lane).not.toHaveBeenCalled();
  });

  it("names no window for an explicit @active either (gate 2)", async () => {
    expect(await composeCandidates({ windowTitle: "@active" })).toEqual({ candidates: [], warnings: ["window_excluded"] });
    expect(mocks.lane).not.toHaveBeenCalled();
  });

  it("says it for a bare call with the locker in front, and names no window (gate 2)", async () => {
    expect(await composeCandidates(undefined)).toEqual({ candidates: [], warnings: ["window_excluded"] });
    expect(mocks.lane).not.toHaveBeenCalled();
  });

  it("says target_window_gone when the handle is gone: the check fails closed on a closed window (gate 2)", async () => {
    mocks.windowIsAlive.mockReturnValue(false);
    expect((await composeCandidates({ hwnd: "500" })).warnings).toEqual(["target_window_gone"]);
  });

  it("keeps no_provider_matched for a bare call whose foreground cannot be resolved (the control)", async () => {
    mocks.resolveWindowTarget.mockRejectedValue(new Error("WindowExcluded: a plain Error with the same words"));
    expect((await composeCandidates(undefined)).warnings).toEqual(["no_provider_matched"]);
  });
});

describe("the road that keeps only the candidates (the direct provider, the post-touch snapshot)", () => {
  it("still fails loudly on an excluded target: an empty list would read as every entity gone (gate 2)", async () => {
    await expect(composeCandidatesOnly({ hwnd: "500" })).rejects.toBeInstanceOf(WindowExcludedError);
  });

  it("hands back the candidates otherwise (the control)", async () => {
    mocks.resolveWindowTarget.mockResolvedValue(null);
    await expect(composeCandidatesOnly({ hwnd: "500" })).resolves.toEqual([]);
    expect(mocks.lane).toHaveBeenCalled();
  });
});

describe("the constraints it becomes", () => {
  it("names the window as excluded, and gives that as the reason for no entities", () => {
    expect(deriveViewConstraints(["window_excluded"], 0)).toEqual({ window: "window_excluded", entityZeroReason: "window_excluded" });
  });

  it("is not overwritten by another window value, whichever comes first (gate 2)", () => {
    for (const other of ["no_provider_matched", "target_window_gone"]) {
      expect(deriveViewConstraints(["window_excluded", other], 0)).toEqual({ window: "window_excluded", entityZeroReason: "window_excluded" });
      expect(deriveViewConstraints([other, "window_excluded"], 0)).toEqual({ window: "window_excluded", entityZeroReason: "window_excluded" });
    }
  });

  it("comes before the reasons whose remedy is a retry, a wait or a scroll", () => {
    expect(deriveViewConstraints(["uia_provider_failed", "query_no_match", "ingress_fetch_error", "window_excluded"], 0)?.entityZeroReason).toBe("window_excluded");
  });
});

describe("through the facade and the ingress", () => {
  it("answers no entities, window_excluded, and no advice to retry", async () => {
    const facade = new DesktopFacade(async () => [], { ingress: new SnapshotIngress((key) => composeCandidates({ hwnd: key.slice(7) })), executorFn: async () => "uia" });
    const view = await facade.see({ target: { hwnd: "500" } });
    expect(view.entities).toEqual([]);
    expect(view.warnings).toEqual(["window_excluded"]);
    expect(view.constraints).toEqual({ window: "window_excluded", entityZeroReason: "window_excluded" });
    expect(mocks.identity).not.toHaveBeenCalled();
  });
});
