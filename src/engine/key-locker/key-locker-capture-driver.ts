// ADR-014 v2 R3 Key Locker — L3-4 W-2: the capture DRIVER (the live-wiring CRUX).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-4-live-wiring-plan.md (§2.2, §3)
//
// Every L3 pipeline module is merged, pure, and unit-tested in ISOLATION, but NOTHING wires them into a
// running loop. This driver is that first production owner — the orchestration that turns the terminal's
// dispatch/prompt events into "the locker learns and fills credentials", while honoring the three
// atomicity obligations the pure `ssh-session-watch.ts` header pinned as WIRING responsibilities (W1/W2/W3).
//
// It stays ENGINE-PURE over injected seams (no Win32 / host / terminal import) so the whole wrong-target
// story is unit-testable with a fake process tree; the thin IMPURE composition root (W-4,
// `key-locker-wiring.ts`) binds these seams to the real terminal hooks + Win32 and drives the timers. It
// OWNS a live `SessionTracker` + `SshSessionWatch` (constructed by the manager, W-3) — passed in so tests
// drive the REAL reconciliation against a controllable snapshot.
//
// The four events it services (all per-pane, keyed by `paneId = String(hwnd)` decimal — the same key the
// terminal, inject-target, and ssh-watch all emit, so tracker keys / InjectTarget hwnd / shellPid stay
// consistent BY CONSTRUCTION):
//   * onLocalPaneLaunched — W1 anchor: a pane L3 ITSELF launched from a known-local shell is anchored
//     KNOWN-LOCAL + watched, in ONE synchronous turn. A pre-existing pane is never anchored → stays UNKNOWN
//     → every fill declines (P1-B: anchoring on "no ssh child seen" would false-anchor a plink/mosh/renamed-
//     ssh pane local and disclose a LOCAL secret to a REMOTE prompt).
//   * onDispatch — the S-A dispatch hook. RECONCILE-then-FREEZE (W3): tick the watch FIRST (pop a dead ssh /
//     markUnknown an ambiguous-or-in-bound-ssh pane) so the tracker is at a correct-or-UNKNOWN steady state,
//     THEN freeze `tracker.get(paneId)` as the pre-effect frame the capture loop derives from — never a live
//     read that a later async tick could perturb. Then record the session effect (derive-then-record) and
//     arm the prompt poller for a credential command.
//   * poll — the prompt poller (the wiring drives it on a timer). Correlates the newly-spawned ssh child for
//     the session-end watch (§3.1 before/after DIFF), then, on a credential prompt, runs `runCaptureLoop`
//     bound to the FROZEN session. Single-flight per pane (P2-E) also suppresses the re-entrant onDispatch
//     the Mode-A landed re-run fires (W4-O2).
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
import type { SessionContext } from "./command-derivation.js";
import { awaitLanded, type ExitCompletion } from "./landed-detection.js";
import type { InjectResult } from "./injector.js";
import { interactiveSshTarget, isKnownSession, type SessionFrame, type SessionTracker } from "./session-tracker.js";
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
   *  `getProcessCommandLineByPid` in production; a fake in tests). Used ONLY for the §3.1 ssh-child DIFF —
   *  the watch snapshots independently for its own `tick`. */
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
  /** Assemble the pane InjectTarget for `paneId` (`assembleInjectTarget`) + SendInput (`inject`, "pane"). */
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
  /** `nowMs()` when armed (poller lifetime, OQ-W-2). */
  armedAtMs: number;
}

/** The §3.1 before/after ssh-child DIFF state for one interactive-ssh dispatch. */
interface SshCorrelation {
  /** The shell's DIRECT `ssh` children BEFORE the dispatch (the diff baseline — a pre-existing tunnel is
   *  in here, so it is never mis-registered as this dispatch's login; Opus R2 Q2). */
  preSsh: Set<number>;
  /** Whether the pre-dispatch snapshot succeeded (a native failure ⇒ no trustworthy baseline ⇒ fail-safe). */
  baselineOk: boolean;
  /** Whether the correlation has resolved (registered the child, or declined) — one-shot per dispatch. */
  registered: boolean;
}

