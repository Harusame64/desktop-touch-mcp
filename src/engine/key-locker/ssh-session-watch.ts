// ADR-014 v2 R3 Key Locker — L3 §3 / §6: the ssh session-end watch (SP-L3-OQ-7).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-3-manager-watch-plan.md (PR 3) +
//   adr-014-v2-r3-l3-capture-plan.md §3 (the ssh-out pop signal).
//
// WHY: an interactive `ssh user@host` runs under Mode B (a pane read), NOT an exit-mode watch — so the
// SessionTracker frame it pushed has no exit code to pop on. If it is never popped, a later LOCAL command
// in that pane derives `sudo://<remotehost>` and, on a MATCH, would autofill the REMOTE secret into a
// LOCAL prompt — a wrong-target fill. The authoritative session-end signal is the SESSION's `ssh` CHILD
// PROCESS exiting, observed via the process tree (a process observation, never a screen-scrape).
//
// WHAT IT WATCHES (Opus L3-3 PR#505 R1 P2-A): the tracker pushes a frame ONLY for an INTERACTIVE ssh —
// a backgrounded `ssh -f -L`, a one-shot `ssh host cmd`, and a ProxyJump/`-W` child ssh push NO frame yet
// are ALSO `ssh` processes under the shell. So the watch must NOT react to "any ssh descendant exiting"
// (a dying tunnel would pop a still-live interactive frame → the pane mislabels remote-as-local → the
// INVERSE wrong-target). Instead the wiring, which dispatched the interactive ssh and can correlate the
// child it spawned, REGISTERS that specific pid via `noteSshOpened`; the watch fires only when THAT pid
// exits. Only the OUTERMOST ssh is locally visible (an inner `ssh b` runs ON host-a).
//
// STRUCTURAL AXIS (Opus/Codex PR#505 R2–R5, folded from five rounds of wrong-target edges): the watch can
// reliably observe EXACTLY ONE thing — the single depth-1 outer ssh, ALIVE, readable as `ssh`, with a
// NON-ZERO creation time matching the registered baseline. It TRUSTS only that one state; a session-bearing
// pane is observable/trustable ONLY at EXACTLY `remoteDepth === 1`, and EVERY other state declines. So, for
// a pane with a registered session: depth 1 + confirmed-same → KEEP; depth 1 + confirmed-exit → POP; depth 1
// + unconfirmable identity (unreadable "" / zero creation time) → SINK; **depth ≥ 2 (nested) → ALWAYS SINK**
// (the inner login runs on the remote host, unobservable locally, so it can never be popped); **depth 0 +
// LIVE registered ssh → SINK** (the tracker was re-anchored local while the ssh lives — trusting local would
// wrong-target); **depth 0 + GONE pid → DROP the stale watch, KEEP local** (a benign re-anchor race, the
// local anchor is legitimate). Nesting AND the depth invariant are enforced at `tick` (and nesting also at
// registration) so the watch self-enforces rather than trusting wiring discipline.
//
// This module is PURE reconciliation over an injected process snapshot — no Win32 import — so it
// unit-tests with a fake tree. The KeyLockerManager (the live wiring, deferred) owns the instance: it
// snapshots via win32 `buildProcessParentMap()` + `getProcessIdentityByPid()` (mapping `processName`
// LOWERCASED into `ProcessIdentity.name`), registers the shell pid + the session ssh pid, and drives
// `tick()` on a timer. That live wiring lands with the terminal-event subscription.
//
// FAIL-SAFE (§3, Opus/Codex R2–R5 P2): any doubt sinks the pane to `markUnknown` (decline-to-derive), NEVER
// a stale trusted `isRemote:true` and NEVER a pop-to-local on a live session. Doubt sources: (a) an
// unwatchable pane (its shell pid vanished); (b) NESTED ssh (`remoteDepth ≥ 2`) — the invisible inner login
// is unobservable, so a nested pane is declined outright (R4); (c) a registered session ssh PRESENT but
// UNREADABLE this tick — identify() reads "" for a live pid (R2) OR `startTimeMs === 0` for a live ssh whose
// creation-time read failed (win32 reads name/time independently — R4); (d) a remote frame with NO live
// watch — a registration that could not confirm a live `ssh`, or the non-atomic push↔register window (R3:
// `noteSshOpened` sink + the `tick` backstop); (e) `remoteDepth === 0` with a LIVE registered ssh — the
// tracker was re-anchored local while the ssh lives, so trusting local would wrong-target (R5).
//
// INVARIANTS the watch relies on (breaking either breaks the watch): (1) `SessionTracker.recordDispatch`
// pushes `isRemote:true` ONLY for `program === "ssh"`, so EVERY remote frame is an ssh frame and the
// `name === "ssh"` trust is sound; (2) `session.startedAt` is never 0 (registration forbids it). RECOVERY:
// `markUnknown` sets the tracker stack to null and does NOT auto-recover on the session's later exit —
// `recordDispatch` early-returns on a null stack — so an unknown pane re-anchors only when the wiring calls
// `beginLocalSession` at a fresh local prompt (SP-L3-OQ-8 territory), not via exit observation. Safe
// (declines), just degraded longer. RESIDUAL (P3, plan §Risks): the shell anchor is liveness-only
// (`!parentMap.has(shellPid)`) with no startTime check — a reused shell pid can mask shell death; it
// self-heals (the dead shell's ssh child dies/reparents ⇒ the session check catches it) and is tracked in
// the plan, not gated on.
//
// SCOPE / FIXED POINT (Opus PR#505 closing sweep): this pure module reconciles every STEADY (watch,tracker)
// state to safety — any desync self-heals within one `tick`, so at rest there is no wrong-target. What a
// pure module CANNOT close is the INTER-TICK WINDOW: a credential fill derives straight from `tracker.get()`
// (never through this watch), so a wiring mutation that transiently puts the tracker in a wrong-target state
// can be read before the next tick reconciles. Closing that window is therefore a WIRING obligation, not a
// module fix. INVARIANTS THE LIVE WIRING MUST HONOR (deferred to the terminal-subscription PR, plan §Risks):
//   (W1) Re-anchor atomicity: `tracker.beginLocalSession(paneId)` MUST run in the SAME synchronous turn as
//        `watchPane(paneId, shellPid)` — never re-anchor the tracker to local while a live watch session
//        lingers (Edge 3).
//   (W2) Close atomicity: `unwatchPane(paneId)` MUST be paired same-turn with the tracker forgetting/clearing
//        that pane's frames — never drop the watch while a remote frame stays trusted (Edge 7).
//   (W3) Derive/mutate atomicity + tick liveness: push-then-`noteSshOpened` in one turn, NO credential derive
//        interleaved across an un-reconciled turn, and `tick` driven on the timer (Edges 1/2/4/9).
//
// W-2b (Opus L3-4 R2 Q1 / R3 Q1a — the UNREGISTERED in-bound ssh fail-safe): the reconcile above only covers
// sessions the wiring REGISTERED. But in the cooperative model the user can hand-`ssh host` out of the SAME
// local pane the assistant launched — the wiring never dispatched it, so no frame is pushed and no pid is
// registered; the tracker stays confidently local and a later assistant `sudo` would fill a LOCAL secret into
// the REMOTE prompt (disclosure). So at `tick`, for a LOCAL-anchored pane (`session===null` AND
// `remoteDepth===0`), scan the shell's process SUBTREE for an ssh DESCENDANT (an ssh reached through an
// intermediate — `sudo ssh`, a wrapper, a tmux server that stays UNDER the shell — is a grandchild the walk
// still finds; an ssh REPARENTED OUT of the shell subtree entirely, e.g. a detached daemon, is out of scope,
// a low-risk residual on the Windows target where a login pane's ssh normally stays under the shell) and
// classify its argv with the SAME `interactiveSshTarget` rule: an interactive in-bound login — OR an ssh
// whose argv is UNREADABLE or EMPTY (elevated/cross-user or a bad read: fail-safe) — sinks the
// pane to `markUnknown`. A tunnel (`-N`/`-f`/`-L`), a one-shot (`ssh host cmd`), scp/sftp/git-over-ssh (their
// inner ssh carries a trailing remote command) classify non-interactive ⇒ NOT sunk, so those panes keep
// autofilling (OQ-W-7 = option B). This is a NEW fail-safe (markUnknown on doubt), never a new pop. It is
// gated on `remoteDepth===0` so a LEGIT assistant-dispatched interactive ssh — whose `recordDispatch` has
// pushed a frame (depth>0) — is handled by the existing unwatched-frame backstop, not this scan.

