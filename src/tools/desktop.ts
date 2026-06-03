import { randomUUID } from "node:crypto";
import type { UiEntityCandidate } from "../engine/vision-gpu/types.js";
import type {
  UiEntity,
  EntityLease,
  LeaseValidationResult,
} from "../engine/world-graph/types.js";
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
import { UIA_BLIND_WARNINGS } from "./desktop-providers/compose-providers.js";
import { deriveEntityCapabilities } from "./desktop-capabilities.js";
import { bakeEntityCapabilities } from "../capabilities/registry.js";
import { isUiaCacheStale } from "../engine/identity-tracker.js";
import type { AttentionState } from "../engine/perception/types.js";

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
  /**
   * Issue #295 carry-over — freshness signal for the actionable entities
   * surface, mirroring `desktop_state.attention`. Set to `'stale'` when the
   * UIA cache for the resolved target HWND has fully expired
   * (`isUiaCacheStale`) so the LLM does not act on a stale snapshot. Omitted
   * when no HWND can be resolved (no `getFocusedHwnd` wired, target spec
   * lacks an HWND) — absent field reads as "no signal" rather than "fresh".
   *
   * Today this field only carries `'ok' | 'stale'`; the wider
   * `AttentionState` union is declared so future signals (e.g. layer-buffer
   * dirty) can be added without a breaking change.
   */
  attention?: AttentionState;
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
   * Set to () => false to disable. Issue #63 (Codex P1): when overridden alone, `blockingElement`
   * on the modal_blocking response is intentionally dropped to prevent identity mismatch with
   * a custom predicate. Override `findBlockingModal` alongside to surface a matching blocker.
   */
  isModalBlocking?: (entity: UiEntity) => boolean;
  /**
   * Override blocking-modal identity lookup. The returned entity's identity is surfaced as
   * `blockingElement` on the modal_blocking response so the LLM can dismiss it via
   * `click_element(name=blockingElement.name)`. Issue #63. When overridden alone (without
   * `isModalBlocking`), the predicate is derived from this finder for consistency.
   */
  findBlockingModal?: (entity: UiEntity) => UiEntity | null;
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
  /**
   * Issue #295 carry-over — resolver for the foreground HWND so see() can
   * surface `attention: 'stale'` when the UIA cache for that HWND is fully
   * expired. Only consulted when `input.target?.hwnd` is absent. Tests omit
   * to avoid Win32 calls; production wires this in `desktop-register.ts`
   * via `enumWindowsInZOrder`. When omitted (or it throws/returns null)
   * and no `target.hwnd` was supplied, `attention` is left absent.
   */
  getFocusedHwnd?: () => bigint | null;
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

/**
 * Issue #295 carry-over — resolve the HWND (as bigint) that the UIA cache
 * stale check should consult. Returns:
 *   - `BigInt(target.hwnd)` when the caller pinned a specific HWND;
 *   - `getFocusedHwnd()`'s return value when no HWND was supplied and the
 *     injectable resolver was wired (production: foreground from
 *     `enumWindowsInZOrder`);
 *   - `null` when neither path produces a value (test wiring without
 *     focus, or `BigInt()` parse failure on a malformed `target.hwnd`).
 *
 * Never throws — every defensive branch falls through to `null` so the
 * stale check is best-effort. The wider see() path is unaffected.
 */
