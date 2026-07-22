// ADR-014 v2 R3 Key Locker — L4 §1: the `key_locker` MCP tool (management + first-run consent).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l4-tool-surface-plan.md §1
//
// A MANAGEMENT + pre-seed surface only — five actions: list / save / forget / set_policy / status.
// There is NO `autofill` action: autofill happens automatically in L3's capture-on-use loop when a
// credential prompt is detected for a bound command; a manual "fill now" tool would duplicate the loop
// and let the model drive injection out of band (OQ-R3-1). The tool NEVER sees a secret — `save` opens
// the LOCKER's secure dialog (secret goes locker→DPAPI), everything else is metadata / control.
//
// Consent (L4 §2): every action except `status` requires first-run consent. `save` ACQUIRES it (prompts
// the locker's `-Consent` dialog via `ensureConsent`); the others check and fail with a typed
// `KeyLockerConsentRequired` (so the user is told to enable, never silently blocked). The kill switch
// (`DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1`) is checked at REGISTRATION — a disabled locker is not offered.

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failCode, getSuggestsForCode } from "./_errors.js";
import {
  withEnvelopeIncludeForUnion,
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
  makeQueryWrapper,
} from "./_envelope.js";
import {
  KeyLockerManager,
  keyLockerDisabled,
} from "../engine/key-locker/key-locker-manager.js";
import { BindingStore, type BindingMeta } from "../engine/key-locker/binding-store.js";
import {
  parseBindingUri,
  canonicalKey,
  formatBindingUri,
  type BindingUri,
} from "../engine/key-locker/binding.js";
import { resolveCanonicalForSshCommand, type ExecFn } from "../engine/key-locker/ssh-resolve.js";
import { keyLockerWiring } from "./key-locker-wiring.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema — a discriminated union over `action` (Opus R1 P2-6: the FULL 3-layer chain, mirroring excel).
// ─────────────────────────────────────────────────────────────────────────────

const URI_DESC =
  "A binding URI identifying the credential target — e.g. `ssh://user@host:22`, `sudo://host/root`, " +
  "`https-cred://github.com:443`, `sshkey:SHA256:…` (no `//`). Parsed per the L1 grammar; malformed input is rejected.";

const listSchema = z.object({
  action: z.literal("list").describe("Enumerate saved bindings (non-secret metadata only)."),
});

const saveSchema = z.object({
  action: z.literal("save").describe(
    "Pre-seed a credential: open the locker's secure entry dialog, store the secret encrypted (Windows " +
      "DPAPI), and bind it to this URI. Prompts the one-time enable dialog if the locker isn't enabled yet. " +
      "The secret is typed into the locker, never sent to this tool.",
  ),
  uri: z.string().min(1).describe(URI_DESC),
});

const forgetSchema = z.object({
  action: z.literal("forget").describe("Delete a saved binding and its stored secret."),
  uri: z.string().min(1).describe(URI_DESC),
});

const setPolicySchema = z.object({
  action: z.literal("set_policy").describe(
    "Set the per-binding autofill confirmation policy. By DEFAULT every autofill asks you to confirm " +
      "(the safe backstop). Set confirmEveryInjection=false to OPT OUT of confirmation for this one " +
      "binding (it will then autofill silently); true restores the confirm-every default.",
  ),
  uri: z.string().min(1).describe(URI_DESC),
  confirmEveryInjection: z.boolean().describe(
    "true (default) = confirm every autofill for this binding; false = opt out (autofill without asking).",
  ),
});

const statusSchema = z.object({
  action: z.literal("status").describe(
    "Report locker health: whether it's enabled (consent), whether it's disabled by the kill switch, how " +
      "many bindings are saved. Readable without enabling.",
  ),
});

