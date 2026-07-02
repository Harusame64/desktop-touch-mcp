// ADR-014 v2 R3 Key Locker — L1 binding model: the binding-URI grammar (THE LOCKED CONTRACT),
// parser, serializer, and canonical-key derivation.
//
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md (§2)
//
// Two related strings, kept distinct on purpose:
//   * the BINDING URI — the human-facing / derived-from-command form (management + logs show it);
//     RFC-3986-safe (userinfo/target-user/path are percent-encoded, `sshkey:` is the opaque
//     authority-less form so ssh-keygen's standard-base64 `+`/`/` need no re-encoding).
//   * the CANONICAL KEY — the exact string used as the store map key. Canonical keys are INTERNAL
//     comparison strings, never re-parsed for navigation, so the ssh `|fp=…` tail (non-URI `|`
//     delimiter + raw base64) is safe there.
//
// Grammar (ABNF, frozen):
//   binding-uri = ssh-uri / sudo-uri / git-uri / sshkey-uri
//   ssh-uri     = "ssh://" userinfo "@" host [":" port]
//   sudo-uri    = "sudo://" host "/" target-user
//   git-uri     = "https-cred://" [userinfo "@"] host [":" port] ["/" path]
//   sshkey-uri  = "sshkey:" key-fp            ; OPAQUE, host-independent, URN-like
//   key-fp      = "SHA256:" base64-nopad      ; exactly as `ssh-keygen -l -f` prints
//
// No secret ever appears at this layer — URIs, fingerprints (public) and opaque ids only.

/** Scheme default ports (canonical keys always carry an explicit port). */
const SSH_DEFAULT_PORT = 22;
const HTTPS_DEFAULT_PORT = 443;

export type BindingParseErrorCode =
  | "UnknownScheme"
  | "MissingComponent"
  | "MalformedUri"
  | "BadPercentEscape"
  | "BadPort";

/**
 * Typed reject for malformed / unknown-scheme / missing-required-component URIs — no silent
 * fallthrough, no partial parse. Carries the offending input (never a secret; none exists here).
 */
export class BindingParseError extends Error {
  readonly code: BindingParseErrorCode;
  readonly input: string;
  constructor(code: BindingParseErrorCode, message: string, input: string) {
    super(`${message} (input: ${input})`);
    this.name = "BindingParseError";
    this.code = code;
    this.input = input;
  }
}

/**
 * A parsed binding target (discriminated on `scheme`). Components hold DECODED values
 * (`formatBindingUri` re-encodes); `host` is lowercased, `port` is always explicit
 * (scheme default filled in).
 *
 * The ssh variant's `fpSet` is a RESOLUTION product (§3: known_hosts fingerprints), not part of
 * the URI string grammar — `parseBindingUri` leaves it undefined; `deriveBinding` fills it so the
 * canonical key (which requires it) is computable without re-running `ssh -G`.
 */
