/**
 * _envelope.ts — Server SSOT envelope shape + compat hoist + L5 wrapper helper.
 *
 * Walking skeleton S3 (ADR-010 P1) implementation per sub-plan
 * `docs/adr-010-p1-s3-plan.md` (merged in PR #110).
 *
 * # 設計 (Round 2 SSOT 準拠、統合書 §11.2 + ADR-010 §2.1 #1)
 *
 * Server is **always envelope-first**: the tool handler's raw result
 * is always wrapped in envelope shape via `buildEnvelope()` with
 * `_version` + `as_of` + `confidence` self-attestation. **Compat mode
 * is post-assembly flatten** (`compatHoist`): when the caller does
 * NOT opt into envelope shape (= existing LLM clients expecting raw
 * shape), the `data` field is hoisted to top level and the envelope
 * wrapper is discarded. That way `confidence: degraded` monitoring +
 * `as_of` provenance + size SLO measurement all work for default
 * raw-shape clients too.
 *
 * # API Surface
 *
 *   - `EnvelopeMinimalShape<T>`         — server SSOT envelope shape
 *   - `EnvelopeOptions`                 — viewPoisoned + asOfWallclockMs (caller-supplied)
 *   - `buildEnvelope<T>(data, opts)`    — assemble envelope (always called)
 *   - `compatHoist<T>(envelope, optIn)` — post-flatten or pass-through
 *   - `resolveEnvelopeOptIn(include, env)` — pure priority chain
 *   - `makeEnvelopeAware(handler, name)` — L5 wrapper helper for MCP server
 *   - `envelopePayloadSizeBytes(payload)` — JSON.stringify().length
 *   - `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES = 1024` — confidence
 *     downgrade trigger (ADR-010 §5.6.1, baseline measured S3-3)
 *
 * # `as_of.wallclock_ms` source (Round 1 P1-4 反映、L1 event wallclock)
 *
 * Per ADR-010 §5 + §4.1 Provenance, `as_of.wallclock_ms` MUST be the
 * L1 event wallclock (so `freshness_ms = now - as_of.wallclock_ms`
 * has correct semantic). Caller supplies via `options.asOfWallclockMs`
 * (read from `viewGetFocusedWithWallclock()` napi binding added in
 * S3-2). Falls back to `Date.now()` only when no event has been
 * observed yet (initial spawn, view-poisoned). `confidence: degraded`
 * is forced in fallback paths so LLM clients can detect the
 * approximation.
 *
 * # `include` arg routing (Round 1 P1-3 反映、ADR-010 §1.5)
 *
 * The `include` arg is NOT added to individual tool source files'
 * Zod schemas. Instead, `withEnvelopeIncludeSchema(baseShape)` injects
 * an `include?: string[]` field into the schema **at registration time**,
 * and `makeEnvelopeAware` peeks `args.include` at the wrapper layer and
 * strips it before invoking the handler.
 *
 * **Why injection is required** (PR #112 Round 1 P1, Codex + user
 * review): MCP SDK's `server.tool(name, schema, handler)` runs Zod
 * `.parse()` BEFORE invoking the registered handler. Zod's default
 * object parsing **strips unknown keys**, so without injection
 * `include` would be removed from `args` before `makeEnvelopeAware`
 * could peek it. The wrapper's per-call opt-in path (`include:["envelope"]`
 * / `include:["raw"]`) only works if `include` survives the schema
 * parse step.
 *
 * Tool source files still don't declare `include` themselves — the
 * registration site calls `withEnvelopeIncludeSchema(baseShape)` to
 * produce the registration-time schema, keeping ADR-010 §1.5 spirit:
 * tool implementations stay envelope-agnostic, the L5 wrapper helper
 * owns both schema injection and runtime peek+strip.
 *
 * S4 commit-axis wrapper extends this pattern (sub-plan §2.1) by
 * composing `makeCommitWrapper` / `makeQueryWrapper` on top of
 * `makeEnvelopeAware` + `withEnvelopeIncludeSchema`.
 *
 * # S4 commit / query wrapper layer (ADR-010 P1 S4)
 *
 * `makeCommitWrapper` wraps a side-effecting tool handler (e.g.
 * `desktop_act`) with the 7-step flow defined in sub-plan
 * `docs/adr-010-p1-s4-plan.md` §2.1:
 *
 *   1. peek + strip `args.include` (S3 inherit)
 *   2. lease 4-tuple validation via caller-supplied `leaseValidator`
 *      (`LeaseStore.validate()` reason → ADR-010 §5.4 typed enum); on
 *      failure return a `confidence: "stale"` envelope with
 *      `if_unexpected.most_likely_cause` + `try_next` and skip handler
 *   3. tool_call_id seq採番 (per-session monotone counter, format
 *      `${sessionId}:${seq}`; cross-server-restart uniqueness deferred
 *      to OQ #1 / ADR-011)
 *   4. `l1PushToolCallStarted({ tool, args_json: <truncated summary>,
 *      lease_token? })` — value passed via `args_json` field is the
 *      ~512-byte truncate of `JSON.stringify(args)` (sub-plan §2.6);
 *      field name unchanged for npm public type signature compat
 *      (Round 2 P1-2)
 *   5. invoke handler (raw side effect)
 *   6. `l1PushToolCallCompleted({ tool, elapsed_ms, ok, error_code? })`
 *      — handler throw routes through this with `ok: false`
 *   7. `buildEnvelope` (S3 inherit) + `compatHoist` (S3 inherit)
 *
 * `makeQueryWrapper` is a thin wrapper that reuses `makeEnvelopeAware`
 * (no lease validation, no ToolCall events) but offers a stable name
 * for query-axis registration sites and a future expansion seam (e.g.
 * lease-issue tracking that doesn't fit ToolCall semantics).
 *
 * `EnvelopeMinimalShape.confidence` is bumped to a 3-value union
 * (`fresh | degraded | stale`) so `data: null` failure envelopes can
 * carry `confidence: "stale"` (ADR-010 §5.3, sub-plan §2.4). The S3
 * 2-value contract tests still pass: `stale` is only emitted from the
 * commit-failure path (`buildFailureEnvelope`); `buildEnvelope` itself
 * still emits only `fresh | degraded`.
 */

