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
// The extractor is JS on purpose — it reads the tree as text, and the cells below read it the same way.
import { readReturnedCodes } from "../../scripts/lib/result-vocabulary.mjs";
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

describe("internal#125 — the extractor that has to SEE the fix", () => {
  // **The flag was added without an input that makes it fire, and it did not.** Round 1 of the Opus
  // review measured the first version against five shapes and four came back silent — including the
  // exact draft its own comment cited — because the surrounding pattern consumed both braces and the
  // string contents were never blanked. A flag that cannot fire is indistinguishable from a
  // negative, so the shapes live here now rather than in a comment.
  const wrap = (body: string) =>
    [
      "function f(",
      "  reason: R,",
      "): { code: string } {",
      '  if (reason === "a" || reason === "b") {',
      body,
      "  }",
      '  return { code: "Lit" };',
      "}",
    ].join("\n");

  const flagged = (body: string) => {
    const problems: string[] = [];
    readReturnedCodes(wrap(body), "f", problems, null);
    return problems.some((x) => /SHORTHAND/.test(x));
  };

  it("fires on every shape a shorthand `code` can take", () => {
    expect(flagged("    return { code };")).toBe(true);
    expect(flagged("    return { code, tryNext: [] };")).toBe(true);
    expect(flagged("    return {\n      code,\n      tryNext: [],\n    };")).toBe(true);
    expect(flagged("    return { tryNext: [], code };")).toBe(true);
    expect(flagged("    return { a: 1, code, b: 2 };")).toBe(true);
  });

  it("stays silent where the name IS readable, and where the text only looks like a key", () => {
    expect(flagged('    return { code: "X" };')).toBe(false);
    // The mirror of what gate 2 found on #674: a string whose VALUE contains the word.
    expect(flagged('    return { note: "a, code}", code: "X" };')).toBe(false);
    // This repo's advice lines carry braces — a non-string-aware scan ends the object inside one.
    expect(flagged('    return { code: "X", tryNext: [{ action: "{tool:reidentify_element}" }] };')).toBe(false);
  });

  it("resolves a table read through the branch that guards it, not to the whole table", () => {
    // **Resolving to the whole table makes "a reserved name nothing produces" true by construction**,
    // which is the defect the reservation exists to catch, wearing the fix's clothes. The guard names
    // "a" and "b"; "c" is reserved and reached by nothing, and must not appear.
    const table = { a: "CodeA", b: "CodeB", c: "CodeC" };
    const problems: string[] = [];
    const codes = readReturnedCodes(
      wrap("    return { code: TBL[reason] };"),
      "f",
      problems,
      { name: "TBL", table },
    );
    expect(codes).toContain("CodeA");
    expect(codes).toContain("CodeB");
    expect(codes, "a reserved name no branch returns must not count as produced").not.toContain("CodeC");
    expect(problems).toEqual([]);
  });

  it("says so when it cannot read the branch, rather than answering nothing", () => {
    // An empty answer and "this parser could not tell" must not look the same to the caller.
    const problems: string[] = [];
    const codes = readReturnedCodes(
      ["function f(", "  reason: R,", "): { code: string } {", "  return { code: TBL[reason] };", "}"].join("\n"),
      "f",
      problems,
      { name: "TBL", table: { a: "CodeA" } },
    );
    expect(codes).toEqual([]);
    expect(problems.join(" ")).toMatch(/cannot read/);
  });
});

describe("internal#125 Round 2 — the two the mask and the guard still got wrong", () => {
  // Round 1 built a string mask and then searched the RAW span with it, and read the last `if`
  // before a return without asking whether that `if` contained it. Both are the same defect this
  // parser keeps reproducing — a decision about shape taken on text that says something else — and
  // both were measured before being fixed, so both are pinned by the inputs that measured them.
  const fn = (body: string) => ["function f(", "  r: R,", "): X {", body, "}"].join("\n");
  const read = (src: string, resolvable: unknown = null) => {
    const problems: string[] = [];
    const codes = readReturnedCodes(src, "f", problems, resolvable);
    return { codes, problems };
  };
  const TBL = { name: "TBL", table: { a: "CodeA", b: "CodeB", c: "CodeC" } };

  it("does not read a name out of a string that spells the key", () => {
    // Measured before the fix: codes were ["Fabricated"] with problems [] — a name nothing produces,
    // reported with no sign that anything was unread. This repo's advice prose spells `code:`.
    const { codes, problems } = read(
      fn('  return { hint: \'pass code: "Fabricated", or nothing\', code: "Real" };'),
    );
    expect(codes).toEqual(["Real"]);
    expect(problems).toEqual([]);
  });

  it("refuses to attribute an UNGUARDED return to the if block above it", () => {
    // Measured before the fix: the return after a closed block was credited with that block's
    // discriminants, silently. Counting names something does NOT produce is the Round 1 defect;
    // this is the same error pointed the other way, and both answered with problems: [].
    const { codes, problems } = read(
      fn('  if (r === "a") {\n    doThing();\n  }\n  return { code: TBL[r] };'),
      TBL,
    );
    expect(codes).toEqual([]);
    expect(problems.join(" ")).toMatch(/cannot read/);
  });

  it("refuses a switch-guarded return rather than borrowing a nearby if", () => {
    const { codes, problems } = read(
      fn('  if (r === "a") {\n    doThing();\n  }\n  switch (r) {\n    case "b":\n      return { code: TBL[r] };\n  }'),
      TBL,
    );
    expect(codes).toEqual([]);
    expect(problems.join(" ")).toMatch(/cannot read/);
  });

  it("reads a guard spelled without a space, and takes the INNERMOST one", () => {
    // `if(` is the same branch to a reader and a different string to a matcher; a mutation spelling
    // it that way made both promoted names vanish with no problem raised.
    expect(read(fn('  if(r === "a" || r === "b") {\n    return { code: TBL[r] };\n  }'), TBL).codes)
      .toEqual(["CodeA", "CodeB"]);
    expect(read(fn('  if (r === "a") {\n    if (r === "b") {\n      return { code: TBL[r] };\n    }\n  }'), TBL).codes)
      .toEqual(["CodeB"]);
  });
});
