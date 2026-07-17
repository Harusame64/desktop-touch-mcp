// ADR-014 v2 R3 L1 — acceptance §8 #2 (ssh resolution + option passthrough), #3 (P2-1
// recorded-identity drift), #4 (host-not-known fail-closed).
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md
//
// Uses the REAL `ssh -G` + `ssh-keygen -l -F` (Windows OpenSSH) against temp fixture files —
// hermetic, no network, nothing ever connects. Skips with a clear message if OpenSSH is absent.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseSshCommand,
  resolveCanonicalForSshCommand,
  SSH_FLAGS_NO_ARG,
  SSH_FLAGS_WITH_ARG,
} from "../../src/engine/key-locker/ssh-resolve.js";
import { BindingStore } from "../../src/engine/key-locker/binding-store.js";
import { formatBindingUri } from "../../src/engine/key-locker/binding.js";

const present = (cmd: string, args: string[]): boolean =>
  spawnSync(cmd, args, { stdio: "ignore", windowsHide: true }).error === undefined;
const hasOpenSsh = present("ssh", ["-V"]) && present("ssh-keygen", ["-?"]);
if (!hasOpenSsh) {
  console.warn("[key-locker-ssh-resolve.test] OpenSSH client not found on this runner — skipping the real ssh -G acceptance suite");
}

const fwd = (p: string): string => p.replace(/\\/g, "/");

let tmp: string;
let cfg: string;
let khMain: string;
let khDrift: string;
let khGlobal: string;
let absent: string;
let fp1: string; // key 1's SHA256 fingerprint (the bound identity)
let pub1: string; // "ssh-ed25519 AAAA…" (type + b64) for known_hosts lines
let pub2: string; // a second, different host key (the drifted identity)

