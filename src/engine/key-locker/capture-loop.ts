// ADR-014 v2 R3 Key Locker — L3 §1: the capture-on-use state machine (THE LOCKED CONTRACT #1).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-capture-plan.md (§1)
//
// This is the Chrome-model loop that turns L1's binding + L2's injectors into "the locker learns and
// fills credentials". A credential prompt L3 dispatched is detected → the binding is DERIVED from the
// dispatched command (L1, authoritative — never the spoofable prompt text) → then:
//
//   * MATCH  (a stored secret exists): confirm (D2 backstop, per-binding policy) → autofill. Nothing to
//     capture or save.
//   * NO MATCH: capture into the locker's secure dialog → inject the just-captured secret → LANDED-detect
//     (§2 two-mode) → OFFER to save → persist the binding->opaqueId mapping ONLY on [Save] (Chrome model,
//     Opus L3-R1 P1-2: the offer precedes the persist, so a declined save never lingers). Every non-commit
//     exit — reject / not-landed / [Not now]/[Never] / any throw — DELETES the captured secret from the
//     locker (Opus L3-R1 P2-1 reverse-orphan closure of L1 §5.3).
//
// SCOPE (L3-2): this is the PANE (SendInput) channel loop — the fully-reactive "echo-off prompt appeared,
// fill it now" flow (`sudo`/`ssh` password prompts). The `askpass` / `git-credential` channels fill via a
// helper the CONSUMER spawn consults, so their inject happens at DISPATCH time (env pre-set) and their
// landed signal spans the consumer's whole lifetime — a different control flow that does not fit the
// synchronous capture→inject→landed→offer sequence here. `selectInjector(scheme, "pane")` gates that: an
// `sshkey` / `https-cred` binding (never pane-injectable — P3-2) DECLINES this loop and is handled by the
// forward askpass/git-credential flow (SP-L3-OQ-5; not built in L3-2).
//
// PURE ORCHESTRATOR: no Win32, no host, no terminal import — every effect is an injected `CaptureLoopDeps`
// seam, so tests drive fakes and the KeyLockerManager (L3-3) wires the live primitives:
//   getSession        = SessionTracker.get(paneId)                         (§3)
//   deriveBinding     = deriveBinding(cmd, session, { exec })              (L1)
//   resolve/bind      = BindingStore.resolve / .bind (locker exists()-verified)
//   confirmPolicyFor  = the binding row's `confirmEveryInjection ?? true`  (D2, L1 §5.1 field)
//   capture/delete    = KeyLockerHost.capture / .delete                    (L0, secret stays in the locker)
//   injectPane        = assembleInjectTarget(hwnd, submit) + inject(host, …, "pane", target)  (§4 + L2)
//   awaitLanded       = awaitLanded(landedDeps(paneId, cmd), cmd)          (§2)
//   confirm / offer   = the locker's secret-free dialogs (like `-Consent`) — forward-wired in L3-3/L4
//
// The wiring — NOT this loop — records each dispatched command into the SessionTracker (the §3 derive-then-
// record ordering) and owns the confirm/offer UI mechanism. Invariant (L0/L1/L2): the secret is entered in
// the locker's secure dialog, injected by the locker, and NEVER crosses the control pipe / touches Node /
// hits the raw pane. This loop handles opaque ids + landed verdicts only.

import { canonicalKey, formatBindingUri, type BindingUri } from "./binding.js";
import type { BindingMeta } from "./binding-store.js";
import type { SessionContext } from "./command-derivation.js";
import { selectInjector, type InjectResult } from "./injector.js";
import type { LandedResult } from "./landed-detection.js";
import { isKnownSession, type PaneSession } from "./session-tracker.js";

/** The user's answer to the post-landing save offer (Chrome model). */
export type SaveChoice = "save" | "not_now" | "never";

/** The credential event that triggers the loop — a prompt L3 observed for a command it dispatched. */
export interface CredentialEvent {
  /** Stable per-pane id (hwnd string / title token) — the SessionTracker key. */
  paneId: string;
  /** The command L3 DISPATCHED that led to this prompt. The AUTHORITATIVE binding source (never the
   *  prompt text — spoofable, seed §6); only the "when to act" timing came from the prompt. */
  dispatchedCommand: string;
  /** Append Enter after a line-oriented echo-off secret (pane channel). Defaults to true. */
  submit?: boolean;
}

/**
 * The terminal state of one loop run — a discriminated union for observability + testing. It never
 * carries the secret (opaque ids + verdicts only).
 */
