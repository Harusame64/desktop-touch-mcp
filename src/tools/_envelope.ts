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
import { nativeL1, nativeViewFocus } from "../engine/native-engine.js";
import type { NativeLeaseTokenSummary } from "../engine/native-types.js";
import { enumMonitors } from "../engine/win32.js";
import {
  runWithSessionContext,
  getMcpTransportSessionIdFromContext,
  isSingleSessionPrototype,
  _setSingleSessionPinForTest,
  _resetSingleSessionPinForTest,
} from "./_session-context.js";
import { getSuggestsForCode, failArgs } from "./_errors.js";
import type { Result } from "../types/result.js";
import { HandlerError } from "../errors/typed-errors.js";
import type { ToolResult } from "./_types.js";
import {
  uiPatternStore,
  parseMemoryRedactMode,
  parseMemoryPersistMode,
} from "../store/ui-pattern-store.js";
import { macroOutcomeStore } from "../store/macro-outcome-store.js";

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
  /** S5 caused_by linkage (ADR-010 §5.2 `include=causal`、sub-plan §2.2).
   * 4 field projection from per-session history buffer. Optional —
   * present only when `include=["causal"]` opt-in + per-session history
   * has a recent commit event in the causal window. */
  caused_by?: CausedByShape;
  /** S5 envelope-top-level `based_on` (architecture §8.2 line 355-356
   * 責務マトリクス、sub-plan §2.2 Round 3 P1 Opus #1 反映で CausedByShape
   * から分離)。L1 event_id range + observation source list. `events` is
   * `string[]` (u64 decimal) so `JSON.stringify` is safe even when L1
   * event_id exceeds 2^53 (Round 3 P1 Codex line 370 反映、`node -e
   * "JSON.stringify({events:[1n]})"` で TypeError 実証済)。Optional —
   * same `include=["causal"]` opt-in trigger as `caused_by`. */
  based_on?: BasedOnShape;
  /** ADR-011 Phase B B-1 Working memory projection (recent N event compact、
   *  ADR-010 §6 line 406 view name `current_state` 整合)。Optional — present
   *  only when `include=["working"]` or `["working:N"]` opt-in。
   *  `_truncation` notation 付きで silently truncate 防止 (Phase B plan §4.3
   *  acceptance、ADR-010 §5.6.1 truncation 規約)。 */
  current_state?: WorkingMemoryProjection;
  /** ADR-011 Phase B B-2 Episodic memory projection (recent N completed
   *  event rich shape、ADR-010 §6 line 407 view name `tool_call_history`
   *  整合)。Optional — present only when `include=["episodic"]` or
   *  `["episodic:N"]` opt-in。Working memory と同 ring 共有、projection
   *  shape のみ rich (lease_token / event_id / elapsed)。 */
  tool_call_history?: EpisodicMemoryProjection;
  /** ADR-011 Phase B B-3 Semantic memory projection (learned UI patterns、
   *  ADR-010 §6 line 408 view name `learned_ui_pattern` 整合)。Optional —
   *  present only when `include=["semantic"]` or `["semantic:K"]` opt-in。
   *  Working/Episodic と同 ring 共有 (`_historyBuffers`)、抽出は rule-based
   *  (同 windowTitle で連続 N=3+ commit 成功 → 1 pattern) + LRU 100 cap、
   *  在メモリのみ (永続化は B-3 follow-up PR で carry-over、env var parser
   *  のみ設置済)。 */
  learned_ui_pattern?: SemanticMemoryProjection;
  /** ADR-011 Phase B B-4 Procedural memory projection (successful repeated
   *  workflows、ADR-010 §6 line 409 view name `successful_macros` 整合)。
   *  Optional — present only when `include=["procedural"]` or
   *  `["procedural:K"]` opt-in。`run_macro` 完了時 outcome store に記録、
   *  suggest filter (success>=3 + failure==0 + no destructive) 経由のみ
   *  expose、destructive macro suggest は **non-goal** で構造的に skip。 */
  successful_macros?: ProceduralMemoryProjection;
  /** ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved)。Optional
   *  — present only when any memory layer (causal/working/episodic/semantic/
   *  procedural) opted in OR `memory_*` keyword explicit 指定時。LLM が
   *  「この call で どの tier が active か」を観測できるよう envelope に
   *  expose、~50-100 B 程度。 */
  security_tier_active?: SecurityTierActive;
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

// ─── S5 caused_by linkage shapes (sub-plan §2.2) ─────────────────────────────

/**
 * `caused_by` 4 field projection (ADR-010 §5.2 `include=causal` opt-in、
 * sub-plan §2.2 Round 3 P1 Opus #1 反映で 5 field → 4 field 縮小).
 *
 * SSOT 整合: architecture §6 worked example (line 213-215) +
 * architecture §8.2 各層責務マトリクス (`based_on` は envelope トップ
 * レベル、L1 start / L2 end 担当) と整合。`based_on` は `CausedByShape`
 * から分離して envelope トップレベル `BasedOnShape` に移動。
 *
 * Triggered: `desktop_state(include=["causal"])` on a session that has a
 * recent commit event (ToolCallStarted + ToolCallCompleted) in the
 * causal window (sub-plan §2.6).
 *
 * `session_id` は ADR-010 §4 識別子ヒエラルキーで envelope 全体に共通する
 * pivot のため CausedBy field 内には重複させず、`tool_call_id` の prefix
 * (`${sessionId}:${seq}`) から逆引可能で十分。ADR-010 §5 example の
 * `session_id` field 採用検討は §6 OQ #6 carry-over。
 */
export interface CausedByShape {
  /** Direct preceding commit summary, e.g. `"desktop_act({...})"` (sub-plan §1.3
   * carry-over OQ #2 finalize: 直前任意 commit tool 採用). */
  your_last_action: string;
  /** Per-session monotone ID (S4 既存採番、`${sessionId}:${seq}` 形式). */
  tool_call_id: string;
  /** ToolCallStarted ↔ ToolCallCompleted wallclock 差。`Date.now()` 由来
   *  (`monotonicStartMs` は causal window timeout 用、別軸)。 */
  elapsed_ms: number;
  /** L3 view diff projection (focus delta + dirty_rect per-monitor count、
   *  sub-plan §1.1 C / §2.3 buildProducedChanges)。`monitor_index` field 維持
   *  (CLAUDE.md §3.2 PR #102 同型 regression 防止)。 */
  produced_changes: string[];
}

/**
 * Envelope-top-level `based_on` field (architecture §8.2 line 355-356
 * 責務マトリクス整合、sub-plan §2.2 Round 3 P1 Opus #1 反映で
 * CausedByShape から分離).
 *
 * Round 3 P1 Codex line 370 反映: `events` は **`string[]` (u64 decimal)**
 * — internal bigint・wire string で JSON.stringify TypeError 完全回避。
 * `node -e "JSON.stringify({events:[1n]})"` で TypeError 実証済 (Codex
 * 2026-05-01)。precision loss 0 (u64 → decimal string で full 64-bit) +
 * LLM client 互換 (Claude CLI bigint 直接扱えず) を兼備。
 */
export interface BasedOnShape {
  /** L1 event_id range (start: ToolCallStarted, end: ToolCallCompleted).
   *  u64 を decimal string で表現。 */
  events: string[];
  /** Observation source 由来 (UIA = focus delta / DXGI = dirty_rect)、
   *  observation 駆動で動的 build (sub-plan §2.2 Round 2 P2 Opus #3 反映)。 */
  sources: string[];
}

/**
 * View snapshot consumed by `buildCausedBy` / `buildBasedOn` (sub-plan §2.2).
 *
 * Production wiring (`src/tools/desktop-state.ts` `defaultCausedByProjector`):
 *   - focus = `viewGetFocused()` (S3-2 既存 napi binding) → name + hwnd
 *   - dirtyRectsByMonitor = `viewGetDirtyRects(monitor_index)` (S2 既存) per-monitor
 *   - latestEventId = `l1GetCaptureStats().eventIdHighWater` (既存 OQ #5 reuse、新 binding 不要)
 *   - queryWallclockMs = `Date.now()` at projector invocation
 */
export interface ViewSnapshot {
  /** L3 latest_focus 値 (focus_view → element name/hwnd)、null = focus 不在 */
  focus: { hwnd: bigint | null; elementName: string | null } | null;
  /** L3 dirty_rects_aggregate per-monitor count (monitor_index → aggregate count) */
  dirtyRectsByMonitor: Map<number, number>;
  /** L1 ring 末尾 event_id (`l1GetCaptureStats().eventIdHighWater` 由来、causal window 右端 (a)) */
  latestEventId: bigint | undefined;
  /** Query 時点の wallclock (causal window timeout は monotonic 軸別計算、本 field は表示用) */
  queryWallclockMs: number;
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
  /**
   * S5 caused_by linkage (sub-plan §2.4 + §3.3 makeQueryWrapper flow).
   * Optional — set by `makeQueryWrapper` when `include=["causal"]` opt-in
   * + `causedByProjector` returns a non-undefined projection.
   */
  causedBy?: CausedByShape;
  /**
   * S5 envelope-top-level `based_on` (sub-plan §2.2 Round 3 P1 Opus #1
   * 反映で envelope top-level に分離、architecture §8.2 line 355-356
   * 責務マトリクス整合). Optional — set together with `causedBy`.
   */
  basedOn?: BasedOnShape;
  /**
   * ADR-011 Phase B B-1 Working memory projection
   * (`envelope.current_state.recent_events`、ADR-010 §6 line 406 view name
   * `current_state` 整合)。Optional — set by `makeQueryWrapper` when
   * `include=["working"]` or `["working:N"]` opt-in。
   *
   * `_truncation` notation は ring underflow / capacity_cap で N 要求未満
   * しか返せない場合に付与 (silently truncate 防止、Phase B plan §4.3
   * acceptance + ADR-010 §5.6.1 truncation 規約)。
   */
  currentState?: WorkingMemoryProjection;
  /**
   * ADR-011 Phase B B-2 Episodic memory projection
   * (`envelope.tool_call_history.episodes`、ADR-010 §6 line 407 view name
   * `tool_call_history` 整合)。Optional — set by `makeQueryWrapper` when
   * `include=["episodic"]` or `["episodic:N"]` opt-in。Working memory と
   * 同 ring 共有 (`_historyBuffers`)、projection shape のみ rich
   * (lease_token_summary / event_id_started / event_id_completed /
   * elapsed_ms)、in-flight skip (completed only)。
   */
  toolCallHistory?: EpisodicMemoryProjection;
  /**
   * ADR-011 Phase B B-3 Semantic memory projection
   * (`envelope.learned_ui_pattern.patterns`、ADR-010 §6 line 408 view name
   * `learned_ui_pattern` 整合)。Optional — set by `makeQueryWrapper` when
   * `include=["semantic"]` or `["semantic:K"]` opt-in。rule-based 抽出
   * (同 windowTitle 連続 N+ commit 成功 → 1 pattern)、in-memory LRU 100
   * (永続化は B-3 follow-up PR で carry-over、env var parser のみ設置済)。
   */
  learnedUiPattern?: SemanticMemoryProjection;
  /**
   * ADR-011 Phase B B-4 Procedural memory projection
   * (`envelope.successful_macros.suggestions`、ADR-010 §6 line 409
   * view name `successful_macros.suggestions` 整合、Round 2 P1-1 fix で
   * inner field 名を `suggestions` に rename: B-1 `current_state.recent_events` /
   * B-2 `tool_call_history.episodes` / B-3 `learned_ui_pattern.patterns` と
   * 同型 axis = envelope field 名 ≠ inner list 名)。Optional — set by
   * `makeQueryWrapper` when `include=["procedural"]` or `["procedural:K"]`
   * opt-in。`run_macro` 完了時 outcome store に記録、suggest filter
   * (success>=3 + failure==0 + no destructive) 経由のみ expose。
   */
  successfulMacros?: ProceduralMemoryProjection;
  /**
   * ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved)。
   * `envelope.security_tier_active` field expose、LLM が effective tier
   * を観測可。`makeQueryWrapper` が memory layer 1 つ以上 opt-in or
   * `memory_*` keyword 指定時に set。
   */
  securityTierActive?: SecurityTierActive;
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
      .describe(ENVELOPE_INCLUDE_FIELD_DESCRIPTION),
  } as T & { include: ZodOptional<ZodArray<ZodString>> };
}

/**
 * Inject `include?: string[]` into a `z.discriminatedUnion(...)` schema
 * by extending each variant's object shape and rebuilding the union.
 *
 * **Why a separate helper** (Opus PR #123 keyboard worktree report):
 * `withEnvelopeIncludeSchema` requires a `Record<string, ZodTypeAny>`
 * (= raw object shape) input, but several tool families
 * (keyboard / clipboard / window_dock / scroll / terminal / browser_eval)
 * use `z.discriminatedUnion` to dispatch on an `action` literal. Direct
 * application of `withEnvelopeIncludeSchema` is impossible — the union
 * has no flat shape to spread into. This helper extends each variant
 * object with the same `include` field and rebuilds the discriminator,
 * preserving the dispatch semantic while making `args.include` survive
 * the MCP SDK's `z.parse()` step.
 *
 * Usage at registration site (sub-plan §3.1 step 3、discriminatedUnion
 * 系 schema 用):
 *
 * ```ts
 * server.registerTool("keyboard", {
 *   description,
 *   inputSchema: withEnvelopeIncludeForUnion(keyboardSchema),
 * }, makeCommitWrapper(handler, "keyboard", { ... }));
 * ```
 *
 * Type signature is intentionally widened to `ZodTypeAny` because Zod 3.x
 * does not export the variant tuple type publicly (`ZodDiscriminatedUnion`
 * has private `options` field with non-exported `ZodObject` element type).
 * Runtime behaviour is bit-equal with `withEnvelopeIncludeSchema` per
 * variant: each `z.object` gains `include?: string[]`, the discriminator
 * is preserved, and the union still dispatches by the same field.
 *
 * Discriminator access: Zod v3 exposed `union.discriminator` on the public
 * surface, but Zod v4 moved it under `_def.discriminator`. We read both so
 * the helper survives the v3↔v4 transition (PR #153 bumped to zod 4.4.x —
 * the v3 path returned `undefined`, breaking every variant's parse with
 * "Invalid discriminated union option" until this fix landed).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withEnvelopeIncludeForUnion(union: any): any {
  const includeField = z
    .array(z.string())
    .optional()
    .describe(ENVELOPE_INCLUDE_FIELD_DESCRIPTION);
  const newOptions = (union.options as readonly z.ZodObject<z.ZodRawShape>[]).map(
    (opt) => opt.extend({ include: includeField }),
  );
  const discriminator = (union._def?.discriminator ?? union.discriminator) as string | undefined;
  if (typeof discriminator !== "string" || discriminator.length === 0) {
    throw new Error(
      "withEnvelopeIncludeForUnion: failed to resolve discriminator field from input union " +
        "(checked union._def.discriminator and union.discriminator). Zod major-version drift?",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return z.discriminatedUnion(discriminator, newOptions as any);
}

// ─── ADR-018 Phase 2a — discriminatedUnion flatten + strict re-parse ─────────

/**
 * ADR-018 Phase 2a §2.5.2 — flatten a `z.discriminatedUnion` into a single flat
 * `z.object` for use as a tool's `registerTool` `inputSchema` (the WIRE schema).
 *
 * The MCP SDK's `normalizeObjectSchema` returns `undefined` for a top-level
 * union → `tools/list` falls back to empty `properties`. A flat `z.object` is
 * recognized and produces real `properties`. Top-level `oneOf` is NOT an
 * option — the Anthropic API rejects it (HTTP 400, "not planned").
 *
 * **Input** is the `withEnvelopeIncludeForUnion(...)`-injected union (so every
 * variant carries `include`). Pass that SAME value to `parseActionArgsOrFail`.
 *
 * The flat schema is intentionally LOOSE: the discriminator becomes a required
 * `z.enum` of all variant literals; every other field becomes `.optional()`.
 * It is NOT the validation gate — `parseActionArgsOrFail` (below), called
 * inside each `*DispatchHandler`, re-parses against the real union and is the
 * strict per-action gate. A field appearing in multiple variants with
 * structurally-different schemas is widened: all-`z.enum` collisions merge to
 * one `z.enum` of the value union; otherwise to a `z.union` (renders as a
 * property-level `anyOf` — accepted by the Anthropic API; only *top-level*
 * `oneOf`/`anyOf` is rejected).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function flattenUnionToObjectSchema(union: any): z.ZodObject<z.ZodRawShape> {
  const discriminator = (union._def?.discriminator ?? union.discriminator) as
    | string
    | undefined;
  if (typeof discriminator !== "string" || discriminator.length === 0) {
    throw new Error(
      "flattenUnionToObjectSchema: failed to resolve discriminator field from input union " +
        "(checked union._def.discriminator and union.discriminator). Zod major-version drift?",
    );
  }
  const variants = union.options as readonly z.ZodObject<z.ZodRawShape>[];
  const literals = new Set<string>();
  const fieldVariants = new Map<string, z.ZodTypeAny[]>();
  for (const variant of variants) {
    // zod 4.3.6: a `.refine()`-wrapped variant is still a `ZodObject` —
    // `.shape` is directly accessible, no unwrap needed (verified).
    const shape = variant.shape as Record<string, z.ZodTypeAny>;
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (key === discriminator) {
        // zod 4: a literal field's `_def.values` is the array of literal values.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fdef = (fieldSchema as any)._def;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const values = (fdef?.values as unknown[] | undefined) ?? [(fieldSchema as any).value];
        for (const v of values) {
          if (v !== undefined && v !== null) literals.add(String(v));
        }
        continue;
      }
      const list = fieldVariants.get(key) ?? [];
      list.push(fieldSchema);
      fieldVariants.set(key, list);
    }
  }
  const literalList = [...literals];
  if (literalList.length === 0) {
    throw new Error(
      `flattenUnionToObjectSchema: no discriminator literal values found for "${discriminator}".`,
    );
  }
  const mergedShape: Record<string, z.ZodTypeAny> = {
    [discriminator]: z
      .enum(literalList as [string, ...string[]])
      .describe(
        `Action selector — one of: ${literalList.join(", ")}. ` +
          "Per-action required fields are enforced at call time (see the tool description); " +
          "this flat schema lists every action's fields as optional.",
      ),
  };
  for (const [key, schemas] of fieldVariants) {
    mergedShape[key] = mergeFlatField(schemas);
  }
  return z.object(mergedShape);
}

/** Strip outer ZodOptional / ZodDefault / ZodNullable wrappers to the base. */
function stripFieldWrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = schema;
  for (let guard = 0; guard < 12; guard++) {
    const t = cur?._def?.type;
    if (t !== "optional" && t !== "default" && t !== "nullable") break;
    const inner = cur._def.innerType;
    if (!inner || inner === cur) break;
    cur = inner;
  }
  return cur as z.ZodTypeAny;
}

