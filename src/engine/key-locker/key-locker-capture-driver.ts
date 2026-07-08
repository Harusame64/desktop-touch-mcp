// ADR-014 v2 R3 Key Locker — L3-4 W-2 (REDO): the capture DRIVER (the live-wiring CRUX).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-4-live-wiring-plan.md (§0-CORR, §2.2, §3)
//
// Every L3 pipeline module is merged, pure, and unit-tested in ISOLATION, but NOTHING wires them into a
// running loop. This driver is that first production owner — the orchestration that turns the terminal's
// dispatch/prompt events into "the locker learns and fills credentials", while honoring the three
// atomicity obligations the pure `ssh-session-watch.ts` header pinned as WIRING responsibilities (W1/W2/W3).
//
// ⚠ FIRE-AFTER-DELIVERY (§0-CORR — SUPERSEDES the fire-before design of PR #513): the merged W-1 (#511)
// fires the S-A dispatch hook ONLY on a CONFIRMED-successful delivery (`terminal.ts:903-913` send /
// `:2137-2145` run). So when `onDispatch(paneId, command)` fires, the command has ALREADY been delivered and
// is running, and a fast interactive-ssh child CAN ALREADY be in the process tree. Three structural
// consequences vs the old fire-before design:
//   (A) `onDispatch` is FULLY SYNCHRONOUS (OQ-W-13 fold). The old `await deriveBinding` inside the handler
//       produced the entire await-window bug class (push→register race, late correlation, stale-arm-during-
//       derive/read). With the sync fold the handler runs atomically — no interleaving — so `dispatchSeq` +
//       clear-at-start + the token gate all COLLAPSE and are DELETED. Arm on a CHEAP synchronous pre-filter
//       (`looksLikeCredential` = `programOf(first real token of any segment) ∈ {sudo,doas,ssh,su}`, a generous
//       superset) and let the poll's capture loop run the AUTHORITATIVE `deriveBinding` it already runs. A
//       generous pre-filter only OVER-polls (bounded-safe, OQ-W-3), never wrong-targets.
//   (B) The W-2b scan must EXEMPT the assistant's OWN just-dispatched ssh (§0-CORR.2): with the child already
//       visible, the reconcile's W-2b unregistered-ssh scan would classify the assistant's own `ssh host-a`
//       as a lurking USER ssh → markUnknown → the assistant's own login never arms. The driver proves the
//       exact child pid THIS dispatch spawned via a before/after `sshBaseline` delta (host-matched to the
//       dispatched host) and passes `watch.tick({ paneId, pid, startTimeMs })` to skip exactly it. A user's
//       SAME-host ssh is a DIFFERENT pid ⇒ still flags; ambiguous (>1) or unprovable (0) ⇒ NO exempt.
//   (C) The loop admits a real `onDispatch` ONLY in its POST-LANDED window (§0-CORR.3, `loopPhase`): during
//       the pre-landed window the shell is BLOCKED at the credential prompt, so a delivered command has NOT
//       run — recording it would put the tracker ahead of reality. This REPLACES the old command-match /
//       `inRunToExit` gates (both admitted the pre-auth window).
//
// It stays ENGINE-PURE over injected seams (no Win32 / host / terminal import) so the whole wrong-target
// story is unit-testable with a fake process tree; the thin IMPURE composition root (W-4,
// `key-locker-wiring.ts`) binds these seams to the real terminal hooks + Win32 and drives the timers. It
// OWNS a live `SessionTracker` + `SshSessionWatch` (constructed by the manager, W-3) — passed in so tests
// drive the REAL reconciliation against a controllable snapshot.
//
// The events it services (all per-pane, keyed by `paneId = String(hwnd)` decimal — the same key the
// terminal, inject-target, and ssh-watch all emit, so tracker keys / InjectTarget hwnd / shellPid stay
// consistent BY CONSTRUCTION):
//   * onLocalPaneLaunched — W1 anchor: a pane L3 ITSELF launched from a known-local shell is anchored
//     KNOWN-LOCAL + watched, in ONE synchronous turn. A pre-existing pane is never anchored → stays UNKNOWN
//     → every fill declines (P1-B: anchoring on "no ssh child seen" would false-anchor a plink/mosh/renamed-
//     ssh pane local and disclose a LOCAL secret to a REMOTE prompt).
//   * onDispatch — the S-A dispatch hook. Fully SYNCHRONOUS: (0) drop if pre-landed; (1) correlate stragglers
//     + compute the W-2b exempt pid via the sshBaseline delta + RECONCILE (`watch.tick(exempt)`); (2) FREEZE
//     `tracker.get(paneId)` as the pre-effect frame the capture loop derives from; (3) record the session
//     effect (derive-then-record) + register the proven ssh child; (4) arm the poller on the cheap pre-filter.
//   * poll — the prompt poller (the wiring drives it on a timer). On a credential prompt, runs
//     `runCaptureLoop` bound to the FROZEN session. Single-flight per pane (P2-E); sets `loopPhase`.
//   * onPaneClosed — W2 close atomicity: `unwatchPane` paired same-turn with `tracker.forget`.

