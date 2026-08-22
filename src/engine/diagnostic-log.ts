/**
 * diagnostic-log.ts — append-only JSONL diagnostic event log (issue #365).
 *
 * Captures runtime events that are normally invisible to external samplers so
 * that post-hoc grep can answer:
 *   - why did the MCP process disappear? (`exit` + `uncaught` events)
 *   - which tool was running when the fan kicked in? (`slow_tool` + `cpu_spike`)
 *   - is the perception drain backlog growing? (`drain_oversize`)
 *
 * Design:
 *   - sync append (`appendFileSync`) so events written just before `process.exit`
 *     are not lost in Node's writable-stream buffer
 *   - best-effort: every write is wrapped in try/catch and never throws to the
 *     caller — diagnostic logging must not become a new crash source
 *   - env overrides:
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH    — override default path
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE — set to "1" to disable entirely
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

const DEFAULT_FILENAME = "diagnostic.log";
const DEFAULT_DIR = ".desktop-touch-mcp/logs";

// Review R1 P2-3: cap stack trace size so a runaway stack doesn't write MB-
// scale records and slow down a synchronous appendFileSync just before exit.
// Review R2 P3 (Opus): named CHARS not BYTES — `slice` / `.length` are UTF-16
// code-unit operations, not byte counts. For ASCII stacks this is bit-equal;
// stack frames with multi-byte path chars (Japanese / emoji) will be capped
// by char count not byte count. Acceptable for the diagnostic goal (we only
// need bounded record size, not exact byte truncation).
const STACK_TRUNCATE_CHARS = 4096;

/**
 * `_disabled`, `_resolvedPath`, and `_dirEnsured` are memoized on first read.
 *
 * **Runtime mutation contract**: the `DESKTOP_TOUCH_DIAGNOSTIC_LOG_*` env vars
 * are read once at first log site and cached for the process lifetime. Changing
 * them mid-process has no effect. This matches how the rest of the server
 * resolves env (process-health.ts / nativeEventsEnabled) and avoids a per-write
 * env lookup hit on the hot path. Tests use `_resetDiagnosticLogForTest()` to
 * force a re-read.
 */
let _resolvedPath: string | null = null;
let _disabled: boolean | null = null;
let _dirEnsured = false;

function isDisabled(): boolean {
  if (_disabled === null) {
    _disabled = process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE === "1";
  }
  return _disabled;
}

/**
 * True when diagnostic events are being written. Exposed so observation-only
 * producers (ADR-035 Phase 1's `_resolve-log.ts`) can skip hashing and Win32
 * reads entirely on a disabled log rather than building a record `logDiagnostic`
 * would immediately drop.
 */
export function isDiagnosticLogEnabled(): boolean {
  return !isDisabled();
}

export function getDiagnosticLogPath(): string {
  if (_resolvedPath !== null) return _resolvedPath;
  const override = process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH;
  if (override && override.length > 0) {
    _resolvedPath = override;
  } else {
    _resolvedPath = join(homedir(), DEFAULT_DIR, DEFAULT_FILENAME);
  }
  return _resolvedPath;
}

function ensureDir(path: string): void {
  if (_dirEnsured) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    _dirEnsured = true;
  } catch {
    // best-effort; appendFileSync below will surface the real error if any
  }
}

