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

// `user32` still hosts a handful of legacy bindings (ShowWindow,
// SetForegroundWindow, SetWindowPos, AttachThreadInput, etc.) that move to
// windows-rs in P3. `gdi32` / `shcore` were retired in P2 (their last
// callers — PrintWindow / GDI / DPI — now live in src/win32/{gdi,dpi}.rs).
const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
// dwmapi — window composition queries; available on Vista+ (always present on Win 10/11)
let _dwmapi: ReturnType<typeof koffi.load> | null = null;
try { _dwmapi = koffi.load("dwmapi.dll"); } catch { /* not available */ }

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

// RECT / MONITORINFO koffi structs removed in P2 — their last consumers
// (GetWindowRect / EnumDisplayMonitors / GetMonitorInfoW) live in
// src/win32/{window,monitor}.rs.

/** PROCESSENTRY32W — Toolhelp32 snapshot entry for process enumeration. */
const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32",
  cntUsage: "uint32",
  th32ProcessID: "uint32",
  th32DefaultHeapID: "uintptr", // ULONG_PTR: 8 bytes on x64, 4 on x86
  th32ModuleID: "uint32",
  cntThreads: "uint32",
  th32ParentProcessID: "uint32",
  pcPriClassBase: "int32",
  dwFlags: "uint32",
  szExeFile: koffi.array("uint16", 260), // WCHAR[MAX_PATH]
});

// BITMAPINFOHEADER koffi struct removed in P2 — GetDIBits now lives in
// src/win32/gdi.rs and constructs the struct natively.

/** SCROLLINFO — passed to GetScrollInfo to query scrollbar position. */
const SCROLLINFO = koffi.struct("SCROLLINFO", {
  cbSize:     "uint32",
  fMask:      "uint32",
  nMin:       "int32",
  nMax:       "int32",
  nPage:      "uint32",
  nPos:       "int32",
  nTrackPos:  "int32",
});

// SCROLLINFO fMask flags
const SIF_ALL      = 0x17;  // SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS
// nBar constants for GetScrollInfo
const SB_HORZ = 0;
const SB_VERT = 1;

