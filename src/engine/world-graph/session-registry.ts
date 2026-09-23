import { randomUUID } from "node:crypto";
import type { Aim } from "../aim.js";
import type { UiEntityCandidate } from "../vision-gpu/types.js";
import type { UiEntity, ExecutorKind, ExecutorOutcome } from "./types.js";
import { LeaseStore } from "./lease-store.js";
import {
  GuardedTouchLoop,
  type TouchAction,
  type WindowBlockAnswer,
  type TouchEnvironment,
  type ViewportVerdict,
} from "./guarded-touch.js";
import { resolveCandidates } from "./resolver.js";

// ── Target identification ─────────────────────────────────────────────────────

/** Subset of DesktopSeeInput.target; defined here to avoid circular import. */
export type TargetSpec = { windowTitle?: string; hwnd?: string; tabId?: string };

/**
 * ADR-036 — the one place that decides whether a `TargetSpec` names a window by handle.
 *
 * `hwnd` is a decimal string on the wire, so "what counts as a handle" is a parse, and it was
 * being answered separately at every site that asked: one threw, one returned `null`, one fell
 * back to the foreground window, and one used the string as a window *title*. For a single
 * malformed value the read half and the write half could then aim at different windows.
 *
 * Returns `undefined` for a spec with no handle, for one that does not parse, and for anything
 * that is not a positive number: `BigInt("")` is `0n` and window zero is not a window, and `-1`
 * is `INVALID_HANDLE_VALUE`, which arrives from a stringified sentinel and would otherwise send
 * `keyboardTypeBg` and `terminalSend` down the by-handle branch to fail there instead of using
 * the title that would have worked (2ゲート目の指摘). Hex is accepted deliberately — `"0x1337"`
 * names a real window, and refusing it would turn a call that would have worked into a silent
 * fall back to aiming by title, which is the failure this exists to remove.
 *
 * What each caller does with `undefined` stays that caller's decision; only the answer to "is
 * this a handle" is shared.
 */
export function parseTargetHwnd(target: TargetSpec | undefined): bigint | undefined {
  const raw = target?.hwnd;
  if (raw === undefined || raw === "") return undefined;
  try {
    const h = BigInt(raw);
    return h <= 0n ? undefined : h;
  } catch {
    return undefined;
  }
}

/**
 * The one UIA control type that has been a modal (internal #126, half 2).
 *
 * UIA maps nine control types to a role and reports EVERY other one as `role:"unknown"`
 * (`uia-provider.ts::uiaRoleFromControlType`), so "role unknown and not window chrome" — this
 * predicate until 2026-09-19 — was "any control outside sixteen types" (nine mapped, eight
 * chrome, `MenuItem` in both). win2 read it against the product's own discover (internal `b9319d7`, main `dc73925e`, nothing pressed): it rang on
 * 37 elements across a WinForms widget window, Explorer and Windows Terminal, none of them a
 * modal — `Spinner`, a ToolStrip grip (`Thumb`), `Pane`, `TabItem`, `SplitButton`, `Header`,
 * `DataItem`, `TreeItem` and seven more — and on Chrome's `BrowserRootView` pane. The two real
 * modals in that set, a WinForms `ShowDialog` form and a `#32770` MessageBox, were both
 * controlType `Window`, in the owner's tree.
 *
 * What narrowing loses, measured (internal `89797ae`): a modal drawn INSIDE a window — a WPF
 * overlay, Chrome's `<dialog>` / `aria-modal` / `alertdialog` — does not reach the UIA tree at
 * all, so the old predicate never saw it either; its Chrome hit was the root pane. `IsDialog`
 * was considered and not used: WinForms never sets it, so it drops the `ShowDialog` form.
 *
 * What narrowing does NOT fix, measured (internal `62b4590`): a `Window` in the owner's tree
 * that is not a modal — a modeless owned form, an MDI child, a `TopLevel=false` form embedded in
 * the window — rings before and after. Nothing this predicate reads tells them from the real one
 * (same controlType, same class, `IsDialog` false on all four); only the OS does: the real
 * modal's owner is disabled, and `productionFindBlockingWindow` asks exactly that.
 *
 * NOT measured: WinUI `ContentDialog`, WPF dialog windows, `DialogBox` classes other than
 * `#32770`.
 */
