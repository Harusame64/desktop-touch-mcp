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
import { failCode, getSuggestsForCode } from "./_errors.js";
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
  toFailureEnvelope,
  type CommitWrapperOptions,
} from "./_envelope.js";
import { nativeViewFocus } from "../engine/native-engine.js";
import type { NativeLeaseTokenSummary } from "../engine/native-types.js";
import type { ToolResult } from "./_types.js";
import { Err } from "../types/result.js";
import { ExecutorFailedError } from "../errors/typed-errors.js";
import type { TouchAction, RoiCapture, RoiCaptureMaterial } from "../engine/world-graph/guarded-touch.js";
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
import { verifyAnyChange } from "../engine/any-change.js";
import { captureFrame, type RawFrame } from "../engine/layer-buffer.js";
import { verifyLocalRepaint } from "../engine/local-repaint.js";
import { disposeSharedDirtyRectBroker } from "../engine/dxgi-broker.js";
import type { VisualMotionObservation } from "./_input-pipeline.js";
import { shouldReturnRoiCapture, type ReturnCaptureMode } from "./_roi-capture-gate.js";
import { filterDirtyRectsToWindow, boundingBox, clampRectToWindow, resolveFoldOcrRoi } from "./_roi-region.js";
import { buildRoiPreviewEntities, somElementsToCandidates } from "./_roi-preview.js";
import { runSomPipeline } from "../engine/ocr-bridge.js";
import type { Rect, UiEntityCandidate } from "../engine/vision-gpu/types.js";
import { createDefaultCapabilityRegistry } from "../capabilities/registry.js";

// ── Advisory registry singleton (PR-SR1-3) ────────────────────────────────────

/**
 * Module-level singleton — pure, no internal state.  Safe for concurrent /
 * parallel test execution and multi-request HTTP mode (北極星 1 + sub-plan §4.2).
 */
