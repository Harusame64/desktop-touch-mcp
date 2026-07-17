// ADR-014 v2 R3 Key Locker — L1: ssh host-key fingerprint resolution (OQ-1 = A).
//
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md (§3)
//
// Resolve an ssh alias to its EFFECTIVE (user, host, port) via `ssh -G` — passing the invocation's
// own options THROUGH (a command-line `-p 2222` / `-l user` / `-F altconfig` / `-o …` / a config
// `HostKeyAlias` all change the endpoint; `ssh -G alias` alone would resolve the WRONG one) — then
// read the host's stored key fingerprints from the known_hosts files ssh itself would consult
// (user `UserKnownHostsFile` + `GlobalKnownHostsFile`, each possibly multiple paths; absent files
// are skipped as EMPTY, never as failure). The fingerprint SET becomes part of the canonical key:
// if the recorded host identity drifts, the key differs, the store misses, and nothing autofills.
//
// `ssh -G` prints the effective config WITHOUT connecting; `ssh-keygen -l -F` handles hashed
// known_hosts entries and prints one SHA256 fingerprint per stored key type. We never parse
// ~/.ssh/config ourselves. Read-only, no network, no secret at this layer.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalFpSet, canonicalKey, type BindingUri } from "./binding.js";

const execFileAsync = promisify(execFile);

/** Injectable process runner (tests fake `ssh -G` / `ssh-keygen` output through this seam). */
export type ExecFn = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const EXEC_TIMEOUT_MS = 10_000;

/** Default runner: async execFile, non-zero exit normalized into `code` (never throws for it). */
export const defaultExec: ExecFn = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      windowsHide: true,
      timeout: EXEC_TIMEOUT_MS,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (err instanceof Error ? err.message : String(e)),
    };
  }
};

// OpenSSH client option letters (`man ssh` synopsis): which short flags CONSUME the next token. The
// no-arg letters are enumerated in SSH_FLAGS_NO_ARG below — the two sets are a CLOSED allow-list, so a
// letter in neither is NOT assumed no-arg (that assumption is what `undecidable` exists to refuse).
// Exported for the §1.3.1 drift guard (a unit canary re-derives both sets from the local ssh's own usage
// synopsis, so an OpenSSH upgrade that moves a letter fails loudly instead of silently costing autofill).
export const SSH_FLAGS_WITH_ARG = new Set([..."BbcDEeFIiJLlmOoPpQRSWw"]);
// The COMPLEMENT of SSH_FLAGS_WITH_ARG: every option letter we KNOW takes no argument. Same source (the
// `man ssh` synopsis cluster `[-46AaCfGgKkMNnqsTtVvXxYy]`), plus `2`, which the synopsis omits but every
// build still ACCEPTS as a no-op (measured: `ssh -2 -G host` prints the config on OpenSSH 9.5p2 and
// 10.3p1) — so `ssh -2 host` opens a REAL session and must classify as a login.
//
// `1` is deliberately in NEITHER list. The synopsis omits it and the real ssh is FATAL on it
// (`SSH protocol v.1 is no longer supported`), so no session ever opens; listing it as no-arg would make
// us confidently classify `ssh -1 host` as an interactive login and push a remote frame for a pane that
// never left local — a later `sudo` would then fill a REMOTE secret into a LOCAL prompt. A retired letter
// is indistinguishable from a letter we have simply never heard of, and both must decline.
//
// Together the two sets are a CLOSED allow-list: a letter in NEITHER makes the parse `undecidable`,
// because without knowing whether it consumes the next token we can locate neither the destination nor the
// remote-command boundary — and guessing either way fails toward DISCLOSURE.
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-complete-fix-plan.md §1.3 / PR1.1
export const SSH_FLAGS_NO_ARG = new Set([..."246AaCfGgKkMNnqsTtVvXxYy"]);

