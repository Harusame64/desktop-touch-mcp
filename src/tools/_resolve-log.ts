/**
 * _resolve-log.ts — ADR-035 observation: how a `windowTitle` was resolved,
 * where the resulting input was actually dispatched (Phase 1), and how the
 * chosen window relates to this server's own process tree (Phase C-0, at the
 * bottom of the file).
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
 * **Nothing here changes where input goes.** Every export is write-only
 * observation: no call site picks a different window, refuses, or retries
 * because of anything in this file. The one caller-visible effect is the
 * Phase C-0 advisory at the bottom — a non-blocking `warnings` string on the
 * response, appended by handlers that call `drainTopologyWarnings()`.
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
import {
  getWindowTitleW,
  getForegroundHwnd,
  getWindowIdentity,
  readOwnConsoleWindow,
  buildProcessParentMap,
  getProcessIdentityByPid,
} from "../engine/win32.js";
import {
  isTerminalClassProcessName,
  isConsoleHostProcessName,
} from "../utils/terminal-process.js";
// The leaf module, NOT `_action-guard.js`: importing the guard here would close
// a cycle back through `action-target.ts` (Opus Round 3 P2).
import { isAutoGuardEnabled } from "../utils/auto-guard-env.js";

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

interface CallContext {
  callId: string;
  /**
   * ADR-035 Phase C-0 advisories raised during this tool call. Collected here
   * rather than returned from `logResolve` because the resolvers that raise
   * them (`findTerminalWindow`, `focusWindowForKeyboard`) sit several frames
   * below the handler that owns the response's `warnings` array; the handler
   * calls `drainTopologyWarnings()` on its way out.
   */
  topologyWarnings: string[];
  /**
   * Window handles already carrying a `topology_relation` record on this call.
   *
   * One tool call can resolve the same destination twice —
   * `terminal(action:'run')` resolves it, then calls the send handler, which
   * resolves it again — and both resolutions describe the SAME relation to the
   * same window. Recording it twice would make every `run` contribute two rows
   * to the distribution Phase C reads while every `send` contributes one, and
   * the plan's usual de-duplication advice (filter by resolver name) cannot
   * separate them: both are `findTerminalWindow` under one `callId`
   * (Opus Round 2 P1).
   */
  topologyRecorded: Set<string>;
}

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
  return _callAls.run(
    {
      callId: `c${process.pid}-${_callSeq}`,
      topologyWarnings: [],
      topologyRecorded: new Set<string>(),
    },
    fn,
  );
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
  /**
   * Pass a thunk when assembling the list costs something a disabled log must
   * not pay for — `action-target.ts` has to convert its handles back from
   * strings, for one. It is invoked only after the enabled check.
   */
  matches: ResolveWindowInput[] | (() => ResolveWindowInput[]);
  /** Defaults to `matches[0]`. */
  chosen?: ResolveWindowInput | null;
  /**
   * Set when the chosen window did NOT come from the primary title match —
   * see the field's documentation on `DiagnosticEvent`.
   */
  fallback?: ResolveFallback;
  /** Set when the resolver matched on an explicit handle, not on the title. */
  pinnedByHwnd?: boolean;
  identity?: IdentityMode;
  /**
   * ADR-035 Phase C-0. Set to `"write"` at the call sites where this resolution
   * is about to drive a native write, and only there — it is what turns on the
   * `topology_relation` record.
   *
   * Opt-IN rather than opt-out on purpose. `findTerminalWindow` is shared by
   * `terminal(action:'read')`, by `run`'s polling loop, and by the two send
   * paths; defaulting to "write" would put dozens of records per `run` into the
   * log for one window and let poll noise dominate the distribution Phase C is
   * supposed to read (Opus Round 1 P1). A new resolver stays silent until
   * somebody decides it is a write.
   */
  intent?: "write";
}): void {
  try {
    if (!isDiagnosticLogEnabled()) return;
    const identity = args.identity ?? "skip";
    const matches = typeof args.matches === "function" ? args.matches() : args.matches;
    const chosen = args.chosen !== undefined ? args.chosen : (matches[0] ?? null);
    const q = hashTitle(args.query);
    const chosenRecord = chosen === null ? null : toRecord(chosen, identity);
    logDiagnostic({
      kind: "resolve",
      resolver: args.resolver,
      callId: currentCallId(),
      autoGuard: isAutoGuardEnabled(),
      queryHash: q.hash,
      queryLen: q.len,
      ...(rawTitlesEnabled() && { queryRaw: args.query }),
      matchCount: matches.length,
      chosen: chosenRecord,
      others: matches
        .filter((w) => chosen === null || w.hwnd !== chosen.hwnd)
        .slice(0, OTHERS_LIMIT)
        .map((w) => toRecord(w, identity)),
      ...(args.fallback !== undefined && { fallback: args.fallback }),
      ...(args.pinnedByHwnd === true && { pinnedByHwnd: true }),
    });
    // ADR-035 Phase C-0 — second event, only for terminal-class destinations a
    // write is about to go to. Written after the resolve record so the two
    // always appear in that order for a given `callId`.
    if (args.intent === "write" && chosen !== null && chosenRecord !== null) {
      noteTopologyForResolve(args.resolver, chosen.hwnd, chosenRecord);
    }
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
  /**
   * Length of the character payload, for the sinks that send one character at a
   * time. `0` means the native call posts nothing at all, so no event is
   * written — `postCharsToHwnd` loops over the string and `keyboard.type("")`
   * emits no keystroke, and neither `text` nor `input` has a schema minimum, so
   * an empty write is reachable from a tool call (Opus Round 3 P1).
   *
   * Deliberately NOT passed by the sinks where an empty payload still performs
   * OS work: a clipboard paste still sends Ctrl+V, a foreground flash still
   * steals and restores the foreground, and `press` / `sequence` / `scroll`
   * have no character payload at all.
   */
  payloadChars?: number;
}): void {
  try {
    if (!isDiagnosticLogEnabled()) return;
    if (args.payloadChars === 0) return;
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

// ─── ADR-035 Phase C-0: topology measurement ─────────────────────────────────
//
// Phase C wants to refuse a write that lands in the operator's OWN session
// window. Three candidate predicates for "this window belongs to me" have died
// in a row (ancestor-PID chain, conhost parent PID, console identity — plan
// §3b), each on a topology assumption that measurement contradicted. So C-0
// ships no predicate at all: it records what the topology actually is, at
// startup and at every terminal-class write destination, and OQ-P4 gets decided
// on that data.
//
// Nothing here changes behaviour. The one caller-visible effect is a
// non-blocking advisory string, and it is deliberately NOT described as a
// safety feature anywhere user-facing: the stage-1 predicate is known to be
// wrong in both directions (Windows Terminal hosts unrelated windows in one
// process, so it over-fires; conhost is a sibling rather than an ancestor, so
// under a classic console it never fires at all).
//
// Cost, precisely (Opus Round 1 P2): a relation record adds NO per-window
// identity lookup — it reuses the one the resolve event already paid for. It is
// not free, though. The ancestor chain costs one process snapshot plus up to
// ANCESTRY_LIMIT identity reads, ONCE per process; the console-host branch
// costs one more process snapshot per PARENT_MAP_TTL_MS while terminal writes
// are flowing; a pid that hits the chain costs one identity read to rule out
// pid reuse; and a console-host destination costs two more, to tell its living
// parent from a reused pid. Four identity reads is the worst case per record.
// All of it is skipped when the log is off.

/** Cap on how far up the process tree the launch chain is walked. */
const ANCESTRY_LIMIT = 10;

/** How long a process parent map may be reused for the console-host lookup. */
const PARENT_MAP_TTL_MS = 5000;

interface AncestryInfo {
  chain: { pid: number; processName: string; startTimeMs: number }[];
  /**
   * pid → { creation time, depth }, for the chain above. A pid ALONE is not an
   * identity: an ancestor can exit while this server keeps running, and Windows
   * will hand its pid to something else — a terminal, eventually. Matching on
   * the pid only would then classify an unrelated window as "ours" for the rest
   * of the process lifetime and put false `ownerInAncestry` records into the
   * very data OQ-P4 is going to be decided on (Codex Round 1 P2).
   *
   * `depth` is 0 for this process, 1 for its parent, and so on — the "which
   * ancestor" the plan's C-0 log shape asks for (Opus Round 1 P1). Self and
   * grandparent are very different readings: a Windows Terminal several links
   * up hosts unrelated windows too, a hit on THIS process does not.
   */
  ancestors: Map<number, { startTimeMs: number; depth: number }>;
  /** `buildProcessParentMap` returned empty — it does that on failure, too. */
  unavailable: boolean;
  /**
   * The walk stopped early because a candidate parent was younger than its own
   * child, i.e. its pid had already been handed on. Everything above that point
   * is unknown, so an `ownerInAncestry: false` on this chain may be a false
   * negative.
   */
  truncatedAtRecycledPid: boolean;
  /**
   * The walk stopped because a link's creation time could not be read. Above
   * that point nothing can be verified, so the chain is short by construction
   * and an `ownerInAncestry: false` on it may be a false negative.
   */
  truncatedAtUnreadableLink: boolean;
  /**
   * The snapshot the chain was walked over. Held so the startup record's
   * conhost-child scan describes the SAME read as `processSnapshotUnavailable`
   * rather than a second, independent one (Opus Round 3 P2).
   *
   * Released once that scan has run — it is a full process table and this is
   * its only reader, so keeping it for the life of the server would hold
   * hundreds of entries for a value used once (Opus Round 5 P3).
   */
  parentMap: Map<number, number> | null;
}

/** How an owning pid compares against the cached ancestor chain. */
type AncestryVerdict =
  /** Not in the chain at all. */
  | "no"
  /** In the chain, and the process creation time still matches. */
  | "yes"
  /**
   * In the chain by pid, but the creation times could not be compared —
   * `getProcessIdentityByPid` reports 0 when the read fails. Deliberately NOT
   * folded into "no": for a measurement slice, "we could not tell" is a
   * distinct reading from "it is not an ancestor", and Phase C needs to know
   * how often it happens before it builds a predicate on top.
   */
  | "unverified"
  /** In the chain by pid, but the creation time says it is a different process. */
  | "recycled";

function classifyAncestry(anc: AncestryInfo, pid: number): AncestryVerdict {
  const known = anc.ancestors.get(pid);
  if (known === undefined) return "no";
  const now = getProcessIdentityByPid(pid).processStartTimeMs;
  if (known.startTimeMs === 0 || now === 0) return "unverified";
  return known.startTimeMs === now ? "yes" : "recycled";
}

let _ancestry: AncestryInfo | null = null;
let _ancestryAtMs = 0;
let _ancestryAttempts = 0;
/** Set once the startup scan has run — the only reader of `AncestryInfo.parentMap`. */
let _startupScanDone = false;
let _ownConsoleWindow: { available: boolean; hwnd: bigint | null } | null = null;
let _ownConsoleWindowAtMs = 0;
let _parentMap: Map<number, number> | null = null;
/** When the cached map was last read SUCCESSFULLY. */
let _parentMapAtMs = 0;
/** When a read was last ATTEMPTED, successfully or not. */
let _parentMapTriedAtMs = 0;

/**
 * How long to wait before re-attempting an ancestry read that came back empty.
 * A successful chain is cached for the process lifetime; a FAILED one must not
 * be, or one unlucky snapshot at startup stamps `ancestryUnavailable` on every
 * record for a server that then runs for days (Opus Round 2 P2).
 */
const ANCESTRY_RETRY_MS = 30_000;

/**
 * How many times an incomplete chain is rebuilt before it is accepted as the
 * best reading available. Bounds the permanently-unreadable case.
 */
const ANCESTRY_MAX_ATTEMPTS = 3;

/** How long to wait before re-asking for a console handle that could not be read. */
const CONSOLE_WINDOW_RETRY_MS = 30_000;

/**
 * This process's launch chain, computed once. The chain is a launch-time fact
 * — an ancestor exiting later does not move a window from "mine" to "not mine"
 * — so it is cached for the life of the process rather than re-snapshotted.
 */
function ancestry(): AncestryInfo {
  const cached = _ancestry;
  if (cached !== null) {
    // A chain that was read successfully is a launch-time fact and never
    // re-read. One that failed is retried, slowly — and "failed" includes a
    // chain that came out of a good snapshot but has an unreadable creation
    // time on ANY link, not just on this process. That link's pid can never be
    // verified, so every destination it owns would be classified `unverified`
    // for the life of the server, silencing the advisory and skewing the
    // measurement (Codex Round 3 P2).
    //
    // The checks are ordered cheapest-first so a complete chain — the normal
    // case, on every single record — costs one array scan and nothing else.
    const hasUnreadableLink = cached.chain.some((p) => p.startTimeMs === 0);
    if (!cached.unavailable && !hasUnreadableLink) return cached;
    // It also has to CONVERGE. A link can be permanently unreadable — an
    // ancestor that has since exited, or an elevated one `OpenProcess` will
    // never open — and rebuilding the chain every retry window forever, for a
    // read that cannot succeed, is not measurement (Opus Round 4 P2). So the
    // rebuild gives up after a few attempts, and an unreadable creation time
    // only counts as retriable while that pid is still in the process table.
    if (_ancestryAttempts >= ANCESTRY_MAX_ATTEMPTS) return cached;
    if (Date.now() - _ancestryAtMs <= ANCESTRY_RETRY_MS) return cached;
    if (!cached.unavailable) {
      const map = freshParentMap();
      if (!cached.chain.some((p) => p.startTimeMs === 0 && map.has(p.pid))) {
        // Every unreadable link belongs to a process that has left the table, so
        // there is nothing to come back for. Stamp the clock anyway: without it
        // the time gate above never trips again and this branch — which costs a
        // process snapshot every cache interval — is re-entered on every single
        // record for the life of the server (Opus Round 5 P2). The launching
        // shell exiting and orphaning the server is the ordinary case.
        _ancestryAtMs = Date.now();
        return cached;
      }
    }
  }
  _ancestryAttempts += 1;
  // The SAME snapshot the console-host branch and the startup record use.
  // (Continues below.)
  // They used to take two independent ones, which let the startup record assert
  // "this process owns no console host child" out of a failed read while
  // reporting `processSnapshotUnavailable:false` from a successful one
  // (Opus Round 3 P2 — revising its own Round 2 "leave the two snapshots").
  const parentMap = freshParentMap();
  const chain: AncestryInfo["chain"] = [];
  const ancestors = new Map<number, { startTimeMs: number; depth: number }>();
  let truncatedAtRecycledPid = false;
  let truncatedAtUnreadableLink = false;
  let pid = process.pid;
  let childStartTimeMs = 0;
  for (let depth = 0; depth < ANCESTRY_LIMIT; depth++) {
    if (ancestors.has(pid)) break; // a cycle in the snapshot; stop rather than spin
    const ident = getProcessIdentityByPid(pid);
    // A parent starts before its child. If this candidate did not, the pid it
    // was reached by belongs to a process that has since exited and been
    // replaced — Toolhelp still reports the historical parent pid, and walking
    // into the replacement would cache an unrelated process AS an ancestor.
    // Every later check would then agree with itself and log terminals that
    // process owns as `ownerInAncestry:true`, advisory and all. This is the
    // reuse that happens BEFORE the chain is cached; `classifyAncestry` covers
    // the one that happens after (Codex Round 4 P2).
    if (
      depth > 0 &&
      childStartTimeMs !== 0 &&
      ident.processStartTimeMs !== 0 &&
      ident.processStartTimeMs > childStartTimeMs
    ) {
      truncatedAtRecycledPid = true;
      break;
    }
    ancestors.set(pid, { startTimeMs: ident.processStartTimeMs, depth });
    chain.push({
      pid,
      processName: ident.processName,
      startTimeMs: ident.processStartTimeMs,
    });
    // An unreadable creation time ends the walk. The link itself stays in the
    // chain — `classifyAncestry` can only ever call it `"unverified"`, which is
    // the honest answer — but everything ABOVE it is not verifiable at all: the
    // parent-vs-child comparison that catches a reused pid has nothing to
    // compare against, so a replacement process and ITS readable ancestors
    // would be cached as verified ancestors of ours (Codex Round 6).
    if (ident.processStartTimeMs === 0) {
      truncatedAtUnreadableLink = true;
      break;
    }
    childStartTimeMs = ident.processStartTimeMs;
    const parent = parentMap.get(pid);
    // pid 0 is the idle process — the documented top of the tree, not a parent.
    if (parent === undefined || parent === 0) break;
    pid = parent;
  }
  _ancestry = {
    chain,
    ancestors,
    unavailable: parentMap.size === 0,
    truncatedAtRecycledPid,
    truncatedAtUnreadableLink,
    // Only worth holding until the startup scan has read it. A rebuild after
    // that would otherwise hang a fresh full process table on the cache that
    // nothing ever reads or frees (Opus Round 6 P3).
    parentMap: _startupScanDone ? null : parentMap,
  };
  _ancestryAtMs = Date.now();
  return _ancestry;
}

/** `GetConsoleWindow()` for this process, read once (it cannot change). */
function ownConsoleWindow(): { available: boolean; hwnd: bigint | null } {
  // Only a SUCCESSFUL read is cached indefinitely. `available:false` is usually
  // permanent (an older `.node` has no binding) but can also be a native-load
  // race at startup, and this is the one reading the whole slice exists to
  // collect — so it is asked again rather than written off for the life of the
  // process. Throttled, because the failure can be a THROWN exception rather
  // than a missing property, and one of those per record is not free.
  const cached = _ownConsoleWindow;
  if (cached !== null && cached.available) return cached;
  const now = Date.now();
  if (cached !== null && now - _ownConsoleWindowAtMs <= CONSOLE_WINDOW_RETRY_MS) return cached;
  _ownConsoleWindowAtMs = now;
  _ownConsoleWindow = readOwnConsoleWindow();
  return _ownConsoleWindow;
}

/**
 * A process parent map no older than {@link PARENT_MAP_TTL_MS}. Unlike the
 * ancestry above this one has to be reasonably fresh — it answers "is the
 * console host's parent still alive", and the whole point of the question is
 * that the parent may have exited (`launch_console classic` reparents through a
 * `cmd.exe` that dies immediately, plan §3b Round 6 P1-A).
 */
function freshParentMap(): Map<number, number> {
  const now = Date.now();
  const cached = _parentMap;
  // Age the cache from the last SUCCESS when it holds one, and from the last
  // ATTEMPT when it does not: `_parentMapAtMs` is deliberately not advanced by a
  // failed read, so measuring a failed cache against it would make every record
  // re-snapshot a process API that is currently failing (Opus Round 3 P2).
  const since = cached !== null && cached.size > 0 ? _parentMapAtMs : _parentMapTriedAtMs;
  if (cached !== null && now - since <= PARENT_MAP_TTL_MS) return cached;
  _parentMapTriedAtMs = now;
  const fresh = buildProcessParentMap();
  _parentMap = fresh;
  // Only a snapshot that actually read something counts as fresh. Stamping an
  // empty one would mark up to a full TTL of records `parentMapUnavailable` on
  // the strength of a single transient failure (Opus Round 2 P2).
  if (fresh.size > 0) _parentMapAtMs = now;
  return fresh;
}

/** @internal Test-only — drop the process-topology caches. */
export function _resetTopologyCachesForTest(): void {
  _ancestry = null;
  _ancestryAtMs = 0;
  _ancestryAttempts = 0;
  _startupScanDone = false;
  _ownConsoleWindow = null;
  _ownConsoleWindowAtMs = 0;
  _parentMap = null;
  _parentMapAtMs = 0;
  _parentMapTriedAtMs = 0;
}

/**
 * Write the one-shot startup topology snapshot. Called from `server-windows.ts`
 * after the CLI `--help` exit and before the transport connects, so it lands in
 * the log before any tool call can.
 *
 * Costs one process snapshot, up to {@link ANCESTRY_LIMIT} identity reads for
 * the chain, and one more per child of this process for the console-host scan —
 * once. Returns immediately when the diagnostic log is off.
 */
export function logTopologySnapshot(): void {
  try {
    if (!isDiagnosticLogEnabled()) return;
    const anc = ancestry();
    const own = ownConsoleWindow();
    // The Round 7 circumstantial evidence, measured directly: a process that
    // INHERITED its parent's console does not spawn its own host, so a conhost
    // child is the sign that this server holds a console of its own and the
    // session's console window is somebody else's window.
    let hostPid: number | null = null;
    let hostName: string | undefined;
    // A child whose image name could not be read is not evidence of "no console
    // host child" — and this is the decisive datum the slice exists to collect,
    // so a partial scan says so rather than reporting a clean negative
    // (Opus Round 4 P2). The map can also be a few seconds stale, so a child
    // that has since exited reads as unreadable too.
    let unreadableChildren = 0;
    for (const [pid, parentPid] of anc.parentMap ?? []) {
      if (parentPid !== process.pid) continue;
      const name = getProcessIdentityByPid(pid).processName;
      if (name === "") {
        unreadableChildren += 1;
        continue;
      }
      if (isConsoleHostProcessName(name)) {
        hostPid = pid;
        hostName = name;
        break;
      }
    }
    logDiagnostic({
      kind: "topology_snapshot",
      consoleWindow: own.hwnd === null ? null : String(own.hwnd),
      ...(own.available === false && { consoleWindowUnavailable: true }),
      ownConsoleHostChildPid: hostPid,
      ...(hostName !== undefined && { ownConsoleHostChildName: hostName }),
      ...(hostPid === null && unreadableChildren > 0 && {
        ownConsoleHostChildScanIncomplete: unreadableChildren,
      }),
      ancestry: anc.chain,
      launchPath: anc.chain.map((p) => p.processName || "pid:" + String(p.pid)).join(" < "),
      processSnapshotUnavailable: anc.unavailable,
      ...(anc.truncatedAtRecycledPid && { ancestryTruncatedAtRecycledPid: true }),
      ...(anc.truncatedAtUnreadableLink && { ancestryTruncatedAtUnreadableLink: true }),
    });
    // The scan above is this map's only reader. See `AncestryInfo.parentMap`.
    anc.parentMap = null;
    _startupScanDone = true;
  } catch {
    // Same contract as the loggers above: measurement never crashes startup.
  }
}

/**
 * Queue the stage-1 advisory on the current call. Returns whether there was a
 * call to queue it on — outside a wrapped handler there is not, and the
 * `advisoryQueued` field on the log record then says so rather than implying a
 * string somebody could have read.
 *
 * Idempotent: the same advisory raised twice in one call (a `run` that sends
 * repeatedly into the same window) is stored once.
 */
function pushTopologyWarning(processName: string, pid: number): boolean {
  const store = _callAls.getStore();
  if (store === undefined) return false;
  const who = processName === "" ? "pid " + String(pid) : processName;
  const text =
    "Destination window is owned by " + who + " (pid " + String(pid) +
    "), which is this server process or one of its ancestors — it may be the " +
    "session you are driving. Observation only; nothing was blocked.";
  if (!store.topologyWarnings.includes(text)) store.topologyWarnings.push(text);
  return true;
}

/** What became of the process that spawned a console host. */
type ConsoleHostParentState =
  /** Still in the process table, and it predates the host — so it is the parent. */
  | "alive"
  /** Not in the process table: it has exited. */
  | "gone"
  /**
   * In the process table, but it started AFTER the console host it supposedly
   * spawned — impossible, so Windows has handed the dead parent's pid to
   * something else. Reporting this as "alive" would corrupt exactly the
   * parent-lifetime data Phase C is collecting (Codex Round 2 P2).
   */
  | "recycled"
  /** In the process table, but a creation time could not be read on one side. */
  | "unverified";

/**
 * Decide what happened to a console host's parent. Presence in the snapshot is
 * necessary but NOT sufficient: `launch_console classic` reparents through a
 * `cmd.exe` that exits immediately, and a pid freed that early is a prime
 * candidate for reuse. A parent that started after its own child is the
 * signature of that reuse.
 *
 * Read `parentMapAgeMs` alongside the result — the snapshot can be up to the
 * cache TTL old, so "alive" means "alive as of that many ms ago".
 */
function classifyConsoleHostParent(
  map: Map<number, number>,
  hostPid: number,
  parentPid: number,
): ConsoleHostParentState {
  if (!map.has(parentPid)) return "gone";
  const hostStart = getProcessIdentityByPid(hostPid).processStartTimeMs;
  const parentStart = getProcessIdentityByPid(parentPid).processStartTimeMs;
  if (hostStart === 0 || parentStart === 0) return "unverified";
  return parentStart <= hostStart ? "alive" : "recycled";
}

/**
 * Record how the window a write resolver chose relates to this server process.
 *
 * Emitted for every terminal-class destination, hit or miss. Gating it on the
 * stage-1 predicate would collect nothing at all under a classic console, where
 * `conhost.exe` is a SIBLING of the shell rather than an ancestor (ADR-035 §6.2
 * measurement) — and that is precisely the configuration Phase C has no data
 * for (Round 14 Codex).
 */
function logTopologyRelation(
  resolver: ResolveResolver,
  hwnd: bigint,
  pid: number,
  processName: string,
): void {
  const anc = ancestry();
  const ownerVerdict = classifyAncestry(anc, pid);
  const ownerInAncestry = ownerVerdict === "yes";
  const ownerIsConsoleHost = isConsoleHostProcessName(processName);

  let consoleHostParentPid: number | null | undefined;
  let consoleHostParentState: ConsoleHostParentState | undefined;
  let consoleHostParentVerdict: AncestryVerdict | undefined;
  let parentMapUnavailable: boolean | undefined;
  let parentMapAgeMs: number | undefined;
  if (ownerIsConsoleHost) {
    const map = freshParentMap();
    parentMapUnavailable = map.size === 0;
    parentMapAgeMs = Date.now() - _parentMapAtMs;
    // A parent read out of an EMPTY snapshot is not "no parent" — it is "we
    // could not look". `buildProcessParentMap` reports both the same way, so
    // the flag above is what keeps a failed read out of the Phase C tally.
    const parent = parentMapUnavailable ? undefined : map.get(pid);
    consoleHostParentPid = parentMapUnavailable ? undefined : (parent ?? null);
    if (parent !== undefined) {
      consoleHostParentState = classifyConsoleHostParent(map, pid, parent);
      consoleHostParentVerdict = classifyAncestry(anc, parent);
    }
  }

  const own = ownConsoleWindow();

  logDiagnostic({
    kind: "topology_relation",
    resolver,
    callId: currentCallId(),
    autoGuard: isAutoGuardEnabled(),
    targetHwnd: String(hwnd),
    ownerPid: pid,
    ownerProcessName: processName,
    ownerInAncestry,
    // Which ancestor — 0 is this very process, 1 its parent. Absent when the
    // pid is not a verified ancestor.
    ...(ownerInAncestry && { ancestryDepth: anc.ancestors.get(pid)!.depth }),
    // Only when the pid hit the chain but the answer is not a plain "yes".
    ...(ownerVerdict === "unverified" || ownerVerdict === "recycled"
      ? { ancestryPidHit: ownerVerdict }
      : {}),
    // The ancestor chain itself came out of a snapshot that may have failed —
    // in which case it is just this process and EVERY `ownerInAncestry:false`
    // here is a read failure, not a negative result. Carried per record because
    // the startup snapshot that also reports it may be many hours away in the
    // log (Opus Round 1 P1).
    ancestryUnavailable: anc.unavailable,
    ...(anc.truncatedAtRecycledPid && { ancestryTruncatedAtRecycledPid: true }),
    ...(anc.truncatedAtUnreadableLink && { ancestryTruncatedAtUnreadableLink: true }),
    ownerIsConsoleHost,
    ...(parentMapUnavailable === true && { parentMapUnavailable: true }),
    // Only when a snapshot was actually read. `_parentMapAtMs` is deliberately
    // not advanced on a failed read, so emitting the age unconditionally would
    // describe a snapshot no longer in use — or, before any read succeeded,
    // report the process data as decades old (Opus Round 3 P1).
    ...(parentMapUnavailable === false && parentMapAgeMs !== undefined && { parentMapAgeMs }),
    ...(consoleHostParentPid !== undefined && { consoleHostParentPid }),
    ...(consoleHostParentState !== undefined && { consoleHostParentState }),
    ...(consoleHostParentVerdict !== undefined && {
      consoleHostParentInAncestry: consoleHostParentVerdict === "yes",
    }),
    // Same reason the owner side carries `ancestryPidHit`: without it a read
    // failure and a detected pid reuse are indistinguishable from an actual
    // negative — and this is the conhost configuration Phase C has the least
    // data for (Opus Round 4 P1).
    ...(consoleHostParentVerdict === "unverified" || consoleHostParentVerdict === "recycled"
      ? { consoleHostParentPidHit: consoleHostParentVerdict }
      : {}),
    isOwnConsoleWindow: own.hwnd !== null && own.hwnd === hwnd,
    // `isOwnConsoleWindow:false` is only a negative RESULT when the console
    // handle could be read at all — an older `.node` without the binding, or a
    // failed call, produces the same false (Opus Round 2 P1).
    ...(own.available === false && { consoleWindowUnavailable: true }),
    // The stage-1 instrument. `ownerInAncestry` IS the predicate — this field
    // only says whether there was a tool call to hang the advisory on.
    advisoryQueued: ownerInAncestry ? pushTopologyWarning(processName, pid) : false,
  });
}

/**
 * The C-0 hook on a resolve event tagged `intent: "write"`: when it landed on a
 * terminal-class window whose owner is already known, record how that window
 * relates to this process.
 *
 * **Identity is never looked up here.** Phase 1 made process identity a
 * per-site opt-in precisely because `getWindowIdentity` is an `OpenProcess` +
 * `QueryFullProcessImageName` round-trip, and only the write paths pay it
 * (plan §2, "実装で確定した事実" 3). Reusing that opt-in as the second gate
 * means the relation record costs no extra per-window lookup — including on the
 * `findTerminalWindow` process-name rescue, the H2 path, which hands the
 * identity in on `chosen`.
 *
 * The write sites that stay silent are the ones Phase 1 left at
 * `identity: "skip"` — `inputPipelineCase3` (the scroll destination) and
 * `actionTarget` (click) — plus `smartScrollImage`, which pays for identity but
 * is not tagged. None of the three is in Phase C's refusal scope, which is
 * terminal `send` / `run` (plan §3b), so OQ-P4 does not need them; instrumenting
 * click would put an `OpenProcess` on every one.
 */
function noteTopologyForResolve(
  resolver: ResolveResolver,
  hwnd: bigint,
  record: ResolveWindowRecord,
): void {
  const pid = record.pid;
  const processName = record.processName;
  if (pid === undefined || processName === undefined) return;
  if (!isTerminalClassProcessName(processName)) return;
  // One record per (call, destination) — see `topologyRecorded`. Outside a
  // wrapped handler there is no call to scope it to, so nothing is suppressed.
  const store = _callAls.getStore();
  if (store !== undefined) {
    const key = String(hwnd);
    if (store.topologyRecorded.has(key)) return;
    store.topologyRecorded.add(key);
  }
  logTopologyRelation(resolver, hwnd, pid, processName);
}

/**
 * Append the advisories raised during this tool call to `warnings`, skipping
 * any that are already in it. No-op outside a wrapped handler, so a call site
 * never has to check.
 *
 * **Non-destructive on purpose.** An earlier draft spliced the queue empty, and
 * that broke the two shapes this tool surface actually has: a handler with
 * several successful return branches surfaced the advisory on one of them and
 * silently dropped it on the others, and `terminal(action:'run')` — which calls
 * the send handler internally and keeps only `ok` / `code` from its result —
 * consumed the advisory in the inner call so the outer response never carried
 * it (Codex Round 1 P2, both). Leaving the queue in place lets every branch and
 * every nesting level ask, and the de-duplication here keeps a doubled ask from
 * doubling the string.
 */
export function appendTopologyWarnings(warnings: string[]): void {
  try {
    const store = _callAls.getStore();
    if (store === undefined) return;
    for (const w of store.topologyWarnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  } catch {
    // Same contract as every other export here: this sits on response paths
    // that could not fail at this point before C-0 existed.
  }
}