const MODAL_CONTROL_TYPE = "Window";

/**
 * ADR-020 Phase 2 PR-P2-1 — unified modal classifier (issue #327 item D
 * structural fix). Replaces the historical 2-function split (`isModalCandidate`
 * pre-touch UIA-tree path / `isModalLike` post-touch diff path) that drifted
 * silently when the chrome-exclusion clause was added to one side only
 * (#297 closure was incomplete until PR #331). Single source of truth so the
 * two paths cannot diverge again.
 *
 * Core predicate (both contexts): UIA-sourced + controlType `Window` (see
 * `MODAL_CONTROL_TYPE`). An entity without a `controlType` is not a modal: the
 * only UIA producer (`uia-provider.ts`) always sets one, and "no type" read as
 * "modal" is what made a missing fact refuse the act.
 *
 * Context-specific clauses:
 *   - `"pre-touch"` with `options.excludeSelf` set: excludes the focus target
 *     from its own blocking-modal search (a dialog cannot block actions on
 *     its own children, Issue #63).
 *   - `"post-touch-diff"`: no self-exclusion; the post snapshot's `touched`
 *     entity is handled by a separate layer (see `guarded-touch.ts`
 *     `computeDiff`).
 *
 * Cross-signal consistency note (Issue #297): the three modal-detection APIs
 * in this codebase serve different layers and intentionally use different
 * signals:
 *
 *   - `desktop-state.ts::MODAL_RE` — window-title regex; surface-level
 *     "is there a window with 'dialog' / 'confirm' / '警告' in its title".
 *   - `classifyModal` (this function) — UIA-tree based; both pre-touch
 *     `blockingElement` resolution and post-touch `modal_appeared` /
 *     `modal_dismissed` diff detection.
 *   - `evaluateModalAbove` (`sensors-win32.ts`) — Win32-Z-order based
 *     confidence score (owner chain + className `#32770` + target disabled).
 *
 * The three are NOT expected to converge on every state — they answer
 * different questions and target different layers.
 */
export function classifyModal(
  entity: UiEntity,
  context: "pre-touch" | "post-touch-diff",
  options?: { excludeSelf?: UiEntity },
): boolean {
  if (context === "pre-touch" && options?.excludeSelf?.entityId === entity.entityId) return false;
  if (!entity.sources.includes("uia")) return false;
  return entity.controlType === MODAL_CONTROL_TYPE;
}

/**
 * @deprecated ADR-020 Phase 2 PR-P2-1 — call `classifyModal(candidate, "pre-touch", { excludeSelf: target })` directly.
 * Retained as a thin wrapper for backward compatibility (existing tests +
 * external callers). Internal callsites in this file already migrated.
 */
export function isModalCandidate(target: UiEntity, candidate: UiEntity): boolean {
  return classifyModal(candidate, "pre-touch", { excludeSelf: target });
}

export type TargetSessionKey =
  | `window:${string}`
  | `tab:${string}`
  | `title:${string}`;

// ── Executor type ─────────────────────────────────────────────────────────────

/**
 * Issue #327 item C: returning the rich `ExecutorOutcome` shape lets the executor
 * signal a silent fallback (e.g. UIA InvokePattern threw, mouse rect-center
 * succeeded). Bare `ExecutorKind` return remains the back-compat shape for
 * executors that never downgrade.
 */
export type ExecutorFn = (
  entity: UiEntity,
  action: TouchAction,
  text?: string
) => Promise<ExecutorKind | ExecutorOutcome>;

// ── Session state ─────────────────────────────────────────────────────────────

