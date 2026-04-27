import { randomUUID } from "node:crypto";
import type { UiEntityCandidate } from "../engine/vision-gpu/types.js";
import type { UiEntity, EntityLease } from "../engine/world-graph/types.js";
import { computeLeaseTtlMs, computeSoftExpiresAtMs } from "../engine/world-graph/lease-ttl-policy.js";
import { resolveCandidates } from "../engine/world-graph/resolver.js";
import {
  SessionRegistry,
  type TargetSpec,
  type ExecutorFn,
} from "../engine/world-graph/session-registry.js";
import type { CandidateIngress } from "../engine/world-graph/candidate-ingress.js";
import { createDesktopExecutor, type ExecutorDeps } from "./desktop-executor.js";
import type { TouchAction, TouchResult } from "../engine/world-graph/guarded-touch.js";
import { deriveViewConstraints, type ViewConstraints, type EntityCapabilities } from "./desktop-constraints.js";

export type { ViewConstraints, EntityCapabilities };

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
  /**
   * Optional negative capability hints for this entity.
   * Advisory — touch may still succeed or fail irrespective of these hints.
   * Phase 1: type present; values populated in future batches.
   */
  capabilities?: EntityCapabilities;
}

/**
 * Phase 4 (Codex PR #41 round 5 P1): a top-level windows enumeration so the
 * legacy `get_windows` workflow — title-collision disambiguation, hwnd-targeted
 * screenshot / mouse / window_dock — has a public replacement after
 * privatization. CHANGELOG / README advertise this as `desktop_discover.windows[]`.
 *
 * Synchronous-only fields by design: virtual-desktop membership (was
 * `isOnCurrentDesktop` on the legacy `get_windows`) requires an async PowerShell
 * call and would force `see()` to return a Promise of windows. That is not
 * worth the cost for the hwnd workflow this field set primarily serves; the
 * legacy `getWindowsHandler` is still exported as an internal helper for
 * callers that need the full async shape.
 */
export interface DesktopWindowMeta {
  /** Z-order ranking; 0 is frontmost. */
  zOrder: number;
  title: string;
  /** String to dodge 64-bit precision loss when round-tripped through JSON. */
  hwnd: string;
  region: { x: number; y: number; width: number; height: number };
  isActive: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  /** Best-effort process name (e.g. "chrome.exe"). May be absent on lookup failure. */
  processName?: string;
}