import { interactiveSshTarget } from "./session-tracker.js";

/** The tracker surface the watch drives (a subset of `SessionTracker`, so tests inject a fake). */
export interface SessionTrackerSink {
  /** Pop one remote frame — the registered session ssh exited and the pane maps 1:1 (depth ≤ 1). */
  noteSessionEnd(paneId: string): void;
  /** Sink the pane to UNKNOWN (decline-to-derive) — used for EVERY non-trusted state: a nested login
   *  (depth ≥ 2), an unwatchable pane (shell gone), a live-but-unconfirmable session ssh (unreadable or a
   *  zero creation time), or a remote frame with no live watch. Never followed by a pop-to-local. */
  markUnknown(paneId: string): void;
  /** Remote-frame depth above the base local shell (0 = local/unknown) — the pop-vs-markUnknown pivot. */
  remoteDepth(paneId: string): number;
}

/** One process's identity in a snapshot (from win32 `getProcessIdentityByPid`). */
export interface ProcessIdentity {
  /** Image name, LOWERCASED, `.exe` stripped (e.g. "ssh", "powershell"). "" when the pid is GONE **or**
   *  present-but-UNREADABLE this tick: win32 `getProcessIdentityByPid` returns empty on an OpenProcess
   *  failure — including ACCESS_DENIED on a LIVE elevated/other-user process — not only on a dead pid. So a
   *  caller MUST NOT infer exit from "" alone; cross-check `parentMap` (the liveness authority) first. The
   *  live adapter MUST lowercase win32's `processName` (it is not lowercased at source). */
  name: string;
  /** Creation time (ms since the Windows epoch). **0 = the creation-time read FAILED, NOT a real time** —
   *  win32 reads the image name and the creation time INDEPENDENTLY (`process.rs` step A / step B), so a
   *  LIVE process can return `{ name: "ssh", startTimeMs: 0 }` when only `GetProcessTimes` failed. A real
   *  running process never has creation time 0 (the Windows epoch is 1601), so 0 is the canonical DOUBT
   *  sentinel: never treat it as a confirmed exit/reuse, and never store it as a watch baseline
   *  (`session.startedAt` is always non-zero). A non-zero value distinguishes a REUSED pid from the same. */
  startTimeMs: number;
}