import type { BindingMeta } from "./binding-store.js";
import type { BindingUri } from "./binding.js";
import {
  runCaptureLoop,
  type CaptureLoopDeps,
  type CaptureLoopOutcome,
  type CredentialEvent,
  type SaveChoice,
} from "./capture-loop.js";
import { tokenizeCommandSegmentsWithOps } from "./command-derivation.js";
import type { SessionContext } from "./command-derivation.js";
import { awaitLanded, type ExitCompletion } from "./landed-detection.js";
import type { InjectResult } from "./injector.js";
import {
  ENV_ASSIGN_RE,
  interactiveSshTarget,
  isKnownSession,
  programOf,
  type PaneSession,
  type SessionFrame,
  type SessionTracker,
} from "./session-tracker.js";
import { type ProcessSnapshot, type SshSessionWatch } from "./ssh-session-watch.js";

/** The prompt-read verdict the S-B seam returns (the tools-layer root runs the detection — §2.2 layer
 *  rule — so the engine driver never imports `terminal.ts`). `null` = the pane read failed this poll. */
export interface PromptVerdict {
  /** The cursor row is an echo-off credential prompt L3 should fill (`isSecretInputPrompt`). */
  isCredentialPrompt: boolean;
  /** The non-secret pane tail (Mode-B auth read reuses this shape). */
  tail: string;
  /** Whether a hidden-input prompt is STILL on the cursor row (Mode-B re-prompt = rejected). */
  stillHiddenPrompt: boolean;
}

/** The result of one `poll(paneId)` — observability for the wiring's timer + the unit tests. */
export type PollResult =
  /** The pane is not armed (no credential dispatch pending) — nothing to do. */
  | { status: "idle" }
  /** Armed, but no credential prompt has appeared yet — keep polling. */
  | { status: "polling" }
  /** A NEWER dispatch replaced the arm during the prompt read — this poll aborts, the fresh arm polls next. */
  | { status: "superseded" }
  /** The pane was SUNK to UNKNOWN (a doubt-tick — e.g. a user hand-ssh'd in) between the arm and the fill —
   *  the frozen context is stale, so the arm is voided and the prompt is left for the human (Codex P1). */
  | { status: "declined" }
  /** A poll is already in progress for this pane (serialized) — the caller should not re-drive. */
  | { status: "busy" }
  /** The poller lifetime elapsed with no prompt (a key-based ssh / cached sudo prints none) — disarmed. */
  | { status: "timed_out" }
  /** A credential prompt was found and the capture loop ran to a terminal outcome. */
  | { status: "filled"; outcome: CaptureLoopOutcome };

/**
 * The injected effects the driver orchestrates. The wiring (W-4) binds these to the real terminal hooks +
 * Win32 + locker host; tests drive fakes. Most are the merged `CaptureLoopDeps` / `LandedDeps` seams,
 * pane-parameterized where the driver must bind a specific pane's hwnd/session.
 */
export interface CaptureDriverDeps {
  /** The live per-pane session tracker (owned by the manager; the driver anchors/records/forgets it). */
  tracker: SessionTracker;
  /** The live ssh session-end watch (owned by the manager, built with the real/fake snapshot seam). */
  watch: SshSessionWatch;
  /** One live process-tree snapshot (win32 `buildProcessParentMap`+`getProcessIdentityByPid`+
   *  `getProcessCommandLineByPid` in production; a fake in tests). Used ONLY for the §0-CORR.2 sshBaseline
   *  DELTA (exempt-pid proof + straggler correlation) — the watch snapshots independently for its own `tick`. */
  snapshot(): ProcessSnapshot;

  /** L1 derivation over the dispatched command in the FROZEN session context. null ⇒ not a credential. */
  deriveBinding(command: string, session: SessionContext): Promise<BindingUri | null>;
  /** Binding-map lookup, locker-`exists()`-verified. */
  resolveBinding(canonicalKey: string): Promise<{ opaqueId: string } | undefined>;
  /** Persist the canonical→opaqueId mapping (the loop calls this ONLY on [Save]). */
  bindBinding(canonicalKey: string, opaqueId: string, meta: BindingMeta): void;
  /** The binding's `confirmEveryInjection` policy (default true — the D2 confirm backstop). */
  confirmPolicyFor(canonicalKey: string): boolean;
  /** OPTIONAL [Never] tombstone gate (NO-MATCH only) — unwired ⇒ no suppression. */
  isNever?(canonicalKey: string): boolean;
  /** OPTIONAL [Never] tombstone writer — unwired ⇒ "never" behaves like "not now". */
  onNever?(canonicalKey: string): void;
  /** Open the locker's secure dialog for `opaqueId` (secret stays in the locker). */
  capture(opaqueId: string): Promise<{ captured: boolean }>;
  /** Delete the locker entry for `opaqueId` (the reverse-orphan closure). */
  deleteSecret(opaqueId: string): Promise<void>;
  /** Assemble the pane InjectTarget for `paneId` (`assembleInjectTarget`) + console-buffer inject (`inject`, "pane"). */
  injectPane(paneId: string, binding: BindingUri, opaqueId: string, submit: boolean): Promise<InjectResult>;
  /** The D2 backstop confirm before a MATCH autofill. */
  confirmInjection(binding: BindingUri): Promise<boolean>;
  /** The Chrome-model save offer after a landed NO-MATCH fill. */
  offerSave(binding: BindingUri): Promise<SaveChoice>;
  /** Mint the opaqueId the loop binds on save. */
  mintOpaqueId(): string;
  /** ISO-8601 timestamp for `meta.createdAt`. */
  now(): string;