export interface DesktopSeeOutput {
  viewId: string;
  target: { title: string; generation: string };
  entities: EntityView[];
  /**
   * Phase 4: top-level visible windows (Z-order, title, hwnd, region, isActive,
   * processName). Replaces the legacy `get_windows` tool — the entity list
   * (`entities[]`) is targeted at one window/tab; this list lets callers
   * enumerate every candidate window before drilling in.
   */
  windows: DesktopWindowMeta[];
  /** Non-fatal warnings (e.g. provider unavailable, partial results). */
  warnings?: string[];
  /**
   * Structured view-level constraints derived from warnings[].
   * Absent when no provider signalled a constraint.
   * Use these to decide fallback strategy without parsing warnings[] strings.
   * entityZeroReason explains why entities.length === 0 when set.
   */
  constraints?: ViewConstraints;
  /**
   * Soft-expiry advisory (no-compromise lease A): if the LLM is still
   * deciding past this absolute timestamp, it should refresh via
   * desktop_discover even though the leases are still technically valid.
   * Positioned at 60% of the lease TTL window. The hard `expiresAtMs` on
   * each entity's lease remains the only correctness wall.
   */
  softExpiresAtMs: number;
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
  /**
   * Override modal detection. Default: session-aware check (UIA unknown-role entity in snapshot).
   * Set to () => false to disable.
   */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /**
   * Override viewport check. Default: conservative pass (always true).
   * Production implementation provided by desktop-register.ts (G1-B).
   */
  isInViewport?: (entity: UiEntity) => boolean;
  /**
   * Return a focus fingerprint for the currently focused element, or undefined if unknown.
   * Production: uses win32.enumWindowsInZOrder() for window-level focus detection (G1-C).
   * When not set, focus_shifted is never emitted (conservative default).
   */
  getFocusedEntityId?: () => string | undefined;
  /**
   * Override lease TTL in ms — bypasses view/entityCount policy when set.
   * Use in tests to inject a fixed TTL. Production callers should omit this
   * to let lease-ttl-policy.ts compute a response-size-aware TTL.
   */
  defaultTtlMs?: number;
  /** Injectable clock for testing. */
  nowFn?: () => number;
  /** Override post-touch candidate source (default: re-calls candidateProvider). */
  postTouchCandidates?: (input: DesktopSeeInput) => UiEntityCandidate[];
  /** Session eviction TTL in ms (default: 120 000 = 2 min). */
  sessionTtlMs?: number;
  /**
   * Interval (ms) at which `evictStaleSessions()` is invoked automatically.
   * Set to 0 (default) to disable the timer — tests rely on this so each
   * facade is deterministic. Production wiring (`getDesktopFacade`) opts in
   * by passing a positive value (typically 30 000 ms). The timer is .unref'd
   * so it never holds the process open on its own.
   */
  sessionEvictionIntervalMs?: number;
  /**
   * Event-driven candidate ingress. When set, see() calls ingress.getSnapshot(key)
   * instead of candidateProvider(input) directly — reducing idle refresh cost.
   * candidateProvider is still used as the underlying fetch function via the ingress.
   */
  ingress?: CandidateIngress;
  /**
   * Phase 4 (Codex PR #41 round 5 P1): inject a windows enumerator for the
   * top-level `windows[]` field that replaces the legacy `get_windows` tool.
   * Production uses win32.enumWindowsInZOrder + getWindowProcessId. Tests can
   * inject a fake list to avoid platform Win32 calls. When omitted (or it
   * throws) the field defaults to `[]` so see() never fails on enumeration
   * problems.
   */
  windowsProvider?: () => DesktopWindowMeta[];
}

