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
// exits. Only the OUTERMOST ssh is locally visible (an inner `ssh b` runs ON host-a), so the watch tracks
// one session pid per pane and the depth pivot (below) covers nesting.
//
// This module is PURE reconciliation over an injected process snapshot — no Win32 import — so it
// unit-tests with a fake tree. The KeyLockerManager (the live wiring, deferred) owns the instance: it
// snapshots via win32 `buildProcessParentMap()` + `getProcessIdentityByPid()` (mapping `processName`
// LOWERCASED into `ProcessIdentity.name`), registers the shell pid + the session ssh pid, and drives
// `tick()` on a timer. That live wiring lands with the terminal-event subscription.
//
// FAIL-SAFE (§3, Opus/Codex R2+R3 P2): any doubt sinks the pane to `markUnknown` (decline-to-derive),
// NEVER a stale trusted `isRemote:true` and NEVER a pop-to-local on a live session. Doubt sources: (a) an
// unwatchable pane (its shell pid vanished); (b) NESTED ssh — the registered outer ssh exits while the
// tracker still holds ≥ 2 remote frames, so a single pop would strand the invisible inner frame (SP-L3-OQ-7
// depth rule); (c) a registered session ssh that is PRESENT but UNREADABLE this tick (identify() reads ""
// for a LIVE pid — R2); (d) a remote frame with NO live watch — a registration that could not confirm a
// live `ssh`, or the non-atomic push↔register window (R3: `noteSshOpened` sink + the `tick` backstop).

/** The tracker surface the watch drives (a subset of `SessionTracker`, so tests inject a fake). */
export interface SessionTrackerSink {
  /** Pop one remote frame — the registered session ssh exited and the pane maps 1:1 (depth ≤ 1). */
  noteSessionEnd(paneId: string): void;
  /** Sink the pane to UNKNOWN — an unconfirmable / unobservable session-end (depth ≥ 2, shell gone). */
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
  /** Creation time (ms since the Windows epoch); 0 on failure. Distinguishes a REUSED pid from the same. */
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
   * `remoteDepth` already reflects the push here), having correlated the ssh child it just spawned. The
   * watch records that pid's identity and fires only on ITS exit (never on a sibling tunnel / one-shot ssh
   * — P2-A). A no-op if the pane isn't watched. Four registration cases, disambiguated by Toolhelp liveness
   * (`parentMap.has`) since identify() reads "" for BOTH a gone pid AND a live-but-unreadable one:
   *   (2) present + a readable `ssh` ⇒ WATCH it (record pid + startTime).
   *   (1) pid gone/bad, (3) present but a readable NON-ssh (wrong pid), (4) present but UNREADABLE (maybe
   *       the real elevated/other-user ssh, maybe a bad pid — indistinguishable) ⇒ cannot establish a
   *       reliable watch: clear the slot, and if a remote frame was ALREADY pushed (`remoteDepth > 0`) sink
   *       it to `markUnknown` so no unwatched `isRemote:true` is stranded (the stale-remote wrong-target —
   *       a later LOCAL command would derive-remote into a REMOTE secret; Codex/Opus L3-3 PR#505 R3 P2).
   *       A speculative call on a still-LOCAL pane (`remoteDepth 0`) just clears the slot — it must NOT
   *       nuke the local anchor. Nested logins re-register the same visible outer pid; the invisible inner
   *       frame is covered by the depth pivot in `tick`.
   */
  noteSshOpened(paneId: string, sshPid: number): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined) return;
    const snap = this.deps.snapshot();
    // (2) Register ONLY a pid we can POSITIVELY confirm is a live `ssh` (present in the Toolhelp map AND a
    //     readable `ssh` identity). Toolhelp liveness gates identify()'s empty-means-gone-OR-unreadable.
    if (snap.parentMap.has(sshPid)) {
      const id = snap.identify(sshPid);
      if (id.name === SSH_PROGRAM) { pane.session = { pid: sshPid, startedAt: id.startTimeMs }; return; }
    }
    // (1)/(3)/(4) No reliable watch. Drop the slot; if a frame was already pushed, sink it rather than
    // strand an unwatched isRemote:true. On a still-local pane this is a no-op beyond clearing the slot.
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
      // Liveness is authoritative from the Toolhelp map (a pid present as a KEY is alive); identify() is a
      // secondary per-process read that returns "" for BOTH a gone pid AND a LIVE-but-UNREADABLE one
      // (OpenProcess ACCESS_DENIED on an elevated/other-user ssh). So the session ssh has CONFIRMABLY exited
      // only when its pid is gone from the map, or present as a DIFFERENT readable process (pid reuse).
      const alive = snap.parentMap.has(pane.session.pid);
      const id = snap.identify(pane.session.pid);
      if (alive && id.name === SSH_PROGRAM && id.startTimeMs === pane.session.startedAt) continue; // same ssh
      // (b) Live but UNREADABLE this tick (present + empty identity): DOUBT, not a confirmed exit. A pop here
      //     would relabel a still-REMOTE pane as local → a LOCAL secret autofilled into a REMOTE prompt (the
      //     inverse wrong-target). Fail-safe to markUnknown — never a pop-to-local on a live session, never a
      //     stale trusted isRemote:true (Codex/Opus L3-3 PR#505 R2 P2).
      if (alive && id.name === "") { this.deps.tracker.markUnknown(paneId); pane.session = null; continue; }
      // (c) CONFIRMED exit (pid gone, or reused by another process). Depth pivot (SP-L3-OQ-7): a lone pop is
      //     safe only when the tracker holds ≤ 1 remote frame; with NESTED frames (≥ 2) the invisible inner
      //     login means a single pop would strand a remote frame → markUnknown rather than relabel.
      if (this.deps.tracker.remoteDepth(paneId) <= 1) this.deps.tracker.noteSessionEnd(paneId);
      else this.deps.tracker.markUnknown(paneId);
      pane.session = null; // consumed — do not re-fire until a new session is registered
    }
  }
}