export interface ParsedSshCommand {
  /** The destination token (`host` or `user@host`), or undefined if none was found. */
  destination?: string;
  /**
   * Every option token (and its value), in order, from ANYWHERE before the remote command begins —
   * including AFTER the destination, which is where real ssh accepts them too. Passed to `ssh -G` verbatim.
   */
  optionArgs: string[];
  /** True if the invocation is a query / no-login mode (`-G` / `-Q` / `-V`) — never prompts. */
  queryMode: boolean;
  /**
   * Every OPTION FLAG LETTER seen before the remote command (getopt clusters expanded: `-fN` → {f,N};
   * `-4p 2222` → {4,p}), EXCLUDING the VALUES of with-arg flags (`-p 2222` contributes `p`, not
   * `2222`; `-F fname` contributes `F`, not `fname`). Lets a caller detect session-shape flags like
   * `-f` (background) / `-N` (no remote command) / `-W` (stdio-forward, implies -N/-T) without
   * re-parsing. Only FLAG letters, so a with-arg value that happens to contain N/f/W never false-triggers.
   */
  flagLetters: ReadonlySet<string>;
  /**
   * The remote command: every token from the FIRST non-option token AFTER the destination to the end of
   * argv, verbatim. Empty ⇒ the invocation opens a LOGIN SHELL on this tty.
   *
   * This mirrors OpenSSH `ssh.c`'s own two-pass argv rule (NOT platform getopt permutation, which is why it
   * is identical across builds): getopt → the first non-option is the DESTINATION → `goto again` → getopt
   * runs AGAIN over the remainder → the first non-option after THAT begins the remote command, and
   * everything from there is passed through untouched (never re-parsed as options). So `ssh h -p 2222` has
   * NO remote command (measured: the live pane reached the :2222 sshd), while `ssh h ls -la` has
   * `["ls","-la"]` and the `-la` belongs to the remote `ls`.
   */
  remoteCommand: string[];
  /**
   * The parse is NOT trustworthy: an option letter outside BOTH allow-lists was seen (we cannot know
   * whether it consumed the next token, so neither the destination nor the remote-command boundary is
   * reliable), OR no destination could be located outside a query mode. Security consumers MUST sink to
   * UNKNOWN on this — never "no session" (that is the F-3 inversion: it trusts a pane as LOCAL while a
   * remote login is open).
   */
  undecidable: boolean;
  /**
   * A CONFIRMED with-arg option was left without a value (`ssh h -p`): ssh rejects this as a local usage
   * error (`option requires an argument -- p`, exit 255) BEFORE any session opens. Not a doubt — a known
   * outcome, which is why it is a separate channel from `undecidable`:
   *
   *   `undecidable` = we do not know what ssh will do  ⇒ callers DECLINE (sink to UNKNOWN)
   *   `malformed`   = we know ssh will fail locally     ⇒ callers may treat it as a PROVEN non-login
   *
   * Collapsing the two would be wrong in both directions: sinking a pane to UNKNOWN over a typo costs it
   * autofill until it is re-anchored (recovery is a future item), while trusting a doubt as a non-login is
   * the F-3 inversion itself. The guarantee rests on the letter really being with-arg — that is what
   * `SSH_FLAGS_WITH_ARG` asserts and what the §1.3.1 drift canary keeps honest.
   *
   * The condition is deliberately narrow: a KNOWN with-arg letter, unattached, with no token left to
   * consume. Nothing else belongs here — `ssh -p h` consumes `h` as the value (not malformed; it is
   * `undecidable` for want of a destination).
   */
  malformed: boolean;
}

/**
 * Split an `ssh …` argv (WITHOUT the leading program token) into passthrough options, the destination,
 * and the remote command, using OpenSSH's OWN two-pass argv rule (`ssh.c`: getopt → destination →
 * `goto again` → getopt → first non-option begins the remote command). Options are therefore recognised
 * AFTER the destination too — `ssh h -p 2222` really does connect to port 2222.
 *
 * The pre-F-3 parser stopped at the destination and silently dropped every option behind it, so
 * `ssh user@h -p 2222` resolved as port 22: the wrong endpoint's secret could be typed into this one's
 * prompt, and `ssh h -v` was misread as a one-shot command ⇒ the pane was trusted LOCAL while a remote
 * login was open. See the findings + plan docs
 * (desktop-touch-mcp-internal:docs/adr-014-v2-r3x-la-live-dogfood-findings.md F-3, §1.2 of the fix plan).
 *
 * KNOWN GAP (deliberate, fail-safe direction): LONG options are not modelled — `--` (end-of-options),
 * `--help`, `--version`. Real ssh accepts them (`ssh -G -- host` prints the config, i.e. a session would
 * open), but their first letter (`-`, `h`, `v` after the leading `--`) lands outside both allow-lists, so
 * the parse is `undecidable` and every consumer DECLINES.
 *
 * The cost is bigger than the invocation: `recordDispatch` maps `undecidable` to `markUnknown`, and an
 * UNKNOWN pane does not recover on its own (see `markUnknown`'s doc — recovery is a future item), so the
 * PANE stops autofilling until it is re-anchored, not just that one command. Accepted anyway: the
 * alternative is guessing an option's arity, and a wrong guess mis-locates the destination — that is the
 * disclosure direction. Nothing is ever mis-targeted here.
 */
