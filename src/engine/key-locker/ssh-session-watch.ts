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
// FAIL-SAFE (§3, Opus R2 P2): any doubt sinks the pane to `markUnknown` (decline-to-derive), NEVER a
// stale trusted `isRemote:true`. Two doubt sources: (a) an unwatchable pane (its shell pid vanished) and
// (b) NESTED ssh — when the registered outer ssh exits while the tracker still holds ≥ 2 remote frames, a
// single pop would strand the invisible inner frame → markUnknown instead (SP-L3-OQ-7 depth rule).

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
  /** Image name, LOWERCASED, `.exe` stripped (e.g. "ssh", "powershell"). "" when unknown/gone. The live
   *  adapter MUST lowercase win32's `processName` (it is not lowercased at source). */
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
  /** Identity for a pid (name + creation time). A gone pid returns `{ name: "", startTimeMs: 0 }`. */
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
   * Register the OUTERMOST interactive-session ssh child pid for a pane — the wiring calls this when it
   * pushes an interactive frame, having correlated the ssh child it just spawned. The watch records that
   * pid's identity and fires only on ITS exit (never on a sibling tunnel / one-shot ssh — P2-A). A no-op
   * if the pane isn't watched; a pid that isn't a live `ssh` is ignored (a late/bad pid never seeds a
   * spurious exit — it would otherwise mismatch identity next tick and fire). Nested logins re-register
   * the same visible outer pid; the invisible inner frame is covered by the depth pivot in `tick`.
   */
  noteSshOpened(paneId: string, sshPid: number): void {
    const pane = this.panes.get(paneId);
    if (pane === undefined) return;
    const id = this.deps.snapshot().identify(sshPid);
    if (id.name !== SSH_PROGRAM) { pane.session = null; return; } // not a live ssh — ignore
    pane.session = { pid: sshPid, startedAt: id.startTimeMs };
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
      if (pane.session === null) continue; // no interactive ssh registered — nothing to pop
      // The registered session ssh has EXITED iff its pid is gone OR its creation time changed (pid reuse).
      const id = snap.identify(pane.session.pid);
      if (id.name === SSH_PROGRAM && id.startTimeMs === pane.session.startedAt) continue; // still alive
      // (b) Depth pivot (SP-L3-OQ-7): a lone pop is safe only when the tracker holds ≤ 1 remote frame; with
      //     NESTED frames (≥ 2) the invisible inner login means a single pop would strand a remote frame →
      //     markUnknown rather than relabel remote-as-local (wrong-target guard).
      if (this.deps.tracker.remoteDepth(paneId) <= 1) this.deps.tracker.noteSessionEnd(paneId);
      else this.deps.tracker.markUnknown(paneId);
      pane.session = null; // consumed — do not re-fire until a new session is registered
    }
  }
}