const launchConsoleSchema = z.object({
  action: z.literal("launch_console").describe(
    "Launch (or reuse) an autofill-capable anchored terminal pane and return its paneId + windowTitle. Use " +
      "this BEFORE running an ssh / sudo / login command for the user: launch the pane, then drive the command " +
      "into it with terminal({action:'run'|'send', paneId}). Pass the `paneId` field (NOT `windowTitle`) to " +
      "terminal — paneId keeps targeting this pane even after its title changes (e.g. after ssh login). KEEP the " +
      "paneId: there is no pane-listing action, but if you lose it, call this again with the default fresh:false " +
      "to reuse the most-recent still-open pane and get its paneId back. Autofill ONLY works in a pane launched " +
      "this way — a pre-existing terminal the user opened is never autofilled. By default the pane opens as a NEW " +
      "TAB in the user's current Windows Terminal window (a new window if none is open); the human can ALSO see " +
      "and type into it (cooperative handoff). Enabling the locker grants this launch ability.",
  ),
  fresh: z.boolean().optional().describe(
    "false (default) = reuse the most-recent still-open anchored pane of the requested host; true = open a NEW one (bounded).",
  ),
  host: z.enum(["windows-terminal", "classic"]).optional().describe(
    "'windows-terminal' (default) = open a new tab in the user's current Windows Terminal window. " +
      "'classic' = open a dedicated classic console window instead (the fallback when Windows Terminal is " +
      "not installed — a KeyLockerWtUnavailable error tells you to retry with this). A Windows Terminal " +
      "pane autofills/reads only while its tab is the ACTIVE tab; a classic console has its own window.",
  ),
});

export const keyLockerSchema = z.discriminatedUnion("action", [
  listSchema,
  saveSchema,
  forgetSchema,
  setPolicySchema,
  statusSchema,
  launchConsoleSchema,
]);

export type KeyLockerArgs = z.infer<typeof keyLockerSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Singletons — one manager (owns the locker host lifecycle) per server process.
// ─────────────────────────────────────────────────────────────────────────────

let managerSingleton: KeyLockerManager | null = null;
function manager(): KeyLockerManager {
  return (managerSingleton ??= new KeyLockerManager());
}

/** The shared `KeyLockerManager` singleton — the L4 tool AND the W-4 live wiring MUST use the SAME instance so
 *  they share the one host + the one `tracker`/`watch`/`snapshotProcessTree` (Explore gap4). Lazy-constructs on
 *  first use; honors `__setKeyLockerManagerForTest`. */
export function keyLockerManager(): KeyLockerManager {
  return manager();
}

/** TEST-ONLY seam: inject a manager (e.g. a fake-host subclass) or reset (null) the singleton. */
export function __setKeyLockerManagerForTest(mgr: KeyLockerManager | null): void {
  managerSingleton = mgr;
}

/**
 * TEST-ONLY seam: inject the `exec` the ssh `save` path passes to `resolveCanonicalForSshCommand`
 * (a fake `ssh -G` / `ssh-keygen`), so the ssh save→canonical parity is unit-testable without real
 * ssh binaries / known_hosts. `undefined`/`null` = the real `defaultExec` (production).
 */
let sshExecForTest: ExecFn | undefined;
export function __setSshExecForTest(exec: ExecFn | null): void {
  sshExecForTest = exec ?? undefined;
}

/** A management-only store (list/bind/unbind/setPolicy never need the locker's existence check). */
function store(): BindingStore {
  return BindingStore.load(manager().storeDir);
}

/** A typed failure with the code's fixed SUGGESTS hint (explicit code — no message classification). */
function fail(code: string, message: string): ToolResult {
  return failCode(code, message, { suggest: getSuggestsForCode(code) });
}

/**
 * Present ANY thrown error as a typed tool failure. Typed errors (KeyLocker*, BindingParseError, …)
 * carry a `.code` — emit it EXPLICITLY via `failCode` so the code family stays coherent regardless of
 * whether a `classify` branch exists (the host codes are surfaced dynamically via `err.code`, so they
 * have no source-literal a classify producer-pin could see). Untyped errors fall through to `failWith`.
 */
function keyLockerFailure(err: unknown): ToolResult {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    const msg = err instanceof Error ? err.message : String(err);
    return fail(code, msg.startsWith(code) ? msg : `${code}: ${msg}`);
  }
  return failWith(err, "key_locker");
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleList(): ToolResult {
  if (!manager().isConsentAccepted()) {
    return fail("KeyLockerConsentRequired", "KeyLockerConsentRequired: enable the key locker before managing bindings");
  }
  const bindings = store().list().map((row) => ({
    displayUri: row.displayUri,
    scheme: row.scheme,
    ...(row.host !== undefined ? { host: row.host } : {}),
    ...(row.user !== undefined ? { user: row.user } : {}),
    ...(row.port !== undefined ? { port: row.port } : {}),
    createdAt: row.createdAt,
    // The RESOLVED policy (matches the capture-loop's `confirmPolicyFor` = `?? true`): an unset binding
    // CONFIRMS by default (the safe backstop). Reporting `?? false` here would tell the user "won't ask"
    // while the loop actually asks (#500 vs #502 drift — the confirm default is ON unless opted out).
    confirmEveryInjection: row.confirmEveryInjection ?? true,
  }));
  return ok({ bindings });
}

