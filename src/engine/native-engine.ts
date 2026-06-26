/**
 * native-engine.ts
 *
 * Single load point for the monorepo-local napi-rs native addon (compiled from
 * the Rust sources under src/*.rs + src/uia/*.rs into `../../index.js` at the
 * repository root). Exposes both:
 *   - nativeEngine: SSE2 SIMD image diff (computeChangeFraction, dHashFromRaw, hammingDistance)
 *   - nativeUia:    UIA backend for uia-bridge.ts (tree, focus, actions, scroll, vdesktop)
 *
 * Any module that needs the native addon MUST import from here. Do not create
 * parallel dynamic-import loads elsewhere — duplicate loads waste work and
 * would drift if the load logic ever evolves (e.g., fallback ordering).
 */

import type {
  NativeUiElementsResult,
  NativeFocusAndPointResult,
  NativeUiaFocusInfo,
  NativeActionResult,
  NativeElementBounds,
  NativeUiElement,
  NativeScrollResult,
  NativeScrollAncestor,
  NativePreprocessOptions,
  NativeImageProcessingResult,

  NativeSsimRegion,
  NativeSsimResidualResult,
  NativeRecognizeRequest,
  NativeRawCandidate,
  NativeCapabilityProfile,
  NativeSessionInit,
  NativeSessionResult,
  NativeWin32Rect,
  NativeThreadProcessId,
  NativePrintWindowResult,
  NativeMonitorInfo,
  NativeForceFocusResult,
  NativeForegroundFlashOptions,
  NativeForegroundFlashResult,
  NativeConsolePasteResult,
  NativeProcessParentEntry,
  NativeProcessIdentity,
  NativeScrollInfo,
  NativeEventEnvelope,
  NativeCaptureStats,
  NativeFocusedElement,
  NativeViewFocusedPipelineStatus,
  NativeFocusedElementWithWallclock,
  NativeLeaseTokenSummary,
  NativeDirtyRectsResult,
  NativeDirtyRectSubscription,
  NativeExcelAccessVbomStatus,
  NativeWtsSessionInfo,
  NativeWgcCaptureResult,
} from "./native-types.js";

export type * from "./native-types.js";

// ─── Image diff surface (used by image.ts, layer-buffer.ts) ──────────────────
export interface NativeEngine {
  computeChangeFraction(
    prev: Buffer,
    curr: Buffer,
    width: number,
    height: number,
    channels: number,
  ): number;
  dhashFromRaw(
    raw: Buffer,
    width: number,
    height: number,
    channels: number,
  ): bigint;
  hammingDistance(a: bigint, b: bigint): number;

  /**
   * ADR-019 Stage 4 — SSIM residual between two same-size pre/post frames.
   * Wang et al. 2004 reference (L=255, K1=0.01, K2=0.03) over 8×8 sliding
   * window with stride 4. `region` selects an inner sub-rect (whole-frame
   * when omitted). Returns the fraction of windows above the per-window
   * residual threshold, the centroid (omitted when fraction is 0), and the
   * mean SSIM across all windows (exposed via
   * `VisualMotionObservation.residual.meanSsim` per Stage 4 sub-plan §4
   * P15 decision lock default (a)).
   *
   * Optional — present only when the Rust addon was built with the Stage 4
   * `compute_ssim_residual` export. Callers in `src/engine/local-repaint.ts`
   * gate Stage 4 activation on `nativeEngine?.computeSsimResidual` being
   * non-undefined and short-circuit `motion: "indeterminate"` otherwise.
   */
  computeSsimResidual?(
    pre: Buffer,
    post: Buffer,
    width: number,
    height: number,
    channels: number,
    region?: NativeSsimRegion | null,
  ): NativeSsimResidualResult;

  // ── Hybrid Non-CDP pipeline (optional — only present after native rebuild) ──

  /**
   * Preprocess a raw RGB/RGBA buffer for OCR (Step 2):
   * upscale `scale`×, convert to grayscale, apply min-max contrast stretch.
   * Returns a 1-channel grayscale buffer at (`width*scale`) × (`height*scale`).
   */
  preprocessImage?(opts: NativePreprocessOptions): Promise<NativeImageProcessingResult>;

}

