import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import { makeCommitWrapper, withEnvelopeIncludeForUnion } from "./_envelope.js";

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

    // Issue #180 / matrix doc §3.1: post-write read-back verification.
    // Strict (always-on) per SSOT — perform Set-Clipboard then immediately
    // Get-Clipboard -Raw (the same path as clipboard:read) inside the same
    // PowerShell invocation to minimise the race window during which another
    // process could replace the clipboard contents. The read-back result is
    // emitted as a base64-encoded UTF-16LE blob on stdout so we can compare
    // byte-for-byte with the requested payload (Windows clipboard's native
    // CF_UNICODETEXT format is UTF-16LE).
    //
    // Combining write + read inside one powershell.exe pipeline (~50ms saved
    // vs spawning twice) keeps the verification overhead well below the
    // <5ms target listed in the issue body's perf goal once the PowerShell
    // cold-start cost (~150-200ms) is amortised over a path that already
    // pays it. A native Win32 clipboard implementation could shave the
    // remaining cost but is intentionally out of scope to keep this patch
    // focused on the SSOT verification contract.
    const script =
      `$b=[System.Convert]::FromBase64String('${b64}');` +
      `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
      `Set-Clipboard -Value $t;` +
      // Read back via the same Get-Clipboard -Raw path used by clipboard:read.
      // $null guard handles the (unlikely) race where the clipboard becomes
      // empty between Set and Get; we emit empty base64 in that case so the
      // verification step below classifies it as a mismatch.
      `$r=Get-Clipboard -Raw;` +
      `if($r -eq $null){Write-Output ''}else{` +
      `[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($r))` +
      `}`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5000 }
    );

    // Byte-equal compare (UTF-16LE, the native Windows clipboard format).
    // Buffer.equals avoids any normalization (NFC/NFD), BOM, or trailing-
    // newline coercion that string comparison could introduce.
    const expectedBytes = Buffer.from(text, "utf16le");
    const readBackB64 = stdout.trim();
    const actualBytes = readBackB64 ? Buffer.from(readBackB64, "base64") : Buffer.alloc(0);

    if (!expectedBytes.equals(actualBytes)) {
      // Do NOT echo the actual clipboard contents into the envelope: a racing
      // app may have placed sensitive data on the clipboard (passwords from
      // a clipboard manager, API keys from another tool) and we'd be leaking
      // it into the failure envelope (and downstream logs / LLM context).
      // Lengths are sufficient for diagnosis ("0 vs N" → cleared,
      // "N vs M, M≠N" → replaced).
      return failWith(
        new Error("ClipboardWriteNotDelivered"),
        "clipboard:write",
        {
          context: {
            hint: "post-write Get-Clipboard -Raw did not match the requested bytes (UTF-16LE)",
            expectedBytes: expectedBytes.length,
            actualBytes: actualBytes.length,
          },
        }
      );
    }

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

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `clipboard` is wrapped via `makeCommitWrapper` (lease-less commit variant
 * — `leaseValidator` omitted; clipboard read/write are OS-level idempotent
 * actions without a lease 4-tuple, mirroring the S6 `click_element` PoC and
 * the PR #123 `keyboard` wrap pattern).
 *
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer) composition
 * matches `keyboardRegistrationHandler` (`keyboard.ts:1038`) and
 * `clickElementRegistrationHandler` (`ui-elements.ts:372`):
 *   - withRichNarration enriches the handler's ToolResult (post.* hooks)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 *
 * `windowTitleKey` is omitted because clipboard has no window-scoped target
 * (read/write hit the OS clipboard regardless of foreground window). This
 * mirrors the same omission in the click_element/keyboard families when a
 * tool has no positional/window target — withRichNarration falls through
 * to `withPostState` only (the rich-narrate UIA-diff path is unreachable
 * since narrate isn't in the clipboard schema).
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.clipboard` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 *
 * Trunk pattern conformance: engine-perception layer 改変ゼロ
 * (expansion-pr-guard.yml + check-expansion-disjoint.mjs)、handler internal
 * logic + Zod schema + 戻り値 shape 不変 (ADR-010 §1.5)。
 */
export const clipboardRegistrationSchema = withEnvelopeIncludeForUnion(clipboardSchema);

export const clipboardRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "clipboard",
    clipboardHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "clipboard",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerClipboardTools(server: McpServer): void {
  server.registerTool(
    "clipboard",
    {
      description: "Read or write the Windows clipboard. action='read' returns current text content (empty string if non-text). action='write' replaces clipboard with given text. Caveats: Non-text clipboard payloads (images, files) return empty string on read. Overwrites existing clipboard content on write.",
      inputSchema: clipboardRegistrationSchema,
    },
    clipboardRegistrationHandler as typeof clipboardHandler
  );
}
