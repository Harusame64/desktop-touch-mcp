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
 *   - size-triggered rotation with a bounded number of generations, so the
 *     file cannot grow without limit (see `DEFAULT_MAX_BYTES`)
 *   - env overrides:
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH      — override default path
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE   — set to "1" to disable entirely
 *       DESKTOP_TOUCH_DIAGNOSTIC_LOG_MAX_BYTES — rotate the live file above this
 *                                                size (default 64 MiB)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
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
 * Rotation ceiling for the live file.
 *
 * Before this the log was append-only with **no ceiling at all**: measured on
 * the maintainer's machine 2026-09-07 at **18,548,383,199 bytes / 34,811,118
 * lines**, accumulated since 2026-05-19. Sampling the tail showed ordinary
 * steady-state traffic (`resolve` / `exit` / `uncaught` / `dispatch_sink` /
 * `cpu_spike` / …), not a runaway producer — the growth is inherent to the
 * event rate, so throttling any one event kind would not have closed it.
 *
 * **What the ceiling actually bounds.** One writer: the live file stays at or
 * under `maxBytes`, so the directory stays under `(KEPT_GENERATIONS + 1) *
 * maxBytes`. That holds only because no single record can exceed it either —
 * see `MAX_RECORD_BYTES`, without which one oversized event walks straight
 * through a rotation. Concurrent writers are the honest caveat — the default path is one
 * file per user (`DEFAULT_DIR`) and every MCP client spawns its own server, so
 * N of them can share it. Each counts only its own bytes, so without help the
 * live file would reach roughly `N * maxBytes` before anyone noticed. That is
 * why the estimate is re-checked against the file's real size every
 * `STAT_REFRESH_DIVISOR`-th of the ceiling: the overshoot with N writers is
 * bounded by one refresh interval each, not by `N * maxBytes`.
 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const KEPT_GENERATIONS = 2;

/**
 * Floor for `maxBytes`.
 *
 * Without it, `1` is a "positive integer" and is accepted — and a reader who
 * takes the variable for MiB and writes `64` gets 64 BYTES: a rename per
 * record, every generation holding a single line, three syscalls per event on
 * the synchronous exit path, and the log destroyed rather than bounded. The
 * same "a typo must not break this" reasoning that rejects `0` and negatives
 * rejects an unusably small ceiling.
 */
const MIN_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling for `maxBytes`, and the mirror image of the floor.
 *
 * The floor catches a reader who takes the variable for MiB and writes `64`.
 * Nothing caught the same confusion in the other direction: `640000` meant as
 * MiB is 640 GB of bytes, accepted verbatim, and rotation never fires again —
 * exactly the behaviour the variable's own documentation promises a typo cannot
 * produce. `Number` also accepts `1e21`, which is a finite integer by
 * `Number.isInteger` and past `MAX_SAFE_INTEGER`, so the arithmetic that
 * follows stops being exact.
 *
 * 1 GiB is well past any diagnostic need (three generations is 3 GiB) and far
 * enough under the misread values to catch them.
 */
const MAX_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Ceiling for a single serialized record.
 *
 * The rotation ceiling only bounds the file if every record fits under it.
 * `uncaught.msg` and `exit.extra` are free-form, so one event can serialize to
 * any size at all - and a record larger than `maxBytes` defeats rotation
 * rather than triggering it: the roll happens, the fresh live file is empty,
 * and the oversized line is appended anyway. Later rolls only carry it into
 * `.1` and `.2`, so one event could put the directory past the stated bound by
 * an arbitrary amount. (`stack` was already capped by `STACK_TRUNCATE_CHARS`;
 * that bounded one field, not the record.)
 *
 * Derived from `MIN_MAX_BYTES` rather than written as its own number so the
 * two cannot drift apart. Every ceiling `parseMaxLogBytes` accepts is at least
 * `MIN_MAX_BYTES`, so a capped record is at most an eighth of it and the append
 * that follows a rotation always fits.
 */
const MAX_RECORD_BYTES = MIN_MAX_BYTES / 8;

