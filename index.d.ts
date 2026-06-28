/* eslint-disable */
/* Hand-maintained type declarations for the napi-rs native addon.
 * `npm run build:rs` discards napi's regenerated output and restores this file via git restore.
 * Source of truth for Native* types: src/engine/native-types.ts — keep them in sync. */

// ─── Shared geometry ─────────────────────────────────────────────────────────

export interface NativeBoundingRect {
  x: number
  y: number
  width: number
  height: number
}

// ─── UIA Element tree ────────────────────────────────────────────────────────

export interface NativeUiElement {
  name: string
  controlType: string
  automationId: string
  className?: string
  isEnabled: boolean
  boundingRect?: NativeBoundingRect | null
  patterns: Array<string>
  depth: number
  value?: string
}

export interface NativeUiElementsResult {
  windowTitle: string
  windowClassName?: string | null
  windowRect?: NativeBoundingRect | null
  elementCount: number
  elements: Array<NativeUiElement>
}

// ─── Scroll ──────────────────────────────────────────────────────────────────

export interface NativeScrollResult {
  ok: boolean
  scrolled: boolean
  error?: string | null
}

export interface NativeScrollAncestor {
  name: string
  automationId: string
  controlType: string
  verticalPercent: number
  horizontalPercent: number
  verticallyScrollable: boolean
  horizontallyScrollable: boolean
}

// ─── Focus / point ───────────────────────────────────────────────────────────

export interface NativeUiaFocusInfo {
  name: string
  controlType: string
  automationId?: string
  value?: string
}

