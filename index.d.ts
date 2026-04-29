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
export declare function win32GetWindowThreadProcessId(hwnd: bigint): NativeThreadProcessId
export declare function win32GetWindowLongPtrW(hwnd: bigint, nIndex: number): number

// ─── Win32 GDI / monitor / DPI (ADR-007 P2) ──────────────────────────────────
export declare function win32PrintWindowToBuffer(hwnd: bigint, flags: number): NativePrintWindowResult
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
export declare function win32GetFocusedChildHwnd(targetHwnd: bigint): bigint | null
export declare function win32BuildProcessParentMap(): NativeProcessParentEntry[]
export declare function win32GetProcessIdentity(pid: number): NativeProcessIdentity
export declare function win32GetScrollInfo(hwnd: bigint, axis: string): NativeScrollInfo | null
export declare function win32PostMessage(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): boolean
export declare function win32GetFocus(): bigint | null
export declare function win32VkToScanCode(vk: number): number

// ─── Win32 owner / ancestor / enabled / popup / DWM (ADR-007 P4) ─────────────
export declare function win32GetWindow(hwnd: bigint, uCmd: number): bigint | null
export declare function win32GetAncestor(hwnd: bigint, gaFlags: number): bigint | null
export declare function win32IsWindowEnabled(hwnd: bigint): boolean
export declare function win32GetLastActivePopup(hwnd: bigint): bigint | null
export declare function win32IsWindowCloaked(hwnd: bigint): boolean

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

export declare function l1PushToolCallStarted(tool: string, argsJson: string, sessionId?: string, toolCallId?: string): bigint
export declare function l1PushToolCallCompleted(tool: string, elapsedMs: number, ok: boolean, errorCode?: string, sessionId?: string, toolCallId?: string): bigint
export declare function l1PushHwInputPostMessage(targetHwnd: bigint, msg: number, wParam: bigint, lParam: bigint, sessionId?: string, toolCallId?: string): bigint
export declare function l1PushFailure(layer: string, op: string, reason: string, panicPayload?: string, sessionId?: string, toolCallId?: string): bigint
export declare function l1PollEvents(sinceEventId: bigint, maxCount: number): NativeEventEnvelope[]
export declare function l1GetCaptureStats(): NativeCaptureStats
export declare function l1ShutdownForTest(): void
