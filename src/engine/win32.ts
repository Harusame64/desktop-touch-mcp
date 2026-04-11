import koffi from "koffi";

// ─────────────────────────────────────────────────────────────────────────────
// DLL loading
// ─────────────────────────────────────────────────────────────────────────────

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const shcore = koffi.load("shcore.dll");

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

// Window Z-order / always-on-top
// hWndInsertAfter is intptr (not void*) so negative sentinel values -1/-2 pass correctly
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(void *hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)"
);
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;

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
        if (width < 50 || height < 50) return true;

        const isMinimized = !!IsIconic(hwnd);
        const isMaximized = !isMinimized && !!IsZoomed(hwnd);

        results.push({
          hwnd,
          title,
          region: { x: rect.left, y: rect.top, width, height },
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

/** Make a window always-on-top (HWND_TOPMOST). */
export function setWindowTopmost(hwnd: unknown): boolean {
  return !!SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
}

/** Remove always-on-top from a window (HWND_NOTOPMOST). */
export function clearWindowTopmost(hwnd: unknown): boolean {
  return !!SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
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