export type DiagnosticEvent =
  | {
      kind: "exit";
      trigger: string;
      exitCode: number;
      inflight: number;
      shutdownPending: boolean;
      extra?: Record<string, unknown>;
    }
  | {
      kind: "uncaught";
      type: "uncaughtException" | "unhandledRejection";
      name?: string;
      msg: string;
      stack?: string;
    }
  | {
      kind: "slow_tool";
      tool: string;
      elapsed_ms: number;
      args_size: number;
    }
  | {
      kind: "cpu_spike";
      cpu_pct: number;
      window_ms: number;
      rss_mb: number;
      inflight: number;
      lastRpcMethod: string | null;
    }
  | {
      kind: "drain_oversize";
      batch_size: number;
      overflow: boolean;
    }
  | {
      kind: "dormancy_transition";
      state: "enter" | "exit";
      // For "enter": idle_ms = elapsed since lastRpc that triggered the stop.
      // For "exit": elapsed_ms = wall-clock cost of the wake (sidecar spawn etc).
      idle_ms?: number;
      elapsed_ms?: number;
      inflight: number;
    }
  | {
      // ADR-030 Phase 1 (plan §3.2): failsafe observability. `x`/`y` are the
      // trigger coordinates (ADR OQ1 — was it a negative-band trigger?).
      kind: "failsafe";
      // "exit_averted": the watcher was about to exit, but the last active
      // tool call finished during the pre-exit notify await, so it stood down.
      event: "triggered" | "armed_idle" | "ghost_zone_notice" | "exit_averted";
      origin?: "watcher" | "per-tool" | "background";
      x: number;
      y: number;
      holdMs: number;
      // Watcher trigger only: the number of tool handlers that passed the
      // failsafe pre-check and are still executing (the watcher exit gate's
      // input). DELIBERATELY not named `inflight` — the `kind:"exit"` field
      // of that name counts transport-level requests (refused calls
      // included), a different semantics (plan Round 5 Opus P2).
      activeToolCalls?: number;
    }
  | {
      // ADR-031 §2(c) — screen / region capture. The two callers that reach
      // the capture choke point through a `catch {}` (ui-elements' text-only
      // continuation, workspace's missing thumbnail) swallow the failure
      // entirely, so this record is the only place a typed reason survives.
      // It is written UPSTREAM of those catches, which is why it is part of
      // the choke point rather than of the callers.
      kind: "capture";
      // "backend_selected": the once-per-process backend choice, so a capture
      //   can be attributed to a pixel source afterwards (ADR-031 §4.4).
      // "backend_override_ignored": DESKTOP_TOUCH_CAPTURE_BACKEND named a
      //   backend that does not exist; the choice fell through to capability.
      // "bounds_unknown": no bounds could be established by ANY route, so the
      //   requested rectangle was passed through unchecked (fail-open, warn
      //   once). Written where failing open becomes final — after the nut.js
      //   fallback below has been tried and failed — so it never describes a
      //   capture that was in fact checked.
      // "bounds_from_nutjs": monitor enumeration was unavailable (a build with
      //   no native addon), so the primary-monitor bounds came from the nut.js
      //   backend instead — the limitation is still enforced, not failed open.
      // "region_rejected": the rectangle is outside what this backend can
      //   capture — refused before the backend was called.
      // "backend_failed": the backend (or the primary-rectangle lookup the
      //   full-screen path needs) threw; surfaced as CaptureBackendFailed.
      event:
        | "backend_selected"
        | "backend_override_ignored"
        | "bounds_unknown"
        | "bounds_from_nutjs"
        | "region_rejected"
        | "backend_failed";
      /** The pixel source this process uses — `gdi-bitblt` or `nutjs`. */
      backend: string;
      /** What decided the backend: capability probe or the env override. */
      determinant?: string;
      /** The rectangle the caller asked for; absent for full-screen captures. */
      region?: { x: number; y: number; width: number; height: number };
      /** Which boundary the request was judged against, when it was judged. */
      bounds?: string;
      /**
       * How strictly it was judged: `contain` for a rectangle the caller named,
       * `overlap` for one Windows produced (a window's own screen rect, which
       * may legitimately run past the monitor edge).
       */
      mode?: string;
      /** Typed reason / underlying message. */
      reason?: string;
    }
  | {
      // ADR-038 Phase 0 — counter for destination-less keyboard writes.
      // Written at the ONE observation point that sits before the
      // lensId / auto-guard branch split (`assertKeyboardDestination` in
      // `_action-guard.ts`), so the count covers the lens path too — the
      // branch that used to skip `runActionGuard` entirely.
      //
      // Emitted for EVERY destination-less call, including the ones this
      // build lets through (`decision:"unguarded"` / `"warn"`), so dogfood
      // can weigh legitimate destination-less usage against the refusals.
      kind: "destination_missing";
      /** `keyboard:type` / `keyboard:press` / `keyboard:sequence`. */
      tool: string;
      /** True when a lensId was passed — the exclusive branch ADR-038 closes. */
      hasLens: boolean;
      /**
       * True when the caller DID pass an `hwnd`. Recorded but not decisive: a
       * handle that resolves to a titleless, non-foreground window is still not
       * a reachable destination (see `keyboardDestinationMiss`), and telling the
       * two apart in the sample is the point of `reason`.
       */
      hadHwndParam: boolean;
      // "no_destination":                 neither windowTitle nor a resolvable hwnd.
      // "titleless_hwnd_not_foreground":  a window resolved, but it has no title
      //   and is not in the foreground, so neither focus nor the guard can steer
      //   the keys to it.
      reason: "no_destination" | "titleless_hwnd_not_foreground";
      // "block":      refused with DestinationRequired (the default).
      // "warn":       DESKTOP_TOUCH_REQUIRE_DESTINATION=0 downgraded it.
      // "unguarded":  DESKTOP_TOUCH_AUTO_GUARD=0 killed the whole guard layer.
      decision: "block" | "warn" | "unguarded";
    }
  | {
      // ADR-035 Phase 1 — one title-to-window resolution (`src/tools/_resolve-log.ts`).
      // Written by every resolver in the ADR-035 §2 known set so the discarded
      // half of a resolution (how many windows matched, which ones lost) is
      // recoverable after the fact. Titles are hashed by default — see the PII
      // note in `_resolve-log.ts`.
      kind: "resolve";
      resolver: ResolveResolver;
      /** Per-tool-call correlation id; null outside a wrapped handler. */
      callId: string | null;
      /** `DESKTOP_TOUCH_AUTO_GUARD` state at resolution time (plan §2, parent §7-4). */
      autoGuard: boolean;
      queryHash: string;
      queryLen: number;
      /** Only when `DESKTOP_TOUCH_RESOLVE_LOG_RAW=1`. */
      queryRaw?: string;
      /** Total matches, INCLUDING the chosen one. `>= 2` is the H1 signal. */
      matchCount: number;
      /**
       * True when the caller supplied an explicit `hwnd` and the resolver
       * matched on the HANDLE, not on the title. `queryHash` still carries the
       * `windowTitle` that came along for focus / warning purposes, so without
       * this flag an hwnd-pinned call is indistinguishable in the log from a
       * clean single title match — which would deflate the measured H1 rate
       * (Opus Round 2 P2).
       */
      pinnedByHwnd?: boolean;
      chosen: ResolveWindowRecord | null;
      /** Runners-up, capped at 5. */
      others: ResolveWindowRecord[];
      /**
       * Present only when the match came from `findTerminalWindow`'s
       * process-name fallback rather than a title match — the direct
       * observation of the zero-match H2 sub-path (ADR-035 §2.1).
       */
      /**
       * Set when the chosen window did NOT come from the primary title match.
       * `process-name`: `findTerminalWindow` fell back to matching the image
       * name after zero title matches (ADR-035 §2.1). `owner-chain`:
       * `resolveWindowTarget` found no plain top-level window and resolved a
       * common dialog through the owner chain instead. Both are the shape H2
       * is about — a window was chosen that the title rule did not select.
       */
      fallback?: ResolveFallback;
    }
  | {
      // ADR-035 Phase 1 — one native input dispatch, recorded immediately
      // before the call leaves the process. Joined to its `resolve` event by
      // `callId`; without both halves the zero-match H2 case has no evidence
      // (plan §2, Round 13 Codex).
      kind: "dispatch_sink";
      sink: DispatchSink;
      /** `keyboard:type` / `terminal:send` / `scroll` / … */
      tool: string;
      callId: string | null;
      autoGuard: boolean;
      /** Where the write was addressed; null for sinks with no handle. */
      targetHwnd: string | null;
      /** Foreground window at dispatch time — the H2 discriminator. */
      fgHwnd: string | null;
      fgTitleHash: string;
      fgTitleLen: number;
      /** Only when `DESKTOP_TOUCH_RESOLVE_LOG_RAW=1`. */
      fgTitleRaw?: string;
      /** ADR-018 dispatcher tier, for the scroll sinks that have one. */
      tier?: "1" | "2" | "3" | "4";
    }
  | {
      // ADR-035 Phase C-0 — written ONCE at server start.
      //
      // Phase C has to answer "is the window the caller named the console this
      // server itself is talking through?", and every candidate predicate so
      // far died on an unverified assumption about process topology (plan §3b:
      // ancestor-PID chain, conhost parent PID, console identity — three in a
      // row). This record is the measurement that replaces the assumption:
      // what `GetConsoleWindow()` actually returns here, whether this process
      // owns its own console host as a CHILD (the Round 7 circumstantial
      // evidence that it does NOT share the session console), and the launch
      // chain above it.
      //
      // Measurement only — nothing branches on it, and it is deliberately not
      // described as a safety feature anywhere user-facing.
      kind: "topology_snapshot";
      /** `GetConsoleWindow()` as a decimal handle string; null when unattached. */
      consoleWindow: string | null;
      /**
       * The console handle could not be read at all — the binding is missing
       * from an older `.node`, or the call failed. `consoleWindow: null` then
       * says nothing about whether this process has a console.
       */
      consoleWindowUnavailable?: boolean;
      /** pid of a `conhost` / `OpenConsole` CHILD of this process, or null. */
      ownConsoleHostChildPid: number | null;
      /** Image name of that child, when one was found. */
      ownConsoleHostChildName?: string;
      /**
       * This process first, then its ancestors, capped at 10 links.
       * `startTimeMs` is what makes an entry an IDENTITY rather than a pid: an
       * ancestor can exit and have its pid handed to something else, and a
       * later `topology_relation` compares creation times before calling a
       * window's owner an ancestor (Codex Round 1 P2). `0` means the read
       * failed.
       */
      ancestry: { pid: number; processName: string; startTimeMs: number }[];
      /** `ancestry` image names joined by " < " — the launch path, best-effort. */
      launchPath: string;
      /**
       * True when `buildProcessParentMap` came back empty, which it also does
       * on failure (`win32.ts` swallows). The ancestry above is then just this
       * process, and a reader must NOT take "no ancestors" at face value.
       */
      processSnapshotUnavailable: boolean;
    }
  | {
      // ADR-035 Phase C-0 — how one write destination relates to this server.
      //
      // Written UNCONDITIONALLY for every terminal-class window a write-side
      // resolver picked, not only for the ones that look like a self-hit. The
      // stage-1 predicate (owner pid in our ancestor chain) is structurally
      // incapable of firing under a conhost session host — conhost is a SIBLING
      // of the shell, never an ancestor (ADR-035 §6.2 measurement) — so gating
      // the record on it would leave Phase C with zero data from exactly the
      // configuration it most needs (Round 14 Codex).
      // One record per (tool call, destination window): a call that resolves
      // the same window twice — `run` resolving it and then its inner send
      // resolving it again — describes one relation, not two.
      kind: "topology_relation";
      resolver: ResolveResolver;
      callId: string | null;
      autoGuard: boolean;
      /** The window the resolver chose, as a decimal handle string. */
      targetHwnd: string;
      /** Always present: the record is only written when the owner is known. */
      ownerPid: number;
      ownerProcessName: string;
      /**
       * The stage-1 predicate: the window's owning pid is this process or one
       * of its ancestors AND the two agree on process creation time. `true` is
       * the self-hit suspicion — including its known false positives (Windows
       * Terminal hosts several unrelated windows in ONE process, measured: hwnd
       * 133658 and 3801680 both on pid 16372), which is why this is an
       * instrument and not a refusal.
       */
      ownerInAncestry: boolean;
      /**
       * Present only when the owning pid DID hit the cached ancestor chain but
       * `ownerInAncestry` is still false. `"recycled"`: the creation times
       * disagree, so Windows has handed an exited ancestor's pid to this
       * process. `"unverified"`: a creation time could not be read on one side.
       * Both are counted separately rather than folded into a plain `false` —
       * how often a pid-only rule would have been WRONG is itself an input to
       * OQ-P4.
       */
      ancestryPidHit?: "recycled" | "unverified";
      /**
       * Which ancestor: 0 is this very process, 1 its parent. Present only when
       * `ownerInAncestry` is true. A hit on THIS process and a hit on a Windows
       * Terminal five links up are different findings — the terminal hosts
       * unrelated windows, this process does not (Opus Round 1 P1).
       */
      ancestryDepth?: number;
      /**
       * The ancestor chain came out of a process snapshot that failed, so it is
       * just this process and EVERY `ownerInAncestry: false` in this record is a
       * read failure rather than a negative result. Carried per record because
       * the startup snapshot that reports the same thing may be hours earlier in
       * the log (Opus Round 1 P1).
       */
      ancestryUnavailable: boolean;
      /** Owner is `conhost` / `OpenConsole` — a console HOST, not a shell. */
      ownerIsConsoleHost: boolean;
      /**
       * Console host only: the process snapshot the parent lookup needed came
       * back empty, so `consoleHostParent*` are absent rather than negative.
       */
      parentMapUnavailable?: boolean;
      /**
       * Console host only: how old the snapshot behind `consoleHostParent*` was,
       * in ms. It is cached briefly, so "alive" means "alive this long ago".
       */
      parentMapAgeMs?: number;
      /** Console host only: its parent pid, and what that parent turned out to be. */
      consoleHostParentPid?: number | null;
      /**
       * Console host only: what became of the process that spawned it.
       * `"alive"` — still running, and it predates the host. `"gone"` — it has
       * exited, which is what `launch_console classic` leaves behind.
       * `"recycled"` — a process with that pid is running but started AFTER the
       * host, so the pid has been handed on; counting it as alive would corrupt
       * the parent-lifetime data this record exists to collect (Codex Round 2
       * P2). `"unverified"` — a creation time could not be read.
       *
       * Read `parentMapAgeMs` alongside it: the answer is as of that long ago.
       */
      consoleHostParentState?: "alive" | "gone" | "recycled" | "unverified";
      /** Console host only: the parent pid is this process or one of its ancestors. */
      consoleHostParentInAncestry?: boolean;
      /** The chosen window IS this process's own console window. */
      isOwnConsoleWindow: boolean;
      /**
       * The console handle could not be read, so `isOwnConsoleWindow: false` is
       * an absence of evidence rather than evidence of absence.
       */
      consoleWindowUnavailable?: boolean;
      /**
       * The non-blocking advisory was queued on this tool call. False when the
       * predicate fired outside a wrapped handler, where there is no call to
       * hang it on and nobody will ever read the string.
       *
       * Queued is not the same as printed: a tool surfaces the advisory where
       * it assembles `warnings`, and a tool that assembles none will not show
       * it. It is deliberately NOT named `warned` for that reason.
       */
      advisoryQueued: boolean;
    };