/** A live process-tree snapshot the watch reconciles against (injected so it unit-tests with a fake). */
export interface ProcessSnapshot {
  /** pid → parentPid for every live process (Toolhelp32). A pid present as a KEY means it is alive. An
   *  EMPTY map = a native-snapshot failure (`buildProcessParentMap` swallows errors → {}), NOT "no
   *  processes" — the watch skips such a tick rather than mis-read every shell as dead. */
  parentMap: Map<number, number>;
  /** Identity for a pid (name + creation time). A gone OR present-but-unreadable pid returns
   *  `{ name: "", startTimeMs: 0 }` — use `parentMap` (the liveness authority) to tell the two apart. */
  identify(pid: number): ProcessIdentity;
  /** A pid's launch argv (`getProcessCommandLineByPid` — W-0), or `null` on ANY read failure
   *  (dead pid / ACCESS_DENIED on an elevated-or-cross-user target / parse failure). The W-2b scan
   *  reads it ONLY for `ssh`-named descendants and treats `null` as "possibly interactive" (fail-safe
   *  markUnknown). `argv[0]` is the ssh image; the classifier takes `argv.slice(1)`. */
  commandLine(pid: number): string[] | null;
}

export interface SshWatchDeps {
  /** Snapshot the live process tree (win32 in production; a fake in tests). Called once per `tick`. */
  snapshot(): ProcessSnapshot;
  /** The SessionTracker to drive on a session-end / unconfirmable end. */
  tracker: SessionTrackerSink;
}

/** A registered pane: the shell pid (liveness anchor) + the outermost session ssh currently watched. */
interface WatchedPane {
  shellPid: number;
  /** The outermost interactive-session ssh child, or null when the pane holds no live ssh session. */
  session: { pid: number; startedAt: number } | null;
}