export function parseSshCommand(args: readonly string[]): ParsedSshCommand {
  const optionArgs: string[] = [];
  const flagLetters = new Set<string>();
  let destination: string | undefined;
  let queryMode = false;
  let remoteCommand: string[] = [];
  let undecidable = false;
  let malformed = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    // An option token is an option WHEREVER it appears until the remote command has begun — ssh's second
    // getopt pass sees post-destination options exactly the same way (F-3's root fix is this guard).
    if (remoteCommand.length === 0 && tok.startsWith("-") && tok.length >= 2) {
      optionArgs.push(tok);
      // Walk the getopt cluster left-to-right. No-arg letters accumulate; the FIRST with-arg letter
      // (`p`/`F`/`o`/`W`/…) consumes its VALUE — the rest of THIS token if attached (`-p2222`,
      // `-Qcipher`), else the NEXT token (`-p 2222`) — and ends the cluster (the remaining chars are
      // that value, not more flags). Walking every letter (not just tok[1]) is what stops `-4p 2222`
      // being misread as a no-arg cluster whose value `2222` is then taken as the destination
      // (Codex #495 R5 P2). Query letters (`-G`/`-V`, and `-Q` which takes an arg but still just
      // lists+exits) may appear anywhere in the cluster.
      for (let c = 1; c < tok.length; c++) {
        const L = tok[c];
        flagLetters.add(L);
        if (L === "G" || L === "V") queryMode = true;
        if (SSH_FLAGS_WITH_ARG.has(L)) {
          if (L === "Q") queryMode = true;
          const attached = c < tok.length - 1; // the value is the rest of THIS token
          if (!attached) {
            // The value is the NEXT token — unless there is none, in which case getopt hands ssh a usage
            // error and it exits before opening anything. Recording that is what stops `ssh h -p` from
            // looking like a login (the pane never left local, so pushing a remote frame would mislabel it).
            if (i + 1 < args.length) optionArgs.push(args[++i]);
            else malformed = true;
          }
          break;
        }
        // A letter in NEITHER allow-list: we cannot know whether it eats the next token, so every
        // boundary after it is a guess. Mark the parse untrustworthy but KEEP scanning so `flagLetters`
        // stays as complete as it can be (no `break` — the caller declines on `undecidable` anyway).
        if (!SSH_FLAGS_NO_ARG.has(L)) undecidable = true;
      }
      continue;
    }
    if (destination === undefined) {
      destination = tok;
      continue;
    }
    // The first non-option token AFTER the destination begins the remote command; ssh passes everything
    // from here through untouched, so we keep it verbatim and stop parsing (a trailing `-la` belongs to
    // the remote `ls`, not to ssh).
    remoteCommand = args.slice(i);
    break;
  }
  // An argv we cannot even find a destination in is not a "no session" verdict — it is NO verdict. Query
  // modes are exempt: `ssh -V` / `ssh -Q cipher` have no destination BY DESIGN and stay clean `none`s.
  if (!queryMode && destination === undefined) undecidable = true;
  return { destination, optionArgs, queryMode, flagLetters, remoteCommand, undecidable, malformed };
}

export interface SshEffectiveConfig {
  host: string;
  user: string;
  port: number;
  hostKeyAlias?: string;
  /** Candidate known_hosts paths (user + global), `~` expanded, order preserved. */
  knownHostsFiles: string[];
  /** Effective ProxyJump (from `-J` — ssh maps it to ProxyJump — or config). */
  proxyJump?: string;
  /** Effective ProxyCommand (may itself be an ssh that prompts first). */
  proxyCommand?: string;
}

/** `~/…` → absolute (ssh -G may print unexpanded tildes for known_hosts paths). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Run `ssh -G <options…> <destination>` and parse the effective, last-wins config tokens.
 * Throws on a non-zero exit (unknown host alias syntax, bad -F path, …) — the caller treats that
 * as "cannot resolve" (fail closed).
 */
export async function sshDashG(
  destination: string,
  optionArgs: readonly string[],
  exec: ExecFn = defaultExec,
): Promise<SshEffectiveConfig> {
  const { code, stdout, stderr } = await exec("ssh", ["-G", ...optionArgs, destination]);
  if (code !== 0) {
    throw new Error(`ssh -G exited ${code}: ${stderr.trim().slice(0, 300)}`);
  }
  return parseSshDashGOutput(stdout, destination);
}

