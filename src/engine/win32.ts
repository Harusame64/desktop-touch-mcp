import koffi from "koffi";

// ─────────────────────────────────────────────────────────────────────────────
// DLL loading
// ─────────────────────────────────────────────────────────────────────────────

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const shcore = koffi.load("shcore.dll");
const kernel32 = koffi.load("kernel32.dll");

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

const RECT = koffi.struct("RECT", {
  left: "int32",
  top: "int32",
  right: "int32",
  bottom: "int32",
});

const MONITORINFO = koffi.struct("MONITORINFO", {
  cbSize: "uint32",
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: "uint32",
});

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

const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32",
  biWidth: "int32",
  biHeight: "int32",
  biPlanes: "uint16",
  biBitCount: "uint16",
  biCompression: "uint32",
  biSizeImage: "uint32",
  biXPelsPerMeter: "int32",
  biYPelsPerMeter: "int32",
  biClrUsed: "uint32",
  biClrImportant: "uint32",
});

// ─────────────────────────────────────────────────────────────────────────────
// Function bindings
// ─────────────────────────────────────────────────────────────────────────────

// Window functions
const GetWindowRect = user32.func(
  "bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)"
);
const GetWindowTextW = user32.func(
  "int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16 *lpString, int nMaxCount)"
);
const PrintWindow = user32.func(
  "bool __stdcall PrintWindow(void *hwnd, void *hdcBlt, uint32 nFlags)"
);
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hWnd)");
const IsIconic = user32.func("bool __stdcall IsIconic(void *hWnd)");
const IsZoomed = user32.func("bool __stdcall IsZoomed(void *hWnd)");
const GetForegroundWindow = user32.func("intptr __stdcall GetForegroundWindow()");
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void *hWnd)");
const EnumWindowsProto = koffi.proto(
  "bool __stdcall EnumWindowsProc(intptr hwnd, intptr lParam)"
);
const EnumWindows = user32.func(
  "bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr lParam)"
);

// DC / GDI
const GetDC = user32.func("void* __stdcall GetDC(void *hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)");
const CreateCompatibleDC = gdi32.func("void* __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func(
  "void* __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)"
);
const SelectObject = gdi32.func(
  "void* __stdcall SelectObject(void *hdc, void *h)"
);
const DeleteObject = gdi32.func("bool __stdcall DeleteObject(void *ho)");
const DeleteDC = gdi32.func("bool __stdcall DeleteDC(void *hdc)");
const GetDIBits = gdi32.func(
  "int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, uint8 *lpvBits, _Inout_ BITMAPINFOHEADER *lpbmi, uint32 usage)"
);

// Monitor enumeration
const MonitorEnumProcProto = koffi.proto(
  "bool __stdcall MonitorEnumProc(void *hMonitor, void *hdcMonitor, RECT *lprcMonitor, intptr dwData)"
);
const EnumDisplayMonitors = user32.func(
  "bool __stdcall EnumDisplayMonitors(void *hdc, RECT *lprcClip, MonitorEnumProc *lpfnEnum, intptr dwData)"
);
const GetMonitorInfoW = user32.func(
  "bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFO *lpmi)"
);

// DPI
const GetDpiForMonitor = shcore.func(
  "int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)"
);
const SetProcessDpiAwareness = shcore.func(
  "int __stdcall SetProcessDpiAwareness(int value)"
);