export type CaptureLoopOutcome =
  /** Nothing touched the locker: the pane session is UNKNOWN (§3 fail-safe), the command carries no
   *  credential L1 attributes, or the binding is not pane-injectable (askpass/git-credential forward flow). */
  | { kind: "declined"; reason: "unknown_session" | "not_a_credential" | "not_pane_channel" }
  /** MATCH path: the per-binding confirm backstop (D2) was declined — no injection. */
  | { kind: "confirm_rejected" }
  /** MATCH path: a stored secret was autofilled. `verified` = the locker's injection-instant re-verify. */
  | { kind: "filled_from_store"; verified: boolean }
  /** Inject returned a typed abort (target_mismatch / not_foreground / …). `matched` distinguishes the
   *  MATCH autofill from a NO-MATCH just-captured fill (the latter also deletes the capture). */
  | { kind: "fill_aborted"; matched: boolean; code: string }
  /** NO-MATCH path: the user cancelled the secure dialog — no secret captured, no binding. */
  | { kind: "capture_cancelled" }
  /** NO-MATCH path: captured → filled → LANDED → [Save] → the mapping was persisted, the secret retained. */
  | { kind: "saved"; verified: boolean }
  /** NO-MATCH path: captured then DISCARDED (locker entry deleted, no bind). `not_landed` = the credential
   *  did not land (exit≠0 / auth-rejected / probe error; `detail` = the landed reason); `not_now`/`never` =
   *  the user declined the save offer. */
  | { kind: "discarded"; reason: "not_landed" | "not_now" | "never"; detail?: string };

/** The injected effects the loop orchestrates (the KeyLockerManager binds these to live primitives). */
export interface CaptureLoopDeps {
  /** The pane's tracked session; UNKNOWN ⇒ decline to derive (§3, never guess localhost). */
  getSession(paneId: string): PaneSession;
  /** L1 derivation over the dispatched command in the pane's session context. null ⇒ not a credential. */
  deriveBinding(command: string, session: SessionContext): Promise<BindingUri | null>;
  /** Binding-map lookup, locker-`exists()`-verified (a stale row is pruned + reported as no binding). */
  resolveBinding(canonicalKey: string): Promise<{ opaqueId: string } | undefined>;
  /** Persist the canonical→opaqueId mapping. Called ONLY on [Save] (P1-2). */
  bindBinding(canonicalKey: string, opaqueId: string, meta: BindingMeta): void;
  /** The binding's `confirmEveryInjection` policy (default TRUE — confirm is the safe backstop, D2). */
  confirmPolicyFor(canonicalKey: string): boolean;
  /** Open the locker's secure dialog for `opaqueId`; the secret stays in the locker (`captured=false` =
   *  the user cancelled). */
  capture(opaqueId: string): Promise<{ captured: boolean }>;
  /** Delete the locker entry for `opaqueId` (the reverse-orphan closure; a no-op on an absent key). */
  deleteSecret(opaqueId: string): Promise<void>;
  /** Assemble the pane InjectTarget (§4) and SendInput the secret under `opaqueId` (L2, "pane" channel). */
  injectPane(binding: BindingUri, opaqueId: string, submit: boolean): Promise<InjectResult>;
  /** The §2 two-mode landed gate for the dispatched command (Mode A exit-0 / Mode B auth-accepted). */
  awaitLanded(command: string): Promise<LandedResult>;
  /** D2 backstop confirm before a MATCH autofill (only invoked when `confirmPolicyFor` is true). */
  confirmInjection(binding: BindingUri): Promise<boolean>;
  /** The Chrome-model save offer AFTER a landed NO-MATCH fill (P1-2 — the loop persists only on "save"). */
  offerSave(binding: BindingUri): Promise<SaveChoice>;
  /** Mint the opaqueId the loop will bind on save (`randomBytes(16).toString("hex")`; a fake in tests). */
  mintOpaqueId(): string;
  /** ISO-8601 timestamp for `meta.createdAt` (injected so tests are deterministic). */
  now(): string;
}

/**
 * Run one capture-on-use cycle for a detected credential prompt (§1). Never throws after a capture —
 * a seam failure between capture and the save decision is caught, the captured secret is deleted
 * (reverse-orphan closure), and a typed `fill_aborted` is returned. The wrong-target defense stays L1's
 * fingerprint + L2's injection-instant re-verify + the landed save-gate; the confirm dialog is a backstop.
 */
