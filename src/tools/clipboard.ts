import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import { nativeWin32, hasNativeClipboardText } from "../engine/native-engine.js";
import {
  makeCommitWrapper,
  withEnvelopeIncludeForUnion,
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
} from "./_envelope.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const clipboardReadSchema = {};

export const clipboardWriteSchema = {
  text: z.string().max(100_000).describe("Text to place on the clipboard"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Backend selection
//
// ADR-033. The PowerShell path below reaches the clipboard by spawning
//   powershell.exe -Command "$b=[System.Convert]::FromBase64String('<blob>');
//                            … Set-Clipboard …"
// which is the shape of a well-known malware TTP (base64 payload decoded inline
// by PowerShell). Microsoft Defender scored the MCP server process as
// `Trojan:Win32/Commando.A!ml` and killed it mid-session. The native path
// removes the spawn entirely — there is no command line left for a heuristic to
// score — and it is roughly two orders of magnitude faster because it does not
// pay PowerShell's cold start.
//
// The PowerShell path is RETAINED rather than deleted because the compiled
// addon is optional: a build without the `.node`, or one predating this change,
// must still be able to read and write the clipboard. (Issue #386 hard-failed
// in the equivalent situation, but there the addon was required to even reach
// the code path; here there is no other channel to the clipboard at all.)
// ─────────────────────────────────────────────────────────────────────────────

/** Which implementation served the call. Surfaced in the envelope so a
 *  Defender-related regression is diagnosable from the response rather than by
 *  guesswork. */
type ClipboardBackend = "native" | "powershell";

/**
 * Largest payload the PowerShell fallback can actually deliver.
 *
 * That path embeds the text as base64 in a command line, and base64 of UTF-16LE
 * costs ~2.67 bytes per character against Windows' 32 767-character command-line
 * ceiling. Measured by binary search (ADR-033 spike): 12 117 characters went
 * through, 12 214 failed with a raw `ENAMETOOLONG` from `spawn` — an opaque
 * error for a tool whose schema advertises 100 000. The limit is checked up
 * front so the caller gets a named, actionable failure instead.
 *
 * The schema's `max(100_000)` stays as the NATIVE path's contract, which does
 * handle the full documented range.
 *
 * Exported because `typeViaClipboard` (`keyboard.ts`) reaches the clipboard
 * through the same kind of PowerShell command line and therefore hits the same
 * wall. One measured number, one place.
 */
export const FALLBACK_MAX_CHARS = 12_000;

/**
 * How long either backend may take before the call is abandoned. Shared by
 * both, so the tool's responsiveness contract does not depend on which
 * implementation served the request.
 *
 * These were the PowerShell path's `execFile` timeouts and are now the SSOT for
 * both. The native path needs them for a different reason: `GetClipboardData`
 * has no bounded worst case — for a delayed-rendered format the OS waits,
 * inside the call, for the owning application to answer — so a hung clipboard
 * owner would otherwise hang the tool call indefinitely. The old PowerShell
 * path was accidentally protected here, because the hang happened in a child
 * process that `execFile` could time out and abandon.
 *
 * IMPORTANT — what the timeout does NOT do on the native path: it abandons the
 * RESULT, not the work. Giving up aborts the signal, which cancels a task still
 * QUEUED for libuv's pool (see `withTimeout`), but a task already inside the
 * Win32 call runs to completion — it cannot be cancelled or killed the way the
 * child process could. Its result is discarded; its side effect is not, which
 * is why a timed-out write reports the clipboard as indeterminate rather than
 * un-written. The worker also stays blocked until the owner answers, so
 * libuv's 4-thread default pool can be exhausted by concurrent calls. That
 * state is bounded by the hung owner's lifetime, and while it lasts the
 * clipboard is unusable system-wide for every application; timing out keeps the
 * server answering rather than making it another casualty.
 */
const READ_TIMEOUT_MS = 4_000;
/** Exported: `typeViaClipboard` (`keyboard.ts`) writes the clipboard through
 *  the same two backends and must not answer a hung clipboard owner on a
 *  different schedule than this tool does. */
export const WRITE_TIMEOUT_MS = 5_000;

/** Distinguishes "we gave up waiting" from every other failure the handlers'
 *  catch blocks see, so only the former gets the unresponsive-owner advice. */
class ClipboardTimeoutError extends Error {}

// The rejection messages below deliberately say "gave up after" rather than
// "timed out". `_errors.ts::classify` has a generic timeout arm that captures
// the latter and answers a hung-clipboard failure with UiaTimeout's advice —
// "the app may be unresponsive, wait and retry" — which is the opposite of what
// the hint says, since retrying cannot help while the owner is hung. Measured,
// not assumed: "…timed out after 4000ms" classifies as UiaTimeout, "…gave up
// after 4000ms…" as the generic ToolError the hint is attached to. Same
// discipline as the other producers whose prose must stay clear of generic
// keywords.

/**
 * Run `start(signal)` and give up after `ms`, aborting the signal on the way
 * out.
 *
 * The abort is the part that matters. Giving up abandons the result, but the
 * addon's task may not even have STARTED: libuv's pool is 4 threads, so when
 * earlier calls against the same hung clipboard owner have saturated it, a new
 * task can spend its entire budget sitting in the queue. Without the abort it
 * would then run whenever the pool frees up — a write the caller was told had
 * failed, landing minutes later on top of whatever the user has copied since.
 * `AsyncTask::with_optional_signal` cancels a task that is still queued.
 * (A task already inside the Win32 call is not cancellable; that is the case
 * `CLIPBOARD_WRITE_UNRESPONSIVE_HINT` warns about.)
 *
 * The rejection is raised BEFORE the abort so the envelope is this timeout
 * rather than the addon's `AbortError`, which carries no hint. A late
 * settlement is discarded rather than leaked: `Promise.race` subscribes to the
 * work, so the abort-driven rejection is already handled and cannot surface as
 * an unhandled rejection. The timer is cleared on every exit so a pending
 * handle cannot hold the event loop open.
 */
export async function withTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = start(controller.signal);
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Lower-case message on purpose: an Error whose whole message is a
          // PascalCase token is this repo's compact-code producer shape and
          // would need its own SUGGESTS entry. A timeout has no recovery
          // distinct from the generic one beyond the hint attached at the
          // catch site.
          reject(new ClipboardTimeoutError(message));
          controller.abort();
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Advice attached to a give-up on either backend. The clipboard is one OS-wide
 *  lock, so the failure is almost never about this server. */
const CLIPBOARD_UNRESPONSIVE_HINT =
  "the application that owns the clipboard is not responding; while it stays hung the clipboard is unusable system-wide, so retrying will not help until that application recovers or is closed";

/**
 * The write variant, which has to say one more thing.
 *
 * Giving up abandons the RESULT, not the work — on both backends. Two of the
 * places a write can exceed its budget are past the point of no return:
 * `EmptyClipboard` broadcasts `WM_DESTROYCLIPBOARD` synchronously and can block
 * on a hung owner, after which the `SetClipboardData` behind it still runs once
 * that owner recovers; and a hang in the post-close verification leg happens
 * when the write has ALREADY landed. So after this failure the clipboard may be
 * unchanged, may be empty, or may hold the requested text — arriving later.
 *
 * That is the opposite of `ClipboardWriteNotDelivered`, whose advice says to
 * treat the clipboard as un-written. A caller that generalised from one to the
 * other could act on a stale read of a clipboard that is about to change under
 * it, so the difference is stated rather than left to be inferred.
 */
const CLIPBOARD_WRITE_UNRESPONSIVE_HINT =
  `${CLIPBOARD_UNRESPONSIVE_HINT}. Unlike a delivery-verification failure, the abandoned write may still complete on its own once that application recovers, so the clipboard contents are indeterminate after this failure — re-read before relying on them`;

/**
 * Did `execFile` kill the child because it exceeded its `timeout`?
 *
 * Measured rather than assumed, because the fallback's disclosure hangs on it
 * (Node 24, Windows): a timeout kill is the only one of these that sets
 * `killed:true` with a `signal`.
 *
 *   timeout      → killed:true,  signal:"SIGTERM", code:null
 *   non-zero exit→ killed:false, signal:null,      code:<exit status>
 *   maxBuffer    → killed absent, code:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
 *   spawn failure→ killed absent, code:"ENOENT"
 *
 * `killSignal` is left at its default, so the signal is whatever Node chose to
 * kill with; the predicate checks that one was sent rather than pinning the
 * name.
 */
function isExecFileTimeoutKill(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { killed?: unknown; signal?: unknown };
  return e.killed === true && typeof e.signal === "string" && e.signal.length > 0;
}

/** Whether a failure means "we stopped waiting", on either backend. */
const isGiveUp = (err: unknown): boolean =>
  err instanceof ClipboardTimeoutError || isExecFileTimeoutKill(err);

const selectBackend = (): ClipboardBackend =>
  hasNativeClipboardText() ? "native" : "powershell";

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

const nativeRead = async (): Promise<ToolResult> => {
  const r = await withTimeout(
    (signal) => nativeWin32!.win32ClipboardReadText!(signal),
    READ_TIMEOUT_MS,
    `native clipboard read gave up after ${READ_TIMEOUT_MS}ms waiting for the clipboard owner`,
  );
  if (!r.ok) {
    // Lower-case message on purpose. An Error whose entire message is a single
    // PascalCase token is this repo's "compact code" producer shape:
    // `_errors.ts::classify` routes it to a code of that name, which then needs
    // its own SUGGESTS entry or the caller gets a code with no advice (swept by
    // oq8-failwith-suggest-routing.test.ts). A read failure has no recovery
    // distinct from the generic one, so it stays on generic classification —
    // exactly like the PowerShell branch, which just rethrows whatever spawn
    // produced.
    return failWith(
      new Error(`native clipboard read failed: ${r.reason ?? "unknown"}`),
      "clipboard:read",
      { hint: r.reason ?? "native clipboard read failed", backend: "native" },
    );
  }
  // A non-text payload (image / files) and an empty clipboard both yield "",
  // which is the documented contract and what `Get-Clipboard -Raw` returns.
  const text = r.hasText ? Buffer.from(r.bytes).toString("utf16le") : "";
  return ok({ ok: true, text, backend: "native" satisfies ClipboardBackend });
};

const nativeWrite = async (text: string): Promise<ToolResult> => {
  // UTF-16LE bytes rather than a JS string: napi's String bridge transcodes
  // through UTF-8, which cannot represent an unpaired surrogate, so it would
  // replace one with U+FFFD *before* the byte comparison ran — and the
  // verification would then pass on mutated text.
  const payload = Buffer.from(text, "utf16le");
  const r = await withTimeout(
    (signal) => nativeWin32!.win32ClipboardWriteTextVerified!(payload, signal),
    WRITE_TIMEOUT_MS,
    `native clipboard write gave up after ${WRITE_TIMEOUT_MS}ms waiting for the clipboard owner`,
  );
  if (!r.ok) {
    // Which leg's byte count is worth reporting. Only a leg that actually READ
    // something may speak: the post-close read first (it is the one that can
    // see an interceptor), then the in-session read. When neither ran — the
    // write itself failed, or the clipboard never opened — `actualBytes` is
    // OMITTED rather than reported as 0, because "0 bytes were on the
    // clipboard" and "nothing was measured" are opposite diagnoses and a
    // fabricated 0 reads as the first one.
    const actualBytes = r.postCloseChecked
      ? r.postCloseBytes
      : r.inSessionReadable
        ? r.inSessionBytes
        : undefined;
    // Do NOT echo the actual clipboard contents (I-2): on a mismatch that text
    // belongs to another process and may be a password or an API key. Byte
    // counts are the whole diagnosis — "0 vs N" → cleared, "N vs M" → replaced.
    return failWith(new Error("ClipboardWriteNotDelivered"), "clipboard:write", {
      hint:
        r.reason === "clipboard_replaced_after_write"
          ? "another process replaced the clipboard immediately after the write (clipboard manager / DLP agent)"
          : (r.reason ?? "the read-back did not match the requested bytes (UTF-16LE)"),
      expectedBytes: r.expectedBytes,
      ...(actualBytes === undefined ? {} : { actualBytes }),
      backend: "native",
    });
  }
  return ok({
    ok: true,
    written: text.length,
    backend: "native" satisfies ClipboardBackend,
    // Verification diagnostics (plan D-5): the delivery verdict is `ok`, and
    // these say what backs it. `postCloseChecked:false` means the second leg
    // never ran — the write is still proven by the in-session read, but a
    // caller that cares about clipboard-manager interception now knows it was
    // not looked for, instead of having to assume it was.
    sequenceAfterWrite: r.sequenceAfterWrite,
    postCloseChecked: r.postCloseChecked,
    ...(r.postCloseChecked || !r.postCloseSkipReason
      ? {}
      : { postCloseSkipReason: r.postCloseSkipReason }),
    // Present only when it is false, i.e. only when the weaker evidence path
    // was taken (post-close agreement alone carried the write).
    ...(r.inSessionReadable ? {} : { inSessionReadable: false }),
  });
};

export const clipboardReadHandler = async (): Promise<ToolResult> => {
  const backend = selectBackend();
  try {
    if (backend === "native") return await nativeRead();
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
      { timeout: READ_TIMEOUT_MS }
    );
    const b64 = stdout.trim();
    const text = b64 ? Buffer.from(b64, "base64").toString("utf16le") : "";
    return ok({ ok: true, text, backend: "powershell" satisfies ClipboardBackend });
  } catch (err) {
    return failWith(err, "clipboard:read", {
      backend,
      ...(isGiveUp(err) ? { hint: CLIPBOARD_UNRESPONSIVE_HINT } : {}),
    });
  }
};

export const clipboardWriteHandler = async ({
  text,
}: {
  text: string;
}): Promise<ToolResult> => {
  const backend = selectBackend();
  try {
    if (backend === "native") return await nativeWrite(text);

    // Addon-less build only. Reject an over-long payload here rather than
    // letting `spawn` fail with `ENAMETOOLONG` several hundred milliseconds
    // later with nothing the caller can act on.
    if (text.length > FALLBACK_MAX_CHARS) {
      return failWith(new Error("ClipboardWriteTooLargeForFallback"), "clipboard:write", {
        hint: `this build has no native clipboard support, and the PowerShell fallback cannot carry more than about ${FALLBACK_MAX_CHARS} characters`,
        requestedChars: text.length,
        maxChars: FALLBACK_MAX_CHARS,
        backend,
      });
    }

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
    // pays it.
    //
    // #180 recorded here that a native Win32 implementation was "intentionally
    // out of scope". ADR-033 overturned that: Defender's detection made the
    // spawn a liability rather than a cost, and the native path (above) is now
    // the default. What survives is this fallback, for addon-less builds.
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
      { timeout: WRITE_TIMEOUT_MS }
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
          hint: "post-write Get-Clipboard -Raw did not match the requested bytes (UTF-16LE)",
          expectedBytes: expectedBytes.length,
          actualBytes: actualBytes.length,
          backend: "powershell" satisfies ClipboardBackend,
        }
      );
    }

    return ok({
      ok: true,
      written: text.length,
      backend: "powershell" satisfies ClipboardBackend,
      // This path's single `Get-Clipboard -Raw` runs after `Set-Clipboard`
      // released the lock, so it IS the post-close leg — hence `true` rather
      // than a shape that differs from the native backend for no reason.
      // `sequenceAfterWrite` is deliberately absent: PowerShell never observes
      // `GetClipboardSequenceNumber`, and emitting a placeholder would be a
      // diagnostic that lies. `backend` says which shape to expect.
      postCloseChecked: true,
    });
  } catch (err) {
    return failWith(err, "clipboard:write", {
      backend,
      // The write variant: after giving up, the clipboard contents are
      // indeterminate rather than merely unwritten. Same on both backends —
      // killing the PowerShell child does not unwind a Set-Clipboard that
      // already ran.
      ...(isGiveUp(err) ? { hint: CLIPBOARD_WRITE_UNRESPONSIVE_HINT } : {}),
    });
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
  // ADR-018 Phase 2a — strict per-action gate. The registered wire schema is
  // the flat `flattenUnionToObjectSchema` output; re-parse against the real
  // (include-injected) union so per-action constraints are still enforced.
  const parsed = parseActionArgsOrFail<ClipboardArgs>(clipboardUnionWithInclude, args, "clipboard");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  if (a.action === "read") return clipboardReadHandler();
  return clipboardWriteHandler(a);
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
// ADR-018 Phase 2a — `clipboardUnionWithInclude` (include-injected union) feeds
// BOTH the flat wire schema (`registerTool` inputSchema) AND the in-handler
// `parseActionArgsOrFail` strict gate. Do not pass the bare `clipboardSchema`.
const clipboardUnionWithInclude = withEnvelopeIncludeForUnion(clipboardSchema);
export const clipboardRegistrationSchema = flattenUnionToObjectSchema(clipboardUnionWithInclude);

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
      description: "Read or write the Windows clipboard. action='read' returns current text content (empty string if non-text). action='write' replaces clipboard with given text and verifies delivery by reading the clipboard back and comparing the bytes (UTF-16LE) for exact equality. Caveats: Non-text clipboard payloads (images, files) return empty string on read. Reading text larger than about 8MB (roughly 4 million characters, far above anything this tool can write) is refused immediately rather than copied. Calls give up after 4s (read) / 5s (write) — the usual cause is that the application owning the clipboard has stopped responding, which blocks the clipboard for every application on the machine, so retrying does not help until it recovers or is closed. A write that gives up leaves the clipboard in an indeterminate state (it may still complete once that application recovers), unlike code:'ClipboardWriteNotDelivered' where the write is known not to have landed — re-read before relying on the contents. Overwrites existing clipboard content on write. action='write' delivery-verification failure returns code:'ClipboardWriteNotDelivered' — typical causes: a third-party clipboard manager intercepts SetClipboardData, DLP / endpoint protection blocks the payload, RDP / Citrix clipboard transcoding strips the text, or another process clears the clipboard between Set and the read-back. Recovery: retry the write, or fall back to keyboard(action='type', use_clipboard=false) for short text. On builds without the native addon (backend:'powershell') writes are additionally capped at about 12000 characters and return code:'ClipboardWriteTooLargeForFallback' above it. Diagnostics: every response reports backend:'native'|'powershell' — the implementation that served the call. A successful write adds postCloseChecked: whether the read that catches a clipboard manager swapping the payload actually ran (native uses a separate second read; powershell's single read-back is that read), plus postCloseSkipReason when it did not run. On backend:'native' only, a successful write also reports sequenceAfterWrite (a Windows clipboard sequence number, for diagnosis only — the delivery verdict is always the byte comparison) and, when the post-close read alone confirmed the write, inSessionReadable:false. Examples: clipboard({action:'write', text:'hello'}) → write+verify; clipboard({action:'read'}) → returns current text.",
      inputSchema: clipboardRegistrationSchema,
    },
    clipboardRegistrationHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );
}