import { z, type ZodArray, type ZodOptional, type ZodString, type ZodTypeAny } from "zod";

import type { LeaseValidationResult } from "../engine/world-graph/types.js";
import { nativeL1 } from "../engine/native-engine.js";
import type { NativeLeaseTokenSummary } from "../engine/native-types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Server SSOT envelope shape (ADR-010 §5、`_version: "1.0"` for P1).
 *
 * Constructed by `buildEnvelope`, optionally hoisted to raw shape by
 * `compatHoist` when caller does not opt into envelope.
 */
export interface EnvelopeMinimalShape<T = unknown> {
  /** Schema version (ADR-010 §5、currently "1.0" for P1). */
  _version: "1.0";
  /** Tool-specific result the handler computed. */
  data: T;
  /**
   * Self-attestation: when the data was observed.
   *
   * **`wallclock_ms` is the L1 event wallclock** (ADR-010 §5 +
   * §4.1 Provenance: `freshness_ms = now - as_of.wallclock_ms`),
   * NOT server-side `Date.now()`. Falls back to `Date.now()` only
   * when no view event has been observed yet (initial spawn,
   * pipeline poisoned). The source distinction is permanent:
   * switching source post-P1 reverses `freshness_ms` semantic and
   * breaks LLM clients (CLAUDE.md §3.2 PR #102 P5c-2 教訓 同型).
   */
  as_of: { wallclock_ms: number };
  /**
   * Confidence: `fresh` (default) / `degraded` (size-over OR
   * view-poisoned OR Date.now() fallback) / `stale` (S4 trunk:
   * commit-failure envelope per ADR-010 §5.3, set only by
   * `buildFailureEnvelope`). S3 trunk shipped 2 values; `cached` /
   * `inferred` are still expansion (ADR-010 §17.6.1 値域 SSOT).
   * `buildEnvelope` itself still emits only `fresh | degraded`, so
   * S3 G3-7-style `expect(...).toEqual("fresh")` pins survive.
   */
  confidence: "fresh" | "degraded" | "stale";
  /** Failure-only recovery hint (ADR-010 §5.3, sub-plan §2.4). Set by
   * `buildFailureEnvelope` on commit-axis failure paths; absent on
   * successful envelopes from `buildEnvelope`. */
  if_unexpected?: IfUnexpectedShape;
}

/**
 * Self-attesting failure hint for the LLM client (ADR-010 §5.3 +
 * sub-plan §2.4). Present only on commit-failure envelopes built by
 * `buildFailureEnvelope`. Successful envelopes from `buildEnvelope`
 * never set this field.
 *
 * `most_likely_cause` is a typed-enum code (PascalCase) drawn from
 * ADR-010 §5.4. S4 trunk wires `LeaseExpired` end-to-end (sub-plan
 * §1.1 F); the other lease-direct codes (`LeaseGenerationMismatch` /
 * `EntityNotFound` / `LeaseDigestMismatch`) are name-pinned in
 * `LEASE_REASON_TO_TYPED_CODE` for expansion mechanical-copy work,
 * but the runtime path for them collapses to `"Unknown"` (sub-plan
 * §7 R4).
 */
export interface IfUnexpectedShape {
  most_likely_cause: string;
  try_next: TryNextAction[];
}

/**
 * Recovery hint for the LLM client (ADR-010 §5.3 + sub-plan §2.4).
 * Mirrors ADR-010 P2 work where `_errors.ts::SUGGESTS` strings get
 * typed; S4 trunk emits one `desktop_discover` action for the
 * `LeaseExpired` path only — residual codes emit an empty list.
 */
export interface TryNextAction {
  action: string;
  args?: Record<string, unknown>;
  confidence?: "high" | "medium" | "low";
}

export interface EnvelopeOptions {
  /**
   * Pre-computed view-poisoned signal (caller passes
   * `await viewFocusedPipelineStatus()` result so we don't re-call
   * per envelope). When omitted, treated as non-poisoned.
   */
  viewPoisoned?: boolean;
  /**
   * L1 event wallclock from view (caller reads via napi getter
   * `viewGetFocusedWithWallclock` added in S3-2). When `null` /
   * `undefined`, falls back to `Date.now()` and forces
   * `confidence: "degraded"` so LLM clients can detect the
   * approximation.
   */
  asOfWallclockMs?: number | null;
}

// ─── Schema injection helper (PR #112 Round 1 P1 fix) ─────────────────────────