/**
 * How much of an oversized record is kept, as a readable prefix of its JSON.
 *
 * Counted in UTF-16 code units, so the bound is a byte bound only after
 * re-encoding. The slice is taken from text that is ALREADY `JSON.stringify`
 * output, so it holds no raw control characters and re-escaping costs almost
 * nothing; what actually sets the worst case is `JSON.stringify` passing
 * non-ASCII through unescaped, at 3 UTF-8 bytes per BMP unit. 4096 units is
 * therefore ~12 KiB at worst, an order of magnitude inside
 * `MAX_RECORD_BYTES`. Pinned by test with a multi-byte payload rather than
 * argued: see "worst-case byte expansion" in tests/unit/diagnostic-log.test.ts.
 */
const OVERSIZE_HEAD_CHARS = 4096;

/** Bound on the `kind` echoed into a truncated record. See `truncatedRecordLine`. */
const KIND_TRUNCATE_CHARS = 64;

/**
 * How often the in-process estimate is reconciled with the file's real size,
 * as a fraction of the ceiling. 16 means one `statSync` per ~4 MiB written at
 * the default ceiling — negligible next to the writes themselves, and the only
 * thing standing between the stated bound and N concurrent writers.
 */
const STAT_REFRESH_DIVISOR = 16;

/**
 * Pure parser, kept separate from the `process.env` read so the parsing rules
 * are testable without mutating the environment.
 *
 * Anything that is not a positive integer — empty, non-numeric, zero,
 * negative, fractional, non-finite — falls back to the default rather than
 * disabling rotation. A typo in this variable must not restore the unbounded
 * behaviour this function exists to prevent, so `"0"` is NOT a disable switch
 * (`DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE=1` turns the log off entirely).
 */
export function parseMaxLogBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_BYTES;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MAX_BYTES;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_MAX_BYTES;
  if (n < MIN_MAX_BYTES) return MIN_MAX_BYTES;
  if (n > MAX_MAX_BYTES) return MAX_MAX_BYTES;
  return n;
}

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
let _maxBytes: number | null = null;

/**
 * Bytes this process believes the live file holds, seeded once from its size.
 *
 * Deliberately **not** a `statSync` per write: the append is synchronous and
 * sits on the `process.exit` path, so a syscall on every record would be paid
 * by every event to detect a condition that fires once per `maxBytes`.
 *
 * The estimate drifts in **both** directions, and they are not symmetric:
 *
 *   - **Too high** — another process rotated under this one. Harmless: this
 *     process rotates early, on a file smaller than the ceiling. Costs a
 *     generation.
 *   - **Too low** — another process is also appending and this one never saw
 *     those bytes. **This is the direction that breaks the bound**: with N
 *     writers each waiting for its own `maxBytes`, the live file would pass
 *     `N * maxBytes` before any of them acted. The first version of this
 *     comment documented only the harmless direction and concluded the bound
 *     held; it did not.
 *
 * So the estimate is reconciled with the real size every
 * `maxBytes / STAT_REFRESH_DIVISOR` bytes this process writes
 * (`_bytesSinceStat`) — one `statSync` per ~4 MiB at the default ceiling.
 */
let _bytesOnDisk: number | null = null;
let _bytesSinceStat = 0;

/**
 * A rotation failed and the fact has not yet reached the log. Recorded on the
 * next successful append rather than from inside `rotateIfNeeded`, so the
 * failure path cannot re-enter itself.
 *
 * `_rotationFailureRecorded` is per **episode**, not per process: it stops a
 * persistent failure writing one notice per record, and is cleared again by
 * the next successful rotation. Latching it for the process lifetime would
 * silence every later episode — and worse, the notice that justified the latch
 * does not even survive: the successful rotations in between carry it into
 * `.1`, then `.2`, then off the end. A viewer that starts holding the live file
 * open hours later would leave a log growing past its limit with nothing in it
 * to say why, which is the one thing this notice exists to prevent.
 */
let _rotationFailurePending = false;
let _rotationFailureRecorded = false;

/**
 * True only for a plain file. Used at the staging path, where `existsSync`
 * would answer yes to a directory sitting there and send it into the generation
 * chain as if it were a staged log.
 */
function isPlainFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function statSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0; // no file yet, or its size is unreadable — treat as empty
  }
}

function getMaxBytes(): number {
  if (_maxBytes === null) {
    _maxBytes = parseMaxLogBytes(process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_MAX_BYTES);
  }
  return _maxBytes;
}

