/**
 * Shared window resolution utility for hwnd-based and @active targeting.
 *
 * Three-tier priority (highest to lowest):
 *   1. `hwnd` string  → look up window directly, bypass title search
 *   2. `windowTitle === "@active"` → resolve current foreground window
 *   3. Normal `windowTitle` partial match → return null (caller handles as before)
 *
 * Returns null for case 3 so existing title-based logic is unchanged.
 */

import { getForegroundHwnd, getWindowTitleW, getWindowRectByHwnd } from "../engine/win32.js";

export interface ResolvedWindow {
  title: string;
  hwnd: bigint;
  warnings: string[];
}

/** Value of DESKTOP_TOUCH_DOCK_TITLE env (resolved literal, not "@parent"). */
function getDockTitleLiteral(): string | undefined {
  const raw = process.env.DESKTOP_TOUCH_DOCK_TITLE;
  if (!raw || raw === "@parent") return undefined;
  return raw;
}

/**
 * Resolve `hwnd` or `@active` shorthand to a concrete `{ title, hwnd }`.
 * Returns `null` when neither special case applies (plain windowTitle → no-op).
 * Throws `WindowNotFound` when explicit hwnd is invalid or foreground cannot be determined.
 */
export async function resolveWindowTarget(params: {
  hwnd?: string;
  windowTitle?: string;
}): Promise<ResolvedWindow | null> {
  const warnings: string[] = [];

  // ── Case 1: explicit hwnd ─────────────────────────────────────────────────
  if (params.hwnd !== undefined) {
    let hwndb: bigint;
    try {
      hwndb = BigInt(params.hwnd);
    } catch {
      throw new Error(`WindowNotFound: hwnd "${params.hwnd}" is not a valid integer`);
    }
    const title = getWindowTitleW(hwndb);
    if (!title) {
      // Verify window still exists via rect (getWindowTitleW returns "" for invalid/invisible)
      const rect = getWindowRectByHwnd(hwndb);
      if (!rect) {
        throw new Error(`WindowNotFound: no visible window with hwnd "${params.hwnd}"`);
      }
    }
    const dockLiteral = getDockTitleLiteral();
    if (dockLiteral && title.toLowerCase().includes(dockLiteral.toLowerCase())) {
      warnings.push("HwndMatchesDockWindow: targeting the CLI host window — intended?");
    }
    return { title, hwnd: hwndb, warnings };
  }

  // ── Case 2: @active shorthand ─────────────────────────────────────────────
  if (params.windowTitle === "@active") {
    const hwndb = getForegroundHwnd();
    if (hwndb === null) {
      throw new Error("WindowNotFound: @active — no foreground window could be determined");
    }
    const title = getWindowTitleW(hwndb);
    const dockLiteral = getDockTitleLiteral();
    if (dockLiteral && title.toLowerCase().includes(dockLiteral.toLowerCase())) {
      warnings.push(
        "@active resolved to the CLI host window. " +
        "This may capture Claude itself rather than the target app. " +
        "Specify windowTitle explicitly if this is unintentional."
      );
    }
    return { title, hwnd: hwndb, warnings };
  }

  // ── Case 3: plain windowTitle or no target ────────────────────────────────
  return null;
}