const keygen = (args: string[]): string => {
  const r = spawnSync("ssh-keygen", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ssh-keygen ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

beforeAll(() => {
  if (!hasOpenSsh) return;
  tmp = mkdtempSync(join(tmpdir(), "dtm-l1-ssh-"));
  absent = fwd(join(tmp, "does-not-exist"));

  for (const name of ["key1", "key2"]) {
    keygen(["-q", "-t", "ed25519", "-N", "", "-f", join(tmp, name)]);
  }
  const pubLine = (name: string): string => {
    const [type, b64] = readFileSync(join(tmp, `${name}.pub`), "utf8").trim().split(/\s+/);
    return `${type} ${b64}`;
  };
  pub1 = pubLine("key1");
  pub2 = pubLine("key2");
  fp1 = /SHA256:[A-Za-z0-9+/]+/.exec(keygen(["-l", "-f", join(tmp, "key1.pub")]))![0];

  khMain = fwd(join(tmp, "known_hosts"));
  writeFileSync(khMain, `real.example.com ${pub1}\n[real.example.com]:2222 ${pub1}\n`, "utf8");
  khDrift = fwd(join(tmp, "known_hosts_drift"));
  writeFileSync(khDrift, `real.example.com ${pub1}\n`, "utf8");
  const khAlias = fwd(join(tmp, "known_hosts_alias"));
  writeFileSync(khAlias, `customalias ${pub1}\n`, "utf8"); // ONLY the alias token — proves HostKeyAlias is used
  const khCustom = fwd(join(tmp, "known_hosts_custom"));
  writeFileSync(khCustom, `real.example.com ${pub1}\n`, "utf8");
  khGlobal = fwd(join(tmp, "known_hosts_global"));
  writeFileSync(khGlobal, `global.example.com ${pub1}\n`, "utf8");

  cfg = fwd(join(tmp, "config"));
  writeFileSync(
    cfg,
    [
      "Host myalias",
      "    HostName real.example.com",
      "    User aliceuser",
      "Host hka",
      "    HostName real.example.com",
      "    User u2",
      "    HostKeyAlias customalias",
      `    UserKnownHostsFile ${khAlias}`,
      "Host cukh",
      "    HostName real.example.com",
      "    User u3",
      `    UserKnownHostsFile ${khCustom}`,
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const mainOpts = (): string[] => ["-F", cfg, "-o", `UserKnownHostsFile=${khMain}`, "-o", `GlobalKnownHostsFile=${absent}`];

describe.skipIf(!hasOpenSsh)("§8 #2 — ssh resolution + option passthrough (real ssh -G / ssh-keygen)", () => {
  it("alias resolves through ~/.ssh/config to the real endpoint + fp-set", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "myalias"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.uri).toMatchObject({ scheme: "ssh", user: "aliceuser", host: "real.example.com", port: 22 });
    expect(r.uri.fpSet).toEqual([fp1]);
    expect(r.canonical).toBe(`ssh://aliceuser@real.example.com:22|fp=${fp1}`);
    expect(formatBindingUri(r.uri)).toBe("ssh://aliceuser@real.example.com");
  });

  it("alias and explicit user@realhost resolving identically share ONE canonical", async () => {
    const viaAlias = await resolveCanonicalForSshCommand([...mainOpts(), "myalias"]);
    const direct = await resolveCanonicalForSshCommand([...mainOpts(), "aliceuser@real.example.com"]);
    expect(viaAlias.kind).toBe("ok");
    expect(direct.kind).toBe("ok");
    if (viaAlias.kind === "ok" && direct.kind === "ok") expect(direct.canonical).toBe(viaAlias.canonical);
  });

  it("-p 2222 passes through: the [host]:port known_hosts token is looked up", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "-p", "2222", "bob@real.example.com"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri).toMatchObject({ port: 2222, user: "bob" });
    // A port with NO stored [host]:port line must fail closed, proving the token carries the port.
    const miss = await resolveCanonicalForSshCommand([...mainOpts(), "-p", "2200", "bob@real.example.com"]);
    expect(miss.kind).toBe("host-not-known");
  });

  it("-l overrides the login user", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "-l", "otheruser", "real.example.com"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri.user).toBe("otheruser");
  });

  it("HostKeyAlias: the lookup token is the ALIAS (file holds only the alias line)", async () => {
    const r = await resolveCanonicalForSshCommand(["-F", cfg, "-o", `GlobalKnownHostsFile=${absent}`, "hka"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri).toMatchObject({ user: "u2", host: "real.example.com" });
  });

  it("a config-level custom UserKnownHostsFile is the file consulted", async () => {
    const r = await resolveCanonicalForSshCommand(["-F", cfg, "-o", `GlobalKnownHostsFile=${absent}`, "cukh"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri.user).toBe("u3");
  });

  it("a host trusted ONLY via GlobalKnownHostsFile resolves (absent user file skipped as empty)", async () => {
    const r = await resolveCanonicalForSshCommand([
      "-F", cfg,
      "-o", `UserKnownHostsFile=${absent}`,
      "-o", `GlobalKnownHostsFile=${khGlobal}`,
      "u9@global.example.com",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri).toMatchObject({ user: "u9", host: "global.example.com" });
  });

  it("an unreadable -F config fails closed as unresolvable", async () => {
    const r = await resolveCanonicalForSshCommand(["-F", absent, "-o", `UserKnownHostsFile=${khMain}`, "h"]);
    expect(r.kind).toBe("unresolvable");
  });

  it("-J (ProxyJump) defers: real ssh -G reports the effective proxyjump → no derivation", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "-J", "bastion.example.com", "bob@real.example.com"]);
    expect(r.kind).toBe("unresolvable");
  });

  // ── F-3 (real `ssh -G`): options BEHIND the destination reach the resolver ──────────────────────────
  // The pre-fix parser stopped at the destination, so these all resolved as if the option were absent.
  it("a post-destination -p reaches ssh -G — `h -p 2222` is the SAME endpoint as `-p 2222 h`", async () => {
    const post = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com", "-p", "2222"]);
    const pre = await resolveCanonicalForSshCommand([...mainOpts(), "-p", "2222", "bob@real.example.com"]);
    expect(post.kind).toBe(pre.kind);
    expect(post).toEqual(pre); // order of options vs destination must not change the endpoint
  });

  it("a post-destination -l changes the derived user (it used to be silently dropped)", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "real.example.com", "-l", "carol"]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.uri.user).toBe("carol");
  });

  it("a post-destination -J still defers — the bastion prompt is not the final host's", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com", "-J", "bastion.example.com"]);
    expect(r.kind).toBe("unresolvable");
  });

  it("a trailing remote command is ignored by ssh -G (it is not read as the destination)", async () => {
    const withCmd = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com", "sudo", "apt", "update"]);
    const bare = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com"]);
    expect(withCmd).toEqual(bare);
  });

  it("a default-port entry stored in BRACKETED [host]:22 form is still found (Codex R4)", async () => {
    const khBracketed = fwd(join(tmp, "known_hosts_bracketed"));
    writeFileSync(khBracketed, `[::1]:22 ${pub1}\n`, "utf8");
    const r = await resolveCanonicalForSshCommand([
      "-F", cfg,
      "-o", `UserKnownHostsFile=${khBracketed}`,
      "-o", `GlobalKnownHostsFile=${absent}`,
      "u@::1",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.uri).toMatchObject({ host: "[::1]", port: 22 });
      expect(r.uri.fpSet).toEqual([fp1]);
    }
  });
});

