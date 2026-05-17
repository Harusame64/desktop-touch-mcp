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

import type { UiEntity, ExecutorKind, ExecutorOutcome } from "../engine/world-graph/types.js";
import type { TouchAction } from "../engine/world-graph/guarded-touch.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";
import type { AdvertisedExecutorKind } from "../capabilities/registry.js";

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
  /**
   * Issue #327 item E: UIA `setValue` fallback. Posts WM_CHAR to the focused child
   * of the target window via `bg-input.ts::postCharsToHwnd`. Used when the primary
   * UIA `ValuePattern` route throws (e.g. Notepad's RichEditD2DPT entity whose
   * locator name/automationId cannot be re-found by `makeSetElementValueScript`).
   * Throws on unsupported windows (Chromium / WT-XAML) — caller surfaces
   * executor_failed and the LLM's `if_unexpected.try_next` from PR #329 points
   * at `keyboard({action:'type', text, method:'foreground'})` as the next rung
   * (FG SendInput bypasses BG injection restrictions).
   *
   * Success returns the `"keyboard"` ExecutorKind. Note that `"keyboard"` is an
   * internal-fallback-only executor — it is NOT advertised in
   * `UiAffordance.executors` / `UiEntity.unsupportedExecutors` (both remain the
   * 4-executor union). See `types.ts::ExecutorKind` JSDoc for the
   * advertised-surface rationale.
   */
  keyboardTypeBg(windowTitle: string, text: string): Promise<void>;
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
): (entity: UiEntity, action: TouchAction, text?: string) => Promise<ExecutorKind | ExecutorOutcome> {
  const d = deps ?? getSharedRealDeps();

  return async (entity, action, text) => {
    const winTitle = resolveWindowTitle(target);

    // Issue #296 Phase 2 — `desktop_discover` derives `unsupportedExecutors`
    // from UIA `controlType` + `patterns` (e.g. `ListItem`/`TabItem` without
    // `InvokePattern`, `TogglePattern`-only checkboxes, visual-only entities)
    // and stashes the array on `UiEntity` so we can skip a route that the
    // capability derivation already predicted would fail.
    //
    // `mouse` is honoured here too (Opus PR #302 P2 #1) — the type union allows
    // it, so the executor must respect it rather than silently routing through
    // the unconditional mouse fallback. In practice today nothing emits
    // `'mouse'` in `unsupportedExecutors`, but treating the field as authoritative
    // future-proofs against capability rules that flag e.g. unreliable rects.
    const blocked = entity.unsupportedExecutors ?? [];
    const uiaBlocked      = blocked.includes("uia");
    const cdpBlocked      = blocked.includes("cdp");
    const terminalBlocked = blocked.includes("terminal");
    const mouseBlocked    = blocked.includes("mouse");

    // ADR-020 SR-1 PR-SR1-2 (北極星 9, Round 7 confirmed): preferredExecutors の
    // 責務は **各 executor block の entry eligibility** に限定する。registry が
    // bake した `entity.preferredExecutors` に含まれない executor の block は
    // skip し、block 内部の fallback / error message / return shape は baseline
    // と bit-equal 維持 (北極星 9 (2)/(4)/(5))。
    //
    // 設計境界 (sub-plan §5.2 + §5.5):
    //   - `entity.preferredExecutors === undefined` → 全 executor で true を返す
    //     (baseline と完全同一動作、北極星 9 (1))。
    //   - generic outer loop / 失敗集約 / 任意 [from → to] downgrade marker は
    //     導入しない (現 executor の fallback は単純 routing ladder ではなく
    //     recovery fallback + 公開 contract を含むため; sub-plan §5.2 末尾参照)。
    //   - 内部 keyboard fallback (UIA setValue → keyboardTypeBg) は引き続き
    //     bare `"keyboard"` return (PR #330 contract、OQ-SR5-1 で SR-5 再判断)。
    const preferredAllows = (executor: AdvertisedExecutorKind): boolean =>
      entity.preferredExecutors === undefined || entity.preferredExecutors.includes(executor);

    // ── UIA route ────────────────────────────────────────────────────────────
    if (entity.sources.includes("uia") && !uiaBlocked && preferredAllows("uia")) {
      // Prefer typed locator; fall back to sourceId (legacy bridge — remove in P3).
      const automationId = entity.locator?.uia?.automationId ?? entity.sourceId;
      const name         = entity.locator?.uia?.name ?? entity.label;
      // Phase 4: 'setValue' absorbs former set_element_value tool — same UIA
      // ValuePattern path as 'type'. Both actions land here for any UIA entity.
      //
      // Issue #327 item E: when `uiaSetValue` throws (most commonly because the
      // PowerShell `name -like '*…*'` locator filter in `makeSetElementValueScript`
      // cannot re-find the entity — Notepad's RichEditD2DPT with empty/unstable name
      // is the canonical dogfood case), fall back to background WM_CHAR injection
      // via `keyboardTypeBg`. The fallback uses the same primitive as `terminalSend`
      // and respects `canInjectAtTarget` so Chromium / UWP / WT-XAML hosts still
      // surface executor_failed cleanly. On combined failure we surface a joint
      // error message so the LLM sees both rungs' diagnostics in one envelope.
      if ((action === "type" || action === "setValue") && text !== undefined) {
        try {
          await d.uiaSetValue(winTitle, text, name, automationId);
          return "uia";
        } catch (uiaErr) {
          try {
            await d.keyboardTypeBg(winTitle, text);
            return "keyboard";
          } catch (kbErr) {
            throw new Error(
              `Type fallback ladder exhausted for "${entity.label ?? entity.entityId}": ` +
              `uia=${uiaErr instanceof Error ? uiaErr.message : String(uiaErr)} / ` +
              `keyboard=${kbErr instanceof Error ? kbErr.message : String(kbErr)}`,
              { cause: kbErr },
            );
          }
        }
      }
      try {
        await d.uiaClick(winTitle, name, automationId);
        return "uia";
      } catch (uiaErr) {
        // UIA click failed (element not found, stale tree, etc.).
        // Prefer entity.rect (freshest, from most-recent candidate) over locator.visual.rect
        // which may be stale (captured at recognition time, before the element moved).
        const rect = entity.rect ?? entity.locator?.visual?.rect;
        if (!rect) throw new Error(
          `UIA click failed for "${entity.label ?? entity.entityId}" and no rect for mouse fallback`,
          { cause: uiaErr },
        );
        const { x, y } = rectCenter(rect);
        await d.mouseClick(x, y);
        // Issue #327 item C: signal the silent downgrade so the LLM sees
        // `executor: "mouse"` AND `downgrade: { from: "uia", reason: ... }`
        // — without the marker the dogfood envelope cannot distinguish
        // "UIA was tried and failed" from "UIA was not the chosen route".
        const reason = uiaErr instanceof Error ? uiaErr.message : String(uiaErr);
        return { kind: "mouse", downgrade: { from: "uia", reason } };
      }
    }

    // ── CDP route ────────────────────────────────────────────────────────────
    // Prefer locator.cdp.selector; fall back to sourceId (legacy bridge).
    const cdpSelector = entity.locator?.cdp?.selector ?? (entity.sources.includes("cdp") ? entity.sourceId : undefined);
    if (cdpSelector && !cdpBlocked && preferredAllows("cdp")) {
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
    // Terminals have no click affordance — terminalSend requires a string.
    // Mirror the UIA/CDP gates: only invoke when the caller actually supplied
    // text (action='type'/'setValue', or action='auto' with text). Otherwise
    // fall through to the mouse fallback so click/invoke on a terminal entity
    // doesn't silently send an empty string.
    if (entity.sources.includes("terminal") && !terminalBlocked && text !== undefined && preferredAllows("terminal")) {
      const termWin = entity.locator?.terminal?.windowTitle ?? winTitle;
      await d.terminalSend(termWin, text);
      return "terminal";
    }

    // ── Mouse fallback ───────────────────────────────────────────────────────
    // Opus PR #302 P2 #2 — when the caller supplied `text` (action='type'/
    // 'setValue', or action='auto' with text) and every text-capable executor
    // (UIA / CDP / terminal) was skipped or blocked, the previous fall-through
    // to a bare `mouseClick(rectCenter)` silently dropped the text payload —
    // the LLM thinks it typed something, but only a focus click was issued.
    // Throw a typed `executor_failed`-shaped error instead so the guarded-touch
    // wrapper surfaces `ok:false reason:'executor_failed'` and the caller can
    // diagnose the dropped payload rather than chasing a phantom-typed bug.
    if (text !== undefined && (action === "type" || action === "setValue")) {
      throw new Error(
        `setValue/type requested for "${entity.label ?? entity.entityId}" but no text-capable executor available ` +
        `(uia${uiaBlocked ? "=blocked" : "=no-source"}, cdp${cdpBlocked ? "=blocked" : "=no-selector"}, terminal${terminalBlocked ? "=blocked" : "=no-source-or-text"}) — mouse fallback would drop the text payload`
      );
    }
    if (mouseBlocked) {
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": mouse fallback also blocked by unsupportedExecutors`
      );
    }
    // ADR-020 SR-1 PR-SR1-2 (北極星 9 + R-SR1-2-e): preferredExecutors が
    // mouse を含まない場合の throw を mouseBlocked と同経路で扱う。text drop
    // 防止 throw を先に評価する順序は維持しているため、text 付き action は
    // mouseBlocked と同等に上の text-drop branch で扱われる。
    if (!preferredAllows("mouse")) {
      // Round 8 P3-2 反映: mouseBlocked 経路の error message と統一して LLM 観測時の
      // log 差分を減らす。R-SR1-2-e (sub-plan §5.5) で「mouseBlocked と同経路で扱う」
      // と明記済の throw、文言も bit-equal にする。
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": mouse fallback also blocked by unsupportedExecutors`
      );
    }
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
  if(!el) return { ok:false, error:"Element not found: " + ${JSON.stringify(selector)} };
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

    async keyboardTypeBg(windowTitle, text) {
      // Issue #327 item E: UIA setValue fallback. Uses the same WM_CHAR primitive
      // as terminalSend but resolves to the focused child via `canInjectAtTarget`
      // so the BG class check classifies the actual key-receiving HWND (Notepad's
      // RichEditD2DPT child rather than the "Notepad" top-level). Chromium / WT-XAML
      // hosts surface "Background keyboard type not supported" so the joint error
      // message above (`Type fallback ladder exhausted: ...`) carries the diagnostic.
      //
      // Opus Round 1 P2-2 note (PR #330): the LLM-visible BG path at
      // `keyboard.ts:973` gates on `canInjectViaPostMessage(top-level hwnd)` and
      // delegates to `postCharsToHwnd` which internally resolves the child via
      // `resolveTarget`. The asymmetry is deliberate here — the child-class check
      // is the right semantic for "send keys to the active edit control" and the
      // Notepad RichEditD2DPT case is exactly where the parent-class check is too
      // coarse. The path-class refactor epic should reconcile both BG paths under
      // a single semantic (tracked in memory `project_path_class_refactor_pending`).
      const { enumWindowsInZOrder } = await import("../engine/win32.js");
      const { canInjectAtTarget, postCharsToHwnd } = await import("../engine/bg-input.js");
      const wins = enumWindowsInZOrder();
      const win = wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
      if (!win) {
        throw new Error(`Window not found for keyboardTypeBg: "${windowTitle}"`);
      }
      const check = canInjectAtTarget(win.hwnd);
      if (!check.supported) {
        throw new Error(
          `Background keyboard type not supported for "${windowTitle}" ` +
          `(${check.reason ?? "unknown"}, class: ${check.className ?? "?"}).`,
        );
      }
      const r = postCharsToHwnd(win.hwnd, text);
      if (!r.full) {
        throw new Error(
          `Background keyboard type incomplete: sent ${r.sent}/${text.length} chars to "${windowTitle}"`,
        );
      }
    },

    async mouseClick(x, y) {
      const { mouse, Button, Point, straightTo } = await import("../engine/nutjs.js");
      await mouse.move(straightTo(new Point(x, y)));
      await mouse.click(Button.LEFT);
    },
  };
  return _realDepsCache;
}
