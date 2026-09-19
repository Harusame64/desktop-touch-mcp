/**
 * internal #126 — when the OS says the element's OWN window takes input, the snapshot's `Window`
 * does not refuse the act. An answer about another handle (the recorded one, the aim's) does not
 * outrank it: the window a read was made from can own the window the element is in (gate 2).
 *
 * MEASURED 2026-09-19 win2: after #686 the snapshot rings only on a UIA `Window`, and it still rang
 * on a modeless owned form, an MDI child and a `TopLevel=false` form embedded in the window
 * (internal `62b4590`). Nothing the classifier reads told them from the real modal; the OS did —
 * the real modal's owner was disabled, the others' were not. Gate 2 on #686 found the costliest
 * case: a dialog's own "OK", discovered from the main window, refused by the dialog it sits in.
 *
 * What this gives up, measured (internal `af5ed7d`): Tk's `grab_set` blocks input without
 * disabling the owner. The act is not refused there; with the aim probe on, the `act.modal` row says
 * what the snapshot saw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TouchEnvironment, WindowBlockAnswer } from "../../src/engine/world-graph/guarded-touch.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const GEN = "gen-1";

function entity(opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "ok-button",
    role: "button",
    label: "OK",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [{ verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: GEN,
    evidenceDigest: "d-ok",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...opts,
  };
}

// What the snapshot holds beside the target: the owned form UIA shows in the owner's tree.
const ownedForm = entity({ entityId: "owned-form", role: "unknown", label: "OWNED", controlType: "Window", affordances: [] });

let dir: string;
let logPath: string;
const rows = (): Record<string, unknown>[] =>
  existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const setAsideRows = () => rows().filter((r) => r.seam === "act.modal" && r.answer === "snapshot_set_aside");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "os-outranks-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

async function touch(answer: WindowBlockAnswer | undefined, snapshot: UiEntity[]) {
  const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
  const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
  const { classifyModal } = await import("../../src/engine/world-graph/session-registry.js");
  const target = snapshot[0];
  const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
  const lease = store.issue(target, "v1");
  const execute = vi.fn(async () => "uia" as const);
  // The production defaults' shape: the shared classifier over the snapshot, self excluded.
  const blocker = (e: UiEntity) => snapshot.find((c) => classifyModal(c, "pre-touch", { excludeSelf: e })) ?? null;
  const env: TouchEnvironment = {
    resolveLiveEntities: () => snapshot,
    currentGeneration: () => GEN,
    isModalBlocking: (e) => blocker(e) !== null,
    findBlockingModal: blocker,
    checkViewport: () => null,
    execute,
    resolvePostTouchEntities: async () => snapshot,
    ...(answer !== undefined && { findBlockingWindow: () => answer }),
  };
  const result = await new GuardedTouchLoop(store, env).touch({ lease });
  return { result, execute };
}

describe("the OS's answer and the snapshot's guess", () => {
  it("proceeds when the OS says the window takes input, though the snapshot holds a Window", async () => {
    const { result, execute } = await touch({ kind: "takes_input" }, [entity(), ownedForm]);
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("writes what it set aside, so a press that lands nowhere can be traced to it", async () => {
    await touch({ kind: "takes_input" }, [entity(), ownedForm]);
    expect(setAsideRows()).toEqual([
      expect.objectContaining({ entityId: "ok-button", answer: "snapshot_set_aside", because: "window_enabled", snapshotBlocker: "OWNED" }),
    ]);
  });

  it("writes no set-aside row when the snapshot had nothing to set aside", async () => {
    const { result } = await touch({ kind: "takes_input" }, [entity()]);
    expect(result.ok).toBe(true);
    expect(setAsideRows()).toEqual([]);
  });

  it("still refuses on the snapshot when the OS cannot say", async () => {
    const { result, execute } = await touch({ kind: "cannot_say" }, [entity(), ownedForm]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "OWNED" } });
    expect(execute).not.toHaveBeenCalled();
    expect(setAsideRows()).toEqual([]);
  });

  it("still refuses on the snapshot when nothing asked the OS (no finder wired)", async () => {
    const { result, execute } = await touch(undefined, [entity(), ownedForm]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses on the OS's blocked answer, whatever the snapshot holds", async () => {
    const { result, execute } = await touch({ kind: "blocked", blocker: { name: "MODAL", role: "dialog", hwnd: "777" } }, [entity()]);
    expect(result).toEqual({ ok: false, reason: "modal_blocking", diff: [], blockingElement: { name: "MODAL", role: "dialog", hwnd: "777" } });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("through the facade and the registry", () => {
  function uiaCandidate(label: string, controlType: string, role: "button" | "unknown", digest: string): UiEntityCandidate {
    return {
      source: "uia",
      target: { kind: "window", id: "Editor" },
      label,
      role,
      controlType,
      rect: { x: 10, y: 10, width: 60, height: 20 },
      actionability: role === "button" ? ["invoke"] : [],
      confidence: 0.9,
      observedAtMs: 0,
      provisional: false,
      digest,
    } as unknown as UiEntityCandidate;
  }

  it("a dialog's own OK, discovered from the main window, is pressed when its window takes input", async () => {
    // Gate 2 on #686: the snapshot held the dialog (`Window`) and its OK, and refused the OK.
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const facade = new DesktopFacade(async () => [uiaCandidate("OK", "Button", "button", "d-ok"), uiaCandidate("Confirm", "Window", "unknown", "d-dialog")], {
      executorFn: async () => "uia",
      findBlockingWindow: () => ({ kind: "takes_input" }),
    });
    const view = await facade.see({ target: { windowTitle: "Editor" } });
    const ok = view.entities.find((e) => e.label === "OK");
    expect(ok).toBeDefined();
    const result = await facade.touch({ lease: ok!.lease });
    expect(result.ok).toBe(true);
  });

  it("a handle-less control in an owned window that opened its own MessageBox is still refused (gate 2)", async () => {
    // M (500) is enabled; the modeless window W (600) it owns has opened MessageBox(W) (780), which
    // disabled W alone. UIA lists W's controls under M, so "Apply" records M's handle and has none of
    // its own. The OS answer is about M — not the element's own window — so it does not set the
    // snapshot aside, and the snapshot still holds W and the MessageBox. The parent refused this;
    // the first version of this change pressed it.
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const { productionFindBlockingWindow } = await import("../../src/tools/desktop-register.js");
    const desktop = new Map<bigint, { owner: bigint | null; enabled: boolean; title: string }>([
      [780n, { owner: 600n, enabled: true, title: "Delete item?" }],
      [600n, { owner: 500n, enabled: false, title: "Tools" }],
      [500n, { owner: null, enabled: true, title: "Editor" }],
    ]);
    const deps = {
      root: (h: bigint) => (desktop.has(h) ? h : null),
      owner: (h: bigint) => desktop.get(h)?.owner ?? null,
      isEnabled: (h: bigint) => desktop.get(h)?.enabled ?? true,
      isVisible: () => true,
      topLevelWindows: () => [...desktop.keys()],
      threadOf: () => 1,
      title: (h: bigint) => desktop.get(h)?.title ?? "",
      className: () => "",
    };
    const inM = (c: UiEntityCandidate) => ({ ...c, originHwnd: "500" }) as UiEntityCandidate;
    const facade = new DesktopFacade(async () => [
      inM(uiaCandidate("Apply", "Button", "button", "d-apply")),
      inM(uiaCandidate("Tools", "Window", "unknown", "d-tools")),
      inM(uiaCandidate("Delete item?", "Window", "unknown", "d-msgbox")),
    ], {
      executorFn: async () => "uia",
      findBlockingWindow: (e, aim) => productionFindBlockingWindow(e, aim, deps),
    });
    const view = await facade.see({ target: { windowTitle: "Editor" } });
    const apply = view.entities.find((e) => e.label === "Apply");
    expect(apply).toBeDefined();
    const result = await facade.touch({ lease: apply!.lease });
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking" });
    expect(setAsideRows()).toEqual([]);
    expect(rows().find((r) => r.seam === "act.modal")).toMatchObject({ askedFrom: "entity_origin", answer: "window_enabled", outranksSnapshot: false });
  });

  it("the same snapshot is refused when the OS cannot say", async () => {
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const facade = new DesktopFacade(async () => [uiaCandidate("OK", "Button", "button", "d-ok"), uiaCandidate("Confirm", "Window", "unknown", "d-dialog")], {
      executorFn: async () => "uia",
      findBlockingWindow: () => ({ kind: "cannot_say" }),
    });
    const view = await facade.see({ target: { windowTitle: "Editor" } });
    const ok = view.entities.find((e) => e.label === "OK");
    const result = await facade.touch({ lease: ok!.lease });
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Confirm" } });
  });
});
