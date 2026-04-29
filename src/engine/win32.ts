import koffi from "koffi";
import { nativeWin32 } from "./native-engine.js";

// Hot-path window APIs (10 functions) are routed through the napi-rs native
// addon (ADR-007 P1). Anything missing from `nativeWin32` indicates the addon
// was built before the win32 module landed — fail loudly so the dev rebuilds.
function requireNativeWin32(): NonNullable<typeof nativeWin32> {
  if (!nativeWin32) {
    throw new Error(
      "[win32] desktop-touch-engine native addon is missing the ADR-007 P1 " +
      "win32 surface. Run `npm run build:rs` to rebuild.",
    );
  }
  return nativeWin32;
}

// ─────────────────────────────────────────────────────────────────────────────
// DLL loading
// ─────────────────────────────────────────────────────────────────────────────

// `user32` still hosts the five owner-chain / enabled / popup utility
// bindings (`GetWindow`, `GetAncestor`, `IsWindowEnabled`,
// `GetLastActivePopup`) that ADR-007 §6 P3 deferred to P4. `kernel32` /
// `gdi32` / `shcore` were retired in earlier phases.
const user32 = koffi.load("user32.dll");
// dwmapi — window composition queries; available on Vista+ (always present on Win 10/11)
let _dwmapi: ReturnType<typeof koffi.load> | null = null;
try { _dwmapi = koffi.load("dwmapi.dll"); } catch { /* not available */ }

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

// RECT / MONITORINFO koffi structs removed in P2 — their last consumers
// (GetWindowRect / EnumDisplayMonitors / GetMonitorInfoW) live in
// src/win32/{window,monitor}.rs.

// PROCESSENTRY32W / SCROLLINFO koffi structs removed in P3 — their consumers
// (Toolhelp32 walk, GetScrollInfo) now live in src/win32/{process,scroll}.rs
// where windows-rs `repr(C)` enforces the field layout. The legacy
// `koffi.sizeof(SCROLLINFO) !== 28` sanity check that guarded against koffi
// padding bugs is therefore obsolete (windows-rs guarantees the size).

// ─────────────────────────────────────────────────────────────────────────────
// Function bindings
// ─────────────────────────────────────────────────────────────────────────────

// Function bindings have migrated to src/win32/*.rs in successive phases:
//   P1 (window.rs):  EnumWindows, GetWindowTextW, GetWindowRect, IsWindowVisible,
//                    IsIconic, IsZoomed, GetForegroundWindow, GetClassNameW,
//                    GetWindowThreadProcessId, GetWindowLongPtrW
//   P2 (gdi/monitor/dpi.rs): PrintWindow + GDI dance, EnumDisplayMonitors,
//                    GetMonitorInfoW, MonitorFromWindow, GetDpiForMonitor,
//                    SetProcessDpiAwareness
//   P3 (process/input/window_op/scroll.rs): ShowWindow, SetForegroundWindow,
//                    SetWindowPos (Set/Clear topmost + bounds), BringWindowToTop,
//                    AttachThreadInput, GetCurrentThreadId, OpenProcess,
//                    GetProcessTimes, QueryFullProcessImageNameW, Toolhelp32,
//                    GetScrollInfo, PostMessageW, GetFocus, MapVirtualKeyW
//
// The five koffi bindings still defined below are owner-chain / DWM utilities
// that ADR-007 §6 P3 deliberately deferred to P4 (`enumWindowsInZOrder`'s
// internal koffi calls move with them). All other koffi.func / koffi.struct /
// koffi.load entries in this file are intentionally retired.

// GWL_EXSTYLE / GW_OWNER / GA_ROOTOWNER / WS_EX_TOPMOST / DWMWA_CLOAKED:
// stable Win32 constants reused below.
const GWL_EXSTYLE   = -20;
const WS_EX_TOPMOST = 0x00000008;
const GW_OWNER      = 4;
const GA_ROOTOWNER  = 3;
const DWMWA_CLOAKED = 14;

