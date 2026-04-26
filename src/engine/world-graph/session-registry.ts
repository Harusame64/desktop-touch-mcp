import { randomUUID } from "node:crypto";
import type { UiEntityCandidate } from "../vision-gpu/types.js";
import type { UiEntity, ExecutorKind } from "./types.js";
import { LeaseStore } from "./lease-store.js";
import {
  GuardedTouchLoop,
  type TouchAction,
  type TouchEnvironment,
} from "./guarded-touch.js";
import { resolveCandidates } from "./resolver.js";

// ── Target identification ─────────────────────────────────────────────────────

/** Subset of DesktopSeeInput.target; defined here to avoid circular import. */
export type TargetSpec = { windowTitle?: string; hwnd?: string; tabId?: string };

export type TargetSessionKey =
  | `window:${string}`
  | `tab:${string}`
  | `title:${string}`;

// ── Executor type ─────────────────────────────────────────────────────────────

export type ExecutorFn = (
  entity: UiEntity,
  action: TouchAction,
  text?: string
) => Promise<ExecutorKind>;

// ── Session state ─────────────────────────────────────────────────────────────

export interface SessionState {
  readonly key: TargetSessionKey;
  viewId: string;
  seq: number;
  generation: string;
  entities: UiEntity[];
  lastTarget: TargetSpec | undefined;
  readonly leaseStore: LeaseStore;
  readonly loop: GuardedTouchLoop;
  lastAccessMs: number;
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
  executorFactory?: (target: TargetSpec | undefined) => ExecutorFn;
  /**
   * Override modal detection. Default: session-aware check — blocks if any OTHER entity
   * in the current snapshot is a UIA "unknown"-role element (overlay/dialog pattern).
   */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /** Override viewport check. Default: conservative pass (always true). */
  isInViewport?: (entity: UiEntity) => boolean;
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
   * Stale leases (pointing to `oldViewId`) still safely fail with "generation_mismatch"
   * because the session's generation counter has advanced — no index entry needed for that.
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
      leaseStore: new LeaseStore({ defaultTtlMs: opts.defaultTtlMs, nowFn: opts.nowFn }),
      loop: null!,  // assigned immediately below
      lastAccessMs: opts.nowFn?.() ?? Date.now(),
    };

    const env: TouchEnvironment = {
      resolveLiveEntities: () => s.entities,
      currentGeneration:   () => s.generation,
      // G1-A: Session-aware modal guard.
      // Default: block if any OTHER entity in the live snapshot is a UIA "unknown"-role
      // element. UIA exposes system dialogs and overlays as unknown-role elements, so
      // this catches modal blocking without a Win32 round-trip.
      // Override via opts.isModalBlocking for custom/test implementations.
      isModalBlocking: opts.isModalBlocking ?? ((entity: UiEntity) =>
        s.entities.some(
          (e) => e.entityId !== entity.entityId && e.sources.includes("uia") && e.role === "unknown"
        )
      ),
      isInViewport: opts.isInViewport ?? (() => true),
      // G1-C: Focus fingerprint for focus_shifted detection.
      // Only wired when opts.getFocusedEntityId is provided (e.g. production desktop-register.ts).
      // Conservative: if not provided, focus_shifted is never emitted.
      getFocusedEntityId: opts.getFocusedEntityId,
      // Resolve executor lazily so s.lastTarget is current at touch time.
      execute: (entity, action, text) => {
        const execFn = opts.executorFn
          ?? opts.executorFactory?.(s.lastTarget)
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
