// ADR-014 v2 R3 Key Locker — L2 injection: the engine-side orchestrator that decides HOW a resolved
// binding's secret reaches a consumer, WITHOUT ever holding the secret.
//
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l2-injection-plan.md (§1, §5)
//
// Three injectors (D4(iii) has two transports — askpass stdout + git credential protocol — that share
// machinery) behind one decision:
//   * SendInput → pane  — the LOCKER types the secret into a dedicated console after an injection-
//     instant re-verify (secret never leaves the locker).
//   * askpass streaming — a compiled helper streams the secret locker→consumer off the MCP path,
//     authorized by a single-use ticket; the engine only assembles the env/git-config.
//   * env var          — R4-gated; a hard `RequiresRedaction` reject (no flag) until R4 lands.
//
// Invariant (from L0/L1): the secret NEVER crosses the control pipe and is NEVER held by Node. This
// module passes only opaque ids + targets + non-secret ticket handles.

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { BindingUri } from "./binding.js";
import type { InjectAbortCode, InjectTarget, KeyLockerHost } from "../key-locker-host.js";

export type { InjectTarget };

// dist/engine/key-locker/ -> ../../../bin/key-askpass.exe (mirrors key-locker.exe resolution).
const ASKPASS_EXE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "key-askpass.exe");

/** Which consumer channel L3 observed for this credential event (drives injector selection). */
export type InjectChannel = "pane" | "askpass" | "git-credential" | "env";

export type InjectorKind = "sendinput" | "askpass";

export type SelectErrorCode = "NoInjectorForBinding" | "RequiresRedaction";

/** Result of the pure selection rule (§1). */
export type SelectResult =
  | { ok: true; injector: InjectorKind }
  | { ok: false; code: SelectErrorCode };

/**
 * The injector-selection rule (§1, THE LOCKED CONTRACT #1) — a pure, total function over
 * (scheme, channel). `env` is always `RequiresRedaction` (R4 gate, §4); unmatched pairs are
 * `NoInjectorForBinding` (never a silent guess).
 */
export function selectInjector(scheme: BindingUri["scheme"], channel: InjectChannel): SelectResult {
  if (channel === "env") return { ok: false, code: "RequiresRedaction" };
  switch (channel) {
    case "pane":
      // Interactive echo-off prompt in the pane → the locker SendInputs.
      if (scheme === "sudo" || scheme === "ssh") return { ok: true, injector: "sendinput" };
      return { ok: false, code: "NoInjectorForBinding" };
    case "askpass":
      // ssh login routed to SSH_ASKPASS, or an ssh-key passphrase.
      if (scheme === "ssh" || scheme === "sshkey") return { ok: true, injector: "askpass" };
      return { ok: false, code: "NoInjectorForBinding" };
    case "git-credential":
      if (scheme === "https-cred") return { ok: true, injector: "askpass" };
      return { ok: false, code: "NoInjectorForBinding" };
  }
}

/** Git credential-field context bound into a ticket for serve-time `context_mismatch` (§3.1). */
export interface GitCredentialContext {
  /** git's `protocol` field — the L1 `https-cred` scheme maps to `"https"` (NOT the scheme; §3.1). */
  protocol: "https";
  host: string;
  /** git's `path` field — present only for a path-bound binding (drives `credential.useHttpPath`). */
  path?: string;
}

/**
 * Map an L1 `https-cred` binding to git's OWN credential fields (Codex R3 P2): git's `get` request
 * presents `protocol`/`host`/`path`, never `scheme`/`port`, so the ticket ctx must be in those terms
 * or every fetch would `context_mismatch`.
 */
export function gitContextFor(binding: BindingUri & { scheme: "https-cred" }): GitCredentialContext {
  return { protocol: "https", host: binding.host, ...(binding.path !== undefined ? { path: binding.path } : {}) };
}

/** What the L3 caller must apply to the consumer spawn for an askpass/git injection. */
export interface ConsumerSpawnConfig {
  /** Env vars to set on the consumer child (inherited by the helper ssh/git spawns). */
  env: Record<string, string>;
  /** Extra `git -c …` args to prepend to a git invocation (empty for plain askpass). */
  gitArgs: string[];
}

export type InjectResult =
  | { ok: true; injector: "sendinput"; verified: boolean }
  | { ok: true; injector: "askpass"; spawn: ConsumerSpawnConfig }
  // `InjectAbortCode` (the locker-side SendInput abort reasons, §2.1) is the SSOT in key-locker-host.
  | { ok: false; code: SelectErrorCode | "target_required" | InjectAbortCode };

/**
 * Orchestrate an injection. Returns booleans / config / typed reasons — NEVER a secret.
 * `pane` → the locker SendInputs (needs `target`); `askpass`/`git-credential` → mint a ticket + return
 * the consumer spawn config (the secret path is helper↔locker only); `env` → `RequiresRedaction`.
 */
export async function inject(
  host: KeyLockerHost,
  binding: BindingUri,
  opaqueId: string,
  channel: InjectChannel,
  target: InjectTarget | null,
): Promise<InjectResult> {
  const selected = selectInjector(binding.scheme, channel);
  if (!selected.ok) return { ok: false, code: selected.code };

  if (selected.injector === "sendinput") {
    if (target === null) return { ok: false, code: "target_required" };
    const r = await host.inject(opaqueId, target);
    return r.ok
      ? { ok: true, injector: "sendinput", verified: r.verified }
      : { ok: false, code: r.code };
  }

  // askpass / git-credential — mint a single-use ticket + serving pipe; assemble the spawn config.
  const gitCtx = channel === "git-credential" && binding.scheme === "https-cred"
    ? gitContextFor(binding)
    : undefined;
  const minted = await host.mintTicket(opaqueId, gitCtx);
  if (!minted.ok) return { ok: false, code: "no_secret" };

  const env: Record<string, string> = {
    DTM_LOCKER_PIPE: minted.pipe,
    DTM_ASKPASS_TICKET: minted.ticket,
  };
  const gitArgs: string[] = [];
  if (channel === "git-credential") {
    // Per-invocation helper injection (never a global git-config mutation, §3.2). An empty
    // `credential.helper=` FIRST RESETS the helper list (Codex R1 P2): otherwise an existing
    // global/repo helper (e.g. Git Credential Manager) is tried first and, if it answers, git never
    // invokes ours — bypassing the ticket + context_mismatch checks and using stale/wrong creds.
    gitArgs.push("-c", "credential.helper=");
    gitArgs.push("-c", `credential.helper=!"${ASKPASS_EXE}" credential`);
    // git omits `path` from `get` unless useHttpPath is set — a path-bound ctx would always mismatch.
    if (gitCtx?.path !== undefined) gitArgs.push("-c", "credential.useHttpPath=true");
    // Username precedence tier (2), §3.2: when the binding carries a stored user, expose it so the
    // helper can answer git's `get` with a username (load-bearing for Bitbucket, which — unlike
    // GitHub/GitLab — rejects an arbitrary one). Tier (1) = git echoing its own username still wins
    // in the helper; tier (3) = password-only when neither holds (Opus R1 P2-2).
    if (binding.scheme === "https-cred" && binding.user !== undefined && binding.user.length > 0) {
      env.DTM_GIT_USERNAME = binding.user;
    }
  } else {
    // Plain SSH_ASKPASS: point ssh at the helper and force non-tty prompting.
    env.SSH_ASKPASS = ASKPASS_EXE;
    env.SSH_ASKPASS_REQUIRE = "force";
  }
  return { ok: true, injector: "askpass", spawn: { env, gitArgs } };
}
