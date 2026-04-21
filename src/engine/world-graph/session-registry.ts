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

export type SnapshotFn = (target?: TargetSpec) => UiEntityCandidate[];

export interface SessionCreateOpts {
  /** Called to fetch candidates for post-touch diff. Falls back to snapshotFn. */
  snapshotFn: SnapshotFn;
  postSnapshotFn?: SnapshotFn;
  executorFn?: ExecutorFn;
  isModalBlocking?: (entity: UiEntity) => boolean;
  isInViewport?: (entity: UiEntity) => boolean;
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

  resolveKey(target?: TargetSpec): TargetSessionKey {
    if (target?.hwnd)        return `window:${target.hwnd}`;
    if (target?.tabId)       return `tab:${target.tabId}`;
    if (target?.windowTitle) return `title:${target.windowTitle}`;
    return "window:__default__";
  }

  /**
   * Return an existing session or create a new one.
   * `opts` is only used on first creation; subsequent calls return the cached session.
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

  /** Find the session that issued a lease by its viewId. Returns undefined if evicted. */
  getByViewId(viewId: string): SessionState | undefined {
    const key = this.viewIdIndex.get(viewId);
    return key ? this.sessions.get(key) : undefined;
  }

  /**
   * Record a viewId → key mapping.
   * Old viewIds are retained so touch() can return "generation_mismatch" (informative)
   * rather than "entity_not_found" (ambiguous) when a stale lease is presented.
   */
  indexViewId(viewId: string, key: TargetSessionKey): void {
    this.viewIdIndex.set(viewId, key);
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

    const execFn: ExecutorFn = opts.executorFn ?? (async () => "mouse");
    const env: TouchEnvironment = {
      resolveLiveEntities:      () => s.entities,
      currentGeneration:        () => s.generation,
      isModalBlocking:          opts.isModalBlocking ?? (() => false),
      isInViewport:             opts.isInViewport    ?? (() => true),
      execute:                  execFn,
      resolvePostTouchEntities: async () => {
        const fn = opts.postSnapshotFn ?? opts.snapshotFn;
        const post = fn(s.lastTarget);
        return resolveCandidates(post, s.generation);
      },
    };

    // Safe cast: `loop` is non-null before `s` leaves this function.
    (s as { loop: GuardedTouchLoop }).loop = new GuardedTouchLoop(s.leaseStore, env);
    return s;
  }
}