/**
 * Suffix for the live file while it is between names. The **pid** goes in front
 * of it — see `stagingPathFor`.
 *
 * Chosen to still match a `diagnostic.log*` glob, so a roll interrupted by a
 * crash leaves its records findable rather than hidden. The next rotation by
 * that pid files it; until then the directory can hold one file more than the
 * usual three.
 */
const STAGING_SUFFIX = ".rotating";

/**
 * Where this process parks the live file mid-roll.
 *
 * The pid is not decoration. Every MCP client starts its own server and they
 * share one log by default, so a single fixed name turns the "is anything
 * staged?" check and the rename that follows into a race with a destructive
 * ending: A sees no staged file, B moves the whole live log to the shared name,
 * C recreates the live path by appending, and A's rename then replaces B's
 * staged log — up to `maxBytes` of the newest history gone. A name only this
 * process ever writes cannot be taken from under another one.
 *
 * It does not make concurrent rotation *correct* — two servers can still shift
 * generations over each other, which is recorded as a known limitation — but it
 * stops this change from making that worse than it already was.
 */
function stagingPathFor(target: string): string {
  return `${target}.${process.pid}${STAGING_SUFFIX}`;
}

/**
 * The file a path actually names.
 *
 * `DESKTOP_TOUCH_DIAGNOSTIC_LOG_PATH` may point at a symbolic link — a log
 * collected centrally, say. `statSync` measures the target, but `renameSync`
 * moves the LINK, and the next append then creates a plain file where the link
 * used to be: after one roll the configured destination silently stops
 * receiving anything. Rotating the resolved target instead leaves the link in
 * place, pointing at the file the next append recreates, and files the
 * generations beside the real log rather than beside the link.
 *
 * Falls back to the path itself on any error, which is the behaviour every
 * ordinary (non-link) path already had.
 */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Move `.N-1` up to `.N` for every kept generation, dropping the oldest.
 *
 * Destructive, and deliberately separated from the live file's own move so the
 * caller can order the two correctly: see `rotateIfNeeded`.
 */
function shiftGenerations(path: string): void {
  try {
    unlinkSync(`${path}.${KEPT_GENERATIONS}`);
  } catch {
    // absent — the usual case on the first rotation
  }
  for (let gen = KEPT_GENERATIONS; gen >= 2; gen--) {
    try {
      renameSync(`${path}.${gen - 1}`, `${path}.${gen}`);
    } catch (err) {
      // "The source is not there" is ordinary: fewer generations exist than
      // the ceiling allows. Anything else is not. If `.1` could not be moved
      // because `.2` is locked or is a directory, `.1` is STILL ON DISK - and
      // falling through would let the live file's rename replace it, throwing
      // away the newest retained generation while recording nothing. Rethrow
      // so the rotation aborts and the outer handler reports it.
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
    }
  }
}

/**
 * Roll `path` -> `path.1` -> … -> `path.KEPT_GENERATIONS` when the next record
 * would push the live file past the ceiling. Best-effort like every other write
 * in this module: a rotation that cannot happen must not stop the append.
 */
