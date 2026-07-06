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
// STRUCTURAL AXIS (Opus/Codex PR#505 R2–R4, folded from four rounds of wrong-target edges): the watch can
// reliably observe EXACTLY ONE thing — the single depth-1 outer ssh, ALIVE, readable as `ssh`, with a
// NON-ZERO creation time matching the registered baseline. It TRUSTS only that one state; EVERY other state
// declines to `markUnknown`. So: trust depth exactly 1 (confirmed-same) → keep; depth-1 confirmed-exit →
// pop; depth 0 with a live session-slot but a remote frame up → sink; **depth ≥ 2 (nested) → ALWAYS sink**
// (the inner login runs on the remote host, its end is unobservable locally, so it can never be popped);
// any unconfirmable identity → sink. Nesting is declined at BOTH registration and `tick` so the watch
// self-enforces the invariant instead of trusting wiring discipline.
//
// This module is PURE reconciliation over an injected process snapshot — no Win32 import — so it
// unit-tests with a fake tree. The KeyLockerManager (the live wiring, deferred) owns the instance: it
// snapshots via win32 `buildProcessParentMap()` + `getProcessIdentityByPid()` (mapping `processName`
// LOWERCASED into `ProcessIdentity.name`), registers the shell pid + the session ssh pid, and drives
// `tick()` on a timer. That live wiring lands with the terminal-event subscription.
//
// FAIL-SAFE (§3, Opus/Codex R2–R4 P2): any doubt sinks the pane to `markUnknown` (decline-to-derive), NEVER
// a stale trusted `isRemote:true` and NEVER a pop-to-local on a live session. Doubt sources: (a) an
// unwatchable pane (its shell pid vanished); (b) NESTED ssh (`remoteDepth ≥ 2`) — the invisible inner login
// is unobservable, so a nested pane is declined outright (R4); (c) a registered session ssh PRESENT but
// UNREADABLE this tick — identify() reads "" for a live pid (R2) OR `startTimeMs === 0` for a live ssh whose
// creation-time read failed (win32 reads name/time independently — R4); (d) a remote frame with NO live
// watch — a registration that could not confirm a live `ssh`, or the non-atomic push↔register window (R3:
// `noteSshOpened` sink + the `tick` backstop).
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
   */
  tick(): void {
    if (this.panes.size === 0) return;
    const snap = this.deps.snapshot();
    // A degenerate (empty) snapshot means the native call FAILED, not that every process died — skip the
    // tick rather than markUnknown + unwatch every pane on a transient glitch (Opus R1 P3-A).
    if (snap.parentMap.size === 0) return;
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
        if (this.deps.tracker.remoteDepth(paneId) > 0) this.deps.tracker.markUnknown(paneId);
        continue;
      }
      // (b) NESTED (`remoteDepth ≥ 2`): a session-bearing pane should never reach here — registration
      //     declines nesting — but self-enforce the invariant rather than trust the wiring. The inner login
      //     runs on the remote host and is unobservable, so decline (R4). A missed re-registration is
      //     caught here within one poll.
      if (this.deps.tracker.remoteDepth(paneId) >= 2) { this.deps.tracker.markUnknown(paneId); pane.session = null; continue; }
      // Liveness is authoritative from the Toolhelp map (a pid present as a KEY is alive); identify() reads
      // "" for a gone-OR-unreadable pid, and `startTimeMs === 0` for a LIVE ssh whose creation-time read
      // failed (win32 reads name/time independently). The ONE trusted state: alive, readable `ssh`, and a
      // NON-ZERO creation time matching the registered (non-zero) baseline.
      const alive = snap.parentMap.has(pane.session.pid);
      const id = snap.identify(pane.session.pid);
      if (alive && id.name === SSH_PROGRAM && id.startTimeMs !== 0 && id.startTimeMs === pane.session.startedAt) continue;
      // (c) Live but UNCONFIRMABLE as the SAME ssh: the whole identity read failed (name ""), OR only the
      //     creation-time read failed (name "ssh" but `startTimeMs === 0`). DOUBT, not a confirmed exit — a
      //     pop here would relabel a still-REMOTE pane local → a LOCAL secret into a REMOTE prompt (the
      //     inverse wrong-target). Fail-safe to markUnknown (R2 + R4).
      if (alive && (id.name === "" || (id.name === SSH_PROGRAM && id.startTimeMs === 0))) {
        this.deps.tracker.markUnknown(paneId); pane.session = null; continue;
      }
      // (d) CONFIRMED exit: pid gone, reused by a readable non-ssh, or reused by a DIFFERENT ssh (a non-zero
      //     creation time that does not match). Depth is ≤ 1 here (the nested guard above already declined
      //     ≥ 2), so this pops to local; the `else markUnknown` is a defensive assertion — formally
      //     unreachable for a session-bearing pane, kept as the last line of defense (SP-L3-OQ-7 depth rule).
      if (this.deps.tracker.remoteDepth(paneId) <= 1) this.deps.tracker.noteSessionEnd(paneId);
      else this.deps.tracker.markUnknown(paneId);
      pane.session = null; // consumed — do not re-fire until a new session is registered
    }
  }
}
