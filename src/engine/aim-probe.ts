/**
 * aim-probe.ts — what the aim actually is, at every seam it passes through.
 *
 * ADR-036, the restoration of the Reactive Perception Graph. The design was never wrong; the
 * line to the aim was not connected, and the layers above it were built by people who could not
 * see where the value came from. So before moving anything toward the specification, this records
 * what the machine does TODAY: the current behaviour is the ground truth, and the specification is
 * where it is being taken.
 *
 * Design rules, each of them a scar:
 *
 *   - **It only reads.** Nothing here calls `observeTarget` or anything else that updates a
 *     tracker, because a probe that writes changes the thing it measures — and the aim's identity
 *     is exactly the kind of state that moves when you look at it.
 *   - **It never throws.** A probe that can break the run it observes will eventually be blamed
 *     for the bug it found. Every entry point swallows its own errors.
 *   - **It writes to a file.** A probe that only prints leaves no record: the terminal is gone
 *     when the window closes, and the interesting run is always the one nobody was watching.
 *   - **Absence is recorded, not inferred.** A seam that is reached with no aim writes
 *     `hwnd: null` rather than writing nothing, so "the aim was empty here" and "this build never
 *     reached this line" are different rows.
 *   - **It says what it is running on.** Row zero of every process names the addon that answered
 *     and what it binds (item 14b), so a record needs no note beside it saying which build it was
 *     taken on — the note is the part that drifted.
 *
 * Off unless `DESKTOP_TOUCH_AIM_PROBE=1`. The path is `DESKTOP_TOUCH_AIM_PROBE_PATH`, or
 * `<home>/.desktop-touch-mcp/logs/aim-probe.jsonl`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeExportNames, nativeUiaState, nativeUiaEvidence } from "./native-engine.js";
import { getWindowIdentity } from "./win32.js";

/** The seams, in the order one `desktop_discover` → `desktop_act` pair passes through them. */
export type AimSeam =
  /**
   * Row zero of every process (item 14b): the addon that answered and what it binds. Written once,
   * before the first seam, so a record says what it was taken on without a note kept beside it.
   */
  | "probe.start"
  /** `see()` entry: the target the caller sent, and the session key it resolved to. */
  | "see.enter"
  /** `normalizeTarget`: what went in, what came out, and what it warned about. */
  | "compose.normalize"
  /**
   * A provider lane: what it was asked for, what it did with it (`read` / `skipped` / `failed`),
   * and the handle it scoped to. Every lane writes one where it returns (item 14a).
   */
  | "provider.read"
  /** `see()` exit: what the session ends up remembering as `lastTarget`. */
  | "see.store"
  /** `createDesktopExecutor`: the target the write path was handed, and the handle it parsed. */
  | "act.aim"
  /** Act time: the identity of the window that handle names NOW (read-only). */
  | "act.identity"
  /** Act time: which backend ran, whether it was aimed, and which rung refused when one did. */
  | "act.route";

let seq = 0;
let resolvedPath: string | null = null;
let disabled = false;
/** Set BEFORE the header is assembled, so a header that cannot be written is not retried per row. */
let headerWritten = false;

function probePath(): string | null {
  if (disabled) return null;
  if (resolvedPath) return resolvedPath;
  if (process.env.DESKTOP_TOUCH_AIM_PROBE !== "1") { disabled = true; return null; }
  const p = process.env.DESKTOP_TOUCH_AIM_PROBE_PATH
    ?? join(homedir(), ".desktop-touch-mcp", "logs", "aim-probe.jsonl");
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    // A directory that cannot be made is not a reason to fail the run being measured.
    disabled = true;
    return null;
  }
  resolvedPath = p;
  return p;
}

/**
 * Record one seam.
 *
 * `data` is written as-is, so callers pass values already reduced to JSON-safe shapes — a `bigint`
 * has to arrive as a string. That is deliberate: the conversion belongs where the value's meaning
 * is known, not in a logger guessing at it.
 */
export function probeAim(seam: AimSeam, data: Record<string, unknown>): void {
  const p = probePath();
  if (!p) return;
  if (!headerWritten) {
    headerWritten = true;
    // Row ZERO, not row one: every row after it keeps the number it had before the header existed,
    // so a record taken before item 14b and one taken after count the same way — and counting is
    // how the `bigint` loss below was found.
    writeRow(p, 0, "probe.start", runHeader());
  }
  // Taken BEFORE anything that can throw, so a row that cannot be written still owns its number
  // and the fallback below can name it. The first version incremented it inside the
  // `JSON.stringify(...)` argument, so a throw consumed the number and left a gap — which is how
  // this bug was found: by counting the gaps (win2, 2026-09-09).
  writeRow(p, ++seq, seam, data);
}