export interface SessionState {
  readonly key: TargetSessionKey;
  viewId: string;
  seq: number;
  generation: string;
  entities: UiEntity[];
  /**
   * Internal #163 — whether the last discover's candidates included any `visual_gpu` one, counted
   * BEFORE the resolver superseded stale copies. `desktop_act` chooses its post-action road from this
   * (the S5b fold is skipped when the discover saw the visual lane), and that choice was made on the
   * copies before #163 removed them from `entities`. Measured on real hardware (win2, arm H3): reading
   * `entities` instead moved blind windows onto the fold, which does not report a label that vanished.
   * The user kept the road unchanged; the fold's silence is its own issue.
   */
  discoverSawVisualGpu?: boolean;
  lastTarget: TargetSpec | undefined;
  /**
   * ADR-036 item 2 — the aim, as one value: the window the last read was made against, with who
   * owned it at that moment.
   *
   * `lastTarget` stays beside it because several readers still want the caller-shaped spec (the
   * OCR fold's key, the Stage 5 resolver). What they must not do is answer "which window" from it
   * separately — that is how the two halves came to disagree in the first place.
   */
  lastAim: Aim | undefined;
  readonly leaseStore: LeaseStore;
  readonly loop: GuardedTouchLoop;
  lastAccessMs: number;
  /**
   * ADR-024 Seed-2 — was the most recent `desktop_discover` on this session a
   * visual-only target (UIA-blind: PWA/Electron/canvas/RDP)? Written by
   * `DesktopFacade.see()` from the discover `warnings` (UIA_BLIND_WARNINGS), read
   * by the `desktop_act` wrapper to gate post-action `roiCapture`. Undefined until
   * the first discover; treated as `false` (no capture) when absent.
   */
  lastDiscoverVisualOnly?: boolean;
}

// ── Session creation options ──────────────────────────────────────────────────

export type SnapshotFn = (target?: TargetSpec) => UiEntityCandidate[] | Promise<UiEntityCandidate[]>;

export interface SessionCreateOpts {
  /** Called to fetch candidates for post-touch diff. Falls back to snapshotFn. */
  snapshotFn: SnapshotFn;
  postSnapshotFn?: SnapshotFn;
  /**
   * Fixed executor — takes precedence over executorFactory.
   * Use for testing or when the executor does not depend on session target.
   */
  executorFn?: ExecutorFn;
  /**
   * Target-aware executor factory — called at touch time with the current session.lastTarget.
   * Use this (via createDesktopExecutor) so the executor sees the up-to-date target spec.
   * Ignored when executorFn is set.
   */
  executorFactory?: (aim: Aim | TargetSpec | undefined) => ExecutorFn;
  /**
   * Override modal detection. Default: session-aware check — blocks if any OTHER entity
   * in the current snapshot is a UIA `Window` (an owned dialog; `classifyModal`). Consulted only
   * when `findBlockingWindow` is absent or did not answer `takes_input`.
   *
   * Issue #63: predicate ↔ blockingElement consistency.
   *   When overridden alone (without `findBlockingModal`), the default snapshot finder
   *   is suppressed and `findBlockingModal` returns null — `blockingElement` is omitted from
   *   the response. This prevents the LLM from being told to dismiss an entity unrelated to
   *   the custom predicate. To surface `blockingElement` with a custom predicate, also
   *   override `findBlockingModal`.
   */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /**
   * Override blocking-modal identity lookup. The returned entity's identity is surfaced as
   * `blockingElement` on the modal_blocking response — with the blocker's own window handle when it
   * recorded one, so the caller can reach it by `desktop_discover target.hwnd` (internal #126). Issue #63.
   *
   * When overridden alone (without `isModalBlocking`), the predicate is derived as
   * `findBlockingModal(entity) !== null` so the two stay consistent.
   */
  findBlockingModal?: (entity: UiEntity) => UiEntity | null;
  /**
   * Override the viewport check (ADR-029 Phase 1). Return `null` to let the
   * touch proceed, or a block reason. Default: conservative pass (`null`).
   */
  checkViewport?: (entity: UiEntity) => ViewportVerdict;
  /**
   * internal #126 — ask the OS whether the entity's window is disabled by a dialog it owns.
   * Absent means not asked (tests, non-Windows); production wires `productionFindBlockingWindow`.
   */
  findBlockingWindow?: (entity: UiEntity, aim: Aim | undefined) => WindowBlockAnswer;
  /**
   * Return a focus fingerprint for the currently focused element (or undefined if unknown).
   * Used for focus_shifted detection: pre- vs post-touch fingerprint is compared.
   * Conservative: when not provided, focus_shifted is never emitted.
   */
  getFocusedEntityId?: () => string | undefined;
  defaultTtlMs?: number;
  nowFn?: () => number;
}