const SSH_PROGRAM = "ssh";

/**
 * Watches each registered pane's outermost interactive-session ssh process for exit, driving the
 * SessionTracker's pop / markUnknown. Pure reconciliation: `tick()` snapshots the tree and checks the
 * one registered session pid per pane. Register a pane with `watchPane` on anchor; register its session
 * ssh child with `noteSshOpened` when the wiring pushes an interactive frame; `unwatchPane` on close.
 */
export class SshSessionWatch {
  private readonly panes = new Map<string, WatchedPane>();

  constructor(private readonly deps: SshWatchDeps) {}

  /**
   * Start watching `paneId`, anchored at its shell pid (`getWindowProcessId(hwnd)` — the window-owning
   * pid, value-consistent with L2's re-verify). No session ssh is watched until `noteSshOpened`.
   * Re-registering a pane resets it (drops any tracked session).
   */
  watchPane(paneId: string, shellPid: number): void {
    // Re-anchoring a pane that STILL holds a live ssh session: silently resetting to a trusted-local slot
    // (`session = null`) would let the R5 `tick` guard miss it (that guard needs `session !== null` to see
    // the live-remote-vs-local contradiction), leaving a live remote login derived as local. Decline first,
    // then reset — a re-anchor over a live session is doubt, so sink it (Opus/Codex R6).
    if (this.panes.get(paneId)?.session != null) this.deps.tracker.markUnknown(paneId);
    this.panes.set(paneId, { shellPid, session: null });
  }

  /** Stop watching a pane (its window closed / the tracker forgot it). Idempotent. */
  unwatchPane(paneId: string): void {
    this.panes.delete(paneId);
  }

