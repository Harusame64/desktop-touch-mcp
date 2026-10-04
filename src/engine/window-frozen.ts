/**
 * Internal #247 — a window whose process the OS has frozen is not read as if it showed its contents.
 *
 * A packaged app (Settings, Calculator, …) is suspended by its lifecycle manager a second or two
 * after it is minimised or hidden. Its window stays listed and can be captured, but the capture is
 * the last frame before it stopped and UI Automation reads nothing from it. MEASURED by win2
 * (2026-10-04, internal `spike/247-cloaked-windows`): `desktop_discover` on hidden Settings read 0
 * UIA elements, then OCRed that old frame and returned 28 elements as the window's contents —
 * including the account name — and two captures 5 s apart differed by 0 px. A window on another
 * virtual desktop is hidden too but running, and its capture is current, so the test is the frozen
 * process, not the hiding (`isWindowProcessFrozen`).
 */

import { isWindowProcessFrozen } from "./win32.js";

export class WindowFrozenError extends Error {
  /** Fit to publish (ADR-036 item 13, `CallerFacingRefusal` in `aim.ts`). */
  readonly callerDetail: string;
  /** Which entry refused (for logs; not published). */
  readonly where: string;
  constructor(where: string) {
    const detail =
      "This window's app is suspended by Windows (it is minimised or not shown): it reads nothing " +
      "through UI Automation, and a capture of it shows its last frame, not its contents now. " +
      "Restore or show the window, then read it again.";
    // `WindowFrozen:` declares the code to `classify` (`_errors.ts`), so a flat failure carries
    // this sentence and its advice rather than a generic code and an internal name.
    super(`WindowFrozen: ${detail}`);
    this.name = "WindowFrozenError";
    this.where = where;
    this.callerDetail = detail;
  }
}

/** Throws `WindowFrozenError` when the window's process is frozen. Cannot tell → does not throw. */
export function refuseIfFrozen(hwnd: unknown, where: string): void {
  if (typeof hwnd === "bigint" && isWindowProcessFrozen(hwnd) === true) {
    throw new WindowFrozenError(where);
  }
}
