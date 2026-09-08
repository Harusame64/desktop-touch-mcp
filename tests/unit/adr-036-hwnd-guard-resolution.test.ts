/**
 * adr-036-hwnd-guard-resolution.test.ts — ADR-036 I-1 / I-2 at the layer where
 * the destination is decided.
 *
 * The contract ADR-035 leaves callers with is "when two windows share a title
 * the write stops with `ambiguous_target`, and you recover by passing `hwnd`".
 * The guard never received that handle: every write built its descriptor from
 * the resolved TITLE, so the guard re-counted the same two windows and refused
 * the recovery call as well. Passing `hwnd` was the documented way out of a
 * refusal that `hwnd` could not lift.
 *
 * Every "with hwnd" case here is paired with the same fixture WITHOUT it. That
 * pairing is the mutation: strip the handle from the descriptor and the pinned
 * case turns back into the ambiguous one, so none of these assertions can pass
 * for a reason other than the handle being used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockEnumWindows, mockBuildWindowIdentity, mockRefreshWin32Fluents } = vi.hoisted(() => ({
  mockEnumWindows: vi.fn(),
  mockBuildWindowIdentity: vi.fn(),
  mockRefreshWin32Fluents: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: mockEnumWindows,
  getWindowProcessId: vi.fn(() => 0),
}));

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: mockRefreshWin32Fluents,
  buildWindowIdentity: mockBuildWindowIdentity,
}));

// The guards themselves are not what this file is about: the refusal under test
// fires BEFORE evaluation, on the candidate count. Stubbing them to pass keeps a
// failure here readable as "the wrong number of candidates", never as "some
// unrelated guard tripped".
vi.mock("../../src/engine/perception/guards.js", () => ({
  evaluateGuards: vi.fn(() => ({
    ok: true, policy: "block", attention: "ok", results: [], failedGuard: undefined,
  })),
}));

import { resolveActionTarget, deriveTargetKey } from "../../src/engine/perception/action-target.js";
import { runActionGuard } from "../../src/tools/_action-guard.js";
import {
  _resetForTest as resetHotCache,
  getOrCreateSlot,
  updateSlot,
  getSlotSnapshot,
} from "../../src/engine/perception/hot-target-cache.js";
import { selectFreshestWindowSlot } from "../../src/tools/desktop-state.js";

// Two windows the title rule cannot tell apart — the shape the whole ADR is
// about. `pictkura` is the real one from the 2026-09-07 report: a minimised
// Chrome window and a live one, both carrying the project name.
const LIVE = 0x1111n;
const SIBLING = 0x2222n;
const SHARED_TITLE = "pictkura — Chrome";

function win(hwnd: bigint, title: string, isActive = false, zOrder = 0) {
  return {
    hwnd, title, zOrder, isActive,
    region: { x: 0, y: 0, width: 800, height: 600 },
    isMinimized: false, isMaximized: false, className: "Chrome_WidgetWin_1", ownerHwnd: null,
  };
}

function twoSiblings() {
  return [win(SIBLING, SHARED_TITLE, true, 0), win(LIVE, SHARED_TITLE, false, 1)];
}

beforeEach(() => {
  resetHotCache();
  mockEnumWindows.mockReset();
  mockRefreshWin32Fluents.mockReset();
  mockBuildWindowIdentity.mockReset();
  mockRefreshWin32Fluents.mockReturnValue([]);
  // Identity is per-handle, so the hot-cache can tell the two windows apart
  // when — and only when — they are kept in separate slots.
  mockBuildWindowIdentity.mockImplementation((hwnd: string) => ({
    hwnd, pid: Number(BigInt(hwnd) % 1000n), processName: "chrome.exe",
    processStartTimeMs: 1700000000000, titleResolved: SHARED_TITLE,
  }));
});

// ─── I-1: the guard resolves the handle it was given ─────────────────────────

describe("ADR-036 I-1 — a window descriptor carrying a handle resolves by handle", () => {
  it("without the handle, two same-titled windows are two candidates", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const r = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE },
      { actionKind: "keyboard" }
    );
    expect(r.candidates).toBe(2);
    // The title rule's tie-break picks the foreground one — which is exactly
    // the window the caller did NOT mean in the report this ADR came from.
    expect(r.lens?.binding.hwnd).toBe(String(SIBLING));
  });

  it("with the handle, the same fixture is one candidate — the named window", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const r = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
      { actionKind: "keyboard" }
    );
    expect(r.candidates).toBe(1);
    expect(r.lens?.binding.hwnd).toBe(String(LIVE));
    // Not the foreground one the title rule would have chosen.
    expect(r.lens?.binding.hwnd).not.toBe(String(SIBLING));
  });

  it("a handle that no longer names a window resolves to nothing, not to a title match", async () => {
    // The sibling is still open and still matches the title. Falling back to it
    // would be the one outcome worse than refusing: the keys would land on a
    // live window the caller never asked for.
    mockEnumWindows.mockReturnValue([win(SIBLING, SHARED_TITLE, true, 0)]);
    const r = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
      { actionKind: "keyboard" }
    );
    expect(r.candidates).toBe(0);
    expect(r.lens).toBeNull();
  });

  it("the handle is not consulted for descriptors that do not carry one", async () => {
    // Guards against a fix that pinned whatever handle the title search settled
    // on: that would make the candidate count 1 for every caller and retire
    // `ambiguous_target` altogether.
    mockEnumWindows.mockReturnValue(twoSiblings());
    const r = await resolveActionTarget(
      { kind: "window", titleIncludes: "pictkura" },
      { actionKind: "keyboard" }
    );
    expect(r.candidates).toBe(2);
  });
});

// ─── I-1 through the guard itself ────────────────────────────────────────────

describe("ADR-036 I-1 — runActionGuard stops counting once a handle is named", () => {
  it("refuses a title-only keyboard write with ambiguous_target", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const ag = await runActionGuard({
      toolName: "keyboard:type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE },
    });
    expect(ag.block).toBe(true);
    expect(ag.summary.status).toBe("ambiguous_target");
    // The refusal has to name the recovery that works. It used to offer only
    // "a more specific windowTitle" — which cannot help when both windows carry
    // the same one — and said nothing about the handle that now lifts it.
    expect(ag.summary.next).toContain("hwnd");
  });

  it("lets the same write through when it names the handle", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const ag = await runActionGuard({
      toolName: "keyboard:type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
    });
    expect(ag.block).toBe(false);
    expect(ag.summary.status).not.toBe("ambiguous_target");
  });

  it("labels the summary with the handle it resolved, not the shared title", async () => {
    // `summary.target` is what the caller reads back. `window:<title>` named
    // both windows on the one call whose purpose is to separate them.
    mockEnumWindows.mockReturnValue(twoSiblings());
    const pinned = await runActionGuard({
      toolName: "keyboard:type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
    });
    expect(pinned.summary.target).toBe(`window#hwnd:${String(LIVE)}`);

    // The pairing: a title that resolves on its own keeps the title label, so
    // the assertion above is about the handle and not about the label changing
    // for every window descriptor.
    mockEnumWindows.mockReturnValue([win(0x3333n, "notepad", true, 0)]);
    const byTitle = await runActionGuard({
      toolName: "keyboard:type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: "notepad" },
    });
    expect(byTitle.summary.target).toBe("window:notepad");
  });

  it("still refuses a dead handle with target_not_found", async () => {
    mockEnumWindows.mockReturnValue([win(SIBLING, SHARED_TITLE, true, 0)]);
    const ag = await runActionGuard({
      toolName: "keyboard:type",
      actionKind: "keyboard",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
    });
    expect(ag.block).toBe(true);
    expect(ag.summary.status).toBe("target_not_found");
  });

  it("applies the same pin to UIA writes, which shared the refusal", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const blocked = await runActionGuard({
      toolName: "click_element",
      actionKind: "uiaInvoke",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE },
    });
    expect(blocked.summary.status).toBe("ambiguous_target");

    const pinned = await runActionGuard({
      toolName: "click_element",
      actionKind: "uiaInvoke",
      descriptor: { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
    });
    expect(pinned.block).toBe(false);
  });
});

// ─── I-2: state keying ───────────────────────────────────────────────────────

describe("ADR-036 I-2 — a handle-pinned destination keeps its own state slot", () => {
  it("keys on the handle, and on the title when there is no handle", () => {
    expect(deriveTargetKey({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE }))
      .toBe(`window#hwnd:${String(LIVE)}`);
    expect(deriveTargetKey({ kind: "window", titleIncludes: "Notepad" }))
      .toBe("window:notepad");
  });

  it("cannot be forged by a window whose TITLE looks like a handle key", () => {
    // The reason the separator is `#`: with `window:hwnd:<n>` a window actually
    // called "hwnd:4369" would have produced the same key as the pinned slot for
    // handle 4369, and the two would have shared identity state.
    const forged = deriveTargetKey({ kind: "window", titleIncludes: `hwnd:${String(LIVE)}` });
    const pinned = deriveTargetKey({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(forged).not.toBe(pinned);
  });

  it("does not report the second window as the first one's identity change", async () => {
    mockEnumWindows.mockReturnValue(twoSiblings());
    const first = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: SIBLING },
      { actionKind: "keyboard" }
    );
    expect(first.changed).toBeUndefined();

    const second = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
      { actionKind: "keyboard" }
    );
    expect(second.changed ?? []).not.toContain("identity");
  });

  it("shares one slot — and misreports — when the same two windows are addressed by title", async () => {
    // The control for the case above. Without it, "no identity change" could
    // mean the hot cache simply never fires here, and the separate-slot claim
    // would be vacuous.
    //
    // BOTH windows stay open across both calls — the alternation the pinned
    // case describes, not one window being replaced by another. What moves is
    // which of them is in the foreground, because that is the title rule's
    // tie-break, so the same title resolves to a different handle each time.
    // One key, two windows: the second resolution reports the first one's
    // handle as replaced.
    mockEnumWindows.mockReturnValue([
      win(SIBLING, SHARED_TITLE, true, 0), win(LIVE, SHARED_TITLE, false, 1),
    ]);
    const first = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE },
      { actionKind: "keyboard" }
    );
    expect(first.lens?.binding.hwnd).toBe(String(SIBLING));
    expect(first.changed).toBeUndefined();

    mockEnumWindows.mockReturnValue([
      win(SIBLING, SHARED_TITLE, false, 1), win(LIVE, SHARED_TITLE, true, 0),
    ]);
    const second = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE },
      { actionKind: "keyboard" }
    );
    expect(second.lens?.binding.hwnd).toBe(String(LIVE));
    expect(second.changed ?? []).toContain("identity");
  });

  it("keeps the pinned slots apart while both windows stay open and swap places", async () => {
    // The positive twin of the control: same alternation, addressed by handle.
    mockEnumWindows.mockReturnValue([
      win(SIBLING, SHARED_TITLE, true, 0), win(LIVE, SHARED_TITLE, false, 1),
    ]);
    await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: SIBLING },
      { actionKind: "keyboard" }
    );
    mockEnumWindows.mockReturnValue([
      win(SIBLING, SHARED_TITLE, false, 1), win(LIVE, SHARED_TITLE, true, 0),
    ]);
    const second = await resolveActionTarget(
      { kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE },
      { actionKind: "keyboard" }
    );
    expect(second.lens?.binding.hwnd).toBe(String(LIVE));
    expect(second.changed ?? []).not.toContain("identity");
  });
});

// ─── The reader side of the split slot ───────────────────────────────────────

describe("ADR-036 I-2 — the attention signal comes from the freshest slot, not the first", () => {
  /** Both slots describe the SAME window; only the name it was reached by differs. */
  function twoSlotsForOneWindow(staleFirst: boolean) {
    const identity = { hwnd: String(LIVE), pid: 7, processName: "chrome.exe", processStartTimeMs: 0, titleResolved: SHARED_TITLE };
    const byTitle = { kind: "window" as const, titleIncludes: SHARED_TITLE };
    const byHandle = { kind: "window" as const, titleIncludes: SHARED_TITLE, hwnd: LIVE };
    // Insertion order decides what `find` would have returned, so the stale one
    // is created first in the case that must not answer.
    const first = staleFirst ? byTitle : byHandle;
    const second = staleFirst ? byHandle : byTitle;
    const s1 = getOrCreateSlot(first, 1_000)!;
    updateSlot(s1.key, { identity, attention: "ok" }, 1_000);
    const s2 = getOrCreateSlot(second, 2_000)!;
    updateSlot(s2.key, { identity, attention: "identity_changed" }, 2_000);
    return { staleKey: s1.key, freshKey: s2.key };
  }

  it("answers from the handle slot when that is the one last touched", () => {
    const { freshKey } = twoSlotsForOneWindow(true);
    const picked = selectFreshestWindowSlot(getSlotSnapshot(), String(LIVE));
    // `find` would have returned the title slot here — it was created first and
    // still says `ok`, which is exactly the answer that hides a drift.
    expect(picked?.key).toBe(freshKey);
    expect(picked?.attention).toBe("identity_changed");
  });

  it("answers from the title slot when THAT is the one last touched", () => {
    // The mirror image, so the rule cannot be satisfied by preferring one key
    // shape over the other.
    const { freshKey } = twoSlotsForOneWindow(false);
    const picked = selectFreshestWindowSlot(getSlotSnapshot(), String(LIVE));
    expect(picked?.key).toBe(freshKey);
    expect(picked?.key.startsWith("window:")).toBe(true);
  });

  it("ignores slots describing a different window", () => {
    twoSlotsForOneWindow(true);
    expect(selectFreshestWindowSlot(getSlotSnapshot(), String(SIBLING))).toBeUndefined();
  });
});