export type BindingUri =
  | { scheme: "ssh"; user: string; host: string; port: number; fpSet?: string[] }
  | { scheme: "sudo"; host: string; targetUser: string }
  | { scheme: "https-cred"; user?: string; host: string; port: number; path?: string }
  | { scheme: "sshkey"; keyFp: string };

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const KEY_FP_RE = /^SHA256:[A-Za-z0-9+/]+$/;
const PORT_RE = /^[0-9]{1,5}$/;
// hostname / IPv4 (loose; ssh -G returns resolved ASCII/punycode hosts). IPv6 is bracketed.
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9\-._]*[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;

/** Percent-encode per the grammar: keep `unreserved` (plus `/` when `keepSlash`), escape the rest. */
function pctEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (UNRESERVED.test(ch) || (keepSlash && ch === "/")) {
      out += ch;
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Strict percent-decode; rejects bad escapes and raw characters outside the grammar. */
function pctDecode(value: string, keepSlash: boolean, input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "%") {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new BindingParseError("BadPercentEscape", `bad percent escape at '%${hex}'`, input);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (UNRESERVED.test(ch) || (keepSlash && ch === "/")) {
      bytes.push(ch.charCodeAt(0));
    } else {
      throw new BindingParseError("MalformedUri", `character '${ch}' must be percent-encoded`, input);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function parsePort(raw: string, input: string): number {
  if (!PORT_RE.test(raw)) throw new BindingParseError("BadPort", `bad port '${raw}'`, input);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new BindingParseError("BadPort", `port ${port} out of range`, input);
  return port;
}

/** Parse `host[:port]`, handling bracketed IPv6. Returns the LOWERCASED host. */
function parseHostPort(raw: string, input: string): { host: string; port?: number } {
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) throw new BindingParseError("MalformedUri", "unterminated IPv6 bracket", input);
    const host = raw.slice(1, close);
    if (host.length === 0 || !IPV6_RE.test(host)) {
      throw new BindingParseError("MalformedUri", `bad IPv6 host '[${host}]'`, input);
    }
    const rest = raw.slice(close + 1);
    if (rest === "") return { host: `[${host.toLowerCase()}]` };
    if (!rest.startsWith(":")) throw new BindingParseError("MalformedUri", `junk after IPv6 host: '${rest}'`, input);
    return { host: `[${host.toLowerCase()}]`, port: parsePort(rest.slice(1), input) };
  }
  const colon = raw.indexOf(":");
  const host = colon < 0 ? raw : raw.slice(0, colon);
  if (host.length === 0 || !HOST_RE.test(host)) {
    throw new BindingParseError(host.length === 0 ? "MissingComponent" : "MalformedUri", `bad host '${host}'`, input);
  }
  if (colon < 0) return { host: host.toLowerCase() };
  return { host: host.toLowerCase(), port: parsePort(raw.slice(colon + 1), input) };
}

/**
 * Parse a binding-URI string into its discriminated type. Throws `BindingParseError` (typed
 * reject) on any malformed / unknown-scheme / missing-component input — never a partial parse.
 */
export function parseBindingUri(input: string): BindingUri {
  const colon = input.indexOf(":");
  if (colon <= 0) throw new BindingParseError("MalformedUri", "no scheme", input);
  const scheme = input.slice(0, colon);

  if (scheme === "sshkey") {
    // OPAQUE form — everything after the first `:` is the fingerprint literal, byte-for-byte.
    const keyFp = input.slice(colon + 1);
    if (!KEY_FP_RE.test(keyFp)) {
      throw new BindingParseError("MalformedUri", "sshkey fingerprint must be 'SHA256:<base64-nopad>'", input);
    }
    return { scheme: "sshkey", keyFp };
  }

  if (scheme !== "ssh" && scheme !== "sudo" && scheme !== "https-cred") {
    throw new BindingParseError("UnknownScheme", `unknown scheme '${scheme}'`, input);
  }
  if (input.slice(colon + 1, colon + 3) !== "//") {
    throw new BindingParseError("MalformedUri", `'${scheme}://' authority form required`, input);
  }
  const rest = input.slice(colon + 3);
  if (rest.length === 0) throw new BindingParseError("MissingComponent", "empty authority", input);

  if (scheme === "ssh") {
    const at = rest.lastIndexOf("@");
    if (at <= 0) throw new BindingParseError("MissingComponent", "ssh:// requires userinfo@host", input);
    const user = pctDecode(rest.slice(0, at), false, input);
    const { host, port } = parseHostPort(rest.slice(at + 1), input);
    return { scheme: "ssh", user, host, port: port ?? SSH_DEFAULT_PORT };
  }

  if (scheme === "sudo") {
    const slash = rest.indexOf("/");
    if (slash < 0 || slash === rest.length - 1) {
      throw new BindingParseError("MissingComponent", "sudo:// requires host/target-user", input);
    }
    const { host, port } = parseHostPort(rest.slice(0, slash), input);
    if (port !== undefined) throw new BindingParseError("MalformedUri", "sudo:// takes no port", input);
    const targetUser = pctDecode(rest.slice(slash + 1), false, input);
    if (targetUser.length === 0) throw new BindingParseError("MissingComponent", "empty target-user", input);
    return { scheme: "sudo", host, targetUser };
  }

  // https-cred://[user@]host[:port][/path]
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const rawPath = slash < 0 ? undefined : rest.slice(slash + 1);
  const at = authority.lastIndexOf("@");
  const user = at > 0 ? pctDecode(authority.slice(0, at), false, input) : undefined;
  if (at === 0) throw new BindingParseError("MissingComponent", "empty userinfo before '@'", input);
  const { host, port } = parseHostPort(authority.slice(at + 1), input);
  const path = rawPath === undefined || rawPath === ""
    ? undefined
    : pctDecode(rawPath.replace(/\/+$/, ""), true, input) || undefined;
  return { scheme: "https-cred", user, host, port: port ?? HTTPS_DEFAULT_PORT, path };
}

/**
 * Serialize to the display URI (§5.1 `displayUri`): RFC-safe, no fp-set, default port omitted.
 */
export function formatBindingUri(b: BindingUri): string {
  switch (b.scheme) {
    case "ssh": {
      const port = b.port === SSH_DEFAULT_PORT ? "" : `:${b.port}`;
      return `ssh://${pctEncode(b.user, false)}@${b.host}${port}`;
    }
    case "sudo":
      return `sudo://${b.host}/${pctEncode(b.targetUser, false)}`;
    case "https-cred": {
      const user = b.user !== undefined ? `${pctEncode(b.user, false)}@` : "";
      const port = b.port === HTTPS_DEFAULT_PORT ? "" : `:${b.port}`;
      const path = b.path !== undefined ? `/${pctEncode(b.path, true)}` : "";
      return `https-cred://${user}${b.host}${port}${path}`;
    }
    case "sshkey":
      return `sshkey:${b.keyFp}`;
  }
}

export type CanonicalKeyErrorCode = "SshFingerprintSetRequired";

/** Typed failure for canonical-key derivation (ssh without a resolved fp-set). */
export class CanonicalKeyError extends Error {
  readonly code: CanonicalKeyErrorCode;
  constructor(code: CanonicalKeyErrorCode, message: string) {
    super(message);
    this.name = "CanonicalKeyError";
    this.code = code;
  }
}

/** Dedupe + ascending-sort a fingerprint set (the §2.2 determinism rule). */
export function canonicalFpSet(fpSet: readonly string[]): string[] {
  return [...new Set(fpSet)].sort();
}

/**
 * Derive the canonical store key (§2.2). Deterministic so equal bindings collide: lowercase host
 * (parse already did), explicit port (scheme default filled), fp-set deduped + sorted, no trailing
 * slash on path. The ssh form REQUIRES the resolved fp-set — the P2-1 defense lives in the key.
 */
export function canonicalKey(b: BindingUri): string {
  switch (b.scheme) {
    case "ssh": {
      if (!b.fpSet || b.fpSet.length === 0) {
        throw new CanonicalKeyError(
          "SshFingerprintSetRequired",
          "ssh canonical key requires the resolved known_hosts fingerprint set (§3)",
        );
      }
      return `ssh://${pctEncode(b.user, false)}@${b.host}:${b.port}|fp=${canonicalFpSet(b.fpSet).join(",")}`;
    }
    case "sudo":
      return `sudo://${b.host}/${pctEncode(b.targetUser, false)}`;
    case "https-cred": {
      const user = b.user !== undefined ? `${pctEncode(b.user, false)}@` : "";
      const path = b.path !== undefined ? `/${pctEncode(b.path, true)}` : "";
      return `https-cred://${user}${b.host}:${b.port}${path}`;
    }
    case "sshkey":
      return `sshkey:${b.keyFp}`;
  }
}
