/**
 * Background input engine — WM_CHAR/WM_KEYDOWN injection via PostMessageW.
 *
 * Delivers text and key presses to a target HWND without changing the foreground
 * window. Works for standard Win32 controls, Windows Terminal, and conhost.
 * Does NOT work for Chromium-based apps (Chrome, Edge, Electron) or UWP sandboxed
 * apps — use `canInjectViaPostMessage` to check before calling.
 *
 * All functions are synchronous (PostMessageW is non-blocking by design).
 */

import {
  getWindowClassName,
  getWindowProcessId,
  getProcessIdentityByPid,
  getFocusedChildHwnd,
  postMessageToHwnd,
  vkToScanCode,
  WM_CHAR, WM_KEYDOWN, WM_KEYUP, VK_RETURN, VK_CONTROL, VK_SHIFT, VK_MENU,
} from "./win32.js";

// ─────────────────────────────────────────────────────────────────────────────
// Known-compatible terminal window classes (fast-path supported:true)
// ─────────────────────────────────────────────────────────────────────────────

/** Terminal window classes that reliably accept WM_CHAR injection. */
export const TERMINAL_WINDOW_CLASSES = new Set([
  "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal (wt.exe)
  "ConsoleWindowClass",             // conhost.exe (cmd, PowerShell, pwsh)
]);

// ─────────────────────────────────────────────────────────────────────────────
// Known-incompatible window class prefixes
// ─────────────────────────────────────────────────────────────────────────────

const CHROMIUM_CLASSES = new Set([
  "Chrome_WidgetWin_0",
  "Chrome_WidgetWin_1",
  "Chrome_RenderWidgetHostHWND",
  "CefBrowserWindow",
  "MozillaWindowClass",
]);

const UWP_CLASSES = new Set([
  "ApplicationFrameWindow",
  "Windows.UI.Core.CoreWindow",
  "Windows.UI.Input.InputSite.WindowClass",
]);

const CHROMIUM_PROCESS_RE = /^(chrome|msedge|brave|opera|firefox|vivaldi|electron)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Injection support check — cached per HWND for 3 seconds
// ─────────────────────────────────────────────────────────────────────────────

export interface InjectCheckResult {
  supported: boolean;
  reason?: "chromium" | "uwp_sandboxed" | "class_unknown";
  className?: string;
  processName?: string;
}

const _injectCache = new Map<string, { result: InjectCheckResult; expiresMs: number }>();

/**
 * Check whether PostMessage-based input injection is supported for this HWND.
 * Result is cached for 3 seconds.
 */
export function canInjectViaPostMessage(hwnd: unknown): InjectCheckResult {
  const key = String(hwnd);
  const cached = _injectCache.get(key);
  if (cached && Date.now() < cached.expiresMs) return cached.result;

  const result = _check(hwnd);
  _injectCache.set(key, { result, expiresMs: Date.now() + 3000 });
  return result;
}

