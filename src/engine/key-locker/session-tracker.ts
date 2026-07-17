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
   * Apply a command's session EFFECT immediately: an interactive `ssh user@host` pushes a remote
   * frame; a `cd <path>` updates cwd. A command in an UNKNOWN pane leaves it unknown. After this call
   * `get()` returns the POST-effect state (the nested-ssh tests pin this).
   *
   * ORDERING CONTRACT for the L3 §1 manager (Opus #495 P2-1): derive a credential command's OWN
   * binding from `get()` taken BEFORE this call — the PRE-effect frame the command actually runs from —
   * then call `recordDispatch` to apply the effect for SUBSEQUENT commands. So a nested `ssh b@host-b`
   * launched from a `host-a` session is derived in the `host-a` frame (its pre-push context; §4 of the
   * L1 plan), and only afterward does the `host-b` frame become current. Derive-then-record, never
   * record-then-derive.
   */
  recordDispatch(paneId: string, command: string): void {
    const st = this.panes.get(paneId);
    if (st === undefined || st.stack === null) return; // unknown / never-anchored — stays unknown

    // Scan EVERY segment for a session-changing program (Opus R1 P1-1: `cd x && ssh host` must still
    // REACH the ssh — do not `return` after cd). The FIRST ssh-in wins the session change. Each
    // segment also carries whether it is CONDITIONALLY reached (`&&` / `||`) — a branch the shell may
    // skip, which we must not treat as a reliable session change (Codex #495 P1).
    const segments = tokenizeCommandSegmentsWithOps(command);
    for (let idx = 0; idx < segments.length; idx++) {
      const { tokens: segment, conditional, backgrounded, pipedStdin } = segments[idx];
      // Skip leading FOO=bar env-assignments (Opus R1 P1-1: `LC_ALL=C ssh user@host` must still detect
      // the ssh) AND leading shell REDIRECTIONS, which the shell applies before exec and can precede the
      // program token (`>log ssh host`, `2>err ssh host`, `< in ssh host` — Codex #495 R9 P2). A leading
      // redirect that touches fd 0 (STDIN) takes ssh's stdin off the tty, so — like a backgrounded/piped
      // ssh — it opens no interactive login even though the program token is `ssh`; remember that.
      let start = 0;
      let leadingStdinRedir = false;
      for (;;) {
        const tok = segment[start];
        if (tok === undefined) break;
        if (ENV_ASSIGN_RE.test(tok)) { start++; continue; }
        const r = redirTokenAt(segment, start);
        if (r === null) break; // the real program token
        if (r.touchesStdin) leadingStdinRedir = true;
        start += r.consumed; // skip the redirect (and its following target token if the operator is bare)
      }
      const program = programOf(segment[start]);
      if (program === "ssh") {
        // An ssh that cannot grab THIS pane's tty opens no interactive login and returns the shell to
        // the LOCAL prompt — treat it, like a one-shot / query, as non-session-opening (no push, keep
        // scanning). Three such shapes: a BACKGROUNDED `ssh host &` (Codex #495 P1), a DOWNSTREAM pipe
        // stage `… | ssh host` whose stdin is the pipe, not the tty (Opus #495 R4 P2), and a LEADING
        // fd-0 redirect `< in ssh host` / `0>f ssh host` (Codex #495 R9) — pushing a remote frame in any
        // of them would mislabel a later LOCAL `sudo`/git as remote → wrong-target.
        const cls: SshLoginClass = backgrounded || pipedStdin || leadingStdinRedir
          ? { kind: "none" }
          : classifySshLogin(segment.slice(start + 1));
        // An UNCLASSIFIABLE ssh could be opening a login we cannot see. Trusting the pane as local would
        // fill a LOCAL secret into a REMOTE prompt (F-3's derivative); pushing a guessed frame would
        // mislabel a later local command. Neither is honest ⇒ sink to UNKNOWN and decline.
        if (cls.kind === "undecidable") { this.markUnknown(paneId); return; }
        const remote = cls.kind === "interactive" ? cls.host : null;
        if (remote !== null) {
          // A conditional (`&&` / `||`) ssh may or may not actually run — unknowable at dispatch time.
          // Pushing a remote frame that never materializes strands the pane as remote (no ssh child
          // for the watch to pop) → wrong-targets a later LOCAL command; staying local wrong-targets
          // the other way if it DID run. The honest state is UNKNOWN → decline (Codex #495 P1). An
          // unconditional ssh is a reliable prediction → push.
          if (conditional) { this.markUnknown(paneId); return; }
          // An interactive login BLOCKS the pane until it exits; only THEN do any SEQUENTIALLY-trailing
          // segments run — locally, possibly re-entering another host or cd'ing (`ssh a ; ssh b`, `ssh
          // a ; cd X`). A single pushed frame + the watch's later pop would land on the PRE-trailing
          // state (localhost / old cwd) while the shell has moved on → wrong-target. That future
          // trajectory is unmodelable from one snapshot, so sink to UNKNOWN when a sequential command
          // follows the login (Codex #495 R5 P1). A DOWNSTREAM PIPE stage (`ssh a | tee`) is NOT
          // sequential — it runs CONCURRENTLY with the login and shares its lifetime — so a trailing
          // run of pipe stages (all `pipedStdin`) does not force unknown; a login whose only followers
          // are its own pipe stages (or nothing) is the clean common case → push.
          if (segments.slice(idx + 1).some((s) => !s.pipedStdin)) { this.markUnknown(paneId); return; }
          st.stack.push({ execHost: remote, isRemote: true, cwd: undefined });
          return; // an interactive login opened and only its pipe stages follow — the pane is now remote.
        }
        // A one-shot `ssh host cmd`, a query (`-G`/`-Q`/`-V`), or a backgrounded `ssh host &` opens NO
        // session in THIS pane. Do NOT stop the scan at the first ssh token (Codex #495 P1): a LATER
        // `; ssh host` / `; cd X` in the same dispatched line still changes the session — keep scanning.
        continue;
      }
      if (program === "cd") {
        if (backgrounded || pipedStdin) {
          // A backgrounded `cd path &` or a downstream-pipe `… | cd path` runs the `cd` builtin in a
          // SUBSHELL — a background job is always a subshell, and (job control being active in an
          // interactive pane) so is a pipeline stage — so the FOREGROUND prompt stays in the current
          // directory; the child's chdir dies with it. No effect on the pane cwd: leave it AS-IS and
          // keep scanning. Mirrors the backgrounded/piped ssh non-session rule above (Codex #495 P2).
        } else if (conditional) {
          // A conditional cd's destination is unpredictable — drop cwd to unknown (git derivation then
          // declines) rather than trust a directory the shell may not have entered (Codex #495 P1).
          st.stack[st.stack.length - 1].cwd = undefined;
        } else {
          // Strip redirects from the cd argv (`cd > log /srv` runs `cd /srv` with stdout→log) so the
          // path finder doesn't pick a redirect operator as the target and fabricate a bogus cwd.
          applyCd(st.stack[st.stack.length - 1], stripRedirections(segment.slice(start + 1)));
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
   * How many REMOTE frames are stacked above the base local shell (0 = local / unknown / never
   * anchored). The ssh process-tree watch (SP-L3-OQ-7) reads this to decide, when it observes the
   * pane's outermost ssh child EXIT, between a lone `noteSessionEnd` (depth ≤ 1 — the one visible ssh
   * maps 1:1 to the one remote frame) and `markUnknown` (depth ≥ 2 — NESTED ssh the local process tree
   * cannot see, so a single pop would strand an inner remote frame → a later local command wrong-targets
   * that inner host; Opus L3-3 PR#495 R4 P3). Never a stale trusted `isRemote:true` on doubt.
   */
  remoteDepth(paneId: string): number {
    const st = this.panes.get(paneId);
    if (st === undefined || st.stack === null) return 0;
    return Math.max(0, st.stack.length - 1);
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

/** Leading `FOO=bar` env-assignment (skipped before the program token, mirrors L1). Exported for L3
 *  landed-detection's mode classifier (same env-skip). */
export const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Program identity of a token: basename-ish, lowercased, `.exe` stripped (mirrors L1). Exported for
 *  L3 landed-detection. */
export function programOf(token: string | undefined): string {
  if (token === undefined) return "";
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * A shell REDIRECTION operator at the START of a token. Our tokenizer keeps `>`/`<` glued to their fd
 * and target, so `2>&1`, `>log`, `<&-`, `&>all`, `3<in` arrive as ONE token; a BARE operator (`>`, `2>`,
 * `<`, `3<`, `>&`, `&>`) instead takes the FOLLOWING token as its target.
 *
 * We split redirects by the ONE bit that decides whether an ssh keeps the pane's tty on stdin: does the
 * redirect touch fd 0 (STDIN)?  This single axis subsumes position (before/after the program), fd number,
 * and direction — the whole grammar class Codex #495 R2-R9 chipped at one shape at a time.
 *
 *   TOUCHES fd 0  → ssh's stdin comes off the tty → it runs NON-interactively (like a pipe/one-shot), so
 *     NO remote frame. An UNSPECIFIED-fd input redirect defaults to fd 0 (`<f`, `<<EOF`, `<<<s`, `<&n`,
 *     `<>f`); an EXPLICIT fd-0 redirect (`0<…`, `0>…`, incl. `0>&2`) also targets stdin.
 *   does NOT touch fd 0  → pure I/O plumbing: OUTPUT on fd≥1 (`>log`, `2>&1`, `&>all`, clobber `>|`) or a
 *     NONZERO-fd INPUT redirect (`3<in`, `3<&0`) that leaves stdin alone. STRIP it so it can't skew the
 *     destination parse or the trailing-remote-command count.
 *
 * STDIN_REDIR_RE is tried FIRST (fd-0 forms), so `0>`/`0<`/bare `<` never fall through to the non-stdin
 * arm. Within each, longer operators precede shorter (`<<<`|`<<`|`<[&>]`|`<`, `>&` before `>`) so JS
 * ordered alternation matches the FULL operator — the match length then tells attached-target (`>log`,
 * `2>&1`) from bare (`>`, `<<`), the latter also consuming the following token.
 */
const STDIN_REDIR_RE = /^(?:0(?:>&|>>?\|?|<<<|<<|<[&>]|<)|<<<|<<|<[&>]|<)/;
const NONSTDIN_REDIR_RE = /^(?:[1-9]\d*(?:>&|>>?\|?|<<<|<<|<[&>]|<)|>&|>>?\|?|&>>?)/;

/** Classify the token at `tokens[i]` as a redirection: whether it touches fd 0 and how many tokens it
 *  consumes (2 if the operator is BARE — its target is the following token — else 1). null = not a
 *  redirect, i.e. a real argument / program / destination / remote-command token. */
function redirTokenAt(tokens: readonly string[], i: number): { touchesStdin: boolean; consumed: number } | null {
  const t = tokens[i];
  const sm = STDIN_REDIR_RE.exec(t);
  if (sm !== null) return { touchesStdin: true, consumed: sm[0].length === t.length ? 2 : 1 };
  const nm = NONSTDIN_REDIR_RE.exec(t);
  if (nm !== null) return { touchesStdin: false, consumed: nm[0].length === t.length ? 2 : 1 };
  return null;
}

/**
 * Remove every NON-fd-0 redirection (output on any fd, nonzero-fd input) from an argv, dropping a bare
 * operator's following target too. fd-0 redirects are also removed here (callers that care about the
 * stdin bit use `scanRedirectionsForStdin`); this helper is for consumers that only need the clean argv
 * (e.g. `cd`'s path finder). Returns a new array.
 */
function stripRedirections(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const r = redirTokenAt(tokens, i);
    if (r === null) { out.push(tokens[i]); continue; }
    if (r.consumed === 2) i++; // bare operator → also skip its target token
  }
  return out;
}

/** Strip redirects from an ssh argv AND report whether any of them touched fd 0 (stdin). */
function scanRedirectionsForStdin(tokens: readonly string[]): { touchesStdin: boolean; stripped: string[] } {
  let touchesStdin = false;
  const stripped: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const r = redirTokenAt(tokens, i);
    if (r === null) { stripped.push(tokens[i]); continue; }
    if (r.touchesStdin) touchesStdin = true;
    if (r.consumed === 2) i++;
  }
  return { touchesStdin, stripped };
}

/** How an `ssh` argv (WITHOUT the leading `ssh` token) affects THIS pane's session. Three states, because
 *  two cannot express doubt — and treating doubt as "opens nothing" is exactly the F-3 inversion: the pane
 *  stays trusted-LOCAL while a real remote login is open, and a later `sudo` fills a LOCAL secret into a
 *  REMOTE prompt. Every consumer must map `undecidable` to its own DECLINE.
 *  Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-complete-fix-plan.md §1.3 / PR1.3 */
export type SshLoginClass =
  /** An interactive login shell opened on this pane's tty. `host` is the bare, lowercased destination
   *  label (L1 resolves the real endpoint later). */
  | { kind: "interactive"; host: string }
  /** PROVABLY opens no session in this pane: a query mode (`-G`/`-Q`/`-V`), `-N`/`-f`/`-W`, an argv whose
   *  stdin is off the tty, or a one-shot with a PROVEN remote command. */
  | { kind: "none" }
  /** The argv cannot be classified with confidence (an unknown option letter, or no locatable
   *  destination outside a query mode) ⇒ callers decline. */
  | { kind: "undecidable" };

/**
 * Classify an `ssh` argv (without the leading `ssh`) by what it does to THIS pane's session. Every `none`
 * is PROVEN; every doubt falls through to `undecidable`.
 */
export function classifySshLogin(rawArgs: readonly string[]): SshLoginClass {
  // Redirections are shell I/O plumbing the shell consumes before exec, and they can appear ANYWHERE —
  // before the destination (`ssh 2>&1 host`), after it, or after a remote command. Scan the WHOLE argv:
  // a redirect that TOUCHES fd 0 (`ssh host < in`, `ssh 0>f host`) takes stdin off the tty → the ssh is
  // non-interactive → no session (Codex #495 R9). Otherwise strip the (non-stdin) redirects so a leading
  // one isn't mis-read by parseSshCommand as the destination and the real host as a one-shot remote
  // command → the pane would else stay local while an interactive login opened → later remote `sudo`
  // wrong-targeted to localhost (Codex #495 P2).
  const { touchesStdin, stripped: args } = scanRedirectionsForStdin(rawArgs);
  if (touchesStdin) return { kind: "none" };
  const parsed = parseSshCommand(args);
  // DOUBT OUTRANKS EVERY POSITIVE VERDICT — including a query. If an unknown letter is present we cannot
  // even trust that `-G`/`-V`/`-Q` IS a query: a future with-arg `-z` would eat the next token, so real ssh
  // reads `ssh -z -G h` as "-G is -z's VALUE" and OPENS A SESSION while our flag scan sees a query. Checking
  // queryMode first would answer `none` there ⇒ the pane stays trusted-LOCAL while a remote login is open —
  // the exact silent disclosure `undecidable` exists to prevent (Opus R1 P1-1).
  // This costs nothing for real queries: the parser's post-loop rule already exempts them
  // (`if (!queryMode && destination === undefined) undecidable = true`), so `-V` / `-Q cipher` / `-G h`
  // carry `undecidable === false` and still fall through to the clean `none` below.
  if (parsed.undecidable) return { kind: "undecidable" };
  if (parsed.queryMode) return { kind: "none" };
  // Defensive: the parser's post-loop rule already covers this, but keep it so a future parser change
  // cannot silently re-open the hole.
  if (parsed.destination === undefined) return { kind: "undecidable" };
  // `-N` (no remote command), `-f` (fork to background) and `-W host:port` (forward stdin/stdout,
  // implies -N/-T) do NOT open an interactive login shell in THIS pane: `-N` holds a tunnel, `-f`
  // returns it to the LOCAL prompt, `-W` turns the pane into a stdio conduit for a bastion and exits.
  // Pushing a remote frame would mislabel a later LOCAL command as remote → wrong-target on the
  // fp-less sudo path (#495 P2 / R5 P2). Treat them as non-session-opening — no push.
  if (parsed.flagLetters.has("N") || parsed.flagLetters.has("f") || parsed.flagLetters.has("W")) {
    return { kind: "none" };
  }
  // A one-shot `ssh host cmd …` has a REAL remote-command token after the destination → not an
  // interactive login. The parser locates that boundary with ssh's own two-pass rule, so a POST-
  // DESTINATION OPTION (`ssh host -v`) is no longer miscounted as a command (F-3: the old
  // `optionArgs.length + 1` arithmetic could not tell the two apart, so every trailing option made the
  // pane look local while a login was open).
  if (parsed.remoteCommand.length > 0) return { kind: "none" };
  const at = parsed.destination.lastIndexOf("@");
  const host = at >= 0 ? parsed.destination.slice(at + 1) : parsed.destination;
  return { kind: "interactive", host: host.toLowerCase() };
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