function writeRow(p: string, n: number, seam: AimSeam, data: Record<string, unknown>): void {
  try {
    appendFileSync(p, JSON.stringify({ seq: n, tsMs: Date.now(), pid: process.pid, seam, ...data }, jsonSafe) + "\n");
  } catch (err) {
    // The observation must not break the observed — but it must not vanish either. Every `act.aim`
    // row disappeared for exactly the runs where the aim carried a handle, because `Aim.hwnd` is a
    // `bigint` and `JSON.stringify` throws on those, and the silent catch turned "could not write
    // it" into the same output as "never got here". A probe whose header says *absence is
    // recorded, not inferred* may not do that to itself.
    try {
      appendFileSync(p, JSON.stringify({
        seq: n, tsMs: Date.now(), pid: process.pid, seam,
        probeError: err instanceof Error ? err.message : String(err),
      }) + "\n");
    } catch {
      // The path itself is unwritable. Nothing left to do that would not risk the run.
    }
  }
}

/**
 * `JSON.stringify` replacer for the values this codebase actually carries.
 *
 * Every window handle in the engine is a `bigint`, and `JSON.stringify` throws on those rather
 * than skipping them — one handle anywhere in the payload destroys the whole row. Converted to the
 * decimal string the rest of the log already uses for handles, so a reader does not have to know
 * which field came from where.
 */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** True when the probe is on — for call sites whose data costs something to assemble. */
export function aimProbeEnabled(): boolean {
  return probePath() !== null;
}

/**
 * The window identity behind a handle, read without touching any tracker.
 *
 * `identity-tracker.ts` already models exactly what the specification asks for — `hwnd_reused`,
 * `process_restarted`, `hwnd_vanished` — but its entry point (`observeTarget`) RECORDS what it
 * sees, so calling it from here would make the probe part of the mechanism. This reads the same
 * facts through the pure win32 helpers instead.
 *
 * A zeroed identity (`pid: 0`, empty name) means the question could not be answered — the native
 * binding is missing, the process is gone, the handle is not a window. That is not evidence of a
 * different window, and the field is emitted as-is so a reader can tell the two apart.
 */