/**
 * Merge the per-variant schemas for one field name into a single optional
 * schema for the flat wire object. Structurally-identical variants (ignoring
 * description text) collapse to one; genuinely-different ones widen — all-enum
 * collisions to one `z.enum` of the value union, otherwise to a `z.union`.
 *
 * Each merged field is `.optional()` — **not** `.catch(undefined)`. A `.catch`
 * was considered (Codex PR #290 Round 2 P2: make the wire schema tolerate a
 * wrong-typed off-action field the way `z.discriminatedUnion` strips an
 * off-variant key) and **rejected** (Opus adjudication): `.catch` would
 * silently *drop* a malformed value, and for a field whose real-union schema
 * carries a `.default()` (`terminal`'s `until` =
 * `z.preprocess(...).default({mode:"quiet"})`) the subsequent
 * `parseActionArgsOrFail` re-parse would then substitute that default — a
 * malformed polling spec runs as quiet-mode with **no error surfaced**
 * (issue #196 regression). A wrong-typed off-action field being rejected with
 * a typed `InvalidArgs` error is the contract working, not a silent failure;
 * the discriminatedUnion's key-strip tolerance was a Zod mechanic, not a
 * designed contract. NOTE: `stripFieldWrappers` strips `optional`/`default`/
 * `nullable` but **not** `preprocess` — a preprocess-wrapped field keeps its
 * inner `.default()` reachable through the union re-parse, which is why
 * `.catch` here would be actively harmful. Do not reintroduce it.
 */
function mergeFlatField(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
  const uniqueBySig = new Map<string, z.ZodTypeAny>();
  schemas.forEach((schema, i) => {
    const base = stripFieldWrappers(schema);
    let sig: string;
    try {
      // `z.toJSONSchema` is the structural signature. In practice colliding
      // keys across the 7 tools are simple types (string / number / enum /
      // literal / bool) which serialize cleanly; the `catch` below is the real
      // guarantee — a field `z.toJSONSchema` cannot serialize (e.g. a future
      // shared `z.preprocess` field) is simply treated as a distinct shape and
      // falls through to the `z.union` widening, which is still correct.
      const js = z.toJSONSchema(base) as Record<string, unknown>;
      delete js.$schema;
      delete js.description; // structural identity ignores description text
      sig = JSON.stringify(js);
    } catch {
      sig = `__unserializable_${i}__`; // treat as a distinct shape
    }
    if (!uniqueBySig.has(sig)) uniqueBySig.set(sig, base);
  });
  const bases = [...uniqueBySig.values()];
  if (bases.length === 1) return bases[0].optional();
  // All-`z.enum` collision → merge to one `z.enum` of the value union. Carry
  // over the first variant's description (the per-variant `.describe()` is
  // otherwise lost; per-action specifics live in the tool's Caveats block).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asEnum = (b: any): string[] | null =>
    b?._def?.type === "enum" && Array.isArray(b.options) ? (b.options as string[]) : null;
  const enumValueSets = bases.map(asEnum);
  if (enumValueSets.every((v) => v !== null)) {
    const merged = [...new Set(enumValueSets.flat() as string[])];
    let mergedEnum = z.enum(merged as [string, ...string[]]);
    const firstDesc = bases.find((b) => typeof b.description === "string")?.description;
    if (firstDesc) mergedEnum = mergedEnum.describe(firstDesc);
    return mergedEnum.optional();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return z.union(bases as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]).optional();
}

/**
 * ADR-018 Phase 2a §2.5.2 — discriminated result of `parseActionArgsOrFail`.
 * Explicit wrapper (NOT `T | ToolResult`): `ToolResult` and a parsed union
 * value share no safe top-level discriminant and no `isToolResult` predicate
 * exists, so callers narrow on `.ok`.
 */
export type ParsedOrFail<T> =
  | { ok: true; value: T }
  | { ok: false; result: ToolResult };

/**
 * ADR-018 Phase 2a §2.5.2 — the strict per-action validation gate that the
 * flat wire schema (`flattenUnionToObjectSchema`) deliberately does NOT
 * provide. Each of the 7 flattened tools' `*DispatchHandler` calls this as its
 * first statement, before the `switch (action)`:
 *
 * ```ts
 * const parsed = parseActionArgsOrFail(scrollUnionWithInclude, args, "scroll");
 * if (!parsed.ok) return parsed.result;
 * switch (parsed.value.action) { ... }
 * ```
 *
 * `unionWithInclude` MUST be the `withEnvelopeIncludeForUnion(...)`-injected
 * union — NOT the bare `scrollSchema`. The bare union has no `include` field,
 * so `.parse()` against it would strip `include`. The include-injected union
 * carries `include` AND every `.refine()` / `z.literal()` / per-action
 * `required` constraint (`withEnvelopeIncludeForUnion` only `.extend()`s).
 *
 * On failure: returns `{ ok: false, result }` where `result` is built via
 * `failArgs` (the dedicated `code:"InvalidArgs"` path — NOT `failWith`, which
 * would mislabel a per-action schema violation as a generic tool error). It
 * does NOT throw — the `ToolResult` flows out through the handler's normal
 * return path (the `makeCommitWrapper` / `withRichNarration` wrappers have
 * already seen the raw `args`).
 */
