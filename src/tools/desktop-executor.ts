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
 * Real deps are imported lazily (dynamic import) to keep module load light —
 * with one static exception: `_resolve-log.js` (ADR-035 Phase 1 observation),
 * which has to be reachable from the closures below and pulls in no native
 * binding of its own.
 *
 * G2: terminal route now uses background WM_CHAR path via bg-input.ts.
 *     On unsupported windows (Chromium, UWP) it throws explicitly so the caller
 *     gets ok:false reason:"executor_failed" and can fall back to V1 terminal({action:'send'}).
 */

import type { UiEntity, ExecutorKind, ExecutorOutcome } from "../engine/world-graph/types.js";
import { logResolve, logDispatchSink } from "./_resolve-log.js";
import type { TouchAction } from "../engine/world-graph/guarded-touch.js";
import { assertCoordinateReachable } from "../engine/reachable-bounds.js";
import { WindowExcludedError } from "../engine/tool-exclusion.js";
import {
  AimedWindowGoneError,
  AimedPointOutsideWindowError,
  AimedRouteFailedError,
  AIM_WINDOW_GONE,
} from "../engine/aim.js";
import { parseTargetHwnd, type TargetSpec } from "../engine/world-graph/session-registry.js";
import type { AdvertisedExecutorKind } from "../capabilities/registry.js";

// ── Injectable backend interface ──────────────────────────────────────────────

export interface ExecutorDeps {
  /**
   * UIA Invoke: click/invoke by label (name) or automationId.
   *
   * ADR-036 — `hwnd` names the window the caller actually resolved. When it is present the
   * backend addresses that handle and does not look a window up by title, so a second window
   * answering to the same title cannot take the action. Trailing and optional so a backend
   * (or a test double) that ignores it still satisfies the interface.
   */
  uiaClick(windowTitle: string, name?: string, automationId?: string, hwnd?: bigint): Promise<void>;
  /** UIA ValuePattern: type text into a textbox. `hwnd` as in {@link ExecutorDeps.uiaClick}. */
  uiaSetValue(windowTitle: string, value: string, name?: string, automationId?: string, hwnd?: bigint): Promise<void>;
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
  terminalSend(windowTitle: string, text: string, hwnd?: bigint): Promise<void>;
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
  keyboardTypeBg(windowTitle: string, text: string, hwnd?: bigint): Promise<void>;
  /** Mouse: click at absolute screen coordinates. */
  mouseClick(x: number, y: number): Promise<void>;
  /**
   * ADR-036 — where the aimed window is NOW, so a coordinate press can be checked against it.
   *
   * `null` means "no rectangle came back", which is NOT the same as "the window is gone":
   * `getWindowRectByHwnd` also answers null when the native win32 binding is missing or the call
   * throws, and this repo ships builds without that module. Reading null as gone refused every
   * pinned coordinate press on such a build, with the message "the window you aimed at no longer
   * exists" about a window on screen (2ゲート目の指摘) — the same conflation `isWindowGone` was
   * written to avoid, reintroduced one file over. {@link ExecutorDeps.aimIsGone} is what earns the
   * difference.
   *
   * Optional, and omitting it skips the check rather than blocking the press: a test double that
   * does not care about coordinates should not have to grow one. Production passes
   * `getWindowRectByHwnd`.
   */
  aimRect?(hwnd: bigint): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /**
   * ADR-036 — whether the handle is known NOT to name a window any more.
   *
   * Consulted only when {@link ExecutorDeps.aimRect} returned null, to tell "gone" from "cannot
   * tell". Production passes `isWindowGone`, which answers **false** whenever the binding could
   * not be asked, so only a successful call is evidence. Absent (or false) means the containment
   * check is skipped for this press: it goes out the way it did before this ADR existed, which is
   * a known blind press and strictly better than refusing every press on a build that cannot
   * answer the question.
   *
   * Async so production can reach `win32` through the same dynamic import every other dep uses;
   * a test double may return a plain boolean.
   */
  aimIsGone?(hwnd: bigint): Promise<boolean> | boolean;
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
  // When only a handle is known there is no title to look up, and the handle's digits are not
  // one: `parseTargetHwnd` carries it instead, and the backends that take it skip the title
  // search entirely. `"@active"` is what the title-only backends get told.
  return target?.windowTitle ?? "@active";
}