export function readWindowIdentity(hwnd: bigint): Record<string, unknown> {
  try {
    // The binding is loaded when `native-engine.ts` is first imported, long before any seam runs,
    // so neither this import nor the header's (item 14b) adds a load to a run with the probe off.
    const ident = getWindowIdentity(hwnd);
    return {
      pid: ident.pid,
      processName: ident.processName,
      processStartTimeMs: ident.processStartTimeMs,
      answered: ident.pid !== 0,
    };
  } catch (err) {
    return { answered: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The lanes, named the way the candidates' own `sources` name them, so a row joins to an entity. */
export type ProbeLane = "uia" | "terminal" | "ocr" | "cdp" | "visual_gpu";

/**
 * What a lane did with the read it was asked for.
 *
 *   - `read`    — it looked. Zero candidates is still a read; its warnings say what it found.
 *   - `skipped` — it was asked and did not look, and `why` says why: no target, no backend,
 *                 still warming, or a road that runs it only for a UIA-blind window.
 *   - `failed`  — it tried and could not.
 */
export type LaneOutcome = "read" | "skipped" | "failed";

/**
 * ADR-036 item 14a — one `provider.read` row from every lane, written where the lane RETURNS.
 *
 * Only the UIA lane used to write one, so `lanesThatRead` was a reach proof on the native road and
 * an absence everywhere else: a terminal, OCR or CDP read left nothing, and "that lane did not
 * read" printed exactly like "that lane is not instrumented" (win2, 2026-09-10, `dev/pr615-roads/`
 * — a passing terminal arm was voided by that rule, and the rule was wrong). With a row on every
 * return, a lane with no row was not called.
 *
 * Returns `result` untouched, so a return site wraps the value it already had instead of growing a
 * second statement that can drift from it. Never records candidate CONTENT — a terminal buffer or
 * a DOM label can carry anything the user has on screen — only counts and the lane's own codes.
 */
export function probeLane<R extends { candidates: readonly unknown[]; warnings: readonly string[] }>(
  lane: ProbeLane,
  outcome: LaneOutcome,
  data: Record<string, unknown>,
  result: R,
): R {
  probeAim("provider.read", {
    lane,
    ...data,
    // New keys go at the END: the UIA lane's row predates them, and excerpts are read at fixed width.
    outcome,
    candidateCount: result.candidates.length,
    warnings: [...result.warnings],
  });
  return result;
}

/**
 * ADR-036 item 14b — what this process is running on, said once, as row zero.
 *
 * Every round before this kept a note beside its record: which sandbox, which `.node`, copied from
 * where. The note was right until it was not — a sandbox carrying the 2026-08-29 addon measured the
 * enumeration road while its source had the OS hit test, and only `pointOwner.via` caught it (win2,
 * 2026-09-10). A record that says what it was taken on cannot drift from a note it does not need.
 *
 * Two readings, from two places, so that they can disagree:
 *   - `boundExports` — what the binding this module imported actually exposes, by name.
 *   - `addonFiles` — which `.node` files the process's module loader has loaded, from its own
 *     registry, each with its sha256, the size of the bytes hashed and its mtime. Not recomputed from
 *     `index.js`'s candidate list: a second lookup names the file that SHOULD have loaded, which is
 *     the note this replaces.
 *
 * Every field is total. A reading that fails is recorded as the failure, and the header never throws
 * into the row it precedes.
 */
function runHeader(): Record<string, unknown> {
  let boundExports: string[] | null = null;
  let boundExportsError: string | undefined;
  try {
    boundExports = nativeExportNames();
  } catch (err) {
    boundExportsError = messageOf(err);
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    // Which build is answering: the script the process was started with, and this module's file.
    entry: process.argv[1] ?? null,
    probeModule: moduleFile(),
    boundExports,
    ...(boundExportsError !== undefined && { boundExportsError }),
    // Whether the UIA engine in that list is the one answering. `DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1`
    // keeps the addon loaded, so the list above still names it on a run that went through PowerShell.
    nativeUia: nativeUiaState(),
    // ADR-036 H2 — and whether native UIA actually ran, as the engine and the OS answer, not the switch.
    // Row zero is written at the run's first probe seam, so this is the state at that moment. Tools that
    // write no probe row (keyboard, terminal, desktop_state) may already have run by then. The probe has
    // no closing row, so what an act did is read afterwards from `server_status`.
    nativeUiaEvidence: nativeUiaEvidence(),
    ...loadedAddonFiles(),
  };
}

/**
 * The `.node` files this process's module loader has loaded, from the loader's own registry.
 *
 * `require.cache` is where Node's CommonJS loader files every module it has loaded, and `index.js`
 * loads the addon through `createRequire` — so the addon is filed there under the path it was
 * actually loaded from, whichever of `index.js`'s candidates that turned out to be. The registry is
 * one object shared by every `createRequire`, so this module's view of it is the whole process's.
 *
 * It replaced `process.report`'s `sharedObjects`, which a real-machine round had just shown to be
 * right on Windows (win2, 2026-09-11, `dev/probe-rows-621/`). The reason was cost, not correctness:
 * the report looks up a host name for every open socket, synchronously, inside the first seam of the
 * run being measured, and the switch that stops it is missing before Node 20.13 and did not reach
 * the libuv section until 22.12 (nodejs/node#55602) — both inside `engines` (win, 2026-09-11).
 * Reading an object asks nobody.
 *
 * ASSUMED on Windows: that the path the loader files is the one Get-FileHash would be pointed at.
 * The round on this commit settles it, with the 2026-08-29 and 2026-09-10 addons as the pair.
 */
function loadedAddonFiles(): Record<string, unknown> {
  try {
    return addonFilesFromLoader(createRequire(import.meta.url).cache);
  } catch (err) {
    return { addonFilesFrom: "require.cache", addonFiles: null, addonFilesError: messageOf(err) };
  }
}

/**
 * The file list, from any registry shaped like `require.cache` — a parameter, so a cell can hand it
 * one. Every failure is recorded as the failure; nothing here throws into the row it feeds.
 */
export function addonFilesFromLoader(cache: Record<string, unknown>): Record<string, unknown> {
  const addonFilesFrom = "require.cache";
  try {
    const addonFiles = Object.keys(cache)
      .filter((p) => /\.node$/i.test(p))
      .map(fileIdentity);
    return { addonFilesFrom, addonFiles };
  } catch (err) {
    return { addonFilesFrom, addonFiles: null, addonFilesError: messageOf(err) };
  }
}

/**
 * A listed file this cannot read is named with the failure, not dropped from the list.
 *
 * One descriptor, and the size taken from the bytes that were hashed. A `stat` of the path and a
 * later read of the path can describe two different files if the addon is replaced in between
 * (CodeQL, on #621) — and one descriptor still does not freeze a file rewritten in place, so a
 * stat's size beside a hash of later bytes could describe two states of one file (PR 側 codex on
 * #621). The descriptor is looked at before and after the read, and a file that moved between the
 * two says so. The header exists because two notes about "the same" build turned out to be about two.
 */
function fileIdentity(path: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    return {
      path,
      bytes: content.length,
      mtimeMs: after.mtimeMs,
      sha256: createHash("sha256").update(content).digest("hex"),
      ...((before.size !== after.size || before.mtimeMs !== after.mtimeMs) && { changedWhileRead: true }),
    };
  } catch (err) {
    return { path, error: messageOf(err) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The row is already decided; a descriptor that will not close changes nothing in it.
      }
    }
  }
}

function moduleFile(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
