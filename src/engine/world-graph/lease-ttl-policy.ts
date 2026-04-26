/**
 * Lease TTL policy for Anti-Fukuwarai v2 (H1 hardening + no-compromise A batch).
 *
 * Why this exists:
 *   Fixed 5s TTL is too short for `view=explore` or large responses because
 *   LLM read + reason + next-tool-call latency commonly exceeds 5s. Dogfood
 *   scenarios S1 (browser-form) and S3 (terminal) hit `lease_expired` there.
 *
 * Policy:
 *   ttlMs = clamp(base + viewBonus + entityBonus + payloadBonus, floor, cap)
 *     base         = 5_000
 *     viewBonus    = action:0 / explore:+5_000 / debug:+10_000
 *     entityBonus  = max(0, entityCount - 20) * 100        [all views]
 *     payloadBonus = max(0, payloadBytes - 2_000) * 0.5    [capped at +10_000]
 *     floor        = 2_000  (defensive; never reached by current policy)
 *     cap          = 60_000 (stale-lease safety; LLMs that think >60s must see() again)
 *
 * The `softExpiresAtMs` recommendation (see desktop.ts) sits at 60% of the
 * computed TTL window — the LLM is told "this is when you should consider
 * refreshing even though the lease is still valid". The hard `expiresAtMs`
 * remains the only correctness wall.
 *
 * Safety contract (unchanged):
 *   - generation_mismatch, digest_mismatch, entity_not_found are independent of TTL
 *   - TTL only controls the `expired` reason path
 *   - Cap ensures no lease lives unreasonably long
 *
 * Not in scope (future batches):
 *   - operator-mode (debug-session) extension
 *   - touch-side grace / auto-refresh (covered by separate batch C)
 */

export const LEASE_TTL_POLICY = {
  baseMs:             5_000,
  floor:              2_000,
  cap:                60_000,
  viewBonus: {
    action:  0,
    explore: 5_000,
    debug:   10_000,
  } as const,
  entityBonusThreshold: 20,
  entityBonusPerUnit:   100,
  payloadBonusBaselineBytes: 2_000,
  payloadBonusPerByteMs:     0.5,
  payloadBonusCapMs:         10_000,
  /** Soft-expiry as a fraction of the full TTL — advisory, not enforced. */
  softExpiryFraction: 0.6,
} as const;

export interface LeaseTtlInput {
  /** view mode from desktop_discover. Undefined = "action" (default). */
  view: "action" | "explore" | "debug" | undefined;
  /** Number of entities issued in this view (after maxEntities slicing). */
  entityCount: number;
  /** Optional payload size in bytes — used to extend TTL when the LLM has more text to read. */
  payloadBytes?: number;
}

function viewBonus(view: LeaseTtlInput["view"]): number {
  switch (view) {
    case "explore": return LEASE_TTL_POLICY.viewBonus.explore;
    case "debug":   return LEASE_TTL_POLICY.viewBonus.debug;
    case "action":
    case undefined:
    default:        return LEASE_TTL_POLICY.viewBonus.action;
  }
}

function entityBonus(count: number): number {
  const over = Math.max(0, count - LEASE_TTL_POLICY.entityBonusThreshold);
  return over * LEASE_TTL_POLICY.entityBonusPerUnit;
}

function payloadBonus(bytes: number | undefined): number {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return 0;
  const over = Math.max(0, bytes - LEASE_TTL_POLICY.payloadBonusBaselineBytes);
  return Math.min(over * LEASE_TTL_POLICY.payloadBonusPerByteMs, LEASE_TTL_POLICY.payloadBonusCapMs);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute the lease TTL (ms) for a given see() response shape.
 *
 * Deterministic and side-effect free — safe to call from any layer.
 */
export function computeLeaseTtlMs(input: LeaseTtlInput): number {
  const raw = LEASE_TTL_POLICY.baseMs
    + viewBonus(input.view)
    + entityBonus(input.entityCount)
    + payloadBonus(input.payloadBytes);
  return clamp(raw, LEASE_TTL_POLICY.floor, LEASE_TTL_POLICY.cap);
}

/**
 * Compute the soft-expiry timestamp from an absolute issue time + the TTL.
 * The LLM treats this as "consider refreshing"; the hard `expiresAtMs` is
 * the only correctness wall.
 */
export function computeSoftExpiresAtMs(issuedAtMs: number, ttlMs: number): number {
  return issuedAtMs + Math.floor(ttlMs * LEASE_TTL_POLICY.softExpiryFraction);
}