/**
 * ADR-035 §2 known-set resolvers, plus `_input-pipeline.ts` Case 3. Closed on
 * purpose: a new resolver has to be added here (and to the ADR-035 §2 table)
 * before it can log, so the event stream cannot silently grow a site the ADR
 * has not accounted for.
 */
export type ResolveResolver =
  /** §2 #1 — the shared `pickPlainTopLevelWindowByTitle` SSOT. */
  | "pickPlainTopLevelWindowByTitle"
  /** `_input-pipeline.ts` Case 3 HWND recovery (a #1 caller, logged separately). */
  | "inputPipelineCase3"
  /** §2 #2 — `engine/perception/action-target.ts`. */
  | "actionTarget"
  /** §2 #3 — `keyboard.ts:focusWindowForKeyboard`. */
  | "focusWindowForKeyboard"
  /** §2 #4 — `terminal.ts:findTerminalWindow` (title match + process-name fallback). */
  | "findTerminalWindow"
  /** §2 #7 — `smart-scroll.ts:tryImage`. */
  | "smartScrollImage"
  /** §2 #8 — `keyboard.ts` background WM_CHAR destination re-resolution (type). */
  | "keyboardBackgroundType"
  /** §2 #9 — `keyboard.ts` foreground_flash target. */
  | "keyboardForegroundFlash"
  /** §2 #13 — the press-side twin of #8. */
  | "keyboardBackgroundPress"
  /**
   * `desktop_act`'s v2 background executors — `terminalSend` and
   * `keyboardTypeBg`. Same unfiltered, silently-first-match shape as §2 #4 /
   * #8, reached through the other public dispatcher rather than through
   * `keyboard` / `terminal` (Opus Round 2 P2).
   */
  | "desktopActTerminalSend"
  | "desktopActKeyboardType"
  /**
   * `_resolve-window.ts` Case 4 — the common-dialog fallback taken when no
   * plain top-level window matched. Recorded separately so the dialog that WAS
   * chosen is on record; logging only the plain-window probe would leave a
   * `matchCount: 0` event joined to a dispatch that did have a target
   * (Codex Round 1 P2).
   */
  | "resolveWindowTargetDialog"
  /**
   * ADR-035 Phase C-0 — `terminal.ts:findTerminalWindowByPaneId`, the send
   * path that takes a `paneId` instead of a title. Instrumented for C-0 rather
   * than in Phase 1 because Phase C's refusal scope explicitly includes the
   * CLASSIC pane form: a classic paneId is an unvalidated decimal hwnd, so
   * `paneId:"<n>"` is the documented equivalence bypass around a refusal that
   * only looks at `windowTitle` / `hwnd` (plan §3b). Without it C-0 would hand
   * Phase C zero observations for the one path the plan names as the bypass
   * (Opus Round 2 P2). `pinnedByHwnd` is set for the classic form, which
   * matches on the handle, and not for `wt:`, which matches a nonce tab title.
   */
  | "findTerminalWindowByPaneId";

