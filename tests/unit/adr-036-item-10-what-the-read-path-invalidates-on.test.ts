/**
 * ADR-036 item 10 — what the READ path treats as a new target, and what it lets through.
 *
 * The map says `identity-tracker.ts` "decides handle reuse on pid alone" and "never compares start
 * time or class". **Half of that is stale**: the tracker has three invalidation branches and one of
 * them compares `processStartTimeMs`. Class is still never compared, and that is the asymmetry the
 * item is actually about — the act path refuses a replacement (`className` separates a window
 * replaced inside one process) that the read path reads as continuous.
 *
 * **Why cells rather than a machine.** win2 measured the input shape on 2026-09-17: a WinForms
 * `RecreateHandle` gives `old=6162910 new=6228446 same=False pid=16168`, and the reader answered
 * `invalidatedBy: null`. That is what the real input looks like. What the reader ANSWERS for each
 * shape is a pure question, so it belongs here, where every branch can be driven — the control arm
 * that could not be built on the machine (it landed in a different code path) is three lines here.
 *
 * The cell this file replaces asserted the opposite of its own name: "detects hwnd_reused when same
 * hwnd observed with a different pid" could not force a different pid, so it asserted that NOTHING
 * fired. A name that generalises past what the body checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win32 = vi.hoisted(() => ({
  pidOf: new Map<string, number>(),
  startTimeOf: new Map<number, number>(),
  alive: new Set<string>(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  getWindowProcessId: (hwnd: bigint) => win32.pidOf.get(String(hwnd)) ?? 0,
  getProcessIdentityByPid: (pid: number) => ({
    pid,
    processName: `p${pid}.exe`,
    processStartTimeMs: win32.startTimeOf.get(pid) ?? 0,
  }),
  enumWindowsInZOrder: () => [...win32.alive].map((h) => ({ hwnd: BigInt(h), title: "", className: "" })),
}));

const { observeTarget, clearIdentities, takeLastInvalidation } = await import(
  "../../src/engine/identity-tracker.js"
);

/** Put a window on the desktop: it has a pid, that pid started at `startedMs`, and it is alive. */
function place(hwnd: bigint, pid: number, startedMs = 1_000): void {
  win32.pidOf.set(String(hwnd), pid);
  win32.startTimeOf.set(pid, startedMs);
  win32.alive.add(String(hwnd));
}

beforeEach(() => {
  win32.pidOf.clear();
  win32.startTimeOf.clear();
  win32.alive.clear();
  clearIdentities();
  takeLastInvalidation();
});

afterEach(() => {
  clearIdentities();
});

describe("what the read path invalidates on", () => {
  it("fires hwnd_reused when the same handle comes back owned by another process", () => {
    // The branch the old cell was named for and could not reach.
    place(0x1234n, 100);
    expect(observeTarget("calc", 0x1234n, "Calculator").invalidatedBy).toBeNull();

    place(0x1234n, 200); // same handle, new owner
    const again = observeTarget("calc", 0x1234n, "Calculator");
    expect(again.invalidatedBy).toBe("hwnd_reused");
    expect(again.previousTarget).toEqual({ pid: 100, processName: "p100.exe" });
  });

  it("fires process_restarted when the title comes back on a new handle and the old one is gone", () => {
    place(0x1111n, 100);
    observeTarget("calc", 0x1111n, "Calculator");

    win32.alive.delete("4369"); // 0x1111 — the old window is destroyed
    place(0x2222n, 300);
    expect(observeTarget("calc", 0x2222n, "Calculator").invalidatedBy).toBe("process_restarted");
  });

  it("fires process_restarted when the same handle's process has a different start time", () => {
    // **This is the branch the map says does not exist.** It compares `processStartTimeMs`, so the
    // item's "never compares start time" is stale — and a cell has to say so, or the next reader
    // designs a fix for a gap that is half closed.
    place(0x3333n, 400, 1_000);
    observeTarget("calc", 0x3333n, "Calculator");

    place(0x3333n, 400, 9_999); // same pid number, started later: a restart into the same handle
    expect(observeTarget("calc", 0x3333n, "Calculator").invalidatedBy).toBe("process_restarted");
  });

  it("says NOTHING when one process recreates its own window handle", () => {
    // **The shape win2 measured on the machine**: `RecreateHandle`, same pid, new handle, the old
    // handle destroyed. Nothing fires, because every branch above needs the pid to differ or the
    // start time to move. The read path calls this the same target; the act path, which compares
    // `className`, would refuse it. That asymmetry is item 10.
    place(0x4444n, 500);
    observeTarget("notepad", 0x4444n, "Untitled");

    win32.alive.delete("17476"); // 0x4444 destroyed by the recreate
    place(0x5555n, 500); // new handle, SAME process
    const after = observeTarget("notepad", 0x5555n, "Untitled");
    expect(after.invalidatedBy).toBeNull();
    expect(after.identity.hwnd).toBe(String(0x5555n));
  });

  it("says nothing for a second window of the same name while the first is still open", () => {
    // Deliberate: two instances are not a restart. Pinned so the fix for the case above cannot
    // close this one by accident.
    place(0x6666n, 600);
    observeTarget("calc", 0x6666n, "Calculator");

    place(0x7777n, 700); // a second instance; 0x6666 stays alive
    expect(observeTarget("calc", 0x7777n, "Calculator").invalidatedBy).toBeNull();
  });

  it("never looks at the class, on any branch", () => {
    // The half of the map's sentence that is still true, and the reason the act path and the read
    // path can disagree about the same window. `enumWindowsInZOrder` is mocked to return a class,
    // and no branch consults it: the recreate case above is the proof — same class, same pid, new
    // handle, silence.
    place(0x8888n, 800);
    observeTarget("calc", 0x8888n, "Calculator");
    win32.alive.delete("34952");
    place(0x9999n, 800);
    expect(observeTarget("calc", 0x9999n, "Calculator").invalidatedBy).toBeNull();
  });
});
