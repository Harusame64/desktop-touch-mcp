/* eslint-disable */
// Type declarations for desktop-touch-engine native addon.

// ─── Image diff ──────────────────────────────────────────────────────────────

export declare function computeChangeFraction(
  prev: Buffer,
  curr: Buffer,
  width: number,
  height: number,
  channels: number,
): number;

export declare function dhashFromRaw(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): bigint;

export declare function hammingDistance(a: bigint, b: bigint): number;

// ─── UIA types (matches Rust #[napi(object)] structs) ────────────────────────

export interface NativeBoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeUiElement {
  name: string;
  controlType: string;
  automationId: string;
  className?: string;
  isEnabled: boolean;
  boundingRect?: NativeBoundingRect | null;
  patterns: string[];
  depth: number;
  value?: string;
}

export interface NativeUiElementsResult {
  windowTitle: string;
  windowClassName?: string;
  windowRect?: NativeBoundingRect | null;
  elementCount: number;
  elements: NativeUiElement[];
}

export interface NativeUiaFocusInfo {
  name: string;
  controlType: string;
  automationId?: string;
  value?: string;
}

export interface NativeFocusAndPointResult {
  focused?: NativeUiaFocusInfo | null;
  atPoint?: NativeUiaFocusInfo | null;
}

export interface NativeScrollResult {
  ok: boolean;
  scrolled: boolean;
  error?: string;
}

export interface NativeScrollAncestor {
  name: string;
  automationId: string;
  controlType: string;
  verticalPercent: number;
  horizontalPercent: number;
  verticallyScrollable: boolean;
  horizontallyScrollable: boolean;
}

export interface NativeActionResult {
  ok: boolean;
  element?: string;
  error?: string;
  code?: string;
}

export interface NativeElementBounds {
  name: string;
  controlType: string;
  automationId: string;
  boundingRect?: NativeBoundingRect | null;
  value?: string;
}

// ─── UIA functions (Windows-only, may be undefined) ──────────────────────────

export declare function uiaGetElements(opts: {
  windowTitle: string;
  maxDepth?: number;
  maxElements?: number;
  fetchValues?: boolean;
}): Promise<NativeUiElementsResult>;

export declare function uiaGetFocusedAndPoint(opts: {
  cursorX: number;
  cursorY: number;
}): Promise<NativeFocusAndPointResult>;

export declare function uiaGetFocusedElement(): Promise<NativeUiaFocusInfo | null>;

export declare function uiaScrollIntoView(opts: {
  windowTitle: string;
  name?: string;
  automationId?: string;
}): Promise<NativeScrollResult>;

export declare function uiaGetScrollAncestors(opts: {
  windowTitle: string;
  elementName: string;
}): Promise<NativeScrollAncestor[]>;

export declare function uiaScrollByPercent(opts: {
  windowTitle: string;
  elementName: string;
  verticalPercent: number;
  horizontalPercent: number;
}): Promise<NativeScrollResult>;

export declare function uiaGetVirtualDesktopStatus(
  hwndIntegers: string[],
): Promise<Record<string, boolean>>;

// Phase C: Actions
export declare function uiaClickElement(opts: {
  windowTitle: string;
  name?: string;
  automationId?: string;
  controlType?: string;
}): Promise<NativeActionResult>;

export declare function uiaSetValue(opts: {
  windowTitle: string;
  value: string;
  name?: string;
  automationId?: string;
}): Promise<NativeActionResult>;

export declare function uiaInsertText(opts: {
  windowTitle: string;
  value: string;
  name?: string;
  automationId?: string;
}): Promise<NativeActionResult>;

export declare function uiaGetElementBounds(opts: {
  windowTitle: string;
  name?: string;
  automationId?: string;
  controlType?: string;
}): Promise<NativeElementBounds | null>;

export declare function uiaGetElementChildren(opts: {
  windowTitle: string;
  name?: string;
  automationId?: string;
  controlType?: string;
  maxDepth: number;
  maxElements: number;
  timeoutMs: number;
}): Promise<NativeUiElement[]>;

export declare function uiaGetTextViaTextPattern(opts: {
  windowTitle: string;
  timeoutMs: number;
}): Promise<string | null>;
