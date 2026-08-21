/**
 * _resolve-log.ts — ADR-035 Phase 1 observation: how a `windowTitle` was
 * resolved, and where the resulting input was actually dispatched.
 *
 * ADR-035 §7 needs to tell two failure hypotheses apart from production data
 * alone:
 *   H1 — the title matched MORE than one window and the resolver silently
 *        picked the wrong one (multi-match, no warning);
 *   H2 — the title matched NOTHING and a fallback (process-name / foreground /
 *        cursor) redirected the write to an unrelated window.
 *
 * Neither is visible in the tool response today: every resolver in the known
 * set (ADR-035 §2 #1-#4, #7-#9, #13 + `_input-pipeline.ts` Case 3) returns the
 * first match and drops the rest on the floor. This module writes the discarded
 * half — `matchCount`, the chosen window's identity, the runners-up, and the
 * fallback flag — into the existing append-only diagnostic log, plus a second
 * event at each native dispatch sink so a resolution can be joined to the write
 * it produced.
 *
 * **Zero behaviour change**: every export here is write-only observation. No
 * call site changes what it returns because of anything in this file.
 *
 * PII (plan §2 checklist, Round 10 Codex): a window title routinely carries a
 * file name, a mail subject, or a browser page title, and `diagnostic.log` is
 * on by default. So every title-shaped field — the query, the chosen title, the
 * runners-up titles, and the foreground title at dispatch — is recorded as
 * `sha256(title)` truncated to 8 hex chars plus its UTF-16 length.
 * `DESKTOP_TOUCH_RESOLVE_LOG_RAW=1` ADDS the raw string alongside the hash
 * (`titleRaw` / `queryRaw` / `fgTitleRaw`); it never replaces it, so a log
 * mixing both modes still joins on the hash.
 *
 * Idle cost: `logResolve` / `logDispatchSink` return before hashing, before any
 * Win32 syscall, and before building a record when the diagnostic log is
 * disabled. Nothing in this module runs on the hot path of a disabled log.
 *
 * Never throws. Both entry points swallow everything, for the reason
 * `logDiagnostic` gives for doing the same: these calls sit immediately before
 * native dispatches and inside resolvers that previously could not fail there,
 * and observation must not become a new crash source.
 *
 * Correlation (plan §2, Round 17 K-3): `logDiagnostic` stamps only ts / pid /
 * uptime, so concurrent tool calls interleave and a resolve event cannot be
 * matched to its dispatch. `runWithCallId` (installed over every registered
 * handler in `server-windows.ts`) puts a per-call id in AsyncLocalStorage and
 * every event carries it as `callId`.
 */

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logDiagnostic, isDiagnosticLogEnabled } from "../engine/diagnostic-log.js";
import type { ResolveResolver, ResolveWindowRecord, ResolveFallback, DispatchSink } from "../engine/diagnostic-log.js";
import { getWindowTitleW, getForegroundHwnd, getWindowIdentity } from "../engine/win32.js";
import { isAutoGuardEnabled } from "./_action-guard.js";

/** Cap on how many runners-up are recorded per resolve event (plan §2 checklist). */
const OTHERS_LIMIT = 5;

/**
 * Hash + length of a title-shaped string. SHA-256 truncated to 8 hex chars:
 * enough to join two occurrences of the same title within one log, short
 * enough to keep a record line small. `len` is UTF-16 code units — the same
 * unit `String.prototype.length` and the Win32 `GetWindowTextW` buffer use, so
 * it can be compared against a title read back from the OS.
 */
export function hashTitle(s: string): { hash: string; len: number } {
  return {
    hash: createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8),
    len: s.length,
  };
}

/** True when raw titles / queries are opted in via env (default: off). */
function rawTitlesEnabled(): boolean {
  return process.env.DESKTOP_TOUCH_RESOLVE_LOG_RAW === "1";
}

// ─── Per-call correlation id ─────────────────────────────────────────────────

interface CallContext { callId: string }

const _callAls = new AsyncLocalStorage<CallContext>();
let _callSeq = 0;