export interface NativeFocusAndPointResult {
  focused?: NativeUiaFocusInfo | null
  atPoint?: NativeUiaFocusInfo | null
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface NativeActionResult {
  ok: boolean
  element?: string | null
  error?: string | null
  code?: string | null
}

// ─── Element bounds ──────────────────────────────────────────────────────────

export interface NativeElementBounds {
  name: string
  controlType: string
  automationId: string
  boundingRect?: NativeBoundingRect | null
  value?: string | null
}

// ─── Win32 hot-path bindings (ADR-007 P1) ────────────────────────────────────

export interface NativeWin32Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface NativeThreadProcessId {
  threadId: number
  processId: number
}

// ─── Win32 GDI / monitor / DPI (ADR-007 P2) ──────────────────────────────────

export interface NativePrintWindowResult {
  data: Buffer
  width: number
  height: number
}

export interface NativeWgcResult {
  data: Buffer
  width: number
  height: number
}

export interface NativeWgcCaptureOptions {
  includeCursor?: boolean
  removeBorder?: boolean
  timeoutMs?: number
}

export interface NativeMonitorInfo {
  handle: bigint
  primary: boolean
  boundsLeft: number
  boundsTop: number
  boundsRight: number
  boundsBottom: number
  workLeft: number
  workTop: number
  workRight: number
  workBottom: number
  dpi: number
}

// ─── Win32 process / input (ADR-007 P3) ──────────────────────────────────────

export interface NativeForceFocusResult {
  ok: boolean
  attached: boolean
  fgBefore: bigint
  fgAfter: bigint
}

// ─── ADR-013 Option E (`foreground_flash` channel、Phase 1c-1f) ──────────────

export interface NativeForegroundFlashOptions {
  maxFocusWaitMs?: number
  foregroundRestoreRetries?: number
  blockKeyboardDuringFlash?: boolean
  scanPasteWarningDialog?: boolean
  pressEnter?: boolean
}

export interface NativeForegroundFlashSkippedFormat {
  formatId: number
  reason: string
}

export interface NativeForegroundFlashResult {
  flashDurationMs: number
  foregroundStealMethod: string
  foregroundRestored: boolean
  foregroundRestoreRetriesUsed: number
  foregroundRestoreMethod: string
  clipboardRestored: boolean
  clipboardSkippedFormats: Array<NativeForegroundFlashSkippedFormat>
  pasteWarningDetected: boolean
}

// issue #386 — native no-steal console-paste (conhost exit-mode path).
export interface NativeConsolePasteSkippedFormat {
  formatId: number
  reason: string
}

export interface NativeConsolePasteResult {
  ok: boolean
  reason?: string
  skippedFormats: Array<NativeConsolePasteSkippedFormat>
  restoreSkippedRace: boolean
}

export interface NativeProcessParentEntry {
  pid: number
  parentPid: number
}

export interface NativeProcessIdentity {
  pid: number
  processName: string
  processStartTimeMs: number
}

export interface NativeScrollInfo {
  nMin: number
  nMax: number
  nPage: number
  nPos: number
  pageRatio: number
}

// ─── Image processing (Hybrid Non-CDP pipeline) ──────────────────────────────

export interface NativePreprocessOptions {
  data: Buffer
  width: number
  height: number
  channels: number
  scale: number
}

export interface NativeImageProcessingResult {
  data: Buffer
  width: number
  height: number
  channels: number
}

export interface NativeSomLabel {
  id: number
  x: number
  y: number
  width: number
  height: number
}

export interface NativeDrawSomLabelsOptions {
  data: Buffer
  width: number
  height: number
  channels: number
  labels: Array<NativeSomLabel>
}

export interface NativeDrawSomLabelsResult {
  data: Buffer
  width: number
  height: number
  channels: number
}

// ─── Exported functions ──────────────────────────────────────────────────────

export declare function computeChangeFraction(prev: Buffer, curr: Buffer, width: number, height: number, channels: number): number
export declare function dhashFromRaw(raw: Buffer, width: number, height: number, channels: number): bigint
export declare function hammingDistance(a: bigint, b: bigint): number

// ─── SSIM residual (ADR-019 Stage 4) ─────────────────────────────────────────

export interface NativeSsimRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeSsimCentroid {
  x: number
  y: number
}

/** ADR-024 Seed-2 S5c-1b — bbox of above-threshold windows (same basis as
 *  centroid; crop-local when called with region=null). Omitted (NOT null)
 *  when no window crossed the threshold. */
export interface NativeSsimBbox {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeSsimResidualResult {
  fractionChanged: number
  /** Omitted (NOT null) when `fractionChanged === 0`. Use `result.centroid != null`
   *  to handle both napi-rs omission and a hypothetical future explicit null. */
  centroid?: NativeSsimCentroid
  /** ADR-024 Seed-2 S5c-1b — bbox of above-threshold windows. Omitted (NOT
   *  null) when no window crossed the threshold / graceful-degrade paths.
   *  Use `result.bbox != null`. */
  bbox?: NativeSsimBbox
  /** Mean SSIM across all windows; exposed via
   *  `VisualMotionObservation.residual.meanSsim` (Stage 4 sub-plan §4 P15). */
  meanSsim: number
}

/**
 * ADR-019 Stage 4 — SSIM residual between two same-size pre/post frames.
 * Wang et al. 2004 reference (L=255, K1=0.01, K2=0.03) on the BT.601
 * luminance channel, 8×8 sliding window with stride 4. The per-window
 * residual threshold (default 0.05) drives `fractionChanged`; the
 * centroid is omitted when no windows cross threshold. `region` selects
 * a sub-rect (whole-frame when `null` / `undefined`). Throws on size
 * mismatch / channels ∉ {3,4} / region outside frame.
 */
export declare function computeSsimResidual(
  pre: Buffer,
  post: Buffer,
  width: number,
  height: number,
  channels: number,
  region?: NativeSsimRegion | null,
): NativeSsimResidualResult

export declare function uiaGetElements(opts: { windowTitle: string; maxDepth?: number; maxElements?: number; fetchValues?: boolean }): Promise<NativeUiElementsResult>
export declare function uiaGetFocusedAndPoint(opts: { cursorX: number; cursorY: number }): Promise<NativeFocusAndPointResult>
export declare function uiaGetFocusedElement(): Promise<NativeUiaFocusInfo | null>

export declare function uiaClickElement(opts: { windowTitle: string; name?: string; automationId?: string; controlType?: string }): Promise<NativeActionResult>
export declare function uiaSetValue(opts: { windowTitle: string; value: string; name?: string; automationId?: string }): Promise<NativeActionResult>
export declare function uiaInsertText(opts: { windowTitle: string; value: string; name?: string; automationId?: string }): Promise<NativeActionResult>
export declare function uiaGetElementBounds(opts: { windowTitle: string; name?: string; automationId?: string; controlType?: string }): Promise<NativeElementBounds | null>
export declare function uiaGetElementChildren(opts: { windowTitle: string; name?: string; automationId?: string; controlType?: string; maxDepth: number; maxElements: number; timeoutMs: number }): Promise<Array<NativeUiElement>>
export declare function uiaGetTextViaTextPattern(opts: { windowTitle: string; timeoutMs: number }): Promise<string | null>

export declare function uiaScrollIntoView(opts: { windowTitle: string; name?: string; automationId?: string }): Promise<NativeScrollResult>
export declare function uiaGetScrollAncestors(opts: { windowTitle: string; elementName: string }): Promise<Array<NativeScrollAncestor>>
export declare function uiaScrollByPercent(opts: { windowTitle: string; elementName: string; verticalPercent: number; horizontalPercent: number }): Promise<NativeScrollResult>
export declare function uiaScrollByWheelAtHwnd(opts: { hwnd: string; wheelDeltaY: number; wheelDeltaX: number }): Promise<NativeScrollResult>
/**
 * ADR-019 MVP-1 (Stage 1) — read-only ScrollPercent companion to
 * `uiaScrollByWheelAtHwnd`. Returns the percent (0.0..=100.0) on the requested
 * axis when a ScrollPattern ancestor / descendant exposes it; `null` when no
 * pattern is exposed (custom-paint receivers like Excel `NUIScrollbar`, Word
 * MFC document body). Pure observation; no SetScrollPercent side effect.
 */
export declare function uiaReadScrollPercentAtHwnd(opts: { hwnd: string; axis: "vertical" | "horizontal" }): Promise<number | null>
export declare function uiaGetVirtualDesktopStatus(hwndIntegers: Array<string>): Promise<Record<string, boolean>>

export declare function preprocessImage(opts: NativePreprocessOptions): Promise<NativeImageProcessingResult>
export declare function drawSomLabels(opts: NativeDrawSomLabelsOptions): Promise<NativeDrawSomLabelsResult>

// ─── Win32 hot-path APIs (ADR-007 P1, sync, panic-safe via napi_safe_call) ───
export declare function win32EnumTopLevelWindows(): bigint[]
export declare function win32GetWindowText(hwnd: bigint): string
export declare function win32GetWindowRect(hwnd: bigint): NativeWin32Rect | null
export declare function win32GetForegroundWindow(): bigint | null
export declare function win32IsWindowVisible(hwnd: bigint): boolean
export declare function win32IsIconic(hwnd: bigint): boolean
export declare function win32IsZoomed(hwnd: bigint): boolean
export declare function win32GetClassName(hwnd: bigint): string
/**
 * ADR-018 Phase 5+N: resolve a top-level HWND to the descendant HWND that
 * actually receives WM_MOUSEWHEEL for MDI / OLE apps (Excel: XLMAIN →
 * XLDESK → EXCEL7; Word: OpusApp → _WwF → _WwG). Returns null when the
 * top-level class is not in the chain table OR when any chain segment
 * fails — caller falls back to top-level POST in either case.
 */
export declare function win32FindScrollLeafForTopLevel(top: bigint): bigint | null
export declare function win32GetWindowThreadProcessId(hwnd: bigint): NativeThreadProcessId
export declare function win32GetWindowLongPtrW(hwnd: bigint, nIndex: number): number

// ─── Win32 GDI / monitor / DPI (ADR-007 P2) ──────────────────────────────────
export declare function win32PrintWindowToBuffer(hwnd: bigint, flags: number): NativePrintWindowResult
// ─── ADR-027: Windows.Graphics.Capture (WGC) ─────────────────────────────────
export declare function win32WgcCaptureWindow(hwnd: bigint, opts?: NativeWgcCaptureOptions): Promise<NativeWgcResult>
export declare function win32EnumMonitors(): NativeMonitorInfo[]
export declare function win32GetWindowDpi(hwnd: bigint): number
export declare function win32SetProcessDpiAwareness(level: number): boolean

// ─── Win32 process / input (ADR-007 P3) ──────────────────────────────────────
export declare function win32ShowWindow(hwnd: bigint, nCmdShow: number): boolean
export declare function win32SetForegroundWindow(hwnd: bigint): boolean
export declare function win32SetWindowTopmost(hwnd: bigint): boolean
export declare function win32ClearWindowTopmost(hwnd: bigint): boolean
export declare function win32SetWindowBounds(hwnd: bigint, x: number, y: number, cx: number, cy: number): boolean
export declare function win32ForceSetForegroundWindow(hwnd: bigint): NativeForceFocusResult
export declare function win32ForegroundFlashInject(targetHwnd: bigint, targetPid: number, text: string, options: NativeForegroundFlashOptions): NativeForegroundFlashResult
export declare function win32GetFocusedChildHwnd(targetHwnd: bigint): bigint | null
export declare function win32BuildProcessParentMap(): NativeProcessParentEntry[]
export declare function win32GetProcessIdentity(pid: number): NativeProcessIdentity
export declare function win32GetScrollInfo(hwnd: bigint, axis: string): NativeScrollInfo | null
export declare function win32PostMessage(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): boolean
export declare function win32ConsolePasteNoFocus(hwnd: bigint, text: string): NativeConsolePasteResult
export declare function win32GetFocus(): bigint | null
export declare function win32VkToScanCode(vk: number): number

// ─── Win32 owner / ancestor / enabled / popup / DWM (ADR-007 P4) ─────────────
export declare function win32GetWindow(hwnd: bigint, uCmd: number): bigint | null
export declare function win32GetAncestor(hwnd: bigint, gaFlags: number): bigint | null
export declare function win32IsWindowEnabled(hwnd: bigint): boolean
export declare function win32GetLastActivePopup(hwnd: bigint): bigint | null
export declare function win32IsWindowCloaked(hwnd: bigint): boolean

// ─── IME open-status query / control (issue #245 系統②) ─────────────────────
//
// Wraps Imm32 `ImmGetDefaultIMEWnd` + the legacy `WM_IME_CONTROL` message
// (`IMC_GETOPENSTATUS` / `IMC_SETOPENSTATUS`). Both return `false` cleanly
// when the target HWND has no associated default-IME window (ASCII layout /
// non-IME thread); callers can treat the boolean as a definitive ON/OFF.
export declare function win32GetImeOpenStatus(hwnd: bigint): boolean
export declare function win32SetImeOpenStatus(hwnd: bigint, open: boolean): boolean

// ─── ADR-017: Terminal Services session observability ───────────────────────
//
// `ProcessIdToSessionId` / `WTSGetActiveConsoleSessionId` /
// `WTSEnumerateSessionsW` wrappers backing `desktop_state`'s opt-in
// `sessionContext` block. All three are read-only, sync, panic-safe via
// `napi_safe_call`; cross-session control APIs are explicitly out of scope.
// The TS classifier (`src/tools/desktop-state.ts`) derives `sessionLabel`
// + `sessionState` from these three calls — native returns raw values only.

export interface NativeWtsSessionInfo {
  sessionId: number
  /** `"Console"`, `"RDP-Tcp#N"`, `"Services"`, etc. `""` when the WTS
   *  layer hands us a null pointer (some listener slots on certain SKUs). */
  winStation: string
  /** Raw `WTS_CONNECTSTATE_CLASS` value: 0=Active, 1=Connected, 2=ConnectQuery,
   *  3=Shadow, 4=Disconnected, 5=Idle, 6=Listen, 7=Reset, 8=Down, 9=Init. */
  state: number
  /** Pre-stringified state label (`"active"` / `"connected"` /
   *  `"disconnected"` / `"listen"` / etc.). Unknown values surface as
   *  `"state_<numeric>"` so a future enum addition is observable. */
  stateLabel: string
}

/** Map a process id to its TS session id. Returns `null` when the pid is
 *  invalid, the process is gone, or the API call failed. */
export declare function win32GetProcessSessionId(pid: number): number | null
/** Returns the active console session id, or `0xFFFFFFFF` when no user is
 *  signed in at the physical console. Caller treats `0xFFFFFFFF` as
 *  "no console". */
export declare function win32GetActiveConsoleSessionId(): number
/** One row per Terminal Services session on the local host. Returns an
 *  empty array when the underlying API fails (best-effort diagnostic). */
export declare function wtsEnumerateSessions(): Array<NativeWtsSessionInfo>

// ─── Desktop Duplication subscription (ADR-007 P5c-2, ADR-019 Stage 5) ──────
//
// Per-output DXGI Desktop Duplication subscription. Background thread polls
// `AcquireNextFrame` + `GetFrameDirtyRects` and queues dirty-rect batches
// for `next(timeoutMs)`. Coordinates are translated to desktop screen space
// using `outputBounds` (populated from `DXGI_OUTPUT_DESC.DesktopCoordinates`
// after PR #322 — correct for ALL monitors, not just primary).

export interface NativeDirtyRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeOutputBounds {
  x: number
  y: number
  width: number
  height: number
}

export declare class DirtyRectSubscription {
  constructor(outputIndex?: number)
  readonly isDisposed: boolean
  readonly outputBounds: NativeOutputBounds
  /** Poll for the next batch of dirty rectangles. Resolves with `[]` on
   *  timeout (normal when the screen is idle). Throws
   *  `E_DUP_ACCESS_LOST` / `E_DUP_DISPOSED` / `E_DUP_UNSUPPORTED` on the
   *  corresponding `DuplicationError` variants — callers must catch and
   *  degrade observation honestly. */
  next(timeoutMs: number): Promise<NativeDirtyRect[]>
  /** Release resources and stop the background DXGI thread. Idempotent. */
  dispose(): void
}

// ─── L1 capture ring buffer (ADR-007 P5a) ────────────────────────────────────

export interface NativeEventEnvelope {
  envelopeVersion: number
  eventId: bigint
  wallclockMs: bigint
  subOrdinal: number
  timestampSource: number
  kind: number
  payloadBytes: Buffer
  sessionId?: string | null
  toolCallId?: string | null
}

export interface NativeCaptureStats {
  uptimeMs: bigint
  pushCount: bigint
  dropCount: bigint
  currentBuffered: number
  panicCount: bigint
  eventIdHighWater: bigint
}

/** Lease 4-tuple summary attached to `l1PushToolCallStarted` when the
 * commit wrapper's lease-validation path is used (ADR-010 P1 S4 sub-plan
 * `docs/adr-010-p1-s4-plan.md` §2.3). The `expiresAtMs` field of the
 * runtime `EntityLease` is intentionally absent — commit-time validation
 * has already consumed it. `evidenceDigestPrefix8` is a fixed 8-char
 * prefix of the full digest so the L1 ring stays compact. */
export interface NativeLeaseTokenSummary {
  entityId: string
  viewId: string
  targetGeneration: string
  evidenceDigestPrefix8: string
}

export declare function l1PushToolCallStarted(tool: string, argsJson: string, sessionId?: string, toolCallId?: string, leaseToken?: NativeLeaseTokenSummary): bigint
export declare function l1PushToolCallCompleted(tool: string, elapsedMs: number, ok: boolean, errorCode?: string, sessionId?: string, toolCallId?: string): bigint
export declare function l1PushHwInputPostMessage(targetHwnd: bigint, msg: number, wParam: bigint, lParam: bigint, sessionId?: string, toolCallId?: string): bigint
export declare function l1PushFailure(layer: string, op: string, reason: string, panicPayload?: string, sessionId?: string, toolCallId?: string): bigint
export declare function l1PollEvents(sinceEventId: bigint, maxCount: number): NativeEventEnvelope[]
export declare function l1GetCaptureStats(): NativeCaptureStats
export declare function l1ShutdownForTest(): void

// ─── L3 perception view (ADR-008 D2-B-1) ─────────────────────────────────────

export interface NativeFocusedElement {
  name: string
  automationId: string | null
  /** Human-readable UIA control type name (e.g. "Button", "Pane", "Edit"). */
  controlType: string
  windowTitle: string
}

export interface NativeViewFocusedPipelineStatus {
  initialized: boolean
  /** `true` when the slot's pipeline has had a failed shutdown
   * (Codex review v9 P2-17). Callers should fall back to UIA. */
  poisoned: boolean
  /** Cumulative `Cmd::PushFocus` count the worker has dequeued and
   * run through `update_at` + `flush`. **Focus-only since S2 D2-C**
   * (Codex round 1 P2-B): `Cmd::PushDirtyRect` traffic is tracked
   * on a separate Rust-side counter (`PerceptionWorker::processed_dirty_rect_count`)
   * to keep this focus-pipeline telemetry isolated from dirty-rect
   * traffic. Pre-S2 it counted all events (mixed). 0 when the
   * pipeline is not yet initialized. */
  processedCount: bigint
}

/** Read the latest globally focused element from the perception engine's
 * `latest_focus` view. Returns `null` when the pipeline has no live row,
 * is uninitialised, or the slot is poisoned (caller should use UIA fallback). */
export declare function viewGetFocused(): NativeFocusedElement | null
export declare function viewFocusedPipelineStatus(): NativeViewFocusedPipelineStatus

// ─── L4 envelope helper (S3 D2-E0 P1, ADR-010) ───────────────────────────────

export interface NativeFocusedElementWithWallclock {
  /** Focused element shape; **omitted** by napi-rs (NOT set to `null`)
   * when no live focus / pipeline poisoned (PR #112 Round 1 P2-B/P1-3).
   * Same `Option::None` omission semantic as PR #108
   * `NativeDirtyRectsResult.latest` — see `native-types.ts` for the
   * full memory `feedback_napi_default_export.md` reference. Use
   * `result.focused != null` (covers both `undefined` from omission
   * and a hypothetical future explicit `null`). */
  focused?: NativeFocusedElement | null
  /** Wallclock_ms of the latest live focus event; **omitted** by napi-rs
   * when no event observed yet (same `Option::None` omission semantic
   * as `focused`). Caller uses `Date.now()` + `confidence: degraded`
   * fallback. */
  latestEventWallclockMs?: bigint | null
  /** True when pipeline slot is poisoned (Codex v9 P2-17). Caller
   * falls back to UIA path entirely. */
  viewPoisoned: boolean
}

/** Single-round-trip read of focused element + L1 event wallclock +
 * pipeline-poisoned flag. Used by the L4 envelope wrapper to build
 * `as_of.wallclock_ms` from L1 event time (NOT server-side `Date.now()`,
 * ADR-010 §5 + §4.1 Provenance, PR #110 Round 1 P1-4). */
export declare function viewGetFocusedWithWallclock(): NativeFocusedElementWithWallclock

// ─── L3 perception dirty_rects_aggregate view (S2 D2-C) ──────────────────────

export interface NativeDirtyRectFrame {
  frameIndex: bigint
  count: bigint
}

export interface NativeDirtyRectsResult {
  /** The `monitor_index` the caller asked for, echoed back so the TS
   * layer can confirm round-trip integrity (CLAUDE.md §3.2 PR #102 教訓). */
  monitorIndex: number
  /** Number of currently-retained frames for this monitor (after the
   * per-monitor FIFO cap eviction). */
  liveFrameCount: number
  /** Most recent `(frame_index, count)` for this monitor, if any.
   * **Optional** because napi-rs serialises `Option::None` for nested
   * struct fields by **omitting** the key (not setting it to `null`).
   * Consumers must either use optional chaining (`result.latest?.frameIndex`)
   * or explicitly check `'latest' in result` / `result.latest != null`
   * (both `null` and `undefined`). User review on PR #108 (2026-05-01)
   * pinned the runtime behaviour. */
  latest?: NativeDirtyRectFrame
}

/** Read the count-only `dirty_rects_aggregate` view for a given monitor
 * (S2 D2-C count-only contract spike, `docs/adr-008-d2-c-plan.md`).
 * Returns the per-monitor live-frame count and the latest
 * `(frame_index, count)`; empty result when the pipeline has no rect
 * yet, the slot is poisoned, or no rect for the requested monitor. */
export declare function viewGetDirtyRects(monitorIndex: number): NativeDirtyRectsResult

// ─── VBA Extensibility bridge (ADR-015 Phase 3) ──────────────────────────────
//
// napi-rs binding for `engine-vba-bridge::excel::*`. Session lifecycle
// is handled via integer handle IDs stored in a process-global
// `Mutex<HashMap<u32, Arc<ExcelSession>>>` inside `src/vba_bridge.rs`.
// Phase 4 wraps these into the single MCP tool surface `excel` (per
// ADR-015 §4.4) with a Zod discriminated union on `action`.

export interface ExcelAccessVbomStatus {
  trusted: boolean
  lockedByPolicy: boolean
  /** One of `"hklm-policy"` (HKLM dictates the value), `"hkcu"` (HKLM
   * unset, HKCU is 1), or `"default"` (neither set). */
  scope: string
}

/** Spawn an STA worker + create `Excel.Application`. Returns an integer
 * session ID for subsequent calls. The caller MUST call
 * `excelSessionClose(id)` when done; relying on GC will eventually
 * clean up but leaves Excel.exe running in the meantime. */
export declare function excelSessionSpawn(): number

/** Close the session: removes from the registry, joins the STA worker
 * thread, releases the IDispatch pointer + Excel.Application. Idempotent. */
export declare function excelSessionClose(sessionId: number): void

/** True if the session ID is still in the registry (not yet closed). */
export declare function excelSessionIsAlive(sessionId: number): boolean

/** Set `Application.Visible`. */
export declare function excelSetVisible(sessionId: number, visible: boolean): void

/** Set `Application.DisplayAlerts`. The Phase 2e demo path does NOT need
 * to call this — `excelWorkbookSaveAs` manages it internally via a
 * save-restore guard (ADR-015 §7 R9). Exposed for manual control. */
export declare function excelSetDisplayAlerts(sessionId: number, enabled: boolean): void

/** Create a fresh blank workbook on the active session. */
export declare function excelWorkbookAddNew(sessionId: number): void

/** Save the active workbook. `fileFormat` is the numeric `XlFileFormat`
 * value; v1 supports `52` (xlOpenXMLWorkbookMacroEnabled / `.xlsm`) only —
 * passing other values throws `VbaUnsupportedArgumentType`. Internally
 * manages `DisplayAlerts` via a save-restore guard. */
export declare function excelWorkbookSaveAs(
  sessionId: number,
  path: string,
  fileFormat: number,
): void

/** Close the active workbook. Does not close `Excel.Application` —
 * use `excelSessionClose` for that. */
export declare function excelWorkbookClose(sessionId: number, saveChanges: boolean): void

/** Add a VBA module to the active workbook + write source into it.
 * Requires `AccessVBOM = 1` (HKCU or HKLM); otherwise throws
 * `VbaAccessNotTrusted`. */
export declare function excelVbaModuleAdd(
  sessionId: number,
  moduleName: string,
  code: string,
): void

/** Run a previously-added macro by name. Calls `Application.Run`.
 * Requires the workbook to be anchored in a Trusted Location (see
 * ADR-015 §3.6 / Phase 2e); otherwise throws `VbaMacroExecutionFailed`
 * with HRESULT `0x800a03ec`. */
export declare function excelMacroRun(sessionId: number, macroName: string): void

/** Read HKCU / HKLM `AccessVBOM` state without modifying the registry.
 * Used by the Phase 4 MCP tool's `check_access_vbom` action. */
export declare function excelCheckAccessVbom(): ExcelAccessVbomStatus