function resolveTargetHwnd(
  target: TargetSpec | undefined,
  getFocusedHwnd: (() => bigint | null) | undefined,
): bigint | null {
  if (target?.hwnd) {
    try {
      return BigInt(target.hwnd);
    } catch {
      return null;
    }
  }
  if (!getFocusedHwnd) return null;
  try {
    return getFocusedHwnd();
  } catch {
    return null;
  }
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

    // ADR-020 PR-P2-2 (Codex Round 1 P2: location fix / Round 2 P2: peek-not-consume
    // / Round 3 P2: CAS-guarded commit):
    //   - read the round-trip wallclock at see() entry, BEFORE any async snapshot
    //     /window collection (R1: avoids backend latency contaminating the value)
    //   - use peek (no clear) so a transient snapshot failure that throws below does
    //     NOT silently discard the sample (R2: clearing one-shot before TTL is
    //     actually computed loses the round-trip permanently)
    //   - peek returns { elapsedMs, sampleSeq }; we hold the CAS token (sampleSeq,
    //     a monotonic counter) and pass it to commit. HTTP-mode facade is
    //     process-global, so a concurrent desktop_act between peek and commit could
    //     otherwise stomp the new sample when we clear. CAS commit with the
    //     monotonic seq keeps the newer sample for the next see() (R3) and is
    //     immune to same-millisecond collisions that a timestamp token would suffer
    //     under concurrent requests (R4).
    const peekedRoundTrip = session.leaseStore.peekObservedRoundTripMs();
    const observedRoundTripMs = peekedRoundTrip?.elapsedMs;

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
    // ADR-024 Seed-2 — persist whether this discover saw a *visual-only* target
    // for the desktop_act wrapper to gate post-action roiCapture. Visual-only =
    // UIA-blind (PWA/Electron/canvas/RDP) AND no structured observation source.
    // UIA-blindness ALONE is not sufficient: the terminal route runs UIA as an
    // *additive* provider (compose-providers.ts), so a terminal whose UIA tree
    // looks blind still surfaces uia_blind_* warnings — but the terminal buffer is
    // a structured source, so a post-action screenshot must be suppressed there
    // (feedback_minimize_screenshot_reliance; Codex PR #425 P2). Browser (CDP) is
    // likewise structured. So require a blind warning AND the absence of any
    // terminal/cdp candidate. The blind predicate stays the same SSOT set as the
    // OCR lane's `uiaBlindForOcr` (UIA_BLIND_WARNINGS).
    const uiaBlind = rawResult.warnings.some((w) => UIA_BLIND_WARNINGS.has(w));
    const hasStructuredSource = rawResult.candidates.some(
      (c) => c.source === "terminal" || c.source === "cdp",
    );
    session.lastDiscoverVisualOnly = uiaBlind && !hasStructuredSource;
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

    // ADR-020 PR-P2-2: both branches normalised to { ttlMs, refreshRequired }
    // so downstream sees a single shape. observedRoundTripMs was consumed at
    // see() entry (Codex Round 1 P2 fix) so it reflects "act → next see()
    // start" wallclock, not "act → end-of-snapshot-collection".
    const policyTtl: { ttlMs: number; refreshRequired: boolean } =
      this.opts.defaultTtlMs !== undefined
        ? { ttlMs: this.opts.defaultTtlMs, refreshRequired: false }
        : computeLeaseTtlMs({
            view: input.view,
            entityCount: resolved.length,
            payloadBytes: estimatedPayloadBytes,
            observedRoundTripMs,
          });

    const nowFn = this.opts.nowFn ?? Date.now;
    const issuedAtMs = nowFn();

    const entityViews: EntityView[] = resolved.map((e) => {
      const lease = session.leaseStore.issue(e, newViewId, policyTtl.ttlMs);
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
      softExpiresAtMs: computeSoftExpiresAtMs(issuedAtMs, policyTtl.ttlMs),
    };
    if (rawResult.warnings.length > 0) output.warnings = rawResult.warnings;

    // H2: derive structured constraints from warnings for LLM fallback decisions.
    const constraints = deriveViewConstraints(rawResult.warnings, entityViews.length);
    if (constraints) output.constraints = constraints;

    // Issue #296 — attach `capabilities` per entity, derived from the UIA
    // `controlType` + `patterns` already carried through by the resolver.
    // Pure derivation, no extra UIA round-trip. `constraints` is passed in
    // so a UIA-blind view (`uia: 'provider_failed'`) can bias UIA-sourced
    // entities toward mouse even when their pattern set looks fine.
    //
    // Issue #296 Phase 2 — also stash `unsupportedExecutors` on the resolved
    // UiEntity so `desktop-executor.ts` can short-circuit a UIA route before
    // paying the `InvokePatternNotSupported` round-trip. `resolved` and
    // `session.entities` alias the same array, so the touch path picks this
    // up automatically.
    // ADR-020 SR-1 PR-SR1-1 (case β entity bake、北極星 8): the registry
    // lookup result is baked onto the engine `UiEntity` in a single batch
    // (`preferredExecutors / unsupportedExecutors / fallbackHint`) via
    // `bakeEntityCapabilities`. The previous inline writeback handled only
    // `unsupportedExecutors`; SR-1 extends this to all three advisory fields
    // so `createDesktopExecutor` can consume them via `entity.*` without
    // re-invoking the registry (which would conflict with the session-bound
    // `executorFactory` lifetime).
    for (let i = 0; i < entityViews.length; i++) {
      const entity = resolved[i];
      if (entity === undefined) continue;
      const cap = deriveEntityCapabilities(entity, constraints);
      if (cap) {
        entityViews[i]!.capabilities = cap;
        bakeEntityCapabilities(entity, cap);
      }
    }

    // Issue #295 carry-over — surface attention='stale' when the UIA cache
    // for the resolved target HWND is fully expired. Mirrors `desktop_state`
    // behaviour so the LLM gets the same freshness signal regardless of
    // which observation tool it chose. We only set the field when we can
    // resolve an HWND (explicit target.hwnd or injected getFocusedHwnd);
    // when neither is available we leave the field absent rather than
    // synthesising a false 'ok'.
    const resolvedHwnd = resolveTargetHwnd(input.target, this.opts.getFocusedHwnd);
    if (resolvedHwnd !== null) {
      try {
        if (isUiaCacheStale(resolvedHwnd)) {
          output.attention = "stale";
        } else {
          output.attention = "ok";
        }
      } catch {
        // best-effort — never block see() on a cache lookup
      }
    }

    // Codex PR #55 P2: refresh lastAccessMs at the END of see() too, in case
    // candidateProvider / ingress took longer than the eviction interval to
    // complete. getOrCreate stamps the start time; without this completion
    // refresh, a multi-minute see() could be evicted mid-call.
    session.lastAccessMs = (this.opts.nowFn ?? Date.now)();

    // ADR-020 PR-P2-2 (Codex Round 2 P2 fix + Round 3/4 P2 CAS guard): commit
    // the peeked round-trip sample only after the successful see() has applied
    // it to TTL computation. If snapshot/window collection above threw, the
    // function exited without reaching this line and the sample stays staged
    // for the next see() call. CAS token (sampleSeq monotonic counter)
    // protects against a concurrent recordAct() between peek and commit —
    // newer sample wins, even when same-millisecond timestamps would collide.
    if (peekedRoundTrip !== undefined) {
      session.leaseStore.commitObservedRoundTripMs(peekedRoundTrip.sampleSeq);
    }

    return output;
  }

  /**
   * Pre-flight lease validation without executing a touch (ADR-010 P1
   * S4 sub-plan §3.4). Used by `makeCommitWrapper`'s `leaseValidator`
   * option so the L5 envelope wrapper can produce a typed-reason
   * failure envelope (`LeaseExpired` etc.) BEFORE the side-effecting
   * handler runs — the wrapper short-circuits via
   * `if_unexpected.most_likely_cause` + `try_next` and does not call
   * `touch()`.
   *
   * Routes to the session that issued the lease via its viewId,
   * mirroring `touch()`'s lookup. Returns `entity_not_found` when
   * the session has been evicted (same semantic as `touch()` so
   * production envelope shape is consistent).
   *
   * Side-effect-free (only refreshes the session's lastAccessMs).
   */
  /**
   * ADR-019 Stage 5 helper — resolve the HWND associated with the session
   * that issued `viewId`. Tries, in order:
   *   1. `session.lastTarget.hwnd` (caller explicitly pinned an HWND);
   *   2. `this.opts.getFocusedHwnd()` (foreground fallback — production
   *      wires this to `enumWindowsInZOrder`, so the typical
   *      `desktop_discover()` / `desktop_discover({ windowTitle })`
   *      flow lands here and Stage 5 stays effective).
   * Returns `null` when the session has been evicted (the lease's viewId
   * no longer maps to a live session) or no HWND can be resolved by
   * either step. Never throws.
   *
   * PR-SR4-4 Round 1 P2 — `BigInt(target.hwnd)` parse failure no longer
   * short-circuits to `null`: instead it logs the audit trail (preserving
   * the PR #325 Round 1 P3-2 stderr surface) and falls through to the
   * foreground resolver. This keeps Stage 5 effective when a stale lease
   * has a malformed pinned hwnd but a usable focused HWND is available —
   * the same dormancy class this PR claims to eliminate. The previous
   * implementation pinned that as a separate dormancy bug (parse failure
   * → silent skip even when foreground would have worked); pinned in
   * `tests/unit/desktop-facade.test.ts` "malformed target.hwnd falls back
   * to getFocusedHwnd".
   *
   * Why the session-eviction guard is explicit (rather than letting the
   * foreground resolver fire anyway): if `touch()` has just rejected the
   * lease with `entity_not_found`, Stage 5 is not invoked in the first
   * place. But if eviction races in between (`touch()` succeeded, then
   * the session was swept before this call), attaching an observation
   * from whatever happens to be in foreground would mislabel the
   * observation as belonging to a window the LLM never asked about —
   * a correctness regression vs. honestly omitting the field.
   *
   * Implementation note: open-codes the (target.hwnd → focused) ladder
   * rather than reusing `resolveTargetHwnd` because the parse-failure
   * fall-through semantics here are intentionally **different from
   * `see()`'s UIA-cache stale check** (which wants null on parse failure
   * so a malformed pinned hwnd does not silently use the foreground
   * window as a stale-check target).
   */
  resolveHwndForViewId(viewId: string): bigint | null {
    const session = this.registry.getByViewId(viewId, this.opts.nowFn);
    if (!session) return null;
    const target = session.lastTarget;
    if (target?.hwnd) {
      try {
        return BigInt(target.hwnd);
      } catch (err) {
        // Audit trail (PR #325 Round 1 P3-2 — preserves the original
        // stderr surface so a production race where `lastTarget.hwnd`
        // becomes malformed (CDP tab path, stale lease, etc.) is still
        // observable rather than silently disabled.
        console.error(
          `[desktop] Stage 5 — BigInt(target.hwnd) failed for viewId=${viewId}: ${err instanceof Error ? err.message : String(err)}; falling back to foreground resolver`,
        );
        // Intentionally fall through to the foreground resolver below.
      }
    }
    if (!this.opts.getFocusedHwnd) return null;
    try {
      return this.opts.getFocusedHwnd();
    } catch {
      return null;
    }
  }

  /**
   * ADR-024 Seed-2 — read the visual-only flag persisted at the most recent
   * `desktop_discover` for this session's view, used by the `desktop_act` wrapper
   * to gate post-action `roiCapture`. Returns `false` when the session is gone or
   * no discover has run yet (safe default = no capture).
   */
  resolveVisualOnlyForViewId(viewId: string): boolean {
    const session = this.registry.getByViewId(viewId, this.opts.nowFn);
    return session?.lastDiscoverVisualOnly ?? false;
  }

  validateLeaseOnly(lease: EntityLease): LeaseValidationResult {
    const session = this.registry.getByViewId(lease.viewId, this.opts.nowFn);
    if (!session) {
      return { ok: false, reason: "entity_not_found" };
    }
    return session.leaseStore.validate(lease, session.generation, session.entities);
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
      findBlockingModal:  this.opts.findBlockingModal,
      isInViewport:       this.opts.isInViewport,
      getFocusedEntityId: this.opts.getFocusedEntityId,
      defaultTtlMs:       this.opts.defaultTtlMs,
      nowFn:              this.opts.nowFn,
    };
  }
}
