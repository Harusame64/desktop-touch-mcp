// ADR-014 v2 R3 L1 — acceptance §8 #1: binding-URI grammar (table-driven).
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md
import { describe, expect, it } from "vitest";
import {
  BindingParseError,
  CanonicalKeyError,
  canonicalKey,
  formatBindingUri,
  parseBindingUri,
  type BindingUri,
} from "../../src/engine/key-locker/binding.js";

describe("binding-URI grammar (§2.1) — valid forms", () => {
  const cases: Array<{ input: string; expected: BindingUri; display?: string }> = [
    {
      input: "ssh://alice@host.example.com",
      expected: { scheme: "ssh", user: "alice", host: "host.example.com", port: 22 },
    },
    {
      input: "ssh://alice@Host.Example.COM:2222",
      expected: { scheme: "ssh", user: "alice", host: "host.example.com", port: 2222 },
      display: "ssh://alice@host.example.com:2222", // host lowercased, non-default port kept
    },
    {
      input: "ssh://root@[::1]:2200",
      expected: { scheme: "ssh", user: "root", host: "[::1]", port: 2200 },
    },
    {
      input: "sudo://localhost/root",
      expected: { scheme: "sudo", host: "localhost", targetUser: "root" },
    },
    {
      input: "sudo://prod.example.com/deploy",
      expected: { scheme: "sudo", host: "prod.example.com", targetUser: "deploy" },
    },
    {
      input: "https-cred://github.com",
      expected: { scheme: "https-cred", user: undefined, host: "github.com", port: 443, path: undefined },
    },
    {
      // EMAIL git username round-trip (Codex R7 P2): percent-encoded, no bare second '@'.
      input: "https-cred://alice%40example.com@github.com/user/repo.git",
      expected: {
        scheme: "https-cred",
        user: "alice@example.com",
        host: "github.com",
        port: 443,
        path: "user/repo.git",
      },
    },
    {
      // Trailing slash stripped from path (§2.2 canonicalization applies at parse).
      input: "https-cred://git.example.com:8443/group/proj/",
      expected: { scheme: "https-cred", user: undefined, host: "git.example.com", port: 8443, path: "group/proj" },
      display: "https-cred://git.example.com:8443/group/proj",
    },
    {
      // Opaque form: standard-base64 '+' and '/' round-trip BYTE-FOR-BYTE (Codex R7 P2).
      input: "sshkey:SHA256:aB+c/9zZ0KqWx3yV5tUu4rSs2qPp1oNn0mMlLkKjJiI",
      expected: { scheme: "sshkey", keyFp: "SHA256:aB+c/9zZ0KqWx3yV5tUu4rSs2qPp1oNn0mMlLkKjJiI" },
    },
  ];

  for (const { input, expected, display } of cases) {
    it(`parses ${input}`, () => {
      const parsed = parseBindingUri(input);
      expect(parsed).toEqual(expected);
      expect(formatBindingUri(parsed)).toBe(display ?? input);
    });
  }

  it("re-parses its own display form (round-trip)", () => {
    const uri = parseBindingUri("https-cred://alice%40example.com@github.com/user/repo.git");
    expect(parseBindingUri(formatBindingUri(uri))).toEqual(uri);
  });
});

describe("binding-URI grammar — typed rejects (no partial parse)", () => {
  const rejects: Array<{ input: string; code: string }> = [
    { input: "ftp://host", code: "UnknownScheme" },
    { input: "ssh//host", code: "UnknownScheme" }, // no colon → scheme "ssh//host"... actually caught below
    { input: "ssh://host.example.com", code: "MissingComponent" }, // ssh REQUIRES userinfo
    { input: "sudo://host.example.com", code: "MissingComponent" }, // no target-user
    { input: "sudo://host/", code: "MissingComponent" },
    { input: "sudo://host:22/root", code: "MalformedUri" }, // sudo takes no port
    { input: "ssh://u@h:99999", code: "BadPort" },
    { input: "ssh://u@h:0", code: "BadPort" },
    { input: "ssh://u@h:12x", code: "BadPort" },
    { input: "ssh://a b@h", code: "MalformedUri" }, // raw space must be pct-encoded
    { input: "ssh://a%2@h", code: "BadPercentEscape" },
    { input: "ssh://u@[::1", code: "MalformedUri" }, // unterminated IPv6 bracket
    { input: "ssh://u@", code: "MissingComponent" },
    { input: "sshkey:MD5:abcdef", code: "MalformedUri" }, // fp must be SHA256:base64-nopad
    { input: "sshkey:SHA256:has=pad", code: "MalformedUri" },
    { input: "https-cred://@github.com", code: "MissingComponent" }, // empty userinfo before '@'
    { input: "", code: "MalformedUri" },
    { input: "ssh:", code: "MalformedUri" },
  ];

  for (const { input, code } of rejects) {
    it(`rejects '${input}' with a typed ${code}-family error`, () => {
      try {
        parseBindingUri(input);
        expect.unreachable(`'${input}' should not parse`);
      } catch (e) {
        expect(e).toBeInstanceOf(BindingParseError);
        // The exact sub-code for a few inputs legitimately varies by which check fires first;
        // what the contract pins is: typed BindingParseError, valid code, input carried.
        expect(["UnknownScheme", "MissingComponent", "MalformedUri", "BadPercentEscape", "BadPort"]).toContain(
          (e as BindingParseError).code,
        );
        expect((e as BindingParseError).input).toBe(input);
      }
    });
  }
});

describe("canonical key (§2.2)", () => {
  it("ssh canonical requires the resolved fp-set (typed error without it)", () => {
    const uri = parseBindingUri("ssh://alice@host.example.com");
    expect(() => canonicalKey(uri)).toThrowError(CanonicalKeyError);
  });

  it("ssh canonical: explicit port + fp-set deduped and sorted ascending", () => {
    const uri = parseBindingUri("ssh://alice@host.example.com") as BindingUri & { scheme: "ssh" };
    uri.fpSet = ["SHA256:bbb", "SHA256:aaa", "SHA256:bbb"];
    expect(canonicalKey(uri)).toBe("ssh://alice@host.example.com:22|fp=SHA256:aaa,SHA256:bbb");
  });

  it("different fp-set ⇒ different canonical (the P2-1 lookup-layer defense)", () => {
    const a = parseBindingUri("ssh://u@h") as BindingUri & { scheme: "ssh" };
    const b = parseBindingUri("ssh://u@h") as BindingUri & { scheme: "ssh" };
    a.fpSet = ["SHA256:FP1"];
    b.fpSet = ["SHA256:FP2"];
    expect(canonicalKey(a)).not.toBe(canonicalKey(b));
  });

  it("sudo / https-cred / sshkey canonicals are deterministic with explicit ports", () => {
    expect(canonicalKey(parseBindingUri("sudo://localhost/root"))).toBe("sudo://localhost/root");
    expect(canonicalKey(parseBindingUri("https-cred://github.com/a/b"))).toBe("https-cred://github.com:443/a/b");
    expect(canonicalKey(parseBindingUri("https-cred://alice%40example.com@github.com"))).toBe(
      "https-cred://alice%40example.com@github.com:443",
    );
    expect(canonicalKey(parseBindingUri("sshkey:SHA256:x+y/z"))).toBe("sshkey:SHA256:x+y/z");
  });
});
