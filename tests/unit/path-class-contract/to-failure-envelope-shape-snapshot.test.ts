/**
 * tests/unit/path-class-contract/to-failure-envelope-shape-snapshot.test.ts
 * — ADR-021 Phase 1 PR-P1-1 (Plan: desktop-touch-mcp-internal §3.2 PR-P1-1).
 *
 * SAFETY NET for the L6 (OQ-SR2-5) closure done in PR-P1-2 / PR-P1-3.
 *
 * This test FREEZES the exact current failure-envelope JSON shape emitted by
 * all 7 failure-construction sites BEFORE migrating the 3 hand-built sites
 * (5/6/7) to the central `toFailureEnvelope` converter. When PR-P1-2/P1-3
 * perform that migration, this snapshot makes every output change explicit and
 * reviewable instead of silent — the whole point of the snapshot-first order.
 *
 * The 7 sites and their current construction:
 *   1-4. memory N/K bound checks — already via `toFailureEnvelope`
 *        (`src/tools/_envelope.ts:3324/3332/3340/3348`).
 *   5a.  lease validation `expired`  — `buildFailureEnvelope` direct
 *        (`src/tools/_envelope.ts:2978`, code/tryNext from
 *        `mapLeaseValidationToTypedReason`).
 *   5b.  lease validation residual reasons (collapse to `Unknown`).
 *   6.   handler throw fallback — `buildFailureEnvelope("Unknown", [], ...)`
 *        (`src/tools/_envelope.ts:3058`).
 *   7.   executor_failed — DATA-level `if_unexpected` attach, pretty-printed
 *        (`src/tools/desktop-register.ts:594-604`).
 *
 * ── MIGRATION HAZARDS this snapshot will surface in PR-P1-2/P1-3 ──
 * (a naive swap to the CURRENT `toFailureEnvelope` is NOT bit-equal here — the
 *  decision per site is "extend converter to be lossless" vs "deliberate
 *  normalisation with CHANGELOG note"; deferred to PR-P1-2, see plan OQ).
 *
 *   (C) Site 5a `try_next` is a RICH entry `{action, args, confidence}` from
 *       `mapLeaseValidationToTypedReason`. `toFailureEnvelope` maps SUGGESTS
 *       strings to `{action}`-only, AND `getSuggestsForCode("LeaseExpired")`
 *       is `[]` → generic fallback. A naive migration would DROP the
 *       `desktop_discover` recovery hint entirely → user-facing regression.
 *   (B) Sites 5b/6 `try_next` is `[]` today; `toFailureEnvelope` substitutes
 *       the generic fallback `[{action:"Inspect..."}]` when SUGGESTS is empty
 *       → `[]` becomes 1 entry (an improvement, but a deliberate change).
 *   (A) Site 7 attaches `if_unexpected` at the DATA level + pretty-prints
 *       (`JSON.stringify(..., null, 2)`); converter-driven paths place it at
 *       the ENVELOPE level. Normalising this asymmetry is the explicit L6
 *       goal — the diff must be deliberate.
 *
 * Wallclock note: `as_of.wallclock_ms` is genuinely runtime-variable
 * (production passes `asOfWallclockMs: null` → `Date.now()` at these sites),
 * so it is pinned as `expect.any(Number)`. Every other field is bit-equal.
 *
 * @see src/tools/_envelope.ts toFailureEnvelope / buildFailureEnvelope /
 *   compatFailureRaw / makeCommitWrapper / mapLeaseValidationToTypedReason
 * @see src/tools/desktop-register.ts desktopActRawHandler /
 *   buildExecutorFailedIfUnexpected
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  toFailureEnvelope,
  makeCommitWrapper,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  type CommitL1Emitter,
} from "../../../src/tools/_envelope.js";
import { Err } from "../../../src/types/result.js";
import { CodedHandlerError } from "../../../src/errors/typed-errors.js";
import { getSuggestsForCode } from "../../../src/tools/_errors.js";
import {
  desktopActRawHandler,
  getDesktopFacade,
} from "../../../src/tools/desktop-register.js";
import type { EntityLease } from "../../../src/engine/world-graph/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse the JSON text block a tool/wrapper returns. */
function parseContent(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

/** Asymmetric wallclock matcher — see header "Wallclock note". */
const ANY_WALLCLOCK = { wallclock_ms: expect.any(Number) };

/** No-op L1 emitter so the snapshot does not touch the global L1 ring. */
const NOOP_L1: CommitL1Emitter = {
  pushStarted: () => {},
  pushCompleted: () => {},
};

beforeEach(() => {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Sites 1-4: memory N/K bound checks (already via toFailureEnvelope) ─────────
//
// Baseline for the converter's current output. These are NOT migrated in
// Phase 1 — PR-P2-0 keeps them bit-equal (plan §3.3.2). Construction is exactly
// `toFailureEnvelope(Err(new CodedHandlerError(code)), { optIn, envelopeOptions:
// { viewPoisoned:false, asOfWallclockMs:null } })` (_envelope.ts:3322-3352).

describe("PR-P1-1 sites 1-4: memory bound-check converter callsites", () => {
  const MEMORY_CODES = [
    "WorkingMemoryNUpperBoundExceeded",
    "EpisodicMemoryNUpperBoundExceeded",
    "SemanticMemoryKUpperBoundExceeded",
    "ProceduralMemoryKUpperBoundExceeded",
  ] as const;

  const envelopeOptions = { viewPoisoned: false, asOfWallclockMs: null };

  for (const code of MEMORY_CODES) {
    it(`${code} — envelope (optIn) shape frozen`, () => {
      const shape = toFailureEnvelope(Err(new CodedHandlerError(code)), {
        optIn: true,
        envelopeOptions,
      });
      expect(shape).toEqual({
        _version: "1.0",
        data: null,
        as_of: ANY_WALLCLOCK,
        confidence: "stale",
        if_unexpected: {
          most_likely_cause: code,
          try_next: getSuggestsForCode(code).map((action) => ({ action })),
        },
      });
    });

    it(`${code} — raw-compat (optIn=false) shape frozen`, () => {
      const shape = toFailureEnvelope(Err(new CodedHandlerError(code)), {
        optIn: false,
        envelopeOptions,
      });
      expect(shape).toEqual({
        ok: false,
        reason: code.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
        diff: [],
        if_unexpected: {
          most_likely_cause: code,
          try_next: getSuggestsForCode(code).map((action) => ({ action })),
        },
      });
    });
  }
});

// ── Sites 5a/5b: lease validation failure (buildFailureEnvelope direct) ────────
//
// makeCommitWrapper Step 2 short-circuits BEFORE the handler runs
// (_envelope.ts:2972-2990). `getEnvValue: () => undefined` keeps the default
// raw mode; `include:["envelope"]` opts into the full envelope.

describe("PR-P1-1 site 5a: lease validation 'expired' (RICH try_next — hazard C)", () => {
  // try_next here is the rich {action, args, confidence} entry that a naive
  // toFailureEnvelope migration would lose (getSuggestsForCode("LeaseExpired")
  // === []). Frozen so PR-P1-2 cannot drop it silently.
  const EXPECTED_TRY_NEXT = [{ action: "desktop_discover", args: {}, confidence: "high" }];

  function wrapExpired() {
    return makeCommitWrapper(
      async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      "snapshot_lease_expired",
      {
        leaseValidator: async () => ({ ok: false, reason: "expired" }),
        getEnvValue: () => undefined,
        l1Emitter: NOOP_L1,
      },
    );
  }

  it("raw-compat shape frozen", async () => {
    const result = await wrapExpired()({} as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      ok: false,
      reason: "lease_expired",
      diff: [],
      if_unexpected: { most_likely_cause: "LeaseExpired", try_next: EXPECTED_TRY_NEXT },
    });
  });

  it("envelope (optIn) shape frozen", async () => {
    const result = await wrapExpired()({ include: ["envelope"] } as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      _version: "1.0",
      data: null,
      as_of: ANY_WALLCLOCK,
      confidence: "stale",
      if_unexpected: { most_likely_cause: "LeaseExpired", try_next: EXPECTED_TRY_NEXT },
    });
  });
});

describe("PR-P1-1 site 5b: lease validation residual reasons (empty try_next — hazard B)", () => {
  // generation_mismatch / entity_not_found / digest_mismatch all collapse to
  // Unknown with try_next: [] in S4 trunk (mapLeaseValidationToTypedReason).
  const RESIDUAL_REASONS = ["generation_mismatch", "entity_not_found", "digest_mismatch"] as const;

  for (const reason of RESIDUAL_REASONS) {
    function wrapResidual() {
      return makeCommitWrapper(
        async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
        "snapshot_lease_residual",
        {
          leaseValidator: async () => ({ ok: false, reason }),
          getEnvValue: () => undefined,
          l1Emitter: NOOP_L1,
        },
      );
    }

    it(`${reason} → raw-compat Unknown + empty try_next frozen`, async () => {
      const result = await wrapResidual()({} as Record<string, unknown>);
      expect(parseContent(result.content)).toEqual({
        ok: false,
        reason: "unknown",
        diff: [],
        if_unexpected: { most_likely_cause: "Unknown", try_next: [] },
      });
    });
  }
});

// ── Site 6: handler throw fallback (buildFailureEnvelope("Unknown", [], ...)) ──

describe("PR-P1-1 site 6: handler throw fallback (empty try_next — hazard B)", () => {
  function wrapThrowing() {
    return makeCommitWrapper(
      async () => {
        throw new Error("snapshot-induced handler throw");
      },
      "snapshot_handler_throw",
      { getEnvValue: () => undefined, l1Emitter: NOOP_L1, getSessionId: () => "snapshot" },
    );
  }

  it("raw-compat shape frozen", async () => {
    const result = await wrapThrowing()({} as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      ok: false,
      reason: "unknown",
      diff: [],
      if_unexpected: { most_likely_cause: "Unknown", try_next: [] },
    });
  });

  it("envelope (optIn) shape frozen", async () => {
    const result = await wrapThrowing()({ include: ["envelope"] } as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      _version: "1.0",
      data: null,
      as_of: ANY_WALLCLOCK,
      confidence: "stale",
      if_unexpected: { most_likely_cause: "Unknown", try_next: [] },
    });
  });
});