/**
 * Inject the wrapper-layer `include?: string[]` field into a tool's
 * raw Zod shape so MCP SDK's `server.tool()` parse step preserves
 * `args.include` for `makeEnvelopeAware` to peek (per-call envelope
 * opt-in / raw override path).
 *
 * **Why this is needed** (PR #112 Round 1 P1): without injection, the
 * MCP SDK runs Zod `.parse()` on the registration schema before the
 * handler is invoked. Zod object parsing strips unknown keys by default,
 * so `include:["envelope"]` would be silently dropped before
 * `makeEnvelopeAware` could peek it — only the env-var path
 * (`DESKTOP_TOUCH_ENVELOPE=1`) would work.
 *
 * Generic over the input shape so the tool's existing field types
 * (Zod schema fragments) are preserved. Returns a new object with the
 * `include` field appended; does not mutate the caller's shape.
 *
 * Usage at registration site (per ADR-010 §1.5 spirit — tool source
 * files don't need to declare `include` themselves):
 *
 * ```ts
 * server.tool(
 *   "desktop_state",
 *   description,
 *   withEnvelopeIncludeSchema(desktopStateSchema),  // adds include
 *   makeEnvelopeAware(handler, "desktop_state", { fetchMeta }),
 * );
 * ```
 *
 * The injected shape: `include: z.array(z.string()).optional()`.
 * `["envelope"]` / `["raw"]` are recognised by `resolveEnvelopeOptIn`;
 * unknown values are ignored (priority chain falls through to env / default).
 */
export function withEnvelopeIncludeSchema<T extends Record<string, ZodTypeAny>>(
  baseShape: T,
): T & { include: ZodOptional<ZodArray<ZodString>> } {
  return {
    ...baseShape,
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Optional response-shape opt-in. " +
        "`['envelope']` returns the self-documenting envelope " +
        "(`_version` / `data` / `as_of` / `confidence`). " +
        "`['raw']` forces raw shape (overrides DESKTOP_TOUCH_ENVELOPE=1 server default). " +
        "Default behaviour is raw shape (compat with existing clients).",
      ),
  } as T & { include: ZodOptional<ZodArray<ZodString>> };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimal-envelope size threshold (ADR-010 §5.6.1: `< 1KB` for P1).
 * Exceeding this triggers `confidence: degraded` downgrade.
 *
 * Initial value 1024; baseline measured in S3-3 sub-batch via
 * `bench:envelope-size`. If `desktop_state` minimal envelope routinely
 * exceeds this, sub-plan §2.6 + ADR-010 §5.6.1 will be bit-equal
 * synced to a higher value (2048 / 4096 candidates).
 */
export const ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES = 1024;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the envelope opt-in priority chain. Pure function over
 * `(include, envValue)` so test fixtures can pin both modes
 * deterministically without mutating process env.
 *
 * Priority (highest to lowest):
 *   1. `include = ["raw"]`      → false (per-call explicit raw, overrides env)
 *   2. `include = ["envelope"]` → true  (per-call explicit envelope)
 *   3. envValue = "1"           → true  (server-wide default to envelope)
 *   4. (default)                → false (raw shape, compat mode)
 */
export function resolveEnvelopeOptIn(
  include: string[] | undefined,
  envValue: string | undefined,
): boolean {
  if (include) {
    if (include.includes("raw")) return false; // explicit raw wins
    if (include.includes("envelope")) return true;
  }
  return envValue === "1";
}

/**
 * Compute estimated **UTF-8 byte size** of an envelope (or raw shape).
 *
 * Used by the size SLO bench harness + the `confidence: degraded`
 * downgrade trigger when envelope size exceeds the per-Phase threshold.
 *
 * **Why bytes, not `JSON.stringify(...).length`** (PR #112 Round 1 P2-A,
 * Codex review): JS string `.length` returns the count of UTF-16 code
 * units, not UTF-8 bytes. Non-ASCII window titles / labels (common in
 * this project — Japanese / Chinese / Korean UI) take 1 UTF-16 code
 * unit per BMP character but 3 UTF-8 bytes; UTF-16 surrogate pairs
 * (emoji, supplementary plane) take 2 code units but 4 UTF-8 bytes.
 * The 1024-byte SLO is stated in bytes (ADR-010 §5.6.1), so the gate
 * must measure bytes via `Buffer.byteLength(s, "utf8")`.
 */
export function envelopePayloadSizeBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    // Circular ref or BigInt: defensive 0 (caller treats as non-degraded
    // since size-based degradation is best-effort).
    return 0;
  }
}

// ─── buildEnvelope: server SSOT assembly (always called) ──────────────────────

/**
 * Build the server-side envelope SSOT shape for a tool's raw result.
 *
 * Always called; compat mode (= post-assembly flatten) is applied by
 * `compatHoist` below, NOT by skipping envelope assembly.
 *
 * `confidence` is `"fresh"` by default; downgraded to `"degraded"` when:
 *   - `options.viewPoisoned === true`, OR
 *   - `options.asOfWallclockMs` is null/undefined (Date.now() fallback), OR
 *   - estimated payload size > `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES`.
 */
export function buildEnvelope<T>(
  data: T,
  options?: EnvelopeOptions,
): EnvelopeMinimalShape<T> {
  const viewPoisoned = options?.viewPoisoned === true;
  const wallclockSupplied =
    options?.asOfWallclockMs != null && Number.isFinite(options.asOfWallclockMs);
  const wallclock = wallclockSupplied ? (options!.asOfWallclockMs as number) : Date.now();

  // Provisional envelope to estimate size for the degradation check.
  const provisional: EnvelopeMinimalShape<T> = {
    _version: "1.0",
    data,
    as_of: { wallclock_ms: wallclock },
    confidence: "fresh",
  };

  let confidence: "fresh" | "degraded" = "fresh";
  if (viewPoisoned || !wallclockSupplied) {
    confidence = "degraded";
  } else if (envelopePayloadSizeBytes(provisional) > ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES) {
    confidence = "degraded";
  }

  return { ...provisional, confidence };
}

