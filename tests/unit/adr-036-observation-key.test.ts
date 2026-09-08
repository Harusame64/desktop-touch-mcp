/**
 * adr-036-observation-key.test.ts — the drift baseline is keyed by how the
 * window was NAMED.
 *
 * `buildHintsForTitle` gained a `pinnedHwnd` in this ADR: it resolves the
 * caller's handle instead of matching their query, because a report about the
 * sibling is worse than no report. The OBSERVATION it takes on the way through
 * kept the old key — the query string — so two same-titled windows shared one
 * slot in `lastByKey`, whose entire question is "the window I knew by this name
 * is a different handle now; did it restart?". That question does not exist for
 * a caller who named a handle, and answering it anyway invented a restart.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const A = 0x1111n;
const B = 0x2222n;
const TITLE = "Report";

let windows: Array<{ hwnd: bigint; title: string }> = [];
/** pid per handle, so a "restart" is expressible: same title, new handle, new pid. */
let pidOf: Record<string, number> = {};

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => windows.map((w, i) => ({
      hwnd: w.hwnd, title: w.title, zOrder: i, isActive: i === 0,
      region: { x: 0, y: 0, width: 800, height: 600 },
      isMinimized: false, isMaximized: false, className: "X", ownerHwnd: null,
    }))),
    getWindowProcessId: vi.fn((h: bigint) => pidOf[String(h)] ?? 1),
    getProcessIdentityByPid: vi.fn((pid: number) => ({
      pid, processName: "app.exe", processStartTimeMs: 1_700_000_000_000 + pid,
    })),
  };
});

const { buildHintsForTitle, clearIdentities, takeLastInvalidation } =
  await import("../../src/engine/identity-tracker.js");

beforeEach(() => {
  clearIdentities();
  takeLastInvalidation();
  windows = [{ hwnd: A, title: TITLE }, { hwnd: B, title: TITLE }];
  pidOf = { [String(A)]: 11, [String(B)]: 22 };
});

describe("ADR-036 — a handle-named observation is keyed by the handle", () => {
  it("does not invent a restart when the caller alternates between two same-titled windows", () => {
    // A, then B, then B closes, then A again. Keyed by the query, that last
    // observation saw "the window called Report used to be B, B is gone, and
    // the pid differs" and called it `process_restarted` — for a window that
    // never went anywhere, and which the caller had named by handle both times.
    expect(buildHintsForTitle(TITLE, A)).not.toBeNull();
    expect(buildHintsForTitle(TITLE, B)).not.toBeNull();
    windows = [{ hwnd: A, title: TITLE }];
    takeLastInvalidation();

    const again = buildHintsForTitle(TITLE, A);
    expect(again).not.toBeNull();
    expect(again!.hwnd).toBe(A);
    // The invalidation is global state that the next screenshot reads, so a
    // false one does not stay local to this call.
    expect(takeLastInvalidation()).toBeNull();
  });

  it("still detects a real restart for a caller who named the title", () => {
    // The pairing. Named by title, "same name, different handle, previous one
    // gone" is exactly the question `lastByKey` exists to answer, and it must
    // keep answering it.
    windows = [{ hwnd: A, title: TITLE }];
    expect(buildHintsForTitle(TITLE)).not.toBeNull();
    takeLastInvalidation();

    windows = [{ hwnd: B, title: TITLE }];
    expect(buildHintsForTitle(TITLE)).not.toBeNull();
    expect(takeLastInvalidation()?.reason).toBe("process_restarted");
  });

  it("keeps the handle's own history: hwnd_reused is not affected", () => {
    // `lastByHwnd` answers the question that DOES apply to a handle, and the
    // new key does not go near it: the same handle coming back under a
    // different process is still a reuse.
    windows = [{ hwnd: A, title: TITLE }];
    expect(buildHintsForTitle(TITLE, A)).not.toBeNull();
    takeLastInvalidation();

    pidOf = { [String(A)]: 99 };
    expect(buildHintsForTitle(TITLE, A)).not.toBeNull();
    expect(takeLastInvalidation()?.reason).toBe("hwnd_reused");
  });
});
