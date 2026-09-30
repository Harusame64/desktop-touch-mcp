/**
 * internal #224 — a `type` that no route can carry says so, and does not claim routes it never took.
 *
 * MEASURED win2 (2026-09-30): `desktop_act(type)` on Word's body (an Edit with no UIA value, so
 * `preferredExecutors ['mouse']` / `unsupportedExecutors ['uia']`) was refused in 3–10 ms with the
 * generic `executor_failed`, `detail` null, and advice saying UIA setValue and background WM_CHAR had
 * been tried. Neither had run.
 */
import { describe, expect, it, vi } from "vitest";

import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";

const body: UiEntity = {
  entityId: "body",
  role: "textbox",
  label: "ページ 1 のコンテンツ",
  controlType: "Edit",
  confidence: 0.9,
  sources: ["uia"],
  affordances: [],
  generation: "gen-1",
  evidenceDigest: "d-body",
  rect: { x: 141, y: 369, width: 793, height: 361 },
  preferredExecutors: ["mouse"],
  unsupportedExecutors: ["uia"],
};

function deps(): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  };
}

describe("a type no route can carry", () => {
  it("is refused with a sentence for the caller: nothing typed, nothing tried, and what to do", async () => {
    const d = deps();
    const err = await createDesktopExecutor({ hwnd: "500" }, d)(body, "type", "x").then(() => undefined, (e: unknown) => e);
    expect((err as { callerDetail?: string }).callerDetail).toBe(
      `Nothing was typed, and no way of typing was tried: "ページ 1 のコンテンツ" offers no UI Automation value ` +
      `to write and no keyboard route. Click it, then type with keyboard({action:'type', text, method:'foreground'}).`,
    );
    expect(d.uiaSetValue).not.toHaveBeenCalled();
    expect(d.keyboardTypeBg).not.toHaveBeenCalled();
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("reaches the reply as detail", async () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(body, "v1");
    const exec = createDesktopExecutor({ hwnd: "500" }, deps());
    const env: TouchEnvironment = {
      resolveLiveEntities: () => [body],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: (e, action, text) => exec(e, action, text),
    };
    const result = await new GuardedTouchLoop(store, env).touch({ lease, action: "type", text: "x" });
    expect(result).toMatchObject({ ok: false, reason: "executor_failed" });
    expect(result.ok === false && result.detail).toMatch(/^Nothing was typed, and no way of typing was tried/);
  });
});

describe("the executor_failed advice", () => {
  it("no longer says UIA setValue and background WM_CHAR were tried whatever happened", () => {
    const text = JSON.stringify(getSuggestsForCode("ExecutorFailed"));
    expect(text).not.toContain("has already tried");
    expect(text).toContain("only where the entity offers them");
  });
});