// Sanity-check at module load: SCROLLINFO must be 28 bytes on x64 (no padding)
if (koffi.sizeof(SCROLLINFO) !== 28) {
  throw new Error(`SCROLLINFO sizeof mismatch: expected 28, got ${koffi.sizeof(SCROLLINFO)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Function bindings
// ─────────────────────────────────────────────────────────────────────────────

// Window functions — the hot-path bindings below have moved to the native
// addon (ADR-007 P1 = src/win32/window.rs, P2 = src/win32/{gdi,monitor,dpi}.rs):
//   P1: EnumWindows, GetWindowTextW, GetWindowRect, GetForegroundWindow,
//       IsWindowVisible, IsIconic, IsZoomed, GetClassNameW,
//       GetWindowThreadProcessId, GetWindowLongPtrW
//   P2: PrintWindow, GetDC, ReleaseDC, CreateCompatibleDC, CreateCompatibleBitmap,
//       SelectObject, DeleteObject, DeleteDC, GetDIBits, EnumDisplayMonitors,
//       GetMonitorInfoW, MonitorFromWindow, GetDpiForMonitor, SetProcessDpiAwareness
//
// Remaining koffi bindings move in P3 (ShowWindow, SetForegroundWindow,
// SetWindowPos, AttachThreadInput, OpenProcess/Toolhelp32, etc.).
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void *hWnd)");

// DC / GDI / Monitor enum / DPI bindings have all moved to the native addon
// (ADR-007 P2). The TS wrappers below (`enumMonitors`, `printWindowToBuffer`,
// `getWindowDpi`) call into `nativeWin32.win32*` directly.

// Window → PID mapping moved to ADR-007 P1 native addon
// (see src/win32/window.rs::win32_get_window_thread_process_id).

// Process tree traversal (Toolhelp32 snapshot)
const CreateToolhelp32Snapshot = kernel32.func(
  "void* __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)"
);
const Process32FirstW = kernel32.func(
  "bool __stdcall Process32FirstW(void *hSnapshot, _Inout_ PROCESSENTRY32W *lppe)"
);
const Process32NextW = kernel32.func(
  "bool __stdcall Process32NextW(void *hSnapshot, _Inout_ PROCESSENTRY32W *lppe)"
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *hObject)");

const TH32CS_SNAPPROCESS = 0x00000002;
const INVALID_HANDLE_VALUE_BIG = 0xffffffffffffffffn; // -1 as u64 for comparison

// Process identity (pid + creation time + image name) for cache invalidation
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// Registered with koffi by name; referenced as a string in func signatures below, no JS handle needed.
koffi.struct("FILETIME", {
  dwLowDateTime: "uint32",
  dwHighDateTime: "uint32",
});
const OpenProcess = kernel32.func(
  "void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)"
);
const GetProcessTimes = kernel32.func(
  "bool __stdcall GetProcessTimes(void *hProcess, _Out_ FILETIME *creation, _Out_ FILETIME *exit, _Out_ FILETIME *kernel, _Out_ FILETIME *user)"
);
const QueryFullProcessImageNameW = kernel32.func(
  "bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint32 *lpdwSize)"
);

// Window Z-order / always-on-top
// hWndInsertAfter is intptr (not void*) so negative sentinel values -1/-2 pass correctly
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(void *hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)"
);

// BringWindowToTop — secondary foreground hint
const BringWindowToTop = user32.func("bool __stdcall BringWindowToTop(void *hWnd)");

// AttachThreadInput — bypass foreground-stealing protection
const AttachThreadInput = user32.func(
  "bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)"
);

// GetCurrentThreadId — from kernel32.dll
const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");

// Scrollbar
const GetScrollInfo = user32.func(
  "bool __stdcall GetScrollInfo(void *hWnd, int fnBar, _Inout_ SCROLLINFO *lpsi)"
);

const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;

// Class name + extended style queries moved to ADR-007 P1 native addon
// (win32_get_class_name / win32_get_window_long_ptr_w). The owner-query
// `GetWindow` binding stays on koffi until P2/P3.
const GetWindowHwnd = user32.func(
  "intptr __stdcall GetWindow(void *hWnd, uint32 uCmd)"
);
const GWL_EXSTYLE  = -20;
const WS_EX_TOPMOST = 0x00000008;
const GW_OWNER     = 4;

// Window ancestry, enabled state, and DWM cloaked detection
const GetAncestor = user32.func(
  "intptr __stdcall GetAncestor(void *hWnd, uint32 gaFlags)"
);
const GA_ROOTOWNER = 3;
const IsWindowEnabled = user32.func(
  "bool __stdcall IsWindowEnabled(void *hWnd)"
);
const GetLastActivePopup = user32.func(
  "intptr __stdcall GetLastActivePopup(void *hWnd)"
);

// Background input — PostMessage / focus resolution / key mapping
const PostMessageW = user32.func(
  "bool __stdcall PostMessageW(void *hWnd, uint32 Msg, uintptr wParam, intptr lParam)"
);
const GetFocus = user32.func("intptr __stdcall GetFocus()");
const MapVirtualKeyW = user32.func(
  "uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)"
);
const DWMWA_CLOAKED = 14;
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
  ShowWindow(hwnd, SW_RESTORE);
  let forceFocusOk: boolean | undefined;
  if (opts?.force) {
    const fr = forceSetForegroundWindow(hwnd);
    forceFocusOk = fr.ok;
  } else {
    SetForegroundWindow(hwnd);
  }
  const rect = requireNativeWin32().win32GetWindowRect!(hwnd as bigint);
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
  const w32 = requireNativeWin32();
  const fg_before = w32.win32GetForegroundWindow!() ?? 0n;
  const hwndBig = hwnd as bigint;

  // If already in foreground, nothing to do
  if (String(fg_before) === String(hwndBig)) {
    return { ok: true, attached: false, fg_before, fg_after: fg_before };
  }

  const fgThread = w32.win32GetWindowThreadProcessId!(fg_before).threadId >>> 0;
  const myThread = (GetCurrentThreadId() as number) >>> 0;

  let attached = false;
  if (fgThread !== 0 && fgThread !== myThread) {
    try {
      attached = !!(AttachThreadInput(myThread, fgThread, true) as boolean);
    } catch {
      // If AttachThreadInput is unavailable or fails, fall through to legacy path
      attached = false;
    }
  }

  try {
    // SetForegroundWindow + BringWindowToTop always, regardless of attach success.
    // BringWindowToTop is a secondary hint that helps even without AttachThreadInput.
    SetForegroundWindow(hwnd);
    BringWindowToTop(hwnd);
  } finally {
    // Detach only if we successfully attached
    if (attached) {
      try {
        AttachThreadInput(myThread, fgThread, false);
      } catch {
        // detach is best-effort
      }
    }
  }

  const fg_after = w32.win32GetForegroundWindow!() ?? 0n;
  const ok = String(fg_after) === String(hwndBig);
  return { ok, attached, fg_before, fg_after };
}

/** Make a window always-on-top (HWND_TOPMOST). */
export function setWindowTopmost(hwnd: unknown): boolean {
  return !!SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/** Remove always-on-top from a window (HWND_NOTOPMOST). */
export function clearWindowTopmost(hwnd: unknown): boolean {
  return !!SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
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
 * Convert a Windows FILETIME (100-ns intervals since 1601) to ms.
 * Returns 0 if both halves are zero.
 */
function fileTimeToMs(low: number, high: number): number {
  if (low === 0 && high === 0) return 0;
  // BigInt to avoid precision loss; result is ms since Windows epoch (we don't need Unix conversion — only equality matters).
  const ticks = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  return Number(ticks / 10000n);
}

/**
 * Resolve a PID into {pid, processName, processStartTimeMs}.
 * Used to detect "same window title but different process" (HWND reuse / app restart).
 * On failure returns identity with empty processName / startTime=0 (still usable for equality of pid).
 */
export function getProcessIdentityByPid(pid: number): ProcessIdentity {
  const out: ProcessIdentity = { pid: pid >>> 0, processName: "", processStartTimeMs: 0 };
  if (pid === 0) return out;
  let h: bigint = 0n;
  try {
    h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid >>> 0) as bigint;
    if (!h || h === 0n) return out;

    // Image name
    const nameBuf = Buffer.alloc(520); // 260 wchars
    const sizeArr = [260];
    if (QueryFullProcessImageNameW(h, 0, nameBuf, sizeArr)) {
      const wlen = sizeArr[0] >>> 0;
      if (wlen > 0) {
        const path = nameBuf.slice(0, wlen * 2).toString("utf16le");
        const base = path.split(/[\\/]/).pop() ?? "";
        out.processName = base.replace(/\.exe$/i, "");
      }
    }

    // Creation time
    const cre = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const ext = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const krn = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const usr = { dwLowDateTime: 0, dwHighDateTime: 0 };
    if (GetProcessTimes(h, cre, ext, krn, usr)) {
      out.processStartTimeMs = fileTimeToMs(cre.dwLowDateTime, cre.dwHighDateTime);
    }
  } catch {
    // swallow; partial identity is still useful
  } finally {
    if (h && h !== 0n) {
      try { CloseHandle(h); } catch { /* noop */ }
    }
  }
  return out;
}

/** Convenience: identity for the process that owns a window. */
export function getWindowIdentity(hwnd: unknown): ProcessIdentity {
  const pid = getWindowProcessId(hwnd);
  return getProcessIdentityByPid(pid);
}

/**
 * Build a Map of pid → parentPid by snapshotting all processes via Toolhelp32.
 * Returns an empty map on failure.
 */
export function buildProcessParentMap(): Map<number, number> {
  const map = new Map<number, number>();
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as bigint;
  // INVALID_HANDLE_VALUE is -1 (0xFFFFFFFFFFFFFFFF on x64); koffi returns it as bigint
  if (snap === INVALID_HANDLE_VALUE_BIG || snap === 0n) return map;
  try {
    const entry = {
      dwSize: koffi.sizeof(PROCESSENTRY32W),
      cntUsage: 0,
      th32ProcessID: 0,
      th32DefaultHeapID: 0n,
      th32ModuleID: 0,
      cntThreads: 0,
      th32ParentProcessID: 0,
      pcPriClassBase: 0,
      dwFlags: 0,
      szExeFile: new Array<number>(260).fill(0),
    };
    if (Process32FirstW(snap, entry)) {
      do {
        map.set(entry.th32ProcessID >>> 0, entry.th32ParentProcessID >>> 0);
      } while (Process32NextW(snap, entry));
    }
  } finally {
    CloseHandle(snap);
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
  return !!SetWindowPos(hwnd, 0, x, y, width, height, SWP_NOZORDER);
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
  try {
    const si = {
      cbSize: koffi.sizeof(SCROLLINFO),
      fMask: SIF_ALL,
      nMin: 0, nMax: 0, nPage: 0, nPos: 0, nTrackPos: 0,
    };
    const fnBar = axis === "vertical" ? SB_VERT : SB_HORZ;
    const ok = GetScrollInfo(hwnd, fnBar, si);
    if (!ok) return null;
    const range = si.nMax - si.nMin - si.nPage + 1;
    if (range <= 0) return null;  // no real scroll range
    const pageRatio = Math.max(0, Math.min(1, (si.nPos - si.nMin) / range));
    return { nMin: si.nMin, nMax: si.nMax, nPage: si.nPage, nPos: si.nPos, pageRatio };
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
  try { return !!PostMessageW(hwnd, msg, wParam, lParam); } catch { return false; }
}

/** Return the HWND that currently has keyboard focus within the thread owning `hwnd`.
 *  Uses AttachThreadInput briefly to read focus across thread boundary.
 *  Returns null on failure — callers should fall back to the top-level hwnd. */
export function getFocusedChildHwnd(targetHwnd: unknown): bigint | null {
  try {
    const targetThread =
      requireNativeWin32().win32GetWindowThreadProcessId!(targetHwnd as bigint).threadId >>> 0;
    if (targetThread === 0) return null; // GetWindowThreadProcessId failed
    const myThread = (GetCurrentThreadId() as number) >>> 0;
    if (targetThread === myThread) {
      const f = GetFocus();
      return f ? BigInt(f as number) : null;
    }
    const attached = !!AttachThreadInput(myThread, targetThread, true);
    if (!attached) return null;
    try {
      const f = GetFocus();
      return f ? BigInt(f as number) : null;
    } finally {
      AttachThreadInput(myThread, targetThread, false);
    }
  } catch { return null; }
}

/** Map a Virtual Key code to a scan code (used for lParam of WM_KEYDOWN). */
export function vkToScanCode(vk: number): number {
  try { return (MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) as number) >>> 0; } catch { return 0; }
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
