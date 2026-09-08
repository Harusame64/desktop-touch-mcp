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
const { resolveActionTarget } = await import("../../src/engine/perception/action-target.js");

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
    expect(buildHintsForTitle(TITLE, A, true)).not.toBeNull();
    expect(buildHintsForTitle(TITLE, B, true)).not.toBeNull();
    windows = [{ hwnd: A, title: TITLE }];
    takeLastInvalidation();

    const again = buildHintsForTitle(TITLE, A, true);
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

  it("keeps the title's question for @active and the dialog rescue", () => {
    // The half the first version of this got wrong. `resolveWindowTarget` hands
    // back a handle for `windowTitle:"@active"` and for a title only a dialog
    // matches, so `pinnedHwnd` being set is NOT "the caller named a handle" —
    // those callers named a title, and the drift question is live for them.
    // Keying on the resolved handle took `process_restarted` away from
    // `@active`, which is the shape the tool's own examples teach.
    windows = [{ hwnd: A, title: TITLE }];
    // Resolved by us, named by title: pass the handle, do NOT key by it.
    expect(buildHintsForTitle(TITLE, A, false)).not.toBeNull();
    takeLastInvalidation();

    windows = [{ hwnd: B, title: TITLE }];
    expect(buildHintsForTitle(TITLE, B, false)).not.toBeNull();
    expect(takeLastInvalidation()?.reason).toBe("process_restarted");
  });

  it("a title that looks like the handle key cannot take its slot", () => {
    // The key is NUL-separated because a window title can contain anything else
    // — including `hwnd:4369`. Nothing exercised that, and a mutant using a
    // printable prefix survived the suite.
    const collide = `hwnd:${A}`;
    windows = [{ hwnd: A, title: collide }];
    expect(buildHintsForTitle(collide, A, true)).not.toBeNull();   // handle slot
    takeLastInvalidation();

    // Same string as a plain title query, on a DIFFERENT handle. If the two
    // shared a slot this would read the handle-keyed record and call it a
    // restart.
    windows = [{ hwnd: B, title: collide }];
    pidOf = { [String(B)]: 22 };
    expect(buildHintsForTitle(collide, undefined, false)).not.toBeNull();
    expect(takeLastInvalidation()).toBeNull();
  });

  it("the GUARD's by-handle resolution files under the handle too", async () => {
    // The other half of the same defect, found one commit after the first was
    // fixed. `resolveWindowTargetByHwnd` passes the normalized TITLE into
    // `buildWindowLensResult`, which forwards it to `observeTarget` through
    // `refreshWin32Fluents` — so guarded calls alternating between two
    // same-titled windows still shared one slot, and the survivor was reported
    // as `process_restarted` once the other closed. That invalidation is
    // global: the next screenshot reads it.
    const byHandle = (hwnd: bigint) =>
      resolveActionTarget({ kind: "window", titleIncludes: TITLE, hwnd }, { actionKind: "uiaInvoke" });

    await byHandle(A);
    await byHandle(B);
    windows = [{ hwnd: A, title: TITLE }];
    takeLastInvalidation();

    await byHandle(A);
    expect(takeLastInvalidation()).toBeNull();
  });

  it("…and a title-named guard call still asks the title's question", async () => {
    // The pairing: the guard's TITLE path is untouched and still detects a real
    // restart.
    windows = [{ hwnd: A, title: TITLE }];
    await resolveActionTarget({ kind: "window", titleIncludes: TITLE }, { actionKind: "uiaInvoke" });
    takeLastInvalidation();

    windows = [{ hwnd: B, title: TITLE }];
    await resolveActionTarget({ kind: "window", titleIncludes: TITLE }, { actionKind: "uiaInvoke" });
    expect(takeLastInvalidation()?.reason).toBe("process_restarted");
  });

  it("keeps the handle's own history: hwnd_reused is not affected", () => {
    // `lastByHwnd` answers the question that DOES apply to a handle, and the
    // new key does not go near it: the same handle coming back under a
    // different process is still a reuse.
    windows = [{ hwnd: A, title: TITLE }];
    expect(buildHintsForTitle(TITLE, A, true)).not.toBeNull();
    takeLastInvalidation();

    pidOf = { [String(A)]: 99 };
    expect(buildHintsForTitle(TITLE, A, true)).not.toBeNull();
    expect(takeLastInvalidation()?.reason).toBe("hwnd_reused");
  });
});
