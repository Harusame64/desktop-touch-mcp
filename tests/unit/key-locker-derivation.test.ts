// ADR-014 v2 R3 L1 — acceptance §8 #5 (sudo session host) + #6 (command derivation table).
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md
//
// ssh derivation goes through a FAKE exec (canned `ssh -G` / `ssh-keygen` output) so the table is
// hermetic without OpenSSH; git derivation uses REAL `git` against temp fixture repos (no network
// — the remote URLs are never contacted). This file owns the per-flag edge table the plan's §4
// scope note delegates to the test suite.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveBinding,
  tokenizeCommandSegments,
  tokenizeCommandSegmentsWithOps,
  type SessionContext,
} from "../../src/engine/key-locker/command-derivation.js";
import { defaultExec, type ExecFn } from "../../src/engine/key-locker/ssh-resolve.js";

let tmp: string;
let khFile: string;
let repoTracking: string; // branch main tracks origin (an https remote)
let repoPushElsewhere: string; // branch main has pushRemote = a NON-origin https remote

const local: SessionContext = { execHost: "localhost", isRemote: false, cwd: "." };
const remotePane: SessionContext = { execHost: "prod.example.com", isRemote: true, cwd: "/home/u" };

// Canned ssh -G/ssh-keygen; git falls through to the real binary (fixture repos, no network).
const fakeExec: ExecFn = async (file, args) => {
  if (file === "ssh" && args[0] === "-G") {
    const dest = args[args.length - 1];
    let user = "u";
    let port = "22";
    const li = args.indexOf("-l");
    if (li >= 0) user = args[li + 1];
    const pi = args.indexOf("-p");
    if (pi >= 0) port = args[pi + 1];
    let host = dest;
    const at = dest.lastIndexOf("@");
    if (at > 0) { user = dest.slice(0, at); host = dest.slice(at + 1); }
    host = host.replace(/^\[|\]$/g, ""); // real ssh -G prints IPv6 hostnames UNBRACKETED
    if (host === "resolvefail.example.com") return { code: 255, stdout: "", stderr: "boom" };
    const ji = args.indexOf("-J"); // real ssh maps -J onto an effective ProxyJump line
    const proxy = ji >= 0 ? `proxyjump ${args[ji + 1]}\n` : "";
    return {
      code: 0,
      stdout: `hostname ${host}\nuser ${user}\nport ${port}\n${proxy}userknownhostsfile ${khFile}\nglobalknownhostsfile ${join(tmp, "absent")}\n`,
      stderr: "",
    };
  }
  if (file === "ssh-keygen") {
    const token = args[args.indexOf("-F") + 1];
    if (token === "h" || token === "[h]:2222" || token === "prod.example.com") {
      return { code: 0, stdout: `${token} ED25519 SHA256:FAKEFP1\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  }
  if (file === "git") return defaultExec(file, args);
  return { code: 127, stdout: "", stderr: `unexpected exec of ${file}` };
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const r = await defaultExec("git", ["-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dtm-l1-derive-"));
  khFile = join(tmp, "known_hosts");
  writeFileSync(khFile, "placeholder — content is faked through ssh-keygen\n", "utf8");

  const mkRepo = async (name: string): Promise<string> => {
    const dir = join(tmp, name);
    await defaultExec("git", ["init", dir]);
    await git(dir, "config", "user.email", "t@example.com");
    await git(dir, "config", "user.name", "t");
    await git(dir, "commit", "--allow-empty", "-m", "init");
    await git(dir, "checkout", "-B", "main");
    return dir;
  };

  repoTracking = await mkRepo("tracking");
  await git(repoTracking, "remote", "add", "origin", "https://github.com/example/repo.git");
  await git(repoTracking, "remote", "add", "sshr", "git@github.com:example/repo.git");
  await git(repoTracking, "remote", "add", "multi", "https://m0.example.com/a.git");
  await git(repoTracking, "remote", "set-url", "--push", "multi", "https://m1.example.com/a.git");
  await git(repoTracking, "remote", "set-url", "--add", "--push", "multi", "https://m2.example.com/b.git");
  await git(repoTracking, "config", "branch.main.remote", "origin");
  await git(repoTracking, "config", "branch.main.merge", "refs/heads/main");

  repoPushElsewhere = await mkRepo("push-elsewhere");
  await git(repoPushElsewhere, "remote", "add", "origin", "https://github.com/example/repo.git");
  await git(repoPushElsewhere, "remote", "add", "forge", "https://forge.example.com:8443/team/proj.git");
  await git(repoPushElsewhere, "config", "branch.main.remote", "origin");
  await git(repoPushElsewhere, "config", "branch.main.merge", "refs/heads/main");
  await git(repoPushElsewhere, "config", "branch.main.pushRemote", "forge");
}, 30_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("tokenizer", () => {
  it("splits segments at unquoted separators, respects quotes", () => {
    expect(tokenizeCommandSegments(`echo "a && b" && sudo apt update; ls | wc`)).toEqual([
      ["echo", "a && b"],
      ["sudo", "apt", "update"],
      ["ls"],
      ["wc"],
    ]);
  });

  it("marks segments after `&&` / `||` conditional; `;` / `&` reset it; a single `&` backgrounds", () => {
    expect(tokenizeCommandSegmentsWithOps(`a && b || c ; d | e & f`)).toEqual([
      { tokens: ["a"], conditional: false, backgrounded: false }, // first
      { tokens: ["b"], conditional: true, backgrounded: false },  // after &&
      { tokens: ["c"], conditional: true, backgrounded: false },  // after ||
      { tokens: ["d"], conditional: false, backgrounded: false }, // after ;
      { tokens: ["e"], conditional: false, backgrounded: true },  // terminated by single `&` → backgrounded
      { tokens: ["f"], conditional: false, backgrounded: false }, // after &
    ]);
  });

  it("a single `|` PROPAGATES an earlier `&&` guard across the pipeline (Codex #495 P2)", () => {
    // `false && echo ok | ssh prod` parses as `false && (echo ok | ssh prod)`: the whole pipeline is
    // guarded, so the downstream `ssh prod` stage must stay conditional, not reset to unconditional.
    expect(tokenizeCommandSegmentsWithOps(`false && echo ok | ssh prod`)).toEqual([
      { tokens: ["false"], conditional: false, backgrounded: false },
      { tokens: ["echo", "ok"], conditional: true, backgrounded: false },
      { tokens: ["ssh", "prod"], conditional: true, backgrounded: false }, // guard propagated through `|`
    ]);
  });
});

describe("§8 #5 — sudo purpose + session host", () => {
  it("sudo -u deploy … on a LOCAL pane → sudo://localhost/deploy", async () => {
    expect(await deriveBinding("sudo -u deploy systemctl restart app", local, { exec: fakeExec })).toEqual({
      scheme: "sudo",
      host: "localhost",
      targetUser: "deploy",
    });
  });

  it("the SAME command in a REMOTE pane targets the remote host — no localhost collapse", async () => {
    expect(await deriveBinding("sudo -u deploy systemctl restart app", remotePane, { exec: fakeExec })).toEqual({
      scheme: "sudo",
      host: "prod.example.com",
      targetUser: "deploy",
    });
  });

  it("nested one-shot `ssh host sudo …` derives the OUTER ssh login, not sudo://", async () => {
    const uri = await deriveBinding("ssh prod.example.com sudo apt update", local, { exec: fakeExec });
    expect(uri).toMatchObject({ scheme: "ssh", host: "prod.example.com", user: "u", port: 22 });
  });
});

describe("§8 #6 — command derivation table", () => {
  const derives = async (cmd: string, session: SessionContext = local) =>
    deriveBinding(cmd, session, { exec: fakeExec });

  // --- ssh ---
  it("ssh h → ssh://u@h:22 with the resolved fp-set", async () => {
    expect(await derives("ssh h")).toEqual({ scheme: "ssh", user: "u", host: "h", port: 22, fpSet: ["SHA256:FAKEFP1"] });
  });
  it("ssh -p 2222 user@h → port honored (known_hosts token is [h]:2222)", async () => {
    expect(await derives("ssh -p 2222 alice@h")).toMatchObject({ scheme: "ssh", user: "alice", host: "h", port: 2222 });
  });
  it("query / no-login modes → null: ssh -G h / ssh -Q cipher / ssh -V", async () => {
    expect(await derives("ssh -G h")).toBeNull();
    expect(await derives("ssh -Q cipher")).toBeNull();
    expect(await derives("ssh -V")).toBeNull();
  });
  it("host not in known_hosts → null (fail closed)", async () => {
    expect(await derives("ssh unknown.example.com")).toBeNull();
  });
  it("ssh -G resolution failure → null (fail closed, never guess)", async () => {
    expect(await derives("ssh resolvefail.example.com")).toBeNull();
  });
  it("IPv6 destination: host is re-bracketed so the displayUri round-trips (Opus R1 P2-1)", async () => {
    const uri = await derives("ssh u@[h]"); // fake ssh -G reports the bare 'h'; kh token 'h' is stored
    expect(uri).toMatchObject({ scheme: "ssh", host: "h" });
    // The bracket rule itself is pinned via the parser: a host ssh -G reports with ':' in it
    // must land bracketed. (Direct unit on the resolve path, no real IPv6 endpoint needed.)
    const { resolveCanonicalForSshCommand } = await import("../../src/engine/key-locker/ssh-resolve.js");
    const { formatBindingUri, parseBindingUri } = await import("../../src/engine/key-locker/binding.js");
    const v6Exec: typeof fakeExec = async (file, args) => {
      if (file === "ssh" && args[0] === "-G") {
        return { code: 0, stdout: `hostname ::1\nuser u\nport 22\nuserknownhostsfile ${khFile}\n`, stderr: "" };
      }
      if (file === "ssh-keygen") return { code: 0, stdout: "::1 ED25519 SHA256:FAKEFP1\n", stderr: "" };
      return { code: 127, stdout: "", stderr: "unexpected" };
    };
    const r = await resolveCanonicalForSshCommand(["u@::1"], v6Exec);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.uri.host).toBe("[::1]");
    expect(parseBindingUri(formatBindingUri(r.uri))).toMatchObject({ scheme: "ssh", host: "[::1]", user: "u", port: 22 });
  });
  it("ssh -J bastion target → null (the FIRST prompt may be the jump host's — Codex R1 P1)", async () => {
    expect(await derives("ssh -J bastion.example.com h")).toBeNull();
  });
  it("clustered arg-taking flag (-4p 2222) fails CLOSED to null, never a wrong target", async () => {
    // '-4p' is tokenized as a no-arg cluster, so '2222' is taken as the destination; the fake
    // known_hosts has no such host → host-not-known → null. Pinned so the failure DIRECTION
    // (toward null) never regresses even though the cluster parse itself is imperfect.
    expect(await derives("ssh -4p 2222 h")).toBeNull();
  });

  // --- sudo (the CANNOT-prompt closed set nulls; everything else derives) ---
  it("sudo apt update → derive", async () => {
    expect(await derives("sudo apt update")).toMatchObject({ scheme: "sudo", targetUser: "root" });
  });
  it("sudo -n apt update → null (never prompts)", async () => {
    expect(await derives("sudo -n apt update")).toBeNull();
  });
  it("bare sudo -k / -K → null (clears timestamp and exits)", async () => {
    expect(await derives("sudo -k")).toBeNull();
    expect(await derives("sudo -K")).toBeNull();
  });
  it("sudo -k apt update → derive (invalidates cache then RUNS → prompts)", async () => {
    expect(await derives("sudo -k apt update")).toMatchObject({ scheme: "sudo" });
  });
  it("sudo -l / sudo -v → derive (both can prompt)", async () => {
    expect(await derives("sudo -l")).toMatchObject({ scheme: "sudo" });
    expect(await derives("sudo -v")).toMatchObject({ scheme: "sudo" });
  });
  it("all four sudo user-selection forms bind targetUser (Codex R2 P2)", async () => {
    for (const cmd of ["sudo -u deploy id", "sudo -udeploy id", "sudo --user=deploy id", "sudo --user deploy id"]) {
      expect(await derives(cmd), cmd).toEqual({ scheme: "sudo", host: "localhost", targetUser: "deploy" });
    }
  });
  it("sudo -k -v / -k -l are force-reprompt modes, NOT a bare clear → derive (Codex R1 P2)", async () => {
    expect(await derives("sudo -k -v")).toMatchObject({ scheme: "sudo" });
    expect(await derives("sudo -k -l")).toMatchObject({ scheme: "sudo" });
    expect(await derives("sudo -k -K")).toBeNull(); // still only clears — cannot prompt
  });
  it("pure-info sudo -V / --help / bare -h → null", async () => {
    expect(await derives("sudo -V")).toBeNull();
    expect(await derives("sudo --help")).toBeNull();
    expect(await derives("sudo -h")).toBeNull();
  });
  it("env assignment prefix is skipped: FOO=1 sudo cmd → derive", async () => {
    expect(await derives("FOO=1 sudo apt update")).toMatchObject({ scheme: "sudo" });
  });
  it("later segment: echo hi && sudo apt update → derive (first credential-bearing program)", async () => {
    expect(await derives("echo hi && sudo apt update")).toMatchObject({ scheme: "sudo" });
  });

  // --- git ---
  it("git clone https://… → derive from the explicit URL", async () => {
    expect(await derives("git clone https://github.com/example/repo.git")).toEqual({
      scheme: "https-cred",
      user: undefined,
      host: "github.com",
      port: 443,
      path: "example/repo.git",
    });
  });
  it("git clone --bundle-uri <uri> <repo> derives the REPO, not the bundle host (Codex R5)", async () => {
    expect(await derives("git clone --bundle-uri https://cache.example.com/bundle https://github.com/org/private.git")).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
      path: "org/private.git",
    });
    expect(await derives("git clone --bundle-uri=https://cache.example.com/bundle https://github.com/org/private.git")).toMatchObject({
      host: "github.com",
    });
  });
  it("git push origin with a cwd whose origin is https → derive via git -C cwd", async () => {
    expect(await derives("git push origin main", { ...local, cwd: repoTracking })).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("bare git push on a branch whose pushRemote is a NON-origin https remote → THAT host (R9/R10)", async () => {
    expect(await derives("git push", { ...local, cwd: repoPushElsewhere })).toMatchObject({
      scheme: "https-cred",
      host: "forge.example.com",
      port: 8443,
      path: "team/proj.git",
    });
  });
  it("bare git fetch follows branch.<cur>.remote", async () => {
    expect(await derives("git fetch", { ...local, cwd: repoTracking })).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("multi-remote fetch modes are ambiguous → null; push --all (all BRANCHES) still derives (Codex R1 P1)", async () => {
    expect(await derives("git fetch --all", { ...local, cwd: repoTracking })).toBeNull();
    expect(await derives("git fetch --multiple origin sshr", { ...local, cwd: repoTracking })).toBeNull();
    expect(await derives("git fetch -m origin sshr", { ...local, cwd: repoTracking })).toBeNull(); // -m = --multiple (Codex R3)
    expect(await derives("git pull --all", { ...local, cwd: repoTracking })).toBeNull();
    expect(await derives("git push --all", { ...local, cwd: repoTracking })).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("git push to a remote with MULTIPLE push URLs → null; fetch (first URL only) still derives (Codex R2 P2)", async () => {
    expect(await derives("git push multi main", { ...local, cwd: repoTracking })).toBeNull();
    expect(await derives("git fetch multi", { ...local, cwd: repoTracking })).toMatchObject({
      scheme: "https-cred",
      host: "m0.example.com",
    });
  });
  it("git push to an ssh remote → null (that's an sshkey path, not https-cred)", async () => {
    expect(await derives("git push sshr main", { ...local, cwd: repoTracking })).toBeNull();
    expect(await derives("git clone git@github.com:example/repo.git")).toBeNull();
    expect(await derives("git clone ssh://git@github.com/example/repo.git")).toBeNull();
  });
  it("git push --repo=<url> / --repo <url> derive from the explicit target (Opus R1 P3-2)", async () => {
    expect(await derives("git push --repo=https://forge.example.com:8443/team/proj.git", { ...local, cwd: tmp })).toMatchObject({
      scheme: "https-cred",
      host: "forge.example.com",
      port: 8443,
    });
    expect(await derives("git push --repo https://github.com/example/repo.git", { ...local, cwd: tmp })).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("git -C <repo> push origin resolves against the -C path, not session.cwd", async () => {
    expect(await derives(`git -C "${repoTracking}" push origin main`, { ...local, cwd: tmp })).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("git push in a REMOTE pane → null (deferred to L3; git runs remotely)", async () => {
    expect(await derives("git push", { ...remotePane, cwd: repoTracking })).toBeNull();
  });
  it("git push outside any repo → null (never guess)", async () => {
    expect(await derives("git push", { ...local, cwd: tmp })).toBeNull();
  });
  it("git -V / git --version / non-credential subcommands → null", async () => {
    expect(await derives("git -V")).toBeNull();
    expect(await derives("git --version")).toBeNull();
    expect(await derives("git status", { ...local, cwd: repoTracking })).toBeNull();
  });

  // --- cwd fail-safe (#495 P1): an UNKNOWN cwd must never resolve a configured remote ---
  it("configured-remote git with UNKNOWN cwd → null (never `git -C <wrong-dir>`; #495 P1)", async () => {
    const noCwd: SessionContext = { execHost: "localhost", isRemote: false }; // cwd omitted (L3 unknown)
    expect(await derives("git push origin main", noCwd)).toBeNull();
    expect(await derives("git push", noCwd)).toBeNull();
    expect(await derives("git fetch", noCwd)).toBeNull();
    // A wiring layer that papered the optional cwd over with "" must ALSO decline, not run in $PWD.
    expect(await derives("git push", { ...local, cwd: "" })).toBeNull();
  });
  it("explicit-URL git still derives with UNKNOWN cwd (the target is cwd-independent)", async () => {
    const noCwd: SessionContext = { execHost: "localhost", isRemote: false };
    expect(await derives("git push https://github.com/example/repo.git main", noCwd)).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
    expect(await derives("git clone https://github.com/example/repo.git", noCwd)).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
  });
  it("git -C <abs> push with UNKNOWN cwd resolves against the -C path (#495 P1 boundary)", async () => {
    const noCwd: SessionContext = { execHost: "localhost", isRemote: false };
    expect(await derives(`git -C "${repoTracking}" push origin main`, noCwd)).toMatchObject({
      scheme: "https-cred",
      host: "github.com",
    });
    // `-C <rel>` cannot resolve against an unknown cwd → still declines.
    expect(await derives("git -C sub push origin main", noCwd)).toBeNull();
  });

  // --- non-credential commands ---
  it("plain commands → null", async () => {
    expect(await derives("npm install")).toBeNull();
    expect(await derives("dir")).toBeNull();
    expect(await derives("")).toBeNull();
  });
});