// ── SessionRegistry ───────────────────────────────────────────────────────────

/**
 * Manages per-target session state for DesktopFacade.
 *
 * Each unique target (hwnd / tabId / windowTitle) gets its own:
 *   - generation counter
 *   - LeaseStore  (leases from one target never bleed into another)
 *   - GuardedTouchLoop with an environment closure over that session's state
 *
 * Dispatch by viewId: `getByViewId(lease.viewId)` finds the session that issued
 * a given lease, enabling `touch()` to route to the correct session even when
 * multiple targets are active concurrently.
 */
export class SessionRegistry {
  private readonly sessions = new Map<TargetSessionKey, SessionState>();
  /** viewId → key index so touch() can find the issuing session. */
  private readonly viewIdIndex = new Map<string, TargetSessionKey>();

  /**
   * Derive a stable session key from a target spec.
   *
   * Priority: hwnd > tabId > windowTitle > default.
   * NOTE: `title:` keys are unstable — window titles can change (e.g. document rename,
   * tab title update). Prefer `hwnd` or `tabId` when available to avoid orphaned sessions.
   */
  resolveKey(target?: TargetSpec): TargetSessionKey {
    if (target?.hwnd)        return `window:${target.hwnd}`;
    if (target?.tabId)       return `tab:${target.tabId}`;
    if (target?.windowTitle) return `title:${target.windowTitle}`;
    return "window:__default__";
  }

  /**
   * Return an existing session or create a new one.
   * `opts` is applied only on first creation — subsequent calls ignore opts
   * and return the cached session. Use `evictStale()` to force recreation.
   */
  getOrCreate(key: TargetSessionKey, opts: SessionCreateOpts): SessionState {
    let s = this.sessions.get(key);
    if (!s) {
      s = this._create(key, opts);
      this.sessions.set(key, s);
    }
    s.lastAccessMs = opts.nowFn?.() ?? Date.now();
    return s;
  }

  /**
   * Find the session that issued a lease by its viewId. Returns undefined if evicted.
   *
   * Refreshes `lastAccessMs` so an in-flight workflow (see → think → touch)
   * keeps the session alive past `sessionTtlMs` even if the LLM stretches
   * past the eviction interval. Without this, the eviction timer (Codex
   * PR #55 P2) could delete a session mid-workflow when the LLM's reasoning
   * crosses the 120s default idle window between see() and touch().
   */
  getByViewId(viewId: string, nowFn: () => number = Date.now): SessionState | undefined {
    const key = this.viewIdIndex.get(viewId);
    if (!key) return undefined;
    const session = this.sessions.get(key);
    if (session) session.lastAccessMs = nowFn();
    return session;
  }

  /**
   * Replace the previous viewId mapping for a key with a new one.
   * The old viewId is removed from the index to prevent unbounded growth during
   * frequent `see()` calls on the same target.
   *
   * Stale leases (pointing to `oldViewId`) still safely fail — but as **`entity_not_found`**, not
   * as `generation_mismatch`: the old id is DELETED from the index here, so `getByViewId` answers
   * undefined and `validateLeaseOnly` returns before `LeaseStore.validate` ever sees the
   * generation. The older wording said `generation_mismatch`, and internal#125's advice text
   * inherited that claim before the Opus review caught it (2026-09-18). `generation_mismatch` is
   * reachable, but by other routes — a concurrent act inside an in-flight `see()`, or a caller
   * passing a `targetGeneration` that did not come from a lease.
   */
  replaceViewId(oldViewId: string | undefined, newViewId: string, key: TargetSessionKey): void {
    if (oldViewId) this.viewIdIndex.delete(oldViewId);
    this.viewIdIndex.set(newViewId, key);
  }

  /**
   * Evict sessions that have not been accessed within `ttlMs`.
   * Also removes their viewId index entries.
   */
  evictStale(ttlMs: number, nowFn: () => number = Date.now): void {
    const threshold = nowFn() - ttlMs;
    for (const [key, s] of this.sessions) {
      if (s.lastAccessMs < threshold) {
        this.sessions.delete(key);
        for (const [vid, k] of this.viewIdIndex) {
          if (k === key) this.viewIdIndex.delete(vid);
        }
      }
    }
  }

