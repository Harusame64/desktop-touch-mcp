// ADR-014 v2 R3 Key Locker — L1: command → binding derivation (never screen-scraped).
//
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md (§4)
//
// Parse the command string the MCP DISPATCHED (we typed it; the secret value is never read here),
// in the context of the pane's session. Two layers: a PURE classification core (tokenize + pick
// the first credential-bearing program + apply the null rules) and ASYNC resolvers for the parts
// that genuinely need I/O (`ssh -G`/`ssh-keygen` per §3; `git -C <cwd>` for a configured remote).
//
// Direction of failure: ambiguity → null (no binding, no autofill offer — never guess). A missed
// derive is a no-op; a spurious derive is harmless because L3's exit-0 save-gate blocks any wrong
// save. The exhaustive per-flag edge table (which ssh/sudo/git modes do/don't prompt) is owned by
// the test suite, not enumerated here (plan §4 scope note).
//
// Session context is an EXPLICIT input: a bare `sudo …` in an ssh'd pane targets the REMOTE host
// (`session.execHost`), and a bare `git push` resolves its configured remote via `session.cwd` —
// neither is derivable from the command text alone. L3 (capture-on-use) owns supplying it.
// `isRemote` is reserved for L3 (frozen-schema field; L1's own rules key only on execHost, except
// the remote-pane git defer below).

import { basename, resolve as resolvePath } from "node:path";
import type { BindingUri } from "./binding.js";
import { defaultExec, parseSshCommand, resolveCanonicalForSshCommand, type ExecFn } from "./ssh-resolve.js";

export interface SessionContext {
  /** `localhost` for a local pane, or the resolved remote host for an ssh'd pane. */
  execHost: string;
  /** Reserved for L3 (nested-prompt tracking); L1 uses it only to defer remote-pane git. */
  isRemote: boolean;
  /** The pane's working directory — resolves a configured git remote via `git -C`. */
  cwd: string;
}

export interface DeriveBindingDeps {
  exec?: ExecFn;
}

/**
 * Shell-style tokenizer: split into command SEGMENTS at unquoted `&&` / `||` / `;` / `|` / `&` /
 * newline, respecting single/double quotes and backslash escapes (POSIX-ish; the dispatched
 * commands are the ones our own terminal tool typed). Quote characters are stripped.
 */
export function tokenizeCommandSegments(cmd: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  const endToken = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else { cur += ch; started = true; }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) { cur += cmd[++i]; started = true; continue; }
      cur += ch; started = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch as '"' | "'"; started = true; continue; }
    if (ch === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; started = true; continue; }
    if (ch === "&" || ch === "|") {
      endSegment();
      if (cmd[i + 1] === ch) i++; // && / ||
      continue;
    }
    if (ch === ";" || ch === "\n") { endSegment(); continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { endToken(); continue; }
    cur += ch; started = true;
  }
  endSegment();
  return segments;
}