  /** Is this pane currently watched? (Lets the wiring avoid double-registration.) */
  isWatching(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /**
   * Register the OUTERMOST interactive-session ssh child pid for a pane — the wiring calls this in the SAME
   * synchronous turn it pushes the interactive frame (push FIRST, then this — no `await`/tick between, so
   * `remoteDepth` already reflects the push here), having correlated the ssh child it just spawned. A no-op
   * if the pane isn't watched. The watch trusts ONE state (see STRUCTURAL AXIS in the file header); this
   * establishes it or declines:
   *   - NESTED (`remoteDepth ≥ 2`): a second remote frame is already up, so this is a nested login. The
   *     inner ssh runs ON the remote host and is invisible locally ⇒ its end can never be observed ⇒
   *     decline outright (`markUnknown`) rather than trust an unobservable frame (R4). Both this and the
   *     `tick` nested guard enforce it, so a missed re-registration still declines within one poll.
   *   - WATCHABLE: the pid is present in the Toolhelp map, readable as `ssh`, AND has a NON-ZERO creation
   *     time ⇒ record `{pid, startedAt}` as the single trusted session.
   *   - Everything else (pid gone/bad, present readable NON-ssh, present but UNREADABLE `""`, or a partial
   *     `ssh` read with `startTimeMs === 0` — no reliable baseline): clear the slot, and if a remote frame
   *     was already pushed (`remoteDepth > 0`) sink it to `markUnknown` so no unwatched `isRemote:true` is
   *     stranded (the stale-remote wrong-target — R3). A speculative call on a still-LOCAL pane
   *     (`remoteDepth 0`) just clears the slot — it must NOT nuke the local anchor.
   */
  noteSshOpened(paneId: string, sshPid: number): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined) return;
    // NESTED (depth ≥ 2): decline — the invisible inner login is unobservable, so it could never be popped.
    if (this.deps.tracker.remoteDepth(paneId) >= 2) {
      pane.session = null;
      this.deps.tracker.markUnknown(paneId);
      return;
    }
    const snap = this.deps.snapshot();
    // WATCHABLE: present in the Toolhelp map (liveness authority), readable as `ssh`, AND a NON-ZERO creation
    // time (a partial read — name "ssh" but time 0 — is a LIVE process whose time read failed; it gives no
    // reliable pid-reuse baseline, so it is NOT watchable).
    if (snap.parentMap.has(sshPid)) {
      const id = snap.identify(sshPid);
      if (id.name === SSH_PROGRAM && id.startTimeMs !== 0) { pane.session = { pid: sshPid, startedAt: id.startTimeMs }; return; }
    }
    // No reliable watch (gone/bad, non-ssh, unreadable, or ssh-with-0-time). Drop the slot; if a frame was
    // already pushed, sink it rather than strand an unwatched isRemote:true. Still-local ⇒ just clear.
    pane.session = null;
    if (this.deps.tracker.remoteDepth(paneId) > 0) this.deps.tracker.markUnknown(paneId);
  }

  /**
   * One poll tick: snapshot once, then for each watched pane check its registered session ssh. Cheap:
   * one Toolhelp snapshot + a bounded per-pane identity read.
   *
   * `exempt` (L3-4 §0-CORR.2 — the fire-AFTER-delivery correction): when the driver drives this tick from
   * `onDispatch` for a command that ITSELF opens an interactive ssh, that ssh child is ALREADY in the tree
   * (the S-A hook fires post-delivery), so the W-2b unregistered-ssh scan would mis-flag the assistant's OWN
   * just-dispatched login as a lurking USER ssh and `markUnknown` the pane. `exempt = { paneId, host }`
   * SURGICALLY removes ONLY the `host`-matching interactive descendant of `exempt.paneId` from the W-2b scan —
   * every OTHER unregistered interactive ssh (a real user `ssh host-evil` on the same shared pane), and every
   * other pane, is scanned in full. Omit `exempt` (a `sudo`/non-ssh dispatch, or the periodic timer) ⇒ the
   * full scan runs everywhere. The exempt NEVER touches the wrong-target pop/markUnknown core.
   */
  tick(exempt?: { paneId: string; host: string }): void {
    if (this.panes.size === 0) return;
    const snap = this.deps.snapshot();
    // A degenerate (empty) snapshot means the native call FAILED, not that every process died — skip the
    // tick rather than markUnknown + unwatch every pane on a transient glitch (Opus R1 P3-A).
    if (snap.parentMap.size === 0) return;
    // Built lazily ONCE per tick, shared across panes, only if a local pane needs the W-2b subtree scan.
    let childrenByParent: Map<number, number[]> | null = null;
    for (const [paneId, pane] of this.panes) {
      // (a) Shell gone ⇒ the pane is unobservable ⇒ fail-safe to UNKNOWN and stop watching it. A live
      //     process always appears as a KEY in the Toolhelp map, so absence = dead.
      if (!snap.parentMap.has(pane.shellPid)) {
        this.deps.tracker.markUnknown(paneId);
        this.panes.delete(paneId);
        continue;
      }
      // No interactive ssh registered. Normally nothing to pop — but a pane that holds a remote frame with
      // NO live watch (a non-atomic push↔register window, or a registration that could not confirm a live
      // ssh) is unsafe: a later LOCAL command would derive-remote against a stale isRemote:true. Sink it to
      // markUnknown as a systemic backstop (never a stray fire in normal flow — remoteDepth tracks the
      // stack in lockstep with session, so this is >0 only in that genuine unwatched-frame state).
      if (pane.session === null) {
        // A remote frame with NO live watch (a non-atomic push↔register window, or a registration that
        // could not confirm a live ssh) — the existing systemic backstop (see block comment above).
        if (this.deps.tracker.remoteDepth(paneId) > 0) { this.deps.tracker.markUnknown(paneId); continue; }
        // W-2b: a LOCAL-anchored pane (depth 0) whose shell subtree holds an UNREGISTERED interactive ssh —
        // the user hand-ssh'd out of a shared L3-launched pane. The tracker is confidently local, so a later
        // assistant `sudo` would fill a LOCAL secret into the REMOTE prompt. Sink on doubt (decline, never
        // disclose). Gated on depth 0: a legit assistant-dispatched ssh has pushed a frame (depth>0) and is
        // handled above, so this scan never fights the normal push→register flow (Opus L3-4 R2 Q1 / R3 Q1a).
        childrenByParent ??= buildChildrenMap(snap.parentMap);
        // §0-CORR.2: exempt the assistant's OWN just-dispatched login (host-matched) for THIS pane only.
        const exemptHost = exempt?.paneId === paneId ? exempt.host : undefined;
        if (this.hasUnregisteredInteractiveSsh(snap, childrenByParent, pane.shellPid, exemptHost)) this.deps.tracker.markUnknown(paneId);
        continue;
      }
      // Liveness is authoritative from the Toolhelp map (a pid present as a KEY is alive); identify() reads
      // "" for a gone-OR-unreadable pid, and `startTimeMs === 0` for a LIVE ssh whose creation-time read
      // failed (win32 reads name/time independently). Compute both here — the depth guard below needs
      // liveness too.
      const alive = snap.parentMap.has(pane.session.pid);
      const id = snap.identify(pane.session.pid);
      const depth = this.deps.tracker.remoteDepth(paneId);
      // (b) A session-bearing pane is observable/trustable ONLY at EXACTLY depth 1 (the structural axis).
      //     Otherwise the trusted region is declined:
      //       - depth ≥ 2 (NESTED): the inner login runs on the remote host and is unobservable ⇒ sink.
      //       - depth 0 with a LIVE registered ssh: the tracker reports LOCAL while the ssh is still alive — a
      //         contradiction (a re-anchor that didn't reset the watch); trusting local would derive a LOCAL
      //         binding for a live remote ⇒ sink (R5).
      //       - depth 0 with a GONE pid: a benign re-anchor race (the ssh exited and the tracker re-anchored
      //         local before this tick cleared the slot). The local anchor is LEGITIMATE, so just DROP the
      //         stale watch — do NOT markUnknown a correct local pane.
      if (depth !== 1) {
        if (depth >= 2 || alive) this.deps.tracker.markUnknown(paneId);
        pane.session = null;
        continue;
      }
      // At EXACTLY depth 1. The ONE trusted state: alive, readable `ssh`, and a NON-ZERO creation time
      // matching the registered (non-zero) baseline.
      if (alive && id.name === SSH_PROGRAM && id.startTimeMs !== 0 && id.startTimeMs === pane.session.startedAt) continue;
      // (c) Live but UNCONFIRMABLE as the SAME ssh: the whole identity read failed (name ""), OR only the
      //     creation-time read failed (name "ssh" but `startTimeMs === 0`). DOUBT, not a confirmed exit — a
      //     pop here would relabel a still-REMOTE pane local → a LOCAL secret into a REMOTE prompt (the
      //     inverse wrong-target). Fail-safe to markUnknown (R2 + R4).
      if (alive && (id.name === "" || (id.name === SSH_PROGRAM && id.startTimeMs === 0))) {
        this.deps.tracker.markUnknown(paneId); pane.session = null; continue;
      }
      // (d) CONFIRMED exit: pid gone, reused by a readable non-ssh, or reused by a DIFFERENT ssh (a non-zero
      //     creation time that does not match). `depth` is provably 1 here — the `!== 1` guard above already
      //     declined depth 0 and depth ≥ 2 — so this is always a single-frame pop to local (SP-L3-OQ-7: the
      //     nested case that would have needed markUnknown is handled by that guard, never reached here).
      this.deps.tracker.noteSessionEnd(paneId);
      pane.session = null; // consumed — do not re-fire until a new session is registered
    }
  }

  /**
   * W-2b: does the shell's process SUBTREE hold an UNREGISTERED ssh that would make a LOCAL-anchored pane
   * actually remote — a user hand-`ssh host` the wiring never dispatched? Walk the `parentMap` subtree from
   * `shellPid` and, for each LIVE `ssh`-named DESCENDANT (subtree, not just direct — a `sudo ssh`/wrapper/
   * tmux-reparented login is a grandchild), classify its argv with `interactiveSshTarget` (the SAME rule that
   * decides whether an ssh opens a session). Returns true (⇒ caller `markUnknown`s, decline-not-disclose) iff
   * any LIVE descendant is itself UNREADABLE (identify() name "" — an elevated/cross-user process we cannot
   * even name, e.g. the ssh in `sudo ssh`; Codex PR#512 P1), OR is an interactive in-bound `ssh` login, OR is
   * an `ssh` whose argv is UNREADABLE (`commandLine` null — an elevated/cross-user ssh we cannot introspect:
   * fail-safe to "possibly interactive"). A tunnel (`-N`/`-f`/
   * `-L`), a one-shot (`ssh host cmd`), or scp/sftp/git-over-ssh (whose inner ssh carries a trailing remote
   * command) all classify null ⇒ NOT flagged, so those panes keep autofilling (OQ-W-7 = option B). Short-
   * circuits on the first interactive/unreadable ssh, so the common no-ssh subtree is one adjacency walk.
   *
   * `exemptHost` (§0-CORR.2): when the driver dispatched an interactive `ssh <exemptHost>` for THIS pane, that
   * login is the assistant's OWN (already in the tree post-delivery), so an interactive descendant whose argv
   * host === `exemptHost` is NOT flagged. This is SURGICAL: any OTHER interactive ssh descendant (a real user
   * `ssh host-evil` to a different host) STILL flags, and an UNREADABLE descendant (name "" / argv null) STILL
   * flags regardless (can't confirm it is the exempt one — fail-safe). Omit `exemptHost` ⇒ every interactive
   * ssh flags (the pre-correction behavior, used for a non-ssh dispatch and the periodic timer).
   */
  private hasUnregisteredInteractiveSsh(
    snap: ProcessSnapshot,
    children: Map<number, number[]>,
    shellPid: number,
    exemptHost?: string,
  ): boolean {
    // BFS the subtree over the pre-built parent→children map (Opus PR#512 P3: built once per tick, not per
    // pane). `seen` guards against pid-reuse apparent cycles (a child listing an ancestor pid).
    const seen = new Set<number>([shellPid]);
    const frontier: number[] = [shellPid];
    while (frontier.length > 0) {
      const parent = frontier.pop() as number;
      for (const pid of children.get(parent) ?? []) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        frontier.push(pid);
        // Every pid reached here is a KEY in `parentMap` (it came from
        // buildChildrenMap, which inverts parentMap) ⇒ ALIVE per the module's
        // liveness contract. So identify()'s "" here is NOT a gone pid — it is a
        // LIVE-but-UNREADABLE descendant (win32 OpenProcess denied on an elevated
        // / cross-user process, e.g. `sudo ssh user@host` where the ssh itself
        // runs as another identity). Fail CLOSED: such a descendant could be an
        // in-bound ssh login, and the name gate must NOT pre-empt the argv
        // fail-safe below (Codex PR#512 P1 — otherwise a `sudo ssh` leaves the
        // depth-0 pane trusted-local and a later fill discloses to the remote).
        // A READABLE non-ssh descendant genuinely cannot be an in-bound login ⇒ skip.
        const descName = snap.identify(pid).name;
        if (descName === "") return true; // unreadable LIVE descendant ⇒ possibly interactive ssh (decline)
        if (descName !== SSH_PROGRAM) continue; // readable non-ssh ⇒ not an in-bound login
        // Fail-safe on ANY non-classifiable ssh: unreadable (null) OR an EMPTY argv — an ssh we cannot
        // classify must sink the pane, never trust-local (Opus PR#512 P2: `interactiveSshTarget([])` returns
        // null, which without this guard would fall through to "not flagged" = trust local, the opposite of
        // the module's "any doubt sinks" invariant).
        const argv = snap.commandLine(pid);
        if (argv === null || argv.length === 0) return true; // unreadable / empty ⇒ fail-safe (possibly interactive)
        const host = interactiveSshTarget(argv.slice(1));
        // an interactive in-bound login — flagged UNLESS it is the assistant's own host-matched dispatch
        // (§0-CORR.2 surgical exempt); a DIFFERENT host (a lurking user ssh) still flags.
        if (host !== null && host !== exemptHost) return true;
      }
    }
    return false;
  }
}

/** Invert a pid→parent map into parent→children. Built ONCE per `tick` and reused across the tick's panes
 *  (Opus PR#512 P3 — the W-2b subtree scan would otherwise rebuild it per local pane). */
function buildChildrenMap(parentMap: Map<number, number>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, parentPid] of parentMap) {
    const arr = children.get(parentPid);
    if (arr === undefined) children.set(parentPid, [pid]);
    else arr.push(pid);
  }
  return children;
}