// ─── Win32 hot-path surface (ADR-007 P1, used by src/engine/win32.ts) ────────
//
// Sync `#[napi]` exports — the napi-rs surface that replaced the legacy FFI
// bindings across ADR-007 P1–P4. Methods are optional so
// a missing native build (e.g. Linux dev environment) cleanly falls back to
// the `if (!nativeWin32) throw` path inside the TS wrappers.
export interface NativeWin32 {
  // ADR-007 P1 hot-path
  win32EnumTopLevelWindows?(): bigint[];
  win32GetWindowText?(hwnd: bigint): string;
  win32GetWindowRect?(hwnd: bigint): NativeWin32Rect | null;
  win32GetForegroundWindow?(): bigint | null;
  win32IsWindowVisible?(hwnd: bigint): boolean;
  win32IsIconic?(hwnd: bigint): boolean;
  win32IsZoomed?(hwnd: bigint): boolean;
  win32GetClassName?(hwnd: bigint): string;
  /**
   * ADR-018 Phase 5+N: resolve a top-level HWND to the descendant HWND that
   * actually receives WM_MOUSEWHEEL for MDI / OLE apps (Excel:
   * XLMAIN → XLDESK → EXCEL7; Word: OpusApp → _WwF → _WwG). Returns `null`
   * when the top-level class is not in the chain table OR when any chain
   * segment fails — caller treats `null` as "no retarget; use input HWND".
   */
  win32FindScrollLeafForTopLevel?(top: bigint): bigint | null;
  win32GetWindowThreadProcessId?(hwnd: bigint): NativeThreadProcessId;
  win32GetWindowLongPtrW?(hwnd: bigint, nIndex: number): number;

  // ADR-007 P2 GDI / monitor / DPI
  win32PrintWindowToBuffer?(hwnd: bigint, flags: number): NativePrintWindowResult;
  captureWindowWgc?(hwnd: bigint): NativeWgcCaptureResult;
  win32EnumMonitors?(): NativeMonitorInfo[];
  win32GetWindowDpi?(hwnd: bigint): number;
  win32SetProcessDpiAwareness?(level: number): boolean;

  // ADR-007 P3 process / input / window-state ops
  win32ShowWindow?(hwnd: bigint, nCmdShow: number): boolean;
  win32SetForegroundWindow?(hwnd: bigint): boolean;
  win32SetWindowTopmost?(hwnd: bigint): boolean;
  win32ClearWindowTopmost?(hwnd: bigint): boolean;
  win32SetWindowBounds?(hwnd: bigint, x: number, y: number, cx: number, cy: number): boolean;
  win32ForceSetForegroundWindow?(hwnd: bigint): NativeForceFocusResult;
  win32GetFocusedChildHwnd?(targetHwnd: bigint): bigint | null;
  win32BuildProcessParentMap?(): NativeProcessParentEntry[];
  win32GetProcessIdentity?(pid: number): NativeProcessIdentity;
  win32GetScrollInfo?(hwnd: bigint, axis: string): NativeScrollInfo | null;
  win32PostMessage?(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): boolean;
  win32GetFocus?(): bigint | null;
  win32VkToScanCode?(vk: number): number;

  // ADR-007 P4 owner / ancestor / enabled / popup / DWM utilities
  win32GetWindow?(hwnd: bigint, uCmd: number): bigint | null;
  win32GetAncestor?(hwnd: bigint, gaFlags: number): bigint | null;
  win32IsWindowEnabled?(hwnd: bigint): boolean;
  win32GetLastActivePopup?(hwnd: bigint): bigint | null;
  win32IsWindowCloaked?(hwnd: bigint): boolean;

  // ADR-013 Option E (`foreground_flash` channel)。`background` 契約とは
  // 分離した妥協 BG path (Clipboard + foreground flash + paste + restore)。
  // `method: 'foreground_flash'` 明示 opt-in でのみ TS engine 側から到達。
  // Failure は `Error` を throw、message に typed reason (snake_case)。
  win32ForegroundFlashInject?(
    targetHwnd: bigint,
    targetPid: number,
    text: string,
    options: NativeForegroundFlashOptions,
  ): NativeForegroundFlashResult;

