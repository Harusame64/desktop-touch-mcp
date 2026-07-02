// ADR-014 v2 R3 Key Locker — L3 SessionContext provider (§3 of the L3 sub-plan).
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l3-capture-plan.md (§3)
//
// L1's `deriveBinding(cmd, session)` needs the pane's {execHost, isRemote, cwd} — but the terminal
// layer tracks NONE of it (only title/hwnd/pid). L1 declared this an explicit input "L3 owns
// supplying." This tracker maintains a per-pane session, updated from the DISPATCHED-COMMAND STREAM
// (the commands L3 itself typed — authoritative, never screen-scraped):
//
//   * a pane is KNOWN-LOCAL only once anchored via beginLocalSession() (e.g. L3 launched / confirmed
//     it from a local prompt). A pane never anchored is UNKNOWN → callers DECLINE to derive (§3
//     fail-safe: never guess localhost for a possibly-already-remote pane).
//   * `ssh user@host` (an interactive login, not a one-shot `ssh host cmd`) PUSHES a remote frame;
//     nested ssh stacks. noteSessionEnd() pops one frame (the manager calls it when it observes the
//     ssh child process exit — SP-L3-OQ-7). markUnknown() sinks a pane to UNKNOWN when the
//     session-end is unconfirmable — never a stale isRemote:true (Opus R2 P2 wrong-target close).
//   * `cd <path>` best-effort updates cwd; unknown cwd stays undefined (L1 fails safe to null for the
//     cwd-dependent cases, so it declines rather than wrong-targets).
//
// This module is PURE state + command parsing — no Win32, no I/O. The process-tree watch that drives
// noteSessionEnd() is the KeyLockerManager's job (deferred, SP-L3-OQ-7).

import { win32 as winPath } from "node:path";
import { tokenizeCommandSegmentsWithOps } from "./command-derivation.js";
import { parseSshCommand } from "./ssh-resolve.js";

/** One session frame: a local shell, or a shell reached by ssh'ing into `execHost`. */
export interface SessionFrame {
  execHost: string;
  isRemote: boolean;
  /** Working directory when known (for L1's configured-git-remote resolution); undefined = unknown. */
  cwd?: string;
}

/** What a pane's session resolves to: a concrete frame, or UNKNOWN (caller must decline to derive). */
export type PaneSession = SessionFrame | { unknown: true };

/** Type guard: is this session usable for derivation (not UNKNOWN)? */
export function isKnownSession(s: PaneSession): s is SessionFrame {
  return !("unknown" in s);
}

interface PaneState {
  /** Frame stack: [0] is the base local shell, each ssh-in pushes one. `null` = UNKNOWN pane. */
  stack: SessionFrame[] | null;
}

/**
 * Per-pane session tracker. Panes are keyed by a stable id the terminal layer supplies (hwnd string
 * / window title token — the caller's choice, consistent per pane).
 */
export class SessionTracker {
  private readonly panes = new Map<string, PaneState>();

  /**
   * Anchor a pane as KNOWN-LOCAL — the manager calls this when it KNOWS the pane started from a local
   * shell (L3 launched it, or a confirmed local prompt). Only anchored panes derive; the anchor is
   * what §3's "observed from its start" means. Re-anchoring resets the stack to a single local frame.
   */
  beginLocalSession(paneId: string, cwd?: string): void {
    this.panes.set(paneId, { stack: [{ execHost: "localhost", isRemote: false, ...(cwd !== undefined ? { cwd } : {}) }] });
  }

  /**
   * Update the pane's session from a command L3 is about to dispatch. An interactive `ssh user@host`
   * pushes a remote frame; a `cd <path>` updates cwd. A command in an UNKNOWN pane leaves it unknown.
   * Call this BEFORE deriving/dispatching so `get()` reflects the command's own context correctly for
   * the NESTED case (the outer login is derived from the pre-push frame; see §4 of the L1 plan).
   */
  recordDispatch(paneId: string, command: string): void {
    const st = this.panes.get(paneId);
    if (st === undefined || st.stack === null) return; // unknown / never-anchored — stays unknown

    // Scan EVERY segment for a session-changing program (Opus R1 P1-1: `cd x && ssh host` must still
    // REACH the ssh — do not `return` after cd). The FIRST ssh-in wins the session change. Each
    // segment also carries whether it is CONDITIONALLY reached (`&&` / `||`) — a branch the shell may
    // skip, which we must not treat as a reliable session change (Codex #495 P1).
    for (const { tokens: segment, conditional } of tokenizeCommandSegmentsWithOps(command)) {
      // Skip leading FOO=bar env-assignments, exactly as L1's deriveBinding does (Opus R1 P1-1:
      // `LC_ALL=C ssh user@host` must still detect the ssh, else the remote frame is never pushed and
      // the pane stays labeled localhost — a wrong-target on the fp-less sudo path).
      let start = 0;
      while (start < segment.length && ENV_ASSIGN_RE.test(segment[start])) start++;
      const program = programOf(segment[start]);
      if (program === "ssh") {
        const remote = interactiveSshTarget(segment.slice(start + 1));
        if (remote !== null) {
          // A conditional (`&&` / `||`) ssh may or may not actually run — unknowable at dispatch time.
          // Pushing a remote frame that never materializes strands the pane as remote (no ssh child
          // for the watch to pop) → wrong-targets a later LOCAL command; staying local wrong-targets
          // the other way if it DID run. The honest state is UNKNOWN → decline (Codex #495 P1). An
          // unconditional ssh is a reliable prediction → push.
          if (conditional) { this.markUnknown(paneId); return; }
          st.stack.push({ execHost: remote, isRemote: true, cwd: undefined });
        }
        return; // a one-shot `ssh host cmd` / query mode does NOT push; either way the ssh wins the scan
      }
      if (program === "cd") {
        if (conditional) {
          // A conditional cd's destination is unpredictable — drop cwd to unknown (git derivation then
          // declines) rather than trust a directory the shell may not have entered (Codex #495 P1).
          st.stack[st.stack.length - 1].cwd = undefined;
        } else {
          applyCd(st.stack[st.stack.length - 1], segment.slice(start + 1));
        }
        // keep scanning — a later `&& ssh …` in the same command still changes the session.
      }
      // NOTE: `exit`/`logout` are deliberately NOT handled here (Opus R1 P1-2). The AUTHORITATIVE pop
      // is the manager's process-tree watch → noteSessionEnd(); a typed-exit pop here would double-pop
      // a nested ssh (recordDispatch pops, then the watch pops again → localhost while still remote),
      // and a FAILED exit (stopped jobs / IGNOREEOF) never actually ends the session. An unconfirmable
      // end sinks via markUnknown, never a speculative pop.
    }
  }