/** Per-pane driver state (exists iff the driver ANCHORED the pane — i.e. L3 launched it). */
interface PaneRecord {
  /** The window-owning shell pid (`getWindowProcessId(hwnd)`), for the §3.1 subtree root. */
  shellPid: number;
  /** The credential dispatch awaiting a prompt, or null. */
  armed: ArmedDispatch | null;
  /** Monotonic per-pane dispatch counter. Each `onDispatch` bumps it + clears `armed`; the post-derive
   *  publish is gated on the counter being unchanged, so only the LATEST dispatch arms (Codex L3-4-W2 R4). */
  dispatchSeq: number;
  /** The pending §3.1 interactive-ssh child correlation, DECOUPLED from `armed` and published the instant
   *  `recordDispatch` pushes the frame — BEFORE the arm-derive await — so `correlateAllPending` can register
   *  the child even while `deriveBinding` (`ssh -G`) is still awaiting (Codex L3-4-W2 R3 P2). Also survives
   *  a not-armed ssh (binding null): the session-end watch still needs the child. Overwritten on the next
   *  ssh push, resolved once `registered`. */
  pendingSsh: SshCorrelation | undefined;
  /** A `poll()` is in progress for this pane — serializes polls (a re-entrant poll returns `busy`) so a
   *  slow prompt read cannot let two polls run two capture loops for one dispatch (Codex L3-4-W2 R2 P2). */
  pollBusy: boolean;
  /** True ONLY while the Mode-A `runToExit` landed seam is executing — the exact window that seam re-fires
   *  onDispatch for the same command (W4-O2). onDispatch drops a re-entrant ONLY on this flag (NOT a command
   *  string, which is fragile to hook-emission normalization — Opus R7 P2). Mode B never enters runToExit, so
   *  a genuine post-auth dispatch during readPaneAfterAuth/offerSave is admitted (recorded/reconciled). */
  inRunToExit: boolean;
}

const SSH_PROGRAM = "ssh";
const DEFAULT_POLL_TIMEOUT_MS = 20_000;

