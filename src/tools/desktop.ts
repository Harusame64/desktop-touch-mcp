import { randomUUID } from "node:crypto";
import type { UiEntityCandidate } from "../engine/vision-gpu/types.js";
import type { UiEntity, EntityLease } from "../engine/world-graph/types.js";
import { resolveCandidates } from "../engine/world-graph/resolver.js";
import {
  SessionRegistry,
  type TargetSpec,
  type SnapshotFn,
  type ExecutorFn,
} from "../engine/world-graph/session-registry.js";
import { createDesktopExecutor, type ExecutorDeps } from "./desktop-executor.js";
import type { TouchAction, TouchResult } from "../engine/world-graph/guarded-touch.js";

// ── Input / Output types ──────────────────────────────────────────────────────

export interface DesktopSeeInput {
  target?: TargetSpec;
  view?: "action" | "explore" | "debug";
  query?: string;
  maxEntities?: number;
  debug?: boolean;
}

/** Entity as returned to the LLM. Raw coordinates absent unless debug=true. */
export interface EntityView {
  entityId: string;
  label?: string;
  role: string;
  confidence: number;
  sources: string[];
  primaryAction: string;
  lease: EntityLease;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface DesktopSeeOutput {
  viewId: string;
  target: { title: string; generation: string };
  entities: EntityView[];
  /** Non-fatal warnings (e.g. provider unavailable, partial results). */
  warnings?: string[];
}

export interface DesktopTouchInput {
  lease: EntityLease;
  action?: TouchAction;
  text?: string;
}

export type DesktopTouchOutput = TouchResult;

// ── CandidateProvider ─────────────────────────────────────────────────────────

/**
 * Returns UiEntityCandidates for a given see request.
 * May be sync or async — facade.see() awaits via Promise.resolve().
 *
 * Production implementations:
 *   - game target    → CandidateProducer (visual_gpu lane)
 *   - browser target → CDP AX + OCR fallback
 *   - terminal       → terminal buffer + OCR fallback
 *   - native UI      → UIA (async getUiElements)
 *
 * All sources converge to UiEntityCandidate before entering the facade.
 */
export type CandidateProvider = (input: DesktopSeeInput) => UiEntityCandidate[] | Promise<UiEntityCandidate[]>;

export type { ExecutorFn };

// ── Facade options ────────────────────────────────────────────────────────────

export interface DesktopFacadeOptions {
  /**
   * Fixed executor — overrides executorDeps.
   * Use in tests to provide a fully-controlled mock.
   */
  executorFn?: ExecutorFn;
  /**
   * Injectable backends for createDesktopExecutor.
   * When set, each session gets a target-aware executor via createDesktopExecutor(target, deps).
   * When omitted, production native bindings are used (UIA/CDP/nutjs).
   */
  executorDeps?: ExecutorDeps;
  /** Override modal detection. Default: always false. */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /** Override viewport check. Default: always true. */
  isInViewport?: (entity: UiEntity) => boolean;
  /** Default lease TTL in ms (default: 5000). */
  defaultTtlMs?: number;
  /** Injectable clock for testing. */
  nowFn?: () => number;
  /** Override post-touch candidate source (default: re-calls candidateProvider). */
  postTouchCandidates?: (input: DesktopSeeInput) => UiEntityCandidate[];
  /** Session eviction TTL in ms (default: 120 000 = 2 min). */
  sessionTtlMs?: number;
}

export type { ExecutorDeps };

// ── Helpers ───────────────────────────────────────────────────────────────────

function primaryActionFrom(entity: UiEntity): string {
  return entity.affordances[0]?.verb ?? "read";
}

function targetTitle(target?: TargetSpec): string {
  if (!target) return "(current)";
  return target.windowTitle ?? target.hwnd ?? target.tabId ?? "(current)";
}

// ── DesktopFacade ─────────────────────────────────────────────────────────────

/**
 * DesktopFacade — `desktop_see` / `desktop_touch` surface for Anti-Fukuwarai v2.
 *
 * Session isolation: each unique target (hwnd / tabId / windowTitle) gets its own
 * generation counter and LeaseStore. Leases from window A are never invalidated by
 * a `see()` call targeting window B.
 *
 * Raw coordinates are excluded from LLM responses unless `debug: true`.
 */
export class DesktopFacade {
  private readonly registry: SessionRegistry;
  private readonly candidateProvider: CandidateProvider;
  private readonly opts: DesktopFacadeOptions;