export function parseActionArgsOrFail<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unionWithInclude: any,
  args: unknown,
  toolName: string,
): ParsedOrFail<T> {
  const parsed = unionWithInclude.safeParse(args);
  if (parsed.success) {
    return { ok: true, value: parsed.data as T };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawIssues = (parsed.error?.issues ?? []) as Array<any>;
  const issues = rawIssues.map((iss) => ({
    path: Array.isArray(iss.path) ? iss.path.join(".") : String(iss.path ?? ""),
    message: String(iss.message ?? "invalid"),
  }));
  const first = issues[0];
  const summary = first
    ? `${first.message}${first.path ? ` (at "${first.path}")` : ""}`
    : "invalid arguments";
  return { ok: false, result: failArgs(summary, toolName, { issues }) };
}

/** Shared description for `include` field across raw-shape and discriminatedUnion injection. */
const ENVELOPE_INCLUDE_FIELD_DESCRIPTION =
  "Optional response-shape opt-in. " +
  "`['envelope']` returns the self-documenting envelope " +
  "(`_version` / `data` / `as_of` / `confidence`). " +
  "`['raw']` forces raw shape (overrides DESKTOP_TOUCH_ENVELOPE=1 server default). " +
  "Default behaviour is raw shape (compat with existing clients).";

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
    // S5: causal include opt-in fields (caller wires via makeQueryWrapper)
    ...(options?.causedBy !== undefined ? { caused_by: options.causedBy } : {}),
    ...(options?.basedOn !== undefined ? { based_on: options.basedOn } : {}),
    // ADR-011 Phase B B-1: Working memory projection
    ...(options?.currentState !== undefined ? { current_state: options.currentState } : {}),
    // ADR-011 Phase B B-2: Episodic memory projection
    ...(options?.toolCallHistory !== undefined ? { tool_call_history: options.toolCallHistory } : {}),
    // ADR-011 Phase B B-3: Semantic memory projection
    ...(options?.learnedUiPattern !== undefined ? { learned_ui_pattern: options.learnedUiPattern } : {}),
    // ADR-011 Phase B B-4: Procedural memory projection
    ...(options?.successfulMacros !== undefined ? { successful_macros: options.successfulMacros } : {}),
    // ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved)
    ...(options?.securityTierActive !== undefined ? { security_tier_active: options.securityTierActive } : {}),
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
 * Project a PascalCase typed reason code (ADR-010 §5.4) to the
 * snake_case legacy reason field commit-tool callers were reading
 * before envelope rollout. Used in raw-mode failure compat hoist so
 * existing `{ok:false, reason:"lease_expired", ...}` clients keep
 * working when the wrapper short-circuits on a lease pre-flight
 * failure (Round 1 P1 fix per Codex / user PR review on PR #113).
 *
 * `LeaseExpired` → `lease_expired`. The S4 trunk runtime only emits
 * `LeaseExpired` and `Unknown` typed codes (residual 3 LeaseStore
 * reasons collapse to `Unknown` per sub-plan §7 R4); both project
 * cleanly via the `[a-z][A-Z]` boundary insertion.
 */
function pascalToSnake(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Raw-mode projection of a failure envelope (Round 1 P1 fix).
 *
 * Pre-S4, `desktop_act` raw-mode failures returned a structured
 * `{ok:false, reason, ...}` JSON object — clients reading
 * `result.ok` and `result.reason` work without opting into the new
 * envelope shape. The S4 commit wrapper builds a failure envelope
 * (`data:null`); naively running `compatHoist` against it returns
 * literal `null` and silently drops the reason / retry signal,
 * breaking pre-S4 raw clients.
 *
 * This helper bridges the gap: in raw mode (no `include=["envelope"]`,
 * no `DESKTOP_TOUCH_ENVELOPE=1`), failure envelopes are flattened
 * to a backward-compatible `{ok:false, reason, if_unexpected}` shape
 * that:
 *
 *   1. Preserves the legacy `ok:false` + `reason` (snake_case)
 *      contract for tools whose pre-S4 failure shape used those
 *      fields (`desktop_act` chiefly).
 *   2. Carries the typed `if_unexpected` payload so newer clients
 *      can read the typed cause + try_next without forcing them
 *      through `include=["envelope"]`.
 *
 * Envelope-opt-in callers (sub-plan §5.3) still get the full
 * envelope shape (`_version` + `data:null` + `as_of` + `confidence:
 * "stale"` + `if_unexpected`) — `compatFailureRaw` is only invoked
 * on the compat-hoist branch.
 */
export interface CompatRawFailureShape {
  ok: false;
  reason: string;
  /** Empty `SemanticDiff` array. Pre-S4 `desktop_act` callers read
   * `result.diff.length` / iterate it for change detection (e.g.
   * `entity_disappeared`, see `src/engine/world-graph/guarded-touch.ts:46-54`
   * `TouchResult` shape); without this default field a raw client's
   * `result.diff.length` would TypeError on the wrapper's pre-flight
   * failure path (Opus Round 1 review P2: §3.2 carry-over scope shrink
   * — pre-S4 public API 破壊禁止). The lease-validation failure path
   * never executes the touch, so there is no observable side effect to
   * diff against — `[]` is the correct, contract-preserving default. */
  diff: never[];
  if_unexpected: IfUnexpectedShape;
}

export function compatFailureRaw(
  envelope: EnvelopeMinimalShape<null>,
): CompatRawFailureShape {
  const ifUnexp =
    envelope.if_unexpected ?? { most_likely_cause: "Unknown", try_next: [] };
  return {
    ok: false,
    reason: pascalToSnake(ifUnexp.most_likely_cause),
    diff: [],
    if_unexpected: ifUnexp,
  };
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

// ─── ADR-020 SR-2 PR-SR2-1: handler boundary central converter ───────────────

/**
 * `toFailureEnvelope` — handler 最外周共通 pattern で使用する converter
 * (ADR-020 SR-2 PR-SR2-1、sub-plan §2 北極星 1 + §4.4).
 *
 * Signature 拡張 (sub-plan Round 2 P1-3): caller 側で
 * `optIn ? failure : compatFailureRaw(failure)` を重複しないよう helper 内に
 * raw-mode projection 統合 + `envelopeOptions` pass-through で `as_of.wallclock_ms`
 * (L1 event wallclock) 等を伝播。
 *
 * Input:
 *   - `result: Result<Ok, Err>` — Err は HandlerError 派生 typed error
 *   - `options.optIn: boolean` — envelope full shape or raw-compat shape
 *   - `options.envelopeOptions?: EnvelopeOptions` — `buildFailureEnvelope` pass-through
 * Output:
 *   - success → handler return value (Ok 型)
 *   - failure → typed error name で SUGGESTS dict lookup → `mostLikelyCause` + `tryNext`
 *     自動生成 → optIn による envelope full shape / raw-compat shape を return
 *
 * 注意: handler 内部 throw 経路は `toResultErr(e)` で `Result.err(HandlerError)`
 * に変換してから本 helper に渡す (handler 最外周共通 pattern、PR-SR2-2/-3 で
 * 29 handler に展開予定)。`failWith` 経路 (176 callsite) は本 SR-2 scope 外
 * (sub-plan §9 OQ-SR2-4 + 親 ADR §11 L10 carry-over)。
 */
export function toFailureEnvelope<Ok, Err extends HandlerError>(
  result: Result<Ok, Err>,
  options: {
    /** `optIn === true` → envelope full shape、`false` → raw-compat shape (caller 側で
     *  `optIn ? failure : compatFailureRaw(failure)` 重複しないため helper 内統合)。 */
    optIn: boolean;
    /** `buildFailureEnvelope` の `EnvelopeOptions` を pass-through
     *  (`asOfWallclockMs` 等の L1 event wallclock 経路、将来 root extras hoist 伝播)。 */
    envelopeOptions?: EnvelopeOptions;
  },
): Ok | EnvelopeMinimalShape<null> | CompatRawFailureShape {
  if (result.ok) return result.value;
  // `result.error.name` は typed error class が constructor body で設定する
  // `SUGGESTS` dict key (e.g. `"ExecutorFailed"`)。`getSuggestsForCode` (in
  // `_errors.ts`) は本 dict の正しい lookup API で、unknown code には汎用
  // fallback 配列を返す。empty fallback の場合は本 helper 側で再 fallback。
  const errorName = result.error.name;
  const tryNextStrings = getSuggestsForCode(errorName);
  const tryNext: TryNextAction[] = tryNextStrings.length > 0
    ? tryNextStrings.map((action) => ({ action }))
    : [{ action: "Inspect the underlying error and retry with adjusted args" }];
  const failure = buildFailureEnvelope(errorName, tryNext, options.envelopeOptions);
  return options.optIn ? failure : compatFailureRaw(failure);
}

/**
 * `toResultErr` — wrap a caught `unknown` throw into `Result.err(HandlerError)`.
 *
 * Use in handler 最外周 catch:
 * ```
 * try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e), {optIn}) }
 * ```
 */
export function toResultErr(e: unknown): Result<never, HandlerError> {
  if (e instanceof HandlerError) return { ok: false, error: e };
  if (e instanceof Error) {
    return { ok: false, error: new HandlerError(e.message, { cause: e }) };
  }
  return { ok: false, error: new HandlerError(String(e)) };
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

// ─── S5 per-session history buffer (sub-plan §1.1 A + §2.1) ─────────────────

/**
 * History entry per commit invocation. `defaultL1Emitter.pushStarted/Completed`
 * push entries here in addition to the L1 ring (best-effort fail-safe — L1
 * binding failure does NOT block history record so causal window
 * computation still works).
 *
 * `monotonicStartMs` (sub-plan §2.1 Round 2 P2 Opus #5 反映) is the
 * `performance.now()` reading at push time. Used by `buildCausedBy` for
 * causal window timeout calculation — system clock drift / NTP sync
 * cannot expire windows falsely (wallclock-based timeout was the Round 2
 * Opus P2 #5 finding).
 *
 * `wallclockStartMs` (`Date.now()` 由来) is kept separately for display-
 * only `caused_by.elapsed_ms` (= `wallclockEndMs - wallclockStartMs`).
 */
export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  /** L1 event_id from `l1PushToolCallStarted()` return; `undefined` when
   *  the napi push failed (telemetry best-effort). */
  eventIdStarted: bigint | undefined;
  /** L1 event_id from `l1PushToolCallCompleted()` return; `undefined` when
   *  napi push failed OR completion hasn't been recorded yet (commit
   *  in-flight). `buildCausedBy` requires this set (= `wallclockEndMs`
   *  defined) to project — in-flight events return `undefined` envelope. */
  eventIdCompleted: bigint | undefined;
  wallclockStartMs: number;
  /** `undefined` while commit is in-flight; set on `pushCompleted` hook. */
  wallclockEndMs: number | undefined;
  /** `performance.now()` at push time; used by `buildCausedBy` for
   *  monotonic causal window timeout (Round 2 P2 Opus #5 反映). */
  monotonicStartMs: number;
  /** `undefined` until completion; `true | false` from L1 emitter. */
  ok: boolean | undefined;
  /** Optional lease 4-tuple summary (sub-plan §2.3 S4 既存)、commit-axis
   *  with lease validation 経由のみ設定。 */
  leaseToken: NativeLeaseTokenSummary | undefined;
  /** ADR-011 A-3: compound commit boundary marker (e.g. `run_macro` outer
   *  event)。`true` の entry は `evictOldestNonBoundary` で FIFO eviction
   *  対象外、長 macro でも orchestration boundary が ring 内 preserve
   *  される (causal projection の anchor として `your_last_action` /
   *  `based_on.events` で参照)。`false` または `undefined` は通常 commit
   *  (FIFO eviction 対象)。default `undefined` (= 非 boundary)。 */
  isCompoundBoundary?: boolean;
  /** ADR-011 Phase B B-3: foreground window title at push time
   *  (best-effort、`pushHistoryStarted` で `nativeViewFocus.viewGetFocused()`
   *  経由で取得、null/失敗時 undefined)。Phase B plan §6.1 rule-based 抽出の
   *  pattern context として使用 (同 windowTitle で連続 N+ commit 成功 →
   *  pattern 化)。`undefined` の entry は pattern 抽出で skip (window context
   *  不明)。redact 設定 (`DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1`) で永続化時
   *  に hash 化される対象 field。 */
  windowTitle?: string;
}

interface ToolCallEventRingBuffer {
  capacity: number;
  events: ToolCallEvent[];
  /** LRU `lastAccessMs` for eviction (sub-plan §3.1 S5-1 + §6 OQ #1).
   *  Updated on every read AND write (`buildCausedBy` + `buildBasedOn`
   *  + `pushHistory*` all bump this). */
  lastAccessMs: number;
}

/**
 * Max events per session (ADR-011 Phase B B-1 land で 8 → 50 拡張、§10 OQ #1
 * 「(a) capacity 50 拡張」採用)。`layer-constraints.md §5 line 280` SSOT 既定値
 * (working memory N 上限 default 50) と整合、ADR-010 §5.6.1 既存 default
 * `working:N (N=10 default)` / `episodic:N (N=5 default)` を Phase A の causal
 * trail / boundary 保護下で安定動作させる十分余裕。
 *
 * 影響: A-3 boundary 保護下で effective capacity = 50 - boundary 件数 = 49+、
 * `evictOldestNonBoundary` 計算量 O(N) で N=50 でも許容範囲、causal trail
 * latency への影響は無視できるレベル。
 */
const HISTORY_BUFFER_CAPACITY = 50;
/** ADR-011 Phase B B-1: Working memory `include=working:N` の default 値。
 *  ADR-010 §5.6.1 P6 行 (line 383) 既定値 N=10 と整合。 */
export const WORKING_MEMORY_DEFAULT_N = 10;
/** ADR-011 Phase B B-1: Working memory N 上限。`layer-constraints §5 line 280`
 *  SSOT 既定値 50 と sync、`HISTORY_BUFFER_CAPACITY` と同値で
 *  ring overflow による silent truncate を構造的に防ぐ。 */
export const WORKING_MEMORY_N_MAX = 50;
/** ADR-011 Phase B B-2: Episodic memory `include=episodic:N` の default 値。
 *  ADR-010 §5.6.1 P6 行 (line 384) 既定値 N=5 と整合。Working (compact) と
 *  差別化、rich shape (lease_token / event_id / elapsed 等) を expose する
 *  ため per-episode size ~300B、N=5 で +1.5KB 目標 (Phase B plan §5.3)。 */
export const EPISODIC_MEMORY_DEFAULT_N = 5;
/** ADR-011 Phase B B-2: Episodic memory N 上限。`layer-constraints §5 line 281`
 *  SSOT 既定値 100 と sync。capacity 50 を超える要求は `_truncation: capacity_cap`
 *  notation で expose、N <= 100 で typed error は発火せず ring overflow
 *  notation 経路で対応 (Working と同型 truth-in-API)。 */
export const EPISODIC_MEMORY_N_MAX = 100;
/** ADR-011 Phase B B-3: Semantic memory `include=semantic:K` の default 値
 *  (Phase B plan §6.2 整合)。LLM が「過去類似 UI pattern を再利用」する用途、
 *  K=3 は recency / frequency 上位 3 pattern を expose、context 経済性
 *  優先 (rich shape ではないが pattern_id + window_title + success_rate 等
 *  で per-pattern ~400B、K=3 で +1.2KB 以内目標、Phase B plan §6.3 acceptance)。 */
export const SEMANTIC_MEMORY_DEFAULT_K = 3;
/** ADR-011 Phase B B-3: Semantic memory K 上限 (Phase B plan §6 + §10 OQ #1
 *  整合、layer-constraints §5 SSOT は B-3 着手時に Semantic 行追加予定)。
 *  pattern store 容量 (default 100 patterns) より小さい上限で envelope size
 *  budget +1.2KB 以内を構造的に保証。 */
export const SEMANTIC_MEMORY_K_MAX = 10;
/** ADR-011 Phase B B-4: Procedural memory `include=procedural:K` の default 値。
 *  少なめ (K=3) で suggest noise 抑制、用途は「最近成功した repeated workflow
 *  3 件を hint」前提。 */
export const PROCEDURAL_MEMORY_DEFAULT_K = 3;
/** ADR-011 Phase B B-4: Procedural memory K 上限 (Semantic と同 axis、
 *  outcome store 容量 100 より小さい上限で envelope size を抑制)。 */
export const PROCEDURAL_MEMORY_K_MAX = 10;
/** Max sessions in `_historyBuffers` (sub-plan §6 OQ #1 LRU eviction). */
const HISTORY_BUFFERS_MAX = 1000;
/** Per-session TTL — entries older than this are evicted on access (24 h). */
const HISTORY_BUFFER_TTL_MS = 24 * 3600 * 1000;

const _historyBuffers = new Map<string, ToolCallEventRingBuffer>();

/**
 * ADR-011 Phase B B-3 Round 2 P1-1 fix: per-session "last extracted toolCallId"
 * cursor for Semantic memory pattern extraction。同 events を query ごとに
 * 再 extract する pre-fix の bug (= `recordPattern` の `success_count +=`
 * で無限累積) を、cursor 越え events のみ slice して防ぐ。
 *
 * cursor 不在 / cursor event が ring eviction で消えた場合は best-effort
 * で ring start から scan (再 emit risk あるが fallback として許容、ring
 * capacity 50 + cursor advance 頻度から実害は限定的)。
 */
const _semanticExtractionCursors = new Map<string, string>();

/** @internal Test-only — clear per-session history buffers between cases. */
export function _resetHistoryBuffersForTest(): void {
  _historyBuffers.clear();
  _semanticExtractionCursors.clear();
}

/** @internal Test-only — inject a fully-formed history entry directly,
 *  bypassing the L1 emitter path. Used by Round 2 P2 (Opus #4) to pin
 *  the bigint→string projection at runtime when `nativeL1` is null in
 *  test environments and the production emitter would otherwise leave
 *  `eventIdStarted` / `eventIdCompleted` undefined. */
export function _seedHistoryForTest(
  sessionId: string,
  entry: ToolCallEvent,
): void {
  const ring = _historyBuffers.get(sessionId) ?? {
    capacity: HISTORY_BUFFER_CAPACITY,
    events: [],
    lastAccessMs: _historyClock(),
  };
  ring.events.push(entry);
  while (ring.events.length > ring.capacity) ring.events.shift();
  ring.lastAccessMs = _historyClock();
  _historyBuffers.set(sessionId, ring);
}

/** @internal Test seam — pin Date.now() for LRU eviction tests. */
let _historyClock: () => number = () => Date.now();
export function _setHistoryClockForTest(clock: () => number): void {
  _historyClock = clock;
}
export function _resetHistoryClockForTest(): void {
  _historyClock = () => Date.now();
}

function evictHistoryIfNeeded(): void {
  // TTL eviction (cheap on each set, bounded by Map size)
  const now = _historyClock();
  for (const [key, ring] of _historyBuffers) {
    if (now - ring.lastAccessMs > HISTORY_BUFFER_TTL_MS) {
      _historyBuffers.delete(key);
      // Round 2 Codex P2 fix: cursor lifecycle を ring eviction に同期。
      // pre-fix では `_semanticExtractionCursors` が ring 消滅後も残存 → 短命
      // session が大量発生する production deploy で Map が unbounded growth、
      // 同 sessionId 再出現時に stale cursor が fallback rescan を引き起こす。
      _semanticExtractionCursors.delete(key);
    }
  }
  // LRU eviction when capacity exceeded
  if (_historyBuffers.size <= HISTORY_BUFFERS_MAX) return;
  const sorted = [...(_historyBuffers.entries())].sort(
    (a, b) => a[1].lastAccessMs - b[1].lastAccessMs,
  );
  while (_historyBuffers.size > HISTORY_BUFFERS_MAX && sorted.length > 0) {
    const [oldestKey] = sorted.shift()!;
    _historyBuffers.delete(oldestKey);
    _semanticExtractionCursors.delete(oldestKey);
  }
}

/**
 * ADR-011 A-3: ring overflow 時の eviction で boundary entry を skip。
 *
 * 通常 FIFO は ring 先頭 (= 最古) の `isCompoundBoundary` entry を巻き込み、
 * 長 macro で outer run_macro event が消失 → `your_last_action` が最終 step
 * に collapse する (ADR-010 §11 OQ #9 / walking-skeleton-expansion-plan §6.1
 * #3 で記述された不整合)。
 *
 * 本 helper は events 配列の先頭から **最古の非 boundary entry** を 1 件
 * 削除する。全 entry が boundary の degraded ケース (本 plan non-goal、
 * `TOOL_REGISTRY` で run_macro recursion 防止済 — `macro.ts:354` 除外定義
 * + `macro.ts:404-409` runtime guard) では fallback で旧 FIFO に戻す
 * (panic 回避、causal projection は最古 boundary を失うが degraded UX は
 * 受容可能)。
 *
 * 呼び出し側は `while (ring.events.length > ring.capacity)` ループで使う —
 * 1 回呼び出しで 1 件削除のため、複数 overflow 時はループで連続呼出する。
 */
function evictOldestNonBoundary(events: ToolCallEvent[]): void {
  const idx = events.findIndex((e) => e.isCompoundBoundary !== true);
  if (idx >= 0) {
    events.splice(idx, 1);
    return;
  }
  // Degraded fallback: 全 entry が boundary (= 非常稀、現行 recursion 防止下では
  // 発生不可)。infinite loop を避けるため旧 FIFO で先頭 1 件 evict。
  events.shift();
}

function pushHistoryStarted(args: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  eventIdStarted: bigint | undefined;
  wallclockStartMs: number;
  monotonicStartMs: number;
  leaseToken: NativeLeaseTokenSummary | undefined;
  /** ADR-011 A-3: mark this entry as a compound commit boundary —
   *  protected from FIFO eviction so long macros preserve orchestration
   *  boundary in causal projection. */
  isCompoundBoundary?: boolean;
  /** ADR-011 Phase B B-3: foreground window title at push time
   *  (best-effort、Phase B sub-plan §6.1 rule-based pattern 抽出 context、
   *  undefined 時 pattern 抽出で run 中断 = window 不明 entry は skip)。 */
  windowTitle?: string;
}): void {
  const now = _historyClock();
  let ring = _historyBuffers.get(args.sessionId);
  if (!ring) {
    ring = { capacity: HISTORY_BUFFER_CAPACITY, events: [], lastAccessMs: now };
    _historyBuffers.set(args.sessionId, ring);
    evictHistoryIfNeeded();
  }
  ring.events.push({
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    argsSummary: args.argsSummary,
    eventIdStarted: args.eventIdStarted,
    eventIdCompleted: undefined,
    wallclockStartMs: args.wallclockStartMs,
    wallclockEndMs: undefined,
    monotonicStartMs: args.monotonicStartMs,
    ok: undefined,
    leaseToken: args.leaseToken,
    isCompoundBoundary: args.isCompoundBoundary,
    windowTitle: args.windowTitle,
  });
  // ADR-011 A-3: ring overflow は `evictOldestNonBoundary` 経由で boundary
  // entry を skip。`_seedHistoryForTest` は test-only seam で boundary
  // なし前提のため旧 `events.shift()` を維持 (plan §4.3.1)。
  while (ring.events.length > ring.capacity) evictOldestNonBoundary(ring.events);
  ring.lastAccessMs = now;
}

function pushHistoryCompleted(args: {
  sessionId: string;
  toolCallId: string;
  eventIdCompleted: bigint | undefined;
  wallclockEndMs: number;
  ok: boolean;
}): void {
  const ring = _historyBuffers.get(args.sessionId);
  if (!ring) return; // unmatched (race or eviction) — best-effort silent
  const entry = ring.events.find((e) => e.toolCallId === args.toolCallId);
  if (!entry) return; // entry already evicted by ring overflow
  entry.eventIdCompleted = args.eventIdCompleted;
  entry.wallclockEndMs = args.wallclockEndMs;
  entry.ok = args.ok;
  ring.lastAccessMs = _historyClock();
}

/**
 * ADR-011 A-3: causal projection の anchor 選択ロジック。
 *
 * `buildCausedBy` / `buildBasedOn` 共有 — eviction skip だけでは
 * acceptance (`your_last_action = outer run_macro event`) は達成不可。
 * ring 先頭に boundary preserved outer event が居て、末尾に最終 step
 * が居るケースで、既存「ring 末尾 1 件参照」では `lastEvent = 最終 step`
 * となり causal anchor が orchestration boundary を失う。
 *
 * 本 helper は以下の優先順位で anchor entry を選択:
 *
 *   (1) ring 内に **完了済 boundary entry** が存在 → 末尾 (LIFO) を採用。
 *       複数 boundary 同時 (本 plan non-goal、現行 recursion 防止下では
 *       発生不可) では最新の orchestration が causal continuity を最も
 *       表現する。`wallclockEndMs` 未確定 (long-running outer 中、step
 *       後続未発火) の boundary は skip — outer 完了済 + step 後続のみ
 *       projection 対象 (plan §6 acceptance「compound boundary 完了
 *       invariant」)。
 *
 *   (2) 完了済 boundary 不在 (= 通常の commit のみ、boundary 未注入) →
 *       既存挙動維持で **ring 末尾 1 件** を採用。step ≤ capacity
 *       ケースで挙動完全不変 (regression 防止)。
 *
 * 呼び出し側 (`buildCausedBy` / `buildBasedOn`) は本 helper の戻り値を
 * 受領後に既存の `wallclockEndMs === undefined` skip / monotonic timeout
 * (右端 (b)) / frontier check (右端 (a)) を順に適用する。
 */
function selectLastEventForCausalProjection(
  events: ToolCallEvent[],
  options?: { causalWindowTimeoutMs?: number; nowMonotonic?: number },
): ToolCallEvent | undefined {
  if (events.length === 0) return undefined;
  const timeoutMs = options?.causalWindowTimeoutMs ?? 200;
  const nowMonotonic = options?.nowMonotonic ?? performance.now();

  // (1) 完了済 boundary entry を末尾優先 (LIFO) で探索
  let latestCompletedBoundary: ToolCallEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.isCompoundBoundary === true && e.wallclockEndMs !== undefined) {
      latestCompletedBoundary = e;
      break;
    }
  }

  // (2) A-4 retrospective fix (Codex P1 #1、PR #157 follow-up): 完了済
  //     boundary が causal window 内なら採用、timeout 切れなら **boundary
  //     を anchor から外して末尾 fallback** (旧挙動: timeout 切れ boundary
  //     を anchor 採用 → buildCausedBy が undefined return → ring 末尾の
  //     新しい通常 commit が **shadow されて消失** する runtime regression)。
  //
  //     具体シナリオ: run_macro 完了直後 250ms 経過後の通常 mouse_click 発火 →
  //     - 旧: boundary B (250ms 古い) を anchor、buildCausedBy が timeout 切れで undefined
  //     - 新: B が timeout 切れ → 末尾 mouse_click を anchor、causal projection 維持
  //
  //     boundary が causal window 内に居る間は LIFO 優先選択を維持
  //     (orchestration boundary anchor 設計、A-3 plan §4.3.5 整合)。
  if (
    latestCompletedBoundary !== undefined &&
    nowMonotonic - latestCompletedBoundary.monotonicStartMs <= timeoutMs
  ) {
    return latestCompletedBoundary;
  }

  // (3) boundary 不在 / boundary timeout 切れ → 末尾 fallback (既存挙動維持)
  return events[events.length - 1];
}

// ─── S5 caused_by + based_on + produced_changes projection (sub-plan §2.2-§2.3) ──

/**
 * Build `caused_by` 4 field projection from per-session history buffer.
 *
 * sub-plan §2.2 Round 3 P1 Opus #1 反映で 4 field 構成 (based_on は envelope
 * top-level `BasedOnShape` で別途、`buildBasedOn` 並列呼出)。
 *
 * Causal window:
 *   - 左端: ToolCallStarted event_id (history entry の `eventIdStarted`)
 *   - 右端 (a) frontier: `viewSnapshot.latestEventId` (Round 2 Codex P1 #2 反映で
 *     `eventIdCompleted > latestEventId` で undefined return = unrelated UI
 *     change の attribution 防止)
 *   - 右端 (b) timeout: monotonic 200ms (Round 2 Opus P2 #5 反映、Round 3 で
 *     `performance.now()` 軸 confirm)
 *   - 右端 (c) first stable observation: carry-over (sub-plan §6 OQ #2)
 *
 * 戻り値: `undefined` when (history empty / commit in-flight / window expired
 * / frontier 未到達) — caller (makeQueryWrapper) 受領時 envelope.caused_by
 * field を omit (raw client 互換)。
 */
export function buildCausedBy(
  sessionId: string,
  viewSnapshot: ViewSnapshot,
  options?: { causalWindowTimeoutMs?: number; monotonicNowMs?: () => number },
): CausedByShape | undefined {
  const ring = _historyBuffers.get(sessionId);
  if (!ring || ring.events.length === 0) return undefined;
  ring.lastAccessMs = _historyClock();
  // Round 2 P2 Opus #5: monotonic 軸 timeout (system clock drift 非依存)
  // A-4 retrospective fix (Codex P1 #1、PR #157 follow-up): timeout を helper
  // に渡して boundary が timeout 切れの場合は末尾 fallback、stale boundary
  // shadow を構造的解消。
  const timeoutMs = options?.causalWindowTimeoutMs ?? 200;
  const nowMonotonic = options?.monotonicNowMs?.() ?? performance.now();
  // ADR-011 A-3 + A-4 fix: boundary 優先 + 完了済 + timeout 内 + 末尾 fallback
  // で causal anchor を選択 (long macro で outer run_macro が ring 内
  // preserved されている間は orchestration boundary を anchor、timeout 切れ
  // boundary は ring 末尾の新しい commit に shadow されないよう fallback)
  const lastEvent = selectLastEventForCausalProjection(ring.events, {
    causalWindowTimeoutMs: timeoutMs,
    nowMonotonic,
  });
  if (!lastEvent || lastEvent.wallclockEndMs === undefined) return undefined; // commit in-flight

  if (nowMonotonic - lastEvent.monotonicStartMs > timeoutMs) {
    return undefined; // window expired (右端 (b) safety net、selected lastEvent も timeout 内であることを再確認)
  }

  // Round 2 P1 Codex: latestEventId frontier check (右端 (a) runtime enforce)
  if (
    viewSnapshot.latestEventId !== undefined &&
    lastEvent.eventIdCompleted !== undefined &&
    lastEvent.eventIdCompleted > viewSnapshot.latestEventId
  ) {
    return undefined; // frontier がまだ commit completion に追いついていない
  }

  return {
    your_last_action: `${lastEvent.toolName}(${lastEvent.argsSummary})`,
    tool_call_id: lastEvent.toolCallId,
    elapsed_ms: lastEvent.wallclockEndMs - lastEvent.wallclockStartMs,
    produced_changes: buildProducedChanges(viewSnapshot),
  };
}

/**
 * Build envelope top-level `based_on` from per-session history buffer
 * (architecture §8.2 line 355-356 L1 start / L2 end 責務マトリクス整合、
 * sub-plan §2.2 Round 3 P1 Opus #1 反映で `CausedByShape` から分離).
 *
 * `events` は u64 decimal `string[]` で表現 (Round 3 P1 Codex line 370
 * 反映、bigint JSON.stringify TypeError 完全回避)。
 *
 * **Round 2 P2 (Codex line 1073) fix**: Apply the same causal window
 * guards as `buildCausedBy` (frontier check + monotonic timeout) so
 * `based_on` cannot outlive `caused_by`. Without this, `caused_by`
 * would correctly disappear after window expiry but `based_on` would
 * keep returning the latest history entry, leaving the envelope in an
 * inconsistent state where the LLM sees event references with no
 * causal context.
 *
 * 戻り値: `undefined` when (history empty / commit in-flight / window
 * expired / frontier 未到達) — caller が envelope.based_on field を omit。
 */
export function buildBasedOn(
  sessionId: string,
  viewSnapshot: ViewSnapshot,
  options?: { causalWindowTimeoutMs?: number; monotonicNowMs?: () => number },
): BasedOnShape | undefined {
  const ring = _historyBuffers.get(sessionId);
  if (!ring || ring.events.length === 0) return undefined;
  ring.lastAccessMs = _historyClock();
  // Round 2 P2 (Codex line 1073) fix: same causal window guards as
  // `buildCausedBy` so `based_on` / `caused_by` never diverge.
  // A-4 retrospective fix (Codex P1 #1 同型): timeout を helper に渡して
  // boundary が timeout 切れの場合は末尾 fallback、`buildCausedBy` と
  // bit-equal 動作 (helper DRY 共有原則維持)。
  const timeoutMs = options?.causalWindowTimeoutMs ?? 200;
  const nowMonotonic = options?.monotonicNowMs?.() ?? performance.now();
  // ADR-011 A-3 + A-4 fix: `buildCausedBy` と同型 anchor 選択 (boundary 優先 +
  // 完了済 + timeout 内 + 末尾 fallback)。`buildCausedBy` / `buildBasedOn`
  // で divergence が起きると envelope 上で `your_last_action` と
  // `based_on.events` が指し示す trail が別物になるため、helper を共有
  // (DRY + bit-equal、A-4 timeout 引数も同 contract で渡す)。
  const lastEvent = selectLastEventForCausalProjection(ring.events, {
    causalWindowTimeoutMs: timeoutMs,
    nowMonotonic,
  });
  if (!lastEvent || lastEvent.wallclockEndMs === undefined) return undefined;

  if (nowMonotonic - lastEvent.monotonicStartMs > timeoutMs) {
    return undefined;
  }
  if (
    viewSnapshot.latestEventId !== undefined &&
    lastEvent.eventIdCompleted !== undefined &&
    lastEvent.eventIdCompleted > viewSnapshot.latestEventId
  ) {
    return undefined;
  }

  const events: string[] = [];
  if (lastEvent.eventIdStarted !== undefined) events.push(String(lastEvent.eventIdStarted));
  if (lastEvent.eventIdCompleted !== undefined) events.push(String(lastEvent.eventIdCompleted));

  // sources: produced_changes 由来動的 build (Round 2 P2 Opus #3、UIA = focus,
  // DXGI = dirty_rect 観測駆動)
  const producedChanges = buildProducedChanges(viewSnapshot);
  const sources: string[] = [];
  if (producedChanges.some((c) => c.startsWith("focus:"))) sources.push("UIA");
  if (producedChanges.some((c) => c.startsWith("dirty_rects["))) sources.push("DXGI");

  return { events, sources };
}

// ─── ADR-011 Phase B: include memory layer parsing helper ──────────────────

/**
 * Parse `include` array for memory layer requests (B-1 working、B-2 episodic、
 * B-3 semantic、B-4 procedural)。
 *
 * 形式 (Phase B plan §4.1 / §5.1 / §6.1 / §7.1):
 *   - `"<layer>"` (N 省略) → `defaultN` 採用
 *   - `"<layer>:N"` (explicit) → parseInt(N)、parse 失敗時 / N < 0 で `defaultN` fallback
 *   - layer 名 不在 → `undefined` (skip projection、layer expose しない)
 *
 * ADR-010 §6 line 414 example `desktop_state(include=["working:10","episodic:5","causal","invariants"])`
 * と整合、layer ごとに独立 N axis を許容。
 */
export function parseIncludeMemoryN(
  include: string[] | undefined,
  layerName: string,
  defaultN: number,
): number | undefined {
  if (!include) return undefined;
  for (const entry of include) {
    if (entry === layerName) return defaultN;
    if (entry.startsWith(`${layerName}:`)) {
      const nStr = entry.slice(layerName.length + 1);
      const n = Number.parseInt(nStr, 10);
      if (Number.isFinite(n) && n >= 0) return n;
      return defaultN;
    }
  }
  return undefined;
}

// ─── ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved) ──────────
//
// **設計**: env (operator ceiling) + LLM `include` axis (per-call request) の
// 二重 axis、effective = security floor 原則 (より strict 側へだけ動かせる)。
// LLM は env を **open 側へ超えられない** = security-fail-safe。
//
// **実装範囲 (本 PR scope per user 諮問 2026-05-07)**: tier resolver +
// `envelope.security_tier_active` field + B-3 semantic redact gate + B-4
// procedural expose gate のみ。JSON persistence / storage backend は touch
// しない (env-controlled at write time、include は per-query expose mask)。

/**
 * Memory security tier ID (LLM 観測可、`envelope.security_tier_active.tier`
 * field で expose)。
 */
export type SecurityTier = "strict" | "balanced" | "open";

/** Effective security knobs (本 query call で実際に適用される値)。 */
export interface SecurityTierEffective {
  /** B-3 semantic projection で window_title を hash redact するか */
  redact_window_titles: boolean;
  /** disk persist が active か (env-controlled、include で関係なし、display 用) */
  persist: boolean;
  /** B-4 procedural projection が expose されるか */
  procedural: "expose" | "off";
}

/** envelope.security_tier_active field shape (LLM expose 用)。 */
export interface SecurityTierActive {
  tier: SecurityTier;
  effective: SecurityTierEffective;
}

/**
 * Parse `include` array for `memory_strict` / `memory_balanced` / `memory_open`
 * keyword (per-call security tier request)。`parseIncludeMemoryN` は N 値解析
 * 専用、本 helper は keyword 解析専用 (B-4 着手時 user 諮問 2026-05-07 で
 * helper 分離 = option (b) 採用)。
 *
 * 形式: `include: ["memory_strict"]` → "strict" / `["memory_balanced"]` →
 * "balanced" / `["memory_open"]` → "open" / 不在 → undefined (= balanced
 * default で resolve)。複数 keyword 並走時は **最初の match を採用** (LLM
 * 側で混在 request しない前提、最初に書いた方を尊重)。
 */
export function parseIncludeMemorySecurity(
  include: string[] | undefined,
): SecurityTier | undefined {
  if (!include) return undefined;
  for (const entry of include) {
    if (entry === "memory_strict") return "strict";
    if (entry === "memory_balanced") return "balanced";
    if (entry === "memory_open") return "open";
  }
  return undefined;
}

/**
 * Resolve effective security tier from per-call request + env ceiling。
 *
 * **原則** (security floor):
 *   - `strict` = LLM 側 explicit 最大 security 要求 → env 設定無視で
 *     redact ON / persist OFF (display) / procedural OFF 強制
 *   - `balanced` (default) = env 設定踏襲、env 既定値が effective
 *   - `open` = env ceiling 範囲内で最大 expose、binary axes (redact/persist)
 *     では balanced と同等 (env=ON は env=OFF にできない、env=OFF は env=ON
 *     にできない、LLM は env を open 側へ超えられない fail-safe)
 *
 * **scope (本 PR、JSON persistence は touch しない)**:
 *   - `redact_window_titles`: B-3 projection で window_title hash redact
 *   - `persist`: env_persist の display (env-controlled、include で実際に
 *     OFF にできない、strict 時は LLM への report のみ false)
 *   - `procedural`: B-4 projection が `successful_macros` を expose するか
 *
 * `request === undefined` (= include に memory_* keyword なし) は
 * "balanced" 既定として扱う、`balanced.effective` = env 既定値踏襲。
 */
export function resolveEffectiveSecurityTier(
  request: SecurityTier | undefined,
  env: { persist: boolean; redact: boolean },
): SecurityTierActive {
  const tier: SecurityTier = request ?? "balanced";
  let redact: boolean;
  let persist: boolean;
  let procedural: "expose" | "off";
  switch (tier) {
    case "strict":
      // strict = LLM が「この call は最大 security」と explicit 要求、env 設定
      // 無視で max 化 (より strict 側へは常に動かせる、security 原則)
      redact = true;
      persist = false;
      procedural = "off";
      break;
    case "balanced":
    case "open":
      // balanced/open = env 既定値踏襲、env を open 側へ超えられない原則
      // (env=redact_ON は include=open で OFF にできない、env=persist_OFF は
      // include=open で ON にできない)。binary axes では現状 balanced と open
      // が effective 同等、tier 名は LLM 観測値として保持 (将来 graduated
      // axis 追加時に diverge 余地)。
      redact = env.redact;
      persist = env.persist;
      procedural = "expose";
      break;
  }
  return {
    tier,
    effective: {
      redact_window_titles: redact,
      persist,
      procedural,
    },
  };
}

// ─── ADR-011 Phase B B-1: Working memory projection ─────────────────────────

/**
 * Compact summary of a `ToolCallEvent` for Working memory projection
 * (`current_state.recent_events`、ADR-011 Phase B B-1 view 構造)。
 *
 * Episodic memory (B-2) は `_envelope.ts:ToolCallEvent` の rich shape を
 * そのまま expose する設計のため、本 interface は **意図的に薄い**
 * (Working = compact、Episodic = rich の差別化、Phase B plan §4.1)。
 *
 *   - tool_call_id: sessionId:seq 形式 (`nextToolCallId`)
 *   - tool: tool name
 *   - args_summary: 64 char truncated (Episodic の 512 char より短い)
 *   - ok: completed only / undefined for in-flight
 *   - is_compound: A-3 boundary flag (true なら inner step は集約表示)
 */
export interface ToolCallEventSummary {
  tool_call_id: string;
  tool: string;
  args_summary: string;
  ok: boolean | undefined;
  is_compound: boolean;
}

/**
 * Truncation notation (Phase B plan §4.3 acceptance、ADR-010 §5.6.1
 * truncation 規約整合)。`projectWorkingMemory` が ring underflow / capacity
 * cap で N 要求未満の件数しか返せない場合、`_truncation` field を envelope
 * に付与して silently truncate を防ぐ (truth-in-API 維持)。
 */
export interface TruncationNotation {
  requested: number;
  returned: number;
  reason: "ring_underflow" | "capacity_cap";
}

/** Working memory projection 戻り値 (recent_events + 任意 _truncation)。
 *  field 名 `recent_events` は ADR-010 §6 line 406 view name `current_state`
 *  + Phase B plan §4 の documented contract `current_state.recent_events`
 *  と sync (Round 1 Codex P1 反映: 旧 field 名 `events` は API contract
 *  違反で LLM client が受信できない盲点を解消、Phase A PR #158 同型
 *  pattern = Codex 単独 API contract regression 検出)。 */
export interface WorkingMemoryProjection {
  recent_events: ToolCallEventSummary[];
  _truncation?: TruncationNotation;
}

/**
 * Project Working memory (recent N event compact) from per-session history
 * buffer (ADR-011 Phase B B-1).
 *
 * 戻り値:
 *   - sentinel `multi:disabled` → `undefined` (skip working memory expose、
 *     A-2 sentinel runtime closed loop と整合)
 *   - history ring 不在 / 0 件 → `{ recent_events: [] }` (empty projection、
 *     `_truncation` なし、ring underflow とは区別)
 *   - 通常: ring 末尾から **最大 N 件** の events を新しい順で抽出 (LIFO)、
 *     ring 内件数 < N の場合は全件 + `_truncation: { reason: "ring_underflow" }`、
 *     N > capacity の場合は capacity 件 + `_truncation: { reason: "capacity_cap" }`
 *
 * 注意点:
 *   - causal trail (`buildCausedBy`) の boundary 優先 LIFO anchor とは
 *     **独立**、Working memory は ring 末尾 N 件を素直に新しい順で出す
 *     (boundary 保護は eviction 段階で既に効いている)
 *   - Episodic memory (B-2) と同 ring を共有、projection shape のみ
 *     異なる (Phase B plan §3.3 storage 表)
 */
export function projectWorkingMemory(
  sessionId: string,
  n: number,
): WorkingMemoryProjection | undefined {
  if (sessionId === "multi:disabled") return undefined;
  const ring = _historyBuffers.get(sessionId);
  if (!ring) return { recent_events: [] };
  ring.lastAccessMs = _historyClock();

  const ringSize = ring.events.length;
  if (ringSize === 0) return { recent_events: [] };

  // capacity_cap: N が ring capacity を超える要求 (silently truncate 防止)
  const cappedN = Math.min(n, ring.capacity);
  // 実際に返せる件数: min(要求 N, ring 内件数)
  const returnedCount = Math.min(cappedN, ringSize);

  // ring 末尾から returnedCount 件を **新しい順** (LIFO) で抽出
  const recentEvents: ToolCallEventSummary[] = [];
  for (let i = ringSize - 1; i >= ringSize - returnedCount; i--) {
    const e = ring.events[i];
    recentEvents.push({
      tool_call_id: e.toolCallId,
      tool: e.toolName,
      args_summary: e.argsSummary.length > 64 ? e.argsSummary.slice(0, 64) : e.argsSummary,
      ok: e.ok,
      is_compound: e.isCompoundBoundary === true,
    });
  }

  // _truncation notation 判定 (Phase B plan §4.3 acceptance)
  // 注意: B-1 land 時点では `WORKING_MEMORY_N_MAX === HISTORY_BUFFER_CAPACITY === 50`
  // のため、makeQueryWrapper s5 path で N > N_MAX を typed error short-circuit
  // するロジックが先に発火 (Round 1 Opus P2-4 関連)。本 helper の `n > ring.capacity`
  // 経路は **wrapper 経由では unreachable** (typed error path に吸収)、
  // `_seedHistoryForTest` 経由 / `projectWorkingMemory` 直接呼出 / 将来 N_MAX >
  // capacity に拡張する場合の **forward-compatible safety net** として保持。
  // 意図的 dead-code-near (test pin あり、B-1-6 で 60 件 push synthetic 経路)。
  let truncation: TruncationNotation | undefined;
  if (n > ring.capacity) {
    truncation = { requested: n, returned: recentEvents.length, reason: "capacity_cap" };
  } else if (returnedCount < n) {
    // ring 内件数 < N (ring underflow)
    truncation = { requested: n, returned: recentEvents.length, reason: "ring_underflow" };
  }

  return truncation === undefined
    ? { recent_events: recentEvents }
    : { recent_events: recentEvents, _truncation: truncation };
}

// ─── ADR-011 Phase B B-2: Episodic memory projection ────────────────────────

/**
 * Rich shape projection of a `ToolCallEvent` for Episodic memory
 * (`tool_call_history.episodes`、ADR-011 Phase B B-2 view 構造、Phase B
 * plan §5.2)。
 *
 * Working memory (`ToolCallEventSummary`、5 field compact) と差別化、
 * `ToolCallEvent` の **完全 shape** を expose:
 *   - tool_call_id / tool / args_summary 512 char (B-1 64 char より rich)
 *   - ok: completed only (in-flight skip、Working は ok undefined 許容)
 *   - started_at_ms / elapsed_ms (wallclock 可視化、LLM の causal trail
 *     再現に有用)
 *   - is_compound: A-3 boundary flag
 *   - lease_token_summary: `${entityId}/${viewId}@${targetGeneration}#${digest8}`
 *     compact format (PII safe redact、機密 field 不在の internal id のみ)
 *   - event_id_started / event_id_completed: u64 decimal string (Phase A
 *     bigint→string SSOT 整合、ADR-010 §8.2 + PR #115 architecture lock)
 */
export interface EpisodeSummary {
  tool_call_id: string;
  tool: string;
  args_summary: string;
  ok: boolean;
  started_at_ms: number;
  elapsed_ms: number;
  is_compound: boolean;
  lease_token_summary?: string;
  event_id_started?: string;
  event_id_completed?: string;
}

/** Episodic memory projection 戻り値 (`episodes` field、Phase B plan §5.2
 *  documented contract `tool_call_history.episodes` 整合)。 */
export interface EpisodicMemoryProjection {
  episodes: EpisodeSummary[];
  _truncation?: TruncationNotation;
}

/**
 * Format `NativeLeaseTokenSummary` 4 field as a compact PII-safe string
 * (Phase B plan §5.2)。
 *
 * 形式: `${entityId}/${viewId}@${targetGeneration}#${digestPrefix8}`
 *   - 全 field は internal id (`entityId` / `viewId`) または derived hash
 *     (`digestPrefix8`) で機密情報なし
 *   - 空 lease token は `undefined` return (Working との並列で field 省略)
 *
 * Phase A の `mapLeaseValidationToTypedReason` (`_envelope.ts:710-729`) と
 * 同型な safe redact pattern。
 */
function formatLeaseTokenSummary(
  token: NativeLeaseTokenSummary | undefined,
): string | undefined {
  if (!token) return undefined;
  return `${token.entityId}/${token.viewId}@${token.targetGeneration}#${token.evidenceDigestPrefix8}`;
}

/**
 * Project Episodic memory (recent N completed event rich shape) from
 * per-session history buffer (ADR-011 Phase B B-2)。
 *
 * Working memory と **同 ring を共有** (`_historyBuffers`)、projection shape
 * のみ rich 化 (Phase B plan §3.3 storage 表)。
 *
 * 戻り値:
 *   - sentinel `multi:disabled` → `undefined` (skip、A-2 closed loop 整合)
 *   - history ring 不在 / 0 件 → `{ episodes: [] }` (empty projection)
 *   - 通常: 完了済 entry (`wallclockEndMs !== undefined && ok !== undefined`) を
 *     ring 末尾から **新しい順** (LIFO) で抽出、in-flight (commit 進行中)
 *     entry は skip。Working との差別化 (Working は ok undefined 含む =
 *     in-flight 許容)。
 *   - ring 内完了済件数 < N → `_truncation: ring_underflow`
 *   - N > capacity → `_truncation: capacity_cap` (forward-compat、現状
 *     N_MAX (= 100) > capacity (= 50) なので発火しうる経路、B-2 land では
 *     truncation notation で truth-in-API 維持)
 */
export function projectEpisodicMemory(
  sessionId: string,
  n: number,
): EpisodicMemoryProjection | undefined {
  if (sessionId === "multi:disabled") return undefined;
  const ring = _historyBuffers.get(sessionId);
  if (!ring) return { episodes: [] };
  ring.lastAccessMs = _historyClock();

  const ringSize = ring.events.length;
  if (ringSize === 0) return { episodes: [] };

  // 完了済 entry のみ抽出 (in-flight skip、Working との差別化)。
  // ring 末尾から探索、LIFO で returnedCount 件まで集める。
  // Round 1 Opus P2-1 反映: 旧 `inflightSkipped` counter は **dead intent**
  // (戻り値 / truncation / log いずれにも反映されない) で削除。
  // Phase B plan §5.3 acceptance に「in-flight skip 件数 expose」要件なし、
  // `ring_underflow` notation で件数差分は既に検出可能 (将来 in-flight 件数
  // expose を追加する場合は別 OQ で議論)。
  const cappedN = Math.min(n, ring.capacity);
  const episodes: EpisodeSummary[] = [];
  for (let i = ringSize - 1; i >= 0 && episodes.length < cappedN; i--) {
    const e = ring.events[i];
    if (e.wallclockEndMs === undefined || e.ok === undefined) {
      continue;
    }
    episodes.push({
      tool_call_id: e.toolCallId,
      tool: e.toolName,
      args_summary: e.argsSummary.length > 512 ? e.argsSummary.slice(0, 512) : e.argsSummary,
      ok: e.ok,
      started_at_ms: e.wallclockStartMs,
      elapsed_ms: e.wallclockEndMs - e.wallclockStartMs,
      is_compound: e.isCompoundBoundary === true,
      ...(e.leaseToken !== undefined
        ? { lease_token_summary: formatLeaseTokenSummary(e.leaseToken) }
        : {}),
      ...(e.eventIdStarted !== undefined ? { event_id_started: String(e.eventIdStarted) } : {}),
      ...(e.eventIdCompleted !== undefined
        ? { event_id_completed: String(e.eventIdCompleted) }
        : {}),
    });
  }

  // _truncation notation 判定 (Phase B plan §5.3 acceptance、B-1 と同型ロジック)
  // 注意: 完了済 entry のみ抽出のため、`returned < requested` には ring 内
  // **完了済件数不足** (in-flight 含む) と **capacity_cap** の両 case がある。
  // 本実装は capacity_cap (n > ring.capacity) を優先判定、それ以外で
  // ring_underflow (実件数 < 要求 N、in-flight skip 含む) として明示。
  let truncation: TruncationNotation | undefined;
  if (n > ring.capacity) {
    truncation = { requested: n, returned: episodes.length, reason: "capacity_cap" };
  } else if (episodes.length < n) {
    // ring 内に完了済 N 件が揃わなかった (in-flight skip / ring 件数不足)
    truncation = { requested: n, returned: episodes.length, reason: "ring_underflow" };
  }

  return truncation === undefined
    ? { episodes }
    : { episodes, _truncation: truncation };
}

// ─── ADR-011 Phase B B-3: Semantic memory projection ───────────────────────

/**
 * Pattern summary projection for Semantic memory
 * (`learned_ui_pattern.patterns`、Phase B plan §6.2 整合)。
 *
 * 抽出: rule-based — 同 `windowTitle` で連続 N=3+ commit `ok=true` を
 * 1 pattern として記録、tool sequence (上位 3 件) を `example_actions` に
 * 集約。LLM が「過去類似 UI を操作した経験」を hint 化する用途。
 *
 *   - pattern_id: hash(windowTitle + tool_sequence_signature)、dedupe key
 *   - window_title: foreground window 名 (raw、redact env で hash 化、永続化
 *     時のみ実害、in-memory only では generic safe)
 *   - step_count: pattern 内 commit 数
 *   - last_seen_at_ms: 最終観測時刻 (LRU 用)
 *   - success_rate: 過去観測 success_count / total observations
 *   - example_actions: tool name 上位 3 件 (frequency 順)
 */
export interface UiPatternSummary {
  pattern_id: string;
  window_title: string;
  step_count: number;
  last_seen_at_ms: number;
  success_rate: number;
  example_actions: string[];
}

/** Semantic memory projection 戻り値 (`patterns` field、Phase B plan §6.2
 *  documented contract `learned_ui_pattern.patterns` 整合)。 */
export interface SemanticMemoryProjection {
  patterns: UiPatternSummary[];
  _truncation?: TruncationNotation;
}

/**
 * Internal pattern record (in-memory store unit、`src/store/ui-pattern-store.ts`
 * で LRU 管理)。`UiPatternSummary` の **拡張**: success_count / failure_count
 * を内部保持して success_rate を runtime computed (新 observation で update)。
 */
export interface UiPatternRecord {
  pattern_id: string;
  window_title: string;
  step_count: number;
  last_seen_at_ms: number;
  success_count: number;
  failure_count: number;
  example_actions: string[];
}

/**
 * 32-bit FNV-1a hash (collision-tolerant deterministic、no crypto import 不要)。
 * windowTitle fingerprint / redact 両用、LRU 100 規模では衝突確率十分低
 * (1 - exp(-100²/2³³) ≈ 1.16e-6)。
 *
 * Round 2 P2-4 fix: pre-fix の `windowTitle.slice(0, 32)` は長 path window
 * (e.g. `C:\Users\.../very-long-filename-N.txt - Notepad`) で先頭 32 char
 * 一致による誤 merge risk があったため、full string を hash 化して衝突空間を
 * 32-bit に拡大 (`step_count` 上書き隠蔽 risk 構造的解消)。
 */
function fnv1aHash16(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime: 16777619
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Compute pattern fingerprint for dedupe (window_title hash + tool sequence
 * signature)。
 *
 * 形式: `${fnv1aHash16(windowTitle)}::${tools.slice(0, 8).join("→")}`
 *   - windowTitle は full string FNV-1a hash → 長 path window 先頭一致による
 *     誤 merge を構造的に解消 (Round 2 P2-4 fix)
 *   - tool sequence は最大 8 commit まで signature に使用 (それ以上は
 *     pattern boundary が異なると判定)
 */
function computePatternFingerprint(
  windowTitle: string,
  tools: string[],
): string {
  const wtHash = fnv1aHash16(windowTitle);
  const toolSeq = tools.slice(0, 8).join("→");
  return `${wtHash}::${toolSeq}`;
}

/**
 * Extract `UiPatternRecord[]` from history ring by rule-based detection
 * (Phase B plan §6.1)。
 *
 * Rule: ring 内で **同 `windowTitle` で連続 N=3+ commit `ok=true`** を
 * 1 pattern として記録。run 中断 (windowTitle 変化、ok=false、windowTitle
 * undefined) で run reset、ring 末尾の run も拾う。
 *
 * 抽出は **on-demand** (query 時 scan)、commit-time の overhead 増を
 * 回避。pattern store 側で dedupe + success/failure count update を行う
 * (本 helper は pattern record を生成するのみ、store 更新は呼び出し側責務)。
 */
export function extractSemanticPatterns(
  events: ToolCallEvent[],
  options?: { minStepCount?: number; nowMs?: number },
): UiPatternRecord[] {
  const minStepCount = options?.minStepCount ?? 3;
  const nowMs = options?.nowMs ?? Date.now();
  const records: UiPatternRecord[] = [];

  let runStart = -1;
  let runWindow: string | undefined = undefined;

  const flushRun = (start: number, end: number, window: string): void => {
    const run = events.slice(start, end);
    if (run.length < minStepCount) return;
    // pattern_id は windowTitle + tool seq signature
    const tools = run.map((e) => e.toolName);
    const fingerprint = computePatternFingerprint(window, tools);
    // example_actions: tool name frequency 上位 3 件 (順序保持)
    const toolFreq = new Map<string, number>();
    for (const t of tools) toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1);
    const exampleActions = [...toolFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    records.push({
      pattern_id: fingerprint,
      window_title: window,
      step_count: run.length,
      last_seen_at_ms: run[run.length - 1].wallclockEndMs ?? nowMs,
      success_count: run.length, // run 内全 commit ok=true 前提 (run 中断条件で flush)
      failure_count: 0,
      example_actions: exampleActions,
    });
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // run 中断条件: windowTitle 不在 / ok != true / windowTitle 変化
    if (e.windowTitle === undefined || e.ok !== true) {
      if (runStart >= 0 && runWindow !== undefined) {
        flushRun(runStart, i, runWindow);
      }
      runStart = -1;
      runWindow = undefined;
      continue;
    }
    if (e.windowTitle !== runWindow) {
      // 新 window で run リセット (前 run があれば flush)
      if (runStart >= 0 && runWindow !== undefined) {
        flushRun(runStart, i, runWindow);
      }
      runStart = i;
      runWindow = e.windowTitle;
    }
    // 同 window で run 継続
  }
  // ring 末尾の run も拾う
  if (runStart >= 0 && runWindow !== undefined) {
    flushRun(runStart, events.length, runWindow);
  }
  return records;
}

/**
 * Project Semantic memory (top-K patterns by recency) from pattern store。
 *
 * Working/Episodic と同 ring 共有、`_historyBuffers` 内 events を on-demand
 * scan + pattern store (in-memory LRU 100) と merge して top-K を expose。
 *
 * 戻り値:
 *   - sentinel `multi:disabled` → undefined (A-2 closed loop 整合)
 *   - history ring 不在 / 0 件 → `{ patterns: [] }` (empty projection)
 *   - 通常: pattern store top-K (last_seen_at_ms 降順) を `UiPatternSummary[]`
 *     に projection、`success_rate = success_count / (success_count + failure_count)`
 *     に runtime compute
 *   - K > store size → `_truncation: ring_underflow`
 *   - K > store capacity (100) → `_truncation: capacity_cap`
 *
 * 注意: 本 helper は pattern store の **read** のみ。store 更新 (新 record
 * の merge) は呼び出し側 (typically `makeCommitWrapper` の completion hook)
 * 責務、本 PR scope では query 時 on-demand 抽出 + 1 度だけ store 更新の
 * シンプル経路を採用 (cross-session 永続化は B-3 follow-up PR carry-over)。
 */
export function projectSemanticMemory(
  sessionId: string,
  k: number,
  store: { getTopK: (n: number) => UiPatternRecord[]; capacity: number },
  options?: {
    /** Round 2 P1-2 fix: env `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` 連動。
     *  true 時 window_title を FNV-1a hash で置換 + pattern_id の
     *  windowTitle 部分も hash 化 (= projection 出力上の plaintext leak
     *  ゼロ化)。store 自体は raw を保持し、env を session 中に flip しても
     *  挙動が即時切り替わる semantics。 */
    redactWindowTitles?: boolean;
  },
): SemanticMemoryProjection | undefined {
  if (sessionId === "multi:disabled") return undefined;
  const ring = _historyBuffers.get(sessionId);
  if (!ring) return { patterns: [] };
  ring.lastAccessMs = _historyClock();

  // capacity_cap: K > store.capacity (default 100)
  const cappedK = Math.min(k, store.capacity);
  const records = store.getTopK(cappedK);

  const redact = options?.redactWindowTitles === true;
  const patterns: UiPatternSummary[] = records.map((r) => {
    // B-3 follow-up Round 2 P2-1 fix: persistence redact-on で disk へ
    // hash 化された window_title (`redacted:[hex8]`) が次回起動時 load で
    // in-memory に固着する。env mid-session で flip しても in-memory は
    // raw 維持の design 前提が **再起動跨ぎでは成立しない** ため、redact-off
    // branch でも `redacted:` 始まりの window_title は **そのまま expose**
    // する (recursive hash 防止 + LLM に対し literal `redacted:` prefix で
    // redaction 状態が明示)。env on で書いた redact データを再読込みした
    // 場合の semantics: 「disk へ書いた瞬間に redact 状態が永久 fix」
    // (irreversible)、env off に戻しても plaintext 復元はしない設計。
    const isAlreadyRedacted = r.window_title.startsWith("redacted:");
    if (redact && !isAlreadyRedacted) {
      const titleHash = fnv1aHash16(r.window_title);
      // pattern_id の `<wt-hash>::<tool-seq>` の wt-hash 側はもともと
      // hash (computePatternFingerprint)、redact mode では window_title 側を
      // hash 表現で揃えて出力する (LLM expose で plaintext 漏洩ゼロ)。
      return {
        pattern_id: r.pattern_id,
        window_title: `redacted:${titleHash}`,
        step_count: r.step_count,
        last_seen_at_ms: r.last_seen_at_ms,
        success_rate:
          r.success_count + r.failure_count === 0
            ? 0
            : r.success_count / (r.success_count + r.failure_count),
        example_actions: r.example_actions,
      };
    }
    return {
      pattern_id: r.pattern_id,
      window_title: r.window_title,
      step_count: r.step_count,
      last_seen_at_ms: r.last_seen_at_ms,
      success_rate:
        r.success_count + r.failure_count === 0
          ? 0
          : r.success_count / (r.success_count + r.failure_count),
      example_actions: r.example_actions,
    };
  });

  // _truncation 判定 (B-1/B-2 同型 logic)
  let truncation: TruncationNotation | undefined;
  if (k > store.capacity) {
    truncation = { requested: k, returned: patterns.length, reason: "capacity_cap" };
  } else if (patterns.length < k) {
    truncation = { requested: k, returned: patterns.length, reason: "ring_underflow" };
  }

  return truncation === undefined
    ? { patterns }
    : { patterns, _truncation: truncation };
}

/**
 * ADR-011 Phase B B-4: Procedural memory summary for envelope expose
 * (suggest target = "過去成功した repeated workflow")。
 *
 * Phase B plan §10 OQ #8 + B-4 着手時 user 諮問 2026-05-07 で確定:
 *   - **MVP scope は query/observation 系 safe repeated workflow 限定**
 *   - destructive/side-effecting macro suggest は **non-goal** (将来別 PR)
 *
 * `getTopKForSuggest` 経由 filter 済みのみ expose、`success_count >= 3` +
 * `failure_count == 0` + `contains_destructive == false` の 3 条件全 pass。
 */
export interface MacroOutcomeSummary {
  macro_id: string;
  tools: string[];
  success_count: number;
  last_seen_at_ms: number;
}

/** Procedural memory projection 戻り値 (suggest 候補 macro 配列 + 任意
 *  `_truncation` notation)。
 *
 *  field 名 `suggestions` は **ADR-010 §6 line 409** documented contract
 *  `successful_macros.suggestions` 整合 (Round 1 Opus P1-1 反映: B-1
 *  `current_state.recent_events` / B-2 `tool_call_history.episodes` /
 *  B-3 `learned_ui_pattern.patterns` と同型 axis、envelope field 名 ≠
 *  inner list 名 の design)。 */
export interface ProceduralMemoryProjection {
  suggestions: MacroOutcomeSummary[];
  _truncation?: TruncationNotation;
}

/**
 * Project Procedural memory (top-K successful macros by recency) from
 * outcome store。
 *
 * - sentinel `multi:disabled` → undefined return (cross-session leak 防止、
 *   B-3 と同 axis)
 * - history ring 不在 / 0 件 → `{ suggestions: [] }` (empty projection、
 *   B-3 と同 fail-safe)
 * - filter 済み top-K (`store.getTopKForSuggest(k)` 経由) を expose、
 *   destructive を含む macro / 失敗 macro は構造的に出ない
 * - K > store size → `_truncation: ring_underflow`
 * - K > store capacity (100) → `_truncation: capacity_cap`
 */
export function projectProceduralMemory(
  sessionId: string,
  k: number,
  store: {
    getTopKForSuggest: (n: number, minSuccessCount?: number) => Array<{
      macro_id: string;
      tools: string[];
      success_count: number;
      last_seen_at_ms: number;
    }>;
    capacity: number;
  },
): ProceduralMemoryProjection | undefined {
  if (sessionId === "multi:disabled") return undefined;
  const ring = _historyBuffers.get(sessionId);
  if (!ring) return { suggestions: [] };
  ring.lastAccessMs = _historyClock();

  const cappedK = Math.min(k, store.capacity);
  const records = store.getTopKForSuggest(cappedK);
  const suggestions: MacroOutcomeSummary[] = records.map((r) => ({
    macro_id: r.macro_id,
    tools: [...r.tools],
    success_count: r.success_count,
    last_seen_at_ms: r.last_seen_at_ms,
  }));

  // Round 1 P2-3 fix: `_truncation.reason: "ring_underflow"` は B-1/B-2/B-3
  // 同型の TruncationNotation enum を踏襲 (新 reason `filter_underflow` 追加
  // しない)。Procedural の場合は ring + filter (success>=3 + failure==0 +
  // no destructive) 経由で K に届かなかった全ケースを包含、LLM client は
  // 「候補数が K 未満」とだけ読めば良い (filter 詳細は projection 経由で expose
  // しない privacy 設計、destructive macro 数を expose すると pattern leak
  // surface 増)。
  let truncation: TruncationNotation | undefined;
  if (k > store.capacity) {
    truncation = {
      requested: k,
      returned: suggestions.length,
      reason: "capacity_cap",
    };
  } else if (suggestions.length < k) {
    truncation = {
      requested: k,
      returned: suggestions.length,
      reason: "ring_underflow",
    };
  }
  return truncation === undefined
    ? { suggestions }
    : { suggestions, _truncation: truncation };
}

/**
 * Project `produced_changes` from current ViewSnapshot (sub-plan §1.1 C +
 * §2.3 trunk 近似実装、focus before-state は §6 OQ #4 carry-over).
 *
 * Format:
 *   - focus delta: `"focus: → <elementName | hwnd=N>"` (focus 不在時 entry 省略、
 *     before/after deep-diff は OQ #4 carry-over)
 *   - dirty_rect: `"dirty_rects[monitor=N]: count"` (count > 0 monitor のみ
 *     entry、`monitor_index` 維持 = CLAUDE.md §3.2 PR #102 同型 regression 防止)
 */
export function buildProducedChanges(viewSnapshot: ViewSnapshot): string[] {
  const changes: string[] = [];
  if (viewSnapshot.focus !== null) {
    const label = viewSnapshot.focus.elementName ?? `hwnd=${viewSnapshot.focus.hwnd}`;
    changes.push(`focus: → ${label}`);
  }
  // Sort monitor_index for deterministic output across Map iteration order
  const sorted = [...viewSnapshot.dirtyRectsByMonitor.entries()].sort((a, b) => a[0] - b[0]);
  for (const [monitorIndex, count] of sorted) {
    if (count > 0) {
      changes.push(`dirty_rects[monitor=${monitorIndex}]: ${count}`);
    }
  }
  return changes;
}

// ─── ADR-011 A-1/A-2: Default query-axis sessionId resolver ─────────────────

/**
 * Default sessionId resolver for query-axis tools wired in ADR-011 A-1
 * (browser_overview / browser_locate / browser_search / screenshot /
 * server_status / wait_until / workspace_snapshot / desktop_discover).
 *
 * **A-2 finalize (PR #157 後継)**: A-1 で導入した duplicate stub
 * (`_defaultQueryTransportSessionId` / `_defaultQuerySingleSessionPrototype`)
 * を `_session-context.ts` の AsyncLocalStorage 経路に delegate 統合
 * (plan §4.2.4 unification)。`desktop-state.ts:desktopStateGetSessionId`
 * とも同じ shared resolver を経由するため、現実的には bit-equal sync が
 * structural に保証される (両 site で異なる stub 実装が drift する回路
 * は閉じる)。
 *
 * Behaviour:
 *   - `extra.sessionId` ALS 注入されていれば return それ (multi-session
 *     transport の per-request 識別子、HTTP StreamableHTTP 等)
 *   - prototype gate (env mode + ALS 検出) で multi-session detect →
 *     `"multi:disabled"` sentinel (caused_by injection skip、cross-session
 *     causal trail leak 防止)
 *   - default → `"default"` (single-LLM-client prototype、stdio default)
 */
export const defaultQuerySessionId = (_args: unknown): string => {
  const transportSessionId = getMcpTransportSessionIdFromContext();
  if (transportSessionId !== undefined) return transportSessionId;
  if (!isSingleSessionPrototype()) {
    return "multi:disabled";
  }
  return "default";
};

/** @internal Test-only — backward-compat alias for A-1 callers. Forwards
 *  to the shared `_session-context.ts` test seam (plan §4.2.4 unification).
 *  Existing tests using this exact name continue to work without rewrites.
 */
export function _setDefaultQuerySingleSessionForTest(value: boolean): void {
  _setSingleSessionPinForTest(value);
}

/** @internal Test-only — same forwarding pattern. */
export function _resetDefaultQuerySingleSessionForTest(): void {
  _resetSingleSessionPinForTest();
}

// ─── ADR-011 A-1: Generic query-axis causedByProjector ───────────────────────

/**
 * Shared causedByProjector for query-axis tools (ADR-011 Phase A A-1).
 *
 * Extracted from `desktop-state.ts:desktopStateCausedByProjector` so all
 * 9 query tools (desktop_state + 8 wired in A-1) share the same 4-axis
 * `ViewSnapshot` construction (focus / dirtyRectsByMonitor / latestEventId
 * / queryWallclockMs). Tool-specific args are not consumed — the snapshot
 * is purely L3-view-derived and uniform across query tools.
 *
 * Behaviour mirrors the original `desktopStateCausedByProjector` bit-for-bit
 * (ADR-011 plan §4.1.5 bit-equal sync sweep):
 *   - sentinel `multi:disabled` → `undefined` (skip caused_by + based_on)
 *   - `nativeL1` unavailable → `{ forceDegraded: true }` (Round 3 P2 fix
 *     `confidence: degraded` for "causal asked but binding null")
 *   - focus / dirty rect view fetch failures swallowed silently (best-effort
 *     produced_changes population)
 *   - per-monitor dirty rect enumeration with `enumMonitors` fallback to
 *     `[0]` (PR #102 同型 monitor_index 維持)
 *   - `latestEventId` from `l1GetCaptureStats().eventIdHighWater` (existing
 *     binding reuse, OQ #5 resolve)
 *
 * `desktop-state.ts:desktopStateCausedByProjector` is a delegating fn to
 * this projector after A-1 land — backward compat maintained, future
 * tool-specific enrichment (OQ #4 in plan §8) can layer atop this base.
 */
export const genericQueryCausedByProjector = async (
  _args: unknown,
  sessionId: string,
): Promise<{ causedBy?: CausedByShape; basedOn?: BasedOnShape; forceDegraded?: boolean } | undefined> => {
  // Sentinel guard: multi-session detect → skip caused_by/based_on entirely
  if (sessionId === "multi:disabled") return undefined;
  // `nativeL1` unavailable (non-Windows dev / pre-P5a binary) → degraded
  if (!nativeL1 || typeof nativeL1.l1GetCaptureStats !== "function") {
    return { forceDegraded: true };
  }

  // L3 latest_focus view → focus delta projection input
  let focus: { hwnd: bigint | null; elementName: string | null } | null = null;
  try {
    if (nativeViewFocus && typeof nativeViewFocus.viewGetFocused === "function") {
      const f = nativeViewFocus.viewGetFocused();
      if (f) {
        focus = { hwnd: null, elementName: f.name ?? null };
      }
    }
  } catch {
    // view unavailable — caused_by reflects "no focus observed" via produced_changes
  }

  // L3 dirty_rects_aggregate per-monitor count (monitor_index 維持、PR #102 同型)
  const dirtyRectsByMonitor = new Map<number, number>();
  try {
    if (nativeViewFocus && typeof nativeViewFocus.viewGetDirtyRects === "function") {
      let monitorIndices: number[] = [0];
      try {
        const monitors = enumMonitors();
        if (monitors && monitors.length > 0) {
          monitorIndices = monitors.map((_, i) => i);
        }
      } catch {
        // enumMonitors failed — keep [0] fallback
      }
      for (const monitorIdx of monitorIndices) {
        try {
          const rects = nativeViewFocus.viewGetDirtyRects(monitorIdx);
          if (rects && rects.latest && rects.latest.count !== undefined) {
            dirtyRectsByMonitor.set(monitorIdx, Number(rects.latest.count));
          }
        } catch {
          // per-monitor lookup failed — skip this monitor
        }
      }
    }
  } catch {
    // dirty rect view unavailable — produced_changes lacks dirty_rects entries
  }

  // L1 ring 末尾 event_id (OQ #5 既存 binding reuse、新規不要)
  let latestEventId: bigint | undefined;
  try {
    if (typeof nativeL1.l1GetCaptureStats === "function") {
      const stats = nativeL1.l1GetCaptureStats();
      latestEventId = stats.eventIdHighWater;
    }
  } catch {
    // L1 stats unavailable — frontier check skipped, monotonic timeout fallback
  }

  const snapshot: ViewSnapshot = {
    focus,
    dirtyRectsByMonitor,
    latestEventId,
    queryWallclockMs: Date.now(),
  };
  return {
    causedBy: buildCausedBy(sessionId, snapshot),
    basedOn: buildBasedOn(sessionId, snapshot),
  };
};

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
  /** ADR-011 A-3: compound commit boundary marker propagated to the
   *  per-session history buffer (does NOT flow into the L1 napi binding —
   *  L1 ring shape is unchanged). `true` causes the history entry to
   *  survive `evictOldestNonBoundary` so long macros preserve
   *  orchestration boundary in causal projection. */
  isCompoundBoundary?: boolean;
  /** ADR-011 Phase B B-3: foreground window title at push time
   *  (best-effort、Phase B sub-plan §6.1 rule-based pattern 抽出 context)。
   *  L1 napi binding には流さない (L1 ring shape 不変)、history record
   *  経路にのみ伝播。`undefined` の場合 pattern 抽出で run 中断扱い。 */
  windowTitle?: string;
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
 *  fallback pattern).
 *
 *  S5: `pushStarted` / `pushCompleted` also record into the per-session
 *  history buffer (sub-plan §2.1 + §3.1 S5-1) so `buildCausedBy` /
 *  `buildBasedOn` can project from `desktop_state(include=causal)`. The
 *  history record is best-effort fail-safe — L1 napi failure does NOT
 *  block history record (causal window calculation still works on the
 *  TS-side ring even if L1 ring binding is broken). */
export const defaultL1Emitter: CommitL1Emitter = {
  pushStarted({ tool, argsJson, sessionId, toolCallId, leaseToken, isCompoundBoundary, windowTitle }) {
    let eventIdStarted: bigint | undefined;
    try {
      eventIdStarted = nativeL1?.l1PushToolCallStarted?.(
        tool,
        argsJson,
        sessionId,
        toolCallId,
        leaseToken,
      );
    } catch {
      // L1 binding unavailable / threw — telemetry best-effort.
    }
    // ADR-011 Phase B B-3: foreground window title best-effort 取得
    // (callers が明示渡してこなかった場合のみ `nativeViewFocus` 経由で
    // 解決を試みる)。L3 view 失敗時 undefined のまま、pattern 抽出で
    // run 中断扱い。
    let resolvedWindowTitle = windowTitle;
    if (resolvedWindowTitle === undefined) {
      try {
        const focused = nativeViewFocus?.viewGetFocused?.();
        // viewGetFocused 戻り値の `name` field を window title 代理として使用
        // (B-3 minimum scope、本来は windowTitle 専用 API or hwnd→title 解決
        // が望ましいが、本 PR では既存 view を流用、follow-up で精緻化)
        resolvedWindowTitle = focused?.name ?? undefined;
      } catch {
        // view binding unavailable / threw — pattern 抽出時 skip
      }
    }
    // S5: history buffer 二重記録 (best-effort fail-safe)。ADR-011 A-3:
    // `isCompoundBoundary` を伝播 (L1 napi binding には流れない、history
    // entry の eviction skip flag としてのみ機能)。
    // ADR-011 Phase B B-3: `windowTitle` を伝播 (Semantic memory pattern
    // 抽出 context、L1 napi binding には流れない、history record 経路のみ)。
    pushHistoryStarted({
      sessionId,
      toolCallId,
      toolName: tool,
      argsSummary: argsJson,
      eventIdStarted,
      wallclockStartMs: Date.now(),
      monotonicStartMs: performance.now(),
      leaseToken,
      isCompoundBoundary,
      windowTitle: resolvedWindowTitle,
    });
  },
  pushCompleted({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId }) {
    let eventIdCompleted: bigint | undefined;
    try {
      eventIdCompleted = nativeL1?.l1PushToolCallCompleted?.(
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
    // S5: history buffer entry を completion marker で update
    pushHistoryCompleted({
      sessionId,
      toolCallId,
      eventIdCompleted,
      wallclockEndMs: Date.now(),
      ok,
    });
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
  /**
   * ADR-011 A-3: mark commits wrapped by this wrapper as compound
   * commit boundaries (e.g. `run_macro`). When `true`, the per-session
   * history entry gets `isCompoundBoundary: true` and is protected
   * from FIFO eviction so long macros preserve orchestration boundary
   * in causal projection (`buildCausedBy.your_last_action` /
   * `buildBasedOn.events` anchor on the outer event instead of the
   * latest inner step). Default `false` — only `run_macro` opts in.
   */
  isCompoundBoundary?: boolean;
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
): (
  rawArgs: TArgs & { include?: string[] },
  extra?: { sessionId?: string },
) => Promise<McpToolResult> {
  const fetchMeta =
    options.fetchMeta ??
    (async () => ({ viewPoisoned: false, asOfWallclockMs: null }));
  const getEnvValue =
    options.getEnvValue ?? (() => process.env.DESKTOP_TOUCH_ENVELOPE);
  const argsSummary = options.argsSummary ?? ((a: TArgs) => truncateJson(a, 512));
  // A-4 retrospective fix (Codex P1 #2、PR #158 follow-up): default
  // `getSessionId` を `defaultQuerySessionId` 同等の ALS-aware resolver に
  // 切替。旧 `() => "default"` 固定は HTTP transport で `extra.sessionId =
  // "abc"` 配下でも commit history が `"default"` ring に記録され、query
  // 側 (`defaultQuerySessionId` 経由で `"abc"` 読取) と key 分裂、per-session
  // causal trail が absent になる runtime regression (Codex 単独検出)。
  // commit/query 同 ring 共有で session-scoped causal trail isolation を達成。
  const getSessionId = options.getSessionId ?? defaultQuerySessionId;
  const l1 = options.l1Emitter ?? defaultL1Emitter;
  const clock = options.clock ?? Date.now;

  return async (rawArgs, extra) => runWithSessionContext(extra?.sessionId, async () => {
    // ADR-011 A-2: ALS context populated from SDK's RequestHandlerExtra.sessionId
    // (`@modelcontextprotocol/sdk/shared/protocol.d.ts:185`)。downstream
    // `getSessionId` resolvers (defaultQuerySessionId / desktopStateGetSessionId)
    // read transport sessionId via `getMcpTransportSessionIdFromContext()`。
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
        // Round 1 P1 (Codex + user PR review): raw-mode failures must
        // preserve the pre-S4 `{ok:false, reason, ...}` shape; literal
        // `null` from `compatHoist(failure, false)` would silently drop
        // the reason + retry signal for existing positional callers.
        // `compatFailureRaw` flattens envelope.data:null into the
        // legacy-compatible shape AND carries `if_unexpected` so newer
        // clients can read the typed cause without opting into envelope.
        const finalShape = optIn ? failure : compatFailureRaw(failure);
        return {
          content: [{ type: "text", text: JSON.stringify(finalShape) }],
        };
      }
    }

    // Step 3: tool_call_id seq採番.
    const sessionId = getSessionId(handlerArgs);
    // A-4 retrospective fix (Round 1 Opus P2-2、PR #163 Round 2 反映):
    // `multi:disabled` sentinel sessionId は **L1 emit + history record を
    // skip** する明示分岐。query 側 (genericQueryCausedByProjector / projectWorkingMemory)
    // は既に sentinel で undefined return する closed loop だが、commit 側
    // default を `defaultQuerySessionId` 共有に変更したことで sentinel sessionId
    // が L1 ring + `_historyBuffers["multi:disabled"]` 共有 sentinel ring に
    // **多 session の commit を混入させる** 構造的副作用が発生 (Phase B B-2
    // Episodic memory expose 時に sentinel ring が誤って読まれる risk)。
    // sentinel = "do nothing (no per-session attribution)" semantics を保持
    // するため、commit body は実行 (handler invoke + raw return) するが
    // telemetry / history record を完全 skip する分岐を追加。
    const isSentinelSession = sessionId === "multi:disabled";
    const toolCallId = isSentinelSession ? "multi:disabled:0" : nextToolCallId(sessionId);

    // Step 4: l1PushToolCallStarted (with optional lease_token summary)。
    // sentinel sessionId は L1 ring に session label を emit しない (ring
    // pollution 防止)、history record も skip。
    const summary = argsSummary(handlerArgs);
    const leaseToken = options.extractLeaseToken
      ? options.extractLeaseToken(handlerArgs)
      : undefined;
    if (!isSentinelSession) {
      l1.pushStarted({
        tool: toolName,
        argsJson: summary,
        sessionId,
        toolCallId,
        leaseToken,
        isCompoundBoundary: options.isCompoundBoundary,
      });
    }

    // Step 5: invoke handler (raw side effect). Step 6: completion event.
    const startedAt = clock();
    let handlerResult: McpToolResult | undefined;
    let handlerError: unknown;
    // Round 2 P2 fix (Codex round 2 review, `_envelope.ts:961`):
    // JavaScript permits `throw undefined` / `Promise.reject()` — in
    // that branch `handlerError` stays bound to the initial `undefined`,
    // so a `handlerError !== undefined` discriminator falsely treats the
    // throw as success and crashes on `result.content?.[0]`. A separate
    // boolean sentinel makes the discriminator value-independent.
    let handlerThrew = false;
    try {
      handlerResult = await handler(handlerArgs);
    } catch (err) {
      handlerError = err;
      handlerThrew = true;
    }
    const elapsedMs = Math.max(0, Math.floor(clock() - startedAt));

    if (handlerThrew) {
      // sentinel sessionId 経路は L1 emit skip (上記 sentinel 分岐と整合)
      if (!isSentinelSession) {
        l1.pushCompleted({
          tool: toolName,
          elapsedMs,
          ok: false,
          errorCode: extractErrorCode(handlerError),
          sessionId,
          toolCallId,
        });
      }
      const failure = buildFailureEnvelope(
        "Unknown",
        [],
        envelopeOptions,
      );
      // Round 1 P1 (Codex + user PR review): same legacy-compat raw
      // projection as the lease-validation failure path — preserve
      // `{ok:false, reason:"unknown", if_unexpected:{...}}` for raw
      // clients instead of literal `null`.
      const finalShape = optIn ? failure : compatFailureRaw(failure);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }

    const result = handlerResult as McpToolResult;

    // Step 7: buildEnvelope (S3 inherit) + compatHoist (S3 inherit).
    const block = result.content?.[0];
    const ok = inferOkFromResult(block);
    // sentinel sessionId 経路は L1 emit skip (上記 sentinel 分岐と整合)
    if (!isSentinelSession) {
      l1.pushCompleted({
        tool: toolName,
        elapsedMs,
        ok,
        errorCode: ok ? undefined : extractErrorCodeFromBlock(block),
        sessionId,
        toolCallId,
      });
    }

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
  });
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
 * Query-axis wrapper options (sub-plan §2.4 Round 3 P1 Opus + Codex 重複 fix
 * で sentinel runtime path closed loop 化).
 *
 * `causedByProjector` signature is `(args, sessionId)` so the wrapper
 * can pass the resolved sessionId to the projector — without this the
 * projector would re-resolve and the sentinel guard (`"multi:disabled"`)
 * would be bypassed (Round 2 → Round 3 dead-loop fix).
 */
export interface QueryWrapperOptions extends MakeEnvelopeAwareOptions {
  /**
   * S5 caused_by + based_on projection (`include=["causal"]` opt-in only).
   *
   * Returns `{ causedBy?, basedOn? }` (both optional — a projector may
   * return only one or `undefined` to skip envelope inject entirely).
   *
   * Production wiring (`src/tools/desktop-state.ts`): the closure builds
   * a `ViewSnapshot` from `viewGetFocused()` + `viewGetDirtyRects()` +
   * `l1GetCaptureStats().eventIdHighWater` (existing napi bindings, no
   * new binding needed per OQ #5 resolve), then calls `buildCausedBy`
   * and `buildBasedOn` in parallel.
   *
   * Sentinel guard runtime path (Round 3 P1 Opus + Codex 重複 fix):
   * when `getSessionId` returns `"multi:disabled"` (multi-LLM-client
   * detected), the projector should immediately `return undefined` to
   * skip envelope.caused_by + envelope.based_on entirely (cross-session
   * leak prevention).
   */
  causedByProjector?: (
    args: unknown,
    sessionId: string,
  ) => Promise<{
    causedBy?: CausedByShape;
    basedOn?: BasedOnShape;
    /**
     * Round 3 P2 fix (Codex line 655): when the projector cannot run
     * (e.g. `nativeL1` null = telemetry binding unavailable), surface
     * the impaired observability via `confidence: degraded` so LLM
     * clients distinguish "include=causal asked, projection
     * unavailable" from "include not asked". Defaults to false.
     */
    forceDegraded?: boolean;
  } | undefined>;
  /**
   * S5 sessionId source (sub-plan §2.4 Round 3 P1 Opus + Codex 重複 fix).
   *
   * `makeQueryWrapper` flow always resolves via this getter when
   * `include=["causal"]` is opt-in, then passes the result to
   * `causedByProjector` (closed-loop sentinel runtime path).
   *
   * Default `() => "default"` — single-LLM-client prototype fallback
   * (sub-plan §1.1 E-2). Production wiring uses
   * `getMcpTransportSessionId()` first, falls back to
   * `"multi:disabled"` sentinel when multi-session detected, and
   * `"default"` for single-LLM-client deploy (ADR-011 で完全 finalize).
   */
  getSessionId?: (args: unknown) => string;
}

/**
 * @internal Test-only — wire pin registry for `__getQueryWrapperOptionsForTest`.
 *
 * Records the resolved `QueryWrapperOptions` used by each `makeQueryWrapper`
 * call so unit tests can assert that 8 query tools wired in ADR-011 A-1
 * actually carry `causedByProjector + getSessionId` references (Round 1
 * Codex P2 反映: `typeof handler === "function"` だけでは wire 漏れを
 * 検出できないため、wrapper の internal config を WeakMap で保持して
 * test 側で identity を pin する observable behavior path)。
 *
 * Production overhead: WeakMap insert per registration (1 回限り、N=28 tool)。
 * GC: handler が解放されると entry も自動 GC、leak なし。
 */
const _queryWrapperOptionsRegistry = new WeakMap<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]) => Promise<McpToolResult>,
  QueryWrapperOptions
>();

/** @internal Test-only — inspect resolved options of a registered query
 *  wrapper (Round 1 Codex P2 wire pin observable behavior). Returns
 *  `undefined` when the handler was not produced by `makeQueryWrapper`
 *  (e.g. raw handler) or when the test seam was reset. */
export function __getQueryWrapperOptionsForTest<TArgs extends Record<string, unknown>>(
  wrapped: (rawArgs: TArgs & { include?: string[] }) => Promise<McpToolResult>,
): QueryWrapperOptions | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return _queryWrapperOptionsRegistry.get(wrapped as any);
}

