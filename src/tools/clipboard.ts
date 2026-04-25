import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const clipboardReadSchema = {};

export const clipboardWriteSchema = {
  text: z.string().max(100_000).describe("Text to place on the clipboard"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const clipboardReadHandler = async (): Promise<ToolResult> => {
  try {
    // Encode clipboard text as base64 UTF-16LE to avoid codepage and newline stripping issues.
    // PowerShell ConvertTo-Json of a string escapes special chars; base64 avoids that.
    const script =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$t=Get-Clipboard -Raw;" +
      "if($t -eq $null){Write-Output ''}else{" +
      "[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($t))" +
      "}";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 4000 }
    );
    const b64 = stdout.trim();
    const text = b64 ? Buffer.from(b64, "base64").toString("utf16le") : "";
    return ok({ ok: true, text });
  } catch (err) {
    return failWith(err, "clipboard:read");
  }
};

export const clipboardWriteHandler = async ({
  text,
}: {
  text: string;
}): Promise<ToolResult> => {
  try {
    // Encode as UTF-16LE (PowerShell native encoding) then base64 — same pattern as keyboard_type
    const b64 = Buffer.from(text, "utf16le").toString("base64");
    const script =
      `$b=[System.Convert]::FromBase64String('${b64}');` +
      `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
      `Set-Clipboard -Value $t`;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5000 }
    );
    return ok({ ok: true, written: text.length });
  } catch (err) {
    return failWith(err, "clipboard:write");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher schema (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

export const clipboardSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
  }),
  z.object({
    action: z.literal("write"),
    text: z.string().max(100_000).describe("Text to place on the clipboard"),
  }),
]);

export type ClipboardArgs = z.infer<typeof clipboardSchema>;

export const clipboardHandler = async (args: ClipboardArgs): Promise<import("./_types.js").ToolResult> => {
  if (args.action === "read") return clipboardReadHandler();
  return clipboardWriteHandler(args);
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerClipboardTools(server: McpServer): void {
  server.registerTool(
    "clipboard",
    {
      description: "Read or write the Windows clipboard. action='read' returns current text content (empty string if non-text). action='write' replaces clipboard with given text. Caveats: Non-text clipboard payloads (images, files) return empty string on read. Overwrites existing clipboard content on write.",
      inputSchema: clipboardSchema,
    },
    clipboardHandler
  );
}