// Owner / ancestor / enabled / DWM-cloaked queries — P4 will fold these into
// `src/win32/window.rs` along with `enumWindowsInZOrder`'s internal usages.
const GetWindowHwnd = user32.func(
  "intptr __stdcall GetWindow(void *hWnd, uint32 uCmd)"
);
const GetAncestor = user32.func(
  "intptr __stdcall GetAncestor(void *hWnd, uint32 gaFlags)"
);
const IsWindowEnabled = user32.func(
  "bool __stdcall IsWindowEnabled(void *hWnd)"
);
const GetLastActivePopup = user32.func(
  "intptr __stdcall GetLastActivePopup(void *hWnd)"
);
const _DwmGetWindowAttribute = _dwmapi
  ? _dwmapi.func(
      "long __stdcall DwmGetWindowAttribute(void *hwnd, uint32 dwAttribute, _Out_ uint32 *pvAttribute, uint32 cbAttribute)"
    )
  : null;

/**
 * Return the hwnd of the last active popup owned by `hwnd`.
 * Returns null when no popup exists (GetLastActivePopup returns the window itself).
 */
export function getLastActivePopup(hwnd: unknown): bigint | null {
  try {
    const result = GetLastActivePopup(hwnd) as bigint;
    return result === 0n ? null : result;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DPI awareness initialization (PROCESS_PER_MONITOR_DPI_AWARE = 2)
// ─────────────────────────────────────────────────────────────────────────────

try {
  // E_ACCESSDENIED ("already set by another API") is treated as success
  // inside the native binding, matching the legacy try/catch swallow.
  requireNativeWin32().win32SetProcessDpiAwareness!(2);
} catch {
  // Ignore: not supported on this Windows version
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface MonitorInfo {
  id: number;
  handle: unknown;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  dpi: number;
  scale: number;
}

/** Enumerate all connected monitors */
export function enumMonitors(): MonitorInfo[] {
  const raw = requireNativeWin32().win32EnumMonitors!();
  return raw.map((m, id) => ({
    id,
    handle: m.handle, // bigint at runtime; declared `unknown` to keep callers opaque
    primary: m.primary,
    bounds: {
      x: m.boundsLeft,
      y: m.boundsTop,
      width: m.boundsRight - m.boundsLeft,
      height: m.boundsBottom - m.boundsTop,
    },
    workArea: {
      x: m.workLeft,
      y: m.workTop,
      width: m.workRight - m.workLeft,
      height: m.workBottom - m.workTop,
    },
    dpi: m.dpi || 96,
    scale: Math.round(((m.dpi || 96) / 96) * 100),
  }));
}

/** Get the combined virtual screen bounds across all monitors */
export function getVirtualScreen(): { x: number; y: number; width: number; height: number } {
  const mons = enumMonitors();
  if (mons.length === 0) return { x: 0, y: 0, width: 1920, height: 1080 };
  const minX = Math.min(...mons.map((m) => m.bounds.x));
  const minY = Math.min(...mons.map((m) => m.bounds.y));
  const maxX = Math.max(...mons.map((m) => m.bounds.x + m.bounds.width));
  const maxY = Math.max(...mons.map((m) => m.bounds.y + m.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface WindowZInfo {
  hwnd: bigint;
  title: string;
  region: { x: number; y: number; width: number; height: number };
  /** Z-order index among visible windows. 0 = topmost (frontmost). */
  zOrder: number;
  isMinimized: boolean;
  isMaximized: boolean;
  /** true if this is the current foreground (focused) window. */
  isActive: boolean;
  /** Extended window style flags (WS_EX_*). Present when enumerated via enumWindowsInZOrder. */
  exStyle?: number;
  /** HWND of the direct owner window (GW_OWNER), or null for unowned top-level windows. */
  ownerHwnd?: bigint | null;
  /** Window class name (e.g. "#32770" for standard Win32 dialogs). */
  className?: string;
  /** True when the window is cloaked by DWM (e.g. UWP background / virtual-desktop windows). */
  isCloaked?: boolean;
  /** False when the window is disabled — indicates a modal dialog is blocking input. */
  isEnabled?: boolean;
}

/**
 * Enumerate all visible top-level windows in Z-order (front to back).
 * Skips invisible, untitled, and tiny windows (< 50px in either dimension).
 */
export function enumWindowsInZOrder(): WindowZInfo[] {
  const w32 = requireNativeWin32();
  const fg = w32.win32GetForegroundWindow!();
  const fgKey = fg !== null ? String(fg) : "";
  const results: WindowZInfo[] = [];
  let zOrder = 0;

  const hwnds = w32.win32EnumTopLevelWindows!();
  for (const hwnd of hwnds) {
    try {
      if (!w32.win32IsWindowVisible!(hwnd)) continue;
      const title = w32.win32GetWindowText!(hwnd);
      if (!title) continue;
      const rect = w32.win32GetWindowRect!(hwnd);
      if (!rect) continue;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;

      // Check minimized state BEFORE the size filter: minimized windows have a
      // "parking" rect (~160x31px) that would otherwise fail the < 50px check.
      const isMinimized = w32.win32IsIconic!(hwnd);
      if (!isMinimized && (width < 50 || height < 50)) continue;

      const isMaximized = !isMinimized && w32.win32IsZoomed!(hwnd);

      // Extended fields for perception modal detection
      const exStyle = w32.win32GetWindowLongPtrW!(hwnd, GWL_EXSTYLE);
      let ownerHwnd: bigint | null = null;
      try {
        const raw = GetWindowHwnd(hwnd, GW_OWNER) as bigint;
        ownerHwnd = raw === 0n ? null : raw;
      } catch { /* keep null */ }
      const className = w32.win32GetClassName!(hwnd);
      let isCloaked = false;
      if (_DwmGetWindowAttribute) {
        try {
          const val = [0];
          _DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, val, 4);
          isCloaked = val[0] !== 0;
        } catch { /* keep false */ }
      }
      let isEnabled = true;
      try { isEnabled = !!IsWindowEnabled(hwnd); } catch { /* keep true */ }

      results.push({
        hwnd,
        title,
        region: isMinimized
          ? { x: 0, y: 0, width: 0, height: 0 }
          : { x: rect.left, y: rect.top, width, height },
        zOrder: zOrder++,
        isMinimized,
        isMaximized,
        isActive: String(hwnd) === fgKey,
        exStyle,
        ownerHwnd,
        className,
        isCloaked,
        isEnabled,
      });
    } catch {
      // skip problematic windows
    }
  }

  return results;
}

/**
 * Get window title using GetWindowTextW (proper Unicode, unlike nut-js which may garble CJK text).
 * Returns empty string if the call fails or the window has no title.
 */
export function getWindowTitleW(hwnd: unknown): string {
  return requireNativeWin32().win32GetWindowText!(hwnd as bigint);
}

/**
 * Get the current bounding rectangle of a window by its HWND.
 * Returns null if the window no longer exists or the call fails.
 */
export function getWindowRectByHwnd(hwnd: unknown): { x: number; y: number; width: number; height: number } | null {
  try {
    const rect = requireNativeWin32().win32GetWindowRect!(hwnd as bigint);
    if (!rect) return null;
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  } catch {
    return null;
  }
}

/** Restore a minimized window and bring it to the foreground.
 *  Returns the actual window rect after restoration, plus force-focus result when opts.force=true.
 *  @param force When true, use AttachThreadInput to bypass Windows foreground-stealing protection. */
export function restoreAndFocusWindow(
  hwnd: unknown,
  opts?: { force?: boolean }
): { x: number; y: number; width: number; height: number; forceFocusOk?: boolean } {
  const SW_RESTORE = 9;
  const w32 = requireNativeWin32();
  if (typeof hwnd === "bigint") w32.win32ShowWindow!(hwnd, SW_RESTORE);
  let forceFocusOk: boolean | undefined;
  if (opts?.force) {
    const fr = forceSetForegroundWindow(hwnd);
    forceFocusOk = fr.ok;
  } else if (typeof hwnd === "bigint") {
    w32.win32SetForegroundWindow!(hwnd);
  }
  const rect = typeof hwnd === "bigint" ? w32.win32GetWindowRect!(hwnd) : null;
  const x = rect?.left ?? 0;
  const y = rect?.top ?? 0;
  const width = rect ? rect.right - rect.left : 0;
  const height = rect ? rect.bottom - rect.top : 0;
  return { x, y, width, height, ...(forceFocusOk !== undefined && { forceFocusOk }) };
}

/**
 * Force the given window to the foreground using AttachThreadInput.
 * This bypasses Windows foreground-stealing protection.
 *
 * Returns:
 *   ok: true  — window is now in the foreground
 *   ok: false — SetForegroundWindow was called but refused
 *   attached: whether AttachThreadInput succeeded
 */
export function forceSetForegroundWindow(hwnd: unknown): {
  ok: boolean;
  attached: boolean;
  fg_before: bigint;
  fg_after: bigint;
} {
  if (typeof hwnd !== "bigint") {
    return { ok: false, attached: false, fg_before: 0n, fg_after: 0n };
  }
  // The native binding owns the AttachThreadInput pair lifetime via an
  // RAII guard; the TS wrapper just repacks camelCase → snake_case to
  // preserve the legacy public shape (Tool Surface 不変原則 P7).
  const r = requireNativeWin32().win32ForceSetForegroundWindow!(hwnd);
  return {
    ok: r.ok,
    attached: r.attached,
    fg_before: r.fgBefore,
    fg_after: r.fgAfter,
  };
}

/** Make a window always-on-top (HWND_TOPMOST). */
export function setWindowTopmost(hwnd: unknown): boolean {
  if (typeof hwnd !== "bigint") return false;
  return requireNativeWin32().win32SetWindowTopmost!(hwnd);
}

/** Remove always-on-top from a window (HWND_NOTOPMOST). */
export function clearWindowTopmost(hwnd: unknown): boolean {
  if (typeof hwnd !== "bigint") return false;
  return requireNativeWin32().win32ClearWindowTopmost!(hwnd);
}

/**
 * Get the PID of the process that owns a window.
 * Returns 0 on failure.
 *
 * Accepts `unknown` for compatibility with the historic koffi binding which
 * was lenient about `null`/`undefined` HWNDs (callers like
 * `tests/e2e/process-tree.test.ts` rely on this). napi-rs's BigInt coercion
 * rejects non-bigint values with `BigintExpected`, so we filter here.
 */
export function getWindowProcessId(hwnd: unknown): number {
  if (typeof hwnd !== "bigint") return 0;
  try {
    return requireNativeWin32().win32GetWindowThreadProcessId!(hwnd).processId >>> 0;
  } catch {
    return 0;
  }
}

/** Identity record that survives across HWND reuse / process restart. */
export interface ProcessIdentity {
  pid: number;
  processName: string;            // e.g. "powershell" (no .exe)
  /** Process creation time in ms since Windows epoch (1601). 0 on failure. */
  processStartTimeMs: number;
}

/**
 * Resolve a PID into {pid, processName, processStartTimeMs}.
 * Used to detect "same window title but different process" (HWND reuse / app restart).
 * On failure returns identity with empty processName / startTime=0 (still usable for equality of pid).
 *
 * Accepts the legacy `pid: number` contract; non-number inputs return a
 * zeroed identity (Opus pre-impl review §13.5). The native binding owns
 * the OpenProcess handle lifetime via RAII and supports partial success
 * (image OR creation time independent).
 */
export function getProcessIdentityByPid(pid: number): ProcessIdentity {
  if (typeof pid !== "number" || pid === 0) {
    return { pid: pid >>> 0, processName: "", processStartTimeMs: 0 };
  }
  try {
    const r = requireNativeWin32().win32GetProcessIdentity!(pid >>> 0);
    return {
      pid: r.pid,
      processName: r.processName,
      processStartTimeMs: r.processStartTimeMs,
    };
  } catch {
    return { pid: pid >>> 0, processName: "", processStartTimeMs: 0 };
  }
}

/** Convenience: identity for the process that owns a window. */
export function getWindowIdentity(hwnd: unknown): ProcessIdentity {
  const pid = getWindowProcessId(hwnd);
  return getProcessIdentityByPid(pid);
}

/**
 * Build a Map of pid → parentPid by snapshotting all processes via Toolhelp32.
 * Returns an empty map on failure. The native binding owns the snapshot
 * handle lifetime via RAII (no JS-side leak risk).
 */
export function buildProcessParentMap(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    for (const entry of requireNativeWin32().win32BuildProcessParentMap!()) {
      map.set(entry.pid >>> 0, entry.parentPid >>> 0);
    }
  } catch {
    // swallow; empty map is still usable
  }
  return map;
}

/**
 * Walk up the process tree from startPid and return the first ancestor PID
 * (including startPid itself) that owns a visible, non-minimized, reasonably-sized
 * top-level window. Returns null if no such ancestor exists.
 *
 * Use case: the MCP server runs as a child of the Claude Code CLI, which runs
 * under a terminal emulator. The CLI node process has no window, but the terminal
 * does — this finds the terminal's HWND without relying on title matching.
 */
export function findAncestorWindow(startPid: number): {
  hwnd: bigint;
  pid: number;
  title: string;
  region: { x: number; y: number; width: number; height: number };
} | null {
  const parentMap = buildProcessParentMap();
  // Gather visible top-level windows grouped by owning PID
  const windowsByPid = new Map<number, WindowZInfo[]>();
  for (const w of enumWindowsInZOrder()) {
    if (w.isMinimized) continue;
    if (w.region.width < 100 || w.region.height < 50) continue;
    const pid = getWindowProcessId(w.hwnd);
    if (pid === 0) continue;
    const arr = windowsByPid.get(pid) ?? [];
    arr.push(w);
    windowsByPid.set(pid, arr);
  }

  // Walk up the tree (cap at 20 levels to avoid cycles on pathological setups)
  let pid = startPid >>> 0;
  for (let depth = 0; depth < 20 && pid !== 0; depth++) {
    const wins = windowsByPid.get(pid);
    if (wins && wins.length > 0) {
      // Prefer the topmost (smallest zOrder) — closest to foreground
      wins.sort((a, b) => a.zOrder - b.zOrder);
      const pick = wins[0];
      return { hwnd: pick.hwnd, pid, title: pick.title, region: pick.region };
    }
    const next = parentMap.get(pid);
    if (next === undefined || next === pid) return null;
    pid = next;
  }
  return null;
}

/**
 * Move and resize a window in a single SetWindowPos call, without changing Z-order.
 * x/y/width/height are in virtual screen coordinates (Per-Monitor DPI aware).
 * Returns true on success.
 */
export function setWindowBounds(
  hwnd: unknown,
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  if (typeof hwnd !== "bigint") return false;
  return requireNativeWin32().win32SetWindowBounds!(hwnd, x, y, width, height);
}

/**
 * Capture a window (even if behind others) using PrintWindow.
 * @param hwnd  Window handle
 * @param flags PrintWindow flags:
 *   0 = default (fast, but GPU/DX windows may appear black)
 *   2 = PW_RENDERFULLCONTENT — captures GPU/Chrome/WinUI3 windows correctly,
 *       but may take 1-3s on video or game windows
 *   3 = PW_CLIENTONLY (1) + PW_RENDERFULLCONTENT (2) — client area only, GPU content
 */
export function printWindowToBuffer(hwnd: unknown, flags = 2): {
  data: Buffer;
  width: number;
  height: number;
} {
  if (typeof hwnd !== "bigint") throw new Error("printWindowToBuffer requires a bigint hwnd");
  const r = requireNativeWin32().win32PrintWindowToBuffer!(hwnd, flags);
  return { data: r.data, width: r.width, height: r.height };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrollbar info
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the HWND of the currently active (foreground) window.
 * Cheaper than enumWindowsInZOrder() when only foreground identity is needed.
 */
export function getForegroundHwnd(): bigint | null {
  try {
    return requireNativeWin32().win32GetForegroundWindow!();
  } catch {
    return null;
  }
}

/**
 * Return the registered class name of a window.
 * Returns an empty string if the window no longer exists or the call fails.
 */
export function getWindowClassName(hwnd: unknown): string {
  try {
    return requireNativeWin32().win32GetClassName!(hwnd as bigint);
  } catch {
    return "";
  }
}

/**
 * Return true when the window has the WS_EX_TOPMOST extended style set,
 * meaning it floats above all non-topmost windows regardless of z-order.
 */
export function isWindowTopmost(hwnd: unknown): boolean {
  try {
    const exStyle = requireNativeWin32().win32GetWindowLongPtrW!(hwnd as bigint, GWL_EXSTYLE);
    return (exStyle & WS_EX_TOPMOST) !== 0;
  } catch {
    return false;
  }
}

/**
 * Return the HWND of the owner window (GW_OWNER) or null if the window
 * has no owner (i.e. is a top-level unowned window).
 */
export function getWindowOwner(hwnd: unknown): bigint | null {
  try {
    const owner = GetWindowHwnd(hwnd, GW_OWNER) as bigint;
    return owner === 0n ? null : owner;
  } catch {
    return null;
  }
}

/**
 * Return the root-owner HWND (GetAncestor GA_ROOTOWNER=3).
 * Follows the owner chain to its root; returns the window's own HWND when unowned.
 * Returns null on failure.
 */
export function getWindowRootOwner(hwnd: unknown): bigint | null {
  try {
    const root = GetAncestor(hwnd, GA_ROOTOWNER) as bigint;
    return root === 0n ? null : root;
  } catch {
    return null;
  }
}

/**
 * Return true if the window is enabled (accepts keyboard/mouse input).
 * Returns true on error (conservative — assume not disabled to avoid missing modals).
 */
export function isWindowEnabled(hwnd: unknown): boolean {
  try {
    return !!IsWindowEnabled(hwnd);
  } catch {
    return true;
  }
}

/**
 * Return true if the window is cloaked by DWM (e.g. UWP background windows on
 * another virtual desktop). Cloaked windows pass IsWindowVisible but are not
 * actually drawn to the user's screen.
 * Returns false on error or when DWM is unavailable.
 */
export function isWindowCloaked(hwnd: unknown): boolean {
  if (!_DwmGetWindowAttribute) return false;
  try {
    const val = [0];
    _DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, val, 4);
    return val[0] !== 0;
  } catch {
    return false;
  }
}

export interface ScrollInfoResult {
  nMin: number;
  nMax: number;
  nPage: number;
  nPos: number;
  /** Scroll position normalised to 0..1. */
  pageRatio: number;
}

/**
 * Query the scrollbar position of a window using Win32 GetScrollInfo.
 * Returns null when the window has no scrollbar, the range is degenerate,
 * or the call fails.
 */
export function readScrollInfo(
  hwnd: bigint | unknown,
  axis: "vertical" | "horizontal"
): ScrollInfoResult | null {
  if (typeof hwnd !== "bigint") return null;
  try {
    const r = requireNativeWin32().win32GetScrollInfo!(hwnd, axis);
    if (!r) return null;
    return {
      nMin: r.nMin,
      nMax: r.nMax,
      nPage: r.nPage,
      nPos: r.nPos,
      pageRatio: r.pageRatio,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background input helpers
// ─────────────────────────────────────────────────────────────────────────────

export const WM_CHAR    = 0x0102;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP   = 0x0101;
export const VK_RETURN  = 0x0D;
export const VK_BACK    = 0x08;
export const VK_DELETE  = 0x2E;
export const VK_CONTROL = 0x11;
export const VK_SHIFT   = 0x10;
export const VK_MENU    = 0x12; // Alt
export const MAPVK_VK_TO_VSC = 0;

/** Post a single WM message to a window. Returns false on failure. */
export function postMessageToHwnd(hwnd: unknown, msg: number, wParam: number, lParam: number): boolean {
  if (typeof hwnd !== "bigint") return false;
  try {
    return requireNativeWin32().win32PostMessage!(
      hwnd,
      msg >>> 0,
      BigInt(wParam | 0),
      BigInt(lParam | 0),
    );
  } catch {
    return false;
  }
}

/** Return the HWND that currently has keyboard focus within the thread owning `hwnd`.
 *  Uses AttachThreadInput briefly to read focus across thread boundary
 *  (the native binding owns the attach pair via RAII).
 *  Returns null on failure — callers should fall back to the top-level hwnd. */
export function getFocusedChildHwnd(targetHwnd: unknown): bigint | null {
  if (typeof targetHwnd !== "bigint") return null;
  try {
    return requireNativeWin32().win32GetFocusedChildHwnd!(targetHwnd);
  } catch {
    return null;
  }
}

/** Map a Virtual Key code to a scan code (used for lParam of WM_KEYDOWN). */
export function vkToScanCode(vk: number): number {
  try {
    return requireNativeWin32().win32VkToScanCode!(vk >>> 0);
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DPI helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the effective DPI of the monitor that contains the given window.
 * Returns 96 (100% baseline) on any failure — safe fallback (keeps scale=2).
 * `MonitorFromWindow(MONITOR_DEFAULTTONEAREST)` + `GetDpiForMonitor(MDT_EFFECTIVE_DPI)`
 * are folded into the native binding so callers don't pay two FFI hops.
 */
export function getWindowDpi(hwnd: unknown): number {
  if (typeof hwnd !== "bigint") return 96;
  try {
    return requireNativeWin32().win32GetWindowDpi!(hwnd) || 96;
  } catch {
    return 96;
  }
}