function _check(hwnd: unknown): InjectCheckResult {
  try {
    const cls = getWindowClassName(hwnd);

    // Fast-path: known terminal classes are always supported
    if (TERMINAL_WINDOW_CLASSES.has(cls)) {
      return { supported: true, className: cls };
    }

    if (CHROMIUM_CLASSES.has(cls) || cls.startsWith("Chrome_")) {
      return { supported: false, reason: "chromium", className: cls };
    }
    if (UWP_CLASSES.has(cls)) {
      return { supported: false, reason: "uwp_sandboxed", className: cls };
    }

    const pid = getWindowProcessId(hwnd);
    const identity = getProcessIdentityByPid(pid);
    const procName = identity.processName;

    if (CHROMIUM_PROCESS_RE.test(procName)) {
      return { supported: false, reason: "chromium", className: cls, processName: procName };
    }

    return { supported: true, className: cls, processName: procName };
  } catch {
    return { supported: false, reason: "class_unknown" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the actual input-receiving child HWND
// ─────────────────────────────────────────────────────────────────────────────

function resolveTarget(hwnd: unknown): unknown {
  try {
    const child = getFocusedChildHwnd(hwnd);
    return child !== null ? child : hwnd;
  } catch {
    return hwnd;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Character injection
// ─────────────────────────────────────────────────────────────────────────────

/** Result of postCharsToHwnd. */
export interface PostCharsResult {
  /** Number of code units (UTF-16) successfully sent. */
  sent: number;
  /** true when all code units were sent. */
  full: boolean;
}

/**
 * Send `text` to `hwnd` via WM_CHAR messages, one UTF-16 code unit at a time.
 * Surrogate pairs are sent as two consecutive WM_CHAR messages (standard Win32).
 * '\n' is normalised to '\r' (0x0D) for terminal compatibility.
 *
 * Does NOT change the foreground window.
 */
export function postCharsToHwnd(hwnd: unknown, text: string): PostCharsResult {
  const target = resolveTarget(hwnd);
  let sent = 0;
  const total = text.length; // UTF-16 code unit count

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);

    // Normalise LF → CR for terminals
    const wParam = ch === 0x0A ? 0x0D : ch;

    if (!postMessageToHwnd(target, WM_CHAR, wParam, 0)) {
      return { sent, full: false };
    }
    sent++;
  }

  return { sent, full: sent === total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Key injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a single virtual key press (KEYDOWN + KEYUP) to `hwnd`.
 * Uses WM_KEYDOWN/WM_KEYUP — no foreground required.
 */
export function postKeyToHwnd(hwnd: unknown, vk: number): boolean {
  const target = resolveTarget(hwnd);
  const scan = vkToScanCode(vk);
  const lParamDown = (scan & 0xFF) << 16;
  const lParamUp   = lParamDown | (1 << 30) | (1 << 31); // prev-down + transition bits
  return (
    postMessageToHwnd(target, WM_KEYDOWN, vk, lParamDown) &&
    postMessageToHwnd(target, WM_KEYUP,   vk, lParamUp)
  );
}

/**
 * Send Enter to `hwnd` via WM_CHAR '\r'.
 * Preferred over postKeyToHwnd(VK_RETURN) for terminals (WT/conhost normalise '\r').
 */
export function postEnterToHwnd(hwnd: unknown): boolean {
  const target = resolveTarget(hwnd);
  return postMessageToHwnd(target, WM_CHAR, VK_RETURN, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Key combo injection (ctrl+a, ctrl+s, escape, etc.)
// ─────────────────────────────────────────────────────────────────────────────

const COMBO_VK: Record<string, number> = {
  ctrl: VK_CONTROL, shift: VK_SHIFT, alt: VK_MENU,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
  "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
  enter: 0x0D, escape: 0x1B, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E, insert: 0x2D, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
};

const MODIFIER_VKS = new Set([VK_CONTROL, VK_SHIFT, VK_MENU]);

/**
 * Send a key combination such as 'ctrl+a', 'escape', 'ctrl+shift+s' to `hwnd`.
 * Returns false if any key in the combo fails or the combo is unknown.
 *
 * Note: ctrl+v paste does NOT work in background mode (clipboard paste requires
 * the window to be foreground). This function is for structural key combos only.
 */
export function postKeyComboToHwnd(hwnd: unknown, combo: string): boolean {
  const target = resolveTarget(hwnd);
  const parts = combo.toLowerCase().split("+").map(p => p.trim());
  const vks = parts.map(p => COMBO_VK[p]).filter((v): v is number => v !== undefined);
  if (vks.length !== parts.length) return false; // unknown key

  const modifiers = vks.filter(v => MODIFIER_VKS.has(v));
  const mainKeys  = vks.filter(v => !MODIFIER_VKS.has(v));

  // Press modifiers
  for (const m of modifiers) {
    const scan = vkToScanCode(m);
    if (!postMessageToHwnd(target, WM_KEYDOWN, m, (scan & 0xFF) << 16)) return false;
  }
  // Press + release main keys
  for (const k of mainKeys) {
    if (!postKeyToHwnd(target, k)) return false;
  }
  // Release modifiers (reverse order)
  for (const m of [...modifiers].reverse()) {
    const scan = vkToScanCode(m);
    const lParam = ((scan & 0xFF) << 16) | (1 << 30) | (1 << 31);
    if (!postMessageToHwnd(target, WM_KEYUP, m, lParam)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When DTM_BG_AUTO=1, method:"auto" selects the BG channel automatically.
 * Default (DTM_BG_AUTO=0) keeps "auto" equivalent to "foreground" for safety.
 */
export function isBgAutoEnabled(): boolean {
  return process.env["DTM_BG_AUTO"] === "1";
}
