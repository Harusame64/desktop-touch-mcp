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
 */

import { z, type ZodArray, type ZodOptional, type ZodString, type ZodTypeAny } from "zod";

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
   * view-poisoned OR Date.now() fallback). S3 trunk: 2-value
   * subset; `cached` / `inferred` / `stale` lands in expansion
   * (ADR-010 §17.6.1 値域 SSOT、stale は S4 で 3 値に bump).
   */
  confidence: "fresh" | "degraded";
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