/**
 * Which rescue supplied the chosen window when the primary title rule did not.
 * `process-name`: `findTerminalWindow` matched the image name after zero title
 * matches (ADR-035 §2.1). `owner-chain`: `resolveWindowTarget` found no plain
 * top-level window and resolved a common dialog through the owner chain.
 */
export type ResolveFallback = "process-name" | "owner-chain";

/** One window in a `resolve` event. Titles hashed; identity fields optional. */
export interface ResolveWindowRecord {
  hwnd: string;
  titleHash: string;
  titleLen: number;
  titleRaw?: string;
  pid?: number;
  processName?: string;
  zOrder?: number;
  isActive?: boolean;
  isMinimized?: boolean;
  isCloaked?: boolean;
}

/**
 * The native channel an input dispatch left through. The three scroll values
 * name ADR-018 dispatcher tiers 1-3; `sendinput` covers both tier 4 and the
 * keyboard foreground path.
 */
export type DispatchSink =
  | "sendinput"
  | "wm_char"
  | "console_paste"
  | "clipboard_paste"
  /**
   * The native foreground-flash inject: steal the foreground, paste, restore.
   * Kept distinct from `clipboard_paste` because it is the one channel that
   * deliberately moves the foreground, so a dispatch on it is expected to
   * disagree with the `fgHwnd` recorded a moment earlier.
   */
  | "foreground_flash"
  | "rawkeyboard"
  | "uia"
  | "cdp"
  | "postmessage";

