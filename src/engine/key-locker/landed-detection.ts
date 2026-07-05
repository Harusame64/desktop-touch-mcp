// ADR-014 v2 R3 Key Locker — L3 §2: landed-detection (the TWO-MODE save-gate).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-capture-plan.md (§2)
//
// After L3 injects a just-captured secret, it must decide whether the credential was ACCEPTED before it
// persists the binding (Chrome-model save-gate). A credential command lands in one of two shapes and
// both must be handled (Opus L3-R1 P1-1 — exit-0 alone breaks the interactive-login North-Star case):
//
//   * Mode A — ONE-SHOT (`git push`, `sudo -v`, `ssh host cmd`, `ssh-keygen -y`): runs under
//     `terminal until:{mode:'exit'}`. accepted iff it EXITED with code 0. Any other completion
//     (timeout / quiet / pattern / a non-exit-able command) ⇒ NOT accepted ⇒ discard (fail safe).
//   * Mode B — INTERACTIVE LOGIN (`ssh user@host`, `sudo -i`, `sudo su`, `su -`): opens a shell and
//     stays alive, so exit mode never returns 0 — waiting for exit would time out and discard a CORRECT
//     secret. The landed signal is instead auth-accepted vs auth-rejected read from the pane: the
//     hidden-input prompt CLEARED and no denial line appeared (accepted), vs a re-prompt / a denial line
//     (rejected). It reads prompt/denial TEXT, never the secret.
//
// Mode B is a SAVE-GATE signal, NOT a wrong-target defense (that stays L1 fingerprint + L2 re-verify):
// a false-accept saves a secret that simply fails next use (→ re-prompt → re-capture); a false-reject
// discards a good secret (re-captured next time). Neither mis-fills — so the heuristic is bounded-safe.
//
// This module is PURE decision logic + async orchestration over INJECTED seams (the terminal exit-mode
// run and the pane read) — no Win32, no direct terminal-tool import — so the capture-loop wires the live
// primitives and tests drive fakes.

import { tokenizeCommandSegments } from "./command-derivation.js";
import { ENV_ASSIGN_RE, interactiveSshTarget, programOf } from "./session-tracker.js";

/** Which landed-detection mode a dispatched credential command uses. */
export type LandedMode = "one-shot" | "interactive";

/** The exit-mode completion the capture-loop hands in (a subset of the terminal tool's `completion`). */
export interface ExitCompletion {
  /** `"exited"` only when `until:{mode:'exit'}` observed the process finish; else timeout/quiet/… */
  reason: string;
  /** Populated ONLY on `reason:"exited"`. */
  exitCode?: number;
}

/** The landed verdict. `accepted` gates the SAVE; `reason` is for logging / the offer context. */
export interface LandedResult {
  accepted: boolean;
  mode: LandedMode;
  reason: string;
}

/**
 * A denial / re-prompt line an interactive login prints on a REJECTED auth. Case-insensitive, matched
 * against the non-secret pane tail read AFTER injection. Kept conservative — a false "no denial" only
 * costs a re-capture next time (SP-L3-OQ-5). Covers ssh, sudo, su, and generic PAM wording.
 */
const AUTH_DENIAL_RE =
  /permission denied|authentication failed(?:ure)?|auth(?:entication)? failure|sorry,? try again|access denied|incorrect password|login incorrect|too many authentication failures/i;

/**
 * Classify which landed-mode a dispatched credential command uses. Interactive = an ssh INTERACTIVE
 * login (reuses the SAME `interactiveSshTarget` that pushes a session frame, so classification and
 * frame-push agree), a `sudo -i`/`-s`/`--login`/`--shell` (starts a shell), or any `su` form (`su`,
 * `su -`, `su user` all open an interactive shell). Everything else — a one-shot `ssh host cmd`, a
 * plain `sudo <cmd>`, `git push`, `ssh-keygen` — is one-shot (Mode A, exit-gated).
 *
 * The redirect-before-program edge (`>log ssh host`) is intentionally NOT handled here: a mis-classified
 * mode is bounded-safe (a good secret is discarded and re-captured, never mis-filled), so a simple
 * env-assign skip + first-program check suffices.
 */
export function classifyLandedMode(command: string): LandedMode {
  for (const segment of tokenizeCommandSegments(command)) {
    let start = 0;
    while (start < segment.length && ENV_ASSIGN_RE.test(segment[start])) start++;
    const program = programOf(segment[start]);
    const rest = segment.slice(start + 1);
    if (program === "ssh" && interactiveSshTarget(rest) !== null) return "interactive";
    if (program === "sudo" && rest.some((a) => a === "-i" || a === "-s" || a === "--login" || a === "--shell")) return "interactive";
    if (program === "su") return "interactive";
  }
  return "one-shot";
}

/** Mode A accept: the one-shot command EXITED with code 0. Anything else is not-accepted (fail safe). */
export function isExitAccepted(completion: ExitCompletion): boolean {
  return completion.reason === "exited" && completion.exitCode === 0;
}

/**
 * Mode B accept: the auth prompt CLEARED and no denial line appeared. `paneTailAfterInject` is the
 * non-secret pane read after injecting; `stillHiddenPrompt` is whether a hidden-input prompt is STILL on
 * the cursor row (a re-prompt = rejected). A denial line always rejects, even if the prompt cleared.
 */
export function isAuthAccepted(paneTailAfterInject: string, stillHiddenPrompt: boolean): boolean {
  if (AUTH_DENIAL_RE.test(paneTailAfterInject)) return false; // explicit denial → rejected
  if (stillHiddenPrompt) return false; // re-prompt (prompt did not clear) → rejected
  return true; // prompt cleared, no denial → accepted
}

/** Seams the capture-loop wires to the live terminal / pane primitives. */
export interface LandedDeps {
  /** Mode A: run the dispatched command under `terminal until:{mode:'exit'}` and return its completion. */
  runToExit: () => Promise<ExitCompletion>;
  /**
   * Mode B: after injection, read the pane's non-secret tail and report whether a hidden-input prompt is
   * STILL present. Returns `{ tail, stillHiddenPrompt }` observed within the bounded auth window.
   */
  readPaneAfterAuth: () => Promise<{ tail: string; stillHiddenPrompt: boolean }>;
}

/**
 * The two-mode landed gate. Classifies the command, then applies the matching accept rule over the
 * injected seam. Never throws for a "not landed" — it returns `accepted:false` so the capture-loop
 * discards (fail safe).
 */
export async function awaitLanded(deps: LandedDeps, command: string): Promise<LandedResult> {
  const mode = classifyLandedMode(command);
  if (mode === "one-shot") {
    const completion = await deps.runToExit();
    const accepted = isExitAccepted(completion);
    return { accepted, mode, reason: accepted ? "exit_0" : `not_exit_0:${completion.reason}` };
  }
  const { tail, stillHiddenPrompt } = await deps.readPaneAfterAuth();
  const accepted = isAuthAccepted(tail, stillHiddenPrompt);
  return { accepted, mode, reason: accepted ? "auth_accepted" : "auth_rejected" };
}