// ── F-3 security regression pin (acceptance-critical) ────────────────────────────────────────────────
//
// The bug this pins is a CREDENTIAL MISDIRECTION, not a missing autofill. Pre-fix, `ssh alice@h -p 2222`
// dropped the `-p`, so it derived the port-22 canonical key AND the port-22 known_hosts fingerprints —
// a bit-exact match for a stored port-22 binding. `BindingStore.resolve` is a plain map lookup, the
// fp-set was derived from the WRONG endpoint (so it cannot detect the mismatch), and L2's
// injection-instant re-verify checks the shell pid + creation time, never the endpoint. The port-22
// secret would have been typed into the port-2222 server's prompt.
describe.skipIf(!hasOpenSsh)("F-3 — a port-22 binding must NOT resolve for an explicit -p 2222", () => {
  it("`ssh bob@h` and `ssh bob@h -p 2222` derive DIFFERENT keys ⇒ the :22 secret cannot reach :2222", async () => {
    const store = BindingStore.load(join(tmp, "store-f3"), async () => true);

    // The user saves a credential for the DEFAULT-port server and binds it.
    const bound = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com"]);
    expect(bound.kind).toBe("ok");
    if (bound.kind !== "ok") return;
    await store.bind(bound.canonical, "opaque-port22", { uri: formatBindingUri(bound.uri), createdAt: "t" });
    expect(await store.resolve(bound.canonical)).toEqual({ opaqueId: "opaque-port22" });

    // The assistant then runs a DIFFERENT server on the same host, with the port behind the destination.
    const other = await resolveCanonicalForSshCommand([...mainOpts(), "bob@real.example.com", "-p", "2222"]);
    // It resolves the real endpoint now (:2222) — or fails closed if that port has no known_hosts entry.
    // Either way the one forbidden outcome is reusing the port-22 key.
    if (other.kind === "ok") {
      expect(other.uri.port).toBe(2222);
      expect(other.canonical).not.toBe(bound.canonical);
      expect(await store.resolve(other.canonical)).toBeUndefined(); // ⇒ no opaqueId ⇒ no autofill
    } else {
      expect(other.kind).toBe("host-not-known"); // fail-closed, never the port-22 binding
    }
  });
});

