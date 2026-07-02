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
import { resolveCanonicalForSshCommand } from "../../src/engine/key-locker/ssh-resolve.js";
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
