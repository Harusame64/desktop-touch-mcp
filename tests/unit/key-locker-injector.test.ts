// ADR-014 v2 R3 L2 — acceptance §6 #1 (selection rule) + the orchestrator's env/git-config assembly
// (§6 #6 env-inert, plus the spawn-config wiring). SendInput + ticket live paths are exercised by the
// e2e suite against the real locker; here we pin the pure decision + assembly logic with a fake host.
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l2-injection-plan.md
import { describe, expect, it, vi } from "vitest";
import {
  gitContextFor,
  inject,
  selectInjector,
  type InjectChannel,
  type InjectTarget,
} from "../../src/engine/key-locker/injector.js";
import type { BindingUri } from "../../src/engine/key-locker/binding.js";
import type { KeyLockerHost } from "../../src/engine/key-locker-host.js";

const target: InjectTarget = { hwnd: "12345", consolePid: 4242, titleFp: "abc", submit: true };

describe("selectInjector (§1 selection rule) — total, typed rejects", () => {
  const cases: Array<[BindingUri["scheme"], InjectChannel, string]> = [
    ["sudo", "pane", "sendinput"],
    ["ssh", "pane", "sendinput"],
    ["ssh", "askpass", "askpass"],       // ssh login routed to SSH_ASKPASS
    ["sshkey", "askpass", "askpass"],    // key passphrase
    ["https-cred", "git-credential", "askpass"],
  ];
  for (const [scheme, channel, injector] of cases) {
    it(`(${scheme}, ${channel}) → ${injector}`, () => {
      expect(selectInjector(scheme, channel)).toEqual({ ok: true, injector });
    });
  }

  it("env channel → RequiresRedaction for EVERY scheme (R4 gate, no flag)", () => {
    for (const scheme of ["sudo", "ssh", "sshkey", "https-cred"] as const) {
      expect(selectInjector(scheme, "env")).toEqual({ ok: false, code: "RequiresRedaction" });
    }
  });

  it("unmatched (scheme, channel) pairs → NoInjectorForBinding (never a guess)", () => {
    expect(selectInjector("https-cred", "pane")).toEqual({ ok: false, code: "NoInjectorForBinding" });
    expect(selectInjector("sudo", "askpass")).toEqual({ ok: false, code: "NoInjectorForBinding" });
    expect(selectInjector("sudo", "git-credential")).toEqual({ ok: false, code: "NoInjectorForBinding" });
    expect(selectInjector("sshkey", "pane")).toEqual({ ok: false, code: "NoInjectorForBinding" });
  });
});

describe("gitContextFor (§3.1 git-field mapping)", () => {
  it("maps https-cred → git's own credential fields (protocol=https, port dropped)", () => {
    expect(gitContextFor({ scheme: "https-cred", host: "github.com", port: 443, path: "owner/repo" })).toEqual({
      protocol: "https",
      host: "github.com",
      path: "owner/repo",
    });
  });
  it("omits path for a host-only binding", () => {
    expect(gitContextFor({ scheme: "https-cred", host: "github.com", port: 443 })).toEqual({
      protocol: "https",
      host: "github.com",
    });
  });
});

/** A fake locker host exposing only the two methods the orchestrator calls. */
function fakeHost(over: Partial<Pick<KeyLockerHost, "inject" | "mintTicket">> = {}): KeyLockerHost {
  return {
    inject: over.inject ?? vi.fn(async () => ({ ok: true as const, verified: true })),
    mintTicket: over.mintTicket ?? vi.fn(async () => ({ ok: true as const, ticket: "TKT", pipe: "\\\\.\\pipe\\dtm-serve-xyz" })),
  } as unknown as KeyLockerHost;
}