describe.skipIf(!hasOpenSsh)("§8 #4 — known-host-absent fallback", () => {
  it("a host missing from every consulted file ⇒ host-not-known (no lookup, no save)", async () => {
    const r = await resolveCanonicalForSshCommand([...mainOpts(), "u@unknown.example.com"]);
    expect(r).toMatchObject({ kind: "host-not-known", host: "unknown.example.com" });
  });
});

describe.skipIf(!hasOpenSsh)("§8 #3 — P2-1 defense: recorded-identity drift (acceptance-critical)", () => {
  it("known_hosts rotates FP1→FP2 ⇒ canonical differs ⇒ store misses ⇒ NO autofill", async () => {
    const opts = ["-F", cfg, "-o", `UserKnownHostsFile=${khDrift}`, "-o", `GlobalKnownHostsFile=${absent}`];
    const store = BindingStore.load(join(tmp, "store"), async () => true);

    const bound = await resolveCanonicalForSshCommand([...opts, "bob@real.example.com"]);
    expect(bound.kind).toBe("ok");
    if (bound.kind !== "ok") return;
    store.bind(bound.canonical, "ab".repeat(16), {
      scheme: "ssh",
      displayUri: formatBindingUri(bound.uri),
      host: bound.uri.host,
      user: bound.uri.user,
      port: bound.uri.port,
      fpSet: bound.uri.fpSet,
      createdAt: new Date().toISOString(),
    });

    // Positive control: unchanged known_hosts resolves to the bound opaqueId.
    expect(await store.resolve(bound.canonical)).toEqual({ opaqueId: "ab".repeat(16) });

    // The recorded identity drifts (key rotation / alias re-point): same command, new stored key.
    writeFileSync(khDrift, `real.example.com ${pub2}\n`, "utf8");
    const drifted = await resolveCanonicalForSshCommand([...opts, "bob@real.example.com"]);
    expect(drifted.kind).toBe("ok");
    if (drifted.kind !== "ok") return;
    expect(drifted.canonical).not.toBe(bound.canonical);
    expect(await store.resolve(drifted.canonical)).toBeUndefined(); // ⇒ no opaqueId ⇒ no autofill
  });
});