function handleStatus(): ToolResult {
  const mgr = manager();
  return ok({
    consentAccepted: mgr.isConsentAccepted(),
    disabled: mgr.isDisabled(),
    bindingCount: store().list().length,
    envInjectionEnabled: false, // env-var / API-token injection is R4-gated (not enabled)
  });
}

/** Build the non-ssh binding meta from a parsed URI (ssh meta is built from the resolver result). */
function metaForNonSsh(parsed: Exclude<BindingUri, { scheme: "ssh" }>): BindingMeta {
  const base = { displayUri: formatBindingUri(parsed), createdAt: new Date().toISOString() };
  switch (parsed.scheme) {
    case "sudo":
      return { scheme: "sudo", host: parsed.host, targetUser: parsed.targetUser, ...base };
    case "https-cred":
      return { scheme: "https-cred", host: parsed.host, port: parsed.port, ...(parsed.user !== undefined ? { user: parsed.user } : {}), ...base };
    case "sshkey":
      return { scheme: "sshkey", ...base };
  }
}

async function handleSave(uri: string): Promise<ToolResult> {
  // 1) Consent — save is the ACQUIRE path (prompts the enable dialog if needed).
  let consented: boolean;
  try {
    consented = await manager().ensureConsent();
  } catch (err) {
    return keyLockerFailure(err); // kill-switched (KeyLockerDisabled)
  }
  if (!consented) {
    return fail("KeyLockerConsentRequired", "KeyLockerConsentRequired: enabling the key locker was declined");
  }

  // 2) Parse the URI (typed BindingParseError on malformed input).
  let parsed: BindingUri;
  try {
    parsed = parseBindingUri(uri);
  } catch (err) {
    return keyLockerFailure(err);
  }

  // 3) Derive the canonical store key + meta. ssh needs its known_hosts fingerprint set resolved at
  //    save time (via the SAME resolver L1 uses at derive time, so the keys match), failing closed if
  //    the host isn't yet trusted (SP-L4-OQ-1). Non-ssh schemes derive directly.
  let canonical: string;
  let meta: BindingMeta;
  if (parsed.scheme === "ssh") {
    const dest = `${parsed.user}@${parsed.host}`;
    const sshArgs = parsed.port === 22 ? [dest] : ["-p", String(parsed.port), dest];
    const res = await resolveCanonicalForSshCommand(sshArgs, sshExecForTest);
    if (res.kind === "host-not-known") {
      return fail(
        "KeyLockerSshUnresolved",
        `KeyLockerSshUnresolved: ${parsed.host} is not in known_hosts yet. Connect to it once ` +
          `(ssh ${dest}) so its host key is recorded, then save.`,
      );
    }
    if (res.kind !== "ok") {
      return fail("KeyLockerSshUnresolved", `KeyLockerSshUnresolved: could not resolve ssh binding target — ${res.reason}`);
    }
    canonical = res.canonical;
    meta = {
      scheme: "ssh",
      displayUri: formatBindingUri(parsed),
      host: res.uri.host,
      user: res.uri.user,
      port: res.uri.port,
      fpSet: res.uri.fpSet,
      createdAt: new Date().toISOString(),
    };
  } else {
    canonical = canonicalKey(parsed);
    meta = metaForNonSsh(parsed);
  }

  // 4) Capture the secret into the locker (secure dialog → DPAPI), then bind on success. A cancelled
  //    dialog reports {captured:false} and writes no binding.
  const opaqueId = randomBytes(16).toString("hex");
  let captured: boolean;
  try {
    const r = await manager().withHost((h) => h.capture(opaqueId));
    captured = r.captured;
  } catch (err) {
    return keyLockerFailure(err);
  }
  if (!captured) return ok({ captured: false });

  store().bind(canonical, opaqueId, meta);
  return ok({ captured: true });
}