/**
 * Append one diagnostic event as a JSONL line. Best-effort: never throws.
 * Synchronous so events written just before `process.exit` reach disk.
 *
 * Review R1 P2-3: large `stack` fields are truncated to keep each line
 * bounded; an unbounded stack on a hot uncaught path would extend the
 * synchronous write past the OS pipe drain window and risk losing the
 * preceding log entries on `process.exit`.
 */
export function logDiagnostic(event: DiagnosticEvent): void {
  if (isDisabled()) return;
  const path = getDiagnosticLogPath();
  ensureDir(path);
  const safeEvent =
    "stack" in event && typeof event.stack === "string" && event.stack.length > STACK_TRUNCATE_CHARS
      ? { ...event, stack: event.stack.slice(0, STACK_TRUNCATE_CHARS) + "…[truncated]" }
      : event;
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    uptime_ms: Math.round(process.uptime() * 1000),
    ...safeEvent,
  };
  try {
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // Disk full / permission denied / path invalid — silently drop.
    // We deliberately do NOT log to stderr here because uncaughtException
    // handler also writes diagnostics and a stderr write that itself throws
    // could re-enter the handler.
  }
}

/**
 * Estimate the serialized size of tool arguments without doing a full
 * JSON.stringify (which can be expensive for large screenshot payloads).
 * Returns a rough byte count.
 */