  constructor(candidateProvider: CandidateProvider, opts: DesktopFacadeOptions = {}) {
    this.candidateProvider = candidateProvider;
    this.opts = opts;
    this.registry = new SessionRegistry();
  }

  /**
   * Resolve entities for the given target and view mode.
   * Bumps the target's generation — prior leases for this target become stale.
   * Leases for other targets are unaffected.
   * Async because CandidateProvider may return a Promise (e.g. UIA getUiElements).
   */
  async see(input: DesktopSeeInput = {}): Promise<DesktopSeeOutput> {
    const key = this.registry.resolveKey(input.target);
    const session = this.registry.getOrCreate(key, this._sessionOpts());

    session.lastTarget = input.target;
    const prevViewId = session.viewId;
    const newViewId = randomUUID();
    session.seq++;
    session.generation = `${newViewId}:${session.seq}`;
    session.viewId = newViewId;

    let resolved = resolveCandidates(
      await Promise.resolve(this.candidateProvider(input)),
      session.generation
    );

    if (input.query) {
      const q = input.query.toLowerCase();
      resolved = resolved.filter((e) => e.label?.toLowerCase().includes(q));
    }

    const max = input.maxEntities ?? (input.view === "explore" ? 50 : 20);
    resolved = resolved.slice(0, max);

    session.entities = resolved;
    this.registry.replaceViewId(prevViewId, newViewId, key);

    const entityViews: EntityView[] = resolved.map((e) => {
      const lease = session.leaseStore.issue(e, newViewId);
      const view: EntityView = {
        entityId: e.entityId,
        label: e.label,
        role: e.role,
        confidence: e.confidence,
        sources: [...e.sources],
        primaryAction: primaryActionFrom(e),
        lease,
      };
      if (input.debug) view.rect = e.rect;
      return view;
    });

    return {
      viewId: newViewId,
      target: { title: targetTitle(input.target), generation: session.generation },
      entities: entityViews,
    };
  }

  /**
   * Validate a lease and execute a guarded touch.
   * Routes to the session that issued the lease via its viewId.
   * Returns "entity_not_found" if the issuing session has been evicted.
   */
  async touch(input: DesktopTouchInput): Promise<DesktopTouchOutput> {
    const session = this.registry.getByViewId(input.lease.viewId);
    if (!session) {
      return { ok: false, reason: "entity_not_found", diff: [] };
    }
    return session.loop.touch(input);
  }

  /** Evict sessions that have not been accessed within `sessionTtlMs`. */
  evictStaleSessions(): void {
    this.registry.evictStale(
      this.opts.sessionTtlMs ?? 120_000,
      this.opts.nowFn
    );
  }

  // ── private ─────────────────────────────────────────────────────────────────

  /**
   * Build SessionCreateOpts from facade-level config.
   * Called on every see() but only used on first session creation for a given key.
   * No per-input state is forwarded — post-touch snapshots receive the bare target.
   */
  private _sessionOpts(): import("../engine/world-graph/session-registry.js").SessionCreateOpts {
    const candidateProvider = this.candidateProvider;
    const postTouchCandidates = this.opts.postTouchCandidates;
    return {
      snapshotFn:      (target) => candidateProvider({ target }),
      postSnapshotFn:  postTouchCandidates ? (target) => postTouchCandidates({ target }) : undefined,
      // executorFn takes precedence; executorFactory provides target-aware executor for production.
      executorFn:      this.opts.executorFn,
      executorFactory: this.opts.executorFn
        ? undefined
        : (target) => createDesktopExecutor(target, this.opts.executorDeps),
      isModalBlocking: this.opts.isModalBlocking,
      isInViewport:    this.opts.isInViewport,
      defaultTtlMs:    this.opts.defaultTtlMs,
      nowFn:           this.opts.nowFn,
    };
  }
}