/**
 * The live capture driver. Constructed once by the manager (W-3) with the shared tracker + watch + the
 * live seams; the wiring root (W-4) calls its four events from the terminal hooks + a poll/tick timer.
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
    this.panes.set(paneId, { shellPid, armed: null, dispatchSeq: 0, pendingSsh: undefined, pollBusy: false, inRunToExit: false });
  }

  /**
   * The S-A dispatch hook — one credential dispatch's session bookkeeping + poller arm. RECONCILE-then-
   * FREEZE (W3): the reconcile (tick) and freeze and record run with NO `await` between them, so an
   * interleaved async tick (an external ssh child exiting) cannot reorder them; only the pure, idempotent
   * arm-derive is awaited AFTER the tracker is already updated.
   *
   * Single-flight (P2-E / W4-O2): while a capture loop is in flight for this pane the shell is blocked on a
   * prompt, so a re-entrant dispatch — including the one the Mode-A `runToExit` landed-run itself fires —
   * must NOT advance `recordDispatch` against an un-landed frame. Dropped.
   *
   * A pane the driver never anchored (`panes` has no record — a pre-existing user pane, P1-B) is ignored
   * here; the tracker stays UNKNOWN for it and every fill declines. (W4-O1: this hook may fire for a
   * command that never actually reaches the shell — a pushed-but-unspawned ssh frame simply never gets an
   * ssh child to correlate and is markUnknown'd by the watch's unwatched-frame backstop; no prompt ⇒ no
   * loop. The driver must not assume every fire = a command that ran.)
   */
  async onDispatch(paneId: string, command: string): Promise<void> {
    const rec = this.panes.get(paneId);
    if (rec === undefined) return;
    // Drop the Mode-A landed RE-RUN — the `runToExit` seam re-fires onDispatch mid-loop (W4-O2) — but NOT a
    // real dispatch. We gate on the `inRunToExit` FLAG (set only around that seam, `runCaptureLoopFor`), NOT a
    // command-string match (fragile to any hook-emission normalization — Opus R7 P2). A Mode-B interactive
    // login succeeds mid-loop and never enters runToExit, so a genuine `ssh host-b` during
    // `readPaneAfterAuth`/`offerSave` is recorded/reconciled, not dropped (Codex R6 P1).
    if (rec.inRunToExit) return;

    // (0a) SUPERSEDE the prior arm. A newer dispatch means the previous command's prompt is stale — clearing
    //      `rec.armed` HERE, before the arm-derive await, stops a poll from filling THIS command's prompt
    //      under the OLD binding while we derive (Codex L3-4-W2 R4 P1: a cached-sudo arm left in place while a
    //      slow `ssh` derives → the ssh prompt appears → the poll's `rec.armed !== armed` guard sees the
    //      unchanged sudo arm and fills the ssh prompt under sudo). A per-dispatch sequence token gates the
    //      post-await publish so only the LATEST dispatch arms — two overlapping derives can resolve out of
    //      order, and the older must not clobber the newer's arm.
    const seq = ++rec.dispatchSeq;
    rec.armed = null;

    // (0b) REGISTER any pending ssh child BEFORE reconciling. `watch.tick()` is driven ONLY from the driver
    //     (here + `tickWatch`), so registering every armed pane's freshly-spawned interactive-ssh child
    //     first makes the push→register window non-observable to this tick: a just-pushed-but-unregistered
    //     remote frame (`session===null && remoteDepth>0`) would otherwise trip the watch's unwatched-frame
    //     backstop → markUnknown, losing a NORMAL ssh login's tracking (Codex L3-4-W2 P1; the residual is
    //     only the sub-ms gap before the child appears in Toolhelp = OQ-W-9). Fail-safe either way — the
    //     push stays at dispatch (an unwatched frame declines, never wrong-targets; DEFERRING the push
    //     would under-report remote and DISCLOSE a local secret to a remote prompt, so it is NOT done).
    this.correlateAllPending();
    // (1) RECONCILE this pane to a correct-or-UNKNOWN steady state (P1-A: pop a dead ssh so a post-exit
    //     command doesn't freeze a stale remote; W-2b: markUnknown a user-typed in-bound ssh). Synchronous.
    this.watch.tick();
    // (2) FREEZE the reconciled pre-effect frame (the derive-then-record PRE-push context, §3.1 point 1).
    const frozen = this.tracker.get(paneId);
    // (4) Apply the session effect for SUBSEQUENT commands. An interactive-ssh frame push (depth delta)
    //     PUBLISHES the §3.1 child correlation onto `rec.pendingSsh` — the PRE-dispatch direct-ssh-child
    //     baseline (the ssh child spawns only after the send, so the baseline never contains it — W4-O1).
    //     Publishing it HERE (before the arm-derive await, decoupled from `armed`) is load-bearing: a
    //     `tickWatch` during a slow `deriveBinding` (`ssh -G`) must be able to see the pending correlation via
    //     `correlateAllPending`, else it markUnknowns the just-pushed unwatched frame (Codex L3-4-W2 R3 P2).
    const depthBefore = this.tracker.remoteDepth(paneId);
    this.tracker.recordDispatch(paneId, command);
    if (this.tracker.remoteDepth(paneId) > depthBefore) rec.pendingSsh = this.snapshotSshBaseline(rec.shellPid);

    // (3) ARM the poller iff this is a credential command in a session that is KNOWN both BEFORE the record
    //     (the derive-then-record context) AND AFTER it. `recordDispatch` can SINK the pane to UNKNOWN for a
    //     conditional/ambiguous command — `false && ssh host ; sudo -v`, `cd x && ssh host` — whose effect it
    //     cannot predict; the pre-record `frozen` still looks local, so without the post-record check the
    //     trailing `sudo` prompt would fill under the (mis-derived) skipped-ssh binding (Codex L3-4-W2 R5 P1).
    //     Declining a sunk pane is the fail-safe (never wrong-target). The derive is pure/idempotent; the loop
    //     re-derives from the SAME frozen frame (a benign double-derive). `pendingSsh` (session tracking) is
    //     INDEPENDENT of arming, so it stays. Both pre-await returns leave the null from 0a (nothing async yet).
    if (!isKnownSession(frozen) || !isKnownSession(this.tracker.get(paneId))) return;
    const binding = await this.deps.deriveBinding(command, frozen);
    // Publish ONLY if this dispatch is still the latest for the pane — a newer onDispatch (which bumped
    // `dispatchSeq` and cleared `rec.armed`) owns the arm now; an out-of-order older derive must not clobber
    // it. `binding === null` (not a credential) leaves the pane disarmed (rec.armed is already null).
    if (rec.dispatchSeq !== seq || binding === null) return;
    rec.armed = { command, frozen, armedAtMs: this.deps.nowMs() };
  }

  /**
   * One prompt-poll for a pane (the wiring drives this on a timer for every `armedPaneIds()`). Correlates
   * the freshly-spawned interactive-ssh child for the session-end watch FIRST (§3.1), then runs the capture
   * loop when a credential prompt appears. Returns a `PollResult` for observability; the loop's own outcome
   * is the terminal signal.
   */
  async poll(paneId: string): Promise<PollResult> {
    const rec = this.panes.get(paneId);
    if (rec === undefined || rec.armed === null) return { status: "idle" };
    // SERIALIZE polls per pane (Codex L3-4-W2 P2). `pollBusy` is set BEFORE the `readPromptTail` await, so a
    // poll-timer re-entry while a prior poll is still awaiting the (slow, UIA) prompt read is dropped —
    // otherwise BOTH would pass the guard, observe the same prompt, and run two capture loops for one armed
    // dispatch (duplicate capture/inject/save). `pollBusy` spans the WHOLE poll incl. the capture loop, so it
    // is the sole poll-serialization gate (onDispatch's own drop uses the separate `inRunToExit` flag).
    if (rec.pollBusy) return { status: "busy" };
    rec.pollBusy = true;
    try {
      const armed = rec.armed;

      // §3.1: register the newly-appeared interactive-ssh child (the wiring correlates it here, not at
      // dispatch — the child does not exist yet in that turn). Runs every poll until it resolves.
      if (rec.pendingSsh !== undefined && !rec.pendingSsh.registered) this.correlateSshChild(paneId, rec.shellPid, rec.pendingSsh);

      // Poller lifetime (OQ-W-2): a key-based ssh / cached sudo prints NO prompt — abandon (safe, no fill).
      if (this.deps.nowMs() - armed.armedAtMs > this.pollTimeoutMs) { rec.armed = null; return { status: "timed_out" }; }

      const verdict = await this.deps.readPromptTail(paneId);
      // The arm can be OVERWRITTEN during the (slow, UIA) read: onDispatch is NOT gated by `pollBusy` (only by
      // `inRunToExit`, false here), so a NEWER credential dispatch to this pane replaces `rec.armed` mid-read. Acting on
      // the STALE `armed` would fill/save the newer prompt under the OLDER binding (e.g. a cached-sudo arm
      // then an ssh-password prompt → sudo secret into the ssh prompt). If the arm changed, abort — the
      // fresh arm is polled next tick (Codex L3-4-W2 R3 P1). Never clear the newer arm.
      if (rec.armed !== armed) return { status: "superseded" };
      if (verdict === null || !verdict.isCredentialPrompt) return { status: "polling" };

      // A credential prompt appeared → run the loop. `pollBusy` (set above) already blocks a re-entrant poll
      // for the whole loop; onDispatch is admitted EXCEPT while the Mode-A `runToExit` seam runs (the driver
      // brackets it with `inRunToExit`, `runCaptureLoopFor`). A Mode-B login succeeds mid-loop, so a real
      // `ssh host-b` during `readPaneAfterAuth`/`offerSave` records/reconciles rather than being dropped and
      // leaving the tracker stale on host-a (Codex L3-4-W2 R6 P1).
      try {
        const outcome = await this.runCaptureLoopFor(rec, paneId, armed);
        return { status: "filled", outcome };
      } finally {
        // Disarm ONLY the loop's OWN arm — a real dispatch that ran mid-loop may have replaced `rec.armed`
        // with a newer arm (via the onDispatch 0a-clear + republish), which must survive to be polled next.
        if (rec.armed === armed) rec.armed = null;
      }
    } finally {
      rec.pollBusy = false;
    }
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

  /** Drive the watch's periodic reconcile (the wiring's tick timer, §2.1 mechanical half of W3). Registers
   *  any pending ssh child FIRST so the periodic tick cannot markUnknown a just-pushed-but-unregistered
   *  interactive-ssh frame (the push→register window — see `onDispatch` step 0). */
  tickWatch(): void {
    this.correlateAllPending();
    this.watch.tick();
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────

  private get tracker(): SessionTracker { return this.deps.tracker; }
  private get watch(): SshSessionWatch { return this.deps.watch; }

  /** The shell's DIRECT `ssh` children right now (the §3.1 diff baseline). Called at dispatch, when the
   *  interactive ssh's own child does NOT yet exist (W4-O1: the hook fires before the send). */
  private snapshotSshBaseline(shellPid: number): SshCorrelation {
    const snap = this.deps.snapshot();
    if (snap.parentMap.size === 0) return { preSsh: new Set(), baselineOk: false, registered: false };
    return { preSsh: sshDirectChildren(snap, shellPid), baselineOk: true, registered: false };
  }

  /**
   * Register the freshly-spawned interactive-ssh child of EVERY armed pane whose correlation is still
   * pending. Called before every `watch.tick()` the driver issues (`onDispatch` step 0 + `tickWatch`) so a
   * just-pushed remote frame is registered before the tick's unwatched-frame backstop can see it. A pane
   * whose child is not visible yet stays pending and is retried on the next tick/poll; correlation is a
   * no-op once resolved (`registered`), so this is idempotent and O(pending panes) — usually 0–1.
   */
  private correlateAllPending(): void {
    for (const [paneId, rec] of this.panes) {
      const ssh = rec.pendingSsh;
      if (ssh !== undefined && !ssh.registered) this.correlateSshChild(paneId, rec.shellPid, ssh);
    }
  }

  /**
   * §3.1 before/after DIFF — register the interactive-ssh child THIS dispatch spawned so the session-end
   * watch can pop it later. Among the shell's DIRECT `ssh` children that are NEW since the baseline (a
   * pre-existing tunnel/control-master is excluded — Opus R2 Q2), register the one whose argv classifies as
   * an interactive login. NEVER guess: >1 interactive OR any argv-unreadable NEW ssh child ⇒ `markUnknown`
   * (Opus R3 Q3, fail-safe — the current fill still uses the frozen frame, only subsequent commands
   * decline). 0 interactive ⇒ the child has not spawned yet, keep polling.
   */
  private correlateSshChild(paneId: string, shellPid: number, ssh: SshCorrelation): void {
    if (!ssh.baselineOk) { this.tracker.markUnknown(paneId); ssh.registered = true; return; }
    const snap = this.deps.snapshot();
    if (snap.parentMap.size === 0) return; // native failure this poll — retry next poll (no baseline change)

    // `sshDirectChildren` gates on `identify().name === "ssh"`, so a NEW login whose ssh process is
    // NAME-unreadable (an elevated/cross-user ssh whose OpenProcess is denied) is excluded from this diff
    // rather than flagged ambiguous. That is still FAIL-SAFE, just via a different path: its pushed remote
    // frame stays unwatched (`session === null && remoteDepth > 0`), so the watch `tick` backstop
    // (`ssh-session-watch.ts`) markUnknowns the pane on the next poll. (The argv-unreadable path below flags
    // immediately; the name-unreadable case is the rarer elevated-ssh variant the backstop covers.)
    const interactive: number[] = [];
    let ambiguous = false;
    for (const pid of sshDirectChildren(snap, shellPid)) {
      if (ssh.preSsh.has(pid)) continue;                 // pre-existing (tunnel/sibling) — not this dispatch
      const argv = snap.commandLine(pid);
      if (argv === null) { ambiguous = true; continue; }  // unreadable elevated/cross-user ssh — fail-safe
      if (interactiveSshTarget(argv.slice(1)) !== null) interactive.push(pid);
    }

    if (ambiguous || interactive.length > 1) { this.tracker.markUnknown(paneId); ssh.registered = true; return; }
    if (interactive.length === 1) { this.watch.noteSshOpened(paneId, interactive[0]); ssh.registered = true; }
    // 0 interactive ⇒ not spawned yet — leave unresolved so a later poll retries.
  }

  /**
   * Assemble the per-event `CaptureLoopDeps` bound to the FROZEN session (W3 — `getSession` returns the
   * frozen frame, never a live `tracker.get`) and run the merged capture loop.
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
      injectPane: (b, id, sub) => this.deps.injectPane(paneId, b, id, sub),
      awaitLanded: (cmd) => awaitLanded({
        // BRACKET the Mode-A re-run window: onDispatch drops a re-entrant only while `inRunToExit` is set (the
        // exact seam that re-fires it, W4-O2) — robust to hook-string normalization (Opus R7 P2). Mode B calls
        // `readPaneAfterAuth`, never this, so the flag stays false there → real post-auth dispatches admitted.
        runToExit: async () => {
          rec.inRunToExit = true;
          try { return await this.deps.runToExit(paneId, cmd, armed.frozen.isRemote); }
          finally { rec.inRunToExit = false; }
        },
        readPaneAfterAuth: () => this.deps.readPaneAfterAuth(paneId),
      }, cmd),
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

/** The DIRECT `ssh`-named children of `shellPid` in a snapshot (the §3.1 diff works over direct children:
 *  the outermost session ssh — incl. a ProxyJump `ssh -J bastion host` — is a direct child; only the outer
 *  ssh is locally visible). */
function sshDirectChildren(snap: ProcessSnapshot, shellPid: number): Set<number> {
  const out = new Set<number>();
  for (const [pid, parentPid] of snap.parentMap) {
    if (parentPid === shellPid && snap.identify(pid).name === SSH_PROGRAM) out.add(pid);
  }
  return out;
}
