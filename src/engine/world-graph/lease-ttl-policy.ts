/**
 * Lease TTL policy for Anti-Fukuwarai v2 (H1 hardening + no-compromise A batch).
 *
 * Why this exists:
 *   Fixed 5s TTL is too short for `view=explore` or large responses because
 *   LLM read + reason + next-tool-call latency commonly exceeds 5s. Dogfood
 *   scenarios S1 (browser-form) and S3 (terminal) hit `lease_expired` there.
 *
 * 2026-05-17 update (issue #327 item F): base bumped 5_000 → 15_000.
 *   Real Claude Code round-trip (user utterance + reasoning + next tool call)
 *   is typically 10-30s, so the 5s baseline often tripped `lease_expired`
 *   on `action` and short-`explore` cycles during dogfood. 15s base brings
 *   the `action` view into the lower edge of typical round-trip; explore and
 *   debug stack on top as before. The hard cap (60_000) remains unchanged.
 *
 * Policy:
 *   ttlMs = clamp(base + viewBonus + entityBonus + payloadBonus, floor, cap)
 *     base         = 15_000
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
  baseMs:             15_000,
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
  /**
   * ADR-020 PR-P2-2: observed wallclock from the previous act attempt to this
   * see() call, if available (LeaseStore.consumeObservedRoundTripMs()). Used
   * to ensure ttlMs covers the LLM's actual round-trip thinking time when
   * that exceeds the policy-derived value. Undefined on the first see() of
   * a session (no act recorded yet).
   */
  observedRoundTripMs?: number;
}

/**
 * ADR-020 PR-P2-2: return shape of `computeLeaseTtlMs`.
 *
 *   - `ttlMs`            — the lease TTL the caller should issue.
 *   - `refreshRequired`  — true iff `observedRoundTripMs > cap` (the lease
 *                          window cannot stretch past the cap, so the LLM
 *                          MUST see() again before its TTL window closes).
 *                          Internal-only marker; not surfaced on
 *                          `DesktopSeeOutput` envelope in this epic. Future
 *                          work (ADR-021 LLM E2E harness) may consume it.
 */
export interface LeaseTtlResult {
  ttlMs: number;
  refreshRequired: boolean;
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
 *
 * ADR-020 PR-P2-2 (F refactor): two-branch contract on observedRoundTripMs:
 *   (a) observedRoundTripMs ≤ cap:
 *       ttlMs ≥ observedRoundTripMs (policy raw OR observed, whichever larger,
 *       then clamped to [floor, cap]); refreshRequired = false.
 *   (b) observedRoundTripMs > cap:
 *       ttlMs = cap (cannot stretch past the safety cap);
 *       refreshRequired = true (the LLM must see() again before this window
 *       closes — internal marker only, not surfaced to envelope in this epic).
 *
 * The cap (60_000ms) is unchanged from H1 hardening — leases that span longer
 * than that risk acting on stale state, so the policy refuses to extend even
 * when the LLM clearly needs more time. The refreshRequired marker is the
 * structural alternative to silently letting the lease expire mid-thinking.
 */
export function computeLeaseTtlMs(input: LeaseTtlInput): LeaseTtlResult {
  const raw = LEASE_TTL_POLICY.baseMs
    + viewBonus(input.view)
    + entityBonus(input.entityCount)
    + payloadBonus(input.payloadBytes);
  const observed = input.observedRoundTripMs;
  if (observed !== undefined && Number.isFinite(observed) && observed > LEASE_TTL_POLICY.cap) {
    return { ttlMs: LEASE_TTL_POLICY.cap, refreshRequired: true };
  }
  const target = observed !== undefined && Number.isFinite(observed) && observed > 0
    ? Math.max(raw, observed)
    : raw;
  return { ttlMs: clamp(target, LEASE_TTL_POLICY.floor, LEASE_TTL_POLICY.cap), refreshRequired: false };
}

/**
 * Compute the soft-expiry timestamp from an absolute issue time + the TTL.
 * The LLM treats this as "consider refreshing"; the hard `expiresAtMs` is
 * the only correctness wall.
 */
export function computeSoftExpiresAtMs(issuedAtMs: number, ttlMs: number): number {
  return issuedAtMs + Math.floor(ttlMs * LEASE_TTL_POLICY.softExpiryFraction);
}