// ─── compatHoist: post-assembly flatten or pass-through ───────────────────────

/**
 * Compat mode: hoist `data` field to top-level when caller expects
 * raw shape (default behaviour for existing LLM clients).
 *
 * Returns:
 *   - `envelope.data` (raw shape, top-level hoist) when `optInEnvelope=false`
 *   - `envelope` unchanged (envelope shape) when `optInEnvelope=true`
 */
export function compatHoist<T>(
  envelope: EnvelopeMinimalShape<T>,
  optInEnvelope: boolean,
): T | EnvelopeMinimalShape<T> {
  return optInEnvelope ? envelope : envelope.data;
}

// ─── makeEnvelopeAware: L5 wrapper helper for MCP server registration ─────────

/**
 * MCP-shape `ToolResult` (the protocol shape every tool handler
 * returns). Redefined here (rather than imported from `./_types.js`)
 * to keep this wrapper module self-contained — `_envelope.ts` is the
 * generic L5 helper, callers cast their `ToolResult`-typed handlers
 * to this loose shape at the registration site.
 *
 * Note we only use `content[0]` of type `"text"` — non-text blocks
 * are passed through unchanged (defensive for handlers that return
 * mixed shapes).
 *
 * **Exported** (PR #112 Round 1 follow-up) so `desktop-state.ts` can
 * declare `desktopStateRegistrationHandler` with a name TypeScript can
 * emit in its `.d.ts` — without the export, `tsc` raises TS4023
 * "exported variable has or is using name from external module but
 * cannot be named".
 */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface MakeEnvelopeAwareOptions {
  /**
   * Caller-injected fetcher for L1 event wallclock + view-poisoned
   * signal. Default reads `viewGetFocusedWithWallclock()` napi
   * binding; tests inject mock to drive `confidence: fresh/degraded`
   * deterministically without hitting napi.
   */
  fetchMeta?: () => Promise<{ viewPoisoned: boolean; asOfWallclockMs: number | null }>;
  /**
   * Caller-injected env value getter. Default reads
   * `process.env.DESKTOP_TOUCH_ENVELOPE`; tests inject a closure to
   * pin env-default branch without `vi.stubEnv` global state.
   */
  getEnvValue?: () => string | undefined;
}

/**
 * **L5 wrapper helper** (ADR-010 §1.5 SSOT: `include` / `dry_run` /
 * `as_of` 等は L5 wrapper が一元解釈、tool 個別実装は修正不要)。
 *
 * Wraps a tool handler (signature: `(args) => Promise<ToolResult>`)
 * so that:
 *   1. The `include` arg is **peeked + stripped** at the wrapper
 *      layer BEFORE handler invocation, so tool individual Zod
 *      schemas do NOT need to declare `include` themselves.
 *   2. The handler's raw JSON content (in `content[0].text`) is
 *      parsed and wrapped in envelope (always; SSOT).
 *   3. Compat hoist is applied based on `resolveEnvelopeOptIn` —
 *      raw shape (post-flatten) when caller does not opt in,
 *      envelope shape when caller opts in via `include=["envelope"]`
 *      or env `DESKTOP_TOUCH_ENVELOPE=1`.
 *   4. Result is re-stringified back into MCP `ToolResult` shape.
 *
 * Handler signature stays as `(args) => Promise<ToolResult>` —
 * unchanged for existing tools (ADR-010 §1.5 compliance).
 *
 * **Defensive pass-through** for non-text or non-JSON content:
 * - If `content[0]` is not `type: "text"`, the handler's result is
 *   returned unchanged (no envelope wrap).
 * - If `content[0].text` is not valid JSON, returned unchanged
 *   (handler emitted non-JSON text — out of scope for envelope).
 *
 * S3 contract: tool handler signature unchanged, envelope wrap
 * inside JSON, MCP `ToolResult` outer shape unchanged.
 */
export function makeEnvelopeAware<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<McpToolResult>,
  _toolName: string, // currently unused; reserved for future telemetry
  options: MakeEnvelopeAwareOptions = {},
): (rawArgs: TArgs & { include?: string[] }) => Promise<McpToolResult> {
  const fetchMeta =
    options.fetchMeta ??
    (async () => ({ viewPoisoned: false, asOfWallclockMs: null }));
  const getEnvValue =
    options.getEnvValue ?? (() => process.env.DESKTOP_TOUCH_ENVELOPE);

  return async (rawArgs) => {
    // Peek + strip `include` before handler invocation. Tool handler
    // sees args without the `include` field, so its individual Zod
    // schema is unaffected (ADR-010 §1.5).
    const { include, ...handlerArgs } = rawArgs as { include?: string[] } & TArgs;
    const optIn = resolveEnvelopeOptIn(include, getEnvValue());

    // Fetch meta (L1 wallclock + viewPoisoned) BEFORE handler so
    // we capture pre-handler state. Post-handler observation would
    // surface focus changes the handler itself induced; for query
    // tools (no side effect) the difference is below scheduler
    // resolution. For commit tools (S4 phase, side effects), the
    // commit wrapper will read meta both pre and post.
    const meta = await fetchMeta();

    const result = await handler(handlerArgs as TArgs);

    // Parse the JSON data from `content[0].text` (MCP standard).
    // Non-text blocks pass through unchanged.
    const block = result.content?.[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      return result;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      // Handler emitted non-JSON text; out of scope for envelope.
      return result;
    }

    // Build envelope (always; SSOT — Round 2 P1-2 反映、統合書 §11.2).
    const envelope = buildEnvelope(parsed, {
      viewPoisoned: meta.viewPoisoned,
      asOfWallclockMs: meta.asOfWallclockMs,
    });
    // Compat hoist (post-flatten or pass-through).
    const final = compatHoist(envelope, optIn);

    return {
      ...result,
      content: [{ ...block, text: JSON.stringify(final) }, ...result.content.slice(1)],
    };
  };
}

