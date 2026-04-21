import { randomUUID } from "node:crypto";
import type { UiEntityCandidate } from "../engine/vision-gpu/types.js";
import type { UiEntity, EntityLease, ExecutorKind } from "../engine/world-graph/types.js";
import { resolveCandidates } from "../engine/world-graph/resolver.js";
import { LeaseStore } from "../engine/world-graph/lease-store.js";
import {
  GuardedTouchLoop,
  type TouchAction,
  type TouchResult,
} from "../engine/world-graph/guarded-touch.js";

// ── Input / Output types ──────────────────────────────────────────────────────

export interface DesktopSeeInput {
  target?: { windowTitle?: string; hwnd?: string; tabId?: string };
  view?: "action" | "explore" | "debug";
  query?: string;
  maxEntities?: number;
  debug?: boolean;
}

/** Entity as returned to the LLM. Raw coordinates are absent unless debug=true. */
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
 *
 * Production implementations:
 *   - game target    → CandidateProducer (visual_gpu lane)
 *   - browser target → CDP AX + OCR fallback
 *   - terminal       → terminal buffer + OCR fallback
 *   - native UI      → UIA
 *
 * All sources converge to the same UiEntityCandidate shape before entering the facade.
 */
export type CandidateProvider = (input: DesktopSeeInput) => UiEntityCandidate[];

// ── Executor ──────────────────────────────────────────────────────────────────

export type ExecutorFn = (
  entity: UiEntity,
  action: TouchAction,
  text?: string
) => Promise<ExecutorKind>;

// ── Generation ticking ────────────────────────────────────────────────────────

function tickGeneration(viewId: string, seq: number): string {
  return `${viewId}:${seq}`;
}

function primaryActionFrom(entity: UiEntity): string {
  return entity.affordances[0]?.verb ?? "read";
}

function targetTitle(target?: DesktopSeeInput["target"]): string {
  if (!target) return "(current)";
  return target.windowTitle ?? target.hwnd ?? target.tabId ?? "(current)";
}

// ── DesktopFacade ─────────────────────────────────────────────────────────────

export interface DesktopFacadeOptions {
  /** Executor function wired to Win32/UIA/CDP/mouse. PoC default: simulated "mouse". */
  executorFn?: ExecutorFn;
  /** Override modal detection. PoC default: always false. */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /** Override viewport check. PoC default: always true. */
  isInViewport?: (entity: UiEntity) => boolean;
  /** TTL for issued leases in ms (default: 5000). */
  defaultTtlMs?: number;
  /** Injectable clock for testing (default: Date.now). */
  nowFn?: () => number;
  /** Injectable function to fetch post-touch candidates (default: re-calls candidateProvider). */
  postTouchCandidates?: (input: DesktopSeeInput) => UiEntityCandidate[];
}

/**
 * DesktopFacade — the `desktop_see` / `desktop_touch` surface for Anti-Fukuwarai v2.
 *
 * `see()` resolves entities from the current target, issues leases, and returns
 * entity views to the LLM WITHOUT raw coordinates (except in debug mode).
 *
 * `touch()` validates a lease against the current view and executes a guarded click
 * via GuardedTouchLoop, returning a semantic diff.
 *
 * The same facade instance handles game, Chrome, and terminal targets — the
 * CandidateProvider is responsible for source-specific sensing.
 */
export class DesktopFacade {
  private viewId = randomUUID();
  private seq = 0;
  private generation = "";
  private entities: UiEntity[] = [];
  private lastInput: DesktopSeeInput = {};

  private readonly leaseStore: LeaseStore;
  private readonly loop: GuardedTouchLoop;
  private readonly candidateProvider: CandidateProvider;
  private readonly postTouchCandidatesFn: (input: DesktopSeeInput) => UiEntityCandidate[];

  constructor(candidateProvider: CandidateProvider, opts: DesktopFacadeOptions = {}) {
    this.candidateProvider = candidateProvider;
    this.postTouchCandidatesFn =
      opts.postTouchCandidates ?? ((inp) => candidateProvider(inp));

    this.leaseStore = new LeaseStore({
      defaultTtlMs: opts.defaultTtlMs ?? 5_000,
      nowFn: opts.nowFn,
    });

    // Build TouchEnvironment as a closure over facade state so resolveLiveEntities()
    // always reflects the most recent see() snapshot.
    const executorFn: ExecutorFn = opts.executorFn ?? (async () => "mouse");

    this.loop = new GuardedTouchLoop(this.leaseStore, {
      resolveLiveEntities:      () => this.entities,
      currentGeneration:        () => this.generation,
      isModalBlocking:          opts.isModalBlocking ?? (() => false),
      isInViewport:             opts.isInViewport    ?? (() => true),
      execute:                  executorFn,
      resolvePostTouchEntities: async () => {
        const post = this.postTouchCandidatesFn(this.lastInput);
        return resolveCandidates(post, this.generation);
      },
    });
  }

  /**
   * Resolve entities for the given target and view mode.
   * Bumps generation so all leases from the previous see() are immediately stale.
   * Raw coordinates are excluded unless `debug: true`.
   */
  see(input: DesktopSeeInput = {}): DesktopSeeOutput {
    this.lastInput = input;
    const candidates = this.candidateProvider(input);

    this.viewId = randomUUID();
    this.seq++;
    this.generation = tickGeneration(this.viewId, this.seq);

    let resolved = resolveCandidates(candidates, this.generation);

    if (input.query) {
      const q = input.query.toLowerCase();
      resolved = resolved.filter((e) => e.label?.toLowerCase().includes(q));
    }

    const maxEntities = input.maxEntities ?? (input.view === "explore" ? 50 : 20);
    resolved = resolved.slice(0, maxEntities);

    this.entities = resolved;

    const entityViews: EntityView[] = resolved.map((e) => {
      const lease = this.leaseStore.issue(e, this.viewId);
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
      viewId: this.viewId,
      target: { title: targetTitle(input.target), generation: this.generation },
      entities: entityViews,
    };
  }

  /** Validate a lease and execute a guarded touch. Returns semantic diff. */
  async touch(input: DesktopTouchInput): Promise<DesktopTouchOutput> {
    return this.loop.touch(input);
  }
}
