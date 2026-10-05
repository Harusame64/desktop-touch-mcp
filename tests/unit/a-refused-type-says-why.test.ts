/**
 * internal #224 — a `type` that no route can carry says so, and does not claim routes it never took.
 *
 * MEASURED win2 (2026-09-30): `desktop_act(type)` on Word's body (an Edit with no UIA value, so
 * `preferredExecutors ['mouse']` / `unsupportedExecutors ['uia']`) was refused in 3–10 ms with the
 * generic `executor_failed`, `detail` null, and advice saying UIA setValue and background WM_CHAR had
 * been tried. Neither had run.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createDesktopExecutor,
  KeyboardCannotReplaceError,
  KeyboardHostUnavailableError,
  NoTextRouteError,
  type ExecutorDeps,
} from "../../src/tools/desktop-executor.js";
import { GuardedTouchLoop, type TouchEnvironment } from "../../src/engine/world-graph/guarded-touch.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { executorFailedAdviceFor, getSuggestsForCode } from "../../src/tools/_errors.js";

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
    // internal #242: `noRouteTried` rides along, so the advice can say nothing was tried.
    expect(result).toEqual({ ok: false, reason: "executor_failed", diff: [], detail: detailFor(WORD_BODY_ROUTES, TYPE_INSTEAD), noRouteTried: true });
  });

  // Gate 2 on #792: the marker on the two keyboard-road refusals had no cell — removing it from
  // either left every test green. Each of the three is thrown through the loop here.
  const ALL_THREE: Array<[string, () => Error]> = [
    ["NoTextRouteError", () => new NoTextRouteError(body, "type", { uia: "blocked", cdp: "no-selector", terminal: "no-source", keyboard: "not-in-preferred" })],
    ["KeyboardCannotReplaceError", () => new KeyboardCannotReplaceError(body)],
    ["KeyboardHostUnavailableError (not usable)", () => new KeyboardHostUnavailableError(body)],
    ["KeyboardHostUnavailableError (cannot post)", () => new KeyboardHostUnavailableError(body, "cannot_post")],
  ];
  for (const [name, make] of ALL_THREE) {
    it(`carries noRouteTried for ${name}, a refusal made before any route ran (internal #242)`, async () => {
      const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
      const lease = store.issue(body, "v1");
      const env: TouchEnvironment = {
        resolveLiveEntities: () => [body],
        currentGeneration: () => "gen-1",
        isModalBlocking: () => false,
        checkViewport: () => null,
        execute: async () => { throw make(); },
      };
      const result = await new GuardedTouchLoop(store, env).touch({ lease, action: "type", text: "x" });
      expect(result).toMatchObject({ ok: false, reason: "executor_failed", noRouteTried: true });
      // The server instructions, the desktop_act description and the guides tell a caller to
      // recognise this case by detail beginning "Nothing was typed" (gate 2 round 2 on #792:
      // they first keyed on "no route was tried", which only one of the three says).
      expect((result as { detail?: string }).detail).toMatch(/^Nothing was typed/);
    });
  }

  it("does not claim no route was tried for a throw that does not say so (internal #242)", async () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(body, "v1");
    const env: TouchEnvironment = {
      resolveLiveEntities: () => [body],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: async () => { throw new Error("a route ran and failed"); },
    };
    const result = await new GuardedTouchLoop(store, env).touch({ lease, action: "type", text: "x" });
    expect(result).toEqual({ ok: false, reason: "executor_failed", diff: [] });
  });
});

describe("the advice", () => {
  // internal #242 — the list is chosen for the act. A caller reading it, not its conditionals, was
  // told routes were tried that never ran, and was offered clicks for a type.
  const CLICK_REMEDY = /mouse_click|click_element/;
  const ROUTES_TRIED = /has already tried/;

  it("says only 'follow detail' when no route was tried, whatever the action", () => {
    for (const action of ["type", "setValue", "click", "auto", undefined]) {
      const lines = executorFailedAdviceFor(action, true);
      expect(lines, String(action)).toHaveLength(1);
      expect(lines[0], String(action)).toMatch(/^Nothing was typed and no route was tried: detail says why .* follow it$/);
    }
  });

  it("offers no click remedy for a type or setValue whose route ran, and keeps the ladder", () => {
    for (const action of ["type", "setValue"]) {
      const lines = executorFailedAdviceFor(action, false);
      expect(lines.some((l) => CLICK_REMEDY.test(l.replace(/Focus the target window first with focus_window or mouse_click$/, ""))), action).toBe(false);
      expect(lines.some((l) => ROUTES_TRIED.test(l)), action).toBe(true);
      // A stale locator is a cause for a type as much as for a click (gate 2: dropping it was green).
      expect(lines.some((l) => l.startsWith("Re-run {tool:reidentify_element}")), action).toBe(true);
    }
  });

  it("offers no type ladder for a click, and keeps the click remedies", () => {
    for (const action of ["click", "invoke"]) {
      const lines = executorFailedAdviceFor(action, false);
      expect(lines.some((l) => ROUTES_TRIED.test(l)), action).toBe(false);
      expect(lines.some((l) => CLICK_REMEDY.test(l)), action).toBe(true);
    }
  });

  it("answers the whole list where the action does not say which road (auto, select, absent)", () => {
    for (const action of ["auto", "select", undefined]) {
      expect(executorFailedAdviceFor(action, false), String(action)).toEqual(getSuggestsForCode("ExecutorFailed"));
    }
  });

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