/**
 * Run `fn` under a fresh per-call correlation id, unless one is already active.
 *
 * Nested handler invocations (`run_macro` calls inner tool handlers directly)
 * INHERIT the outer id rather than minting a new one — the same inheritance
 * rule `_session-context.ts` uses — so a macro step's resolve and dispatch stay
 * joined to the macro call that caused them.
 */
export function runWithCallId<T>(fn: () => T): T {
  if (_callAls.getStore() !== undefined) return fn();
  _callSeq = (_callSeq + 1) % 1000000;
  return _callAls.run({ callId: `c${process.pid}-${_callSeq}` }, fn);
}

/** The active correlation id, or `null` outside any wrapped handler. */
export function currentCallId(): string | null {
  return _callAls.getStore()?.callId ?? null;
}

/**
 * Wrap the handler in a tool-registration argument list so every invocation
 * runs under its own correlation id. Same argument shape as
 * `wrapHandlerArgWithTiming` / `wrapHandlerArg` — the three chain, and this one
 * goes OUTERMOST so the id covers the failsafe pre-check and the timing wrapper
 * as well as the handler body.
 *
 * Skips the wrap on any argument shape it does not recognise, matching the
 * defensive contract of the two wrappers it chains with.
 */
export function wrapHandlerArgWithCallId(toolArgs: unknown[]): unknown[] {
  if (toolArgs.length === 0) return toolArgs;
  if (typeof toolArgs[0] !== "string") return toolArgs;
  const lastIdx = toolArgs.length - 1;
  const originalHandler = toolArgs[lastIdx];
  if (typeof originalHandler !== "function") return toolArgs;
  toolArgs[lastIdx] = async (...handlerArgs: unknown[]) =>
    runWithCallId(() =>
      (originalHandler as (...a: unknown[]) => Promise<unknown>)(...handlerArgs),
    );
  return toolArgs;
}

/** @internal Test-only — reset the sequence so ids are deterministic per test. */
export function _resetCallIdSeqForTest(): void {
  _callSeq = 0;
}

// ─── Resolve events ──────────────────────────────────────────────────────────

/**
 * The subset of `WindowZInfo` a resolve event records. Declared structurally
 * (not as `WindowZInfo`) so a caller that only has `{hwnd, title}` — the
 * `action-target.ts` snapshot, for one — can pass what it has.
 */
export interface ResolveWindowInput {
  hwnd: bigint;
  title: string;
  zOrder?: number;
  isActive?: boolean;
  isMinimized?: boolean;
  isCloaked?: boolean;
  /** Pre-read identity. Omit to skip the OpenProcess round-trip (see below). */
  pid?: number;
  processName?: string;
}

/**
 * Whether to pay for process identity on the windows in a resolve event.
 *
 * `getWindowIdentity` costs an `OpenProcess` + `QueryFullProcessImageName` per
 * window, so it is opt-in per call site: sites that already hold the identity
 * (`findTerminalWindow`'s process-name fallback) pass it in, and sites where
 * the pid is the discriminator the ADR needs (the terminal / keyboard write
 * paths, where "which shell did this land in" is the question) ask for it.
 * Read-side sites leave it off. At most `1 + OTHERS_LIMIT` lookups per event.
 */
export type IdentityMode = "skip" | "lookup";

function toRecord(w: ResolveWindowInput, identity: IdentityMode): ResolveWindowRecord {
  const t = hashTitle(w.title);
  let pid = w.pid;
  let processName = w.processName;
  if (identity === "lookup" && pid === undefined) {
    try {
      const ident = getWindowIdentity(w.hwnd);
      pid = ident.pid;
      processName = ident.processName;
    } catch {
      // best-effort — a window that died between resolution and logging just
      // loses its identity fields.
    }
  }
  return {
    hwnd: String(w.hwnd),
    titleHash: t.hash,
    titleLen: t.len,
    ...(rawTitlesEnabled() && { titleRaw: w.title }),
    ...(pid !== undefined && { pid }),
    ...(processName !== undefined && processName !== "" && { processName }),
    ...(w.zOrder !== undefined && { zOrder: w.zOrder }),
    ...(w.isActive !== undefined && { isActive: w.isActive }),
    ...(w.isMinimized !== undefined && { isMinimized: w.isMinimized }),
    ...(w.isCloaked !== undefined && { isCloaked: w.isCloaked }),
  };
}