  /** Mode A (§2 S-C): run `command` under `terminal until:{mode:'exit'}` (shell from the frozen isRemote,
   *  OQ-W-4) and return its completion. */
  runToExit(paneId: string, command: string, isRemote: boolean): Promise<ExitCompletion>;
  /** Mode B (§2 S-B): read the pane's non-secret tail + still-hidden-prompt after an interactive login. */
  readPaneAfterAuth(paneId: string): Promise<{ tail: string; stillHiddenPrompt: boolean }>;
  /** The prompt-read seam (§1 S-B): the credential-prompt verdict for a pane, or null on a read failure. */
  readPromptTail(paneId: string): Promise<PromptVerdict | null>;

  /** Monotonic-ish ms clock for the poller lifetime (default `Date.now`; injected in tests). */
  nowMs(): number;
  /** Abandon a prompt poll after this many ms (a key-based ssh / cached sudo prints no prompt). */
  pollTimeoutMs?: number;
}

/** A credential dispatch armed for the prompt poller (the frozen frame is the W3 closure). */
interface ArmedDispatch {
  /** The dispatched command — the AUTHORITATIVE binding source (never the prompt text). */
  command: string;
  /** The reconciled PRE-effect session the capture loop derives from (never a live tracker.get). */
  frozen: SessionFrame;
  /** The POST-record session at arm time — the state the pane is EXPECTED to hold when the armed command's
   *  own prompt shows (sudo/su: === frozen, non-session-changing; an ssh login: frozen + its own push). `poll`
   *  re-checks the LIVE session against this before filling: any EXTERNAL change between arm and fill — a
   *  session-end POP, a nested push, or a doubt markUnknown — means the pane is no longer the context the
   *  command runs in, so the frozen binding must NOT be filled (Codex R2 P1 markUnknown + Opus R2 P2 async pop:
   *  both are cross-host disclosures the DISPATCH-time reconcile cannot catch, the sink/pop being AFTER the
   *  freeze). Comparing execHost + isRemote (not cwd — cwd only steers git-remote derivation, not disclosure). */
  expected: SessionFrame;
  /** `nowMs()` when armed (poller lifetime, OQ-W-2). */
  armedAtMs: number;
}

/**
 * A pending straggler ssh-child correlation (§0-CORR.2): fire-after-delivery usually makes the child
 * present AT dispatch, so this is the RARE slow-spawn path. It carries the pre-dispatch ssh-descendant
 * baseline + the dispatched host so a later `correlateAllPending` can still register EXACTLY the child THIS
 * dispatch spawned (host-matched), never a pre-existing tunnel/sibling.
 */
interface PendingSshCorrelation {
  /** The shell subtree's ssh-descendant pids BEFORE this dispatch (the delta baseline — a pre-existing
   *  tunnel is in here, so it is never mis-registered as this dispatch's login; Opus R2 Q2). */
  baseline: Set<number>;
  /** The interactive host this dispatch's ssh targets — the child to register must host-match it. */
  dHost: string;
  /** Whether the correlation has resolved (registered the child, or declined) — one-shot per dispatch. */
  registered: boolean;
}

/** Per-pane phase of the capture loop (§0-CORR.3) — gates whether `onDispatch` admits a real dispatch.
 *  `pre-landed` = the shell is BLOCKED at the credential prompt (a delivered command has NOT run) ⇒ DROP.
 *  `post-landed` = the login/sudo was accepted and the shell is back at a prompt ⇒ ADMIT. `none` = no loop. */
type LoopPhase = "none" | "pre-landed" | "post-landed";

/** Per-pane driver state (exists iff the driver ANCHORED the pane — i.e. L3 launched it). */
interface PaneRecord {
  /** The window-owning shell pid (`getWindowProcessId(hwnd)`), for the sshBaseline subtree root. */
  shellPid: number;
  /** The credential dispatch awaiting a prompt, or null. */
  armed: ArmedDispatch | null;
  /** The shell subtree's ssh-descendant pids as of the LAST reconcile (§0-CORR.2). Advanced every
   *  `onDispatch`/`tickWatch`; the delta against a fresh snapshot identifies the newly-spawned child. */
  sshBaseline: Set<number>;
  /** A pending straggler ssh-child correlation (the child was not visible at dispatch), or undefined.
   *  Resolved by `correlateAllPending` on a later tick/poll. */
  pendingSsh: PendingSshCorrelation | undefined;
  /** A `poll()` is in progress for this pane — serializes polls (a re-entrant poll returns `busy`) so a
   *  slow prompt read cannot let two polls run two capture loops for one dispatch (Codex L3-4-W2 R2 P2). */
  pollBusy: boolean;
  /** The capture-loop phase (§0-CORR.3). `onDispatch` DROPS a dispatch while `pre-landed` (shell blocked at
   *  the prompt), ADMITS on `post-landed`/`none`. This REPLACES the old `inRunToExit` flag: the Mode-A
   *  `runToExit` landed re-run fires onDispatch while still `pre-landed` (awaitLanded has not returned
   *  accepted yet) ⇒ dropped; a genuine post-auth dispatch fires after the flip to `post-landed` ⇒ admitted. */
  loopPhase: LoopPhase;
}