export function makeQueryWrapper<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<McpToolResult>,
  toolName: string,
  options: QueryWrapperOptions = {},
): (
  rawArgs: TArgs & { include?: string[] },
  extra?: { sessionId?: string },
) => Promise<McpToolResult> {
  // S4 fast path: when no S5 features are wired (causedByProjector +
  // getSessionId both omitted), reuse the bare S3 makeEnvelopeAware
  // wrapper unchanged. Existing query-axis callers (e.g.
  // `desktop_discover` from S4) hit this branch with no behaviour
  // change — sub-plan §4.5 既存 caller 破壊なし sweep。ADR-011 A-2
  // でも S4 fast path は session context 不要 (causedByProjector 不在
  // で sentinel sessionId は不要)、ALS wrap 省略で no-op overhead 回避。
  if (options.causedByProjector === undefined && options.getSessionId === undefined) {
    const wrapped = makeEnvelopeAware(handler, toolName, options);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _queryWrapperOptionsRegistry.set(wrapped as any, options);
    return wrapped;
  }

  // S5 path: include peek + getSessionId resolve + causedByProjector
  // 並列 inject + buildEnvelope({ causedBy, basedOn }).
  const fetchMeta =
    options.fetchMeta ??
    (async () => ({ viewPoisoned: false, asOfWallclockMs: null }));
  const getEnvValue =
    options.getEnvValue ?? (() => process.env.DESKTOP_TOUCH_ENVELOPE);
  // A-4 retrospective fix (Codex P1 #2 同型): commit wrapper と同じく
  // `defaultQuerySessionId` 共有で ALS-aware resolver に統一。本来 A-1 で
  // 全 query tool に明示 wire 済 (causedByProjector を opt-in する registration
  // site は `getSessionId: defaultQuerySessionId` を渡す) のため runtime 影響は
  // 軽微だが、registration 漏れに対する safety net として default も同 logic
  // に揃える (commit/query 一貫性 + session ring 分裂 risk 構造的解消)。
  const getSessionId = options.getSessionId ?? defaultQuerySessionId;
  const causedByProjector = options.causedByProjector;

  // ADR-011 A-2: ALS context populated from SDK's RequestHandlerExtra.sessionId
  // wraps the entire S5 flow so getSessionId / causedByProjector see the
  // transport sessionId via getMcpTransportSessionIdFromContext().
  const s5Wrapper = async (
    rawArgs: TArgs & { include?: string[] },
    extra?: { sessionId?: string },
  ): Promise<McpToolResult> => runWithSessionContext(extra?.sessionId, async () => {
    const { include, ...handlerArgs } = rawArgs as { include?: string[] } & TArgs;
    const includeCausal = include?.includes("causal") === true;
    const includeRaw = include?.includes("raw") === true;
    // ADR-011 Phase B B-1: Working memory `include=["working"]` or
    // `include=["working:N"]` parsing。N <= WORKING_MEMORY_N_MAX で
    // typed error、include 不在 / layer 不在 → undefined (skip projection)。
    const includeWorkingN = parseIncludeMemoryN(include, "working", WORKING_MEMORY_DEFAULT_N);
    const includeWorkingOptIn = includeWorkingN !== undefined;
    // ADR-011 Phase B B-2: Episodic memory `include=["episodic"]` or
    // `include=["episodic:N"]` parsing。N <= EPISODIC_MEMORY_N_MAX で
    // typed error、include 不在 / layer 不在 → undefined (skip projection)。
    // Working と同 ring 共有、projection shape のみ rich。
    const includeEpisodicN = parseIncludeMemoryN(include, "episodic", EPISODIC_MEMORY_DEFAULT_N);
    const includeEpisodicOptIn = includeEpisodicN !== undefined;
    // ADR-011 Phase B B-3: Semantic memory `include=["semantic"]` or
    // `include=["semantic:K"]` parsing。K <= SEMANTIC_MEMORY_K_MAX で typed error、
    // include 不在 / layer 不在 → undefined (skip projection)。
    const includeSemanticK = parseIncludeMemoryN(include, "semantic", SEMANTIC_MEMORY_DEFAULT_K);
    const includeSemanticOptIn = includeSemanticK !== undefined;
    // ADR-011 Phase B B-4: Procedural memory `include=["procedural"]` or
    // `include=["procedural:K"]` parsing。K <= PROCEDURAL_MEMORY_K_MAX で
    // typed error、include 不在 / layer 不在 → undefined (skip projection)。
    const includeProceduralK = parseIncludeMemoryN(include, "procedural", PROCEDURAL_MEMORY_DEFAULT_K);
    const includeProceduralOptIn = includeProceduralK !== undefined;
    // ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved):
    // `include=["memory_strict"]` / `["memory_balanced"]` / `["memory_open"]`
    // で per-call security tier request。env (operator ceiling) と組み合わせて
    // effective tier を resolve、B-3 redact + B-4 expose gate に接続。
    const includeMemorySecurityRequest = parseIncludeMemorySecurity(include);
    // Round 2 P1 fix (Codex line 1501): `include=["causal"]` is an
    // implicit envelope opt-in — causal projection (`caused_by` +
    // `based_on`) only exists inside the envelope shape. Without this
    // bump, `include=["causal"]` alone would hit `optIn=false` (since
    // it contains neither "raw" nor "envelope"), the compat hoist
    // would flatten `envelope.data` to top-level, and the projected
    // `caused_by` / `based_on` fields would be silently dropped — the
    // S5 cross-layer contract would not actually take effect at
    // runtime. Treating `causal` as an envelope opt-in is the natural
    // resolution: callers asking for causal context implicitly want
    // the envelope shape that carries it.
    //
    // Round 3 P2 fix (Codex line 1556): preserve the explicit `raw`
    // override priority. `resolveEnvelopeOptIn` already returns false
    // when `include` contains `"raw"`, so we only auto-promote to
    // envelope mode for `causal` when `raw` is NOT explicitly
    // requested. This keeps the per-call opt-out path that lets
    // legacy callers force raw shape even while asking for causal
    // context (degraded UX, but contract-preserving).
    // ADR-011 Phase B B-1/B-2: `include=["working"]` / `["episodic"]` も causal
    // と同型で envelope opt-in の implicit promotion (raw override 維持)。
    // current_state / tool_call_history は envelope 内 top-level field、raw
    // 互換 hoist では消失するため。
    // §10 OQ #10 Resolved: `memory_*` keyword 単独 (memory layer 不在) でも
    // tier_active 観測のため envelope opt-in promotion (raw override 維持)。
    const optIn =
      ((includeCausal || includeWorkingOptIn || includeEpisodicOptIn || includeSemanticOptIn || includeProceduralOptIn || includeMemorySecurityRequest !== undefined) && !includeRaw) ||
      resolveEnvelopeOptIn(include, getEnvValue());

    // ADR-011 Phase B B-1: N upper bound check (silently truncate せず error)。
    // Round 1 Opus P1-3 反映: try_next に SUGGESTS 3 行を typed action として
    // 配線、runtime hint delivery を保証 (`_errors.ts:getSuggestsForCode` 経由、
    // SUGGESTS 文字列 → `{action: string}` minimal wiring、ADR-010 P2 acceptance
    // の本格 typed action 設計は別 phase の責務だが本 PR で string content は
    // LLM に届ける)。
    if (includeWorkingOptIn && includeWorkingN! > WORKING_MEMORY_N_MAX) {
      const tryNext: TryNextAction[] = getSuggestsForCode(
        "WorkingMemoryNUpperBoundExceeded",
      ).map((suggest) => ({ action: suggest }));
      const failure = buildFailureEnvelope(
        "WorkingMemoryNUpperBoundExceeded",
        tryNext,
        { viewPoisoned: false, asOfWallclockMs: null },
      );
      const finalShape = optIn ? failure : compatFailureRaw(failure);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }
    // ADR-011 Phase B B-2: Episodic memory N upper bound check (B-1 同型)。
    if (includeEpisodicOptIn && includeEpisodicN! > EPISODIC_MEMORY_N_MAX) {
      const tryNext: TryNextAction[] = getSuggestsForCode(
        "EpisodicMemoryNUpperBoundExceeded",
      ).map((suggest) => ({ action: suggest }));
      const failure = buildFailureEnvelope(
        "EpisodicMemoryNUpperBoundExceeded",
        tryNext,
        { viewPoisoned: false, asOfWallclockMs: null },
      );
      const finalShape = optIn ? failure : compatFailureRaw(failure);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }
    // ADR-011 Phase B B-3: Semantic memory K upper bound check (B-1/B-2 同型)。
    if (includeSemanticOptIn && includeSemanticK! > SEMANTIC_MEMORY_K_MAX) {
      const tryNext: TryNextAction[] = getSuggestsForCode(
        "SemanticMemoryKUpperBoundExceeded",
      ).map((suggest) => ({ action: suggest }));
      const failure = buildFailureEnvelope(
        "SemanticMemoryKUpperBoundExceeded",
        tryNext,
        { viewPoisoned: false, asOfWallclockMs: null },
      );
      const finalShape = optIn ? failure : compatFailureRaw(failure);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }
    // ADR-011 Phase B B-4: Procedural memory K upper bound check (B-3 同型)。
    if (includeProceduralOptIn && includeProceduralK! > PROCEDURAL_MEMORY_K_MAX) {
      const tryNext: TryNextAction[] = getSuggestsForCode(
        "ProceduralMemoryKUpperBoundExceeded",
      ).map((suggest) => ({ action: suggest }));
      const failure = buildFailureEnvelope(
        "ProceduralMemoryKUpperBoundExceeded",
        tryNext,
        { viewPoisoned: false, asOfWallclockMs: null },
      );
      const finalShape = optIn ? failure : compatFailureRaw(failure);
      return {
        content: [{ type: "text", text: JSON.stringify(finalShape) }],
      };
    }

    const meta = await fetchMeta();
    const result = await handler(handlerArgs as TArgs);

    // Round 3 P1 (Opus + Codex 重複) closed loop: getSessionId resolve
    // → projector へ伝播。projector 内で sentinel detect → undefined.
    let causedBy: CausedByShape | undefined;
    let basedOn: BasedOnShape | undefined;
    let projectionForceDegraded = false;
    let currentState: WorkingMemoryProjection | undefined;
    let toolCallHistory: EpisodicMemoryProjection | undefined;
    let learnedUiPattern: SemanticMemoryProjection | undefined;
    let successfulMacros: ProceduralMemoryProjection | undefined;
    let securityTierActive: SecurityTierActive | undefined;
    const includeAnyMemoryLayer =
      (includeCausal && causedByProjector) ||
      includeWorkingOptIn ||
      includeEpisodicOptIn ||
      includeSemanticOptIn ||
      includeProceduralOptIn;
    if (includeAnyMemoryLayer || includeMemorySecurityRequest !== undefined) {
      // ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved):
      // env を snapshot で読んで `resolveEffectiveSecurityTier` で effective
      // を resolve、B-3 redact / B-4 expose gate + envelope expose に flow。
      // env-only (= memory layer なし + memory_* keyword あり) でも tier 計算は
      // 行うが、envelope 自体は memory layer 不在で minimal shape のまま、
      // tier_active field のみ追加する設計 (operator が tier 確認する用途)。
      const envSnapshot = {
        persist: parseMemoryPersistMode(
          process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
        ),
        redact: parseMemoryRedactMode(
          process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES,
        ),
      };
      securityTierActive = resolveEffectiveSecurityTier(
        includeMemorySecurityRequest,
        envSnapshot,
      );
    }
    if (includeAnyMemoryLayer) {
      const sessionId = getSessionId(handlerArgs);
      // causal projection (A-1 wire)
      if (includeCausal && causedByProjector) {
        const projection = await causedByProjector(handlerArgs, sessionId);
        causedBy = projection?.causedBy;
        basedOn = projection?.basedOn;
        // Round 3 P2 fix (Codex line 655): surface impaired observability
        // (e.g. nativeL1 null) via `confidence: degraded` so LLM clients
        // can distinguish "causal asked, unavailable" from healthy raw.
        projectionForceDegraded = projection?.forceDegraded === true;
      }
      // ADR-011 Phase B B-1: Working memory projection
      if (includeWorkingOptIn) {
        currentState = projectWorkingMemory(sessionId, includeWorkingN!);
        // sentinel `multi:disabled` → undefined return、cross-session leak 防止
        // (Phase A sentinel runtime closed loop と整合)
      }
      // ADR-011 Phase B B-2: Episodic memory projection (Working と同 sessionId
      // 共有、sentinel skip 一貫性、projection shape のみ rich)
      if (includeEpisodicOptIn) {
        toolCallHistory = projectEpisodicMemory(sessionId, includeEpisodicN!);
      }
      // ADR-011 Phase B B-3: Semantic memory projection (rule-based 抽出 +
      // pattern store top-K、sentinel skip 一貫性 + cross-session isolation)。
      // **on-demand pattern 抽出 (Round 2 P1-1 fix)**: query 時に cursor 越え
      // 新規 events のみ scan し、`extractSemanticPatterns` の戻り値を pattern
      // store に merge。pre-fix では同 events を毎 query 再 extract → success_count
      // 無限累積 → API contract regression、cursor で構造的に解消。
      // sentinel session では projectSemanticMemory が undefined return + pattern
      // store update も skip (`isSentinelSession === true` ガード)。
      if (includeSemanticOptIn && sessionId !== "multi:disabled") {
        const ring = _historyBuffers.get(sessionId);
        if (ring && ring.events.length > 0) {
          // cursor 越え events だけを抽出対象に絞る (P1-1 fix)
          const cursorTcId = _semanticExtractionCursors.get(sessionId);
          let startIndex = 0;
          if (cursorTcId !== undefined) {
            const idx = ring.events.findIndex(
              (e) => e.toolCallId === cursorTcId,
            );
            if (idx >= 0) {
              startIndex = idx + 1;
            }
            // idx < 0: cursor event が ring eviction で消えた → fallback で
            // ring start から scan (再 emit risk 容認、ring capacity 50 で
            // 実害限定)
          }
          const newEvents = ring.events.slice(startIndex);
          if (newEvents.length > 0) {
            const patterns = extractSemanticPatterns(newEvents);
            for (const p of patterns) {
              uiPatternStore.recordPattern(p, /* success */ true);
            }
            // cursor を ring 末尾の toolCallId に進める (次 query 以降は
            // この event 以降だけを extract 対象に)
            _semanticExtractionCursors.set(
              sessionId,
              ring.events[ring.events.length - 1].toolCallId,
            );
          }
        }
        // Phase B Security tier framework §10 OQ #10 Resolved:
        // effective.redact_window_titles は env_redact (operator ceiling)
        // と include_tier (per-call request) の resolve 結果を使う。
        // - tier=strict: redact 強制 ON (env=OFF でも ON)
        // - tier=balanced/open: env_redact 踏襲 (env=ON は OFF にできない、
        //   security floor 原則)
        learnedUiPattern = projectSemanticMemory(
          sessionId,
          includeSemanticK!,
          uiPatternStore,
          {
            redactWindowTitles:
              securityTierActive?.effective.redact_window_titles ?? false,
          },
        );
      }
      // ADR-011 Phase B B-4: Procedural memory projection (suggest 候補
      // = 過去成功した repeated workflow、`run_macro` 完了時 outcome store
      // 直接 record、`getTopKForSuggest` filter (success>=3 + failure==0
      // + no destructive) で構造的に safe 候補のみ expose、destructive
      // macro suggest は Phase B では non-goal で出ない設計)。
      // §10 OQ #10 Resolved: tier=strict なら projection を skip
      // (`effective.procedural === "off"` で suppress、LLM 側で
      // `memory_strict` を request した時の per-call expose-floor 適用)。
      if (
        includeProceduralOptIn &&
        sessionId !== "multi:disabled" &&
        securityTierActive?.effective.procedural === "expose"
      ) {
        successfulMacros = projectProceduralMemory(
          sessionId,
          includeProceduralK!,
          macroOutcomeStore,
        );
      }
    }

    const block = result.content?.[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      return result;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      return result;
    }

    const envelope = buildEnvelope(parsed, {
      // Round 3 P2 fix (Codex line 655): merge meta.viewPoisoned with
      // the projector's `forceDegraded` flag so impaired observability
      // (nativeL1 null / projection unavailable while causal opted in)
      // surfaces as `confidence: degraded` even when meta itself is
      // healthy.
      viewPoisoned: meta.viewPoisoned || projectionForceDegraded,
      asOfWallclockMs: meta.asOfWallclockMs,
      causedBy,
      basedOn,
      // ADR-011 Phase B B-1: Working memory projection
      currentState,
      // ADR-011 Phase B B-2: Episodic memory projection
      toolCallHistory,
      // ADR-011 Phase B B-3: Semantic memory projection
      learnedUiPattern,
      // ADR-011 Phase B B-4: Procedural memory projection
      successfulMacros,
      // ADR-011 Phase B Security tier framework (§10 OQ #10 Resolved)
      securityTierActive,
    });
    const final = compatHoist(envelope, optIn);

    return {
      ...result,
      content: [{ ...block, text: JSON.stringify(final) }, ...result.content.slice(1)],
    };
  });
  // S5 path wrapper も registry に記録 (wire pin test seam、本 file 上部の
  // `_queryWrapperOptionsRegistry` doc 参照)。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _queryWrapperOptionsRegistry.set(s5Wrapper as any, options);
  return s5Wrapper;
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
