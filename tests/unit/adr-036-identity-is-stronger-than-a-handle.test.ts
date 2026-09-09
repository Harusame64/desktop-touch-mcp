/**
 * A handle is a number, and Windows gives numbers back.
 *
 * The specification, on why the aim cannot be a handle alone:
 *
 * > For windows, the runtime row key can be `hwnd`, but **identity must be stronger than `hwnd`**.
 * > If the same `hwnd` appears with a different process identity, RPG treats it as **identity
 * > invalidation**, not an ordinary update.
 *
 * So the aim carries who owned the handle when it was taken, and an act compares before doing
 * anything. What makes this worth its own suite is the asymmetry: when the identity has changed,
 * the action would NOT fail — it would succeed, against a window nobody looked at. The refusal is
 * the only thing standing between the lease and a stranger.
 *
 * The other half is the one that keeps being re-learned: "could not ask" is not "changed". A build
 * with no native binding answers nothing, and refusing on an unanswered question would take every
 * aimed action down on that build — the same shape as reading a null rectangle as a gone window
 * (`bb2e2b5`), one file over.
 */
import { describe, it, expect, vi } from "vitest";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { AimIdentityChangedError, compareAimIdentity, toAim, type Aim, type WindowIdentity } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;
const WHEN_TAKEN: WindowIdentity = { hwnd: HWND, pid: 1234, processName: "notepad.exe", processStartTimeMs: 1_700_000_000_000 };

function entity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "Save",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [
      { verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] },
    ],
    generation: "gen-1",
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...overrides,
  };
}

function deps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick:       vi.fn(async () => {}),
    uiaSetValue:    vi.fn(async () => {}),
    cdpClick:       vi.fn(async () => {}),
    cdpFill:        vi.fn(async () => {}),
    terminalSend:   vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick:     vi.fn(async () => {}),
    ...overrides,
  };
}

const aimWithIdentity: Aim = { kind: "aim", title: "Untitled - Notepad", hwnd: HWND, identity: WHEN_TAKEN };

describe("an act on a recycled handle is refused before anything is done", () => {
  it("refuses when the process behind the handle has changed", async () => {
    const d = deps({
      aimIdentity: vi.fn(async () => ({ ...WHEN_TAKEN, pid: 9999, processName: "chrome.exe" })),
    });
    const exec = createDesktopExecutor(aimWithIdentity, d);

    await expect(exec(entity(), "click")).rejects.toBeInstanceOf(AimIdentityChangedError);
    // The point of checking first: nothing may reach a backend, because reaching one would have
    // WORKED — on the window that inherited the number.
    expect(d.uiaClick).not.toHaveBeenCalled();
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("refuses when the pid is the same but the process is a later one wearing it", async () => {
    // Windows reuses pids as well as handles. The start time is what separates one generation of a
    // pid from the next, and without it a restarted app looks like the same app.
    const d = deps({
      aimIdentity: vi.fn(async () => ({ ...WHEN_TAKEN, processStartTimeMs: WHEN_TAKEN.processStartTimeMs + 60_000 })),
    });
    const exec = createDesktopExecutor(aimWithIdentity, d);
    await expect(exec(entity(), "click")).rejects.toBeInstanceOf(AimIdentityChangedError);
  });

  it("acts when the identity is the one the aim was taken on", async () => {
    const d = deps({ aimIdentity: vi.fn(async () => ({ ...WHEN_TAKEN })) });
    const exec = createDesktopExecutor(aimWithIdentity, d);
    await exec(entity(), "click");
    expect(d.uiaClick).toHaveBeenCalled();
  });
});

describe("an unanswered question is not an answer", () => {
  it("acts when nothing could say who owns the handle now", async () => {
    // The build with no native binding. Refusing here would refuse everything on it, about windows
    // that are on screen and working.
    const d = deps({ aimIdentity: vi.fn(async () => undefined) });
    const exec = createDesktopExecutor(aimWithIdentity, d);
    await exec(entity(), "click");
    expect(d.uiaClick).toHaveBeenCalled();
  });

  it("acts when the aim never carried an identity", async () => {
    // A raw TargetSpec — every caller that has not been migrated, and every test double. There is
    // nothing to compare against, and inventing a comparison would be inventing evidence.
    const d = deps({ aimIdentity: vi.fn(async () => ({ ...WHEN_TAKEN, pid: 9999 })) });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, d);
    await exec(entity(), "click");
    expect(d.uiaClick).toHaveBeenCalled();
  });

  it("acts when the dep itself is absent", async () => {
    const d = deps();   // no aimIdentity at all
    const exec = createDesktopExecutor(aimWithIdentity, d);
    await exec(entity(), "click");
    expect(d.uiaClick).toHaveBeenCalled();
  });
});

describe("the comparison says which of the three answers it has", () => {
  it("separates same, changed and unknown", () => {
    const same = compareAimIdentity(aimWithIdentity, { ...WHEN_TAKEN });
    const changed = compareAimIdentity(aimWithIdentity, { ...WHEN_TAKEN, pid: 2 });
    const noAnswer = compareAimIdentity(aimWithIdentity, undefined);
    const noBaseline = compareAimIdentity({ kind: "aim", hwnd: HWND }, { ...WHEN_TAKEN });
    expect([same, changed, noAnswer, noBaseline]).toEqual(["same", "changed", "unknown", "unknown"]);
  });

  it("treats a zeroed identity as unanswered, not as a mismatch", () => {
    // `getWindowIdentity` returns pid 0 for "no such window" AND for "this build cannot ask". The
    // production dep maps that to undefined; this pins the comparison too, because a value that
    // reaches it anyway must not read as a different process.
    const zeroed: WindowIdentity = { hwnd: HWND, pid: 0, processName: "", processStartTimeMs: 0 };
    expect(compareAimIdentity(aimWithIdentity, zeroed)).toBe("unknown");
  });

  it("does not compare start times when one side could not report one", () => {
    // Partial success is a documented outcome of the native call: the image name can come back
    // without the creation time. A zero there is a hole, not a different process.
    const partial: WindowIdentity = { ...WHEN_TAKEN, processStartTimeMs: 0 };
    expect(compareAimIdentity(aimWithIdentity, partial)).toBe("same");
  });
});

describe("toAim reads both shapes, and agrees with the registry about handles", () => {
  it("reads a TargetSpec, dropping nothing but inventing nothing", () => {
    expect(toAim({ windowTitle: "App", hwnd: "4919", tabId: "t1" }))
      .toEqual({ kind: "aim", title: "App", hwnd: 4919n, tabId: "t1", identity: undefined });
  });

  it("passes an Aim through untouched", () => {
    expect(toAim(aimWithIdentity)).toBe(aimWithIdentity);
  });

  it("answers 'no handle' for the same strings parseTargetHwnd does", async () => {
    // Two implementations of one rule, kept apart on purpose (the registry imports the engine, so
    // sharing it would close a cycle). The agreement is what makes that safe, so it is pinned:
    // both halves of this ADR have to mean the same thing by "a handle".
    const { parseTargetHwnd } = await import("../../src/engine/world-graph/session-registry.js");
    for (const hwnd of ["0", "-1", "", "bad", "4919", "18446744073709551615"]) {
      expect(toAim({ hwnd }).hwnd, `disagreed about ${JSON.stringify(hwnd)}`)
        .toEqual(parseTargetHwnd({ hwnd }));
    }
    expect(toAim(undefined)).toEqual({ kind: "aim" });
  });
});