export async function runCaptureLoop(deps: CaptureLoopDeps, event: CredentialEvent): Promise<CaptureLoopOutcome> {
  const { paneId, dispatchedCommand } = event;
  const submit = event.submit ?? true;

  // §3: a pane whose session is UNKNOWN (never anchored / sunk to unknown on an unconfirmable ssh end)
  // declines to derive — never guess a localhost binding for a possibly-remote pane (the cardinal sin).
  const session = deps.getSession(paneId);
  if (!isKnownSession(session)) return { kind: "declined", reason: "unknown_session" };

  // L1: derive from the DISPATCHED command (authoritative), not the prompt text. null ⇒ not a credential
  // we manage — leave the prompt for the human to type.
  const binding = await deps.deriveBinding(dispatchedCommand, session);
  if (binding === null) return { kind: "declined", reason: "not_a_credential" };

  // PANE-CHANNEL scope: only `sudo`/`ssh` fill via the pane SendInput. An `sshkey` (always askpass — P3-2)
  // or `https-cred` (git-credential) binding is NOT pane-injectable and is handled by the forward
  // askpass/git-credential flow (SP-L3-OQ-5), so decline this loop rather than mis-route to the pane.
  if (!selectInjector(binding.scheme, "pane").ok) return { kind: "declined", reason: "not_pane_channel" };

  // The store map key. ssh requires the resolved fp-set (deriveBinding fills it); a missing set is a
  // malformed binding — fail safe to decline rather than throw out of the loop.
  let canonical: string;
  try {
    canonical = canonicalKey(binding);
  } catch {
    return { kind: "declined", reason: "not_a_credential" };
  }

  // ── MATCH: a stored secret already exists → autofill; nothing to capture or save. ──────────────────
  const hit = await deps.resolveBinding(canonical);
  if (hit !== undefined) {
    // D2 backstop (default on): confirm before filling an already-stored secret. A per-binding opt-out
    // (confirmEveryInjection=false, set via L4 management) skips it; the backstop is NOT the primary
    // wrong-target defense (that is L1 fp + L2 re-verify), so a user opt-out is bounded-safe.
    if (deps.confirmPolicyFor(canonical)) {
      if (!(await deps.confirmInjection(binding))) return { kind: "confirm_rejected" };
    }
    const r = await deps.injectPane(binding, hit.opaqueId, submit);
    return r.ok
      ? { kind: "filled_from_store", verified: injectVerified(r) }
      : { kind: "fill_aborted", matched: true, code: r.code };
  }

  // ── NO MATCH: capture → inject → landed → OFFER → persist only on [Save] (P1-2). ───────────────────
  const opaqueId = deps.mintOpaqueId(); // minted before capture; bound on save, deleted otherwise
  let captured = false;                 // did a secret actually get stored under opaqueId?
  let committed = false;                // did the user [Save] it? (retain the locker entry)
  let outcome: CaptureLoopOutcome;
  try {
    const cap = await deps.capture(opaqueId); // L0 secure dialog; the secret never leaves the locker
    captured = cap.captured;
    if (!captured) {
      outcome = { kind: "capture_cancelled" };
    } else {
      const r = await deps.injectPane(binding, opaqueId, submit); // inject the just-captured secret (L2)
      if (!r.ok) {
        outcome = { kind: "fill_aborted", matched: false, code: r.code };
      } else {
        // §2 two-mode landed gate: Mode A (one-shot, exit-0) / Mode B (interactive login, auth-accepted).
        // A wrong secret / non-land NEVER saves — it is deleted in `finally` (D5 save-gate).
        const landed = await deps.awaitLanded(dispatchedCommand);
        if (!landed.accepted) {
          outcome = { kind: "discarded", reason: "not_landed", detail: landed.reason };
        } else {
          // Chrome model (P1-2): OFFER first, persist ONLY on [Save]. A declined save never binds.
          const choice = await deps.offerSave(binding);
          if (choice === "save") {
            deps.bindBinding(canonical, opaqueId, metaFor(binding, deps.now()));
            committed = true; // retain the locker secret; skip the reverse-orphan delete below
            outcome = { kind: "saved", verified: injectVerified(r) };
          } else {
            outcome = { kind: "discarded", reason: choice }; // "not_now" | "never" → discard
          }
        }
      }
    }
  } catch (err) {
    // A seam failure between capture and the decision (pipe drop, dialog crash) — treat as a fill abort.
    // A capture that THREW may or may not have stored the secret, so force the safe delete below.
    captured = true;
    outcome = { kind: "fill_aborted", matched: false, code: `loop_error:${err instanceof Error ? err.message : String(err)}` };
  } finally {
    // Reverse-orphan closure (P2-1, L1 §5.3): delete the captured secret on EVERY non-commit exit —
    // reject / not-landed / [Not now]/[Never] / any throw. Best-effort: a delete failure leaves dead
    // encrypted storage (not a leak; §8 same-user could read the store anyway), never a wrong save.
    if (captured && !committed) {
      try { await deps.deleteSecret(opaqueId); } catch { /* best-effort; residual is dead storage */ }
    }
  }
  return outcome;
}

/** The pane channel only ever runs the `sendinput` injector; read its re-verify bit (else false). */
function injectVerified(r: InjectResult): boolean {
  return r.ok && r.injector === "sendinput" ? r.verified : false;
}

/**
 * Build the no-secret binding-store `meta` for a save (§5.1 row shape). `displayUri` is the RFC-safe
 * human form; the per-scheme fields mirror the binding so management/audit can render it without
 * re-deriving. The `sshkey` arm is unreachable in the pane loop (declined above) but kept total.
 */
function metaFor(binding: BindingUri, createdAt: string): BindingMeta {
  const base = { scheme: binding.scheme, displayUri: formatBindingUri(binding), createdAt };
  switch (binding.scheme) {
    case "ssh":
      return { ...base, host: binding.host, user: binding.user, port: binding.port, ...(binding.fpSet ? { fpSet: binding.fpSet } : {}) };
    case "sudo":
      return { ...base, host: binding.host, targetUser: binding.targetUser };
    case "https-cred":
      return { ...base, host: binding.host, port: binding.port, ...(binding.user !== undefined ? { user: binding.user } : {}) };
    case "sshkey":
      return base;
  }
}
