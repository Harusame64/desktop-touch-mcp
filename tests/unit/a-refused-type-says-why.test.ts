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

const detailFor = (routes: string, instead: string) =>
  `Nothing was typed, and no route was tried: no route here can carry text to "ページ 1 のコンテンツ" (${routes}). ${instead}`;
const TYPE_INSTEAD = "Put the caret where the text should go (click there, or move it with keyboard keys such as ctrl+End), then keyboard({action:'type', text, method:'foreground'}).";
const SET_INSTEAD = "To replace its contents, click it, select them with keyboard ctrl+a, then keyboard({action:'type', text, method:'foreground'}).";
const WORD_BODY_ROUTES = "UI Automation: ruled out for this element; browser: no page selector for it; terminal: not how this element was read; keyboard: not offered for this element";

async function refusal(e: UiEntity, action: "type" | "setValue") {
  const d = deps();
  const err = await createDesktopExecutor({ hwnd: "500" }, d)(e, action, "x").then(() => undefined, (x: unknown) => x);
  return { err: err as { name?: string; callerDetail?: string; message?: string }, d };
}

describe("a type no route can carry", () => {
  it("is refused with a sentence for the caller: nothing typed, nothing tried, each route's state, what to do", async () => {
    const { err, d } = await refusal(body, "type");
    expect(err.name).toBe("NoTextRouteError");
    expect(err.callerDetail).toBe(detailFor(WORD_BODY_ROUTES, TYPE_INSTEAD));
    expect(d.uiaSetValue).not.toHaveBeenCalled();
    expect(d.keyboardTypeBg).not.toHaveBeenCalled();
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("says to select the contents first for a setValue, which replaces (gate 2)", async () => {
    expect((await refusal(body, "setValue")).err.callerDetail).toBe(detailFor(WORD_BODY_ROUTES, SET_INSTEAD));
  });

  it("says 'not offered' for a route the element has but was left out of, not 'no source' (gate 2)", async () => {
    const { err } = await refusal({ ...body, unsupportedExecutors: undefined }, "type");
    expect(err.callerDetail).toContain("UI Automation: not offered for this element;");
    expect(err.message).toContain("uia=not-in-preferred");
  });

  it("says 'blocked' for a terminal route that is ruled out", async () => {
    const { err } = await refusal({ ...body, sources: ["terminal"], unsupportedExecutors: ["terminal"] }, "type");
    expect(err.callerDetail).toContain("UI Automation: not how this element was read; browser: no page selector for it; terminal: ruled out for this element;");
  });

  it("reaches the reply as executor_failed with that detail (the user's choice, 2026-09-30)", async () => {
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
    expect(result).toEqual({ ok: false, reason: "executor_failed", diff: [], detail: detailFor(WORD_BODY_ROUTES, TYPE_INSTEAD) });
  });
});

describe("the advice", () => {
  it("defers to detail when no route was tried, and says whose the two rungs are", () => {
    const line = getSuggestsForCode("ExecutorFailed").find((l) => l.startsWith("For action='type'"));
    expect(line).toMatch(/^For action='type' or action='setValue': when detail says no route was tried, follow it\. Otherwise, on a UI Automation element desktop_act has already tried/);
  });
});

describe("the view's reason", () => {
  it("is carried when the view gave one (gate 2)", async () => {
    const { err } = await refusal({ ...body, fallbackHint: "use mouse_click — UIA provider failed for this view" }, "type");
    expect(err.callerDetail).toContain(`(${WORD_BODY_ROUTES}). The view says: use mouse_click — UIA provider failed for this view. Put the caret`);
  });

  it("a CDP element with an empty selector is 'no page selector', as the route itself reads it (gate 2)", async () => {
    const { err } = await refusal({ ...body, sources: ["cdp"], unsupportedExecutors: undefined, locator: { cdp: { selector: "" } } } as UiEntity, "type");
    expect(err.callerDetail).toContain("browser: no page selector for it;");
  });
});