/** Parse `ssh -G` stdout into the effective, last-wins config. `destinationForError` only labels errors. */
function parseSshDashGOutput(stdout: string, destinationForError: string): SshEffectiveConfig {
  let host = "";
  let user = "";
  let port = 22;
  let hostKeyAlias: string | undefined;
  let proxyJump: string | undefined;
  let proxyCommand: string | undefined;
  const knownHostsFiles: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const key = line.slice(0, sp).toLowerCase();
    const value = line.slice(sp + 1).trim();
    switch (key) {
      case "hostname": host = value; break;
      case "user": user = value; break;
      case "port": { const p = Number(value); if (Number.isInteger(p) && p > 0) port = p; break; }
      case "hostkeyalias": hostKeyAlias = value; break;
      case "proxyjump": proxyJump = value; break;
      case "proxycommand": proxyCommand = value; break;
      case "userknownhostsfile":
      case "globalknownhostsfile": {
        // The value is a whitespace-separated file list. A path CONTAINING spaces is ambiguous in
        // ssh's own output, so also keep the raw value as one candidate; absent candidates are
        // skipped as empty at lookup time either way.
        for (const cand of value.split(/\s+/)) knownHostsFiles.push(expandTilde(cand));
        if (/\s/.test(value)) knownHostsFiles.push(expandTilde(value));
        break;
      }
    }
  }
  if (host === "" || user === "") {
    throw new Error(`ssh -G output missing hostname/user for '${destinationForError}'`);
  }
  return { host, user, port, hostKeyAlias, knownHostsFiles, proxyJump, proxyCommand };
}

const FP_RE = /SHA256:[A-Za-z0-9+/]+/g;

/**
 * Union the SHA-256 fingerprints stored under ANY of the candidate `tokens` across the given
 * known_hosts files. Absent files (or `ssh-keygen` failures for one file/token) are treated as
 * EMPTY, never as failure — `ssh -G` routinely reports paths that do not exist. Deduped + sorted
 * (§2.2 determinism).
 */
export async function knownHostsFingerprints(
  tokens: readonly string[],
  files: readonly string[],
  exec: ExecFn = defaultExec,
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of new Set(files)) {
    // NO `existsSync(file)` pre-filter (DF-3, live dogfood 2026-07-08): `ssh -G` reports known_hosts
    // paths in the SSH BINARY'S OWN world. Git-for-Windows' MSYS OpenSSH — very commonly first on a
    // Windows PATH — prints POSIX paths like `/c/Users/you/.ssh/known_hosts` that Windows
    // `fs.existsSync` cannot stat, so the old guard dropped EVERY candidate file ⇒ the host was always
    // "not known" ⇒ the derivation returned null ⇒ autofill SILENTLY never fired for anyone whose PATH
    // `ssh` is Git's. `ssh-keygen -F -f <file>` already returns non-zero for an absent/unreadable file
    // (skipped just below), so it is the sole, format-correct arbiter — and Node resolves the SAME ssh
    // family for `ssh-keygen`, so an MSYS path emitted by MSYS `ssh -G` is read by MSYS `ssh-keygen`.
    for (const token of new Set(tokens)) {
      const { code, stdout } = await exec("ssh-keygen", ["-l", "-F", token, "-f", file]);
      if (code !== 0) continue; // host not in this file under this token — skip, keep unioning
      for (const m of stdout.match(FP_RE) ?? []) found.add(m);
    }
  }
  return canonicalFpSet([...found]);
}

export type SshResolveResult =
  | { kind: "ok"; uri: BindingUri & { scheme: "ssh" }; canonical: string }
  | { kind: "host-not-known"; user: string; host: string; port: number }
  | { kind: "unresolvable"; reason: string };

/**
 * §3.3 — the P2-1 defense pipeline: parse the ssh argv, `ssh -G` with the SAME options, form the
 * known_hosts lookup token from the EFFECTIVE output (`hostkeyalias` ?? host[:port]), union the
 * fingerprints over every file ssh would consult. Empty union ⇒ `host-not-known` (fail closed,
 * no lookup, no save). `args` excludes the leading `ssh` program token.
 */
