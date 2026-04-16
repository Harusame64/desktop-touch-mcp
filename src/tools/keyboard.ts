import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { withRichNarration, narrateParam } from "./_narration.js";
import { detectFocusLoss } from "./_focus.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";

const execFileAsync = promisify(execFile);

/**
 * Set the Windows clipboard via PowerShell, using Base64 to handle any Unicode text.
 * Then paste with Ctrl+V to bypass IME conversion.
 */
export async function typeViaClipboard(text: string, pasteCombo: "ctrl+v" | "ctrl+shift+v" = "ctrl+v"): Promise<void> {
  // Save current clipboard (best-effort — non-text content will be lost)
  let savedClipboard: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
      { timeout: 3000 }
    );
    savedClipboard = stdout;
  } catch {
    // Clipboard may be empty or locked — proceed without saving
  }

  // Encode as UTF-16LE (PowerShell's native string encoding)
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script =
    `$b=[System.Convert]::FromBase64String('${b64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
  });

  const combo = parseKeys(pasteCombo);
  await keyboard.pressKey(...combo);
  await keyboard.releaseKey(...combo);

  // Brief delay to let the paste complete before restoring clipboard
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Restore previous clipboard (best-effort)
  if (savedClipboard !== null) {
    try {
      const restoreB64 = Buffer.from(savedClipboard, "utf16le").toString("base64");
      const restoreScript =
        `$b=[System.Convert]::FromBase64String('${restoreB64}');` +
        `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
        `Set-Clipboard -Value $t`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", restoreScript], {
        timeout: 3000,
      });
    } catch {
      // Restore is best-effort — don't fail the overall operation
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const forceFocusParam = coercedBoolean().optional().describe(
  "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
  "before focusing the target window. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false)."
);

const trackFocusParam = coercedBoolean().default(true).describe(
  "When true (default), detect if focus was stolen from the target window after the action. " +
  "Reports focusLost in the response. Set false to skip."
);

const settleMsParam = z.coerce.number().int().min(0).max(2000).default(300).describe(
  "Milliseconds to wait after the action before checking foreground window (default 300)."
);

const windowTitleFocusParam = z.string().optional().describe(
  "Partial title of the window that should receive the keystrokes. " +
  "When provided, the server focuses this window before typing and uses it as the expected " +
  "target for focusLost detection."
);

/** Non-ASCII punctuation that can be hijacked as Chrome/Edge keyboard accelerators */
const NON_ASCII_SYMBOL_RE = /[\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u00A0]/;

export const keyboardTypeSchema = {
  text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
  narrate: narrateParam,
  use_clipboard: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
      "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
      "prevents IME from converting characters. Default false."
    ),
  replaceAll: z.boolean().optional().default(false).describe(
    "When true, send Ctrl+A to select all existing text before typing. " +
    "Equivalent to Ctrl+A → keyboard_type in one call (requires field already focused). Default false."
  ),
  forceKeystrokes: z.boolean().optional().default(false).describe(
    "When true, always use keystroke mode even if text contains non-ASCII symbols " +
    "(em-dash, en-dash, smart quotes, etc.) that would normally trigger auto-clipboard. " +
    "Default false — auto-clipboard is enabled."
  ),
  windowTitle: windowTitleFocusParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before typing, " +
    "and a perception envelope is attached to post.perception on success."
  ),
};