export function estimateArgsSize(args: unknown[]): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return -1;
  }
}

/**
 * Best-effort JSON serialization that never throws. Falls back through
 * `JSON.stringify` → `String(value)` → literal `"<unstringifiable>"`. Used by
 * the uncaught handlers in `server-windows.ts` to normalize circular /
 * exotic thrown values before constructing an `Error` for logging.
 *
 * (Review R1 P1-2 — extracted to this module in R2 for testability.)
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unstringifiable>";
    }
  }
}

/**
 * Normalize an arbitrary thrown value into an `Error` instance so the
 * `uncaughtException` / `unhandledRejection` handlers can safely read
 * `.name` / `.message` / `.stack`. Node passes the *exact* value that was
 * thrown to listeners — including `null`, `undefined`, numbers, or circular
 * objects — and dereferencing properties on those would re-enter the
 * handler.
 *
 * (Codex Review R1 P2-2 for `unhandledRejection`; Codex R2 follow-up for the
 * symmetric `uncaughtException` path.)
 */
export function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(safeStringify(value));
}

/**
 * Wrap tool handler args (s.tool / s.registerTool signature) so that calls
 * exceeding `thresholdMs` are logged via `slow_tool` events. Mirrors
 * `wrapHandlerArg` in `utils/failsafe-wrap.ts` — both wrappers can be chained.
 *
 * Review R1 P3-3: only wrap when `toolArgs[0]` is a string (the conventional
 * tool name). For any other shape we skip the wrap so the log doesn't get
 * filled with literal `"undefined"` / `"[object Object]"` from upstream
 * misuse — keeping the failure-mode equivalent to `wrapHandlerArg`.
 */
export function wrapHandlerArgWithTiming(
  toolArgs: unknown[],
  thresholdMs = 1000,
): unknown[] {
  if (toolArgs.length === 0) return toolArgs;
  const toolName = toolArgs[0];
  if (typeof toolName !== "string") return toolArgs;
  const lastIdx = toolArgs.length - 1;
  const originalHandler = toolArgs[lastIdx];
  if (typeof originalHandler !== "function") return toolArgs;
  toolArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
    const start = performance.now();
    try {
      return await (originalHandler as (...a: unknown[]) => Promise<unknown>)(
        ...handlerArgs,
      );
    } finally {
      const elapsed = performance.now() - start;
      if (elapsed > thresholdMs) {
        logDiagnostic({
          kind: "slow_tool",
          tool: toolName,
          elapsed_ms: Math.round(elapsed),
          args_size: estimateArgsSize(handlerArgs),
        });
      }
    }
  };
  return toolArgs;
}

/** Test-only: reset module-level memoization. Not exposed via index. */
export function _resetDiagnosticLogForTest(): void {
  _resolvedPath = null;
  _disabled = null;
  _dirEnsured = false;
}