// ── F-3: OpenSSH's two-pass argv rule ────────────────────────────────────────────────────────────────
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3x-complete-fix-plan.md §1.2 / §5 PR1.2 — the table
// below IS that table. Findings: …-la-live-dogfood-findings.md F-3.
//
// The pre-fix parser stopped at the destination and dropped every option behind it, so
// `ssh user@h -p 2222` resolved as port 22 (the wrong endpoint's secret could be typed into this one's
// prompt) and `ssh h -v` was misread as a one-shot (⇒ the pane was trusted LOCAL while a remote login was
// open). Real ssh accepts post-destination options because ssh.c runs getopt AGAIN after the destination
// (`goto again`) — ssh.c's own rule, not platform getopt permutation, so it is identical in every build.
describe("parseSshCommand — OpenSSH two-pass argv rule (F-3)", () => {
  interface Row {
    n: string;
    argv: string[];
    destination: string | undefined;
    optionArgs: string[];
    flagLetters: string[];
    remoteCommand: string[];
    undecidable: boolean;
    queryMode?: boolean;
  }
  const rows: Row[] = [
    { n: "1  h", argv: ["h"], destination: "h", optionArgs: [], flagLetters: [], remoteCommand: [], undecidable: false },
    { n: "2  -p 2222 alice@h", argv: ["-p", "2222", "alice@h"], destination: "alice@h", optionArgs: ["-p", "2222"], flagLetters: ["p"], remoteCommand: [], undecidable: false },
    { n: "3  alice@h -p 2222 (FIXED)", argv: ["alice@h", "-p", "2222"], destination: "alice@h", optionArgs: ["-p", "2222"], flagLetters: ["p"], remoteCommand: [], undecidable: false },
    { n: "4  h ls", argv: ["h", "ls"], destination: "h", optionArgs: [], flagLetters: [], remoteCommand: ["ls"], undecidable: false },
    { n: "5  h -v (FIXED)", argv: ["h", "-v"], destination: "h", optionArgs: ["-v"], flagLetters: ["v"], remoteCommand: [], undecidable: false },
    { n: "6  h -v ls", argv: ["h", "-v", "ls"], destination: "h", optionArgs: ["-v"], flagLetters: ["v"], remoteCommand: ["ls"], undecidable: false },
    { n: "7  h ls -v (the -v is the remote ls's)", argv: ["h", "ls", "-v"], destination: "h", optionArgs: [], flagLetters: [], remoteCommand: ["ls", "-v"], undecidable: false },
    { n: "8  -G h", argv: ["-G", "h"], destination: "h", optionArgs: ["-G"], flagLetters: ["G"], remoteCommand: [], undecidable: false, queryMode: true },
    { n: "9  h -G", argv: ["h", "-G"], destination: "h", optionArgs: ["-G"], flagLetters: ["G"], remoteCommand: [], undecidable: false, queryMode: true },
    { n: "10 -l other h", argv: ["-l", "other", "h"], destination: "h", optionArgs: ["-l", "other"], flagLetters: ["l"], remoteCommand: [], undecidable: false },
    { n: "11 h -l other (FIXED)", argv: ["h", "-l", "other"], destination: "h", optionArgs: ["-l", "other"], flagLetters: ["l"], remoteCommand: [], undecidable: false },
    { n: "12 -N -L 8080:x:80 h", argv: ["-N", "-L", "8080:x:80", "h"], destination: "h", optionArgs: ["-N", "-L", "8080:x:80"], flagLetters: ["N", "L"], remoteCommand: [], undecidable: false },
    { n: "13 h -N -L 8080:x:80", argv: ["h", "-N", "-L", "8080:x:80"], destination: "h", optionArgs: ["-N", "-L", "8080:x:80"], flagLetters: ["N", "L"], remoteCommand: [], undecidable: false },
    { n: "14 -4p 2222 h", argv: ["-4p", "2222", "h"], destination: "h", optionArgs: ["-4p", "2222"], flagLetters: ["4", "p"], remoteCommand: [], undecidable: false },
    { n: "15 -p2222 alice@h", argv: ["-p2222", "alice@h"], destination: "alice@h", optionArgs: ["-p2222"], flagLetters: ["p"], remoteCommand: [], undecidable: false },
    { n: "16 alice@h -p2222 (FIXED)", argv: ["alice@h", "-p2222"], destination: "alice@h", optionArgs: ["-p2222"], flagLetters: ["p"], remoteCommand: [], undecidable: false },
    { n: "17 -J bastion h", argv: ["-J", "bastion", "h"], destination: "h", optionArgs: ["-J", "bastion"], flagLetters: ["J"], remoteCommand: [], undecidable: false },
    { n: "18 h -J bastion (FIXED)", argv: ["h", "-J", "bastion"], destination: "h", optionArgs: ["-J", "bastion"], flagLetters: ["J"], remoteCommand: [], undecidable: false },
    { n: "19 h -z (letter in neither table)", argv: ["h", "-z"], destination: "h", optionArgs: ["-z"], flagLetters: ["z"], remoteCommand: [], undecidable: true },
    { n: "20 -P mytag h (-P takes a tag)", argv: ["-P", "mytag", "h"], destination: "h", optionArgs: ["-P", "mytag"], flagLetters: ["P"], remoteCommand: [], undecidable: false },
    { n: "20b -P h (the tag eats the destination)", argv: ["-P", "h"], destination: undefined, optionArgs: ["-P", "h"], flagLetters: ["P"], remoteCommand: [], undecidable: true },
    { n: "22 (empty argv)", argv: [], destination: undefined, optionArgs: [], flagLetters: [], remoteCommand: [], undecidable: true },
    { n: "23 -V", argv: ["-V"], destination: undefined, optionArgs: ["-V"], flagLetters: ["V"], remoteCommand: [], undecidable: false, queryMode: true },
    { n: "24 -Q cipher", argv: ["-Q", "cipher"], destination: undefined, optionArgs: ["-Q", "cipher"], flagLetters: ["Q"], remoteCommand: [], undecidable: false, queryMode: true },
    { n: "25 -1 h (retired letter — in NEITHER table by design)", argv: ["-1", "h"], destination: "h", optionArgs: ["-1"], flagLetters: ["1"], remoteCommand: [], undecidable: true },
    { n: "26 -2 h (accepted no-op)", argv: ["-2", "h"], destination: "h", optionArgs: ["-2"], flagLetters: ["2"], remoteCommand: [], undecidable: false },
  ];

  it.each(rows)("row $n", (r: Row) => {
    const p = parseSshCommand(r.argv);
    expect(p.destination).toBe(r.destination);
    expect(p.optionArgs).toEqual(r.optionArgs);
    expect([...p.flagLetters].sort()).toEqual([...r.flagLetters].sort());
    expect(p.remoteCommand).toEqual(r.remoteCommand);
    expect(p.undecidable).toBe(r.undecidable);
    expect(p.queryMode).toBe(r.queryMode ?? false);
  });
});