/**
 * Record one title-to-window resolution. **One resolution = one event**: a site
 * that delegates to another instrumented helper must suppress one of the two
 * (see the `logAs: "off"` option in `_resolve-window.ts`).
 *
 * `matches` is the FULL match list in the resolver's own order — index 0 is the
 * window the resolver went on to use, the rest are the runners-up H1 is about.
 * Pass `chosen` explicitly when the resolver's tie-break is not "first match"
 * (`focusWindowForKeyboard` prefers the active window).
 */
export function logResolve(args: {
  resolver: ResolveResolver;
  query: string;
  matches: ResolveWindowInput[];
  /** Defaults to `matches[0]`. */
  chosen?: ResolveWindowInput | null;
  /**
   * Set when the chosen window did NOT come from the primary title match —
   * see the field's documentation on `DiagnosticEvent`.
   */
  fallback?: ResolveFallback;
  identity?: IdentityMode;
}): void {
  if (!isDiagnosticLogEnabled()) return;
  try {
    const identity = args.identity ?? "skip";
    const chosen = args.chosen !== undefined ? args.chosen : (args.matches[0] ?? null);
    const q = hashTitle(args.query);
    logDiagnostic({
      kind: "resolve",
      resolver: args.resolver,
      callId: currentCallId(),
      autoGuard: isAutoGuardEnabled(),
      queryHash: q.hash,
      queryLen: q.len,
      ...(rawTitlesEnabled() && { queryRaw: args.query }),
      matchCount: args.matches.length,
      chosen: chosen === null ? null : toRecord(chosen, identity),
      others: args.matches
        .filter((w) => chosen === null || w.hwnd !== chosen.hwnd)
        .slice(0, OTHERS_LIMIT)
        .map((w) => toRecord(w, identity)),
      ...(args.fallback !== undefined && { fallback: args.fallback }),
    });
  } catch {
    // See the module docstring: observation must never become a new crash
    // source. Every call site sits on a path that could not fail here before.
  }
}

// ─── Dispatch sink events ────────────────────────────────────────────────────

/**
 * Record one native input dispatch, immediately before the call that leaves the
 * process. `targetHwnd` is where the write was addressed (null for the
 * cursor / foreground-routed sinks that have no handle); the foreground window
 * is read here so H2 can be confirmed — a dispatch whose target is not the
 * foreground window, or whose foreground is the operator's own session window,
 * is exactly the evidence ADR-035 §7 is missing.
 *
 * Reads the foreground handle + title only (`GetForegroundWindow` +
 * `GetWindowTextW`); it never enumerates windows, so the cost is two syscalls
 * per dispatch and zero when the diagnostic log is off.
 */
export function logDispatchSink(args: {
  sink: DispatchSink;
  tool: string;
  targetHwnd: bigint | null;
  tier?: "1" | "2" | "3" | "4";
}): void {
  if (!isDiagnosticLogEnabled()) return;
  try {
    const fgHwnd = getForegroundHwnd();
    let fgTitle = "";
    if (fgHwnd !== null) {
      try {
        fgTitle = getWindowTitleW(fgHwnd);
      } catch {
        // window died between the two calls — leave the title empty.
      }
    }
    const t = hashTitle(fgTitle);
    logDiagnostic({
      kind: "dispatch_sink",
      sink: args.sink,
      tool: args.tool,
      callId: currentCallId(),
      autoGuard: isAutoGuardEnabled(),
      targetHwnd: args.targetHwnd === null ? null : String(args.targetHwnd),
      fgHwnd: fgHwnd === null ? null : String(fgHwnd),
      fgTitleHash: t.hash,
      fgTitleLen: t.len,
      ...(rawTitlesEnabled() && { fgTitleRaw: fgTitle }),
      ...(args.tier !== undefined && { tier: args.tier }),
    });
  } catch {
    // Same contract as `logResolve` above — never throw into a dispatch path.
  }
}
