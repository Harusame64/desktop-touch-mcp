/**
 * internal #126 — the modal guard asks the window, not only the snapshot.
 *
 * `isModalBlocking` looks at the `desktop_discover` snapshot, scoped to the target window. A
 * `ShowDialog` / `MessageBox` in another top-level window is never in it, and the act that ran into
 * one degraded to a press the OS swallowed and answered `ok:true` (win2, 2026-09-18). The guard now
 * asks the OS first — is the entity's own window disabled by a dialog it owns — which win2 measured
 * on four fixtures before anything depended on it (internal `6e41392`).
 */
import { describe, expect, it, vi } from "vitest";

import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";
import { _resetFacadeForTest, getDesktopFacade, productionFindBlockingWindow } from "../../src/tools/desktop-register.js";

const GEN = "gen-1";

function entity(opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "OK",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [{ verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: GEN,
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...opts,
  };
}

function candidate(): UiEntityCandidate {
  return {
    source: "visual_gpu",
    target: { kind: "window", id: "Editor" },
    label: "OK",
    role: "button",
    rect: { x: 10, y: 10, width: 60, height: 20 },
    actionability: ["click"],
    confidence: 0.9,
    observedAtMs: 0,
    provisional: false,
  } as unknown as UiEntityCandidate;
}

function makeEnv(overrides: Partial<TouchEnvironment> = {}): TouchEnvironment {
  return {
    resolveLiveEntities: () => [],
    currentGeneration: () => GEN,
    isModalBlocking: () => false,
    checkViewport: () => null,
    execute: async () => "mouse",
    resolvePostTouchEntities: async () => [],
    ...overrides,
  };
}

describe("the guard asks the window before the snapshot", () => {
  it("refuses modal_blocking with the dialog, and presses nothing, when the window is blocked", async () => {
    const e = entity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const execute = vi.fn(async () => "mouse" as const);
    const isModalBlocking = vi.fn(() => false);
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      findBlockingWindow: () => ({ kind: "blocked", blocker: { name: "Save changes?", role: "dialog" } }),
      isModalBlocking,
      execute,
    }));
    const result = await loop.touch({ lease });
    expect(result).toEqual({ ok: false, reason: "modal_blocking", diff: [], blockingElement: { name: "Save changes?", role: "dialog" } });
    // The measured defect was a press the OS swallowed and an `ok:true`. Nothing is pressed now.
    expect(execute).not.toHaveBeenCalled();
    // The OS answered; the snapshot is not consulted to second-guess it.
    expect(isModalBlocking).not.toHaveBeenCalled();
  });

  it("falls through to the snapshot check, unchanged, when the OS cannot say", async () => {
    const e = entity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const loop = new GuardedTouchLoop(store, makeEnv({
      resolveLiveEntities: () => [e],
      findBlockingWindow: () => ({ kind: "cannot_say" }),
      isModalBlocking: () => true,
    }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      expect(result.blockingElement).toBeUndefined();
    }
  });

  it("proceeds when the OS cannot say and the snapshot is clear", async () => {
    const e = entity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "v1");
    const execute = vi.fn(async () => "uia" as const);
    const loop = new GuardedTouchLoop(store, makeEnv({ resolveLiveEntities: () => [e], findBlockingWindow: () => ({ kind: "cannot_say" }), execute }));
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * A little desktop: windows front-to-back, each with the top of its owner chain, and whether it is
 * enabled and visible. `deps(desktop)` answers the finder's OS questions from it.
 */
interface W { hwnd: bigint; owner: bigint | null; enabled: boolean; visible?: boolean; title?: string; cls?: string; thread?: number }
function deps(desktop: W[], over: Record<string, unknown> = {}) {
  const at = (h: bigint) => desktop.find((w) => w.hwnd === h);
  return {
    root: (h: bigint) => h,
    owner: (h: bigint) => at(h)?.owner ?? null,
    threadOf: (h: bigint) => at(h)?.thread ?? 1,
    isEnabled: (h: bigint) => at(h)?.enabled ?? true,
    isVisible: (h: bigint) => at(h)?.visible ?? true,
    topLevelWindows: () => desktop.map((w) => w.hwnd),
    title: (h: bigint) => at(h)?.title ?? "",
    className: (h: bigint) => at(h)?.cls ?? "",
    ...over,
  };
}
const MAIN = 500n;
const main = (enabled = false): W => ({ hwnd: MAIN, owner: null, enabled, title: "Editor" });
const modal: W = { hwnd: 777n, owner: MAIN, enabled: true, title: "Save changes?", cls: "#32770" };
const stranger: W = { hwnd: 9n, owner: null, enabled: true, title: "Another app", thread: 2 };

describe("productionFindBlockingWindow", () => {
  const origin = { kind: "window" as const, id: "Editor", hwnd: "500" };

  it("follows GW_OWNER, so a WinForms Form dialog — its own GA_ROOTOWNER — is in the family", () => {
    // win2, 2026-09-19 (internal `e7f3980`): a WinForms ShowDialog is owned by the main window, but
    // GA_ROOTOWNER answers the dialog itself (it walks GetParent, which returns the owner only for
    // a popup). Keyed on GA_ROOTOWNER, the dialog fell out of the family and the act answered ok:true.
    // The model's `owner` is GW_OWNER; nothing here answers GA_ROOTOWNER at all.
    const winformsDialog: W = { hwnd: 4328194n, owner: MAIN, enabled: true, title: "MODAL" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([winformsDialog, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "4328194" } });
  });

  it("names the dialog, with its handle, when the entity's window is disabled by it", () => {
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([stranger, modal, main()]))).toEqual({
      kind: "blocked",
      blocker: { name: "Save changes?", role: "dialog", hwnd: "777" },
    });
  });

  it("names the INNER dialog of a nested pair, the live one at the top", () => {
    // ShowDialog (600) opened a MessageBox (800): the first is disabled now, the second is live.
    const outer: W = { hwnd: 600n, owner: MAIN, enabled: false, title: "Options" };
    const inner: W = { hwnd: 800n, owner: 600n, enabled: true, title: "Error" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([inner, outer, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "800" } });
  });

  it("names the modal when WinForms' MessageBox has disabled a palette of the same owner too", () => {
    // win2, 2026-09-19 (internal `a24d9c3`): the last active popup was the palette, disabled by the
    // same modal — the "last active popup" reading fell silent and the act answered ok:true.
    const palette: W = { hwnd: 650n, owner: MAIN, enabled: false, title: "Palette" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([palette, modal, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("does not name a hidden window of the family, or a window of another family", () => {
    const hidden: W = { hwnd: 640n, owner: MAIN, enabled: true, visible: false, title: "Old" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([stranger, hidden, modal, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("asks the family at the TOP OF THE OWNER CHAIN when the entity sits in a dialog that opened another", () => {
    // The entity is in dialog A (600, disabled now); A opened B (800), so B's owner is A and A's is
    // the main window. The family is the top of that chain, not A — asking A's own family finds
    // nothing (a mutation survived without this cell: the others have the entity in the main window).
    const outer: W = { hwnd: 600n, owner: MAIN, enabled: false, title: "Options" };
    const inner: W = { hwnd: 800n, owner: 600n, enabled: true, title: "Error" };
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Options", hwnd: "600" } }), undefined, deps([inner, outer, main()]));
    expect(got).toMatchObject({ kind: "blocked", blocker: { hwnd: "800" } });
  });

  it("names the live window NEAREST THE TOP when two of the family are live", () => {
    // A Win32 DialogBox disables only its owner, so an owned palette stays enabled; the modal sits
    // above it. (If the palette is activated above the modal, the palette is named — the refusal is
    // still right, the owner IS disabled; recorded in internal #126 as the limit.)
    const palette: W = { hwnd: 650n, owner: MAIN, enabled: true, title: "Palette" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([modal, palette, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("does not name the entity's OWN OWNER, when an owned window is disabled for the app's own reasons", () => {
    // Gate 2, round 3: an owned palette the app disabled (no modal anywhere) named its enabled main
    // window as the dialog blocking it. A modal is owned by what it blocks, never its owner.
    const palette: W = { hwnd: 650n, owner: MAIN, enabled: false, title: "Palette" };
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Palette", hwnd: "650" } }), undefined, deps([palette, main(true), stranger]));
    expect(got).toEqual({ kind: "cannot_say" });
  });

  it("names an OWNERLESS modal of the same thread — MB_TASKMODAL, or WPF ShowDialog with no Owner", () => {
    // Gate 2, round 3: such a dialog disables every top-level window of its thread and owns none of
    // them, so it is in no owner family. The thread is the fallback. A window of another thread
    // (the stranger, above it) is not named.
    const taskModal: W = { hwnd: 880n, owner: null, enabled: true, title: "Task modal", thread: 1 };
    const got = productionFindBlockingWindow(entity({ origin }), undefined, deps([stranger, taskModal, main()]));
    expect(got).toMatchObject({ kind: "blocked", blocker: { hwnd: "880" } });
  });

  it("prefers the owner family over the thread when both have a live window", () => {
    const taskModal: W = { hwnd: 880n, owner: null, enabled: true, title: "Same thread, unowned", thread: 1 };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([taskModal, modal, main()]))).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("refuses an UNTITLED dialog too, naming it by class and handle", () => {
    const untitled: W = { ...modal, title: "" };
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([untitled, main()]))).toEqual({
      kind: "blocked",
      blocker: { name: "#32770", role: "dialog", hwnd: "777" },
    });
  });

  it("asks the element's OWN window first, so a dialog's own button is not refused as blocked by itself", () => {
    // Gate 2, round 2: a dialog's "OK" discovered from the main window records the main window's
    // handle. The button's own window roots at the dialog, which is enabled.
    const root = vi.fn((h: bigint) => (h === 900n ? 777n : h));
    const got = productionFindBlockingWindow(
      entity({ origin, locator: { uia: { name: "OK", nativeWindowHandle: "900" } } }),
      undefined,
      deps([modal, main()], { root }),
    );
    // Its window takes input — the OS answered, and the snapshot's guess (the dialog it sits in, a
    // `Window` in the main window's tree) is set aside by it.
    expect(got).toEqual({ kind: "takes_input" });
    expect(root).toHaveBeenCalledWith(900n);
  });

  it.each([
    ["takes_input", "the element's OWN window roots at an enabled window", { origin, locator: { uia: { name: "OK", nativeWindowHandle: "900" } } }, [modal, main(true)]],
    ["cannot_say", "the window is disabled with nothing live in its family (its own work)", { origin }, [stranger, main()]],
  ])("answers %s when %s", (kind, _label, e, desktop) => {
    const root = (h: bigint) => (h === 900n ? MAIN : h);
    expect(productionFindBlockingWindow(entity(e as Partial<UiEntity>), undefined, deps(desktop as W[], { root }))).toEqual({ kind });
  });

  it("answers cannot_say — not takes_input — when the enabled window was asked about by the recorded handle, not the element's own", () => {
    // Gate 2 on this change: UIA lists an owned window's controls under its owner, so a handle-less
    // control in a modeless window W that opened its own MessageBox records the OWNER's handle. The
    // owner is enabled; W is not. Taking the owner's answer as the element's set the MessageBox aside.
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([modal, main(true)]))).toEqual({ kind: "cannot_say" });
  });

  it("asks the ROOT of the element's own window, not the handle itself — a child control is not disabled with its window", () => {
    // Gate 2: `isEnabled(handle)` in place of `isEnabled(root)` survived every cell. A dialog
    // disables the top-level window; the child control's own HWND stays enabled, and reading it
    // would answer takes_input under a real ShowDialog — and now set the snapshot aside too.
    const root = (h: bigint) => (h === 900n ? MAIN : h);
    const got = productionFindBlockingWindow(
      entity({ origin, locator: { uia: { name: "Save", nativeWindowHandle: "900" } } }),
      undefined,
      deps([modal, main()], { root }),
    );
    expect(got).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it.each([
    ["no origin at all", undefined],
    ["an origin with no handle (a lane that recorded none)", { kind: "window" as const, id: "Editor" }],
    ["a handle that is not a number", { kind: "window" as const, id: "Editor", hwnd: "Editor" }],
  ])("does not re-resolve by title and asks nothing, for %s", (_label, o) => {
    const root = vi.fn((h: bigint) => h);
    expect(productionFindBlockingWindow(entity(o ? { origin: o } : {}), undefined, deps([modal, main()], { root }))).toEqual({ kind: "cannot_say" });
    expect(root).not.toHaveBeenCalled();
  });

  it("answers cannot_say when the window has no root — it closed between discover and the act", () => {
    // Not `takes_input`: a closed window takes nothing, and setting the snapshot aside on it would
    // let the act through on the absence of an answer (a mutation that did so survived every cell).
    expect(productionFindBlockingWindow(entity({ origin }), undefined, deps([modal, main()], { root: () => null }))).toEqual({ kind: "cannot_say" });
  });

  it("answers cannot_say, not a refusal, when the OS cannot be read", () => {
    const got = productionFindBlockingWindow(entity({ origin }), undefined, deps([modal, main()], {
      topLevelWindows: () => {
        throw new Error("native binding absent");
      },
    }));
    expect(got).toEqual({ kind: "cannot_say" });
  });
});

describe("an entity with no recorded handle is asked about the aim's window", () => {
  const aim = { kind: "aim" as const, title: "Editor", hwnd: MAIN, identity: { pid: 42, processName: "editor.exe", processStartTimeMs: 1000 } };

  it("asks the aim's window when the entity's lane recorded no handle", () => {
    // win2, 2026-09-19: on an addon older than #619 the UIA lane records no handle, and the first
    // version asked nothing — a silence that reads the same as "not blocked".
    const root = vi.fn((h: bigint) => h);
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Editor" } }), aim, deps([modal, main()], {
      root,
      identityNow: () => aim.identity,
    }));
    expect(got).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
    expect(root).toHaveBeenCalledWith(MAIN);
  });

  it("does not ask the aim's window once its handle names another process's window", () => {
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Editor" } }), aim, deps([modal, main()], {
      identityNow: () => ({ ...aim.identity, pid: 99 }),
    }));
    expect(got).toEqual({ kind: "cannot_say" });
  });

  it("checks the aim's owner BEFORE the window's state — an enabled window of another process is not takes_input", () => {
    // Gate 2: moving the enabled check ahead of the identity check survived — every identity cell
    // had a disabled window. The element's own handle roots at the aim's window, which now belongs to
    // another process and is enabled.
    const got = productionFindBlockingWindow(
      entity({ origin: { kind: "window", id: "Editor" }, locator: { uia: { name: "OK", nativeWindowHandle: "900" } } }),
      aim,
      deps([modal, main(true)], { root: (h: bigint) => (h === 900n ? MAIN : h), identityNow: () => ({ ...aim.identity, pid: 99 }) }),
    );
    expect(got).toEqual({ kind: "cannot_say" });
  });

  it("checks the aim's owner even when the entity recorded the same window's handle", () => {
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Editor", hwnd: "500" } }), aim, deps([modal, main()], {
      identityNow: () => ({ ...aim.identity, pid: 99 }),
    }));
    expect(got).toEqual({ kind: "cannot_say" });
  });

  it("asks nothing when neither the entity nor the aim has a handle", () => {
    const root = vi.fn((h: bigint) => h);
    const got = productionFindBlockingWindow(entity({ origin: { kind: "window", id: "Editor" } }), { kind: "aim", title: "Editor" }, deps([modal, main()], { root }));
    expect(got).toEqual({ kind: "cannot_say" });
    expect(root).not.toHaveBeenCalled();
  });
});

describe("the production wiring reaches the guard", () => {
  // Gate 2, round 1: every cell above hands the env or the finder in directly, so deleting any of
  // the three wiring lines (register → facade → registry → env) left them all green while the
  // protection silently disappeared in production.
  it("registers productionFindBlockingWindow on the production facade", () => {
    const facade = getDesktopFacade();
    try {
      expect((facade as unknown as { opts: { findBlockingWindow?: unknown } }).opts.findBlockingWindow).toBe(productionFindBlockingWindow);
    } finally {
      _resetFacadeForTest();
    }
  });

  it("hands the finder the session's aim, read at touch time", async () => {
    const findBlockingWindow = vi.fn(() => ({ kind: "cannot_say" as const }));
    const facade = new DesktopFacade(async () => [candidate()], { executorFn: async () => "mouse", findBlockingWindow });
    const view = await facade.see({ target: { hwnd: "500" } });
    await facade.touch({ lease: view.entities[0].lease });
    expect(findBlockingWindow).toHaveBeenCalledTimes(1);
    expect(findBlockingWindow.mock.calls[0][1]).toMatchObject({ kind: "aim", hwnd: 500n });
  });

  it("carries a facade option through the registry to the guard", async () => {
    const facade = new DesktopFacade(async () => [candidate()], {
      executorFn: async () => "mouse",
      findBlockingWindow: () => ({ kind: "blocked" as const, blocker: { name: "Save changes?", role: "dialog", hwnd: "777" } }),
    });
    const view = await facade.see({ target: { windowTitle: "Editor" } });
    const result = await facade.touch({ lease: view.entities[0].lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("modal_blocking");
      expect(result.blockingElement).toEqual({ name: "Save changes?", role: "dialog", hwnd: "777" });
    }
  });
});
