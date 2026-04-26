/**
 * desktop-executor.ts — Route desktop_act actions to the appropriate native backend.
 *
 * Priority order:
 *   1. uia      → clickElement / setElementValue (UIA Invoke/ValuePattern)
 *   2. cdp      → CDP click via screen coords / evaluateInTab fill
 *   3. terminal → background WM_CHAR injection (no focus steal); explicit fail if unsupported
 *   4. mouse    → mouse click at entity rect center (visual-only fallback)
 *
 * All deps are injectable so tests can mock every route without OS bindings.
 * Real deps are imported lazily (dynamic import) to keep module load light.
 *
 * G2: terminal route now uses background WM_CHAR path via bg-input.ts.
 *     On unsupported windows (Chromium, UWP) it throws explicitly so the caller
 *     gets ok:false reason:"executor_failed" and can fall back to V1 terminal({action:'send'}).
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
   * Terminal: send text to a terminal window via background WM_CHAR injection (G2).
   * Does not steal focus. Throws explicitly for unsupported windows (Chromium, UWP).
   * On failure, caller sees ok:false reason:"executor_failed" and can fall back to V1 terminal({action:'send'}).
   */
  terminalSend(windowTitle: string, text: string): Promise<void>;
  /** Mouse: click at absolute screen coordinates. */
  mouseClick(x: number, y: number): Promise<void>;
}

// ── G2: Background terminal send — injectable for testing ─────────────────────

/**
 * Injectable deps for the background terminal send path.
 * Exported so unit tests can exercise the routing logic without OS bindings.
 */
export interface TerminalBgDeps {
  /** Find terminal window by title substring. Returns undefined if not found. */
  findWindow(windowTitle: string): { hwnd: unknown; title: string } | undefined;
  /** Check if WM_CHAR injection is supported for this HWND. */
  canBgSend(hwnd: unknown): { supported: boolean; reason?: string; className?: string };
  /** Send text to HWND via WM_CHAR. Returns partial result if send was incomplete. */
  bgSend(hwnd: unknown, text: string): { sent: number; full: boolean };
}

/**
 * Core background terminal send logic — separated for testability.
 *
 * Throws if:
 *   - Window not found by title
 *   - Background injection not supported (Chromium, UWP, etc.)
 *   - Send incomplete (partial write)
 *
 * Never falls back to foreground focus-steal (G2 contract).
 */
export function terminalBgExecute(
  windowTitle: string,
  text: string,
  deps: TerminalBgDeps
): void {
  const win = deps.findWindow(windowTitle);
  if (!win) throw new Error(`Terminal window not found: "${windowTitle}"`);

  const check = deps.canBgSend(win.hwnd);
  if (!check.supported) {
    throw new Error(
      `Background terminal send not supported for "${windowTitle}" ` +
      `(${check.reason ?? "unknown"}, class: ${check.className ?? "?"}).` +
      ` Use V1 terminal(action='send') as fallback.`
    );
  }

  const result = deps.bgSend(win.hwnd, text);
  if (!result.full) {
    throw new Error(
      `Background terminal send incomplete: sent ${result.sent}/${text.length} chars to "${windowTitle}"`
    );
  }
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
      // Phase 4: 'setValue' absorbs former set_element_value tool — same UIA
      // ValuePattern path as 'type'. Both actions land here for any UIA entity.
      if ((action === "type" || action === "setValue") && text !== undefined) {
        await d.uiaSetValue(winTitle, text, name, automationId);
        return "uia";
      }
      try {
        await d.uiaClick(winTitle, name, automationId);
        return "uia";
      } catch {
        // UIA click failed (element not found, stale tree, etc.).
        // Prefer entity.rect (freshest, from most-recent candidate) over locator.visual.rect
        // which may be stale (captured at recognition time, before the element moved).
        const rect = entity.rect ?? entity.locator?.visual?.rect;
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
      // Phase 4: 'setValue' on a CDP entity uses cdpFill — equivalent to
      // browser_fill for controlled inputs (React/Vue/Svelte).
      if ((action === "type" || action === "setValue") && text !== undefined) {
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
      // G2: Background WM_CHAR path — no focus steal.
      // canInjectViaPostMessage() gates supported terminals (Windows Terminal, conhost).
      // Unsupported windows (Chromium, UWP) throw explicitly — caller gets executor_failed
      // and the LLM description directs them to V1 terminal({action:'send'}) as fallback.
      const { enumWindowsInZOrder } = await import("../engine/win32.js");
      const { canInjectViaPostMessage, postCharsToHwnd } = await import("../engine/bg-input.js");
      const wins = enumWindowsInZOrder();
      terminalBgExecute(windowTitle, text, {
        findWindow: (title) => wins.find((w) => w.title.toLowerCase().includes(title.toLowerCase())),
        canBgSend:  (hwnd) => canInjectViaPostMessage(hwnd),
        bgSend:     (hwnd, t) => postCharsToHwnd(hwnd, t),
      });
    },

    async mouseClick(x, y) {
      const { mouse, Button, Point, straightTo } = await import("../engine/nutjs.js");
      await mouse.move(straightTo(new Point(x, y)));
      await mouse.click(Button.LEFT);
    },
  };
  return _realDepsCache;
}
