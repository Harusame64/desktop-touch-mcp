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
// Invariants (the same ones the loop keeps; nothing here weakens them):
//   * the secret never reaches the assistant — the dialog is the locker's, the pipe carries only booleans;
//   * injection only into a pane the locker LAUNCHED (the driver's spawn-captured anchor), re-verified by
//     the locker at the injection instant (shell pid + creation time);
//   * only into a prompt that reads as a credential prompt BOTH when the call is made AND again after the
//     dialog, immediately before the write (the user may take minutes; the prompt may have gone);
//   * the emergency stop is probed before the dialog opens and again at the injection instant;
//   * nothing persists — no binding, no [Never] tombstone, no consent change; the captured secret is
//     deleted on EVERY exit (the loop's reverse-orphan rule).
// The session being UNKNOWN or nested is deliberately NOT a gate: nothing is derived from it or bound to it,
// and the user decides, looking at the dialog, whether this pane should get this secret.

import type { PaneAnchor } from "./inject-target.js";
import type { PromptVerdict } from "./key-locker-capture-driver.js";

/** What the locker's dialog shows. `label` is LOCKER-derived (which pane — never the pane's live title or
 *  prompt text, both of which a remote host can write); `note` is the assistant's stated reason, which the
 *  dialog marks as the assistant's words. */
export interface FillOnceDialog {
  label: string;
  note: string;
}

/** The result of taking a pane for a one-shot fill (the driver serializes it against its own poll/loop). */
export type FillOnceClaim =
  | { ok: true; anchor: PaneAnchor }
  | { ok: false; reason: "not_anchored" | "busy" };

export type FillOnceInjectResult = { ok: true; verified: boolean } | { ok: false; code: string };

export interface FillOnceDeps {
  /** Take the pane exclusively (no concurrent poll / capture loop / second fill_once). */
  claim(paneId: string): FillOnceClaim;
  /** Give the pane back. Called exactly once for every successful claim. */
  release(paneId: string): void;
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
}

export type FillOnceDeclineReason =
  | "not_anchored"        // not a pane launched by key_locker launch_console (or it was closed)
  | "busy"                // the pane's own autofill loop or another fill_once is running
  | "failsafe_engaged"    // the emergency stop is armed
  | "failsafe_unknown"    // the emergency-stop probe failed — decline rather than guess
  | "prompt_unreadable"   // the pane could not be read unambiguously
  | "not_at_prompt"       // the pane is not showing a credential prompt
  | "prompt_gone"         // the prompt was gone by the time the user finished the dialog
  | "target_gone";        // the pane closed while the dialog was open

export type FillOnceOutcome =
  | { kind: "filled"; verified: boolean }
  | { kind: "cancelled" }
  | { kind: "declined"; reason: FillOnceDeclineReason }
  | { kind: "fill_aborted"; code: string };

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

/** Is the pane at a credential prompt right now? null = yes, else the decline reason to use. */
async function promptBlocks(
  deps: FillOnceDeps,
  paneId: string,
  whenNot: "not_at_prompt" | "prompt_gone",
): Promise<FillOnceDeclineReason | null> {
  const verdict = await deps.readPromptTail(paneId);
  if (verdict === null) return "prompt_unreadable";
  return verdict.isCredentialPrompt ? null : whenNot;
}

export async function runFillOnce(
  deps: FillOnceDeps,
  req: { paneId: string; dialog: FillOnceDialog; submit: boolean },
): Promise<FillOnceOutcome> {
  const { paneId, dialog, submit } = req;
  const claim = deps.claim(paneId);
  if (!claim.ok) return { kind: "declined", reason: claim.reason };
  try {
    // Before the dialog: the stop, then the prompt. Never open a credential dialog for a pane that is not
    // asking for one, or while the user is holding the emergency stop.
    const stopped = await failsafeBlocks(deps);
    if (stopped !== null) return { kind: "declined", reason: stopped };
    const notPrompt = await promptBlocks(deps, paneId, "not_at_prompt");
    if (notPrompt !== null) return { kind: "declined", reason: notPrompt };

    const opaqueId = deps.mintOpaqueId();
    let attempted = false; // a capture that threw may or may not have stored — delete in that case too
    try {
      attempted = true;
      const cap = await deps.capture(opaqueId, dialog);
      if (!cap.captured) return { kind: "cancelled" };

      // After the dialog (arbitrary user time): the prompt must STILL be there, then the stop and the
      // anchor, kept adjacent to the write (no await between the last checks and `injectAt` except the
      // stop probe itself, which must be the last await — the same ordering as the loop's backstop).
      const gone = await promptBlocks(deps, paneId, "prompt_gone");
      if (gone !== null) return { kind: "declined", reason: gone };
      const stoppedNow = await failsafeBlocks(deps);
      if (stoppedNow !== null) return { kind: "declined", reason: stoppedNow };
      if (!deps.stillAnchored(paneId)) return { kind: "declined", reason: "target_gone" };

      const r = await deps.injectAt(claim.anchor, opaqueId, submit);
      return r.ok ? { kind: "filled", verified: r.verified } : { kind: "fill_aborted", code: r.code };
    } catch (err) {
      return { kind: "fill_aborted", code: `fill_once_error:${err instanceof Error ? err.message : String(err)}` };
    } finally {
      // Never saved: delete on EVERY exit, the filled one included. Best-effort (a failed delete leaves dead
      // encrypted storage, not a leak).
      if (attempted) {
        try { await deps.deleteSecret(opaqueId); } catch { /* best-effort */ }
      }
    }
  } finally {
    deps.release(paneId);
  }
}
