/**
 * desktop-register.ts — MCP tool registration for desktop_discover / desktop_act.
 *
 * Guarded by env flag DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1.
 * Only imported when the flag is set — OFF path has zero side-effects.
 *
 * Facade lifecycle:
 *   - Process-local singleton (shared across all createMcpServer() calls).
 *   - In stateless HTTP mode, multiple requests share the same facade instance;
 *     session state (leases, generations) persists within the process lifetime.
 *     This is required: desktop_discover in request N must be followed by desktop_act
 *     in request N+1 using the same session.
 *   - State bleed between targets is prevented by the per-target SessionRegistry
 *     (each hwnd/tabId/windowTitle has its own LeaseStore and generation counter).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { coercedBoolean } from "./_coerce.js";
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput, type DesktopWindowMeta } from "./desktop.js";
import type {
  EntityLease,
  LeaseValidationResult,
  UiEntity,
} from "../engine/world-graph/types.js";
import {
  makeCommitWrapper,
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  genericQueryCausedByProjector,
  defaultQuerySessionId,
  type CommitWrapperOptions,
} from "./_envelope.js";
import { nativeViewFocus } from "../engine/native-engine.js";
import type { NativeLeaseTokenSummary } from "../engine/native-types.js";
import type { ToolResult } from "./_types.js";
import type { TouchAction } from "../engine/world-graph/guarded-touch.js";
import {
  SnapshotIngress,
  combineEventSources,
  createWinEventIngressSource,
} from "../engine/world-graph/candidate-ingress.js";
import { createBrowserIngressSource } from "../engine/world-graph/browser-ingress.js";
import { createTerminalIngressSource } from "../engine/world-graph/terminal-ingress.js";
import { createVisualIngressSource, type VisualIngressSource } from "../engine/world-graph/visual-ingress.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";
import { composeCandidates } from "./desktop-providers/compose-providers.js";
import { getVisualRuntime } from "../engine/vision-gpu/runtime.js";
import { PocVisualBackend } from "../engine/vision-gpu/poc-backend.js";
import { OnnxBackend } from "../engine/vision-gpu/onnx-backend.js";
import { onDirtySignal } from "../engine/vision-gpu/dirty-signal.js";
import { _resetOcrAdaptersForTest, getOcrVisualAdapter } from "../engine/vision-gpu/ocr-adapter-registry.js";
import { DirtyRectRouter } from "../engine/vision-gpu/dirty-rect-source.js";
import {
  enumWindowsInZOrder,
  getWindowProcessId,
  getProcessIdentityByPid,
  getWindowRectByHwnd,
} from "../engine/win32.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import {
  disposeSharedSubscriptionCache,
  verifyAnyChange,
} from "../engine/any-change.js";
import type { VisualMotionObservation } from "./_input-pipeline.js";

// ── G1: Production guards (viewport + focus) ──────────────────────────────────

/**
 * G1-B: Production viewport guard.
 *
 * Structured sources (uia, cdp, terminal) guarantee that the element is accessible
 * to the OS at the time of candidate resolution — they cannot be truly "out of viewport"
 * from the OS's perspective. We pass these conservatively.
 *
 * Visual-only entities with a rect are checked against the current foreground window.
 * If the entity center lies outside the foreground window's region, we block the touch.
 * Conservative fallback (return true) on any Win32 error.
 */
function productionIsInViewport(entity: UiEntity): boolean {
  if (!entity.rect) return true; // no rect → can't check → conservative pass
  // Structured sources: OS guarantees accessibility, skip rect check.
  if (entity.sources.some((s) => s === "uia" || s === "cdp" || s === "terminal")) return true;
  // Visual-only: check entity rect against current foreground window.
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    if (!fg) return true; // no foreground window → conservative pass
    return computeViewportPosition(entity.rect, fg.region) === "in-view";
  } catch {
    return true; // conservative on Win32 error
  }
}

/**
 * G1-C: Production focus fingerprint (window-level, best-effort).
 *
 * Returns the foreground window's hwnd as an opaque string.
 * When the foreground shifts between pre- and post-touch snapshots,
 * GuardedTouchLoop emits focus_shifted in the diff.
 * Conservative: returns undefined on any Win32 error.
 */
