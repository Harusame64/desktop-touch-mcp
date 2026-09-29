/**
 * internal #211 (C) — a `Window` whose own `WindowPattern.IsModal` reads `false` is not a modal.
 *
 * MEASURED win2 (S6, 2026-09-29): `IsModal` was `true` on the four real modals (a Win32 save dialog,
 * a MessageBox, WinForms and WPF `ShowDialog`) and `false` on a modeless Find/Replace and on
 * ordinary windows; a title bar and a UWP `CoreWindow` do not support the pattern. The snapshot's
 * guess counted every UIA `Window`, so on a handle-less (XAML) control, where the OS answer does not
 * outrank the snapshot, a modeless window refused the act on its owner, and its appearing after an
 * act read as `modal_appeared`.
 */
import { describe, expect, it, vi } from "vitest";

import { classifyModal } from "../../src/engine/world-graph/session-registry.js";
import { GuardedTouchLoop, type SnapshotWindowAnswer, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const GEN = "gen-1";

function entity(opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e",
    role: "unknown",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [],
    generation: GEN,
    evidenceDigest: "d",
    ...opts,
  };
}

const window = (isModal: boolean | undefined, opts: Partial<UiEntity> = {}) =>
  entity({ controlType: "Window", ...(isModal !== undefined && { locator: { uia: { name: "W", isModal } } }), ...opts });

describe("classifyModal and a window's own IsModal", () => {
  for (const context of ["pre-touch", "post-touch-diff"] as const) {
    it(`does not count a Window that says it is not modal (${context})`, () => {
      expect(classifyModal(window(false), context)).toBe(false);
    });

    it(`counts a Window that says it is modal (${context})`, () => {
      expect(classifyModal(window(true), context)).toBe(true);
    });

    it(`counts a Window that did not say, as before (${context})`, () => {
      expect(classifyModal(window(undefined), context)).toBe(true);
    });
  }

  it("does not make a non-Window a modal because it says so", () => {
    expect(classifyModal(entity({ controlType: "Pane", locator: { uia: { name: "P", isModal: true } } }), "pre-touch")).toBe(false);
  });

  it("does not count a Window that is not from UIA, whatever it says", () => {
    expect(classifyModal(window(true, { sources: ["visual_gpu"] }), "pre-touch")).toBe(false);
  });
});

describe("the refusal before an act, through the facade", () => {
  function candidate(label: string, controlType: string, isModal?: boolean): UiEntityCandidate {
    const role = controlType === "Button" ? "button" : "unknown";
    return {
      source: "uia",
      target: { kind: "window", id: "Notepad" },
      label,
      role,
      controlType,
      rect: { x: 10, y: 10, width: 60, height: 20 },
      actionability: role === "button" ? ["invoke"] : [],
      confidence: 0.9,
      observedAtMs: 0,
      provisional: false,
      digest: `d-${label}`,
      locator: { uia: { name: label, ...(isModal !== undefined && { isModal }) } },
    } as unknown as UiEntityCandidate;
  }

  async function pressSave(beside: UiEntityCandidate[]) {
    const execute = vi.fn(async () => "uia" as const);
    const facade = new DesktopFacade(async () => [candidate("Save", "Button"), ...beside], { executorFn: execute });
    const view = await facade.see({ target: { windowTitle: "Notepad" } });
    const save = view.entities.find((e) => e.label === "Save");
    expect(save).toBeDefined();
    return { result: await facade.touch({ lease: save!.lease }), execute };
  }

  it("presses beside a modeless window (Find/Replace, IsModal false)", async () => {
    const { result, execute } = await pressSave([candidate("置換", "Window", false)]);
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses beside a modal window (IsModal true), naming it", async () => {
    const { result, execute } = await pressSave([candidate("名前を付けて保存", "Window", true)]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "名前を付けて保存" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses beside a window that did not say (the control: the old behaviour)", async () => {
    const { result } = await pressSave([candidate("Confirm", "Window")]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Confirm" } });
  });

  it("names the MessageBox, not the modeless window that opened it, and refuses (gate 2's case on #686)", async () => {
    const { result } = await pressSave([candidate("Tools", "Window", false), candidate("Delete item?", "Window", true)]);
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "Delete item?" } });
  });
});

