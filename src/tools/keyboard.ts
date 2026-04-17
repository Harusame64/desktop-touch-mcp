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
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";

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
  fixId: z.string().optional().describe(
    "Approve a pending suggestedFix (one-shot, 15s TTL). Pass the fixId returned by a previous " +
    "failed keyboard_type to re-attempt with guard-validated args."
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

interface FocusForKeyboardResult {
  warnings: string[];
  homingNotes: string[];
  /**
   * true when the target window is confirmed to be in the foreground after
   * focusWindowForKeyboard returns. Covers two cases:
   *   1. Target was already the active window at entry (no focus work needed).
   *   2. Focus attempt (with or without force-escalation) verified via EnumWindows.
   * Callers pass this into the auto-guard so safe.keyboardTarget's foreground
   * fluent check is bypassed (the caller's verification is more authoritative than
   * a second EnumWindows racing with foreground-stealing protection).
   */
  foregroundVerified: boolean;
  /** true when SetForegroundWindow was refused even after force-escalation. */
  forceRefused: boolean;
}

async function focusWindowForKeyboard(
  windowTitle: string,
  force: boolean,
): Promise<FocusForKeyboardResult> {
  const warnings: string[] = [];
  const homingNotes: string[] = [];
  let foregroundVerified = false;
  let forceRefused = false;
  const needle = windowTitle.toLowerCase();
  try {
    const windows = enumWindowsInZOrder();
    const active = windows.find((w) => w.isActive);
    if (active && active.title.toLowerCase().includes(needle)) {
      // Target is already in the foreground — nothing to do.
      foregroundVerified = true;
    } else {
      const target = windows.find((w) => w.title.toLowerCase().includes(needle));
      if (target) {
        // Always verify foreground after focus so the auto-guard does not block
        // on a stale/foreground-steal-prevented SetForegroundWindow. If the first
        // attempt (honoring caller's `force` flag) fails to transfer the foreground,
        // auto-escalate to force=true so windowTitle+auto-guard remains a reliable
        // contract (the caller already expressed intent by passing windowTitle).
        restoreAndFocusWindow(target.hwnd, { force });
        await new Promise<void>((r) => setTimeout(r, 100));
        let after = enumWindowsInZOrder().find((w) => w.isActive);
        let reachedForeground = !!after && after.title.toLowerCase().includes(needle);

        if (!reachedForeground && !force) {
          // Auto-escalate to force focus (AttachThreadInput bypass) — the caller
          // asked us to type into this window, so bringing it to the foreground
          // is required for the keystrokes to reach the right target.
          restoreAndFocusWindow(target.hwnd, { force: true });
          await new Promise<void>((r) => setTimeout(r, 100));
          after = enumWindowsInZOrder().find((w) => w.isActive);
          reachedForeground = !!after && after.title.toLowerCase().includes(needle);
        }

        if (reachedForeground) {
          homingNotes.push(`brought "${target.title}" to front`);
          foregroundVerified = true;
        } else {
          warnings.push("ForceFocusRefused");
          forceRefused = true;
        }
      }
    }
  } catch {
    // best-effort
  }
  return { warnings, homingNotes, foregroundVerified, forceRefused };
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
  fixId,
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
  fixId?: string;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  try {
    // Phase G: fixId approval prologue
    let effectiveText = text;
    let effectiveWindowTitle = windowTitle;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "keyboard_type");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "keyboard_type");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      if (typeof vr.fix.args.text === "string") effectiveText = vr.fix.args.text;
      consumeFix(fixId);
    }
    const warnings: string[] = [];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // Step 1: Focus first (guard needs foreground state to be correct).
    if (effectiveWindowTitle) {
      const fw = await focusWindowForKeyboard(effectiveWindowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
      foregroundVerified = fw.foregroundVerified;
    }

    // Step 2: Guard evaluation (on already-focused window).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard_type", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "keyboard_type" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard_type",
          {
            lensId,
            guard: guardResult.failedGuard,
            _perceptionForPost: env,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "keyboard_type" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const descriptor = effectiveWindowTitle
        ? { kind: "window" as const, titleIncludes: effectiveWindowTitle }
        : null;
      const ag = await runActionGuard({
        toolName: "keyboard_type", actionKind: "keyboard", descriptor,
        ...(foregroundVerified && { foregroundVerified: true }),
        ...(fixId && { fixCarryingArgs: { text: effectiveText, windowTitle: effectiveWindowTitle } }),
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "keyboard_type",
          {
            _perceptionForPost: ag.summary,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = ag.summary;
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
    if (!use_clipboard && !forceKeystrokes && NON_ASCII_SYMBOL_RE.test(effectiveText)) {
      effectiveClipboard = true;
      autoClipboardReason = "non-ASCII symbol detected";
    }

    if (effectiveClipboard) {
      await typeViaClipboard(effectiveText);
    } else {
      await keyboard.type(effectiveText);
    }

    let focusLost = undefined;
    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: effectiveWindowTitle,
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

    return ok({
      ok: true,
      typed: effectiveText.length,
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
    // assertKeyComboSafe before focus — invalid keys fail immediately.
    assertKeyComboSafe(keys);

    const warnings: string[] = [];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // Step 1: Focus first (guard needs foreground state to be correct).
    if (windowTitle) {
      const fw = await focusWindowForKeyboard(windowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
      foregroundVerified = fw.foregroundVerified;
    }

    // Step 2: Guard evaluation (on already-focused window).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard_press", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "keyboard_press" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard_press",
          {
            lensId,
            guard: guardResult.failedGuard,
            _perceptionForPost: env,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "keyboard_press" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const descriptor = windowTitle
        ? { kind: "window" as const, titleIncludes: windowTitle }
        : null;
      const ag = await runActionGuard({
        toolName: "keyboard_press", actionKind: "keyboard", descriptor,
        ...(foregroundVerified && { foregroundVerified: true }),
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "keyboard_press",
          {
            _perceptionForPost: ag.summary,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = ag.summary;
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
    "Type a string into the focused window. Pass windowTitle to auto-focus and auto-guard (verifies identity, foreground, modal) before typing — returns post.perception.status without a screenshot. Omitting windowTitle types into the active window and returns post.perception.status='unguarded'. Pass replaceAll:true to Ctrl+A before typing. Prefer set_element_value for form fields. Examples: keyboard_type({windowTitle:'Notepad', text:'hello'}) // guarded. keyboard_type({text:'hello'}) // unguarded. keyboard_type({fixId:'fix-...'}) // approve suggestedFix to re-target. lensId is optional for advanced pinned-lens use. Caveats: Does not handle IME composition for CJK — use use_clipboard=true or set_element_value instead. Non-ASCII punctuation (em-dash etc.) auto-routes via clipboard (method:'clipboard-auto') to prevent Chrome address-bar hijack; pass forceKeystrokes:true to disable.",
    keyboardTypeSchema,
    withRichNarration("keyboard_type", keyboardTypeHandler, { windowTitleKey: "windowTitle" })
  );

  server.tool(
    "keyboard_press",
    "Press a key or key combination (e.g. 'ctrl+c', 'alt+tab', 'f5', 'escape'). Pass windowTitle to auto-focus and auto-guard before pressing — returns post.perception.status. Omitting windowTitle sends to the active window and returns post.perception.status='unguarded'. Examples: keyboard_press({windowTitle:'Notepad', keys:'ctrl+s'}) // guarded. keyboard_press({keys:'escape'}) // unguarded. lensId is optional for advanced pinned-lens use. Caveats: win+r, win+x, win+s, win+l are blocked for security. narrate:'rich' adds UIA state feedback for state-transitioning keys only.",
    keyboardPressSchema,
    withRichNarration("keyboard_press", keyboardPressHandler, {
      windowTitleKey: "windowTitle",
      keyboardPressGate: true,
      keysKey: "keys",
    })
  );
}