export async function resolveCanonicalForSshCommand(
  args: readonly string[],
  exec: ExecFn = defaultExec,
): Promise<SshResolveResult> {
  const parsed = parseSshCommand(args);
  // An argv we cannot classify has a GUESSED destination and a guessed option/command split, so which
  // endpoint we would bind — i.e. whose prompt this secret gets typed into — is a guess too. Fail closed
  // HERE, not only in `deriveSsh`: this is an exported engine seam, and containment must not rest on what
  // today's callers happen to pass (強制命令 7). The other caller (`key-locker-tool.ts`) builds its argv
  // itself and never produces an undecidable parse, so this costs nothing.
  if (parsed.undecidable) return { kind: "unresolvable", reason: "unclassifiable ssh argv (unknown option letter)" };
  // A with-arg option with no value never runs: ssh answers with a usage error, so there is nothing to
  // bind. Stated explicitly rather than relied upon: without this, the decline happens only as a side
  // effect of how the argv is reassembled below (the dangling option swallows the destination, ssh then
  // errors for want of one). That is true today, but it is an accident of reconstruction order, not a
  // guarantee — and it costs a pointless spawn to discover.
  if (parsed.malformed) return { kind: "unresolvable", reason: "malformed ssh argv (option with no value)" };
  if (parsed.destination === undefined) return { kind: "unresolvable", reason: "no ssh destination" };
  let cfg: SshEffectiveConfig;
  try {
    // Pass the OPTIONS ONLY — never the remote command. `optionArgs` now carries post-destination options
    // too (the F-3 two-pass fix), so this yields the same endpoint handing `ssh -G` the whole argv would,
    // WITHOUT putting the remote command on ssh.exe's command line: `ssh h mysql -pS3CR3T` would otherwise
    // publish that secret to every process that can read our argv (Opus R1 P2-1). The same threat model
    // already bans the dispatched command from the diagnostic log; process arguments are no different.
    cfg = await sshDashG(parsed.destination, parsed.optionArgs, exec);
  } catch (e) {
    return { kind: "unresolvable", reason: (e as Error).message };
  }
  // A ProxyJump (`-J` on the command line — ssh maps it to ProxyJump, so it shows up here even
  // though we never parse it ourselves — or from config) or a ProxyCommand means the FIRST
  // password prompt may belong to the JUMP host, not the final destination. Binding the final
  // host would put the wrong secret into the bastion prompt (Codex impl-R1 P1). Ambiguity → no
  // derivation; the per-hop prompts are an L3 capture-on-use concern (same cut as nested
  // `ssh host sudo …`).
  if (cfg.proxyJump !== undefined || cfg.proxyCommand !== undefined) {
    return { kind: "unresolvable", reason: "ProxyJump/ProxyCommand present — the first prompt may be the jump host's" };
  }
  // Lookup-token candidates: an alias is looked up verbatim; non-default ports use the
  // `[host]:port` form. For the DEFAULT port, also try `[host]:22` — known_hosts rows written
  // with an explicit :22 (common for IPv6 / other tooling) don't match the bare-host lookup
  // (`ssh-keygen -F '::1'` misses a `[::1]:22` row — Codex R4), which would fail-closed a host
  // the user already trusts. Union across candidates only ever ADDS fps the user stored for this
  // exact host:port, so the fail-closed direction is preserved.
  const tokens = cfg.hostKeyAlias !== undefined
    ? [cfg.hostKeyAlias]
    : cfg.port === 22
      ? [cfg.host, `[${cfg.host}]:22`]
      : [`[${cfg.host}]:${cfg.port}`];
  const fpSet = await knownHostsFingerprints(tokens, cfg.knownHostsFiles, exec);
  if (fpSet.length === 0) {
    return { kind: "host-not-known", user: cfg.user, host: cfg.host, port: cfg.port };
  }
  // `ssh -G` prints IPv6 hostnames UNBRACKETED (`::1`); the grammar's host slot is the bracketed
  // form (`[::1]`), so bracket here — otherwise the stored displayUri would not re-parse (the
  // round-trip invariant every other scheme upholds). The known_hosts token above stays bare,
  // matching how ssh itself writes IPv6 entries.
  const host = cfg.host.includes(":") && !cfg.host.startsWith("[")
    ? `[${cfg.host.toLowerCase()}]`
    : cfg.host.toLowerCase();
  const uri: BindingUri & { scheme: "ssh" } = {
    scheme: "ssh",
    user: cfg.user,
    host,
    port: cfg.port,
    fpSet,
  };
  return { kind: "ok", uri, canonical: canonicalKey(uri) };
}
