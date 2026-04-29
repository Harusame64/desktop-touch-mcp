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
  NativeDrawSomLabelsOptions,
  NativeDrawSomLabelsResult,
  NativeRecognizeRequest,
  NativeRawCandidate,
  NativeCapabilityProfile,
  NativeSessionInit,
  NativeSessionResult,
  NativeWin32Rect,
  NativeThreadProcessId,
  NativePrintWindowResult,
  NativeMonitorInfo,
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

  // ── Hybrid Non-CDP pipeline (optional — only present after native rebuild) ──

  /**
   * Preprocess a raw RGB/RGBA buffer for OCR (Step 2):
   * upscale `scale`×, convert to grayscale, apply min-max contrast stretch.
   * Returns a 1-channel grayscale buffer at (`width*scale`) × (`height*scale`).
   */
  preprocessImage?(opts: NativePreprocessOptions): Promise<NativeImageProcessingResult>;

  /**
   * Render Set-of-Mark annotations on a raw RGB/RGBA buffer (Step 4).
   * Draws a 2px red bounding box + white/black ID badge for each label.
   * Returns a buffer with the same dimensions and channel count as input.
   */
  drawSomLabels?(opts: NativeDrawSomLabelsOptions): Promise<NativeDrawSomLabelsResult>;
}

// ─── Win32 hot-path surface (ADR-007 P1, used by src/engine/win32.ts) ────────
//
// Sync `#[napi]` exports replacing 10 koffi bindings. Methods are optional so
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
  win32GetWindowThreadProcessId?(hwnd: bigint): NativeThreadProcessId;
  win32GetWindowLongPtrW?(hwnd: bigint, nIndex: number): number;

  // ADR-007 P2 GDI / monitor / DPI
  win32PrintWindowToBuffer?(hwnd: bigint, flags: number): NativePrintWindowResult;
  win32EnumMonitors?(): NativeMonitorInfo[];
  win32GetWindowDpi?(hwnd: bigint): number;
  win32SetProcessDpiAwareness?(level: number): boolean;
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
  // index.js exports each function as a named ESM export (no default unwrap needed).
  nativeBinding = addon as unknown as Record<string, unknown>;
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
// surface. TS wrappers in `src/engine/win32.ts` fall back to koffi when this
// is null (e.g. running an older .node without the win32 module).
export const nativeWin32: NativeWin32 | null =
  nativeBinding && typeof nativeBinding.win32EnumTopLevelWindows === "function"
    ? (nativeBinding as unknown as NativeWin32)
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
