// ADR-014 v2 R3 Key Locker — `fill_once`: an assistant-requested, one-shot, never-saved fill.
//
// Plan: desktop-touch-mcp-internal#277 (spec comment, user-approved 2026-10-12).
//
// Why it exists. The capture-on-use loop derives a binding from the DISPATCHED command and the pane's
// tracked session. A nested hop (`ssh jump` → `ssh user@IP` inside it) is unobservable from this machine,
// so the watch sinks the pane to UNKNOWN at depth ≥ 2 (`ssh-session-watch.ts`) and the loop declines — by
// design, since a derived binding there could not be verified. The user also asked that the assistant be
// able to ask for a key at any moment. `fill_once` serves both WITHOUT deriving or storing anything: the
// user types the secret into the locker's own dialog, it is written into ONE pane once, and it is deleted.
//
// Invariants (nothing here weakens the loop's):
//   * the secret never reaches the assistant — the dialog is the locker's, the pipe carries only booleans;
//   * injection only into a pane the locker LAUNCHED (the driver's spawn-captured anchor), re-verified by
//     the locker at the injection instant (shell pid + creation time);
//   * only while a CREDENTIAL PROGRAM (ssh / sudo / su / doas) is running under that pane's shell. The prompt
//     TEXT alone is not enough: the assistant itself can print `Password:` (a comment, `Read-Host`) into its
//     own pane, and a secret typed into an ECHOING line is readable back with `terminal read` (PR #806 Opus
//     P1). A real local program asking is what makes the prompt echo-off. Past the first hop the remote side
//     can still fake a prompt — that is inherent, and the dialog is where the user judges it;
//   * the pane must look the SAME after the dialog as before it — the same prompt text and the same
//     credential processes (pid + creation time). Anything else (Ctrl+C and a new `ssh other-host`, a
//     timed-out prompt, output) declines: the user typed this secret for what they saw (PR #806 Opus P2);
//   * the emergency stop is probed before the dialog opens and again as the last await before the write;
//   * nothing persists — no binding, no [Never] tombstone, no consent change. The helper keeps a fill_once
//     secret in its own memory only (never store.json), so a server that dies mid-dialog (the emergency
//     stop exits it) leaves nothing behind; and the secret is still deleted on EVERY exit here, with a
//     failed erase reported as `cleanupFailed`.
// The session being UNKNOWN or nested is deliberately NOT a gate: nothing is derived from it or bound to it.

import type { PaneAnchor } from "./inject-target.js";
import type { PromptVerdict } from "./key-locker-capture-driver.js";

/** What the locker's dialog shows. `label` is LOCKER-derived (which pane — never the pane's live title or
 *  prompt text, both of which a remote host can write); `note` is the assistant's stated reason, which the
 *  dialog marks as the assistant's words. */
export interface FillOnceDialog {
  label: string;
  note: string;
}

/** The result of taking a pane for a one-shot fill (the driver serializes it against its own poll/loop).
 *  `token` identifies THIS claim, so its release can never reset a different claim or record. */
export type FillOnceClaim =
  | { ok: true; anchor: PaneAnchor; token: object }
  | { ok: false; reason: "not_anchored" | "busy" };

export type FillOnceInjectResult = { ok: true; verified: boolean } | { ok: false; code: string };

export interface FillOnceDeps {
  /** Take the pane exclusively (no concurrent poll / capture loop / second fill_once). */
  claim(paneId: string): FillOnceClaim;
  /** Give the claim back. Called exactly once for every successful claim, with its token. */
  release(paneId: string, token: object): void;
  /** The credential programs (ssh / sudo / su / doas) running under the anchored shell, as pid → creation
   *  time; null when the pane is no longer anchored. */
  credentialProcesses(paneId: string): Map<number, number> | null;
  /** Resolves while the emergency stop is NOT armed; throws (`err.name === "FailsafeError"`) while it is. */
  checkFailsafe(): Promise<void>;
  /** The credential-prompt verdict for the pane, or null when the pane cannot be read unambiguously. */
  readPromptTail(paneId: string): Promise<PromptVerdict | null>;
  mintOpaqueId(): string;
  /** The locker's secure dialog: the user types (or cancels); the secret is stored under `opaqueId`. */
  capture(opaqueId: string, dialog: FillOnceDialog): Promise<{ captured: boolean }>;
  /** Is the pane still anchored (its record not torn down by a close while the dialog was open)? */
  stillAnchored(paneId: string): boolean;
  /** Write the secret under `opaqueId` into the anchored pane (the locker re-verifies the anchor). */
  injectAt(anchor: PaneAnchor, opaqueId: string, submit: boolean): Promise<FillOnceInjectResult>;
  deleteSecret(opaqueId: string): Promise<void>;
  /** Wait before re-trying a `busy` claim (the driver's poll holds the pane for a moment every tick). */
  sleep?(ms: number): Promise<void>;
}

export type FillOnceDeclineReason =
  | "not_anchored"           // not a pane launched by key_locker launch_console (or it was closed)
  | "busy"                   // the pane's own autofill loop or another fill_once is running
  | "failsafe_engaged"       // the emergency stop is armed
  | "failsafe_unknown"       // the emergency-stop probe failed — decline rather than guess
  | "prompt_unreadable"      // the pane could not be read unambiguously
  | "not_at_prompt"          // the pane is not showing a credential prompt
  | "no_credential_program"  // no ssh / sudo / su / doas runs under the pane's shell (a printed prompt)
  | "prompt_changed"         // the pane changed while the dialog was open (or its prompt went away)
  | "target_gone";           // the pane closed while the dialog was open