// ADR-036 — the parse lives in `session-registry.ts`, next to `TargetSpec`, because the read
// half and the write half have to agree on what counts as a handle. See `parseTargetHwnd`.

/**
 * ADR-036 — a coordinate press on a pinned session has to land inside the window it named.
 *
 * The mouse route is not a downgrade: for an entity whose only affordance is visual — an OCR
 * label, a `read`-only control — it is the route, and refusing it outright would take the
 * capability away from exactly the windows UIA cannot see. What it must not be is BLIND. The
 * point comes from a rect remembered at discover time, and a window that has since moved,
 * minimised or closed leaves that point over something else, which then takes the press.
 *
 * Measured on Windows 2026-09-09: pinned `desktop_act` on `read` entities pressed the remembered
 * rect and returned `ok:true` with no `downgrade` — invisible to the caller and to the guard
 * that ends the ladder after a failed UIA attempt, because there was no failed attempt.
 *
 * What this does NOT prove, in the order the holes were found:
 *
 *   - Containment is not position WITHIN the window. Measured on Windows 2026-09-09 (win2):
 *     Notepad moved 280×140 px with the remembered point still inside its rectangle came back
 *     `ok:true`, `executor:"mouse"` — the press went ahead, at a screen point that now sits
 *     280×140 px further into the window than the one the lease described. So this check catches
 *     the move that takes the point OUT of the window (and minimise, which parks the rect at
 *     -32000, and a window that is gone); it does not catch the move that keeps it in.
 *
 *     What that cell does NOT say is whether a different CONTROL took the press: Notepad's text
 *     area is one element, so both answers look the same there. A window with several pressable
 *     things inside the entity's rect is needed to tell them apart, and that measurement is
 *     pending — the honest statement today is about the position, not about the control.
 *
 *     Closing it needs the offset carried from discover time, or the entity re-resolved at act
 *     time; that is a different change with its own costs, recorded as an open question rather
 *     than half-done here.
 *   - That the aimed window is the topmost one at that point. Another window can sit over it and
 *     take the click; occlusion needs a hit test and is not claimed here.
 *
 * This paragraph is written twice as long as it wants to be because its first version claimed the
 * middle case ("catches what was measured — moved, minimised, gone") and the measurement above
 * says otherwise. A comment is a claim, not a check.
 */
