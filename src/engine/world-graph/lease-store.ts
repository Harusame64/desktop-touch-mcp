import type { UiEntity, EntityLease, LeaseValidationResult } from "./types.js";

/**
 * Default TTL used when the caller does not pass `ttlMs` to issue().
 *
 * For production see() calls, the TTL is chosen by lease-ttl-policy.ts based
 * on `view` and entity count (H1 hardening). This default only applies to:
 *   - tests that construct LeaseStore directly
 *   - legacy callers that bypass the facade policy
 *
 * Safety: `cap` in lease-ttl-policy.ts bounds production TTLs so stale leases
 * cannot live indefinitely regardless of policy inputs.
 */
const DEFAULT_TTL_MS = 5_000;

export interface LeaseStoreOptions {
  /** Default TTL for issued leases in ms (default: 5000). */
  defaultTtlMs?: number;
  /** Injectable clock for testing. */
  nowFn?: () => number;
}

export class LeaseStore {
  private readonly leases = new Map<string, EntityLease>();
  private readonly defaultTtlMs: number;
  private readonly nowFn: () => number;
  /**
   * ADR-020 PR-P2-2: timestamp of the most recent act attempt in this session.
   * Read-once via consumeObservedRoundTripMs() on the next see() — the
   * computed `nowFn() - lastActAtMs` reflects the LLM's "act → next see"
   * round-trip wallclock, which feeds `observedRoundTripMs` into the TTL
   * policy so the lease window adapts to actual thinking time.
   *
   * Lifecycle:
   *   - undefined initially (no act yet)
   *   - set by recordAct() at execute attempt time (success OR failure)
   *   - cleared by consumeObservedRoundTripMs() after read (one-shot)
   */
  private lastActAtMs: number | undefined = undefined;

  constructor(opts: LeaseStoreOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /**
   * Issue a lease for an entity.
   * Replaces any existing lease for the same entityId.
   */
  issue(entity: UiEntity, viewId: string, ttlMs?: number): EntityLease {
    const lease: EntityLease = {
      entityId: entity.entityId,
      viewId,
      targetGeneration: entity.generation,
      expiresAtMs: this.nowFn() + (ttlMs ?? this.defaultTtlMs),
      evidenceDigest: entity.evidenceDigest,
    };
    this.leases.set(entity.entityId, lease);
    return lease;
  }

  /**
   * Validate a lease against the current generation and a live entity set.
   *
   * Returns `{ok:true, entity}` so the caller can use the re-resolved entity
   * without a second lookup — preventing TOCTOU between validate and click.
   *
   * Callers MUST pass the same `liveEntities` snapshot to both `validate()` and
   * the executor, with no await between them.
   *
   * Checks (in order):
   * 1. TTL not expired
   * 2. Generation matches current
   * 3. Entity with matching entityId is present in the live set
   * 4. evidenceDigest matches the live entity
   */
  validate(
    lease: EntityLease,
    currentGeneration: string,
    liveEntities: UiEntity[]
  ): LeaseValidationResult {
    if (this.nowFn() > lease.expiresAtMs) {
      return { ok: false, reason: "expired" };
    }
    if (lease.targetGeneration !== currentGeneration) {
      return { ok: false, reason: "generation_mismatch" };
    }
    const entity = liveEntities.find((e) => e.entityId === lease.entityId);
    if (!entity) {
      return { ok: false, reason: "entity_not_found" };
    }
    if (entity.evidenceDigest !== lease.evidenceDigest) {
      return { ok: false, reason: "digest_mismatch" };
    }
    return { ok: true, entity };
  }

  /** Return the stored lease for an entity, or undefined if not issued / evicted. */
  get(entityId: string): EntityLease | undefined {
    return this.leases.get(entityId);
  }

  /** Evict all expired leases to prevent unbounded growth. */
  evictExpired(): void {
    const now = this.nowFn();
    for (const [id, lease] of this.leases) {
      if (now > lease.expiresAtMs) this.leases.delete(id);
    }
  }

  /**
   * ADR-020 PR-P2-2: record the wallclock of an act attempt. Called from
   * GuardedTouchLoop.touch() just before execute (success OR failure both
   * captured — the LLM's thinking time ends at attempt start, independent of
   * what the OS/app does next). The `viewId` argument is accepted for future
   * per-viewId expansion; the timestamp is taken from the store's injected
   * `nowFn` so test fake timers automatically apply (callers do not need to
   * pass their own clock).
   */
  recordAct(_viewId: string): void {
    this.lastActAtMs = this.nowFn();
  }

  /**
   * ADR-020 PR-P2-2: read-once accessor for the act → next see() round-trip
   * wallclock. Returns `nowFn() - lastActAtMs` if an act has been recorded
   * since the last consume, otherwise undefined. Clears `lastActAtMs` after
   * read so subsequent see() calls without an intervening act get undefined
   * (not the stale "time since the original act" reading).
   *
   * Per-see cycle (see → act → see → act → see …):
   *   - first see:                   undefined  (no act yet)
   *   - after recordAct, next see:   nowFn() - lastActAtMs, then clear
   *   - subsequent see without act:  undefined  (cleared)
   *
   * Naming convention: `consume*` (not `get*`) advertises the side-effect
   * (clear-after-read) so callers cannot accidentally re-read stale values.
   */
  consumeObservedRoundTripMs(): number | undefined {
    if (this.lastActAtMs === undefined) return undefined;
    const elapsed = this.nowFn() - this.lastActAtMs;
    this.lastActAtMs = undefined;
    return elapsed;
  }
}
