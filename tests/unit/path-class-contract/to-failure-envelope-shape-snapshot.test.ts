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
 * The 7 sites (cited by enclosing symbol, NOT line number — line numbers drift
 * across PRs; the @see footer lists the symbols):
 *   1-4. memory N/K bound checks — via `toFailureEnvelope` (the 4 Working/
 *        Episodic/Semantic/Procedural upper-bound checks in the query wrapper).
 *   5a.  lease validation `expired` — via `toFailureEnvelope` with a verbatim
 *        rich `tryNext` (migrated in PR-P1-2; code/tryNext from
 *        `mapLeaseValidationToTypedReason`, lease path in `makeCommitWrapper`).
 *   5b.  lease validation residual reasons (collapse to `Unknown`, empty tryNext).
 *   6.   handler throw fallback — via `toFailureEnvelope` with empty `tryNext`
 *        (migrated in PR-P1-2; handler-throw path in `makeCommitWrapper`).
 *   7.   executor_failed — DATA-level `if_unexpected` attach, pretty-printed
 *        (`desktopActRawHandler` in `desktop-register.ts`; NOT yet migrated, PR-P1-3).
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
 * P1-2 resolution: sites 5a/5b/6 are now migrated to `toFailureEnvelope` via the
 * verbatim `tryNext` override — hazard C avoided (rich hint preserved bit-equal),
 * hazard B deferred (empty tryNext preserved, zero behaviour change). This
 * snapshot stayed green through P1-2, proving the migration was shape-preserving.
 * Site 7 (hazard A) is NOT yet migrated — that is PR-P1-3.
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

/**
 * FROZEN pre-migration `try_next` content (captured 2026-05-20 from
 * `src/tools/_errors.ts` SUGGESTS). These are HARDCODED literals — NOT computed
 * via `getSuggestsForCode(...)` — so a SUGGESTS edit changes the `actual` output
 * but NOT this expectation, which surfaces the change instead of letting both
 * move together (PR #373 Codex P2: a migration safety-net expectation must be
 * decoupled from the production source it guards). If SUGGESTS legitimately
 * changes, update these literals deliberately (and note any user-facing hint
 * change in the CHANGELOG).
 */
const FROZEN_TRY_NEXT: Record<string, ReadonlyArray<{ action: string }>> = {
  WorkingMemoryNUpperBoundExceeded: [
    { action: "Reduce working:N — upper bound is WORKING_MEMORY_N_MAX (= 50, layer-constraints §5)" },
    { action: "If you need more recent events, use include=[\"episodic:N\"] for richer rich-shape projection (B-2 land 後に有効)" },
    { action: "Working memory is a compact summary of recent commits — N typically ≤ 10 is sufficient for context" },
  ],
  EpisodicMemoryNUpperBoundExceeded: [
    { action: "Reduce episodic:N — upper bound is EPISODIC_MEMORY_N_MAX (= 100, layer-constraints §5)" },
    { action: "Use include=[\"working:N\"] (compact summary) when the rich shape (lease_token / event_id / elapsed_ms) is unnecessary" },
    { action: "Episodic memory exposes the full ToolCallEvent shape — N typically ≤ 5 is sufficient for causal context recovery" },
  ],
  SemanticMemoryKUpperBoundExceeded: [
    { action: "Reduce semantic:K — upper bound is SEMANTIC_MEMORY_K_MAX (= 10)" },
    { action: "Semantic memory surfaces top-K learned UI patterns (rule-based: same windowTitle + 3+ successful commits)" },
    { action: "If you want recent commits instead of patterns, use include=[\"episodic:N\"] (rich shape) or [\"working:N\"] (compact)" },
  ],
  ProceduralMemoryKUpperBoundExceeded: [
    { action: "Reduce procedural:K — upper bound is PROCEDURAL_MEMORY_K_MAX (= 10)" },
    { action: "Procedural memory surfaces top-K successful repeated workflows (success>=3 + 0 failures + no destructive tools)" },
    { action: "Suggest candidates are limited by design — destructive macro suggest is non-goal in Phase B (consider Phase B follow-up for explicit consent UX)" },
  ],
  ExecutorFailed: [
    { action: "For action='click', fall back to mouse_click({clickAt}) using the entity rect center from desktop_discover — common when UIA InvokePattern is missing on the control" },
    { action: "For action='type' or action='setValue': desktop_act has already tried UIA setValue and background WM_CHAR (post-#327 E ladder) before reporting executor_failed. The remaining rung is keyboard({action:'type', text, method:'foreground'}) — foreground SendInput uses the OS input queue and bypasses BG injection blocks that stopped the internal ladder (Chromium hosts, WT-XAML, etc.). Focus the target window first with focus_window or mouse_click" },
    { action: "If the entity has a stable name or automationId, try click_element({name|automationId}) — uses a different UIA path than desktop_act and may succeed where this executor threw" },
    { action: "Re-run desktop_discover — the entity may have moved or been re-keyed between discover and act, in which case the executor saw a stale locator" },
  ],
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
// { viewPoisoned:false, asOfWallclockMs:null } })`.

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
          try_next: FROZEN_TRY_NEXT[code],
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
          try_next: FROZEN_TRY_NEXT[code],
        },
      });
    });
  }
});

// ── Sites 5a/5b: lease validation failure (via toFailureEnvelope, migrated P1-2) ─
//
// makeCommitWrapper Step 2 (lease validation) short-circuits BEFORE the handler
// runs. `getEnvValue: () => undefined` keeps the default raw mode;
// `include:["envelope"]` opts into the full envelope.

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
        try_next: FROZEN_TRY_NEXT.ExecutorFailed,
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