describe("inject orchestrator (§5) — never returns a secret", () => {
  const sudo: BindingUri = { scheme: "sudo", host: "localhost", targetUser: "root" };
  const git: BindingUri = { scheme: "https-cred", host: "github.com", port: 443, path: "owner/repo" };
  const gitNoPath: BindingUri = { scheme: "https-cred", host: "github.com", port: 443 };
  const sshkey: BindingUri = { scheme: "sshkey", keyFp: "SHA256:abc" };

  it("pane → calls host.inject with the target, returns verified only", async () => {
    const host = fakeHost();
    const r = await inject(host, sudo, "op-1", "pane", target);
    expect(r).toEqual({ ok: true, injector: "sendinput", verified: true });
    expect(host.inject).toHaveBeenCalledWith("op-1", target);
  });

  it("pane without a target → target_required", async () => {
    expect(await inject(fakeHost(), sudo, "op-1", "pane", null)).toEqual({ ok: false, code: "target_required" });
  });

  it("pane abort (locker re-verify fails) → surfaces the typed abort code, no secret", async () => {
    const host = fakeHost({ inject: vi.fn(async () => ({ ok: false as const, code: "not_foreground" as const })) });
    expect(await inject(host, sudo, "op-1", "pane", target)).toEqual({ ok: false, code: "not_foreground" });
  });

  it("git-credential → mints ticket with git ctx, assembles per-invocation helper + useHttpPath", async () => {
    const mintTicket = vi.fn(async () => ({ ok: true as const, ticket: "TKT", pipe: "PIPE" }));
    const r = await inject(fakeHost({ mintTicket }), git, "op-2", "git-credential", null);
    expect(mintTicket).toHaveBeenCalledWith("op-2", { protocol: "https", host: "github.com", path: "owner/repo" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.injector !== "askpass") throw new Error("expected askpass");
    expect(r.spawn.env).toEqual({ DTM_LOCKER_PIPE: "PIPE", DTM_ASKPASS_TICKET: "TKT" });
    expect(r.spawn.gitArgs).toContain("-c");
    // An empty credential.helper= must precede ours (resets any global/repo helper — Codex R1 P2).
    const emptyIdx = r.spawn.gitArgs.indexOf("credential.helper=");
    const oursIdx = r.spawn.gitArgs.findIndex((a) => a.startsWith("credential.helper=!"));
    expect(emptyIdx).toBeGreaterThanOrEqual(0);
    expect(oursIdx).toBeGreaterThan(emptyIdx);
    expect(r.spawn.gitArgs).toContain("credential.useHttpPath=true"); // path-bound
  });

  it("git-credential host-only binding → no useHttpPath (git omits path anyway)", async () => {
    const r = await inject(fakeHost(), gitNoPath, "op-2", "git-credential", null);
    if (!r.ok || r.injector !== "askpass") throw new Error("expected askpass");
    expect(r.spawn.gitArgs).not.toContain("credential.useHttpPath=true");
    expect(r.spawn.gitArgs.some((a) => a.startsWith("credential.helper="))).toBe(true);
  });

  it("git-credential with a stored binding user → exposes DTM_GIT_USERNAME (§3.2 tier 2)", async () => {
    const gitUser: BindingUri = { scheme: "https-cred", user: "alice", host: "bitbucket.org", port: 443, path: "team/repo" };
    const r = await inject(fakeHost(), gitUser, "op-2", "git-credential", null);
    if (!r.ok || r.injector !== "askpass") throw new Error("expected askpass");
    expect(r.spawn.env.DTM_GIT_USERNAME).toBe("alice");
  });

  it("git-credential with NO stored user → no DTM_GIT_USERNAME (helper falls to git's own / omit)", async () => {
    const r = await inject(fakeHost(), git, "op-2", "git-credential", null);
    if (!r.ok || r.injector !== "askpass") throw new Error("expected askpass");
    expect(r.spawn.env.DTM_GIT_USERNAME).toBeUndefined();
  });

  it("askpass (ssh key passphrase) → SSH_ASKPASS env, no git ctx, no gitArgs", async () => {
    const mintTicket = vi.fn(async () => ({ ok: true as const, ticket: "TKT", pipe: "PIPE" }));
    const r = await inject(fakeHost({ mintTicket }), sshkey, "op-3", "askpass", null);
    expect(mintTicket).toHaveBeenCalledWith("op-3", undefined); // no git ctx for ssh askpass
    if (!r.ok || r.injector !== "askpass") throw new Error("expected askpass");
    expect(r.spawn.env.SSH_ASKPASS).toBeDefined();
    expect(r.spawn.env.DTM_LOCKER_PIPE).toBe("PIPE");
    expect(r.spawn.env.DTM_ASKPASS_TICKET).toBe("TKT");
    expect(r.spawn.gitArgs).toEqual([]);
  });

  it("mint failure (no such secret) → no_secret, no spawn config leaked", async () => {
    const host = fakeHost({ mintTicket: vi.fn(async () => ({ ok: false as const, code: "no_secret" as const })) });
    expect(await inject(host, sshkey, "op-3", "askpass", null)).toEqual({ ok: false, code: "no_secret" });
  });

  it("env channel → RequiresRedaction, never touches the host", async () => {
    const host = fakeHost();
    expect(await inject(host, git, "op-4", "env", null)).toEqual({ ok: false, code: "RequiresRedaction" });
    expect(host.inject).not.toHaveBeenCalled();
    expect(host.mintTicket).not.toHaveBeenCalled();
  });

  it("no result path carries a secret-shaped field (structural)", async () => {
    const results = await Promise.all([
      inject(fakeHost(), sudo, "o", "pane", target),
      inject(fakeHost(), git, "o", "git-credential", null),
      inject(fakeHost(), sshkey, "o", "askpass", null),
      inject(fakeHost(), git, "o", "env", null),
    ]);
    const json = JSON.stringify(results);
    // The orchestrator only ever handles opaque ids, tickets, pipe names, targets, booleans, codes.
    expect(json).not.toMatch(/secret|password|passphrase/i);
  });
});