// ─── S4 commit / query wrapper layer (ADR-010 P1 S4) ─────────────────────────
//
// Sub-plan SSOT: `docs/adr-010-p1-s4-plan.md`
//
//   §2.1  commit / query wrapper API
//   §2.2  LeaseStore.validate() reason → typed enum mapping table
//   §2.3  L1 EventKind payload schema (existing 100/101 unchanged)
//   §2.4  failure envelope (most_likely_cause: "LeaseExpired", try_next: 1 path)
//   §2.6  args_summary truncate (~512 byte cap)
//
// Walking-skeleton G3 contract test suite (`tests/unit/desktop-act-commit-wrapper.test.ts`)
// pins the bit-equal contract for all 8 cases (G3-S4-1 ~ G3-S4-8).

/**
 * Result of a caller-supplied lease-validation function. Mirrors the
 * runtime `LeaseValidationResult` from `src/engine/world-graph/types.ts`
 * so the wrapper consumes the same union shape `LeaseStore.validate()`
 * already produces — no impedance mismatch (sub-plan §2.2).
 */
export type LeaseValidationLike = LeaseValidationResult;

/**
 * Mapping from `LeaseStore.validate()` reason → ADR-010 §5.4 typed enum
 * code (PascalCase). Sub-plan §2.2 + §1.4 + §1.1 F:
 *
 *   `expired`              → `LeaseExpired`              ← S4 trunk: full runtime
 *   `generation_mismatch`  → `LeaseGenerationMismatch`   ← contract pin only
 *   `entity_not_found`     → `EntityNotFound`            ← contract pin only
 *   `digest_mismatch`      → `LeaseDigestMismatch`       ← contract pin only
 *
 * **Contract pin**: typed-code names live here in source for expansion
 * mechanical-copy work. **Runtime**: only `LeaseExpired` is emitted
 * end-to-end with `try_next`; the residual 3 reasons collapse to
 * `"Unknown"` at runtime (sub-plan §7 R4) so trunk skeleton stays
 * minimal — expansion lifts each into its own try_next path
 * mechanically.
 *
 * `EntityOutsideViewport` is NOT in this table — it's a 5th
 * lease-relevant typed code emitted via a different path (viewport-out
 * commit gate / WindowChanged event), not from `LeaseStore.validate()`.
 * Sub-plan §2.2 treats it as carry-over for expansion (sub-plan §1.4).
 */
export const LEASE_REASON_TO_TYPED_CODE = {
  expired: "LeaseExpired",
  generation_mismatch: "LeaseGenerationMismatch",
  entity_not_found: "EntityNotFound",
  digest_mismatch: "LeaseDigestMismatch",
} as const;

/**
 * Map a `LeaseStore.validate()` reason to the runtime typed code +
 * `try_next` shape carried in the failure envelope (sub-plan §2.4).
 *
 * S4 trunk only fully wires `expired → LeaseExpired` with `try_next:
 * [{action: "desktop_discover"}]` — the other 3 reasons map to
 * `Unknown` with empty `try_next` per sub-plan §7 R4. Expansion
 * promotes each to its own typed code via a mechanical change here.
 *
 * Returned shape is what `buildFailureEnvelope` consumes; tests pin
 * both branches deterministically (`tests/unit/desktop-act-commit-wrapper.test.ts`
 * G3-S4-2 / lease-residual cases).
 */
export function mapLeaseValidationToTypedReason(
  reason: "expired" | "generation_mismatch" | "entity_not_found" | "digest_mismatch",
): { code: string; tryNext: TryNextAction[] } {
  if (reason === "expired") {
    return {
      code: "LeaseExpired",
      tryNext: [{ action: "desktop_discover", args: {}, confidence: "high" }],
    };
  }
  // Sub-plan §7 R4: residual 3 reasons collapse to `Unknown` at runtime
  // in S4 trunk. The PascalCase names are pinned in
  // `LEASE_REASON_TO_TYPED_CODE` so expansion can mechanically promote
  // each branch into its own typed code without re-deriving the mapping.
  return { code: "Unknown", tryNext: [] };
}

/**
 * Truncate a JSON-stringified `args` to fit the L1 ring's per-event
 * size budget (sub-plan §2.6). Default 512 bytes — covers the
 * vast majority of `desktop_act` invocations while bounding L1 ring
 * pressure when an argument shape balloons (e.g. `text` containing
 * a paste).
 *
 * Byte budget is measured in UTF-8 (matches `envelopePayloadSizeBytes`'s
 * choice of `Buffer.byteLength(..., "utf8")`). When the JSON exceeds
 * the budget, the result has the ellipsis sentinel `…` appended so the
 * truncation is visible in L1 dumps. The single ellipsis (3 UTF-8
 * bytes) is included in the budget — the slice loses 3 bytes to make
 * room — so the returned string is **always ≤ `maxBytes`** even when
 * the source ends mid-multibyte sequence (the slice falls back to
 * the last safe codepoint boundary).
 *
 * **carry-over (OQ #3)**: PII / secret redaction is expansion P2
 * work. S4 trunk only truncates by length — see sub-plan §8 OQ #3.
 */
