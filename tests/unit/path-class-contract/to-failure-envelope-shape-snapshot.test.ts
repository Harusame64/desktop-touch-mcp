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
 *   5b.  the two lease mismatches — each under its own name with real advice since
 *        internal#125 (2026-09-18); until then both collapsed to `Unknown` with an empty
 *        tryNext, which a caller could not tell apart from a thrown handler (site 6).
 *   6.   handler throw fallback — via `toFailureEnvelope` with empty `tryNext`
 *        (migrated in PR-P1-2; handler-throw path in `makeCommitWrapper`).
 *   7.   executor_failed — via `toFailureEnvelope` raw projection (migrated in
 *        PR-P1-3, bit-equal; `desktopActRawHandler` in `desktop-register.ts`).
 *        `if_unexpected` still serialises at the DATA level (see hazard A).
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
 *   (A) Site 7's `if_unexpected` serialises at the DATA level (sibling of
 *       ok/reason/diff), so in `include=["envelope"]` mode it surfaces at
 *       `envelope.data.if_unexpected`, not `envelope.if_unexpected` like the
 *       wrapper-driven failure paths. P1-3 unified the *construction* through
 *       `toFailureEnvelope` (bit-equal), but the data→envelope *placement*
 *       requires the wrapper to treat a handler-returned `ok:false` as a
 *       failure — that is the Phase 5 TOOL_REGISTRY Result change (§2.2
 *       deferred), NOT done here.
 *
 * P1-2/P1-3 resolution: all 3 hand-built sites (5a/5b/6 in P1-2, 7 in P1-3) now
 * route their failure construction through `toFailureEnvelope` — bit-equal, so
 * this snapshot stayed green throughout (proving each migration was shape-
 * preserving). Hazard C avoided (rich `tryNext` passed verbatim), hazard B
 * deferred (empty `tryNext` preserved, zero behaviour change), hazard A's
 * envelope-mode placement deferred to Phase 5 (see above).
 *
 * Wallclock note: `as_of.wallclock_ms` is genuinely runtime-variable
 * (production passes `asOfWallclockMs: null` → `Date.now()` at these sites),
 * so it is pinned as `expect.any(Number)`. Every other field is bit-equal.
 *
 * @see src/tools/_envelope.ts toFailureEnvelope / buildFailureEnvelope /
 *   compatFailureRaw / makeCommitWrapper / mapLeaseValidationToTypedReason
 * @see src/tools/desktop-register.ts desktopActRawHandler (executor_failed via
 *   toFailureEnvelope, ADR-021 P1-3)
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
import {
  captureAdviceConfiguration,
  resetAdviceConfiguration,
  renderAdviceForCaller,
  ADVICE_WITHHELD_FLOOR,
} from "../../../src/tools/_advice-capability.js";
import { getSuggestsForCode } from "../../../src/tools/_errors.js";
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
 *
 * **They are the V2-CORNER rendering, and the corner is now pinned in `beforeEach`.**
 * ADR-036 stage 2 B2c made these lines carry `{tool:<capability>}` in the dictionary
 * and resolve at the presenter, so `desktop_discover` here is one corner's answer, not
 * a constant. Left unpinned they passed only while the ambient environment had no kill
 * switch and nothing in the module graph had captured a configuration — a latent
 * dependency the same round removed from `desktop-act-commit-wrapper.test.ts` and left
 * in this file (gate 2 on `7fda7f7`, 2026-09-13). The decoupling above is unchanged:
 * the literals are still literals, so a SUGGESTS edit still surfaces here.
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
  // The frozen tables above are one corner's rendering — say which, rather than
  // inheriting it from the runner. See the note on `FROZEN_TRY_NEXT`.
  captureAdviceConfiguration({ v2: true, credentialStore: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAdviceConfiguration();
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

describe("PR-P1-1 site 5b: the two lease mismatches, each under its own name (internal#125)", () => {
  // **This site used to freeze the defect.** generation_mismatch / digest_mismatch collapsed to
  // Unknown with `try_next: []` in S4 trunk, and the frozen shape below said so — which meant the
  // snapshot agreed with itself while a caller could not tell those two apart, nor tell either of
  // them from a THROWN handler (one byte string for three causes, measured: internal `6bdcdce` /
  // `4f1a8a4`). entity_not_found left this list in ADR-036 item 16 — site 5c; these two leave it
  // now. The freeze is kept, pointed at the shape the caller should receive.
  const RESIDUAL_REASONS = ["generation_mismatch", "digest_mismatch"] as const;
  const EXPECTED = {
    generation_mismatch: { reason: "lease_generation_mismatch", cause: "LeaseGenerationMismatch" },
    digest_mismatch: { reason: "lease_digest_mismatch", cause: "LeaseDigestMismatch" },
  } as const;

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

    it(`${reason} → raw-compat ${EXPECTED[reason].cause} + non-empty try_next frozen`, async () => {
      const result = await wrapResidual()({} as Record<string, unknown>);
      const parsed = parseContent(result.content) as {
        ok: boolean; reason: string; diff: unknown[];
        if_unexpected: { most_likely_cause: string; try_next: { action: string }[] };
      };
      // **The KEY SET is frozen too.** Dropping the whole-object `toEqual` to stop freezing advice
      // prose also dropped "and nothing else is at the top level", which site 5a still holds for
      // `LeaseExpired` (Opus review Round 1, 2026-09-18). A new top-level field is a shape change
      // and this file is where a shape change is supposed to be noticed.
      expect(Object.keys(parsed).sort()).toEqual(["diff", "if_unexpected", "ok", "reason"]);
      expect(Object.keys(parsed.if_unexpected).sort()).toEqual(["most_likely_cause", "try_next"]);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe(EXPECTED[reason].reason);
      expect(parsed.diff).toEqual([]);
      expect(parsed.if_unexpected.most_likely_cause).toBe(EXPECTED[reason].cause);
      // **The ARRIVAL is frozen, not the sentences.** Freezing the prose makes a wording change look
      // like a contract change, and this file exists to catch the shape moving. What must not
      // regress is that real advice arrives — which is three facts, not one: the key is present, it
      // is not empty, and it is not the WITHHELD FLOOR. The floor satisfies "non-empty", so a cell
      // that stops at `length > 0` passes on a configuration where every sentence was dropped
      // (Opus review Round 1, 2026-09-18).
      expect(parsed.if_unexpected.try_next.length).toBe(getSuggestsForCode(EXPECTED[reason].cause).length);
      expect(parsed.if_unexpected.try_next.every((row) => typeof row.action === "string")).toBe(true);
      expect(parsed.if_unexpected.try_next.map((row) => row.action)).not.toContain(ADVICE_WITHHELD_FLOOR);
    });
  }
});

describe("PR-P1-1 site 5c: lease validation 'entity_not_found' (ADR-036 item 16)", () => {
  // Promoted out of 5b. The touch returns the same reason and desktop_act rebuilds it as
  // EntityNotFound with the advice table's lines, so this path answers with the same lines.
  it("raw-compat shape frozen", async () => {
    const { getSuggestsForCode } = await import("../../../src/tools/_errors.js");
    const result = await makeCommitWrapper(
      async () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      "snapshot_lease_entity_not_found",
      {
        leaseValidator: async () => ({ ok: false, reason: "entity_not_found" }),
        getEnvValue: () => undefined,
        l1Emitter: NOOP_L1,
      },
    )({} as Record<string, unknown>);
    // RESOLVED, because that is the wire. The SSOT accessor is still the source — a
    // dictionary edit still moves this expectation with it — but as of ADR-036 stage 2
    // B2c the dictionary holds `{tool:<capability>}` and the envelope holds the name
    // this server registered. Comparing the wire to the raw dictionary would pin a
    // shape no caller receives.
    const { renderAdviceForCaller } = await import("../../../src/tools/_advice-capability.js");
    const raw = getSuggestsForCode("EntityNotFound");
    const tryNext = renderAdviceForCaller(raw).map((action) => ({ action }));
    expect(tryNext.length).toBeGreaterThan(0);
    // The round's claim, in the cell: a placeholder in the dictionary, none on the wire.
    expect(raw.join(" ")).toContain("{tool:");
    expect(tryNext.map((t) => t.action).join(" ")).not.toContain("{tool:");
    expect(parseContent(result.content)).toEqual({
      ok: false,
      reason: "entity_not_found",
      diff: [],
      if_unexpected: { most_likely_cause: "EntityNotFound", try_next: tryNext },
    });
  });
});

// ── Site 6: handler throw fallback (buildFailureEnvelope("Unknown", …) — hazard B DONE) ──

describe("PR-P1-1 site 6: handler throw fallback (a next step at last — internal #121)", () => {
  // **THE SAME TREATMENT SITE 5b GOT, one site over.** This block used to freeze `try_next: []`,
  // and the freeze agreed with itself while the one response a caller cannot interpret was also
  // the only one offering no next step (#121 §1). The empty list was never a finding — ADR-021's
  // plan installed it to keep the converter migration bit-equal and named the follow-up in the
  // same line (hazard B: "handler crash に generic hint を付ける改善は deliberate な follow-up に
  // 分離"). internal #121 is that follow-up.
  //
  // The freeze is KEPT and pointed at the shape the caller should receive: `try_next` is now
  // whatever `SUGGESTS.Unknown` renders to in this configuration, because the site stopped
  // describing its own answer and started reading the table.
  //
  // **THE FREEZE IS A LITERAL, per this file's own rule** (header, `FROZEN_TRY_NEXT`): a
  // safety-net expectation computed from the thing it guards is a cell that cannot fail — empty
  // the dictionary and both sides go empty together, green. The first draft of this block did
  // exactly that, comparing against `getSuggestsForCode("Unknown")`, and it would have passed
  // through the mutation that deletes the entry. The strings below are the V2-CORNER rendering
  // (the corner is pinned in `beforeEach`), so `{tool:reidentify_element}` appears here already
  // resolved to `desktop_discover` — the same treatment the rest of this file's literals get.
  //
  // The corner-by-corner survival of the two placeholder-free lines, and the retry this advice
  // must not invite, are in `adr-036-a-thrown-handler-says-what-to-do-next.test.ts`.
  const SITE6_ADVICE: ReadonlyArray<{ action: string }> = [
    { action: "The tool's handler threw before any road could name a cause. This is not a refusal the tool decided, so it does NOT say the act was skipped — the act may have taken effect before the throw." },
    { action: "Observe the target again before acting, and do not repeat this call as a retry until you have: a throw can land after the side effect, so a blind repeat can apply it twice." },
    { action: "For a native desktop target, take the view again with desktop_discover — the identifiers you were holding belong to the view that just failed." },
    { action: "For a browser target, re-read the page with browser_overview or browser_search — a DOM node is not in the UIA tree, so the desktop instrument above cannot see it." },
    { action: "For a terminal target, read the pane back with terminal(action='read') before sending anything again." },
    { action: "If it repeats, report it rather than working around it: every road this product designed answers under its own name, so 'Unknown' means one was missed." },
  ];

  function wrapThrowing() {
    return makeCommitWrapper(
      async () => {
        throw new Error("snapshot-induced handler throw");
      },
      "snapshot_handler_throw",
      { getEnvValue: () => undefined, l1Emitter: NOOP_L1, getSessionId: () => "snapshot" },
    );
  }

  it("raw-compat shape frozen — the compat projection did not move, only try_next filled", async () => {
    const result = await wrapThrowing()({} as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      ok: false,
      reason: "unknown",
      diff: [],
      if_unexpected: { most_likely_cause: "Unknown", try_next: SITE6_ADVICE },
    });
  });

  it("envelope (optIn) shape frozen", async () => {
    const result = await wrapThrowing()({ include: ["envelope"] } as Record<string, unknown>);
    expect(parseContent(result.content)).toEqual({
      _version: "1.0",
      data: null,
      as_of: ANY_WALLCLOCK,
      confidence: "stale",
      if_unexpected: { most_likely_cause: "Unknown", try_next: SITE6_ADVICE },
    });
  });

  it("the site READS the dictionary — the literal above is a freeze, not a second source", async () => {
    // The pair the literal needs. Frozen literals catch a drifting producer; they also go stale
    // silently, and a stale freeze that nobody notices is how this very block spent months
    // agreeing that the caller gets nothing. This cell says the two are the same thing today, so
    // a dictionary edit lands as a RED freeze above rather than as two records disagreeing.
    expect(SITE6_ADVICE.map((row) => row.action)).toEqual(
      renderAdviceForCaller(getSuggestsForCode("Unknown")),
    );
    // And that the reading is real: the placeholder was resolved on the way out, not shipped raw.
    expect(SITE6_ADVICE.some((row) => row.action.includes("{tool:"))).toBe(false);
    expect(getSuggestsForCode("Unknown").some((line) => line.includes("{tool:"))).toBe(true);
  });

  it("ships real advice, not the floor and not nothing", async () => {
    // The control a shape freeze cannot be. `ADVICE_WITHHELD_FLOOR` is what a wholly-dropped list
    // ships instead of `[]`, so its presence here would mean this code has no recovery THIS
    // configuration can offer — true of some codes, and not of this one, whose first two lines
    // carry no placeholder at all and therefore survive every corner.
    const result = await wrapThrowing()({} as Record<string, unknown>);
    const parsed = parseContent(result.content) as {
      if_unexpected: { try_next: { action: string }[] };
    };
    expect(parsed.if_unexpected.try_next.length).toBeGreaterThanOrEqual(4);
    expect(parsed.if_unexpected.try_next.map((row) => row.action)).not.toContain(
      ADVICE_WITHHELD_FLOOR,
    );
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

  // ADR-036 item 13 — THE SEAM THIS ITEM IS ABOUT, end to end. The nine act-path refusals are
  // rebuilt here from the reason code, and the engine's sentence used to stop at the loop: measured
  // on the real machine (win2, 2026-09-10) as an `aim_occluded` response carrying neither the
  // blocker's title nor its handle, with no message field anywhere in it.
  //
  // Pinned at the HANDLER, not at `toFailureEnvelope`, because that is where the loss happened: the
  // first version of this change was covered only by cells that called the converter directly and
  // by cells that stopped inside the loop, so deleting `detail: result.detail` from all nine sites
  // left every one of them green (gate 2, Opus sandbox review, 2026-09-10). This one goes through
  // `desktopActRawHandler` in the mode `desktop_act` actually uses.
  it("carries the refusal's own sentence to the caller, in the shape desktop_act returns", async () => {
    const facade = getDesktopFacade();
    const detail = 'Refusing to press (426, 287) for the window this act named (hwnd 4919): the window on top at that point is "BLOCKER-CELL" (hwnd 777).';
    vi.spyOn(facade, "touch").mockResolvedValue({ ok: false, reason: "aim_occluded", diff: [], detail });

    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
    const parsed = parseContent(result.content) as { if_unexpected: { detail?: string; most_likely_cause: string } };

    expect(parsed.if_unexpected.detail).toBe(detail);
    expect(parsed.if_unexpected.most_likely_cause).toBe("AimOccluded");
  });

  it("leaves the field out when the refusal had nothing of its own to say", async () => {
    // A silence and an answer must not share a representation: `detail: ""` would read as "the
    // engine had nothing to say", and a missing field says "there was no sentence".
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({ ok: false, reason: "aim_occluded", diff: [] });

    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
    const parsed = parseContent(result.content) as { if_unexpected: Record<string, unknown> };

    expect("detail" in parsed.if_unexpected).toBe(false);
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

  // ADR-029 Phase 1: the unreachable-coordinate refusal carries its own cause and
  // try_next. Pinned here because reusing ExecutorFailed's advice ("fall back to
  // mouse_click") would send the caller back into the guard that just refused.
  it("coordinate_outside_reachable_bounds gets its own cause and try_next", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({
      ok: false,
      reason: "coordinate_outside_reachable_bounds",
      diff: [],
    });

    const parsed = parseContent(
      (await desktopActRawHandler({ lease: fakeLease, action: "click" })).content
    ) as {
      ok: boolean;
      reason: string;
      if_unexpected: { most_likely_cause: string; try_next: Array<{ action: string }> };
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("coordinate_outside_reachable_bounds");
    expect(parsed.if_unexpected.most_likely_cause).toBe("CoordinateOutsideReachableBounds");
    expect(parsed.if_unexpected.try_next.length).toBeGreaterThan(0);
    // The advice must not steer back into the same guard.
    const actions = parsed.if_unexpected.try_next.map((t) => t.action).join(" ");
    expect(actions).toMatch(/primary monitor/i);
  });
});