const SSH_PROGRAM = "ssh";
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
/** The cheap synchronous arm pre-filter set (§0-CORR.1 A) — a generous superset; the loop's own
 *  `deriveBinding` is the authoritative gate, so an over-arm just declines `not_a_credential`. */
const CREDENTIAL_PROGRAMS = new Set(["sudo", "doas", "ssh", "su"]);

/**
 * The live capture driver. Constructed once by the manager (W-3) with the shared tracker + watch + the
 * live seams; the wiring root (W-4) calls its events from the terminal hooks + a poll/tick timer.
 */
export class KeyLockerCaptureDriver {
  private readonly panes = new Map<string, PaneRecord>();
  private readonly pollTimeoutMs: number;

  constructor(private readonly deps: CaptureDriverDeps) {
    this.pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  /**
   * W1 — anchor a pane L3 ITSELF launched from a known-local shell. `beginLocalSession` (tracker known-local)
   * and `watchPane` (liveness anchor at `shellPid`) run in ONE synchronous turn (Edge 3): never a window
   * where the tracker trusts local while no watch guards a later ssh-out. Re-launching resets the pane.
   * ONLY the assistant's own launches call this — a pre-existing pane is never anchored (P1-B, §3 W1).
   */
  onLocalPaneLaunched(paneId: string, shellPid: number, cwd?: string): void {
    this.tracker.beginLocalSession(paneId, cwd);
    this.watch.watchPane(paneId, shellPid);
    this.panes.set(paneId, {
      shellPid,
      armed: null,
      sshBaseline: new Set(),
      pendingSsh: undefined,
      pollBusy: false,
      loopPhase: "none",
    });
  }

  /**
   * The S-A dispatch hook — one dispatch's session bookkeeping + poller arm, FULLY SYNCHRONOUS (§0-CORR.1).
   * No `await` anywhere: the correlate → exempt-delta → reconcile → freeze → record → register → arm sequence
   * runs atomically, so an interleaved async tick (an external ssh child exiting) cannot reorder any of it.
   *
   * DROP while `loopPhase === 'pre-landed'` (§0-CORR.3): the shell is blocked at a credential prompt, so a
   * delivered command has NOT run — recording it would put the tracker ahead of reality. This also drops the
   * Mode-A `runToExit` landed RE-RUN (which fires onDispatch mid-loop, still pre-landed — W4-O2). A genuine
   * post-auth dispatch fires after the flip to `post-landed` and is admitted.
   *
   * A pane the driver never anchored (`panes` has no record — a pre-existing user pane, P1-B) is ignored
   * here; the tracker stays UNKNOWN for it and every fill declines. (W4-O1: fire-after means the command has
   * already run and its ssh child may already exist — the exempt delta below skips the assistant's own child
   * so the W-2b scan does not mis-flag it.)
   */
  onDispatch(paneId: string, command: string): void {
    const rec = this.panes.get(paneId);
    if (rec === undefined) return;
    // (0) DROP while the shell is blocked mid-credential (§0-CORR.3). Also drops the Mode-A landed re-run.
    if (rec.loopPhase === "pre-landed") return;

    // (1a) REGISTER any pending straggler ssh child of any pane BEFORE the tick — a just-pushed-but-
    //      unregistered remote frame (`session===null && remoteDepth>0`) would otherwise trip the watch's
    //      unwatched-frame backstop → markUnknown (OQ-W-5). In fire-after the child is usually already
    //      present at its own dispatch, so this straggler path rarely has work.
    this.correlateAllPending();

    // (1b) §0-CORR.2 W-2b EXEMPT: identify the SPECIFIC ssh child THIS dispatch spawned via a before/after
    //      delta against the pane's maintained ssh-descendant baseline, and exempt ONLY that pid so the
    //      reconcile's W-2b scan does not mis-flag the assistant's OWN login as a lurking user ssh. A user's
    //      SAME-host ssh is a DIFFERENT pid ⇒ still flags; 0 or >1 new host-matching children ⇒ NO exempt.
    const dHost = dispatchedInteractiveSshHost(command);
    const curSsh = sshDescendants(this.deps.snapshot(), rec.shellPid);
    const preBaseline = rec.sshBaseline;
    const newHostMatch =
      dHost === null
        ? []
        : [...curSsh].filter(([pid, info]) => !preBaseline.has(pid) && info.host === dHost).map(([pid]) => pid);
    const exemptPid = newHostMatch.length === 1 ? newHostMatch[0] : null;

    // (1c) RECONCILE this pane to a correct-or-UNKNOWN steady state (P1-A: pop a dead ssh so a post-exit
    //      command doesn't freeze a stale remote; W-2b: markUnknown a user-typed in-bound ssh) — SKIPPING the
    //      one proven exempt child. Synchronous, one Toolhelp snapshot inside `tick`.
    this.watch.tick(
      exemptPid !== null
        ? { paneId, pid: exemptPid, startTimeMs: curSsh.get(exemptPid)!.startTimeMs }
        : undefined,
    );
    // Advance the delta baseline for the next dispatch/tick (all current ssh descendant pids).
    rec.sshBaseline = new Set(curSsh.keys());

    // (2) FREEZE the reconciled pre-effect frame (the derive-then-record PRE-push context, §3.1 point 1).
    const frozen = this.tracker.get(paneId);

    // (3) Apply the session effect for SUBSEQUENT commands (the command ALREADY ran — fire-after). An
    //     interactive-ssh frame push (depth delta) then REGISTERS the session ssh child so the watch can pop
    //     it on exit.
    const depthBefore = this.tracker.remoteDepth(paneId);
    this.tracker.recordDispatch(paneId, command);
    if (this.tracker.remoteDepth(paneId) > depthBefore) {
      // A clean interactive login pushed a frame. Register EXACTLY the proven child:
      //   - 1 new host-matching child ⇒ `noteSshOpened` (the child is already visible, fire-after).
      //   - >1 (assistant's + a user's same-host ssh both new in this window) ⇒ markUnknown: ambiguous,
      //     never guess (Opus R3 Q3). The current fill still uses the frozen frame; only subsequent decline.
      //   - 0 (the child has not appeared yet — a slow spawn) ⇒ record a pending straggler correlation that
      //     `correlateAllPending` retries; until then the unwatched-frame backstop declines (fail-safe).
      if (newHostMatch.length === 1) {
        this.watch.noteSshOpened(paneId, newHostMatch[0]);
      } else if (newHostMatch.length > 1) {
        this.tracker.markUnknown(paneId);
      } else if (dHost !== null) {
        rec.pendingSsh = { baseline: preBaseline, dHost, registered: false };
      }
    }

    // (4) ARM the poller iff this is a credential-shaped command in a session KNOWN both BEFORE the record
    //     (the derive-then-record context) AND AFTER it (post-record-sink gate, R5 — KEPT). `recordDispatch`
    //     can SINK the pane to UNKNOWN for a conditional/ambiguous command whose effect it cannot predict;
    //     the pre-record `frozen` still looks local, so without the post-record check the trailing prompt
    //     would fill under a mis-derived binding (Codex L3-4-W2 R5 P1). Declining a sunk pane is fail-safe.
    //     The arm uses only the CHEAP sync pre-filter — the authoritative `deriveBinding` runs in the loop.
    //     The POST-record frame is captured as `expected` (the state the command's own prompt shows in) so
    //     `poll` can detect an EXTERNAL change before filling (Codex R2 P1 + Opus R2 P2).
    const postRecord = this.tracker.get(paneId);
    rec.armed =
      isKnownSession(frozen) && isKnownSession(postRecord) && looksLikeCredential(command)
        ? { command, frozen, expected: postRecord, armedAtMs: this.deps.nowMs() }
        : null;
  }

  /**
   * One prompt-poll for a pane (the wiring drives this on a timer for every `armedPaneIds()`). Runs the
   * capture loop when a credential prompt appears, bound to the FROZEN session. Returns a `PollResult` for
   * observability; the loop's own outcome is the terminal signal.
   */
  async poll(paneId: string): Promise<PollResult> {
    const rec = this.panes.get(paneId);
    if (rec === undefined || rec.armed === null) return { status: "idle" };
    // SERIALIZE polls per pane (Codex L3-4-W2 P2). `pollBusy` is set BEFORE the `readPromptTail` await, so a
    // poll-timer re-entry while a prior poll is still awaiting the (slow, UIA) prompt read is dropped —
    // otherwise BOTH would pass the guard, observe the same prompt, and run two capture loops for one armed
    // dispatch (duplicate capture/inject/save). `pollBusy` spans the WHOLE poll incl. the capture loop.
    if (rec.pollBusy) return { status: "busy" };
    rec.pollBusy = true;
    try {
      const armed = rec.armed;

      // §0-CORR.2 straggler backstop: register a still-pending ssh child (rare in fire-after). Idempotent.
      if (rec.pendingSsh !== undefined && !rec.pendingSsh.registered) {
        this.correlateSshChild(paneId, rec.shellPid, rec.pendingSsh);
      }

      // Poller lifetime (OQ-W-2): a key-based ssh / cached sudo prints NO prompt — abandon (safe, no fill).
      if (this.deps.nowMs() - armed.armedAtMs > this.pollTimeoutMs) { rec.armed = null; return { status: "timed_out" }; }

      const verdict = await this.deps.readPromptTail(paneId);
      // The arm can be OVERWRITTEN during the (slow, UIA) read: onDispatch is NOT gated by `pollBusy`, so a
      // NEWER credential dispatch to this pane replaces `rec.armed` mid-read. Acting on the STALE `armed`
      // would fill/save the newer prompt under the OLDER binding. If the arm changed, abort — the fresh arm
      // is polled next tick (Codex L3-4-W2 R3 P1). Never clear the newer arm.
      if (rec.armed !== armed) return { status: "superseded" };
      if (verdict === null || !verdict.isCredentialPrompt) return { status: "polling" };

      // EARLY-DECLINE before opening the capture UI (Codex R2/R3 P1). The arm's `frozen` was reconciled at
      // DISPATCH, but an async change between arm and this poll — a user hand-ssh out of the launched pane
      // (doubt markUnknown), or a registered ssh exiting (session-end POP) — moves the pane out from under it.
      // `liveSessionMatchesExpected` RECONCILES (the poll can be the FIRST code to observe reality; the tracker
      // is stale until a tick — Codex R3) then checks the live session STILL matches `armed.expected`. A
      // mismatch here avoids opening a capture dialog on an already-changed pane. This is NOT the load-bearing
      // guard, though — the confirm/capture awaits below can change the session AFTER this check, so the
      // AUTHORITATIVE re-check is at the INJECTION INSTANT (`runCaptureLoopFor`'s injectPane wrapper, Codex R4).
      if (!this.liveSessionMatchesExpected(paneId, armed.expected)) { rec.armed = null; return { status: "declined" }; }

      // A credential prompt appeared → run the loop. Mark `pre-landed` (§0-CORR.3) FIRST so a command
      // delivered while the shell is blocked at this prompt — including the Mode-A `runToExit` landed re-run
      // — is DROPPED by onDispatch. The awaitLanded wrapper flips to `post-landed` on acceptance; the finally
      // resets `none`.
      rec.loopPhase = "pre-landed";
      try {
        const outcome = await this.runCaptureLoopFor(rec, paneId, armed);
        return { status: "filled", outcome };
      } finally {
        rec.loopPhase = "none";
        // Disarm ONLY the loop's OWN arm — a real dispatch that ran mid-loop (post-landed) may have replaced
        // `rec.armed` with a newer arm, which must survive to be polled next.
        if (rec.armed === armed) rec.armed = null;
      }
    } finally {
      rec.pollBusy = false;
    }
  }

  /** Is this pane still ANCHORED (a driver record exists)? The wiring's `launch_console` reuse checks this: a
   *  pane whose window is alive but whose record was torn down (a spurious `window_disappeared` → `onPaneClosed`,
   *  OQ-8) can never arm, so reuse must NOT return it — it launches a fresh, re-anchored pane instead. */
  hasPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /** Panes with a credential dispatch awaiting a prompt (the wiring polls exactly these). */
  armedPaneIds(): string[] {
    const out: string[] = [];
    for (const [paneId, rec] of this.panes) if (rec.armed !== null) out.push(paneId);
    return out;
  }

  /**
   * W2 — a pane's window closed / its hwnd was invalidated (event-bus `window_disappeared` /
   * identity-tracker reuse). `unwatchPane` is paired SAME-turn with `tracker.forget` (Edge 7): never drop
   * the watch while a remote frame stays trusted. Idempotent.
   */
  onPaneClosed(paneId: string): void {
    this.watch.unwatchPane(paneId);
    this.tracker.forget(paneId);
    this.panes.delete(paneId);
  }

  /**
   * Drive the watch's periodic reconcile (the wiring's tick timer, §2.1 mechanical half of W3). Registers
   * any pending straggler ssh child FIRST (so the periodic tick cannot markUnknown a just-pushed-but-
   * unregistered interactive-ssh frame), advances every pane's ssh-descendant baseline, then ticks with NO
   * exempt (the periodic timer has no just-dispatched command to prove a child for — §0-CORR.2 full scan).
   */
  tickWatch(): void {
    this.correlateAllPending();
    // Advance each pane's delta baseline so the NEXT onDispatch's "new since last reconcile" is accurate
    // (a child that appeared/exited between dispatches is folded in here). One snapshot per pane is fine at
    // the tick cadence; the watch also snapshots independently inside `tick`.
    for (const rec of this.panes.values()) {
      rec.sshBaseline = new Set(sshDescendants(this.deps.snapshot(), rec.shellPid).keys());
    }
    this.watch.tick();
    // ARM HYGIENE (Codex R1-R4 line 464): this tick may have popped/markUnknown'd a pane that holds a live
    // arm from an earlier dispatch (a user hand-ssh'd in, or the session ended). The injection-instant guard
    // already makes a stale fill IMPOSSIBLE, but leaving the arm set wastes polls and misreports
    // `armedPaneIds`. Disarm any pane whose (freshly-reconciled) live session no longer matches its arm's
    // `expected`. No extra tick — the tracker is already reconciled by the `watch.tick()` above.
    for (const [paneId, rec] of this.panes) {
      if (rec.armed !== null && !sessionMatches(this.tracker.get(paneId), rec.armed.expected)) rec.armed = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────

  private get tracker(): SessionTracker { return this.deps.tracker; }
  private get watch(): SshSessionWatch { return this.deps.watch; }

  /**
   * RECONCILE-then-CHECK: the single "is it still safe to fill this arm?" test. Drives the SAME reconcile the
   * dispatch path drives (correlate stragglers + `watch.tick()`, NO exempt — a user's in-bound ssh must fully
   * flag), THEN checks the pane's live session STILL matches the arm's `expected` frame (execHost + isRemote).
   * Used at BOTH the poll early-decline AND the INJECTION INSTANT — because the confirm/capture UI awaits
   * between them can take arbitrary user time, during which an async tick can pop/markUnknown the session
   * (Codex R3 line 408 / R4 line 524). The tracker only reflects reality after a tick, so the reconcile MUST
   * precede the read. Returns false on any mismatch (incl. UNKNOWN) ⇒ the pane is no longer the command's
   * context ⇒ do not fill. Matches `expected`, not `frozen`: a session-changing `ssh host-a` has frozen=local
   * but expected=host-a (its own push), so its own login prompt fills while an external pop/push/sink declines.
   */
  private liveSessionMatchesExpected(paneId: string, expected: SessionFrame): boolean {
    this.correlateAllPending();
    this.watch.tick();
    return sessionMatches(this.tracker.get(paneId), expected);
  }

  /**
   * Register the freshly-spawned interactive-ssh child of EVERY pane whose straggler correlation is still
   * pending. Called before every `watch.tick()` the driver issues (`onDispatch` step 1a + `tickWatch`) so a
   * just-pushed remote frame is registered before the tick's unwatched-frame backstop can see it. A pane
   * whose child is not visible yet stays pending and is retried; correlation is a no-op once resolved
   * (`registered`), so this is idempotent and O(pending panes) — usually 0.
   */
  private correlateAllPending(): void {
    for (const [paneId, rec] of this.panes) {
      const ssh = rec.pendingSsh;
      if (ssh !== undefined && !ssh.registered) this.correlateSshChild(paneId, rec.shellPid, ssh);
    }
  }

  /**
   * §0-CORR.2 straggler correlation — register the interactive-ssh child THIS dispatch spawned so the
   * session-end watch can pop it later. Among the shell subtree's ssh descendants that are NEW since the
   * dispatch baseline AND host-match `dHost`, register the one such pid. NEVER guess: >1 ⇒ `markUnknown`
   * (fail-safe — the current fill still uses the frozen frame, only subsequent commands decline). 0 ⇒ the
   * child has not spawned yet, leave pending for the next poll/tick.
   */
  private correlateSshChild(paneId: string, shellPid: number, ssh: PendingSshCorrelation): void {
    const snap = this.deps.snapshot();
    if (snap.parentMap.size === 0) return; // native failure this poll — retry next poll (no baseline change)

    const newMatch: number[] = [];
    for (const [pid, info] of sshDescendants(snap, shellPid)) {
      if (ssh.baseline.has(pid)) continue; // pre-existing (tunnel/sibling) — not this dispatch
      if (info.host === ssh.dHost) newMatch.push(pid);
    }

    if (newMatch.length > 1) { this.tracker.markUnknown(paneId); ssh.registered = true; return; }
    if (newMatch.length === 1) { this.watch.noteSshOpened(paneId, newMatch[0]); ssh.registered = true; }
    // 0 ⇒ not spawned yet — leave unresolved so a later poll/tick retries.
  }

  /**
   * Assemble the per-event `CaptureLoopDeps` bound to the FROZEN session (W3 — `getSession` returns the
   * frozen frame, never a live `tracker.get`) and run the merged capture loop. The `awaitLanded` wrapper
   * flips `loopPhase` to `post-landed` the instant it returns `accepted` (§0-CORR.3) — the shell is then
   * back at a prompt, so subsequent commands genuinely run and onDispatch admits them.
   */
  private runCaptureLoopFor(rec: PaneRecord, paneId: string, armed: ArmedDispatch): Promise<CaptureLoopOutcome> {
    const event: CredentialEvent = { paneId, dispatchedCommand: armed.command };
    const loopDeps: CaptureLoopDeps = {
      getSession: () => armed.frozen, // FROZEN pre-effect frame — the W3 closure
      deriveBinding: (cmd, session) => this.deps.deriveBinding(cmd, session),
      resolveBinding: (k) => this.deps.resolveBinding(k),
      bindBinding: (k, id, meta) => this.deps.bindBinding(k, id, meta),
      confirmPolicyFor: (k) => this.deps.confirmPolicyFor(k),
      capture: (id) => this.deps.capture(id),
      deleteSecret: (id) => this.deps.deleteSecret(id),
      // INJECTION-INSTANT re-check (Codex R4 line 524 — the AUTHORITATIVE disclosure guard). The poll's
      // early-decline ran BEFORE the loop; but `confirmPolicyFor`/`confirmInjection`/`capture` (a secure UI
      // dialog the user interacts with) await for ARBITRARY time before we get here, and an async `tickWatch`
      // can pop the ssh frame or markUnknown the pane DURING that wait. Injecting the FROZEN binding blind
      // would then type e.g. a remote sudo secret into a now-LOCAL prompt (the ssh exited while the confirm UI
      // was open) — a disclosure the pre-loop check cannot see. So RECONCILE + re-verify the live session STILL
      // matches `armed.expected` at the exact injection instant; on mismatch ABORT with `target_mismatch` (the
      // loop maps it to `fill_aborted` and, on the NO-MATCH path, its `finally` deletes the just-captured
      // secret — reverse-orphan). This is the local-vs-remote analog of L2's window/title injection-instant
      // re-verify, which does NOT catch a session change (plan §3 W3).
      injectPane: (b, id, sub) =>
        this.liveSessionMatchesExpected(paneId, armed.expected)
          ? this.deps.injectPane(paneId, b, id, sub)
          : Promise.resolve({ ok: false, code: "target_mismatch" } as InjectResult),
      awaitLanded: async (cmd) => {
        const result = await awaitLanded(
          {
            runToExit: () => this.deps.runToExit(paneId, cmd, armed.frozen.isRemote),
            readPaneAfterAuth: () => this.deps.readPaneAfterAuth(paneId),
          },
          cmd,
        );
        // §0-CORR.3: the login/sudo is accepted and the shell is back at a prompt — admit subsequent real
        // dispatches. A not-accepted result stays `pre-landed` (the loop then discards, no offer window).
        if (result.accepted) rec.loopPhase = "post-landed";
        return result;
      },
      confirmInjection: (b) => this.deps.confirmInjection(b),
      offerSave: (b) => this.deps.offerSave(b),
      mintOpaqueId: () => this.deps.mintOpaqueId(),
      now: () => this.deps.now(),
      ...(this.deps.isNever ? { isNever: (k: string) => this.deps.isNever!(k) } : {}),
      ...(this.deps.onNever ? { onNever: (k: string) => this.deps.onNever!(k) } : {}),
    };
    return runCaptureLoop(loopDeps, event);
  }
}

/** Does a live pane session STILL match the arm's `expected` context, by execHost + isRemote? (Not cwd —
 *  cwd only steers git-remote derivation for the https-cred scheme, which is not a pane channel, so a cwd
 *  drift cannot move a pane-injected secret cross-host.) UNKNOWN never matches (fail-safe). */
function sessionMatches(live: PaneSession, expected: SessionFrame): boolean {
  return isKnownSession(live) && live.execHost === expected.execHost && live.isRemote === expected.isRemote;
}

/**
 * The ssh-named DESCENDANTS of `shellPid` in a snapshot (subtree, not just direct children — the exempt
 * delta must see a `sudo ssh`/wrapper/tmux-reparented login the same way the W-2b scan does). For each,
 * report its interactive-login HOST (`commandLine` → `interactiveSshTarget`, or null for a tunnel/one-shot/
 * unreadable ssh) + its creation time (for the pid+time exempt). A `seen` set guards pid-reuse cycles.
 */
function sshDescendants(snap: ProcessSnapshot, shellPid: number): Map<number, { host: string | null; startTimeMs: number }> {
  const out = new Map<number, { host: string | null; startTimeMs: number }>();
  const seen = new Set<number>([shellPid]);
  const children = new Map<number, number[]>();
  for (const [pid, parentPid] of snap.parentMap) {
    const arr = children.get(parentPid);
    if (arr === undefined) children.set(parentPid, [pid]);
    else arr.push(pid);
  }
  const frontier: number[] = [shellPid];
  while (frontier.length > 0) {
    const parent = frontier.pop() as number;
    for (const pid of children.get(parent) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      frontier.push(pid);
      const id = snap.identify(pid);
      if (id.name !== SSH_PROGRAM) continue;
      const argv = snap.commandLine(pid);
      const host = argv === null ? null : interactiveSshTarget(argv.slice(1));
      out.set(pid, { host, startTimeMs: id.startTimeMs });
    }
  }
  return out;
}

/**
 * The interactive-login HOST the dispatched `command` opens (bare, lowercased), or null. Mirrors
 * `SessionTracker.recordDispatch`'s ssh-segment detection (env/redirect skip + backgrounded/piped/leading-
 * stdin-redirect + `interactiveSshTarget`) but returns the host instead of mutating a tracker. Used ONLY to
 * host-match the exempt-pid delta (§0-CORR.2). This is AVAILABILITY-only, not security: any divergence from
 * `recordDispatch` only biases toward NO exempt (the W-2b scan then flags the assistant's own login → the
 * login declines — a bounded availability regression, never a wrong-target). Returns the FIRST segment's
 * interactive-ssh host — the one `recordDispatch` would push a frame for.
 */
function dispatchedInteractiveSshHost(command: string): string | null {
  for (const seg of tokenizeCommandSegmentsWithOps(command)) {
    const { tokens, backgrounded, pipedStdin } = seg;
    // Skip leading env-assignments; the redirect-skip is folded into interactiveSshTarget's own whole-argv
    // scan below, so here we only need to find the program token past leading `FOO=bar`.
    let start = 0;
    while (tokens[start] !== undefined && ENV_ASSIGN_RE.test(tokens[start])) start++;
    if (programOf(tokens[start]) !== SSH_PROGRAM) continue;
    // A backgrounded / downstream-piped ssh takes stdin off the tty ⇒ no interactive login (mirrors
    // recordDispatch); a leading fd-0 redirect is caught inside interactiveSshTarget's whole-argv scan.
    if (backgrounded || pipedStdin) continue;
    const host = interactiveSshTarget(tokens.slice(start + 1));
    if (host !== null) return host;
  }
  return null;
}

/**
 * The cheap synchronous arm pre-filter (§0-CORR.1 A): does ANY segment's first real token name a program
 * that can prompt for a credential (`sudo`/`doas`/`ssh`/`su`)? A generous superset — the loop's own
 * `deriveBinding` is the authoritative gate, so an over-arm just polls a little then declines. Mirrors
 * `recordDispatch`'s env/redirect leading-token skip so `LC_ALL=C sudo …` / `>log ssh …` still arm.
 */
function looksLikeCredential(command: string): boolean {
  for (const seg of tokenizeCommandSegmentsWithOps(command)) {
    const { tokens } = seg;
    let start = 0;
    // Skip leading env-assignments (`FOO=bar`) — the redirect forms are rare on a credential command and a
    // miss only under-arms a redirected credential command (bounded: the periodic tick still reconciles).
    while (tokens[start] !== undefined && ENV_ASSIGN_RE.test(tokens[start])) start++;
    if (CREDENTIAL_PROGRAMS.has(programOf(tokens[start]))) return true;
  }
  return false;
}