/** Program identity of a token: basename, lowercased, `.exe` stripped. */
function programOf(token: string): string {
  return basename(token).toLowerCase().replace(/\.exe$/, "");
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Derive the binding target of a dispatched command, or `null` when it carries no credential
 * prompt L1 can attribute (query modes, the sudo cannot-prompt set, non-https git remotes,
 * remote-pane git, plain commands, ambiguity). Async: ssh and configured-git-remote derivation
 * resolve through child processes; the classification core itself is pure (plan §4, Codex R10).
 */
export async function deriveBinding(
  dispatchedCommand: string,
  session: SessionContext,
  deps: DeriveBindingDeps = {},
): Promise<BindingUri | null> {
  const exec = deps.exec ?? defaultExec;
  for (const segment of tokenizeCommandSegments(dispatchedCommand)) {
    // Skip leading FOO=bar environment assignments.
    let start = 0;
    while (start < segment.length && ENV_ASSIGN_RE.test(segment[start])) start++;
    if (start >= segment.length) continue;
    const program = programOf(segment[start]);
    const rest = segment.slice(start + 1);
    // The FIRST credential-bearing program wins; later segments are L3's concern.
    if (program === "ssh") return deriveSsh(rest, exec);
    if (program === "sudo") return deriveSudo(rest, session);
    if (program === "git") return deriveGit(rest, session, exec);
  }
  return null;
}

async function deriveSsh(args: string[], exec: ExecFn): Promise<BindingUri | null> {
  // Query / no-login modes never prompt (`-G` config query, `-Q` algorithm query, `-V` version).
  // Modes that still authenticate (-T no-pty, -N no-remote-cmd) derive normally.
  const parsed = parseSshCommand(args);
  if (parsed.queryMode || parsed.destination === undefined) return null;
  const resolved = await resolveCanonicalForSshCommand(args, exec);
  // host-not-known / unresolvable ⇒ fail closed: no binding, no lookup, no save.
  return resolved.kind === "ok" ? resolved.uri : null;
}

// sudo short options that CONSUME the next token (kept minimal; edge flags live in the test table).
const SUDO_FLAGS_WITH_ARG = new Set(["-u", "-g", "-p", "-U", "-C", "-D", "-R", "-T", "-h"]);
// The CANNOT-prompt set is a CLOSED enumeration (plan §4): null iff the invocation provably never
// prompts; everything else derives (a spurious derive is blocked by L3's exit-0 save-gate).
// NOTE: `-h` with no argument is `--help`; sudo's host flag form is `-h host`. We treat a BARE
// trailing `-h` / `--help` / `-V` / `--version` as pure-info (null).

function deriveSudo(args: string[], session: SessionContext): BindingUri | null {
  let targetUser = "root";
  let sawKClear = false;
  let sawOtherOption = false;
  let hasCommand = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "-n" || tok === "--non-interactive") return null; // never prompts (fails instead)
    if (tok === "--help" || tok === "-V" || tok === "--version") return null; // pure-info
    if (tok === "-h" && i === args.length - 1) return null; // bare -h = help
    if (tok === "-k" || tok === "-K") { sawKClear = true; continue; }
    // All four sudo user-selection forms bind targetUser (Codex R2 P2 — an unrecognized form
    // would silently fall through and mislabel the binding as sudo://…/root):
    if (tok === "-u" && i + 1 < args.length) { targetUser = args[++i]; sawOtherOption = true; continue; }
    if (tok.startsWith("-u") && tok.length > 2) { targetUser = tok.slice(2); sawOtherOption = true; continue; } // attached: -udeploy
    if (tok.startsWith("--user=")) { targetUser = tok.slice("--user=".length); sawOtherOption = true; continue; }
    if (tok === "--user" && i + 1 < args.length) { targetUser = args[++i]; sawOtherOption = true; continue; }
    if (SUDO_FLAGS_WITH_ARG.has(tok)) { i++; sawOtherOption = true; continue; }
    if (tok.startsWith("-")) { sawOtherOption = true; continue; } // -l / -v / -s / -i … may prompt
    hasCommand = true;
    break;
  }
  // BARE means -k/-K and nothing but clear flags: such an invocation clears the credential
  // timestamp(s) and exits — cannot prompt. `sudo -k <cmd>` runs the command and `sudo -k -v` /
  // `-k -l` are force-reprompt validation/list modes (Codex impl-R1 P2) — all of those derive.
  if (sawKClear && !hasCommand && !sawOtherOption) return null;
  if (targetUser.length === 0) return null; // `-u ''` — ambiguous, never guess
  return { scheme: "sudo", host: session.execHost.toLowerCase(), targetUser };
}

const GIT_CRED_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);
// Per-subcommand option letters/words that consume a separate argument token (minimal set; the
// exhaustive per-flag table is the test suite's — a miss here fails toward null or a skipped opt).
const GIT_ARG_OPTS: Record<string, Set<string>> = {
  push: new Set(["-o", "--push-option", "--receive-pack", "--exec"]), // --repo is captured as the target below
  pull: new Set(["--depth", "-j", "--jobs", "--upload-pack", "--negotiation-tip", "--server-option", "-o", "-s", "-X", "--strategy", "--strategy-option"]),
  fetch: new Set(["--depth", "-j", "--jobs", "--upload-pack", "--negotiation-tip", "--server-option", "-o", "--refmap", "--shallow-since", "--shallow-exclude"]),
  clone: new Set(["-b", "--branch", "-o", "--origin", "--depth", "-c", "--config", "--reference", "--reference-if-able", "--separate-git-dir", "-j", "--jobs", "--filter", "-u", "--upload-pack", "--template", "--shallow-since", "--shallow-exclude"]),
  "ls-remote": new Set(["-o", "--upload-pack", "--server-option"]),
};

