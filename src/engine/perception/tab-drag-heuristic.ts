/**
 * Heuristic detection for tab-strip drags in known tabbed applications.
 *
 * Problem: Windows 11 Notepad, Terminal, and similar tabbed apps treat a drag
 * that starts in the title-bar / tab-strip area as "detach tab to new window"
 * rather than "move window". This silently creates a new HWND and can trigger
 * a spurious CrossWindowDragBlocked error downstream.
 *
 * Detection criteria (all three must match):
 *   1. Source process name is in KNOWN_TAB_APPS
 *   2. Drag start Y is within TITLEBAR_HEIGHT_PX of the window top edge
 *   3. Horizontal displacement dominates vertical (|dx| > |dy| * 2)
 *
 * Intentionally conservative: vertical drags (window-move intent) are not flagged,
 * and any drag can be explicitly allowed with allowTabDrag:true.
 */

/**
 * Process base names (lowercase, no .exe) whose title-bar area contains a tab strip.
 * getProcessIdentityByPid strips the .exe suffix; we lowercase for comparison.
 */
export const KNOWN_TAB_APPS = new Set([
  "notepad",
  "windowsterminal",
  "explorer",
  "msedge",
  "chrome",
  "firefox",
  "code",            // VS Code
]);

/** Approximate height in pixels of the title-bar / tab-strip region. */
export const TITLEBAR_HEIGHT_PX = 56;

export interface TabDragRisk {
  risk: boolean;
  processName?: string;
}

/**
 * Returns { risk: true } when the drag looks like a tab-strip detach operation.
 *
 * @param startX  Drag start X (screen coords)
 * @param startY  Drag start Y (screen coords)
 * @param endX    Drag end X
 * @param endY    Drag end Y
 * @param windowTop     Top Y of the source window
 * @param processName   Source process name (case-insensitive)
 */
export function detectTabDragRisk(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  windowTop: number,
  processName: string
): TabDragRisk {
  const name = processName.toLowerCase();
  if (!KNOWN_TAB_APPS.has(name)) return { risk: false };

  const inTitleBar = (startY - windowTop) < TITLEBAR_HEIGHT_PX;
  if (!inTitleBar) return { risk: false };

  const dx = Math.abs(endX - startX);
  const dy = Math.abs(endY - startY);
  const horizontalDominant = dx > dy * 2;
  if (!horizontalDominant) return { risk: false };

  return { risk: true, processName: name };
}
