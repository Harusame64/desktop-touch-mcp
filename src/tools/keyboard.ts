import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";

const execFileAsync = promisify(execFile);

/**
 * Set the Windows clipboard via PowerShell, using Base64 to handle any Unicode text.
 * Then paste with Ctrl+V to bypass IME conversion.
 */
async function typeViaClipboard(text: string): Promise<void> {
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

  const ctrlV = parseKeys("ctrl+v");
  await keyboard.pressKey(...ctrlV);
  await keyboard.releaseKey(...ctrlV);

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

export const keyboardTypeSchema = {
  text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
  use_clipboard: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
      "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
      "prevents IME from converting characters. Default false."
    ),
};

export const keyboardPressSchema = {
  keys: z
    .string()
    .max(100)
    .describe("Key combo string, e.g. 'ctrl+c', 'alt+tab', 'enter', 'ctrl+shift+s'. Note: win+r, win+x, win+s, win+l are blocked for security."),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const keyboardTypeHandler = async ({
  text,
  use_clipboard,
}: {
  text: string;
  use_clipboard: boolean;
}): Promise<ToolResult> => {
  try {
    if (use_clipboard) {
      await typeViaClipboard(text);
      return ok({ ok: true, typed: text.length, method: "clipboard" });
    }
    await keyboard.type(text);
    return ok({ ok: true, typed: text.length, method: "keystroke" });
  } catch (err) {
    return failWith(err, "keyboard_type");
  }
};

export const keyboardPressHandler = async ({ keys }: { keys: string }): Promise<ToolResult> => {
  try {
    assertKeyComboSafe(keys);
    const keyList = parseKeys(keys);
    await keyboard.pressKey(...keyList);
    await keyboard.releaseKey(...keyList);
    return ok({ ok: true, pressed: keys });
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
    "Type a string of text using the keyboard. The text is sent to whatever window is currently focused.",
    keyboardTypeSchema,
    keyboardTypeHandler
  );

  server.tool(
    "keyboard_press",
    [
      "Press a key or key combination.",
      "Examples: 'enter', 'ctrl+c', 'alt+tab', 'ctrl+shift+s', 'f5', 'escape'.",
      "Modifiers: ctrl, alt, shift, win/meta.",
      "Special keys: enter, tab, space, backspace, delete, home, end, pageup, pagedown,",
      "up, down, left, right, escape, f1-f12.",
    ].join(" "),
    keyboardPressSchema,
    keyboardPressHandler
  );
}
