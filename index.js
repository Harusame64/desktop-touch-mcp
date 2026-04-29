/* eslint-disable */
// ESM wrapper for the desktop-touch-engine native addon. Node addons (.node)
// are always CJS, so we use createRequire to load them from within this module.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Try MSVC first (official publish triple per package.json), then GNU (dev toolchain).
const bindingCandidates = [
  "desktop-touch-engine.win32-x64-msvc.node",
  "desktop-touch-engine.win32-x64-gnu.node",
];

let nativeBinding = null;
let lastError = null;
const triedPaths = [];

for (const name of bindingCandidates) {
  const bindingPath = join(here, name);
  triedPaths.push(bindingPath);
  if (!existsSync(bindingPath)) continue;
  try {
    nativeBinding = _require(bindingPath);
    break;
  } catch (e) {
    lastError = e;
  }
}

if (!nativeBinding) {
  throw new Error(
    "Failed to load desktop-touch-engine native addon. " +
    `Tried: ${triedPaths.join(", ")}. ` +
    (lastError
      ? `Last load error: ${lastError.message}`
      : "No matching .node binary found for this platform.")
  );
}

// ─── Image diff ──────────────────────────────────────────────────────────────
export const computeChangeFraction = nativeBinding.computeChangeFraction;
export const dhashFromRaw = nativeBinding.dhashFromRaw;
export const hammingDistance = nativeBinding.hammingDistance;

// ─── UIA (Windows-only; properties may be undefined on non-Windows builds) ───
export const uiaGetElements = nativeBinding.uiaGetElements;
export const uiaGetFocusedAndPoint = nativeBinding.uiaGetFocusedAndPoint;
export const uiaGetFocusedElement = nativeBinding.uiaGetFocusedElement;
export const uiaScrollIntoView = nativeBinding.uiaScrollIntoView;
export const uiaGetScrollAncestors = nativeBinding.uiaGetScrollAncestors;
export const uiaScrollByPercent = nativeBinding.uiaScrollByPercent;
export const uiaGetVirtualDesktopStatus = nativeBinding.uiaGetVirtualDesktopStatus;
export const uiaClickElement = nativeBinding.uiaClickElement;
export const uiaSetValue = nativeBinding.uiaSetValue;
export const uiaInsertText = nativeBinding.uiaInsertText;
export const uiaGetElementBounds = nativeBinding.uiaGetElementBounds;
export const uiaGetElementChildren = nativeBinding.uiaGetElementChildren;
export const uiaGetTextViaTextPattern = nativeBinding.uiaGetTextViaTextPattern;

// ─── Hybrid Non-CDP pipeline (Step 2 + Step 4) ───────────────────────────────
export const preprocessImage  = nativeBinding.preprocessImage;
export const drawSomLabels    = nativeBinding.drawSomLabels;

// ─── Win32 hot-path APIs (ADR-007 P1) ────────────────────────────────────────
export const win32EnumTopLevelWindows       = nativeBinding.win32EnumTopLevelWindows;
export const win32GetWindowText             = nativeBinding.win32GetWindowText;
export const win32GetWindowRect             = nativeBinding.win32GetWindowRect;
export const win32GetForegroundWindow       = nativeBinding.win32GetForegroundWindow;
export const win32IsWindowVisible           = nativeBinding.win32IsWindowVisible;
export const win32IsIconic                  = nativeBinding.win32IsIconic;
export const win32IsZoomed                  = nativeBinding.win32IsZoomed;
export const win32GetClassName              = nativeBinding.win32GetClassName;
export const win32GetWindowThreadProcessId  = nativeBinding.win32GetWindowThreadProcessId;
export const win32GetWindowLongPtrW         = nativeBinding.win32GetWindowLongPtrW;

// ─── Win32 GDI / monitor / DPI (ADR-007 P2) ──────────────────────────────────
export const win32PrintWindowToBuffer       = nativeBinding.win32PrintWindowToBuffer;
export const win32EnumMonitors              = nativeBinding.win32EnumMonitors;
export const win32GetWindowDpi              = nativeBinding.win32GetWindowDpi;
export const win32SetProcessDpiAwareness    = nativeBinding.win32SetProcessDpiAwareness;

export default nativeBinding;