export function truncateJson(args: unknown, maxBytes: number = 512): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    // Circular ref or BigInt: defensive empty-object fallback so the
    // wrapper still pushes a ToolCallStarted event with a recognisable
    // payload (rather than throwing inside the wrapper itself).
    json = "{}";
  }
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return json;
  // UTF-8 safe truncation: shrink one char at a time until the byte
  // budget (minus 3 for the ellipsis) is satisfied. Avoids breaking
  // multi-byte sequences mid-codepoint.
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  let cut = json;
  while (Buffer.byteLength(cut, "utf8") + ellipsisBytes > maxBytes && cut.length > 0) {
    cut = cut.slice(0, -1);
  }
  return cut + ellipsis;
}

/**
 * Build a commit-failure envelope (ADR-010 §5.3, sub-plan §2.4).
 *
 *   {
 *     _version:   "1.0",
 *     data:        null,
 *     as_of:      { wallclock_ms: ... },
 *     confidence: "stale",            // failure 固定
 *     if_unexpected: { most_likely_cause, try_next },
 *   }
 *
 * `as_of.wallclock_ms` follows the same source rule as `buildEnvelope`:
 * caller-supplied L1 event wallclock when present, else `Date.now()`.
 * Failure envelope is always `confidence: "stale"` regardless of the
 * size or fallback path — failure shape is small (try_next 1 path)
 * and wallclock fallback is irrelevant when the call never executed.
 */
export function buildFailureEnvelope(
  mostLikelyCause: string,
  tryNext: TryNextAction[],
  options?: EnvelopeOptions,
): EnvelopeMinimalShape<null> {
  const wallclockSupplied =
    options?.asOfWallclockMs != null && Number.isFinite(options.asOfWallclockMs);
  const wallclock = wallclockSupplied ? (options!.asOfWallclockMs as number) : Date.now();
  return {
    _version: "1.0",
    data: null,
    as_of: { wallclock_ms: wallclock },
    confidence: "stale",
    if_unexpected: { most_likely_cause: mostLikelyCause, try_next: tryNext },
  };
}

// ─── tool_call_id session-local monotone counter ─────────────────────────────

/**
 * Per-session `tool_call_id` source. Format `${sessionId}:${seq}`,
 * seq ≥ 1 monotone within a single server lifetime (sub-plan §2.1 +
 * §3.5). Cross-server-restart uniqueness is OQ #1 carry-over —
 * SQLite/file-backed persistence lands in expansion (ADR-011).
 *
 * `_resetToolCallSeqForTest()` lets unit tests pin per-session
 * counter behaviour deterministically (G3-S4-6) without mutating
 * module state across test files.
 */
const _toolCallSeq = new Map<string, number>();

export function nextToolCallId(sessionId: string): string {
  const seq = (_toolCallSeq.get(sessionId) ?? 0) + 1;
  _toolCallSeq.set(sessionId, seq);
  return `${sessionId}:${seq}`;
}

/** @internal Test-only — clear per-session counters between cases. */
export function _resetToolCallSeqForTest(): void {
  _toolCallSeq.clear();
}

// ─── L1 push helpers (commit-axis ToolCall events) ───────────────────────────
//
// The wrapper isolates the napi calls so tests can inject a fake L1
// emitter without depending on the real native binding. The real
// helpers swallow napi errors defensively — a failed L1 push must NOT
// short-circuit a real tool side effect (the user's click should land
// even if telemetry is broken).

export interface L1ToolCallStartedArgs {
  tool: string;
  argsJson: string;
  sessionId: string;
  toolCallId: string;
  leaseToken?: NativeLeaseTokenSummary;
}

export interface L1ToolCallCompletedArgs {
  tool: string;
  elapsedMs: number;
  ok: boolean;
  errorCode?: string;
  sessionId: string;
  toolCallId: string;
}

export interface CommitL1Emitter {
  pushStarted(args: L1ToolCallStartedArgs): void;
  pushCompleted(args: L1ToolCallCompletedArgs): void;
}

/** Default emitter (production). Calls the napi binding via `nativeL1`
 *  from `native-engine.ts` and swallows any throw so tool side effects
 *  are never blocked by L1 telemetry failure. `nativeL1` is `null` on
 *  pre-P5a binaries / non-Windows dev environments — calls become
 *  no-ops there (matches the rest of `native-engine.ts`'s defensive
 *  fallback pattern). */
export const defaultL1Emitter: CommitL1Emitter = {
  pushStarted({ tool, argsJson, sessionId, toolCallId, leaseToken }) {
    try {
      nativeL1?.l1PushToolCallStarted?.(
        tool,
        argsJson,
        sessionId,
        toolCallId,
        leaseToken,
      );
    } catch {
      // L1 binding unavailable / threw — telemetry best-effort.
    }
  },
  pushCompleted({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId }) {
    try {
      nativeL1?.l1PushToolCallCompleted?.(
        tool,
        elapsedMs,
        ok,
        errorCode,
        sessionId,
        toolCallId,
      );
    } catch {
      // L1 binding unavailable / threw — telemetry best-effort.
    }
  },
};

