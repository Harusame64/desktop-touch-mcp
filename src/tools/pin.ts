import { z } from "zod";
import { enumWindowsInZOrder, setWindowTopmost, clearWindowTopmost } from "../engine/win32.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { titleMatchesShownFirst } from "./_title-pick.js";

/**
 * A shown window before a hidden one with the same title (`_title-pick.ts`); a minimised one counts
 * as shown (its 0×0 rect used to skip it, and the hidden content of a minimised packaged app was
 * pinned instead — win2, llm22 F5). `allowHidden`: unpin may still reach a hidden window, so a
 * topmost flag set on one can be taken off. `hiddenOnly` says the title matched only hidden ones.
 */
function findWindowHwnd(
  titleQuery: string,
  opt: { allowHidden: boolean },
): { found: { hwnd: unknown; title: string } | null; hiddenOnly: boolean } {
  let hidden = false;
  for (const win of titleMatchesShownFirst(enumWindowsInZOrder(), titleQuery)) {
    if (!win.isMinimized && (win.region.width < 50 || win.region.height < 50)) continue;
    if (win.isCloaked === true && !opt.allowHidden) {
      hidden = true;
      continue;
    }
    return { found: { hwnd: win.hwnd, title: win.title }, hiddenOnly: false };
  }
  return { found: null, hiddenOnly: hidden };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const pinWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
  duration_ms: z
    .coerce.number()
    .int()
    .min(0)
    .max(60000)
    .optional()
    .describe("Auto-unpin after this many milliseconds (0–60000). Omit to pin indefinitely."),
};

export const unpinWindowSchema = {
  title: z.string().describe("Partial window title to search for (case-insensitive)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const pinWindowHandler = async ({
  title,
  duration_ms,
}: { title: string; duration_ms?: number }): Promise<ToolResult> => {
  try {
    const { found, hiddenOnly } = findWindowHwnd(title, { allowHidden: false });
    if (!found) {
      return failWith(
        new Error(
          hiddenOnly
            ? `No window found matching: "${title}" that is shown — only a hidden one (on another virtual desktop, or a packaged app's content while it is minimised or not shown); pinning it would change nothing on screen. Bring it back first (focus_window).`
            : `No window found matching: "${title}"`,
        ),
        "window_dock",
      );
    }

    setWindowTopmost(found.hwnd);

    if (duration_ms !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, duration_ms));
      clearWindowTopmost(found.hwnd);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, title: found.title, action: `pinned for ${duration_ms}ms, now unpinned` }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, title: found.title, action: "pinned (call window_dock(action='unpin') to remove)" }),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `window_dock(action='pin') failed: ${String(err)}` }] };
  }
};

export const unpinWindowHandler = async ({ title }: { title: string }): Promise<ToolResult> => {
  try {
    const { found } = findWindowHwnd(title, { allowHidden: true });
    if (!found) {
      return failWith(new Error(`No window found matching: "${title}"`), "window_dock");
    }

    clearWindowTopmost(found.hwnd);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, title: found.title, action: "unpinned" }),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `window_dock(action='unpin') failed: ${String(err)}` }] };
  }
};

// registerPinTools removed in Phase 2a (family merge).
// pin_window and unpin_window are now registered via window_dock(action='pin'|'unpin') in window-dock.ts.
