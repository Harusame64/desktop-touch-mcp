/**
 * Lease TTL policy for Anti-Fukuwarai v2 (H1 hardening).
 *
 * Why this exists:
 *   Fixed 5s TTL is too short for `view=explore` or large responses because
 *   LLM read + reason + next-tool-call latency commonly exceeds 5s. Dogfood
 *   scenarios S1 (browser-form) and S3 (terminal) hit `lease_expired` there.
 *
 * Policy:
 *   ttlMs = clamp(base + viewBonus + entityBonus, floor, cap)
 *     base        = 5_000
 *     viewBonus   = action:0 / explore:+5_000 / debug:+10_000
 *     entityBonus = max(0, entityCount - 20) * 100   [applies to all views]
 *     floor       = 2_000  (defensive; never reached by current policy)
 *     cap         = 30_000 (stale-lease safety: LLMs that think >30s must see() again)
 *
 * Safety contract (unchanged by this policy):
 *   - generation_mismatch, digest_mismatch, entity_not_found are independent of TTL
 *   - TTL only controls the `expired` reason path
 *   - Cap ensures no lease lives unreasonably long
 *
 * Not in scope (future batches):
 *   - payload-size-aware TTL (when size metrics are available)
 *   - operator-mode (debug-session) extension
 *   - touch-side grace / auto-refresh (explicitly forbidden by instructions)
 */

export const LEASE_TTL_POLICY = {
  baseMs:             5_000,
  floor:              2_000,
  cap:                30_000,
  viewBonus: {
    action:  0,
    explore: 5_000,
    debug:   10_000,
  } as const,
  entityBonusThreshold: 20,
  entityBonusPerUnit:   100,
} as const;

export interface LeaseTtlInput {
  /** view mode from desktop_discover. Undefined = "action" (default). */
  view: "action" | "explore" | "debug" | undefined;
  /** Number of entities issued in this view (after maxEntities slicing). */
  entityCount: number;
  // Reserved for future batches; not used today.
  // payloadBytes?: number;
  // operatorMode?: boolean;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute the lease TTL (ms) for a given see() response shape.
 *
 * Deterministic and side-effect free — safe to call from any layer.
 */
export function computeLeaseTtlMs(input: LeaseTtlInput): number {
  const raw = LEASE_TTL_POLICY.baseMs + viewBonus(input.view) + entityBonus(input.entityCount);
  return clamp(raw, LEASE_TTL_POLICY.floor, LEASE_TTL_POLICY.cap);
}