  // issue #386 — native no-steal console-paste for the conhost exit-mode path.
  // Sync; runs the whole save → set → console-Paste → Enter → restore clipboard
  // transaction natively (reuses clipboard_snapshot). Never throws on a Win32
  // failure — reports it via `ok=false` + `reason`. Optional so an older `.node`
  // build (pre-#386) cleanly falls back (TS wrapper surfaces native_engine_unavailable).
  win32ConsolePasteNoFocus?(hwnd: bigint, text: string): NativeConsolePasteResult;

  // Issue #245 系統②: IME open-status query / control via Imm32.dll +
  // WM_IME_CONTROL. Returns `false` when the target HWND has no associated
  // IME (e.g. ASCII layout) — both read and write surface the same "no IME"
  // signal so callers can branch safely. Used by `desktop_state.hints.imeOpen`
  // and `keyboard(action='type', forceImeOff:true)`.
  win32GetImeOpenStatus?(hwnd: bigint): boolean;
  win32SetImeOpenStatus?(hwnd: bigint, open: boolean): boolean;

  // ADR-017: read-only Terminal Services session observability.
  //
  // Used by `desktop_state` `include:['sessionContext']` opt-in to compute
  // `sessionLabel` (`'console'|'rdp'|'other'`) + `sessionState`
  // (`'active'|'connected'|'disconnected'|'locked'|'unknown'`) without any
  // cross-session control surface. All three bindings are sync, panic-safe
  // via `napi_safe_call`, and follow the existing "missing-method falls back
  // to safe default" optional-method convention so older `.node` binaries
  // (e.g. a dev environment that hasn't rebuilt after the ADR-017 binding
  // landed) degrade cleanly to `sessionContext.sessionLabel: 'other'` /
  // `sessionState: 'unknown'` rather than throwing.
  win32GetProcessSessionId?(pid: number): number | null;
  win32GetActiveConsoleSessionId?(): number;
  wtsEnumerateSessions?(): NativeWtsSessionInfo[];
}

// ─── UIA surface (used by uia-bridge.ts) ─────────────────────────────────────
// Individual methods are optional to allow partial Rust implementations to
// still let the TS/PowerShell fallbacks cover the rest.
export interface NativeUia {
  // Phase A+B: Tree / Focus
  uiaGetElements?(opts: {
    windowTitle: string;
    maxDepth?: number;
    maxElements?: number;
    fetchValues?: boolean;
  }): Promise<NativeUiElementsResult>;
  uiaGetFocusedAndPoint?(opts: {
    cursorX: number;
    cursorY: number;
  }): Promise<NativeFocusAndPointResult>;
  uiaGetFocusedElement?(): Promise<NativeUiaFocusInfo | null>;

  // Phase C: Actions
  uiaClickElement?(opts: {
    windowTitle: string;
    name?: string;
    automationId?: string;
    controlType?: string;
  }): Promise<NativeActionResult>;
  uiaSetValue?(opts: {
    windowTitle: string;
    value: string;
    name?: string;
    automationId?: string;
  }): Promise<NativeActionResult>;
  uiaInsertText?(opts: {
    windowTitle: string;
    value: string;
    name?: string;
    automationId?: string;
  }): Promise<NativeActionResult>;
  uiaGetElementBounds?(opts: {
    windowTitle: string;
    name?: string;
    automationId?: string;
    controlType?: string;
  }): Promise<NativeElementBounds | null>;
  uiaGetElementChildren?(opts: {
    windowTitle: string;
    name?: string;
    automationId?: string;
    controlType?: string;
    maxDepth: number;
    maxElements: number;
    timeoutMs: number;
  }): Promise<NativeUiElement[]>;
  uiaGetTextViaTextPattern?(opts: {
    windowTitle: string;
    timeoutMs: number;
  }): Promise<string | null>;