async function deriveGit(args: string[], session: SessionContext, exec: ExecFn): Promise<BindingUri | null> {
  // In a REMOTE pane git runs remotely — a local `git -C cwd` cannot resolve its remotes. Defer
  // to L3 (same cut as the nested `ssh host sudo …`).
  if (session.isRemote) return null;

  // Global options before the subcommand: honor `-C <path>` (changes the effective cwd), skip
  // `-c k=v` / `--git-dir=…`-style value options, null on version/help.
  let cwd = session.cwd;
  let i = 0;
  let sub: string | undefined;
  for (; i < args.length; i++) {
    const tok = args[i];
    if (tok === "-v" || tok === "-V" || tok === "--version" || tok === "-h" || tok === "--help") return null;
    if (tok === "-C" && i + 1 < args.length) { cwd = resolvePath(cwd, args[++i]); continue; }
    if (tok === "-c" && i + 1 < args.length) { i++; continue; }
    if (tok.startsWith("--") && tok.includes("=")) continue; // --git-dir=… / --work-tree=…
    if (tok.startsWith("-")) continue;
    sub = tok.toLowerCase();
    i++;
    break;
  }
  if (sub === undefined || !GIT_CRED_SUBCOMMANDS.has(sub)) return null;

  // `git fetch --all` / `--multiple …` (and `git pull --all`, which forwards to fetch) contact
  // MULTIPLE remotes — there is no single credential target, and deriving the branch remote could
  // save/offer under the wrong one (Codex impl-R1 P1). Ambiguity → null. (`git push --all` pushes
  // all BRANCHES to one remote and stays derivable.)
  if ((sub === "fetch" || sub === "pull") && args.slice(i).some((t) => t === "--all" || t === "--multiple")) {
    return null;
  }
  if (sub === "fetch" && args.slice(i).includes("-m")) return null; // -m = --multiple (fetch only; pull's -m is a merge option)

  // First non-option token after the subcommand = the repository (a URL or a remote NAME).
  const argOpts = GIT_ARG_OPTS[sub];
  let repoArg: string | undefined;
  for (; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--") { repoArg = args[i + 1]; break; }
    if (tok.startsWith("--repo=")) { repoArg = tok.slice("--repo=".length); break; } // push's explicit target
    if (tok === "--repo" && i + 1 < args.length) { repoArg = args[i + 1]; break; }
    if (tok.startsWith("-")) {
      if (argOpts.has(tok)) i++;
      continue;
    }
    repoArg = tok;
    break;
  }

  if (repoArg !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(repoArg)) {
    return parseHttpsRemote(repoArg); // explicit URL (https derives; ssh/git/http → null)
  }
  if (repoArg !== undefined && /[:/]/.test(repoArg)) {
    return null; // scp-like (git@host:path) or a filesystem path — not an https credential
  }

  // A remote NAME (explicit arg wins) — else resolve git's EFFECTIVE remote for the op via the
  // precedence chain, NEVER a hard-coded `origin` (plan §4, Codex R9/R10): resolve the NAME first,
  // then ask for that remote's URL (`remote get-url [--push]` observes pushurl).
  if (sub === "clone") return null; // clone without a URL never reaches a prompt we can attribute
  const git = async (...gitArgs: string[]) => exec("git", ["-C", cwd, ...gitArgs]);
  let remoteName = repoArg;
  if (remoteName === undefined) {
    const branch = await git("symbolic-ref", "--short", "HEAD");
    const cur = branch.code === 0 ? branch.stdout.trim() : undefined;
    const config = async (key: string) => {
      const r = await git("config", "--get", key);
      return r.code === 0 ? r.stdout.trim() : undefined;
    };
    if (sub === "push") {
      remoteName = (cur !== undefined ? await config(`branch.${cur}.pushRemote`) : undefined)
        ?? await config("remote.pushDefault")
        ?? (cur !== undefined ? await config(`branch.${cur}.remote`) : undefined)
        ?? "origin";
    } else {
      remoteName = (cur !== undefined ? await config(`branch.${cur}.remote`) : undefined) ?? "origin";
    }
  }
  // For push, list ALL push URLs (`get-url --push` alone returns just the first): a remote with
  // multiple pushurls contacts every one of them, so there is no single credential target and a
  // later URL's prompt would be bound under the wrong host (Codex R2 P2) — ambiguity → null.
  // Fetch uses only its first URL, so the plain single-URL form is correct there.
  const url = await git("remote", "get-url", ...(sub === "push" ? ["--push", "--all"] : []), remoteName);
  if (url.code !== 0) return null; // no such remote / not a repo — never guess
  const urls = url.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (urls.length !== 1) return null;
  return parseHttpsRemote(urls[0]);
}

/** An https remote URL → `https-cred://…`; any other transport → null (not an https credential). */
function parseHttpsRemote(rawUrl: string): BindingUri | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return {
    scheme: "https-cred",
    user: u.username !== "" ? decodeURIComponent(u.username) : undefined,
    host: u.hostname.toLowerCase(),
    port: u.port !== "" ? Number(u.port) : 443,
    path: path !== "" ? path : undefined,
  };
}
