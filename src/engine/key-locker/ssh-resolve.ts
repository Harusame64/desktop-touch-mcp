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
import { existsSync } from "node:fs";
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

// OpenSSH client option letters (`man ssh` synopsis): which short flags CONSUME the next token.
// (Everything else — 46AaCfGgKkMNnqsTtVvXxYy — is a no-arg flag and falls to the else branch.)
const SSH_FLAGS_WITH_ARG = new Set([..."BbcDEeFIiJLlmOoPpQRSWw"]);

export interface ParsedSshCommand {
  /** The destination token (`host` or `user@host`), or undefined if none was found. */
  destination?: string;
  /** Every option token up to the destination, in order — passed through to `ssh -G` verbatim. */
  optionArgs: string[];
  /** True if the invocation is a query / no-login mode (`-G` / `-Q` / `-V`) — never prompts. */
  queryMode: boolean;
  /**
   * The letters of every NO-ARG flag token seen before the destination (getopt clusters expanded:
   * `-fN` → {f, N}). Only no-arg tokens are scanned, so a with-arg flag's VALUE (`-F fname`, `-o k=v`)
   * never contributes a letter. Lets a caller detect session-shape flags like `-f` (background) /
   * `-N` (no remote command) without re-parsing.
   */
  noArgFlags: ReadonlySet<string>;
}

/**
 * Split an `ssh …` argv (WITHOUT the leading program token) into passthrough options + the
 * destination. Tokens after the destination are the remote command — irrelevant to resolution.
 */
export function parseSshCommand(args: readonly string[]): ParsedSshCommand {
  const optionArgs: string[] = [];
  const noArgFlags = new Set<string>();
  let destination: string | undefined;
  let queryMode = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (destination === undefined && tok.startsWith("-") && tok.length >= 2) {
      const letter = tok[1];
      if (letter === "G" || letter === "V" || letter === "Q") queryMode = true;
      if (SSH_FLAGS_WITH_ARG.has(letter)) {
        if (tok.length > 2) {
          optionArgs.push(tok); // attached form: -p2222 / -Qcipher
        } else {
          optionArgs.push(tok);
          if (i + 1 < args.length) optionArgs.push(args[++i]);
        }
      } else {
        // no-arg flag, possibly a getopt cluster (-4A, -vG); -G/-V may appear mid-cluster
        if (tok.includes("G") || tok.includes("V")) queryMode = true;
        for (const c of tok.slice(1)) noArgFlags.add(c); // surface -f / -N / clusters for callers
        optionArgs.push(tok);
      }
      continue;
    }
    if (destination === undefined) {
      destination = tok;
      continue;
    }
    break; // remote command begins — stop
  }
  return { destination, optionArgs, queryMode, noArgFlags };
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
    throw new Error(`ssh -G output missing hostname/user for '${destination}'`);
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
    if (!existsSync(file)) continue;
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
  if (parsed.destination === undefined) return { kind: "unresolvable", reason: "no ssh destination" };
  let cfg: SshEffectiveConfig;
  try {
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