/** Find a saved binding by its display URI (normalised through the parser so input spelling matches). */
function findByDisplayUri(uri: string): { canonicalKey: string; opaqueId: string } | { error: ToolResult } {
  let normalized: string;
  try {
    normalized = formatBindingUri(parseBindingUri(uri));
  } catch (err) {
    return { error: keyLockerFailure(err) };
  }
  const row = store().list().find((r) => r.displayUri === normalized);
  if (row === undefined) return { error: fail("KeyLockerNoSuchBinding", `KeyLockerNoSuchBinding: no saved binding matches ${normalized}`) };
  return { canonicalKey: row.canonicalKey, opaqueId: row.opaqueId };
}

async function handleForget(uri: string): Promise<ToolResult> {
  if (!manager().isConsentAccepted()) {
    return fail("KeyLockerConsentRequired", "KeyLockerConsentRequired: enable the key locker before managing bindings");
  }
  const found = findByDisplayUri(uri);
  if ("error" in found) return found.error;
  // Delete both the locker secret and the map row. host.delete needs the locker (consent already checked).
  try {
    await manager().withHost((h) => h.delete(found.opaqueId));
  } catch (err) {
    return keyLockerFailure(err);
  }
  const removed = store().unbind(found.canonicalKey);
  return ok({ removed });
}

function handleSetPolicy(uri: string, confirmEveryInjection: boolean): ToolResult {
  if (!manager().isConsentAccepted()) {
    return fail("KeyLockerConsentRequired", "KeyLockerConsentRequired: enable the key locker before managing bindings");
  }
  const found = findByDisplayUri(uri);
  if ("error" in found) return found.error;
  const updated = store().setPolicy(found.canonicalKey, confirmEveryInjection);
  return ok({ updated });
}

/**
 * ADR-014 R3 OQ-W-16-bis: launch (or reuse) an autofill-capable anchored console for the assistant to drive
 * credential commands into. Consent is an ACQUIRE path here (like `save`) — launching spawns a locker-owned
 * console, so the one-time enable dialog is the natural moment to ask. Routes through the live WIRING (which
 * anchors the pane via `onLocalPaneLaunched`); a direct manager spawn would NOT anchor it and the loop would
 * never arm for that pane.
 */