export const keyboardPressSchema = {
  keys: z
    .string()
    .max(100)
    .describe("Key combo string, e.g. 'ctrl+c', 'alt+tab', 'enter', 'ctrl+shift+s'. Note: win+r, win+x, win+s, win+l are blocked for security."),
  narrate: narrateParam,
  windowTitle: windowTitleFocusParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before the key press."
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function focusWindowForKeyboard(
  windowTitle: string,
  force: boolean,
): Promise<{ warnings: string[]; homingNotes: string[] }> {
  const warnings: string[] = [];
  const homingNotes: string[] = [];
  try {
    const windows = enumWindowsInZOrder();
    const active = windows.find((w) => w.isActive);
    if (!active || !active.title.toLowerCase().includes(windowTitle.toLowerCase())) {
      const target = windows.find((w) =>
        w.title.toLowerCase().includes(windowTitle.toLowerCase())
      );
      if (target) {
        restoreAndFocusWindow(target.hwnd, { force });
        if (force) {
          // Re-check if foreground was actually transferred to surface ForceFocusRefused
          await new Promise<void>((r) => setTimeout(r, 100));
          const after = enumWindowsInZOrder().find((w) => w.isActive);
          if (!after || !after.title.toLowerCase().includes(windowTitle.toLowerCase())) {
            warnings.push("ForceFocusRefused");
          } else {
            homingNotes.push(`brought "${target.title}" to front`);
          }
        } else {
          await new Promise<void>((r) => setTimeout(r, 100));
          homingNotes.push(`brought "${target.title}" to front`);
        }
      }
    }
  } catch {
    // best-effort
  }
  return { warnings, homingNotes };
}

export const keyboardTypeHandler = async ({
  text,
  use_clipboard,
  replaceAll,
  forceKeystrokes,
  windowTitle,
  forceFocus: forceFocusArg,
  trackFocus,
  settleMs,
  lensId,
}: {
  text: string;
  use_clipboard: boolean;
  replaceAll: boolean;
  forceKeystrokes: boolean;
  windowTitle?: string;
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
  lensId?: string;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  try {
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard_type", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard_type",
          { lensId, guard: guardResult.failedGuard }
        );
      }
    }
    const warnings: string[] = [];

    const homingNotes: string[] = [];
    if (windowTitle) {
      const fw = await focusWindowForKeyboard(windowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
    }

    // Ctrl+A to replace existing content before typing
    if (replaceAll) {
      const selectAll = parseKeys("ctrl+a");
      await keyboard.pressKey(...selectAll);
      await keyboard.releaseKey(...selectAll);
    }

    // Auto-clipboard: upgrade to clipboard mode when non-ASCII symbols are present
    // (unless the caller opted out via forceKeystrokes)
    let effectiveClipboard = use_clipboard;
    let autoClipboardReason: string | undefined;
    if (!use_clipboard && !forceKeystrokes && NON_ASCII_SYMBOL_RE.test(text)) {
      effectiveClipboard = true;
      autoClipboardReason = "non-ASCII symbol detected";
    }

    if (effectiveClipboard) {
      await typeViaClipboard(text);
    } else {
      await keyboard.type(text);
    }

    let focusLost = undefined;
    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: windowTitle,
        homingNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    const method = effectiveClipboard
      ? autoClipboardReason
        ? "clipboard-auto"
        : "clipboard"
      : "keystroke";

    const perceptionEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "keyboard_type" }) : undefined;
    return ok({
      ok: true,
      typed: text.length,
      method,
      ...(autoClipboardReason && { autoClipboardReason }),
      ...(focusLost && { focusLost }),
      ...(warnings.length > 0 && { hints: { warnings } }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "keyboard_type");
  }
};

export const keyboardPressHandler = async ({
  keys,
  windowTitle,
  forceFocus: forceFocusArg,
  trackFocus,
  settleMs,
  lensId,
}: {
  keys: string;
  windowTitle?: string;
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
  lensId?: string;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  try {
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard_press", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard_press",
          { lensId, guard: guardResult.failedGuard }
        );
      }
    }
    assertKeyComboSafe(keys);

    const warnings: string[] = [];
    const homingNotes: string[] = [];

    if (windowTitle) {
      const fw = await focusWindowForKeyboard(windowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
    }

    const keyList = parseKeys(keys);
    await keyboard.pressKey(...keyList);
    await keyboard.releaseKey(...keyList);

    let focusLost = undefined;
    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: windowTitle,
        homingNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    const perceptionEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "keyboard_press" }) : undefined;
    return ok({
      ok: true,
      pressed: keys,
      ...(focusLost && { focusLost }),
      ...(warnings.length > 0 && { hints: { warnings } }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "keyboard_press");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerKeyboardTools(server: McpServer): void {
  server.tool(
    "keyboard_type",
    "Type a string into the focused window. Pass windowTitle to auto-focus the target before typing and enable focus-loss detection (focusLost in response) — eliminates a separate focus_window call. Pass replaceAll:true to Ctrl+A before typing (replace existing content in one call). Prefer set_element_value for form fields. Caveats: Omitting windowTitle types into whatever window is currently active — if focus may have shifted since your last get_context, pass windowTitle explicitly. Does not handle IME composition for CJK — use use_clipboard=true or set_element_value instead. Text containing em-dash (—), en-dash (–), smart quotes, or other non-ASCII punctuation is automatically rerouted via clipboard (method:'clipboard-auto') to prevent Chrome/Edge from intercepting keystrokes as keyboard accelerators (e.g. address bar hijack). Pass forceKeystrokes:true to disable this auto-upgrade.",
    keyboardTypeSchema,
    withRichNarration("keyboard_type", keyboardTypeHandler, { windowTitleKey: "windowTitle" })
  );

  server.tool(
    "keyboard_press",
    "Press a key or key combination (e.g. 'ctrl+c', 'alt+tab', 'ctrl+shift+s', 'f5', 'escape', 'f1'–'f12'). Pass windowTitle to auto-focus before pressing — eliminates a separate focus_window call. Caveats: Omitting windowTitle sends keystrokes to the currently active window — if focus may have shifted since your last observation, pass windowTitle explicitly. win+r, win+x, win+s, win+l are blocked for security. narrate:'rich' adds UIA state feedback for state-transitioning keys (Enter, Tab, Esc, F-keys) only.",
    keyboardPressSchema,
    withRichNarration("keyboard_press", keyboardPressHandler, {
      windowTitleKey: "windowTitle",
      keyboardPressGate: true,
      keysKey: "keys",
    })
  );
}