function rotateIfNeeded(path: string, incomingBytes: number): void {
  const maxBytes = getMaxBytes();
  const refreshInterval = Math.max(1, Math.floor(maxBytes / STAT_REFRESH_DIVISOR));
  if (_bytesOnDisk === null || _bytesSinceStat >= refreshInterval) {
    // Reconcile with the file itself, not with what this process remembers
    // writing. Without this the ceiling is per process, not per file.
    _bytesOnDisk = statSizeOrZero(path);
    _bytesSinceStat = 0;
  }
  if (_bytesOnDisk + incomingBytes <= maxBytes) return;
  if (!existsSync(path)) {
    // Checked BEFORE the shift below, not after it fails. The shift is
    // destructive - it unlinks the oldest generation and promotes the rest -
    // and it must not run on the strength of an estimate that turns out to
    // describe a file that is not there. Getting here means the live file was
    // deleted by hand, or rolled by another process sharing the path: in the
    // concurrent case the shift would discard that writer's fresh `.1`
    // and destroy history faster than `KEPT_GENERATIONS` advertises. Nothing
    // has failed; re-seed from the empty state and let the append recreate it.
    _bytesOnDisk = 0;
    _bytesSinceStat = 0;
    return;
  }
  // Everything below moves files, so it works on what `path` resolves to, not
  // on `path` itself. Appends keep using `path`: through a link, that is how the
  // target gets recreated after a roll.
  const target = realPathOrSelf(path);
  const staging = stagingPathFor(target);
  try {
    if (isPlainFile(staging)) {
      // A previous roll was interrupted between staging the live file and
      // filing it. Those records are NEWER than `.1`, so file them before
      // staging anything else - the rename below would otherwise replace them.
      //
      // Shifting before the move is safe HERE, unlike for the live file: this
      // file is ours, was created moments ago, and nothing outside this module
      // knows the name, so it is not the one a viewer can be holding open.
      shiftGenerations(target);
      renameSync(staging, `${target}.1`);
    }
    // The live file moves FIRST, before any generation is touched.
    //
    // The other order looks natural - make room, then fill it - and it quietly
    // destroys the archive it is meant to protect. When the live file cannot be
    // renamed at all (a viewer holding it open with write but not delete
    // permission, the case this module documents), the shift has already run:
    // `.2` unlinked, `.1` promoted into it. The append continues, the ceiling
    // is passed again, and the next attempt eats that generation too. A
    // persistent failure ends with an oversized log and NO retained history,
    // which is worse than the unbounded growth this module was written to stop.
    //
    // Staged first, a live file that can never be renamed costs nothing at all:
    // this rename fails, and every generation is exactly where it was.
    renameSync(target, staging);
    shiftGenerations(target);
    renameSync(staging, `${target}.1`);
    _bytesOnDisk = 0;
    _bytesSinceStat = 0;
    // Rotation works again, so the next failure is a new episode and gets its
    // own notice. See `_rotationFailureRecorded`.
    //
    // BOTH flags, not just the latch. A notice can still be pending here: its
    // own append failed earlier, which is exactly the case the write path was
    // reordered to keep retriable. Left set, it would be written after this
    // recovery - describing a failure that is over - and, worse, latch the
    // state this line just cleared, so the NEXT episode is suppressed and the
    // re-arm accomplishes nothing. A notice explains why a log is oversized;
    // the log just rotated, so there is nothing left to explain.
    _rotationFailurePending = false;
    _rotationFailureRecorded = false;
  } catch {
    // FIRST, undo a half-done roll. Staging the live file succeeds and the
    // shift after it throws — a viewer holding `.1` open is enough — and
    // without this the whole live file is left under the staging name while
    // the append starts a fresh, empty one. The newest generation is then
    // outside the `.1`/`.2` chain entirely: only a later roll BY THIS SAME PID
    // reclaims it, so another server never will, and each occurrence adds a
    // full ceiling to the directory permanently. Measured, one server, one
    // record: a 1 MiB live file stranded at `.rotating`, `diagnostic.log`
    // restarted empty, and every doc guarantee about "the newest records are
    // in diagnostic.log" false.
    //
    // Putting it back makes a failed roll cost nothing again, which is the
    // property the staging order was introduced for in the first place.
    if (isPlainFile(staging) && !existsSync(target)) {
      try {
        renameSync(staging, target);
      } catch {
        // Could not put it back either. It keeps a `diagnostic.log*` name and
        // the leftover branch files it on this pid's next roll.
      }
    }
    // Deliberately NOT re-checking existence of the live file here. The check
    // above covers every case that can be reached deterministically; what would
    // be left is a race so narrow no test can demonstrate it, on a branch that
    // could turn a real, permanent rotation failure into silence - which is the
    // one outcome this module exists to prevent. If the race does happen the
    // cost is a single misleading record, and the next write rotates normally.
    //
    // The roll could not complete (a file held open without FILE_SHARE_DELETE,
    // permission denied, a filesystem that refuses it). Keep appending rather
    // than dropping events — an oversized log is a smaller failure than a blind
    // server — and back the estimate off so the retry costs one attempt per
    // back-off rather than one per record. Measured from the file rather than
    // from the estimate, because the restore above may have changed which file
    // is live. The back-off is at least one whole record: at ceilings under
    // 2 MiB `refreshInterval` (`maxBytes`/16) is SMALLER than `MAX_RECORD_BYTES`,
    // so backing off by the interval alone would still leave the next record
    // over the ceiling and re-attempt the roll immediately.
    //
    // This outcome is NOT bounded: a file that can never be rolled grows at
    // full speed, which is the state this module exists to prevent. So it is
    // recorded once rather than swallowed, and the log can explain its own size.
    const backOff = Math.max(refreshInterval, MAX_RECORD_BYTES);
    _bytesOnDisk = Math.max(0, statSizeOrZero(target) - backOff);
    _bytesSinceStat = 0;
    if (!_rotationFailureRecorded) _rotationFailurePending = true;
  }
}

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
       * How many children of this process had an unreadable image name. Present
       * only when no console host was found, in which case
       * `ownConsoleHostChildPid: null` is not a clean negative — one of these
       * may have been the console host (Opus Round 4 P2).
       */
      ownConsoleHostChildScanIncomplete?: number;
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
      /** As on `topology_relation` — the walk stopped at a reused pid. */
      ancestryTruncatedAtRecycledPid?: boolean;
      /**
       * The ancestor walk stopped because a link's creation time could not be
       * read. Above that point the parent-vs-child comparison that catches a
       * reused pid has nothing to compare against, so the chain is deliberately
       * short and an `ownerInAncestry: false` on it may be a false negative
       * (Codex Round 6).
       */
      ancestryTruncatedAtUnreadableLink?: boolean;
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
      //
      // So this is NOT a per-write counter, and must not be used as one: a
      // macro that writes N times into one window still produces a single
      // record. The per-write quantity lives in the `dispatch_sink` records,
      // which are emitted once per native dispatch and share this `callId` —
      // join on the call and the window to weight a relation by how many writes
      // actually went to it. Counting resolutions instead would have made the
      // weight depend on how many times a handler happened to re-resolve, which
      // is a property of the plumbing.
      //
      // Matching the window needs care: a `dispatch_sink` carries `targetHwnd`
      // only for the sinks that address a handle. The foreground-routed ones —
      // SendInput and the clipboard paste, which are the DEFAULT path for
      // Windows Terminal, and so the path the stage-1 advisory is usually about
      // — pass `targetHwnd: null` and identify the window through `fgHwnd`
      // instead. So match on `targetHwnd ?? fgHwnd` (Opus Round 4 P2 measured
      // the sink call sites; an earlier note here said `targetHwnd` alone and
      // would have silently dropped every WT write). When the two disagree on a
      // handle-addressed sink, that disagreement is itself the H2 finding and
      // not a join problem.
      //
      // Two limits of the fallback, for whoever reads the log: `fgHwnd` can be
      // null (no foreground window — a locked or secure desktop), leaving that
      // sink row with no join key at all; and on a handle-less sink the
      // foreground IS the only window identifier, so a write that landed
      // somewhere other than the resolved window is credited to whatever was in
      // front. There is nothing there to disagree with.
      kind: "topology_relation";
      /**
       * The resolver that FIRST reached this window in this call. When a call
       * resolves the same window through more than one resolver, later ones are
       * folded into this record (see the note above), so this names the first,
       * not necessarily the one whose result drove the dispatch.
       */
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
      /**
       * The ancestor walk stopped early: a candidate parent turned out to be
       * YOUNGER than its own child, so the pid it was reached by has been
       * handed on since. Everything above that point is unknown, and an
       * `ownerInAncestry: false` on such a chain may be a false negative
       * (Codex Round 4 P2).
       */
      ancestryTruncatedAtRecycledPid?: boolean;
      /**
       * The ancestor walk stopped because a link's creation time could not be
       * read. Above that point the parent-vs-child comparison that catches a
       * reused pid has nothing to compare against, so the chain is deliberately
       * short and an `ownerInAncestry: false` on it may be a false negative
       * (Codex Round 6).
       */
      ancestryTruncatedAtUnreadableLink?: boolean;
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
      /**
       * The parent-side twin of `ancestryPidHit`: present when the parent pid
       * hit the cached chain but `consoleHostParentInAncestry` is still false,
       * because the creation times disagree (`"recycled"`) or could not be
       * compared (`"unverified"`). Without it those two are indistinguishable
       * from an actual negative.
       */
      consoleHostParentPidHit?: "recycled" | "unverified";
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
 * Stand-in for a record that would not fit under `MAX_RECORD_BYTES`.
 *
 * Keeps `kind` so existing greps still find the event, says plainly that it was
 * truncated and how large it really was, and carries a bounded prefix of the
 * original JSON so the offending field is still readable.
 */
