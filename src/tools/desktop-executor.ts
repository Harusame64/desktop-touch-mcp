/**
 * desktop-executor.ts — Route desktop_touch actions to the appropriate native backend.
 *
 * Priority order:
 *   1. uia      → clickElement / setElementValue (UIA Invoke/ValuePattern)
 *   2. cdp      → CDP click via screen coords / evaluateInTab fill
 *   3. terminal → keyboard type into terminal window (foreground path — steals focus)
 *   4. mouse    → mouse click at entity rect center (visual-only fallback)
 *
 * All deps are injectable so tests can mock every route without OS bindings.
 * Real deps are imported lazily (dynamic import) to keep module load light.
 */

import type { UiEntity, ExecutorKind } from "../engine/world-graph/types.js";
import type { TouchAction } from "../engine/world-graph/guarded-touch.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";

// ── Injectable backend interface ──────────────────────────────────────────────

export interface ExecutorDeps {
  /** UIA Invoke: click/invoke by label (name) or automationId. */
  uiaClick(windowTitle: string, name?: string, automationId?: string): Promise<void>;
  /** UIA ValuePattern: type text into a textbox. */
  uiaSetValue(windowTitle: string, value: string, name?: string, automationId?: string): Promise<void>;
  /** CDP: click a DOM element by CSS selector. */
  cdpClick(selector: string, tabId?: string): Promise<void>;
  /** CDP: fill a text input by CSS selector.
   * NOTE: uses DEFAULT_CDP_PORT (9222). Phase 2 should extend TargetSpec with optional cdpPort. */
  cdpFill(selector: string, value: string, tabId?: string): Promise<void>;
  /**
   * Terminal: send text to a terminal window (foreground path via keyboard.type).
   * This steals focus from the LLM client. Phase 2 should prefer the background
   * WM_CHAR path from terminalSendHandler to avoid focus disruption.
   */
  terminalSend(windowTitle: string, text: string): Promise<void>;
  /** Mouse: click at absolute screen coordinates. */
  mouseClick(x: number, y: number): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWindowTitle(target?: TargetSpec): string {
  return target?.windowTitle ?? target?.hwnd ?? "@active";
}

function rectCenter(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

// ── Executor factory ──────────────────────────────────────────────────────────

/**
 * Build an ExecutorFn that routes to the appropriate native backend.
 *
 * Called lazily so `target` reflects the current session.lastTarget at touch time.
 * Pass `deps` to inject mock backends in tests; omit for production native bindings.
 *
 * Routing priority: uia → cdp → terminal → mouse (visual fallback)
 * Locator fields (P2-A) are used when present; sourceId is used as a fallback
 * for candidates that pre-date the locator migration.
 *
 * UIA click failure gracefully falls through to mouse when entity has a rect.
 */
export function createDesktopExecutor(
  target: TargetSpec | undefined,
  deps?: ExecutorDeps
): (entity: UiEntity, action: TouchAction, text?: string) => Promise<ExecutorKind> {
  const d = deps ?? getSharedRealDeps();

  return async (entity, action, text) => {
    const winTitle = resolveWindowTitle(target);

    // ── UIA route ────────────────────────────────────────────────────────────
    if (entity.sources.includes("uia")) {
      // Prefer typed locator; fall back to sourceId (legacy bridge — remove in P3).
      const automationId = entity.locator?.uia?.automationId ?? entity.sourceId;
      const name         = entity.locator?.uia?.name ?? entity.label;
      if (action === "type" && text !== undefined) {
        await d.uiaSetValue(winTitle, text, name, automationId);
        return "uia";
      }
      try {
        await d.uiaClick(winTitle, name, automationId);
        return "uia";
      } catch {
        // UIA click failed (element not found, stale tree, etc.).
        // Fall through to mouse if rect is available rather than failing the touch.
        const rect = entity.locator?.visual?.rect ?? entity.rect;
        if (!rect) throw new Error(
          `UIA click failed for "${entity.label ?? entity.entityId}" and no rect for mouse fallback`
        );
        const { x, y } = rectCenter(rect);
        await d.mouseClick(x, y);
        return "mouse";
      }
    }

    // ── CDP route ────────────────────────────────────────────────────────────
    // Prefer locator.cdp.selector; fall back to sourceId (legacy bridge).
    const cdpSelector = entity.locator?.cdp?.selector ?? (entity.sources.includes("cdp") ? entity.sourceId : undefined);
    if (cdpSelector) {
      const cdpTabId = entity.locator?.cdp?.tabId ?? target?.tabId;
      if (action === "type" && text !== undefined) {
        await d.cdpFill(cdpSelector, text, cdpTabId);
        return "cdp";
      }
      await d.cdpClick(cdpSelector, cdpTabId);
      return "cdp";
    }

    // ── Terminal route ───────────────────────────────────────────────────────
    if (entity.sources.includes("terminal")) {
      const termWin = entity.locator?.terminal?.windowTitle ?? winTitle;
      await d.terminalSend(termWin, text ?? "");
      return "terminal";
    }

    // ── Mouse fallback ───────────────────────────────────────────────────────
    if (!entity.rect) {
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": no rect for mouse fallback`
      );
    }
    const { x, y } = rectCenter(entity.rect);
    await d.mouseClick(x, y);
    return "mouse";
  };
}

// ── Real deps (Windows native) ────────────────────────────────────────────────

/**
 * Module-level cache so all sessions share one set of native handles
 * (keyboard/mouse singletons, dynamic-imported modules).
 */
let _realDepsCache: ExecutorDeps | undefined;

function getSharedRealDeps(): ExecutorDeps {
  if (_realDepsCache) return _realDepsCache;
  _realDepsCache = {
    async uiaClick(windowTitle, name, automationId) {
      const { clickElement } = await import("../engine/uia-bridge.js");
      const r = await clickElement(windowTitle, name, automationId);
      if (!r.ok) throw new Error(r.error ?? "UIA click failed");
    },

    async uiaSetValue(windowTitle, value, name, automationId) {
      const { setElementValue } = await import("../engine/uia-bridge.js");
      const r = await setElementValue(windowTitle, value, name, automationId);
      if (!r.ok) throw new Error(r.error ?? "UIA setElementValue failed");
    },

    async cdpClick(selector, tabId) {
      // TODO: support non-default CDP port via TargetSpec.cdpPort (Phase 2)
      const { getElementScreenCoords, DEFAULT_CDP_PORT } = await import("../engine/cdp-bridge.js");
      const coords = await getElementScreenCoords(selector, tabId ?? null, DEFAULT_CDP_PORT);
      if ((coords as { error?: string }).error) {
        throw new Error((coords as { error?: string }).error ?? "CDP getElementScreenCoords failed");
      }
      const { mouse, Button, Point, straightTo } = await import("../engine/nutjs.js");
      await mouse.move(straightTo(new Point(coords.x, coords.y)));
      await mouse.click(Button.LEFT);
    },

    async cdpFill(selector, value, tabId) {
      const { evaluateInTab, DEFAULT_CDP_PORT } = await import("../engine/cdp-bridge.js");
      const expr = `(function(){
  const el = document.querySelector(${JSON.stringify(selector)});
  if(!el) return { ok:false, error:"Element not found: ${selector}" };
  el.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")?.set
    ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value")?.set;
  if(nativeSetter) nativeSetter.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  return { ok:true };
})()`;
      const r = await evaluateInTab(expr, tabId ?? null, DEFAULT_CDP_PORT) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(r.error ?? "CDP fill failed");
    },

    async terminalSend(windowTitle, text) {
      // Foreground path: focus window then type. See docstring on ExecutorDeps.terminalSend
      // for the Phase 2 plan to use the WM_CHAR background path instead.
      const { keyboard } = await import("../engine/nutjs.js");
      const { enumWindowsInZOrder, restoreAndFocusWindow } = await import("../engine/win32.js");
      const wins = enumWindowsInZOrder();
      const win = wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
      if (!win) throw new Error(`Terminal window not found: "${windowTitle}"`);
      restoreAndFocusWindow(win.hwnd);
      await keyboard.type(text);
    },

    async mouseClick(x, y) {
      const { mouse, Button, Point, straightTo } = await import("../engine/nutjs.js");
      await mouse.move(straightTo(new Point(x, y)));
      await mouse.click(Button.LEFT);
    },
  };
  return _realDepsCache;
}