export type FillOnceOutcome = (
  | { kind: "filled"; verified: boolean }
  | { kind: "cancelled" }
  | { kind: "declined"; reason: FillOnceDeclineReason }
  | { kind: "fill_aborted"; code: string }
) & {
  /** Set when the one-time secret could NOT be erased afterwards (two attempts failed): it stays encrypted
   *  in the locker store under an id nothing points to. Reported, never swallowed (PR #806 codex P2). */
  cleanupFailed?: true;
};

/** A `busy` claim is retried this many times, this far apart (the poll's hold is one prompt read). */
const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 200;

/** Probe the stop: null = clear to proceed, else the decline reason (fail-CLOSED on a probe error — this is
 *  an explicit request, so declining costs one retry, never a wrong write). */
async function failsafeBlocks(deps: FillOnceDeps): Promise<FillOnceDeclineReason | null> {
  try {
    await deps.checkFailsafe();
    return null;
  } catch (err) {
    return err instanceof Error && err.name === "FailsafeError" ? "failsafe_engaged" : "failsafe_unknown";
  }
}

function sameProcesses(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [pid, start] of a) if (b.get(pid) !== start) return false;
  return true;
}

async function claimWithRetry(deps: FillOnceDeps, paneId: string): Promise<FillOnceClaim> {
  let claim = deps.claim(paneId);
  for (let i = 0; i < BUSY_RETRIES && !claim.ok && claim.reason === "busy" && deps.sleep !== undefined; i++) {
    await deps.sleep(BUSY_RETRY_MS);
    claim = deps.claim(paneId);
  }
  return claim;
}

export async function runFillOnce(
  deps: FillOnceDeps,
  req: { paneId: string; dialog: FillOnceDialog; submit: boolean },
): Promise<FillOnceOutcome> {
  const { paneId, dialog, submit } = req;
  const claim = await claimWithRetry(deps, paneId);
  if (!claim.ok) return { kind: "declined", reason: claim.reason };
  try {
    // Before the dialog: the stop, the prompt, and a real program asking. Never open a credential dialog
    // for a pane that is not asking for one, or while the user is holding the emergency stop.
    const stopped = await failsafeBlocks(deps);
    if (stopped !== null) return { kind: "declined", reason: stopped };
    const before = await deps.readPromptTail(paneId);
    if (before === null) return { kind: "declined", reason: "prompt_unreadable" };
    if (!before.isCredentialPrompt) return { kind: "declined", reason: "not_at_prompt" };
    const procsBefore = deps.credentialProcesses(paneId);
    if (procsBefore === null) return { kind: "declined", reason: "not_anchored" };
    if (procsBefore.size === 0) return { kind: "declined", reason: "no_credential_program" };

    // From here on a secret may exist under `opaqueId` (a capture that threw may or may not have stored it),
    // so every exit erases it — the filled one included.
    const opaqueId = deps.mintOpaqueId();
    let outcome: FillOnceOutcome;
    try {
      outcome = await captureAndFill(deps, { paneId, dialog, submit, opaqueId, anchor: claim.anchor, before, procsBefore });
    } catch (err) {
      outcome = { kind: "fill_aborted", code: `fill_once_error:${err instanceof Error ? err.message : String(err)}` };
    }
    return (await erased(deps, opaqueId)) ? outcome : { ...outcome, cleanupFailed: true };
  } finally {
    deps.release(paneId, claim.token);
  }
}

/** Erase the one-time secret: two attempts (a pipe hiccup is the usual cause); false if both failed. */
async function erased(deps: FillOnceDeps, opaqueId: string): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try { await deps.deleteSecret(opaqueId); return true; } catch { /* retry once */ }
  }
  return false;
}

async function captureAndFill(
  deps: FillOnceDeps,
  r: {
    paneId: string; dialog: FillOnceDialog; submit: boolean; opaqueId: string; anchor: PaneAnchor;
    before: PromptVerdict; procsBefore: Map<number, number>;
  },
): Promise<FillOnceOutcome> {
  const { paneId, dialog, submit, opaqueId, anchor, before, procsBefore } = r;
  const cap = await deps.capture(opaqueId, dialog);
  if (!cap.captured) return { kind: "cancelled" };

  // After the dialog (arbitrary user time): the pane must be the SAME — the same prompt text and the
  // same credential processes — then the stop and the anchor, kept adjacent to the write (the stop
  // probe is the last await before `injectAt`, the same ordering as the loop's backstop).
  const after = await deps.readPromptTail(paneId);
  if (after === null) return { kind: "declined", reason: "prompt_unreadable" };
  if (!after.isCredentialPrompt || after.tail !== before.tail) return { kind: "declined", reason: "prompt_changed" };
  const procsAfter = deps.credentialProcesses(paneId);
  if (procsAfter === null) return { kind: "declined", reason: "target_gone" };
  if (!sameProcesses(procsBefore, procsAfter)) return { kind: "declined", reason: "prompt_changed" };
  const stoppedNow = await failsafeBlocks(deps);
  if (stoppedNow !== null) return { kind: "declined", reason: stoppedNow };
  if (!deps.stillAnchored(paneId)) return { kind: "declined", reason: "target_gone" };

  const w = await deps.injectAt(anchor, opaqueId, submit);
  return w.ok ? { kind: "filled", verified: w.verified } : { kind: "fill_aborted", code: w.code };
}