  // Phase D: Scroll / VDesktop
  uiaScrollIntoView?(opts: {
    windowTitle: string;
    name?: string;
    automationId?: string;
  }): Promise<NativeScrollResult>;
  uiaGetScrollAncestors?(opts: {
    windowTitle: string;
    elementName: string;
  }): Promise<NativeScrollAncestor[]>;
  uiaScrollByPercent?(opts: {
    windowTitle: string;
    elementName: string;
    verticalPercent: number;
    horizontalPercent: number;
  }): Promise<NativeScrollResult>;
  /**
   * ADR-018 Phase 1b — Tier 1 destination-explicit wheel dispatch. Resolves
   * the UIA element from `hwnd` and calls `SetScrollPercent` on the first
   * ScrollPattern ancestor. `wheelDeltaY` / `wheelDeltaX` use Win32
   * `WHEEL_DELTA = 120` units per notch (down/right positive).
   */
  uiaScrollByWheelAtHwnd?(opts: {
    hwnd: string;
    wheelDeltaY: number;
    wheelDeltaX: number;
  }): Promise<NativeScrollResult>;
  /**
   * ADR-019 MVP-1 (Stage 1) — read-only `ScrollPercent` observation. Walks
   * UIA ancestors then DFS subtree to find a ScrollPattern whose requested
   * axis is scrollable, returns `CurrentVertical/HorizontalScrollPercent`
   * (0.0..=100.0). Returns `null` when no pattern is exposed (custom-paint
   * receivers like Excel `NUIScrollbar`, Word MFC). Pure observation;
   * never writes.
   */
  uiaReadScrollPercentAtHwnd?(opts: {
    hwnd: string;
    axis: "vertical" | "horizontal";
  }): Promise<number | null>;
  uiaGetVirtualDesktopStatus?(
    hwndIntegers: string[],
  ): Promise<Record<string, boolean>>;
}

// ─── Visual GPU surface (ADR-005 Phase 4a/4b-1) ──────────────────────────────
//
// `visionRecognizeRois` is the AsyncTask exported from src/lib.rs.
// `detectCapability` is exported from src/vision_backend/capability.rs.
// `visionInitSession` is the Phase 4b-1 EP cascade session init (AsyncTask).
// All methods are optional so a build without the `vision-gpu` cargo feature
// (or a missing native addon) cleanly falls back to PocVisualBackend.
export interface NativeVision {
  visionRecognizeRois?(req: NativeRecognizeRequest): Promise<NativeRawCandidate[]>;
  detectCapability?(): NativeCapabilityProfile;
  /**
   * Phase 4b-1: initialise an ORT session using the EP cascade determined
   * by `init.profile`. The Promise **never rejects** — errors are surfaced
   * via `result.ok === false`.
   */
  visionInitSession?(init: NativeSessionInit): Promise<NativeSessionResult>;
}

// ─── Load once (top-level await; index.js throws if .node binary is missing) ─
let nativeBinding: Record<string, unknown> | null = null;
try {
  const addon = await import("../../index.js");
  // Use the raw napi-rs binding (default export) so debug-only exports like
  // l1TestForcePanic are accessible via NativeL1 without appearing on the
  // public index.d.ts surface. Named re-exports in index.js are identical
  // references, so all other checks remain unaffected.
  nativeBinding = (addon as unknown as { default: Record<string, unknown> }).default;
} catch {
  // Native addon not built or platform unsupported — callers fall back to TS/PowerShell.
}

export const nativeEngine: NativeEngine | null =
  nativeBinding &&
  typeof nativeBinding.computeChangeFraction === "function" &&
  typeof nativeBinding.dhashFromRaw === "function" &&
  typeof nativeBinding.hammingDistance === "function"
    ? (nativeBinding as unknown as NativeEngine)
    : null;

export const nativeUia: NativeUia | null =
  nativeBinding && typeof nativeBinding.uiaGetElements === "function"
    ? (nativeBinding as unknown as NativeUia)
    : null;

// Treat the binding as "vision available" when EITHER end of the surface is
// callable. `detectCapability` is exported even when `vision-gpu` cargo
// feature is OFF (returns `{ backendBuilt: false }`); `visionRecognizeRois`
// is exported only when the feature is ON. Either function being present
// means the addon is loaded and the TS layer can probe for capability.
export const nativeVision: NativeVision | null =
  nativeBinding &&
  (typeof nativeBinding.visionRecognizeRois === "function"
    || typeof nativeBinding.detectCapability === "function")
    ? (nativeBinding as unknown as NativeVision)
    : null;

