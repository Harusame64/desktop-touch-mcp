/**
 * ADR-036 / internal#125 — the lease residual says WHICH mismatch.
 *
 * Before this change `generation_mismatch` and `digest_mismatch` both collapsed to `Unknown` with
 * no advice, and a caller could not tell either of them from a THROWN handler: all three arrived
 * as one byte string, measured on the real machine
 * (`{"ok":false,"reason":"unknown","diff":[],"if_unexpected":{"most_likely_cause":"Unknown","try_next":[]}}`
 * — four arms, one distinct string; internal `6bdcdce` and `4f1a8a4`).
 *
 * These cells pin the three things that make the fix true rather than merely present:
 *   1. every lease reason answers with its OWN name, read from the reservation table;
 *   2. the ORDER `LeaseStore.validate` checks in, because a cell that only knows "the four names
 *      exist" passes just as green after someone swaps two checks around;
 *   3. the advice arrives — the key is not dropped, which is a different failure from an empty one.
 */
import { describe, it, expect } from "vitest";
import {
  LEASE_REASON_TO_TYPED_CODE,
  mapLeaseValidationToTypedReason,
} from "../../src/tools/_envelope.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const REASONS = ["expired", "generation_mismatch", "entity_not_found", "digest_mismatch"] as const;

const entity = (over: Partial<UiEntity> = {}): UiEntity =>
  ({
    entityId: "ent-1",
    label: "TARGET",
    role: "button",
    confidence: 1,
    sources: ["uia"],
    evidenceDigest: "digest-1",
    ...over,
  }) as UiEntity;

describe("internal#125 — every lease reason has its own name", () => {
  it("answers four distinct codes, and none of them is Unknown", () => {
    const codes = REASONS.map((r) => mapLeaseValidationToTypedReason(r).code);
    expect(new Set(codes).size, `four reasons must not share a name: ${codes.join(", ")}`).toBe(4);
    expect(codes).not.toContain("Unknown");
  });

  it("takes the name from the reservation table rather than a copy of it", () => {
    // The point of reading the table is that the table becomes a thing that is CHECKED. If a future
    // edit copies the values back into literals this still passes — so the cell that matters is the
    // mutation: change a table VALUE and this goes red, which a literal-returning function would not.
    for (const reason of REASONS) {
      expect(mapLeaseValidationToTypedReason(reason).code).toBe(LEASE_REASON_TO_TYPED_CODE[reason]);
    }
  });

  it("carries advice for the two promoted names — the key is present, not empty", () => {
    // `getSuggestsForCode` answers `[]` for a code it has no entry for, and the flat presenter's
    // `renderAdviceWithFloor` turns `[]` into `undefined`, which DROPS THE KEY. "absent" and "empty"
    // are different facts downstream, so the promotion is only finished when the advice exists:
    // mapping the code alone splits the name and leaves the recovery silent.
    for (const name of ["LeaseGenerationMismatch", "LeaseDigestMismatch"] as const) {
      expect(getSuggestsForCode(name).length, `${name} has no SUGGESTS entry`).toBeGreaterThan(0);
    }
    for (const reason of ["generation_mismatch", "digest_mismatch"] as const) {
      const { tryNext } = mapLeaseValidationToTypedReason(reason);
      expect(tryNext.length, `${reason} reaches the caller with no recovery`).toBeGreaterThan(0);
      expect(tryNext.every((row) => typeof row.action === "string" && row.action.length > 0)).toBe(true);
    }
  });
});

describe("internal#125 — the order LeaseStore.validate checks in", () => {
  // **Why an order cell and not four independent ones.** `validate` answers the FIRST check that
  // fails (`lease-store.ts`: TTL → generation → entity → digest), so a lease that is expired AND
  // generation-mismatched answers `expired`. Without this, a later change that reorders the checks
  // keeps every "the four names exist" cell green while silently changing which name a caller
  // receives — and the arms that measured this on the real machine only ever broke ONE rule at a
  // time, so they would not have noticed either.
  const live = [entity()];

  const leaseFor = (over: Partial<ReturnType<LeaseStore["issue"]>> = {}) => {
    const store = new LeaseStore({ nowFn: () => 1_000, defaultTtlMs: 60_000 });
    return { store, lease: { ...store.issue(entity(), "view-1"), ...over } };
  };

  it("answers expired when the TTL has passed, whatever else is also wrong", () => {
    const { store, lease } = leaseFor({
      expiresAtMs: 0,
      targetGeneration: "gen-OTHER",
      evidenceDigest: "digest-OTHER",
      entityId: "ent-GONE",
    });
    expect(store.validate(lease, "gen-1", live)).toEqual({ ok: false, reason: "expired" });
  });

  it("answers generation_mismatch before it looks at the entity or the digest", () => {
    const { store, lease } = leaseFor({
      targetGeneration: "gen-OTHER",
      evidenceDigest: "digest-OTHER",
      entityId: "ent-GONE",
    });
    expect(store.validate(lease, "gen-1", live)).toEqual({ ok: false, reason: "generation_mismatch" });
  });

  it("answers entity_not_found before it looks at the digest", () => {
    const { store, lease } = leaseFor({
      targetGeneration: "gen-1",
      evidenceDigest: "digest-OTHER",
      entityId: "ent-GONE",
    });
    expect(store.validate(lease, "gen-1", live)).toEqual({ ok: false, reason: "entity_not_found" });
  });

  it("answers digest_mismatch last, when nothing earlier disagrees", () => {
    const { store, lease } = leaseFor({ targetGeneration: "gen-1", evidenceDigest: "digest-OTHER" });
    expect(store.validate(lease, "gen-1", live)).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("and each of those four reasons now reaches a caller under its own name", () => {
    // The two cells above are about the store; this line is the join — the order the store answers
    // in, mapped through the presenter, is what a caller actually receives.
    expect(
      (["expired", "generation_mismatch", "entity_not_found", "digest_mismatch"] as const).map(
        (r) => mapLeaseValidationToTypedReason(r).code,
      ),
    ).toEqual(["LeaseExpired", "LeaseGenerationMismatch", "EntityNotFound", "LeaseDigestMismatch"]);
  });
});