// ─── makeCommitWrapper (sub-plan §2.1 7-step flow) ──────────────────────────

export interface CommitWrapperOptions<TArgs> extends MakeEnvelopeAwareOptions {
  /**
   * Lease 4-tuple validator (sub-plan §1.1 D + §3.4). Caller-supplied
   * pure function so unit tests can inject deterministic results
   * without driving a real `LeaseStore` (G3-S4-2 / G3-S4-3).
   *
   * Production wiring (`src/tools/desktop-register.ts`): closure that
   * reads the session for the lease's `viewId` from the facade and
   * runs `LeaseStore.validate(lease, currentGeneration, liveEntities)`.
   *
   * Omit when the wrapped tool doesn't carry a lease (`click_element`
   * lease-less variant, expansion §1.2). The wrapper skips step 2 in
   * that case and goes straight to handler invocation.
   */
  leaseValidator?: (args: TArgs) => Promise<LeaseValidationLike>;
  /**
   * Project the lease 4-tuple from `args` into the `NativeLeaseTokenSummary`
   * carried on `ToolCallStarted` (sub-plan §2.3). Called only when
   * `leaseValidator` is set and validation succeeds. Default returns
   * `undefined` (no lease attached on the L1 event).
   */
  extractLeaseToken?: (args: TArgs) => NativeLeaseTokenSummary | undefined;
  /**
   * `args_summary` generator (sub-plan §2.6). Default truncates
   * `JSON.stringify(args)` to 512 bytes. Caller can override to
   * inject PII redaction (expansion P2 work, OQ #3).
   */
  argsSummary?: (args: TArgs) => string;
  /**
   * Session-id source (sub-plan §2.1 + OQ #1). Default `"default"`
   * — sufficient for trunk skeleton because per-session ring buffers
   * land in S5 (caused_by linkage). Tests inject a fixed value to
   * pin tool_call_id format (G3-S4-6).
   */
  getSessionId?: (args: TArgs) => string;
  /**
   * L1 emitter (default `defaultL1Emitter`, production). Tests
   * inject a fake to assert pushStarted / pushCompleted call shape.
   */
  l1Emitter?: CommitL1Emitter;
  /**
   * Wallclock source for `elapsed_ms` measurement. Default
   * `Date.now`. Tests inject a deterministic clock so G3-S4-3
   * pins `elapsed_ms` on the ToolCallCompleted event without flake.
   */
  clock?: () => number;
}

/**
 * Wrap a commit-axis (side-effecting) tool handler with the 7-step
 * flow per sub-plan §2.1. The handler keeps its existing signature
 * `(args) => Promise<ToolResult>` — wrapper layer owns lease
 * validation, ToolCall events, envelope assembly, and compat hoist.
 *
 * **Tool individual implementation is unchanged** (ADR-010 §1.5):
 * `desktop_act`'s internal logic, Zod schema, and raw return shape
 * are unmodified. Registration sites (`desktop-register.ts` +
 * `macro.ts` `TOOL_REGISTRY`) wrap once at module scope and share
 * the same instance across the `server.tool` and `run_macro`
 * paths (PR #112 same-pattern fix).
 *
 * The wrapper falls back to S3 `makeEnvelopeAware` semantics when
 * `leaseValidator` is omitted (lease-less commit, e.g. expansion
 * `click_element`) — only the ToolCall event emission and envelope
 * assembly pieces apply, lease-validation step 2 is skipped.
 */
export function makeCommitWrapper<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<McpToolResult>,
  toolName: string,
  options: CommitWrapperOptions<TArgs> = {},
): (rawArgs: TArgs & { include?: string[] }) => Promise<McpToolResult> {
  const fetchMeta =
    options.fetchMeta ??
    (async () => ({ viewPoisoned: false, asOfWallclockMs: null }));
  const getEnvValue =
    options.getEnvValue ?? (() => process.env.DESKTOP_TOUCH_ENVELOPE);
  const argsSummary = options.argsSummary ?? ((a: TArgs) => truncateJson(a, 512));
  const getSessionId = options.getSessionId ?? (() => "default");
  const l1 = options.l1Emitter ?? defaultL1Emitter;
  const clock = options.clock ?? Date.now;

  return async (rawArgs) => {
    // Step 1: peek + strip `include` (S3 inherit).
    const { include, ...handlerArgsRaw } = rawArgs as { include?: string[] } & TArgs;
    const handlerArgs = handlerArgsRaw as TArgs;
    const optIn = resolveEnvelopeOptIn(include, getEnvValue());
    const meta = await fetchMeta();
    const envelopeOptions: EnvelopeOptions = {
      viewPoisoned: meta.viewPoisoned,
      asOfWallclockMs: meta.asOfWallclockMs,
    };

    // Step 2: lease validation (skip when no validator — lease-less commit).
    let validation: LeaseValidationLike | undefined;
    if (options.leaseValidator) {
      validation = await options.leaseValidator(handlerArgs);
      if (!validation.ok) {
        const { code, tryNext } = mapLeaseValidationToTypedReason(validation.reason);
        const failure = buildFailureEnvelope(code, tryNext, envelopeOptions);
        const finalShape = compatHoist(failure, optIn);
        return {
          content: [{ type: "text", text: JSON.stringify(finalShape) }],
        };
      }
    }

    // Step 3: tool_call_id seq採番.
    const sessionId = getSessionId(handlerArgs);
    const toolCallId = nextToolCallId(sessionId);

    // Step 4: l1PushToolCallStarted (with optional lease_token summary).
    const summary = argsSummary(handlerArgs);
    const leaseToken = options.extractLeaseToken
      ? options.extractLeaseToken(handlerArgs)
      : undefined;
    l1.pushStarted({
      tool: toolName,
      argsJson: summary,
      sessionId,
      toolCallId,
      leaseToken,
    });

    // Step 5: invoke handler (raw side effect). Step 6: completion event.
    const startedAt = clock();
    let handlerResult: McpToolResult | undefined;
    let handlerError: unknown;
    try {
      handlerResult = await handler(handlerArgs);
    } catch (err) {
      handlerError = err;
    }
    const elapsedMs = Math.max(0, Math.floor(clock() - startedAt));

    if (handlerError !== undefined) {
      l1.pushCompleted({
        tool: toolName,
        elapsedMs,
        ok: false,
        errorCode: extractErrorCode(handlerError),
        sessionId,
        toolCallId,
      });
      const failure = buildFailureEnvelope(
        "Unknown",
        [],
        envelopeOptions,
      );
      const finalShape = compatHoist(failure, optIn);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }

    const result = handlerResult as McpToolResult;

    // Step 7: buildEnvelope (S3 inherit) + compatHoist (S3 inherit).
    const block = result.content?.[0];
    const ok = inferOkFromResult(block);
    l1.pushCompleted({
      tool: toolName,
      elapsedMs,
      ok,
      errorCode: ok ? undefined : extractErrorCodeFromBlock(block),
      sessionId,
      toolCallId,
    });

    if (!block || block.type !== "text" || typeof block.text !== "string") {
      return result;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      return result;
    }
    const envelope = buildEnvelope(parsed, envelopeOptions);
    const final = compatHoist(envelope, optIn);
    return {
      ...result,
      content: [{ ...block, text: JSON.stringify(final) }, ...result.content.slice(1)],
    };
  };
}