async function assertPointIsInsideAim(
  deps: ExecutorDeps,
  aimHwnd: bigint,
  x: number,
  y: number,
  label: string,
): Promise<void> {
  if (!deps.aimRect) return;   // nothing to check with — see the JSDoc on the dep
  const rect = await deps.aimRect(aimHwnd);
  if (!rect) {
    // No rectangle is two different facts. Only a source that can say so reports the window gone;
    // everything else is "cannot tell", and a check that cannot be made is skipped rather than
    // turned into a refusal about a window that may well be on screen (see the deps' JSDoc).
    if (await deps.aimIsGone?.(aimHwnd)) {
      throw new AimedWindowGoneError(aimHwnd, `no rectangle for the window this press was aimed at`);
    }
    return;
  }
  const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  if (!inside) {
    // Typed, not a plain `Error`: the loop reports `executor_failed` for anything it cannot name,
    // and that reason's first suggestion is a coordinate click at the entity's rect — this point.
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": this call named window ${aimHwnd}, and that ` +
      `window is now at (${rect.x}, ${rect.y}) ${rect.width}x${rect.height}. The point comes from a ` +
      `rectangle remembered at discover time; the window has moved, been minimised, or closed since, ` +
      `so whatever is under that point now would take the click. Re-run desktop_discover.`,
      aimHwnd,
    );
  }
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
 * Routing uses the entity's source-specific `locator` fields.
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
    // ADR-036 — resolved once per touch, next to the title it replaces, so a route added later
    // has to walk past it rather than reach for `winTitle` alone.
    const aimHwnd = parseTargetHwnd(target);

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
      const automationId = entity.locator?.uia?.automationId;
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
          await d.uiaSetValue(winTitle, text, name, automationId, aimHwnd);
          return "uia";
        } catch (uiaErr) {
          // R3 tool-exclusion — as in the click path below: refusals are not rungs.
          if (uiaErr instanceof WindowExcludedError) throw uiaErr;
          // A dead aim is NOT short-circuited here, unlike in the click path. That rung addresses
          // the same handle (`keyboardTypeBg` looks the window up by hwnd and throws when the
          // enumeration does not hold it), so it cannot write into a different window — and a
          // window whose UIA provider has gone while the HWND lives is exactly the case WM_CHAR
          // injection was added for. The click path's downgrade is blind by coordinate; this one
          // is not.
          try {
            await d.keyboardTypeBg(winTitle, text, aimHwnd);
            return "keyboard";
          } catch (kbErr) {
            // Both rungs are spent, so the refusal that was let through above is now the whole
            // answer: a window that has gone gets the same typed refusal here as it does on the
            // click path, instead of an `executor_failed` that reads like a UIA hiccup
            // (2ゲート目の指摘). One condition, one answer, whichever action asked.
            if (uiaErr instanceof AimedWindowGoneError) throw uiaErr;
            // ADR-036 — and an aimed WRITE ends the same way an aimed click does. Both rungs
            // addressed the handle and both are spent; reported as `executor_failed` the caller is
            // told to fall back to `click_element` / `mouse_click` at the entity's rect, which is
            // the blind press the click path refuses two branches down. One aim, two actions,
            // opposite advice (2ゲート目の指摘). Unpinned calls keep the generic reason: they never
            // promised which window, so the coordinate road is theirs to take.
            // Wording kept from PR #330 — two suites pin it, and the fact they pin is that the
            // joint diagnostic survives; renaming it would have been churn wearing a fix's clothes.
            const ladder =
              `Type fallback ladder exhausted for "${entity.label ?? entity.entityId}"` +
              `${aimHwnd !== undefined ? ` on window ${aimHwnd}` : ""}: ` +
              `uia=${uiaErr instanceof Error ? uiaErr.message : String(uiaErr)} / ` +
              `keyboard=${kbErr instanceof Error ? kbErr.message : String(kbErr)}`;
            if (aimHwnd !== undefined) {
              throw new AimedRouteFailedError(
                `${ladder}. Not falling back to a coordinate press — this call named its window, ` +
                `and the entity's rect is a screen point that any window can be under. ` +
                `Re-run desktop_discover.`,
                aimHwnd,
                { cause: kbErr },
              );
            }
            throw new Error(ladder, { cause: kbErr });
          }
        }
      }
      try {
        await d.uiaClick(winTitle, name, automationId, aimHwnd);
        return "uia";
      } catch (uiaErr) {
        // R3 tool-exclusion — a refusal is not a failure to route around. Every other throw
        // here means "UIA could not do it, try the mouse"; this one means "you may not touch
        // that window", and the mouse fallback would touch it anyway, by coordinate, at the
        // rect the secure dialog now occupies (2ゲート目の指摘).
        if (uiaErr instanceof WindowExcludedError) throw uiaErr;
        // ADR-036 — nor is a dead aim a rung. The rect below is where the window WAS; a window
        // that has closed since the lease was taken has usually been replaced on screen by
        // whatever was behind it, and the downgrade would click that instead. "Window drift" is
        // one of the five failures the perception graph is built to stop, so this ends the
        // ladder and says so (2ゲート目の指摘).
        if (uiaErr instanceof AimedWindowGoneError) throw uiaErr;
        // ADR-036 — and an aimed click does not finish as a blind one.
        //
        // The downgrade below clicks `entity.rect`'s centre. That is a screen coordinate, and a
        // coordinate is not aimed at anything: whatever occupies the point takes the press. For a
        // call that named its window by handle — the whole subject of this ADR — that is the
        // failure it exists to remove, arriving as the recovery path.
        //
        // Measured on Windows 2026-09-09, and worse than the argument: with the window frame
        // synthesised into the read but not the write, EVERY press of `Close` and `Minimize` on a
        // pinned session came back `ok:true` while `executor` said `mouse` and `downgrade` said
        // `Element not found` — the mouse landed on the rect, one of them at `-32000,-32000`, and
        // only a caller reading `downgrade` could have known. Success was being reported for a
        // press that UIA never made.
        //
        // So the ladder ends here when the aim was a handle. An honest failure lets the caller
        // re-discover; a blind press lets it believe. Unpinned calls keep the downgrade: a title
        // was never a promise about which window, and the rect is all they ever had.
        if (aimHwnd !== undefined) {
          // Typed for the same reason the two refusals above are: an untyped throw arrives as
          // `executor_failed`, and that reason's published first suggestion is "fall back to
          // mouse_click using the entity rect center" — the blind press this branch exists to
          // refuse, handed back as the recovery (PR 側 codex, 2026-09-09).
          throw new AimedRouteFailedError(
            `UIA click failed for "${entity.label ?? entity.entityId}" on window ${aimHwnd}: ` +
            `${uiaErr instanceof Error ? uiaErr.message : String(uiaErr)}. ` +
            `Not falling back to a coordinate click — this call named its window, and the ` +
            `entity's rect is a screen point that any window can be under. Re-run desktop_discover.`,
            aimHwnd,
            { cause: uiaErr },
          );
        }
        // UIA click failed (element not found, stale tree, etc.).
        // Prefer entity.rect (freshest, from most-recent candidate) over locator.visual.rect
        // which may be stale (captured at recognition time, before the element moved).
        const rect = entity.rect ?? entity.locator?.visual?.rect;
        if (!rect) throw new Error(
          `UIA click failed for "${entity.label ?? entity.entityId}" and no rect for mouse fallback`,
          { cause: uiaErr },
        );
        const { x, y } = rectCenter(rect);
        // ADR-029: the UIA route works on any monitor. The mouse downgrade
        // reaches every monitor too since Phase 2a, but the point still has to
        // BE on one — a stale rect that now sits off-screen is refused here
        // rather than clicked somewhere else.
        assertCoordinateReachable(x, y);
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
    const cdpSelector = entity.locator?.cdp?.selector;
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
      // The handle goes with it. This executor is built for one session — `target` is that
      // session's `lastTarget`, and the entities reaching it were read from that session's own
      // discover — so there is no entity here belonging to another window to protect.
      //
      // Two narrower shapes were tried and both were wrong. Comparing the two title strings
      // passes whenever they happen to match, and equal titles do not make one window, which is
      // the premise of this ADR. Asking "did the entity name a terminal window?" fails the
      // other way: the terminal provider always fills that field, so the handle was dropped for
      // every ordinary terminal entity and `terminalSend` went back to the first z-order match
      // (gate 1). The title is still passed for the backend that has no handle to use.
      const termWin = entity.locator?.terminal?.windowTitle ?? winTitle;
      await d.terminalSend(termWin, text, aimHwnd);
      return "terminal";
    }

    // ── Keyboard route (ADR-020 SR-5 PR-SR5-2、北極星 9 (4) + 5 block sequential) ──
    // `preferredExecutors` に `"keyboard"` が含まれ、UIA / CDP / terminal の
    // どれも entry しなかった場合に到達する direct keyboard 経路。`keyboardTypeBg`
    // (UIA route 内 recovery と同 primitive、`bg-input.ts::postCharsToHwnd` 経由
    // WM_CHAR injection) を呼び出し、bare `"keyboard"` return (PR #330 contract 維持、
    // OQ-SR5-1 exit condition (1))。失敗時は throw 直伝播 (CDP/terminal と同 pattern、
    // mouse rescue しない、北極星 9 (3) 整合)。
    //
    // 到達条件 (sub-plan §5.2 末尾):
    //   - `preferredExecutors=["keyboard"]` 単独 set で UIA-排除 + (a) `sources` に
    //     "uia" 含まない or (b) `unsupportedExecutors.includes("uia")` で uiaBlocked、
    //     かつ CDP / terminal eligibility なし
    //   - text 必須 + (action === "type" | "setValue") のみ entry (click は keyboard で意味なし)
    // 典型 ValuePattern entity (`preferredExecutors=["uia","keyboard"]`) は UIA block
    // で entry → UIA setValue → keyboardTypeBg 内部 ladder で bare "keyboard" return
    // (新 block は到達せず、北極星 2 = PR #330 contract bit-equal 維持)。
    // 北極星 9 (1) baseline 完全同一動作維持: entity.preferredExecutors が undefined
    // (registry lookup 不在 = test 直 invoke / legacy path) の case で新 keyboard block
    // を entry させないため、`preferredAllows("keyboard")` (undefined 時 true 返却) では
    // なく、explicit な `entity.preferredExecutors !== undefined && includes("keyboard")`
    // で gate する。これで preferredExecutors を明示 advertise していない baseline 経路
    // (e.g. unsupportedExecutors:["uia"] 単独 + text な test case) で text drop 防止 throw
    // への到達経路が baseline と bit-equal 維持される。
    if (
      entity.preferredExecutors !== undefined &&
      entity.preferredExecutors.includes("keyboard") &&
      !blocked.includes("keyboard") &&
      text !== undefined &&
      (action === "type" || action === "setValue")
    ) {
      await d.keyboardTypeBg(winTitle, text, aimHwnd);
      return "keyboard";
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
      // ADR-020 SR-5 PR-SR5-2: keyboard executor が advertised に昇格したので
      // diagnostic string にも keyboard 経路の skip 理由を含める。
      const keyboardBlocked = blocked.includes("keyboard");
      throw new Error(
        `setValue/type requested for "${entity.label ?? entity.entityId}" but no text-capable executor available ` +
        `(uia${uiaBlocked ? "=blocked" : "=no-source"}, cdp${cdpBlocked ? "=blocked" : "=no-selector"}, terminal${terminalBlocked ? "=blocked" : "=no-source-or-text"}, keyboard${keyboardBlocked ? "=blocked" : "=not-in-preferred"}) — mouse fallback would drop the text payload`
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
    // ADR-029 Phase 1 — see the downgrade path above.
    assertCoordinateReachable(x, y);
    // ADR-036 — and if this call named a window, the point has to still be in it.
    if (aimHwnd !== undefined) {
      await assertPointIsInsideAim(d, aimHwnd, x, y, entity.label ?? entity.entityId);
    }
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
    async uiaClick(windowTitle, name, automationId, hwnd) {
      const { clickElement } = await import("../engine/uia-bridge.js");
      // ADR-036 — the bridge has taken a handle since H3 ("bypass title-based root search",
      // added for Save As and the other common dialogs), and `ui-elements.ts` has passed one
      // for every resolved window since then. What could not reach it was THIS path: the
      // interface above had nowhere to put a handle, so `desktop_act` always asked by title.
      const r = await clickElement(windowTitle, name, automationId, undefined, hwnd !== undefined ? { hwnd } : undefined);
      // ADR-036 — "the window is gone" is not "UIA could not do it": see `aim.ts`.
      if (!r.ok && r.code === AIM_WINDOW_GONE) throw new AimedWindowGoneError(hwnd, r.error);
      if (!r.ok) throw new Error(r.error ?? "UIA click failed");
    },

    async uiaSetValue(windowTitle, value, name, automationId, hwnd) {
      const { setElementValue } = await import("../engine/uia-bridge.js");
      const r = await setElementValue(windowTitle, value, name, automationId, hwnd !== undefined ? { hwnd } : undefined);
      if (!r.ok && r.code === AIM_WINDOW_GONE) throw new AimedWindowGoneError(hwnd, r.error);
      if (!r.ok) throw new Error(r.error ?? "UIA setElementValue failed");
    },

    async cdpClick(selector, tabId) {
      // TODO: support non-default CDP port via TargetSpec.cdpPort (Phase 2)
      const { getElementScreenCoords, DEFAULT_CDP_PORT } = await import("../engine/cdp-bridge.js");
      const coords = await getElementScreenCoords(selector, tabId ?? null, DEFAULT_CDP_PORT);
      if ((coords as { error?: string }).error) {
        throw new Error((coords as { error?: string }).error ?? "CDP getElementScreenCoords failed");
      }
      // ADR-029: coordinates only become known inside this dep, so the
      // reachability check lives here rather than in the executor core.
      assertCoordinateReachable(coords.x, coords.y);
      const { mouse, Button } = await import("../engine/nutjs.js");
      const { moveCursorTo } = await import("../engine/cursor.js");
      await moveCursorTo(coords.x, coords.y);
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

    async terminalSend(windowTitle, text, hwnd) {
      // G2: Background WM_CHAR path — no focus steal.
      // canInjectViaPostMessage() gates supported terminals (Windows Terminal, conhost).
      // Unsupported windows (Chromium, UWP) throw explicitly — caller gets executor_failed
      // and the LLM description directs them to V1 terminal({action:'send'}) as fallback.
      const { enumWindowsInZOrder, isWindowGone: isWindowGoneSync } = await import("../engine/win32.js");
      const { canInjectViaPostMessage, postCharsToHwnd } = await import("../engine/bg-input.js");
      const wins = enumWindowsInZOrder();
      terminalBgExecute(windowTitle, text, {
        // ADR-035 Phase 1 — the same unfiltered, silently-first-match shape the
        // v1 resolvers have, reached through `desktop_act` instead. Instrumented
        // so the observation window covers BOTH public dispatchers; leaving it
        // out would put a hole in the H2 evidence exactly where a v2 caller
        // writes (Opus Round 2 P2).
        findWindow: (title) => {
          // ADR-036 — when the caller resolved a handle, this is no longer a lookup: the
          // enumeration is consulted only to fetch that window's record, and a same-titled
          // sibling cannot be returned instead. `pinnedByHwnd` keeps the ADR-035 evidence
          // able to count the two shapes apart.
          if (hwnd !== undefined) {
            const named = wins.filter((w) => w.hwnd === hwnd);
            logResolve({
              resolver: "desktopActTerminalSend",
              query: title,
              matches: named,
              pinnedByHwnd: true,
              identity: "lookup",
              intent: "write",
            });
            // ADR-036 — a by-handle miss is ordinary (`enumWindowsInZOrder` drops untitled,
            // sub-50 px and excluded windows), and the throw downstream only knows the title,
            // so it named a window that is plainly on screen. Thrown here, AFTER the resolve
            // is logged: an earlier pre-check said the same sentence but left the miss out of
            // the H2 evidence, counting handle successes and not handle failures (2ゲート目).
            if (!named[0]) {
              // ADR-036 — and say WHICH kind of miss it is. A generic Error becomes
              // `executor_failed`, whose published terminal recovery is "use V1
              // terminal(action='send')" — a title-based road that can type into a same-titled
              // sibling or into the replacement window. That advice is right for a window that
              // is merely filtered out of the enumeration (untitled, sub-50 px, excluded) and
              // wrong for one that has been destroyed, so the two stop sharing an answer
              // (PR 側 codex の P1).
              if (isWindowGoneSync(hwnd)) throw new AimedWindowGoneError(hwnd);
              throw new Error(
                `Terminal window not found: hwnd ${hwnd} is not in the enumeration (title was "${title}")`,
              );
            }
            return named[0];
          }
          const matches = wins.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
          logResolve({
            resolver: "desktopActTerminalSend",
            query: title,
            matches,
            identity: "lookup",
            intent: "write",
          });
          return matches[0];
        },
        canBgSend:  (hwnd) => canInjectViaPostMessage(hwnd),
        bgSend:     (hwnd, t) => {
          // `TerminalBgDeps` types the handle as `unknown` (it is a test seam);
          // the concrete value here is the `bigint` from the enumeration above.
          logDispatchSink({
            sink: "wm_char",
            tool: "desktop_act:terminal_send",
            targetHwnd: typeof hwnd === "bigint" ? hwnd : null,
            payloadChars: t.length,
          });
          return postCharsToHwnd(hwnd, t);
        },
      });
    },

    async keyboardTypeBg(windowTitle, text, hwnd) {
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
      // ADR-035 Phase 1 — the `terminalSend` twin above; see its comment.
      // ADR-036 — and its handle branch: a resolved handle names the window outright, so the
      // enumeration is only asked for that window's record.
      const byHandle = hwnd !== undefined;
      const matches = byHandle
        ? wins.filter((w) => w.hwnd === hwnd)
        : wins.filter((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
      const win = matches[0];
      logResolve({
        resolver: "desktopActKeyboardType",
        query: windowTitle,
        matches,
        ...(byHandle && { pinnedByHwnd: true }),
        identity: "lookup",
        intent: "write",
      });
      if (!win) {
        // ADR-036 — say which question was asked. `enumWindowsInZOrder` drops untitled,
        // sub-50 px and excluded windows, so a by-handle miss is ordinary, and reporting the
        // title alone told an operator that a window plainly on screen was "not found".
        throw new Error(
          byHandle
            ? `Window not found for keyboardTypeBg: hwnd ${hwnd} is not in the enumeration (title was "${windowTitle}")`
            : `Window not found for keyboardTypeBg: "${windowTitle}"`,
        );
      }
      const check = canInjectAtTarget(win.hwnd);
      if (!check.supported) {
        throw new Error(
          `Background keyboard type not supported for "${windowTitle}" ` +
          `(${check.reason ?? "unknown"}, class: ${check.className ?? "?"}).`,
        );
      }
      logDispatchSink({ sink: "wm_char", tool: "desktop_act:keyboard_type", targetHwnd: win.hwnd, payloadChars: text.length });
      const r = postCharsToHwnd(win.hwnd, text);
      if (!r.full) {
        throw new Error(
          `Background keyboard type incomplete: sent ${r.sent}/${text.length} chars to "${windowTitle}"`,
        );
      }
    },

    async aimRect(hwnd) {
      const { getWindowRectByHwnd } = await import("../engine/win32.js");
      return getWindowRectByHwnd(hwnd);
    },

    async aimIsGone(hwnd) {
      // `isWindowGone` says false whenever it could not ask, which is the whole point of pairing
      // it with `aimRect`: a null rectangle plus "cannot tell" must not become "the window you
      // aimed at is gone".
      const { isWindowGone } = await import("../engine/win32.js");
      return isWindowGone(hwnd);
    },

    async mouseClick(x, y) {
      // ADR-029 Phase 2a: the shared cursor choke point places the pointer on
      // any monitor (and refuses rather than clamping when it cannot); the
      // click itself needs no coordinates — it hits whatever is under the
      // cursor.
      const { mouse, Button } = await import("../engine/nutjs.js");
      const { moveCursorTo } = await import("../engine/cursor.js");
      await moveCursorTo(x, y);
      await mouse.click(Button.LEFT);
    },
  };
  return _realDepsCache;
}