  private _create(key: TargetSessionKey, opts: SessionCreateOpts): SessionState {
    const s: SessionState = {
      key,
      viewId: randomUUID(),
      seq: 0,
      generation: "",
      entities: [],
      lastTarget: undefined,
      lastAim: undefined,
      leaseStore: new LeaseStore({ defaultTtlMs: opts.defaultTtlMs, nowFn: opts.nowFn }),
      loop: null!,  // assigned immediately below
      lastAccessMs: opts.nowFn?.() ?? Date.now(),
      lastDiscoverVisualOnly: undefined,
    };

    const env: TouchEnvironment = {
      resolveLiveEntities: () => s.entities,
      currentGeneration:   () => s.generation,
      // G1-A: Session-aware modal guard — consulted only when the OS's answer (`findBlockingWindow`)
      // did not settle it (guarded-touch.ts).
      // Default: block if any OTHER entity in the live snapshot is a UIA `Window` — an owned
      // dialog appears in its owner's tree as one (`classifyModal`, internal #126). Overlays drawn
      // inside a window do not reach the UIA tree at all (internal `89797ae`).
      //
      // Issue #63 (Codex P1): when the user overrides exactly one of the pair, we derive
      // the other to keep predicate ↔ blockingElement consistent — never surface a default
      // snapshot blocker alongside an unrelated custom predicate.
      //   both default      → shared classifyModal predicate (consistent, ADR-020 PR-P2-1)
      //   both overridden   → caller's responsibility (no derivation)
      //   only isModalBlocking overridden → findBlockingModal returns null (blockingElement omitted,
      //                                     so the LLM is never told to dismiss the wrong element)
      //   only findBlockingModal overridden → isModalBlocking derived as `finder(e) !== null`
      isModalBlocking:
        opts.isModalBlocking ??
        (opts.findBlockingModal
          ? (entity: UiEntity) => opts.findBlockingModal!(entity) !== null
          : (entity: UiEntity) => s.entities.some((e) => classifyModal(e, "pre-touch", { excludeSelf: entity }))),
      findBlockingModal:
        opts.findBlockingModal ??
        (opts.isModalBlocking
          ? () => null
          : (entity: UiEntity) => s.entities.find((e) => classifyModal(e, "pre-touch", { excludeSelf: entity })) ?? null),
      checkViewport: opts.checkViewport ?? (() => null),
      // The aim is read at touch time, like the executor's: an entity whose lane recorded no handle
      // is asked about the window this act is aimed at (win2: on an addon older than #619 the UIA
      // lane records none, and the check asked nothing).
      ...(opts.findBlockingWindow
        ? { findBlockingWindow: (entity: UiEntity) => opts.findBlockingWindow!(entity, s.lastAim) }
        : {}),
      // G1-C: Focus fingerprint for focus_shifted detection.
      // Only wired when opts.getFocusedEntityId is provided (e.g. production desktop-register.ts).
      // Conservative: if not provided, focus_shifted is never emitted.
      getFocusedEntityId: opts.getFocusedEntityId,
      // Resolve executor lazily so s.lastTarget is current at touch time.
      execute: (entity, action, text) => {
        const execFn = opts.executorFn
          // ADR-036 — the aim first: it carries the identity the executor compares against. The
          // spec falls back for sessions created before a read resolved anything.
          ?? opts.executorFactory?.(s.lastAim ?? s.lastTarget)
          ?? (async () => "mouse" as ExecutorKind);
        return execFn(entity, action, text);
      },
      resolvePostTouchEntities: async () => {
        const fn = opts.postSnapshotFn ?? opts.snapshotFn;
        const post = await Promise.resolve(fn(s.lastTarget));
        return resolveCandidates(post, s.generation);
      },
    };

    // Safe cast: `loop` is non-null before `s` leaves this function.
    (s as { loop: GuardedTouchLoop }).loop = new GuardedTouchLoop(s.leaseStore, env);
    return s;
  }
}