// ── §1.3.1 flag-table drift guard ────────────────────────────────────────────────────────────────────
//
// Both tables are a COPY of a moving spec (the `man ssh` synopsis). The parser CONTAINS an unknown letter
// safely (`undecidable` ⇒ every consumer declines), but a drifted table silently costs autofill — and a
// future with-arg letter we mis-list as no-arg is the one direction that can mis-locate a destination.
// This canary re-derives both sets from the LOCAL ssh's own usage text, so the OpenSSH upgrade that moves
// a letter fails here — on the machine that upgraded — instead of going unnoticed.
//
// A canary, not a gate: it skips where OpenSSH is absent (the same rule as the real-`ssh -G` suites above).
describe.skipIf(!hasOpenSsh)("§1.3.1 — the flag tables match the local OpenSSH synopsis", () => {
  // `ssh` with no args prints the usage synopsis and exits non-zero — that IS the normal path here.
  const usage = (): string => {
    const r = spawnSync("ssh", [], { encoding: "utf8", windowsHide: true });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };

  it("every `[-X value]` letter in the synopsis is in SSH_FLAGS_WITH_ARG, and vice versa", () => {
    // `[-B bind_interface]` / `[-D [bind_address:]port]` / `[-w local_tun[:remote_tun]]` — a letter, a
    // space, then a value placeholder. The bare cluster `[-46Aa…]` has no space, so it never matches here.
    const real = [...usage().matchAll(/\[-([A-Za-z]) [^\]]/g)].map((m) => m[1]);
    expect(real.length).toBeGreaterThan(10); // the synopsis parsed at all (guards against a format change)
    expect([...new Set(real)].sort()).toEqual([...SSH_FLAGS_WITH_ARG].sort());
  });

  it("the synopsis no-arg cluster equals SSH_FLAGS_NO_ARG minus the measured `2` exception", () => {
    const cluster = /\[-([A-Za-z0-9]+)\]/.exec(usage())?.[1] ?? "";
    expect(cluster.length).toBeGreaterThan(10); // the cluster parsed at all
    // `2` is the ONE deliberate extra: the synopsis omits it, but every build still ACCEPTS it as a no-op
    // (measured: `ssh -2 -G host` prints the config), so `ssh -2 host` opens a REAL session and must
    // classify as a login. `1` is deliberately in NEITHER table (real ssh: "SSH protocol v.1 is no longer
    // supported", fatal) and is therefore INSIDE this guard's net — if a future OpenSSH re-uses `-1`, this
    // fails and we re-decide rather than silently classifying a dead invocation as a login.
    expect([...cluster].sort()).toEqual([...SSH_FLAGS_NO_ARG].filter((c) => c !== "2").sort());
  });
});
