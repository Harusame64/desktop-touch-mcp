import type { UiEntity, EntityLease, LeaseValidationResult } from "./types.js";

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
}