// Window → PID mapping
const GetWindowThreadProcessId = user32.func(
  "uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)"
);

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
const FILETIME = koffi.struct("FILETIME", {
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
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;

// ─────────────────────────────────────────────────────────────────────────────
// DPI awareness initialization (PROCESS_PER_MONITOR_DPI_AWARE = 2)
// ─────────────────────────────────────────────────────────────────────────────

try {
  SetProcessDpiAwareness(2);
} catch {
  // Ignore: already set or not supported on this Windows version
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
  const monitors: MonitorInfo[] = [];
  let id = 0;

  const cb = koffi.register(
    (hMonitor: unknown) => {
      const info = {
        cbSize: 40, // sizeof MONITORINFO
        rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
        rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
        dwFlags: 0,
      };
      GetMonitorInfoW(hMonitor, info);

      const dpiXArr = [0];
      const dpiYArr = [0];
      try {
        GetDpiForMonitor(hMonitor, 0 /* MDT_EFFECTIVE_DPI */, dpiXArr, dpiYArr);
      } catch {
        dpiXArr[0] = 96;
      }
      const dpi = dpiXArr[0] || 96;

      monitors.push({
        id: id++,
        handle: hMonitor,
        primary: (info.dwFlags & 1) !== 0,
        bounds: {
          x: info.rcMonitor.left,
          y: info.rcMonitor.top,
          width: info.rcMonitor.right - info.rcMonitor.left,
          height: info.rcMonitor.bottom - info.rcMonitor.top,
        },
        workArea: {
          x: info.rcWork.left,
          y: info.rcWork.top,
          width: info.rcWork.right - info.rcWork.left,
          height: info.rcWork.bottom - info.rcWork.top,
        },
        dpi,
        scale: Math.round((dpi / 96) * 100),
      });
      return true;
    },
    koffi.pointer(MonitorEnumProcProto)
  );

  try {
    EnumDisplayMonitors(null, null, cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  return monitors;
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
}

/**
 * Enumerate all visible top-level windows in Z-order (front to back).
 * Skips invisible, untitled, and tiny windows (< 50px in either dimension).
 */
export function enumWindowsInZOrder(): WindowZInfo[] {
  const fgHwnd = GetForegroundWindow() as bigint;
  const fgKey = String(fgHwnd);
  const results: WindowZInfo[] = [];
  let zOrder = 0;

  const cb = koffi.register(
    (hwnd: bigint) => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const title = getWindowTitleW(hwnd);
        if (!title) return true;
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!GetWindowRect(hwnd, rect)) return true;
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;

        // Check minimized state BEFORE the size filter: minimized windows have a
        // "parking" rect (~160x31px) that would otherwise fail the < 50px check.
        const isMinimized = !!IsIconic(hwnd);
        if (!isMinimized && (width < 50 || height < 50)) return true;

        const isMaximized = !isMinimized && !!IsZoomed(hwnd);

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
        });
      } catch {
        // skip problematic windows
      }
      return true;
    },
    koffi.pointer(EnumWindowsProto)
  );

  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }

  return results;
}

/**
 * Get window title using GetWindowTextW (proper Unicode, unlike nut-js which may garble CJK text).
 * Returns empty string if the call fails or the window has no title.
 */
export function getWindowTitleW(hwnd: unknown): string {
  const MAX = 512;
  const buf = Buffer.alloc(MAX * 2); // UTF-16LE
  const len = GetWindowTextW(hwnd, buf, MAX) as number;
  if (len <= 0) return "";
  return buf.slice(0, len * 2).toString("utf16le");
}

/**
 * Get the current bounding rectangle of a window by its HWND.
 * Returns null if the window no longer exists or the call fails.
 */
export function getWindowRectByHwnd(hwnd: unknown): { x: number; y: number; width: number; height: number } | null {
  try {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(hwnd, rect)) return null;
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  } catch {
    return null;
  }
}

/** Restore a minimized window and bring it to the foreground.
 *  Returns the actual window rect after restoration. */
export function restoreAndFocusWindow(hwnd: unknown): { x: number; y: number; width: number; height: number } {
  const SW_RESTORE = 9;
  ShowWindow(hwnd, SW_RESTORE);
  SetForegroundWindow(hwnd);
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRect(hwnd, rect);
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
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
 */
export function getWindowProcessId(hwnd: unknown): number {
  const pidOut = [0];
  GetWindowThreadProcessId(hwnd, pidOut);
  return pidOut[0] >>> 0; // coerce to unsigned
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
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetWindowRect(hwnd, rect)) {
    throw new Error("GetWindowRect failed");
  }

  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid window dimensions: ${width}x${height}`);
  }

  const screenDC = GetDC(null);
  if (!screenDC) throw new Error("GetDC failed");

  const memDC = CreateCompatibleDC(screenDC);
  if (!memDC) {
    ReleaseDC(null, screenDC);
    throw new Error("CreateCompatibleDC failed");
  }

  const hBitmap = CreateCompatibleBitmap(screenDC, width, height);
  if (!hBitmap) {
    DeleteDC(memDC);
    ReleaseDC(null, screenDC);
    throw new Error("CreateCompatibleBitmap failed");
  }

  const oldBitmap = SelectObject(memDC, hBitmap);

  try {
    const ok = PrintWindow(hwnd, memDC, flags);
    if (!ok) {
      // Fall through — some windows partially render even when returning false
    }

    // Set up BITMAPINFOHEADER for 32bpp top-down DIB
    const bmi = {
      biSize: 40,
      biWidth: width,
      biHeight: -height, // negative = top-down
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };

    const pixels = Buffer.alloc(width * height * 4);
    GetDIBits(memDC, hBitmap, 0, height, pixels, bmi, 0 /* DIB_RGB_COLORS */);

    // Convert BGRA → RGBA and set alpha=255
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i]!;
      pixels[i] = pixels[i + 2]!;   // R ← B
      pixels[i + 2] = b;             // B ← R
      pixels[i + 3] = 255;           // Alpha = opaque
    }

    return { data: pixels, width, height };
  } finally {
    SelectObject(memDC, oldBitmap);
    DeleteObject(hBitmap);
    DeleteDC(memDC);
    ReleaseDC(null, screenDC);
  }
}