function truncatedRecordLine(line: string, lineBytes: number, kind: string): string {
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      uptime_ms: Math.round(process.uptime() * 1000),
      // Bounded here rather than trusted to the `DiagnosticEvent` union. Every
      // call site in this repo passes a literal, but a compile-time union is
      // not a runtime guarantee, and this is the one record whose whole job is
      // to be provably small. The longest real kind is ~20 characters.
      kind: kind.slice(0, KIND_TRUNCATE_CHARS),
      record_truncated: true,
      original_bytes: lineBytes,
      head: line.slice(0, OVERSIZE_HEAD_CHARS),
    }) + "\n"
  );
}

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
  // Path resolution and serialization are both INSIDE the guard. `exit.extra` is `Record<string,
  // unknown>`, so a circular reference, a BigInt or a throwing `toJSON` reaches
  // `JSON.stringify` from a caller this module cannot see — and this function
  // runs from the uncaughtException and shutdown handlers, where a thrown
  // exception is exactly the failure the never-throw contract exists to
  // prevent. Rotation needs the serialized length, which is what moved the
  // stringify out of the guard; it moves back in together with it. Path
  // resolution joins them because `homedir()` can throw `ERR_SYSTEM_ERROR` on
  // a machine with no resolvable home - rare, but the header promises this
  // function never throws, and it was outside the guard before this change.
  try {
    const path = getDiagnosticLogPath();
    ensureDir(path);
    const safeEvent =
      "stack" in event &&
      typeof event.stack === "string" &&
      event.stack.length > STACK_TRUNCATE_CHARS
        ? { ...event, stack: event.stack.slice(0, STACK_TRUNCATE_CHARS) + "…[truncated]" }
        : event;
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      uptime_ms: Math.round(process.uptime() * 1000),
      ...safeEvent,
    };
    let line = JSON.stringify(record) + "\n";
    let lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_RECORD_BYTES) {
      // Rotation cannot shrink a record that is itself over the ceiling, so
      // the record is what has to give. See `MAX_RECORD_BYTES`.
      line = truncatedRecordLine(line, lineBytes, event.kind);
      lineBytes = Buffer.byteLength(line, "utf8");
    }
    rotateIfNeeded(path, lineBytes);
    appendFileSync(path, line);
    if (_bytesOnDisk !== null) _bytesOnDisk += lineBytes;
    _bytesSinceStat += lineBytes;
    if (_rotationFailurePending) {
      const note =
        JSON.stringify({
          ts: new Date().toISOString(),
          pid: process.pid,
          uptime_ms: Math.round(process.uptime() * 1000),
          kind: "log_rotation_failed",
          maxBytes: getMaxBytes(),
        }) + "\n";
      appendFileSync(path, note);
      // Flags cleared only after the notice is actually on disk. Clearing them
      // first meant that if this second append failed - the event line having
      // just consumed the last of the disk, say - the pending state was gone
      // for good: later events would resume once space freed up, and the
      // rotation failure that explains the log's size would never be reported.
      _rotationFailurePending = false;
      _rotationFailureRecorded = true;
      const noteBytes = Buffer.byteLength(note, "utf8");
      if (_bytesOnDisk !== null) _bytesOnDisk += noteBytes;
      _bytesSinceStat += noteBytes; // counted like any other append, so the
      // periodic reconciliation stays in step with what was actually written
    }
  } catch {
    // Disk full / permission denied / path invalid / an event that cannot be
    // serialized — silently drop.
    // We deliberately do NOT log to stderr here because uncaughtException
    // handler also writes diagnostics and a stderr write that itself throws
    // could re-enter the handler.
  }
}

/**
 * Serialized size of tool arguments, in UTF-16 code units, or -1 when they
 * cannot be serialized at all.
 *
 * The name and the old comment both promised an estimate that avoided a full
 * `JSON.stringify`; the body has always done exactly that stringify, and
 * `.length` counts code units rather than bytes. Only the description was
 * wrong — this is the size recorded in `slow_tool`, where a figure that tracks
 * payload size is what matters, not an exact byte count.
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
  _maxBytes = null;
  _bytesOnDisk = null;
  _bytesSinceStat = 0;
  _rotationFailurePending = false;
  _rotationFailureRecorded = false;
}