  /** The pane's current session (top frame), or UNKNOWN if never anchored / sunk. */
  get(paneId: string): PaneSession {
    const st = this.panes.get(paneId);
    if (st === undefined || st.stack === null || st.stack.length === 0) return { unknown: true };
    const top = st.stack[st.stack.length - 1];
    return { execHost: top.execHost, isRemote: top.isRemote, ...(top.cwd !== undefined ? { cwd: top.cwd } : {}) };
  }

  /**
   * Pop the top ssh frame — the manager calls this when it observes the pane's `ssh` child process
   * exit (the authoritative session-end signal, §3). Popping the base local frame is a no-op (you
   * can't ssh-out of the local shell). Never sinks to unknown by itself.
   */
  noteSessionEnd(paneId: string): void {
    const st = this.panes.get(paneId);
    if (st === undefined || st.stack === null) return;
    if (st.stack.length > 1) st.stack.pop(); // keep the base local frame
  }

  /**
   * Sink a pane to UNKNOWN — the manager calls this when a session-end is UNCONFIRMABLE (can't track
   * the process tree, ambiguous logout/EOF). §3/Opus R2 P2: never leave a possibly-ended remote frame
   * as trusted `isRemote:true`; decline instead. Recovery to known-local is SP-L3-OQ-8 (future).
   */
  markUnknown(paneId: string): void {
    this.panes.set(paneId, { stack: null });
  }

  /** Forget a pane entirely (e.g. its window closed). A later `get()` returns UNKNOWN. */
  forget(paneId: string): void {
    this.panes.delete(paneId);
  }
}

/** Leading `FOO=bar` env-assignment (skipped before the program token, mirrors L1). */
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Program identity of a token: basename-ish, lowercased, `.exe` stripped (mirrors L1). */
function programOf(token: string | undefined): string {
  if (token === undefined) return "";
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * If an `ssh` argv (without the leading `ssh`) is an INTERACTIVE LOGIN, return the resolved host
 * (bare, lowercased — the label; L1 resolves the real endpoint later). Return null for a one-shot
 * `ssh host cmd`, a query mode (`-G`/`-Q`/`-V`), or no destination — none of which open a session.
 */
function interactiveSshTarget(args: string[]): string | null {
  const parsed = parseSshCommand(args);
  if (parsed.queryMode || parsed.destination === undefined) return null;
  // `-N` (no remote command) and `-f` (fork to background) do NOT open an interactive login shell in
  // THIS pane: `-N` blocks the pane holding a tunnel, `-f` returns it to the LOCAL prompt. Pushing a
  // remote frame would mislabel a later LOCAL command as remote → wrong-target on the fp-less sudo
  // path (#495 P2). Treat them as non-session-opening — no push.
  if (parsed.noArgFlags.has("N") || parsed.noArgFlags.has("f")) return null;
  // A one-shot `ssh host cmd …` has a remote-command token AFTER the destination → not an interactive
  // login session. parseSshCommand consumes `optionArgs` (the options) + 1 (the destination); anything
  // BEYOND that count is the remote command. STRUCTURAL token count, not indexOf (Opus R1 P2-1:
  // `ssh -l host host` would make indexOf return the option-arg's index and misclassify it).
  const consumed = parsed.optionArgs.length + 1;
  if (args.length > consumed) return null; // trailing remote command → one-shot, no session
  const at = parsed.destination.lastIndexOf("@");
  const host = at >= 0 ? parsed.destination.slice(at + 1) : parsed.destination;
  return host.toLowerCase();
}

/**
 * Best-effort cwd update from a `cd` command (mutates the frame's cwd). Paths are WINDOWS console
 * paths, so use `path.win32` semantics REGARDLESS of the host OS Node runs on — `node:path` would
 * misjudge `C:/srv` as relative on Linux (test/dev) and fabricate a bogus cwd fed to `git -C`
 * (Codex #495 P2). Determinism across platforms; on the Windows runtime the two are identical.
 */
function applyCd(frame: SessionFrame, args: string[]): void {
  const target = args.find((a) => !a.startsWith("-"));
  if (target === undefined || target === "~" || target.startsWith("~")) {
    frame.cwd = undefined; // home / unresolvable — leave unknown (L1 fails safe)
    return;
  }
  if (winPath.isAbsolute(target)) {
    frame.cwd = target;
  } else if (frame.cwd !== undefined && winPath.isAbsolute(frame.cwd) && !frame.isRemote) {
    // relative cd only resolvable locally against a known ABSOLUTE cwd; a relative/unknown anchor
    // stays unknown (never drag in the host's process.cwd() — Opus #495 P3).
    frame.cwd = winPath.resolve(frame.cwd, target);
  } else {
    frame.cwd = undefined;
  }
}