// ── Site 7: executor_failed (DATA-level if_unexpected, pretty-print — hazard A) ─

describe("PR-P1-1 site 7: desktopActRawHandler executor_failed (DATA-level — hazard A)", () => {
  const fakeLease: EntityLease = {
    entityId: "e1",
    viewId: "v1",
    targetGeneration: "g1",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    evidenceDigest: "d1",
  };

  it("if_unexpected attached at DATA level (sibling of ok/reason/diff) frozen", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({ ok: false, reason: "executor_failed", diff: [] });

    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });

    // Current shape: the TouchResult is spread at the top level and
    // if_unexpected sits ALONGSIDE ok/reason/diff (NOT under an envelope
    // `if_unexpected`, NOT with `_version`/`data`/`as_of`). PR-P1-3 normalises
    // this through toFailureEnvelope — this freeze makes that diff explicit.
    expect(parseContent(result.content)).toEqual({
      ok: false,
      reason: "executor_failed",
      diff: [],
      if_unexpected: {
        most_likely_cause: "ExecutorFailed",
        try_next: getSuggestsForCode("ExecutorFailed").map((action) => ({ action })),
      },
    });
  });

  it("serialises pretty-printed (2-space indent) — current format pin", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({ ok: false, reason: "executor_failed", diff: [] });

    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
    const text = (result.content[0] as { text: string }).text;
    // Pretty-print is the current serialisation (null, 2). Sites 5/6 emit
    // compact JSON; PR-P1-3 normalisation would unify these.
    expect(text).toContain('\n  "ok": false');
  });
});