// `nativeWin32` is non-null whenever the addon exposes the new ADR-007 P1
// surface. When this is null (e.g. running an older `.node` build without
// the win32 module), the TS wrappers in `src/engine/win32.ts` throw a
// loud "addon out of date" Error rather than carrying a legacy fallback —
// since ADR-007 P4 there is nothing to fall back to.
export const nativeWin32: NativeWin32 | null =
  nativeBinding && typeof nativeBinding.win32EnumTopLevelWindows === "function"
    ? (nativeBinding as unknown as NativeWin32)
    : null;

// ─── L1 capture surface (ADR-007 P5a) ────────────────────────────────────────
//
// Ring buffer + typed push helpers + polling API. Probe key is `l1PushFailure`
// since it's the most general of the 4 typed helpers and will remain across P5b+.
// All methods are optional so a pre-P5a addon build cleanly falls back to null.
export interface NativeL1 {
  l1PushToolCallStarted?(
    tool: string,
    argsJson: string,
    sessionId?: string,
    toolCallId?: string,
    /** Lease 4-tuple summary (ADR-010 P1 S4 sub-plan §2.3, tail-only
     * Optional 5th parameter so existing 4-arg positional callers stay
     * compatible — Round 1 P1-1). `undefined` for query-axis tools,
     * lease-less commits, and pre-S4 callers. */
    leaseToken?: NativeLeaseTokenSummary,
  ): bigint;
  l1PushToolCallCompleted?(
    tool: string,
    elapsedMs: number,
    ok: boolean,
    errorCode?: string,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PushHwInputPostMessage?(
    targetHwnd: bigint,
    msg: number,
    wParam: bigint,
    lParam: bigint,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PushFailure?(
    layer: string,
    op: string,
    reason: string,
    panicPayload?: string,
    sessionId?: string,
    toolCallId?: string,
  ): bigint;
  l1PollEvents?(sinceEventId: bigint, maxCount: number): NativeEventEnvelope[];
  l1GetCaptureStats?(): NativeCaptureStats;
  l1ShutdownForTest?(): void;
  l1TestForcePanic?(): void;
}

export const nativeL1: NativeL1 | null =
  nativeBinding && typeof nativeBinding.l1PushFailure === "function"
    ? (nativeBinding as unknown as NativeL1)
    : null;

// ─── L3 perception view surface (ADR-008 D2-B-1) ─────────────────────────────
// Single load point for the `latest_focus` view's read API. `desktop_state.ts`
// (D2-B-2, next PR) reads `viewGetFocused` first and falls back to UIA when
// the result is `null` (no live row, uninitialised, or poisoned slot).

export interface NativeViewFocus {
  viewGetFocused?(): NativeFocusedElement | null;
  viewFocusedPipelineStatus?(): NativeViewFocusedPipelineStatus;
  /** S3 D2-E0 P1 (ADR-010 PR #110): combined getter returning focused + L1
   * event wallclock + view-poisoned signal. Used by `_envelope.ts::makeEnvelopeAware`
   * to build `as_of.wallclock_ms` from L1 event time (PR #110 Round 1 P1-4 反映). */
  viewGetFocusedWithWallclock?(): NativeFocusedElementWithWallclock;
  /** S2 D2-C: dirty_rects_aggregate per-monitor count. Used by S5
   * `caused_by` projector (`desktop-state.ts`) to build `produced_changes`
   * dirty_rect entries with `monitor_index` field maintained
   * (CLAUDE.md §3.2 PR #102 同型 regression 防止). */
  viewGetDirtyRects?(monitorIndex: number): NativeDirtyRectsResult;
}

// PR #112 Round 1 P1-2 (Opus review): probe the **newest** function
// (`viewGetFocusedWithWallclock` from S3-2) as the discriminator. Probing
// the older `viewGetFocused` would let an old `.node` binary (PR #96
// release-shipped, pre-S3-2) pass this check while
// `viewGetFocusedWithWallclock` is undefined — silently degrading every
// envelope to `confidence: "degraded"` because `desktopStateRegistrationHandler`'s
// `fetchMeta` always returns `(false, null)` in that mismatched state.
// Probing the newer function ensures the slot is set to non-null only
// when the binary actually exposes both APIs.
export const nativeViewFocus: NativeViewFocus | null =
  nativeBinding && typeof nativeBinding.viewGetFocusedWithWallclock === "function"
    ? (nativeBinding as unknown as NativeViewFocus)
    : null;

// ─── VBA Extensibility bridge (ADR-015 Phase 3) ──────────────────────────────
//
// napi-rs binding around `engine-vba-bridge`. Session-handle based (integer
// IDs). Phase 4 wraps these into the single `excel` MCP tool surface.
//
// Methods are optional so a pre-Phase-3 addon build cleanly falls back to
// null; the Phase 4 TS wrapper throws `VbaBridgeUnavailable` rather than
// silently proceeding when the addon doesn't expose this surface.
export interface NativeExcel {
  // Session lifecycle
  excelSessionSpawn?(): number;
  excelSessionClose?(sessionId: number): void;
  excelSessionIsAlive?(sessionId: number): boolean;

  // Application property setters
  excelSetVisible?(sessionId: number, visible: boolean): void;
  excelSetDisplayAlerts?(sessionId: number, enabled: boolean): void;

  // Workbook lifecycle
  excelWorkbookAddNew?(sessionId: number): void;
  excelWorkbookSaveAs?(
    sessionId: number,
    path: string,
    fileFormat: number,
  ): void;
  excelWorkbookClose?(sessionId: number, saveChanges: boolean): void;

  // VBA authoring + execution
  excelVbaModuleAdd?(
    sessionId: number,
    moduleName: string,
    code: string,
  ): void;
  excelMacroRun?(sessionId: number, macroName: string): void;

  // Registry inspection (read-only)
  excelCheckAccessVbom?(): NativeExcelAccessVbomStatus;
}

// Probe key: `excelSessionSpawn` is the entry point for any Excel work —
// if the addon exposes it, the rest of the surface is also expected to
// be present (they all live in the same Rust module `vba_bridge.rs`).
export const nativeExcel: NativeExcel | null =
  nativeBinding && typeof nativeBinding.excelSessionSpawn === "function"
    ? (nativeBinding as unknown as NativeExcel)
    : null;

// ─── Desktop Duplication / DirtyRectSubscription (ADR-019 Stage 5) ───────────
//
// PR #102 (ADR-007 P5c-2) shipped the `DirtyRectSubscription` napi class.
// Stage 5 sub-plan §3 P4 formalises it as a typed SSOT entry. The class is
// reached via `nativeDuplication.DirtyRectSubscription` (constructor reference),
// matching the existing surface convention. `src/engine/any-change.ts`
// consumes this; the untyped escape hatch in
// `src/engine/vision-gpu/dirty-rect-source.ts` may migrate in a follow-up
// cleanup (Stage 5b carry-over).

export interface NativeDuplication {
  /** Constructor reference for `DirtyRectSubscription`. `outputIndex` defaults
   *  to 0 (primary monitor) when omitted. Throws (E_DUP_INIT / E_DUP_UNSUPPORTED)
   *  on init failure — callers must catch and degrade. */
  DirtyRectSubscription?: new (outputIndex?: number) => NativeDirtyRectSubscription;
}

export const nativeDuplication: NativeDuplication | null =
  nativeBinding && typeof nativeBinding.DirtyRectSubscription === "function"
    ? (nativeBinding as unknown as NativeDuplication)
    : null;

if (nativeEngine) {
  console.error("[native-engine] Rust image-diff engine loaded (SSE2 SIMD)");
}
if (nativeUia) {
  console.error("[native-engine] Rust UIA engine loaded");
}
if (nativeVision) {
  console.error("[native-engine] Rust vision-gpu backend loaded (ADR-005)");
}
if (nativeWin32) {
  console.error("[native-engine] Rust win32 hot-path bindings loaded (ADR-007 P1)");
}
if (nativeL1) {
  console.error("[native-engine] Rust L1 capture loaded (ADR-007 P5a)");
}
if (nativeExcel) {
  console.error("[native-engine] Rust VBA bridge loaded (ADR-015 Phase 3)");
}