function productionGetFocusedEntityId(): string | undefined {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    return fg ? `hwnd:${fg.hwnd}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Issue #295 carry-over — foreground HWND resolver for the UIA-cache-stale
 * check in `DesktopFacade.see()`. Returns the active window's HWND as a
 * bigint, or null on enumeration failure / no active window. Reuses the
 * same `enumWindowsInZOrder` source as `productionGetFocusedEntityId` so
 * the two stay consistent across calls.
 */
function productionGetFocusedHwnd(): bigint | null {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    if (!fg) return null;
    return typeof fg.hwnd === "bigint" ? fg.hwnd : BigInt(fg.hwnd);
  } catch {
    return null;
  }
}

/**
 * Production windowsProvider with a short-lived (default 100ms) result cache.
 *
 * Audit P1-1 (docs/v1-release-readiness-review.md §8.2): every desktop_discover
 * call previously re-ran enumWindowsInZOrder + getWindowProcessId +
 * getProcessIdentityByPid for every visible window — on a desktop with 40+
 * windows this is tens of ms per call and shows up in chained workflows
 * (desktop_state → desktop_discover → desktop_act). A coarse TTL cache
 * collapses bursts of see() calls without hiding real focus shifts (the
 * windowsProvider is intentionally re-evaluated whenever the cache TTL
 * expires; OS-level focus changes between snapshots are observed by the
 * separate `getFocusedEntityId` path).
 *
 * Time source: defaults to `performance.now()` (monotonic), so wall-clock
 * adjustments — NTP step-back, manual clock changes, VM snapshot restore —
 * never make a stale entry look fresh. The path also defends with `t >=
 * cached.at` so an injected non-monotonic `nowFn` (or any future regression)
 * still falls through to a re-enumeration on backward time travel rather
 * than serving the previous snapshot. (Codex PR #53 P2.)
 *
 * `nowFn`, `ttlMs`, `enumerate`, and `resolveProcessName` are injectable for
 * unit testing.
 */
export interface WindowsProviderCacheOptions {
  ttlMs?: number;
  nowFn?: () => number;
  /** Override the raw window enumerator. Tests inject a fake; production uses enumWindowsInZOrder. */
  enumerate?: typeof enumWindowsInZOrder;
  /** Override per-hwnd process info. Tests inject a fake; production uses getWindowProcessId + getProcessIdentityByPid. */
  resolveProcessName?: (hwnd: bigint | number) => string | undefined;
}

function defaultResolveProcessName(hwnd: bigint | number): string | undefined {
  try {
    const pid = getWindowProcessId(hwnd);
    return getProcessIdentityByPid(pid).processName;
  } catch {
    return undefined;
  }
}

export function createCachedProductionWindowsProvider(
  options: WindowsProviderCacheOptions = {},
): () => DesktopWindowMeta[] {
  const ttlMs = options.ttlMs ?? 100;
  const now = options.nowFn ?? (() => performance.now());
  const enumerate = options.enumerate ?? enumWindowsInZOrder;
  const resolveProcessName = options.resolveProcessName ?? defaultResolveProcessName;
  let cached: { at: number; result: DesktopWindowMeta[] } | undefined;

  return () => {
    const t = now();
    // Defensive: ignore the cached entry if the clock moved backward since it
    // was stored. With the default monotonic clock this branch is unreachable;
    // it exists so an injected non-monotonic `nowFn` (or a future regression)
    // can't keep serving stale windows past the TTL.
    if (cached && t >= cached.at && t - cached.at < ttlMs) return cached.result;
    const result = enumerate().map((w) => {
      const processName = resolveProcessName(w.hwnd);
      return {
        zOrder: w.zOrder,
        title: w.title,
        hwnd: String(w.hwnd),
        region: w.region,
        isActive: w.isActive,
        isMinimized: w.isMinimized,
        isMaximized: w.isMaximized,
        processName,
      };
    });
    cached = { at: t, result };
    return result;
  };
}

// ── Process-level facade singleton ───────────────────────────────────────────

let _facade: DesktopFacade | undefined;

/** Process-level visual invalidation hook. Call to trigger visual cache refresh. */
let _visualSource: VisualIngressSource | undefined;

/** Process-level PoC visual backend. Expose for P3-D pipeline to call updateSnapshot(). */
let _pocBackend: PocVisualBackend | undefined;

/**
 * Phase 4a (ADR-005): OnnxBackend (Rust-internal vision_backend). Attached when:
 *   1. Native vision binding is loaded (`OnnxBackend.isAvailable()`)
 *   2. `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND=1` opt-in is set
 *   3. `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` is unset
 * If any condition fails, falls back to `PocVisualBackend`. This keeps Phase 1-3
 * behaviour intact until the operator explicitly enables Phase 4 path.
 */
let _onnxBackend: OnnxBackend | undefined;

/** Phase 3: dirty-rect router (Desktop Duplication → RoiScheduler → OcrVisualAdapter). */
let _dirtyRouter: DirtyRectRouter | undefined;

/**
 * @internal Test-only entry point. Production code does not call this.
 * Kept exported for `tests/unit/{dirty-signal,poc-backend,benchmark-gates}.test.ts`
 * which need to inject snapshots without touching CandidateProducer.
 *
 * The production dataplane feeds PocVisualBackend via pushDirtySignal
 * from OcrVisualAdapter (Phase 1) and, in Phase 3+, from the dirty-rect
 * event loop. External callers should use pushDirtySignal, not this function.
 */
export function getVisualIngressSource(): VisualIngressSource | undefined {
  return _visualSource;
}

/**
 * @internal Same rationale as getVisualIngressSource.
 * Call backend.updateSnapshot(targetKey, candidates) to deliver stable candidates.
 */
export function getPocVisualBackend(): PocVisualBackend | undefined {
  return _pocBackend;
}

/**
 * @internal Phase 4a — return the OnnxBackend when attached, otherwise undefined.
 * Used by tests that want to verify the Rust-internal vision_backend is wired.
 * Production code should not depend on this; use `getVisualRuntime()` instead.
 */
export function getOnnxBackend(): OnnxBackend | undefined {
  return _onnxBackend;
}

/**
 * Return the process-level DesktopFacade.
 * Created lazily on first call; no heavy initialization happens at import time.
 *
 * P2-B: uses composeCandidates() as the provider — routes to browser/terminal/uia
 * based on target type and merges results additively.
 */
/**
 * Return the process-level DesktopFacade.
 *
 * P2-E: uses a composite event source that combines:
 *   - WinEvent (window appear/disappear/foreground)  → native window keys
 *   - CDP lifecycle change detection                  → tab: keys
 *   - Terminal buffer fingerprint change              → title: terminal keys
 *   - Visual manual invalidation hook                 → any key (GPU pipeline)
 */
/**
 * P3-B: Attach PocVisualBackend to the global VisualRuntime and wire its dirty
 * signals to the visual ingress source so target caches are invalidated automatically
 * when the GPU pipeline produces new stable candidates.
 *
 * Flow:
 *   PocVisualBackend.updateSnapshot(targetKey, candidates)
 *     → backend fires dirty listeners
 *     → VisualIngressSource.markDirty(targetKey)
 *     → next see() call: ingress.getSnapshot(targetKey) refreshes from visual provider
 */
async function initVisualRuntime(visualSource: VisualIngressSource): Promise<void> {
  // Phase 4a (ADR-005): prefer Rust-internal OnnxBackend when available and
  // explicitly opted in. Falls back to PocVisualBackend otherwise so that
  // Phase 1-3 behaviour is unchanged when the operator has not enabled Phase 4.
  const onnxOptIn = process.env["DESKTOP_TOUCH_ENABLE_ONNX_BACKEND"] === "1";
  const useOnnx = onnxOptIn && OnnxBackend.isAvailable();

  if (useOnnx) {
    const backend = new OnnxBackend();
    _onnxBackend = backend;
    backend.onDirty((targetKey) => visualSource.markDirty(targetKey, "dirty-rect"));
    onDirtySignal((targetKey, candidates) => {
      backend.updateSnapshot(targetKey, candidates);
    });
    await getVisualRuntime().attach(backend);
    console.error("[desktop-register] visual lane: OnnxBackend attached (ADR-005 Phase 4a)");
    return;
  }

  // Default: PocVisualBackend (Phase 1-3 behaviour).
  const backend = new PocVisualBackend();
  _pocBackend = backend;
  backend.onDirty((targetKey) => visualSource.markDirty(targetKey, "dirty-rect"));
  onDirtySignal((targetKey, candidates) => {
    backend.updateSnapshot(targetKey, candidates);
  });
  await getVisualRuntime().attach(backend);
  if (onnxOptIn) {
    console.error(
      "[desktop-register] visual lane: PocVisualBackend attached " +
      "(ENABLE_ONNX_BACKEND=1 set but native vision addon unavailable — falling back)",
    );
  }
}

export function getDesktopFacade(): DesktopFacade {
  if (!_facade) {
    const provider: CandidateProvider = async (input: DesktopSeeInput) =>
      (await composeCandidates(input.target)).candidates;

    _visualSource = createVisualIngressSource();

    const ingress = new SnapshotIngress(
      (key: string) => composeCandidates(targetKeyToSpec(key)),
      combineEventSources([
        createWinEventIngressSource(),
        createBrowserIngressSource(),
        createTerminalIngressSource(),
        _visualSource,
      ])
    );

    _facade = new DesktopFacade(provider, {
      // Sweep stale sessions every 30s. The default sessionTtlMs is 120s
      // (2 min idle), so ~one timer fire after a session goes idle is enough
      // to keep the registry from growing unbounded over a long-running
      // process. The timer is .unref'd inside the facade so it never
      // holds the process open on its own.
      sessionEvictionIntervalMs: 30_000,
      ingress,
      // G1-B: viewport guard — blocks visual-only entities outside the foreground window.
      isInViewport: productionIsInViewport,
      // G1-C: window-level focus fingerprint for focus_shifted diff.
      getFocusedEntityId: productionGetFocusedEntityId,
      // Issue #295 carry-over — foreground HWND for the see() UIA-cache-stale
      // check. Same enumWindowsInZOrder source as getFocusedEntityId above.
      getFocusedHwnd: productionGetFocusedHwnd,
      // G1-A: modal guard — session-aware default in session-registry.ts (UIA unknown-role).
      // No override needed here; the session-registry default is already production-grade.
      // Phase 4 (Codex PR #41 round 5 P1): production windows enumerator —
      // wraps enumWindowsInZOrder + processName resolution. The facade catches
      // any throw and returns [] in that case, so this is allowed to fail.
      // Audit P1-1: 100ms TTL cache prevents the per-window pid+processName
      // round-trip storm when chained tool calls land in the same tick.
      windowsProvider: createCachedProductionWindowsProvider(),
    });

    // Wire the visual runtime (non-blocking — failure does not prevent facade creation).
    // Guarded by DESKTOP_TOUCH_DISABLE_VISUAL_GPU so operators can suppress the
    // entire visual lane (PocVisualBackend never attaches, 50ms warmup never runs).
    //
    // First-request window: `initVisualRuntime` is async. Between `getDesktopFacade()`
    // returning and the attach completing, `runtime.isAvailable()` is false and
    // `fetchVisualCandidates` emits `visual_provider_unavailable`. This is correct
    // behavior (the backend is genuinely not ready yet) and harmless in practice
    // because the first see() call typically arrives after the event loop yields.
    //
    // Before Phase 4 default-on: consider making getDesktopFacade() return
    // Promise<DesktopFacade> and awaiting this to eliminate the window entirely.
    if (process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] !== "1") {
      initVisualRuntime(_visualSource).catch((err) => {
        console.error("[desktop-register] Failed to initialize visual runtime:", err);
      });

      // Phase 3: start dirty-rect router. Routes Desktop Duplication events
      // to the foreground window's OcrVisualAdapter for immediate re-polling.
      // Falls back to no-op if native addon is absent (no RDP error, just silence).
      if (process.env["DESKTOP_TOUCH_DISABLE_DIRTY_RECTS"] !== "1") {
        _dirtyRouter = new DirtyRectRouter({
          onRois: (_rois, _nowMs) => {
            // Phase 3: trigger the foreground window's OCR adapter on dirty-rect events.
            // Full per-roi recognition is deferred to Phase 4 (real detector).
            try {
              const wins = enumWindowsInZOrder();
              const fg = wins.find((w) => w.isActive);
              if (!fg) return;
              const target = { hwnd: String(fg.hwnd), windowTitle: fg.title };
              void getOcrVisualAdapter(target).pollOnce(target).catch(() => {});
            } catch { /* best-effort */ }
          },
          onFallback: (reason) => {
            console.error(`[desktop-register] DirtyRectRouter fallback: ${reason}`);
          },
        });
        _dirtyRouter.start();
      }
    }
  }
  return _facade;
}

/**
 * Parse a TargetSessionKey back to a TargetSpec.
 * `window:__default__` returns undefined; composeCandidates() then resolves the
 * current foreground window and routes providers against that live target.
 */
function targetKeyToSpec(key: string): TargetSpec | undefined {
  if (key.startsWith("window:") && key !== "window:__default__") return { hwnd: key.slice(7) };
  if (key.startsWith("tab:"))    return { tabId: key.slice(4) };
  if (key.startsWith("title:"))  return { windowTitle: key.slice(6) };
  return undefined;
}

/**
 * Reset the facade singleton (for testing only).
 * Calls dispose() to close ingress event subscriptions before clearing.
 */
export function _resetFacadeForTest(): void {
  (_facade as unknown as { dispose?: () => void })?.dispose?.();
  _facade = undefined;
  _visualSource = undefined;
  _pocBackend = undefined;
  void _onnxBackend?.dispose();
  _onnxBackend = undefined;
  _dirtyRouter?.stop();
  _dirtyRouter = undefined;
  // ADR-019 Stage 5 (§6 R2) — release any cached DXGI subscriptions so the
  // DXGI session doesn't leak across test runs.
  disposeSharedSubscriptionCache();
  _resetOcrAdaptersForTest();
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const targetSchema = z.object({
  windowTitle: z.string().optional(),
  hwnd:        z.string().optional(),
  tabId:       z.string().optional(),
}).optional();

const leaseSchema = z.object({
  entityId:         z.string(),
  viewId:           z.string(),
  targetGeneration: z.string(),
  expiresAtMs:      z.number(),
  evidenceDigest:   z.string(),
});

// Phase 4 (Codex PR #41 P1): exported so run_macro DSL can register
// desktop_discover / desktop_act in its own TOOL_REGISTRY without duplicating
// the schema literals.
export const desktopSeeSchema = {
  target:      targetSchema.describe("Target window (windowTitle / hwnd) or browser tab (tabId). Omit for foreground window."),
  view:        z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query:       z.string().optional().describe("Filter entities by label substring (case-insensitive)"),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug:       coercedBoolean().optional().describe("Include raw screen coordinates in response (debug only — never relay to end-users)"),
};

export const desktopTouchSchema = {
  lease:  leaseSchema.describe("Lease returned by desktop_discover. Expires after TTL; re-call desktop_discover if desktop_act fails with lease_expired."),
  action: z.enum(["auto", "invoke", "click", "type", "setValue", "select"]).optional().describe(
    "Action to perform. 'auto' selects the best affordance from the entity. " +
    "'setValue' (Phase 4: absorbs former set_element_value) sets a UIA ValuePattern value or fills a CDP controlled input — pass the new value via text."
  ),
  text:   z.string().optional().describe("Text to type or set (required when action='type' or action='setValue')."),
};

/**
 * Phase 4 (Codex PR #41 round 3 P1): runtime guard that desktop_act callers
 * must provide `text` for `action='type'` / `action='setValue'`. Without
 * this, the executor falls through to a UIA click — silently triggering an
 * unintended side effect instead of a validation error. Used by both the
 * MCP registration closure below and the run_macro DSL handler in macro.ts.
 *
 * Empty string is *not* missing — `text: ""` is a legitimate clear-field
 * operation that the executor (`text !== undefined` gate in
 * desktop-executor.ts) routes through `uiaSetValue` / `cdpFill` to clear
 * the target. This mirrors the legacy `set_element_value` contract.
 * (Codex PR #41 round 4 P2.)
 *
 * Returns null on success; an error message on failure.
 */
export function validateDesktopTouchTextRequirement(
  action: string | undefined,
  text: string | undefined,
): string | null {
  if ((action === "type" || action === "setValue") && text === undefined) {
    return `desktop_act(action='${action}') requires text — without it the executor falls through to a click on the target entity, which is almost never what you want. Pass text explicitly (use text:'' to clear a field), or use action='click' / 'invoke' for a click-style interaction.`;
  }
  return null;
}

// ── L5 commit / query wrapper integration (ADR-010 P1 S4) ─────────────────────
//
// Sub-plan: `docs/adr-010-p1-s4-plan.md` §2.1 + §2.5 + §3.3.
//
// Same module-scope wrapping pattern as `desktop-state.ts` from S3 (PR
// #112): wrap once here so `server.tool` (this file's
// `registerDesktopTools`) and `run_macro` dispatcher (`./macro.ts`
// `TOOL_REGISTRY`) share the SAME wrapped handler + injected schema.
// Without this, macro 経路 would re-`z.object(rawSchema).parse(args)`
// and silently strip the wrapper-layer `args.include` field, breaking
// per-call envelope opt-in (PR #112 P1-1 同型 risk pattern).

/** desktop_discover (query-axis) raw handler. Calls into the facade
 *  unchanged; the L5 query wrapper takes care of envelope assembly +
 *  compat hoist + per-call `include` opt-in. */
const desktopDiscoverRawHandler = async (input: unknown): Promise<ToolResult> => {
  const output = await getDesktopFacade().see(input as DesktopSeeInput);
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
};

/** desktop_act (commit-axis) raw handler. Internal logic, Zod schema,
 *  and return shape are unchanged from before S4 (ADR-010 §1.5 spirit:
 *  individual tool implementations stay envelope-agnostic). The L5
 *  commit wrapper layers on lease pre-flight + ToolCall event emission +
 *  envelope assembly.
 *
 *  ADR-019 Stage 5 wiring (sub-plan §2.3.1): after a successful touch,
 *  resolve the target window's HWND from the issuing session's
 *  `lastTarget`, call `verifyAnyChange`, and attach the resulting
 *  `VisualMotionObservation` to `result.observation`. Gated on
 *  `DESKTOP_TOUCH_STAGE5_DXGI !== "0"` (default ON; opt-out by setting
 *  to `"0"`). Failures degrade silently — observation absence is
 *  bit-equal to the pre-Stage-5 envelope. */
const desktopActRawHandler = async (
  input: { lease: EntityLease; action?: TouchAction; text?: string },
): Promise<ToolResult> => {
  const validationError = validateDesktopTouchTextRequirement(input.action, input.text);
  if (validationError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: validationError }, null, 2) }],
    };
  }
  const facade = getDesktopFacade();
  const result = await facade.touch({
    lease: input.lease,
    action: input.action,
    text: input.text,
  });

  if (result.ok && process.env["DESKTOP_TOUCH_STAGE5_DXGI"] !== "0") {
    const observation = await tryVerifyAnyChange(facade, input.lease.viewId);
    if (observation !== null) {
      (result as { observation?: VisualMotionObservation }).observation = observation;
    }
  }

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};

/**
 * Stage 5 sub-plan §2.3.1 — resolve the target HWND from the lease's session
 * `lastTarget`, fetch the window rect, and run `verifyAnyChange`. Returns
 * `null` when the target cannot be resolved (no `hwnd` in the target spec —
 * e.g. CDP tab or windowTitle-only target without a resolved HWND, or the
 * window rect lookup failed). All other paths (DXGI unsupported, AccessLost,
 * etc.) return a degraded `VisualMotionObservation` from `verifyAnyChange`
 * itself rather than `null`.
 */
async function tryVerifyAnyChange(
  facade: DesktopFacade,
  viewId: string,
): Promise<VisualMotionObservation | null> {
  const target = facade.getTargetForViewId(viewId);
  if (!target?.hwnd) return null;
  let hwnd: bigint;
  try {
    hwnd = BigInt(target.hwnd);
  } catch {
    return null;
  }
  const windowRect = getWindowRectByHwnd(hwnd);
  if (windowRect === null || windowRect.width <= 0 || windowRect.height <= 0) {
    return null;
  }
  try {
    return await verifyAnyChange({ hwnd, windowRect });
  } catch {
    // Defensive: orchestrator promises never to throw, but a bug there must
    // not break the envelope.
    return null;
  }
}

/** Pre-flight lease validation closure used by the commit wrapper
 *  (sub-plan §3.4). Routes to the same session the lease was issued
 *  from and runs `LeaseStore.validate()` without executing the touch.
 *  When the lease arg is missing/malformed (caller passed garbage) we
 *  return `entity_not_found` so the wrapper emits a typed envelope
 *  rather than crashing inside the validator. */
function desktopActLeaseValidator(args: unknown): Promise<LeaseValidationResult> {
  const i = args as { lease?: EntityLease };
  if (!i?.lease || typeof i.lease.viewId !== "string") {
    return Promise.resolve({ ok: false, reason: "entity_not_found" });
  }
  return Promise.resolve(getDesktopFacade().validateLeaseOnly(i.lease));
}

/** Project the lease 4-tuple from `desktop_act` args into the
 *  `NativeLeaseTokenSummary` carried on the L1 `ToolCallStarted`
 *  payload (sub-plan §2.3). `evidenceDigestPrefix8` is the first 8
 *  chars of the full digest so the L1 ring stays compact when
 *  lease-aware tool calls are emitted at high rate. */
function desktopActExtractLeaseToken(args: unknown): NativeLeaseTokenSummary | undefined {
  const i = args as { lease?: EntityLease };
  if (!i?.lease) return undefined;
  return {
    entityId: i.lease.entityId,
    viewId: i.lease.viewId,
    targetGeneration: i.lease.targetGeneration,
    evidenceDigestPrefix8: (i.lease.evidenceDigest ?? "").slice(0, 8),
  };
}

/** `fetchMeta` for the envelope `as_of.wallclock_ms` source. Same
 *  pattern as `desktop-state.ts` (PR #112): read the L1 event
 *  wallclock + view-poisoned signal via the `viewGetFocusedWithWallclock`
 *  napi binding. Defensive paths: degrade to `Date.now()` fallback +
 *  `confidence: degraded` when the binding is missing or throws. */
const fetchEnvelopeMeta = async () => {
  if (
    nativeViewFocus &&
    typeof nativeViewFocus.viewGetFocusedWithWallclock === "function"
  ) {
    try {
      const meta = nativeViewFocus.viewGetFocusedWithWallclock();
      return {
        viewPoisoned: meta.viewPoisoned,
        asOfWallclockMs:
          meta.latestEventWallclockMs != null
            ? Number(meta.latestEventWallclockMs)
            : null,
      };
    } catch {
      return { viewPoisoned: true, asOfWallclockMs: null };
    }
  }
  return { viewPoisoned: false, asOfWallclockMs: null };
};

/** Round 1 P2 fix (Codex + user PR review): derive `tool_call_id`'s
 *  session-id source from the lease's `viewId` so the per-session
 *  monotone seq the wrapper emits (`${sessionId}:${seq}`) reflects
 *  the SessionRegistry's per-target session boundaries. Without this
 *  override, `makeCommitWrapper` falls back to the hard-coded
 *  `"default"` session and collapses every desktop_act call across
 *  every target/view into a single global seq — violating sub-plan
 *  §2.1 + §3.5 contract that tool_call_id is session-local.
 *
 *  Falls back to `"default"` when the lease arg is missing/malformed
 *  (the wrapper's leaseValidator has already short-circuited those
 *  cases on the failure path; the fallback is purely defensive). */
function desktopActSessionId(args: unknown): string {
  const lease = (args as { lease?: EntityLease }).lease;
  return typeof lease?.viewId === "string" && lease.viewId.length > 0
    ? lease.viewId
    : "default";
}

const desktopActWrapperOptions: CommitWrapperOptions<Record<string, unknown>> = {
  fetchMeta: fetchEnvelopeMeta,
  leaseValidator: desktopActLeaseValidator,
  extractLeaseToken: desktopActExtractLeaseToken,
  getSessionId: desktopActSessionId,
};

/** Module-scope schema with `include?: string[]` injected so MCP SDK's
 *  `server.tool()` Zod parse step preserves it for `makeQueryWrapper` /
 *  `makeCommitWrapper` to peek (PR #112 Round 1 P1 fix, sub-plan §2.5). */
export const desktopDiscoverRegistrationSchema = withEnvelopeIncludeSchema(desktopSeeSchema);
export const desktopActRegistrationSchema = withEnvelopeIncludeSchema(desktopTouchSchema);

/** Module-scope wrapped handlers (envelope-aware). Used by both the
 *  `server.tool` registration site below and `./macro.ts`
 *  `TOOL_REGISTRY` so the wrapper layer is honoured uniformly across
 *  the direct MCP path and the `run_macro` dispatcher (sub-plan §2.5,
 *  PR #112 same-pattern fix). */
export const desktopDiscoverRegistrationHandler = makeQueryWrapper(
  desktopDiscoverRawHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "desktop_discover",
  {
    fetchMeta: fetchEnvelopeMeta,
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export const desktopActRegistrationHandler = makeCommitWrapper(
  desktopActRawHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "desktop_act",
  desktopActWrapperOptions,
);

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register desktop_discover and desktop_act on the MCP server.
 * Called by default on v0.17+; suppressed only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1.
 * See docs/anti-fukuwarai-v2-activation-policy.md.
 */
export function registerDesktopTools(server: McpServer): void {
  // Eagerly initialise the facade so the visual runtime + dirty-rect
  // router boot at registration time (matches pre-S4 behaviour). The
  // raw handlers below also call `getDesktopFacade()` lazily, but a
  // first-request without prior init would lose the initial 50ms
  // visual warmup window — keep the eager call for parity.
  getDesktopFacade();

  // S4 (sub-plan §2.5): pass the module-scope schema + handler so the
  // run_macro dispatcher reuses the SAME wrapped instances. Side
  // effect: lease pre-flight + ToolCall events + envelope assembly
  // are owned by the L5 wrapper, not the raw handlers.
  server.tool(
    "desktop_discover",
    [
      "[EXPERIMENTAL] Find actionable entities and emit leases for desktop_act. Observe a window or browser tab and return interactive entities as structured data.",
      "Supports multiple source lanes: UIA (native), CDP (browser), terminal buffer, and visual GPU.",
      "Returns entities with leases — pass a lease to desktop_act to interact.",
      "Raw screen coordinates are NOT returned in normal mode (debug=true only).",
      "If response.warnings[] is non-empty, results may be partial.",
      "response.constraints (when present) is a structured summary of provider limitations — use it to decide fallback without parsing warnings[] strings.",
      "constraints.entityZeroReason (when entities is empty) explains WHY: foreground_unresolved → add target.windowTitle;",
      "uia_blind_visual_unready → retry when visual backend is ready or use screenshot(ocrFallback=always);",
      "uia_blind_visual_empty → use screenshot(ocrFallback=always) or V1 click_element;",
      "cdp_failed_visual_empty → check --remote-debugging-port=9222 and retry;",
      "all_providers_failed → use V1 tools (click_element / terminal(action='read') / screenshot);",
      "constraints.uia=blind_single_pane → PWA/Electron/canvas; try view=debug or screenshot(ocrFallback=always);",
      "constraints.cdp=provider_failed → check --remote-debugging-port=9222;",
      "constraints.terminal=provider_failed → use V1 terminal(action='read'/'send');",
      "Recovery: no_provider_matched → add target.windowTitle or retry; partial_results_only → compare with V1 click_element;",
      "cdp_provider_failed → check --remote-debugging-port=9222;",
      "visual_provider_unavailable / visual_provider_warming → server retried once (~200ms); if still warned, continue with structured lane or retry later;",
      "uia/terminal_provider_failed → use V1 tools (click_element / terminal(action='read'));",
      "uia_blind_single_pane / uia_blind_too_few_elements → target is PWA/Electron/canvas; try view=debug for visual lane hints, or fall back to screenshot(ocrFallback=always);",
      "visual_not_attempted → GPU backend unavailable; use V1 screenshot+mouse_click or wait and retry;",
      "visual_attempted_empty → visual lane ran but produced no stable candidates; consider screenshot(ocrFallback=always) or V1 tools;",
      "visual_attempted_empty_cdp_fallback → CDP failed and visual also empty (browser); check --remote-debugging-port=9222 and retry;",
      "dialog_resolved_via_owner_chain → common dialog (Save As/Open) found via owner chain; targeting is now hwnd-based;",
      "parent_disabled_prefer_popup → parent window blocked by a modal; switched to targeting the active popup dialog.",
      "response.softExpiresAtMs is an advisory timestamp at ~60% of the lease TTL window — past it the LLM should consider re-calling desktop_discover even though leases are still technically valid; lease.expiresAtMs remains the only correctness wall.",
      "Issue #296: entities[].capabilities (when present) advises executor selection. preferredExecutors[0] is the executor most likely to succeed; if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element (saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls).",
    ].join(" "),
    desktopDiscoverRegistrationSchema,
    desktopDiscoverRegistrationHandler as (input: unknown) => Promise<ToolResult>,
  );

  server.tool(
    "desktop_act",
    [
      "[EXPERIMENTAL] Act on a discovered entity (click/type/setValue/scroll). Use desktop_act.",
      "Validates the lease before executing — rejects stale, expired, or mismatched leases.",
      "Returns a semantic diff (entity_disappeared, modal_appeared, etc.) and a 'next' hint.",
      "If ok=false, read 'reason':",
      "  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_discover;",
      "  modal_blocking → response.blockingElement (when present) names the blocker — dismiss via V1 click_element(name=blockingElement.name) then retry;",
      "  entity_outside_viewport → scroll via V1 scroll(action='raw'/'to_element') then retry;",
      "  executor_failed → fall back to V1 tools (click_element / mouse_click / browser_click);",
      "  executor_failed on terminal textbox (action=type) → use V1 terminal(action='send') instead.",
      "Check desktop_discover response.constraints for pre-emptive fallback hints before calling desktop_act.",
    ].join(" "),
    desktopActRegistrationSchema,
    desktopActRegistrationHandler as (input: unknown) => Promise<ToolResult>,
  );
}