const advisoryRegistry = createDefaultCapabilityRegistry();

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
  // ADR-019 Stage 5 (§6 R2) + ADR-020 SR-4 PR-SR4-2 — release the shared
  // DXGI broker so the DXGI session doesn't leak across test runs.
  disposeSharedDirtyRectBroker();
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
  returnCapture: z.enum(["on-change", "always", "never"]).optional().describe(
    "[EXPERIMENTAL] ADR-024 Seed-2 — controls the post-action ROI capture on visual-only targets " +
    "(UIA-blind / RDP / canvas). When it attaches, a successful act carries a 'roiCapture' " +
    "{ roi, somImage, entities }: a base64 PNG crop of the changed region plus a lease-less entity " +
    "preview, so you can confirm the result and find the next target without a separate desktop_state / " +
    "screenshot. The entities are previews only (no lease) — re-run desktop_discover to act on them. " +
    "Semantics: 'on-change' (default for visual-only targets) attaches only on a visible change; 'always' " +
    "on any successful visual-only act; 'never' suppresses it. No effect on structured targets " +
    "(browser/CDP, UIA-rich native) — 'roiCapture' is never attached there; use desktop_state."
  ),
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
export const desktopActRawHandler = async (
  // ADR-024 Seed-2 S1: `returnCapture` is accepted (and advertised in the schema)
  // so callers can start opting in; population of `result.roiCapture` is wired in
  // S2+ (gate plumbing). In S1 the field is always absent — existing responses are
  // bit-equal.
  input: { lease: EntityLease; action?: TouchAction; text?: string; returnCapture?: ReturnCaptureMode },
): Promise<ToolResult> => {
  const validationError = validateDesktopTouchTextRequirement(input.action, input.text);
  if (validationError) {
    // validationError is already fully-qualified ("desktop_act(action='...') requires
    // text — ..."), so emit it verbatim via failCode (NOT failArgs, which would
    // re-prefix "desktop_act: " and double the tool name — Codex PR #380 P2). Adds
    // the InvalidArgs code + its recovery suggest (OQ-9 c) without touching the message.
    return failCode("InvalidArgs", validationError, { suggest: getSuggestsForCode("InvalidArgs") });
  }
  const facade = getDesktopFacade();

  // ADR-024 Seed-2 S5c-1a — for visual-only targets, derive the post-action
  // motion verdict (and, via buildRoiCapture, the ROI) from a true window
  // frame-diff rather than DXGI dirty rects. A PrintWindow pre/post diff captures
  // only the target window's own pixels (occlusion-immune) and never touches the
  // DXGI dirty-rect broker, so it sidesteps both dogfood defects: F1 (occlusion-
  // blind geometry filter) and F2 (the same-process DirtyRectRouter draining the
  // frame before the act polls). See adr-024-seed2-dogfood-findings. The pre-
  // action frame MUST be captured BEFORE the touch, so resolve the visual-only
  // flag + window geometry up front. Non-visual-only targets are untouched: they
  // keep the DXGI tryVerifyAnyChange path and their `result.observation` stays
  // byte-equal (ADR-019 Stage 5 telemetry contract; S5c review R2-P1).
  const postVerifyEnabled = process.env["DESKTOP_TOUCH_STAGE5_DXGI"] !== "0";
  // ADR-024 Seed-2 S5b — the order-trap fold. When ON (default) a visual-only
  // act folds its post-touch confirmation into a SINGLE ROI-OCR feeding BOTH the
  // diff and the roiCapture (one OCR vs S5's two). `=0` falls back to the S5
  // 2-OCR path (every composeCandidates lane preserved).
  const foldEnabled = process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"] !== "0";
  const visualOnly = facade.resolveVisualOnlyForViewId(input.lease.viewId);
  let preFrame: RawFrame | null = null;
  let frameDiffHwnd: bigint | null = null;
  let frameDiffWindowRect: { x: number; y: number; width: number; height: number } | null = null;
  let frameDiffPoint: { x: number; y: number } | null = null;
  if (postVerifyEnabled && visualOnly) {
    // Resolve the TARGET window (not foreground): the pre-frame is captured
    // before the click, so a not-yet-foreground windowTitle target must still
    // diff the right window (Codex PR #431 P2).
    frameDiffHwnd = await facade.resolveTargetHwndForFrameDiff(input.lease.viewId);
    if (frameDiffHwnd !== null) {
      const wr = getWindowRectByHwnd(frameDiffHwnd);
      if (wr !== null && wr.width > 0 && wr.height > 0) {
        frameDiffWindowRect = wr;
        // Focal point for the frame-diff = the clicked entity's centre, so the
        // diff clips to a padded region around the expected change rather than
        // diluting a small localized repaint across the whole window (→ false
        // `indeterminate`). Resolved before the touch from the discover snapshot.
        frameDiffPoint = facade.resolveEntityCenterForViewId(
          input.lease.viewId,
          input.lease.entityId,
        );
        preFrame = await captureFrame(frameDiffHwnd, wr);
      }
    }
  }

  // ADR-024 Seed-2 S5b — fold gate. Fold only when: enabled; visual-only;
  // pre-frame + window geometry in hand; AND the discover snapshot is OCR-only
  // (D6 — no visual_gpu lane the OCR-only post could silently drop). Otherwise
  // keep the S5 path (legacy 2-OCR) below, which preserves every lane.
  const fold =
    foldEnabled &&
    postVerifyEnabled &&
    visualOnly &&
    preFrame !== null &&
    frameDiffHwnd !== null &&
    frameDiffWindowRect !== null &&
    !facade.discoverHasVisualGpuForViewId(input.lease.viewId);

  const result = await facade.touch({
    lease: input.lease,
    action: input.action,
    text: input.text,
    // Fold path: the loop invokes this closure (post-execute) in place of
    // env.resolvePostTouchEntities — its single ROI-OCR feeds the diff and the
    // roiCapture. Non-fold: no closure → loop uses the env path (S5, byte-equal).
    ...(fold
      ? {
          postSnapshot: buildFoldPostSnapshot(
            facade,
            input.lease,
            preFrame as RawFrame,
            frameDiffHwnd as bigint,
            frameDiffWindowRect as { x: number; y: number; width: number; height: number },
            frameDiffPoint,
            input.returnCapture,
          ),
        }
      : {}),
  });

  if (fold) {
    // Fold path — the closure already ran the single ROI-OCR and assembled the
    // roiCapture. Lift its internal `roiMaterial` onto the public fields and
    // strip it before serialization (same split discipline as the Stage 5
    // observation/roiBbox plumbing). No second OCR (buildRoiCapture) here.
    if (result.ok) {
      const rm = (result as { roiMaterial?: RoiCaptureMaterial }).roiMaterial;
      delete (result as { roiMaterial?: RoiCaptureMaterial }).roiMaterial;
      if (rm?.observation) {
        (result as { observation?: VisualMotionObservation }).observation = rm.observation;
      }
      if (rm?.roiCapture) {
        (result as { roiCapture?: RoiCapture }).roiCapture = rm.roiCapture;
      }
    }
  } else {
    // ── Legacy S5 path (non-visual / fold-off / visual_gpu present / frame-diff
    // setup missed) — post-verify, then build the roiCapture in a SECOND OCR. ──
    let postVerify: { observation: VisualMotionObservation; dirtyRects: Rect[] } | null = null;
    let frameDiffObservation: VisualMotionObservation | undefined;
    // ADR-024 Seed-2 S5c-1b — the window-relative changed-region bbox from the
    // frame-diff, split off the observation here so it never reaches the public
    // `result.observation` telemetry (R2-P1) and is instead threaded into
    // buildRoiCapture as the localized ROI.
    let frameDiffRoi: Rect | undefined;
    if (result.ok && postVerifyEnabled) {
      if (visualOnly) {
        // Visual-only — frame-diff ONLY. Never fall back to the DXGI verifier:
        // DXGI is exactly the occlusion-blind / drain-race path this phase replaces,
        // so a visual-only frame-diff *miss* (capture/hwnd/rect unavailable) must
        // degrade to no observation — NOT reintroduce F1/F2 via DXGI (Codex PR #431
        // round 2 P2). With no observation the gate sees `motion=undefined` and
        // declines (except `returnCapture:"always"`, whose full-window fallback in
        // buildRoiCapture still applies — a best-effort capture, never DXGI motion).
        if (preFrame !== null && frameDiffHwnd !== null && frameDiffWindowRect !== null) {
          // Stage 4 orchestrator: caller pre-frame + capturePostFrameUntilStable
          // settle + native SIMD computeChangeFraction/SSIM. Its background-animation
          // guard degrades to `indeterminate`, which the gate excludes (so a noisy
          // desktop yields no spurious roiCapture = F1). `observation.source` becomes
          // `ssim_residual` (frame-diff family) on this path only.
          // S5c-1b — opt into the ROI bbox surface so the SAME frame-diff that
          // produces `motion` also yields the localized changed-region rect.
          const frameDiffObs = await verifyLocalRepaint({
            hwnd: frameDiffHwnd,
            hint: {
              windowRect: frameDiffWindowRect,
              ...(frameDiffPoint !== null && { point: frameDiffPoint }),
            },
            preFrame,
            includeRoiBbox: true,
          });
          // Split `roiBbox` off BEFORE assigning `result.observation` (P2-2):
          // `roiBbox` is an internal ROI-source channel, not public Stage 5
          // telemetry — the same split pattern as `tryVerifyAnyChange`'s
          // `dirtyRects`. The destructured `observation` has no `roiBbox` key, so
          // the serialized envelope stays byte-equal with the pre-S5c-1b shape.
          const { roiBbox, ...observation } = frameDiffObs;
          frameDiffObservation = observation;
          frameDiffRoi = roiBbox;
          (result as { observation?: VisualMotionObservation }).observation = observation;
        }
        // else: frame-diff setup missed → degrade silently (no observation, no DXGI).
      } else {
        // Non-visual-only — existing DXGI Stage 5 path (byte-equal). `dirtyRects` is
        // an internal ROI-source channel for buildRoiCapture (S3a), kept off the
        // public `result.observation` telemetry by the split in tryVerifyAnyChange.
        postVerify = await tryVerifyAnyChange(facade, input.lease.viewId);
        if (postVerify !== null) {
          (result as { observation?: VisualMotionObservation }).observation = postVerify.observation;
        }
      }
    }

    // ADR-024 Seed-2 S5 — fold the post-action ROI capture into the act response
    // for visual-only targets. `buildRoiCapture` gates on the visual-only regime +
    // motion verdict, then assembles `{roi, somImage, entities, source}`. Absent
    // (gate declines / no change / no ROI) → response stays bit-equal with the
    // pre-Seed-2 shape (additive — existing destructures unaffected).
    if (result.ok) {
      const roiCapture = await buildRoiCapture(
        facade,
        input.lease.viewId,
        frameDiffObservation ?? postVerify?.observation,
        postVerify?.dirtyRects ?? [],
        input.returnCapture,
        // Source is regime-determined: buildRoiCapture's gate only passes for
        // visual-only targets (the frame-diff regime), so a visual-only capture
        // is always `frame_diff` — including the `returnCapture:"always"` full-
        // window fallback when the frame-diff observation was a miss.
        visualOnly ? "frame_diff" : "dxgi",
        // S5c-1b — the localized changed-region ROI from the frame-diff (when the
        // capture was occlusion-immune). `undefined` → buildRoiCapture falls back
        // to the DXGI dirty-rect bbox (legacy path) or the full window.
        frameDiffRoi,
      );
      if (roiCapture !== undefined) {
        (result as { roiCapture?: RoiCapture }).roiCapture = roiCapture;
      }
    }
  }

  // Issue #327 item G: GuardedTouchLoop.touch returns {ok:false,
  // reason:"executor_failed", diff:[]} on executor exception. Because the handler
  // RETURNS this (does not throw), the L5 makeCommitWrapper treats it as a normal
  // result and would ship no if_unexpected recovery hint. We build the hint here.
  //
  // ADR-021 P1-3: build it through the central toFailureEnvelope converter (north
  // star 1: one failure path) instead of the old hand-spread + local
  // buildExecutorFailedIfUnexpected helper. This handler always returns the RAW
  // shape (the L5 wrapper above applies envelope/optIn), so optIn:false →
  // compatFailureRaw → {ok:false, reason:"executor_failed", diff:[], if_unexpected}.
  // Bit-equal to the pre-migration shape (reason via pascalToSnake("ExecutorFailed"),
  // diff:[] from compatFailureRaw, try_next via SUGGESTS) — pinned by
  // to-failure-envelope-shape-snapshot.test.ts site 7.
  //
  // Scope note: the envelope-mode data->envelope asymmetry (in include=["envelope"]
  // mode the hint surfaces at envelope.data.if_unexpected, not envelope.if_unexpected)
  // is NOT addressed here — normalising it requires the wrapper to treat a
  // handler-returned ok:false as a failure, which is the Phase 5 TOOL_REGISTRY
  // Result-returning change (ADR-021 §2.2 deferred).
  if (!result.ok && result.reason === "executor_failed") {
    const failure = toFailureEnvelope(
      Err(new ExecutorFailedError("desktop_act executor failed")),
      { optIn: false },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
};

/**
 * Stage 5 sub-plan §2.3.1 — resolve the target HWND for the lease's session
 * (via `facade.resolveHwndForViewId`, which first tries the session's pinned
 * `lastTarget.hwnd` and then falls back to the production foreground
 * resolver), fetch the window rect, and run `verifyAnyChange`. Returns
 * `null` only when no HWND can be resolved at all (session evicted,
 * `BigInt(target.hwnd)` parse failure, AND no foreground resolver
 * available) or the window rect lookup failed. All other paths (DXGI
 * unsupported, AccessLost, etc.) return a degraded
 * `VisualMotionObservation` from `verifyAnyChange` itself rather than
 * `null`.
 *
 * Foreground fallback (this PR): the original PR #325 implementation only
 * consulted `lastTarget.hwnd` and therefore went dormant on the typical
 * `desktop_discover()` / `desktop_discover({ windowTitle })` flow where
 * the caller does not pin an HWND. `resolveHwndForViewId` reuses the same
 * foreground resolver `see()` consults for its Issue #295 stale check, so
 * the two paths agree on "which HWND belongs to this session".
 */
async function tryVerifyAnyChange(
  facade: DesktopFacade,
  viewId: string,
): Promise<{ observation: VisualMotionObservation; dirtyRects: Rect[] } | null> {
  const hwnd = facade.resolveHwndForViewId(viewId);
  if (hwnd === null) return null;
  const windowRect = getWindowRectByHwnd(hwnd);
  if (windowRect === null || windowRect.width <= 0 || windowRect.height <= 0) {
    return null;
  }
  try {
    // ADR-024 Seed-2 S3a/S5 — opt into the dirty-rect surface so the SAME poll
    // that produces `motion` also yields the ROI rects (no second DXGI acquire).
    // Split `dirtyRects` off the observation here: it is an internal ROI-source
    // channel for buildRoiCapture, not public observation telemetry, so it never
    // reaches the serialized `result.observation`.
    const obs = await verifyAnyChange({ hwnd, windowRect, includeDirtyRects: true });
    const { dirtyRects, ...observation } = obs;
    return { observation, dirtyRects: dirtyRects ?? [] };
  } catch {
    // Defensive: orchestrator promises never to throw, but a bug there must
    // not break the envelope.
    return null;
  }
}

/**
 * ADR-024 Seed-2 S5 — gate + fold for the post-action `roiCapture`.
 *
 * Returns the capture to attach to a successful `desktop_act`, or `undefined`
 * when the gate declines (non-visual-only target / no change / opt-out) or no
 * ROI is available.
 *
 * Fold (S5, walking-skeleton Option A — additive; the order-trap compute
 * optimization that avoids the post-touch full-window OCR is deferred to S5b):
 *   1. gate on visual-only regime + motion verdict (`shouldReturnRoiCapture`);
 *   2. turn the S3a per-output dirty rects into window-relative rects
 *      (S3b `filterDirtyRectsToWindow`) and reduce them to one ROI (bounding box);
 *   3. OCR only that ROI (S4 `runSomPipeline(..., roi)`) → `somImage` crop +
 *      `SomElement[]`;
 *   4. map the elements to lease-less `RoiPreviewEntity[]` (OQ-8 (b) MVP),
 *      deduped against the most recent discover snapshot (OQ-10) so the preview
 *      highlights only what changed.
 *
 * Degrades to `undefined` on every miss (no hwnd / no window rect / ROI misses
 * the window / OCR threw or rendered no image) so the act envelope is unaffected.
 */
async function buildRoiCapture(
  facade: DesktopFacade,
  viewId: string,
  observation: VisualMotionObservation | undefined,
  dirtyRects: Rect[],
  returnCapture: ReturnCaptureMode | undefined,
  // S5c-1a — ROI provenance label for the assembled capture. `frame_diff` on the
  // visual-only PrintWindow path; `dxgi` on the legacy dirty-rect path.
  source: RoiCapture["source"],
  // S5c-1b — the localized changed-region ROI from the frame-diff (window-
  // relative), present only when the visual-only capture was occlusion-immune.
  // When present it takes precedence over the DXGI dirty-rect bbox and the
  // full-window fallback (P1-2). `undefined` → legacy dirty-rect / full-window.
  frameDiffRoi?: Rect,
): Promise<RoiCapture | undefined> {
  const gatePassed = shouldReturnRoiCapture({
    ok: true, // only called on the success path
    visualOnly: facade.resolveVisualOnlyForViewId(viewId),
    motion: observation?.motion,
    returnCapture,
  });
  if (!gatePassed) return undefined;

  // buildRoiCapture only runs for visual-only targets (the gate above), so the
  // SoM crop must come from the SAME window the frame-diff motion used — resolve
  // the target window by title, not foreground, for consistency with
  // verifyLocalRepaint (Codex PR #431 round 2 P2, same axis as the motion path).
  const hwnd = await facade.resolveTargetHwndForFrameDiff(viewId);
  if (hwnd === null) return undefined;
  const windowRect = getWindowRectByHwnd(hwnd);
  if (windowRect === null || windowRect.width <= 0 || windowRect.height <= 0) {
    return undefined;
  }

  // ROI resolution priority (S5c-1b P1-2):
  //   1. `frameDiffRoi` — the localized changed-region bbox from an occlusion-
  //      immune frame-diff (visual-only PrintWindow path). Already window-
  //      relative; clamped to the window rect below to stay in bounds.
  //   2. DXGI dirty-rect bbox — `filterDirtyRectsToWindow` → bounding box
  //      (legacy dxgi-source path; `dirtyRects` is empty on the frame-diff
  //      path, so this only fires for the dxgi regime).
  //   3. Full window — the gate already passed, so we owe a capture even when
  //      no localized region is available: `returnCapture: "always"` on a
  //      no-change act, or a frame-diff that was not occlusion-immune
  //      (BitBlt-fallback demotion, P1-1), or a no-change/indeterminate motion.
  const windowRel = filterDirtyRectsToWindow(dirtyRects, windowRect);
  const fullWindow = { x: 0, y: 0, width: windowRect.width, height: windowRect.height };
  const roi =
    (frameDiffRoi !== undefined ? clampRectToWindow(frameDiffRoi, windowRect) : undefined) ??
    boundingBox(windowRel) ??
    fullWindow;

  try {
    // S4 — OCR only the ROI crop. hwnd is provided so the empty windowTitle is
    // unused; no UIA dictionary (visual-only target has no UIA candidates).
    const som = await runSomPipeline("", hwnd, "ja", 2, "auto", false, [], roi);
    return assembleRoiCaptureFromSom(som, roi, source, facade, viewId);
  } catch (err) {
    // OCR is best-effort; never break the act envelope on a pipeline failure.
    console.error(
      `[desktop_act] ROI capture OCR failed for viewId=${viewId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * ADR-024 Seed-2 S5b — OCR-free assembly of a {@link RoiCapture} from an
 * already-computed SoM pipeline result. Extracted from {@link buildRoiCapture}
 * so the S5b fold can reuse the SAME assembly on the single ROI-OCR it already
 * ran (instead of a second `runSomPipeline`), keeping the `roiCapture` output
 * byte-equal between the legacy 2-OCR path and the folded 1-OCR path (S5b
 * acceptance ③). Gate-less: the caller is responsible for the visual-only gate.
 */
function assembleRoiCaptureFromSom(
  som: Awaited<ReturnType<typeof runSomPipeline>>,
  roi: Rect,
  source: RoiCapture["source"],
  facade: DesktopFacade,
  viewId: string,
): RoiCapture | undefined {
  if (som.somImage === null) return undefined; // SoM render unavailable

  // OQ-10 — map ROI-OCR elements to the lease-less preview, deduped against
  // the discover snapshot by geometry AND label (so an in-place text change is
  // preserved). Pure logic in `_roi-preview.ts` (`buildRoiPreviewEntities`).
  const entities = buildRoiPreviewEntities(
    som.elements,
    facade.getDiscoverEntitiesForViewId(viewId),
  );

  return { roi, somImage: som.somImage.base64, entities, source };
}

/**
 * ADR-024 Seed-2 S5b — build the visual-only fold's post-snapshot closure.
 * Captured BEFORE the touch (holds the pre-frame + target identity); invoked by
 * `GuardedTouchLoop.touch()` AFTER execute.
 *
 * **Diff baseline = carry-forward (b).** The post snapshot rebuilds the discover
 * full-window entities as candidates with the SAME `target.id`, so they resolve
 * to the SAME entityIds → post == pre → the touched entity keeps its identity and
 * never reads as a false `entity_disappeared`. This is deliberate: ROI-crop OCR
 * is NOT a reliable substitute for full-window OCR — a crop ≈ the text-line
 * height defeats Windows OCR's line segmentation (Opus S5b-2 root-cause), so the
 * diff must not depend on re-OCRing the ROI. The visual change is surfaced via
 * `roiCapture`, not the structural diff.
 *
 * **roiCapture = padded single OCR (a).** The fold's ONE OCR runs on the PADDED
 * change region (`resolveFoldOcrRoi` gives WinRT OCR the line context a tight
 * crop lacks), and only when the gate passes (`returnCapture:"always"` keeps a
 * full-window capture on no_change/miss — Codex P2-1; other modes omit it).
 * `observation` is always surfaced for telemetry.
 */
function buildFoldPostSnapshot(
  facade: DesktopFacade,
  lease: { viewId: string; entityId: string },
  preFrame: RawFrame,
  hwnd: bigint,
  windowRect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number } | null,
  returnCapture: ReturnCaptureMode | undefined,
): () => Promise<{ candidates: UiEntityCandidate[]; roiMaterial?: RoiCaptureMaterial }> {
  const viewId = lease.viewId;
  // The SAME target.id the discover OCR lane used → carry-forward entityId parity (R1).
  const targetId = facade.resolveOcrTargetIdForViewId(viewId);

  return async () => {
    // verifyLocalRepaint never throws — it degrades to `indeterminate` (no
    // roiBbox) on any capture/SSIM failure; the gate then declines roiCapture.
    const obs = await verifyLocalRepaint({
      hwnd,
      hint: { windowRect, ...(point !== null && { point }) },
      preFrame,
      includeRoiBbox: true,
    });
    const { roiBbox, ...observation } = obs;

    // Diff baseline (b): carry forward the discover entities, rebuilt as
    // candidates (same target+label+rect → same entityId on resolve → post==pre).
    const discover = facade.getDiscoverEntitiesForViewId(viewId);
    const candidates =
      targetId !== null
        ? somElementsToCandidates(
            discover.map((e) => ({ text: e.label, region: e.rect })),
            { kind: "window", id: targetId },
            Date.now(),
          )
        : [];

    // roiCapture (a): the fold's SINGLE OCR, on the PADDED change region, only
    // when the gate passes. The diff above never depends on this OCR.
    let roiCapture: RoiCapture | undefined;
    const gatePassed = shouldReturnRoiCapture({
      ok: true,
      visualOnly: true, // fold only runs for visual-only targets (handler gate)
      motion: observation.motion,
      returnCapture,
    });
    if (gatePassed) {
      const ocrRoi = resolveFoldOcrRoi(roiBbox, windowRect);
      try {
        const som = await runSomPipeline("", hwnd, "ja", 2, "auto", false, [], ocrRoi);
        roiCapture = assembleRoiCaptureFromSom(som, ocrRoi, "frame_diff", facade, viewId);
      } catch (err) {
        // roiCapture OCR is best-effort; never break the act on a pipeline failure.
        console.error(
          `[desktop_act] S5b fold roiCapture OCR failed for viewId=${viewId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      candidates,
      roiMaterial: {
        ...(roiCapture !== undefined && { roiCapture }),
        observation,
      },
    };
  };
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
      advisoryRegistry.toolDescriptionAdvisory(),
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
      "[EXPERIMENTAL] On visual-only targets (UIA-blind / RDP / canvas), a successful act may attach a",
      "'roiCapture' { roi, somImage, entities }: a base64 PNG crop of the changed region + a lease-less entity",
      "preview, so you can confirm the result + find the next target in one call (no separate desktop_state /",
      "screenshot). entities are previews (no lease) — re-run desktop_discover to act. Control via returnCapture",
      "('on-change' default / 'always' / 'never'). Never attached on structured targets (browser/CDP, UIA-rich).",
    ].join(" "),
    desktopActRegistrationSchema,
    desktopActRegistrationHandler as (input: unknown) => Promise<ToolResult>,
  );
}