describe("the refusal before an act, when production asks each window by its handle", () => {
  async function pressSave(beside: UiEntityCandidate[], answer: SnapshotWindowAnswer) {
    const execute = vi.fn(async () => "uia" as const);
    const judgeSnapshotWindow = vi.fn(() => answer);
    const save = { source: "uia", target: { kind: "window", id: "Notepad" }, label: "Save", role: "button", rect: { x: 10, y: 10, width: 60, height: 20 }, actionability: ["invoke"], confidence: 0.9, observedAtMs: 0, provisional: false, locator: { uia: { name: "Save" } } } as unknown as UiEntityCandidate;
    const facade = new DesktopFacade(async () => [save, ...beside], { executorFn: execute, judgeSnapshotWindow });
    const view = await facade.see({ target: { windowTitle: "Notepad" } });
    const result = await facade.touch({ lease: view.entities.find((e) => e.label === "Save")!.lease });
    return { result, execute, judgeSnapshotWindow };
  }
  const win = (label: string, isModal?: boolean) => ({
    source: "uia", target: { kind: "window", id: "Notepad" }, label, role: "unknown", controlType: "Window", rect: { x: 0, y: 0, width: 300, height: 200 }, actionability: [], confidence: 0.9, observedAtMs: 0, provisional: false,
    locator: { uia: { name: label, nativeWindowHandle: "777", ...(isModal !== undefined && { isModal }) } },
  }) as unknown as UiEntityCandidate;

  it("presses beside a modeless window the OS says may block", async () => {
    const { result, execute } = await pressSave([win("置換", false)], "may_block");
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses beside a modal one the OS says may block", async () => {
    const { result } = await pressSave([win("名前を付けて保存", true)], "may_block");
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "名前を付けて保存" } });
  });

  it("does not ask the window being acted on about itself (a Window with an affordance)", async () => {
    const execute = vi.fn(async () => "uia" as const);
    const self = { ...win("ツール", false), actionability: ["click"] } as unknown as UiEntityCandidate;
    const facade = new DesktopFacade(async () => [self], { executorFn: execute, judgeSnapshotWindow: () => "closed" });
    const view = await facade.see({ target: { windowTitle: "Notepad" } });
    const target = view.entities.find((e) => e.label === "ツール");
    expect(target).toBeDefined();
    const result = await facade.touch({ lease: target!.lease });
    expect(result.ok).toBe(true);
  });

  it("still refuses as a stale read when a modeless window the read listed has closed (item 9; gate 2)", async () => {
    const { result, execute } = await pressSave([win("置換", false)], "closed");
    expect(result).toMatchObject({ ok: false, reason: "lease_generation_mismatch", detail: expect.stringContaining("置換") });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("what an act says appeared", () => {
  async function diffAfter(appeared: UiEntity) {
    const button = entity({ entityId: "btn", role: "button", label: "Replace", sources: ["visual_gpu"], rect: { x: 1, y: 1, width: 10, height: 10 } });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(button, "v1");
    const env: TouchEnvironment = {
      resolveLiveEntities: () => [button],
      currentGeneration: () => GEN,
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: async () => "mouse",
      resolvePostTouchEntities: async () => [button, appeared],
    };
    const result = await new GuardedTouchLoop(store, env).touch({ lease });
    expect(result.ok).toBe(true);
    return result.ok ? result.diff : [];
  }

  it("says entity_appeared, not modal_appeared, for a modeless window", async () => {
    const diff = await diffAfter(window(false, { entityId: "find" }));
    expect(diff).toContain("entity_appeared");
    expect(diff).not.toContain("modal_appeared");
  });

  it("says modal_appeared for a modal one", async () => {
    const diff = await diffAfter(window(true, { entityId: "save-as" }));
    expect(diff).toContain("modal_appeared");
    expect(diff).not.toContain("entity_appeared");
  });

  it("still says modal_dismissed when a modeless window closes: its going has no other code (gate 2)", async () => {
    const find = window(false, { entityId: "find" });
    const button = entity({ entityId: "btn", role: "button", label: "Close", sources: ["visual_gpu"], rect: { x: 1, y: 1, width: 10, height: 10 } });
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(button, "v1");
    const env: TouchEnvironment = {
      resolveLiveEntities: () => [button, find],
      currentGeneration: () => GEN,
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: async () => "mouse",
      resolvePostTouchEntities: async () => [button],
    };
    const result = await new GuardedTouchLoop(store, env).touch({ lease });
    expect(result.ok && result.diff).toContain("modal_dismissed");
  });

  it("says modal_appeared for one that did not say, as before", async () => {
    expect(await diffAfter(window(undefined, { entityId: "dialog" }))).toContain("modal_appeared");
  });
});