export type { CandidateIngress };

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
 * DesktopFacade — `desktop_discover` / `desktop_act` surface for Anti-Fukuwarai v2.
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
  private _evictionTimer: ReturnType<typeof setInterval> | undefined;

  constructor(candidateProvider: CandidateProvider, opts: DesktopFacadeOptions = {}) {
    this.candidateProvider = candidateProvider;
    this.opts = opts;
    this.registry = new SessionRegistry();
    const intervalMs = opts.sessionEvictionIntervalMs ?? 0;
    if (intervalMs > 0) {
      this._evictionTimer = setInterval(() => {
        // Never let a transient eviction error escape the timer — it would
        // crash the host process. Worst case is one missed sweep.
        try { this.evictStaleSessions(); } catch { /* swallow */ }
      }, intervalMs);
      // Don't keep the process alive just for this timer.
      if (typeof this._evictionTimer.unref === "function") this._evictionTimer.unref();
    }
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

    // Use ingress (event-driven cache) if available; fall back to direct provider.
    let rawResult = this.opts.ingress
      ? await this.opts.ingress.getSnapshot(key)
      : { candidates: await Promise.resolve(this.candidateProvider(input)), warnings: [] as string[] };

    // H4: view=debug escalation (Rule-B) — surface visual_not_attempted when the
    // visual backend is unready, regardless of whether compose's Rule-A fired.
    // Scope: Rule-B only handles the "visual unready" path (visual_provider_unavailable /
    // visual_provider_warming). Rule-A' (warm-but-empty) and Rule-C (CDP+visual both
    // empty) are compose-side concerns and are NOT repeated here to avoid dual sourcing.
    // When compose has already applied Rule-A the alreadyEscalated guard prevents duplication.
    if (input.view === "debug") {
      const hasVisualUnready = rawResult.warnings.some(
        (w) => w === "visual_provider_unavailable" || w === "visual_provider_warming"
      );
      const alreadyEscalated = rawResult.warnings.includes("visual_not_attempted");
      if (hasVisualUnready && !alreadyEscalated) {
        rawResult = { ...rawResult, warnings: [...rawResult.warnings, "visual_not_attempted"] };
      }
    }
    let resolved = resolveCandidates(rawResult.candidates, session.generation);

    if (input.query) {
      const q = input.query.toLowerCase();
      resolved = resolved.filter((e) => e.label?.toLowerCase().includes(q));
    }

    const max = input.maxEntities ?? (input.view === "explore" ? 50 : 20);
    resolved = resolved.slice(0, max);

    session.entities = resolved;
    this.registry.replaceViewId(prevViewId, newViewId, key);

    // Phase 4 (Codex PR #41 round 5 P1): top-level windows enumeration.
    // Pulled forward (was after lease issue) so the TTL policy can size the
    // payloadBytes estimate against the full response shape.
    // Failure to enumerate is non-fatal — surface an empty list rather than
    // failing the whole call, since see()'s primary contract is entity
    // discovery for the targeted window.
    let windows: DesktopWindowMeta[] = [];
    if (this.opts.windowsProvider) {
      try {
        windows = this.opts.windowsProvider();
      } catch {
        windows = [];
      }
    }

    // H1 + no-compromise A: TTL is response-size aware. Estimate payload
    // bytes from entity / window / warning counts (the shape is stable enough
    // that a coefficient-based estimate is within ~30% of the real serialized
    // size — close enough for a soft TTL knob; we'd otherwise have to
    // serialize twice).
    const estimatedPayloadBytes =
      500 +
      resolved.length * 250 +
      windows.length * 180 +
      rawResult.warnings.length * 80;

    const policyTtl = this.opts.defaultTtlMs !== undefined
      ? this.opts.defaultTtlMs
      : computeLeaseTtlMs({
          view: input.view,
          entityCount: resolved.length,
          payloadBytes: estimatedPayloadBytes,
        });

    const nowFn = this.opts.nowFn ?? Date.now;
    const issuedAtMs = nowFn();

    const entityViews: EntityView[] = resolved.map((e) => {
      const lease = session.leaseStore.issue(e, newViewId, policyTtl);
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

    const output: DesktopSeeOutput = {
      viewId: newViewId,
      target: { title: targetTitle(input.target), generation: session.generation },
      entities: entityViews,
      windows,
      softExpiresAtMs: computeSoftExpiresAtMs(issuedAtMs, policyTtl),
    };
    if (rawResult.warnings.length > 0) output.warnings = rawResult.warnings;

    // H2: derive structured constraints from warnings for LLM fallback decisions.
    const constraints = deriveViewConstraints(rawResult.warnings, entityViews.length);
    if (constraints) output.constraints = constraints;

    // Codex PR #55 P2: refresh lastAccessMs at the END of see() too, in case
    // candidateProvider / ingress took longer than the eviction interval to
    // complete. getOrCreate stamps the start time; without this completion
    // refresh, a multi-minute see() could be evicted mid-call.
    session.lastAccessMs = (this.opts.nowFn ?? Date.now)();

    return output;
  }

  /**
   * Validate a lease and execute a guarded touch.
   * Routes to the session that issued the lease via its viewId.
   * Returns "entity_not_found" if the issuing session has been evicted.
   */
  async touch(input: DesktopTouchInput): Promise<DesktopTouchOutput> {
    // Pass nowFn so getByViewId can refresh lastAccessMs against the same
    // injected clock the eviction sweep uses. Codex PR #55 P2: without
    // this refresh, an in-flight workflow (see → think → touch) crossing
    // the eviction interval (default 30s timer over a 120s sessionTtlMs)
    // could find its session evicted at the moment of touch.
    const session = this.registry.getByViewId(input.lease.viewId, this.opts.nowFn);
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

  /** Dispose the facade and its ingress (event subscriptions). */
  dispose(): void {
    if (this._evictionTimer !== undefined) {
      clearInterval(this._evictionTimer);
      this._evictionTimer = undefined;
    }
    this.opts.ingress?.dispose();
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
      executorFn:         this.opts.executorFn,
      executorFactory:    this.opts.executorFn
        ? undefined
        : (target) => createDesktopExecutor(target, this.opts.executorDeps),
      isModalBlocking:    this.opts.isModalBlocking,
      isInViewport:       this.opts.isInViewport,
      getFocusedEntityId: this.opts.getFocusedEntityId,
      defaultTtlMs:       this.opts.defaultTtlMs,
      nowFn:              this.opts.nowFn,
    };
  }
}