/**
 * Wrap a query-axis (no-side-effect) tool handler. Sub-plan §2.1 +
 * §3.3: `desktop_discover` registers via this helper. Reuses the S3
 * `makeEnvelopeAware` semantics directly — no ToolCall events, no
 * lease validation, no `tool_call_id` seq. Provided as a stable name
 * so the registration sites read like the symmetric commit / query
 * pair the sub-plan describes; the future expansion seam is the
 * `QueryWrapperOptions` interface (currently empty, S4 carry-over for
 * potential lease-issue tracking events).
 */
/**
 * Query-axis wrapper options. S4 trunk: alias for `MakeEnvelopeAwareOptions`
 * — no new fields. The named alias is reserved as an expansion seam for
 * query-side telemetry (e.g. lease-issue events, query history) which
 * is **carry-over** for S5+ (sub-plan §1.2). Defined as a `type` rather
 * than an empty `interface` so eslint's `no-empty-object-type` rule
 * stays happy while keeping the symmetric commit / query naming.
 */
export type QueryWrapperOptions = MakeEnvelopeAwareOptions;

export function makeQueryWrapper<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<McpToolResult>,
  toolName: string,
  options: QueryWrapperOptions = {},
): (rawArgs: TArgs & { include?: string[] }) => Promise<McpToolResult> {
  return makeEnvelopeAware(handler, toolName, options);
}

// ─── Internal helpers (commit wrapper completion event details) ──────────────

/**
 * Best-effort `error_code` extraction from a thrown handler value.
 * Used on the ToolCallCompleted event when the handler throws —
 * sub-plan G3-S4-4 pins `ok: false` + recognisable code on the L1
 * event when the wrapped handler rejects.
 */
function extractErrorCode(err: unknown): string {
  if (typeof err === "string") return err.slice(0, 64);
  if (err instanceof Error) {
    // ADR-010 §5.4 typed codes are PascalCase identifiers — most
    // domain errors carry the code in `err.name` (e.g. `ZodError`).
    return err.name.length > 0 && err.name !== "Error" ? err.name : "Unknown";
  }
  return "Unknown";
}

/**
 * Inspect the MCP `content[0].text` block to decide whether the
 * handler reported `ok: false`. The legacy `ToolResult` shape (used
 * by `_types.ts::ok` / `failWith`) is `{content: [{type: "text",
 * text: '{"ok": ...}'}]}`. We parse the text and read the `ok` flag,
 * defaulting to `true` for non-JSON / missing-flag content (keeps the
 * existing healthy-path semantic).
 */
function inferOkFromResult(
  block: { type: string; text?: string; [k: string]: unknown } | undefined,
): boolean {
  if (!block || block.type !== "text" || typeof block.text !== "string") return true;
  try {
    const parsed = JSON.parse(block.text);
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return (parsed as { ok: unknown }).ok !== false;
    }
  } catch {
    // Non-JSON or malformed — treat as success (matches S3 defensive
    // pass-through path in `makeEnvelopeAware`).
  }
  return true;
}

function extractErrorCodeFromBlock(
  block: { type: string; text?: string; [k: string]: unknown } | undefined,
): string {
  if (!block || block.type !== "text" || typeof block.text !== "string") return "Unknown";
  try {
    const parsed = JSON.parse(block.text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.code === "string" && obj.code.length > 0) return obj.code;
      if (typeof obj.error === "string" && obj.error.length > 0) {
        return obj.error.slice(0, 64);
      }
    }
  } catch {
    // ignore
  }
  return "Unknown";
}