async function handleLaunchConsole(
  fresh: boolean | undefined,
  host: "windows-terminal" | "classic" | undefined,
): Promise<ToolResult> {
  let consented: boolean;
  try {
    consented = await manager().ensureConsent();
  } catch (err) {
    return keyLockerFailure(err); // kill-switched (KeyLockerDisabled)
  }
  if (!consented) {
    return fail("KeyLockerConsentRequired", "KeyLockerConsentRequired: enabling the key locker was declined");
  }
  const wiring = keyLockerWiring();
  if (wiring === null) {
    return fail("KeyLockerDisabled", "KeyLockerDisabled: the key locker live wiring is not active");
  }
  try {
    // S-pid E7 (OQ-R3x-2): the DEFAULT host is 'windows-terminal' — a bare launch_console opens a new
    // tab in the user's CURRENT WT window (that IS the feature; classic is the explicit escape hatch a
    // user can pin, NOT the default). Applied here, not as a zod .default() (the registration layer
    // strips defaults — the TOOL_REGISTRY include-strip discipline).
    const { paneId, windowTitle } = await wiring.ensureAnchoredConsole({
      fresh: fresh ?? false,
      host: host ?? "windows-terminal",
    });
    // Additive guidance field: the #1 dogfood mistake was passing `windowTitle` into terminal's `paneId`
    // slot. LLMs follow instructions in the most-recent tool result closely, so name the right field here.
    return ok({
      paneId,
      windowTitle,
      hint:
        "Drive commands with terminal({action:'run'|'send', paneId:'" + paneId + "'}). Pass this paneId " +
        "(NOT windowTitle) so input keeps targeting this pane even after its title changes (e.g. after ssh login).",
    });
  } catch (err) {
    return keyLockerFailure(err); // KeyLockerWtUnavailable / KeyLockerSpawnFailed / KeyLockerConsoleLimit
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler + registration
// ─────────────────────────────────────────────────────────────────────────────

const keyLockerUnionWithInclude = withEnvelopeIncludeForUnion(keyLockerSchema);
export const keyLockerRegistrationSchema = flattenUnionToObjectSchema(keyLockerUnionWithInclude);

export const keyLockerHandler = async (args: KeyLockerArgs): Promise<ToolResult> => {
  const parsed = parseActionArgsOrFail<KeyLockerArgs>(keyLockerUnionWithInclude, args, "key_locker");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  switch (a.action) {
    case "list":
      return handleList();
    case "status":
      return handleStatus();
    case "save":
      return handleSave(a.uri);
    case "forget":
      return handleForget(a.uri);
    case "set_policy":
      return handleSetPolicy(a.uri, a.confirmEveryInjection);
    case "launch_console":
      return handleLaunchConsole(a.fresh, a.host);
  }
};

// A management/diagnostic surface (no L1 perception events, no lease) — wrapped like server_status /
// screenshot_query via `makeQueryWrapper` (no S5 opts → the bare envelope-aware wrapper).
export const keyLockerRegistrationHandler = makeQueryWrapper(
  keyLockerHandler as unknown as (args: Record<string, unknown>) => Promise<ToolResult>,
  "key_locker",
);

export function registerKeyLockerTools(server: McpServer): void {
  if (keyLockerDisabled()) return; // kill switch: a disabled locker is not offered at all
  server.registerTool(
    "key_locker",
    {
      description: buildDesc({
        purpose:
          "Manage credentials the terminal autofills for you (SSH key passphrases, sudo / login " +
          "passwords). Secrets are entered once into the locker's own secure dialog and stored encrypted " +
          "on this machine (Windows DPAPI, current user); they are NEVER shown to the assistant or sent " +
          "to this tool.",
        details:
          "action='save' pre-seeds a credential for a binding URI (ssh://user@host:22, sudo://host/root, " +
          "https-cred://host:443, sshkey:SHA256:…): it opens the locker's secure entry dialog and " +
          "stores the secret; the first save also shows a one-time enable confirmation. action='list' " +
          "shows saved bindings (metadata only, never secrets). action='forget' deletes a binding and its " +
          "secret. action='set_policy' toggles per-binding autofill confirmation. action='status' reports " +
          "whether the locker is enabled (consent) and how many bindings exist. action='launch_console' opens " +
          "(or reuses) an autofill-capable anchored pane and returns {paneId, windowTitle} — by default a new " +
          "tab in the user's current Windows Terminal window (host:'classic' opens a dedicated classic console " +
          "window instead).",
        prefer:
          "Autofill is AUTOMATIC when a bound command triggers a credential prompt in the terminal — there " +
          "is no manual fill action. But autofill ONLY fires in a pane opened by launch_console (a " +
          "pre-existing terminal is never autofilled): to autofill, first launch_console, then run the ssh / " +
          "sudo command with terminal({action:'run'|'send', paneId}) — pass the `paneId` field, not the " +
          "`windowTitle`. Keep the returned paneId; there is no pane-listing action, but launch_console " +
          "with fresh:false reuses the most-recent pane and returns its paneId again. Use save to enroll, " +
          "list/status to inspect.",
        caveats:
          "Windows-only. The anchored pane defaults to a Windows Terminal tab (autofill and terminal reads " +
          "operate while that tab is the ACTIVE tab — switching away pauses them safely); host:'classic' " +
          "opens a dedicated classic console window instead, and is the retry when Windows Terminal is not " +
          "installed (KeyLockerWtUnavailable). The human can also see and type into the pane. Enabling the " +
          "locker (first save or launch_console) grants BOTH credential autofill AND the ability for the " +
          "assistant to launch a locker-owned pane. Disable the whole feature with " +
          "DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1. An ssh save needs the host key already in known_hosts " +
          "(connect once first). API-token / env-var credentials are not supported yet.",
        examples: [
          "key_locker({action:'status'}) → {consentAccepted:false, disabled:false, bindingCount:0}",
          "key_locker({action:'save', uri:'sudo://buildbox/root'}) → opens the secure dialog → {captured:true}",
          "key_locker({action:'list'}) → {bindings:[{displayUri:'sudo://buildbox/root', scheme:'sudo', …}]}",
          "key_locker({action:'launch_console'}) → {paneId:'wt:31264:13322426700123', windowTitle:'dtm-locker-console-…'} → then terminal({action:'send', paneId:'wt:31264:13322426700123', input:'ssh user@host'})",
          "key_locker({action:'launch_console', host:'classic'}) → {paneId:'12345678', windowTitle:'dtm-locker-console-…'} (dedicated classic console window)",
        ],
      }),
      inputSchema: keyLockerRegistrationSchema,
    },
    keyLockerRegistrationHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  );
}
