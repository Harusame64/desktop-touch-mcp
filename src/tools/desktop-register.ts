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
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput } from "./desktop.js";
import type { EntityLease, UiEntity } from "../engine/world-graph/types.js";
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
import { enumWindowsInZOrder } from "../engine/win32.js";
import { computeViewportPosition } from "../utils/viewport-position.js";

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
      ingress,
      // G1-B: viewport guard — blocks visual-only entities outside the foreground window.
      isInViewport: productionIsInViewport,
      // G1-C: window-level focus fingerprint for focus_shifted diff.
      getFocusedEntityId: productionGetFocusedEntityId,
      // G1-A: modal guard — session-aware default in session-registry.ts (UIA unknown-role).
      // No override needed here; the session-registry default is already production-grade.
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
            console.debug(`[desktop-register] DirtyRectRouter fallback: ${reason}`);
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

const desktopSeeSchema = {
  target:      targetSchema.describe("Target window (windowTitle / hwnd) or browser tab (tabId). Omit for foreground window."),
  view:        z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query:       z.string().optional().describe("Filter entities by label substring (case-insensitive)"),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug:       z.boolean().optional().describe("Include raw screen coordinates in response (debug only — never relay to end-users)"),
};

const desktopTouchSchema = {
  lease:  leaseSchema.describe("Lease returned by desktop_discover. Expires after TTL; re-call desktop_discover if desktop_act fails with lease_expired."),
  action: z.enum(["auto", "invoke", "click", "type", "setValue", "select"]).optional().describe(
    "Action to perform. 'auto' selects the best affordance from the entity. " +
    "'setValue' (Phase 4: absorbs former set_element_value) sets a UIA ValuePattern value or fills a CDP controlled input — pass the new value via text."
  ),
  text:   z.string().optional().describe("Text to type or set (required when action='type' or action='setValue')."),
};

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register desktop_discover and desktop_act on the MCP server.
 * Called by default on v0.17+; suppressed only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1.
 * See docs/anti-fukuwarai-v2-activation-policy.md.
 */
export function registerDesktopTools(server: McpServer): void {
  const facade = getDesktopFacade();

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
      "uia_blind_visual_empty → use screenshot(ocrFallback=always) or V1 get_ui_elements;",
      "cdp_failed_visual_empty → check --remote-debugging-port=9222 and retry;",
      "all_providers_failed → use V1 tools (get_ui_elements / terminal(action='read') / screenshot);",
      "constraints.uia=blind_single_pane → PWA/Electron/canvas; try view=debug or screenshot(ocrFallback=always);",
      "constraints.cdp=provider_failed → check --remote-debugging-port=9222;",
      "constraints.terminal=provider_failed → use V1 terminal(action='read'/'send');",
      "Recovery: no_provider_matched → add target.windowTitle or retry; partial_results_only → compare with V1 get_ui_elements;",
      "cdp_provider_failed → check --remote-debugging-port=9222;",
      "visual_provider_unavailable / visual_provider_warming → server retried once (~200ms); if still warned, continue with structured lane or retry later;",
      "uia/terminal_provider_failed → use V1 tools (get_ui_elements / terminal(action='read'));",
      "uia_blind_single_pane / uia_blind_too_few_elements → target is PWA/Electron/canvas; try view=debug for visual lane hints, or fall back to screenshot(ocrFallback=always);",
      "visual_not_attempted → GPU backend unavailable; use V1 screenshot+mouse_click or wait and retry;",
      "visual_attempted_empty → visual lane ran but produced no stable candidates; consider screenshot(ocrFallback=always) or V1 tools;",
      "visual_attempted_empty_cdp_fallback → CDP failed and visual also empty (browser); check --remote-debugging-port=9222 and retry;",
      "dialog_resolved_via_owner_chain → common dialog (Save As/Open) found via owner chain; targeting is now hwnd-based;",
      "parent_disabled_prefer_popup → parent window blocked by a modal; switched to targeting the active popup dialog.",
    ].join(" "),
    desktopSeeSchema,
    async (input) => {
      const output = await facade.see(input as DesktopSeeInput);
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }
  );

  server.tool(
    "desktop_act",
    [
      "[EXPERIMENTAL] Act on a discovered entity (click/type/setValue/scroll). Use desktop_act.",
      "Validates the lease before executing — rejects stale, expired, or mismatched leases.",
      "Returns a semantic diff (entity_disappeared, modal_appeared, etc.) and a 'next' hint.",
      "If ok=false, read 'reason':",
      "  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_discover;",
      "  modal_blocking → dismiss modal via V1 click_element then retry;",
      "  entity_outside_viewport → scroll via V1 scroll(action='raw'/'to_element') then retry;",
      "  executor_failed → fall back to V1 tools (click_element / mouse_click / browser_click);",
      "  executor_failed on terminal textbox (action=type) → use V1 terminal(action='send') instead.",
      "Check desktop_discover response.constraints for pre-emptive fallback hints before calling desktop_act.",
    ].join(" "),
    desktopTouchSchema,
    async (input) => {
      const result = await facade.touch({
        lease: input.lease as EntityLease,
        action: input.action,
        text: input.text,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
