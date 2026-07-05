// ADR-014 v2 R3 Key Locker — L3 §3 / §6: the ssh session-end watch (SP-L3-OQ-7).
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-3-manager-watch-plan.md (PR 3) +
//   adr-014-v2-r3-l3-capture-plan.md §3 (the ssh-out pop signal).
//
// WHY: an interactive `ssh user@host` runs under Mode B (a pane read), NOT an exit-mode watch — so the
// SessionTracker frame it pushed has no exit code to pop on. If it is never popped, a later LOCAL command
// in that pane derives `sudo://<remotehost>` and, on a MATCH, would autofill the REMOTE secret into a
// LOCAL prompt — a wrong-target fill. The authoritative session-end signal is therefore the pane's `ssh`
// CHILD PROCESS exiting, observed via the process tree (a process observation, never a screen-scrape).
//
// This module is PURE reconciliation logic over an injected process snapshot — no Win32 import — so it
// unit-tests with a fake tree. The KeyLockerManager (the assembly) owns the live instance: it snapshots
// via win32 `buildProcessParentMap()` + `getProcessIdentityByPid()`, registers a pane's shell pid on
// anchor, and drives `tick()` on a timer. That live wiring lands with the terminal-event subscription.
//
// FAIL-SAFE (§3, Opus R2 P2): any doubt sinks the pane to `markUnknown` (decline-to-derive), NEVER a
// stale trusted `isRemote:true`. Two doubt sources: (a) an unwatchable pane (its shell pid vanished from
// the snapshot) and (b) NESTED ssh — the local tree shows only the OUTERMOST ssh (an inner `ssh b` runs
// ON host-a, invisible locally), so when the outer ssh exits while the tracker still holds ≥ 2 remote
// frames, a single pop would strand the inner frame → markUnknown instead (SP-L3-OQ-7 depth rule).

/** The tracker surface the watch drives (a subset of `SessionTracker`, so tests inject a fake). */
export interface SessionTrackerSink {
  /** Pop one remote frame — the observed outermost ssh child exited and the pane maps 1:1 (depth ≤ 1). */
  noteSessionEnd(paneId: string): void;
  /** Sink the pane to UNKNOWN — an unconfirmable / unobservable session-end (depth ≥ 2, shell gone). */
  markUnknown(paneId: string): void;
  /** Remote-frame depth above the base local shell (0 = local/unknown) — the pop-vs-markUnknown pivot. */
  remoteDepth(paneId: string): number;
}

/** One process's identity in a snapshot (from win32 `getProcessIdentityByPid`). */
export interface ProcessIdentity {
  /** Image name, lowercased, `.exe` stripped (e.g. "ssh", "powershell"). "" when unknown/gone. */
  name: string;
  /** Creation time (ms since the Windows epoch); 0 on failure. Distinguishes a REUSED pid from the same. */
  startTimeMs: number;
}

/** A live process-tree snapshot the watch reconciles against (injected so it unit-tests with a fake). */
export interface ProcessSnapshot {
  /** pid → parentPid for every live process (Toolhelp32). A pid present as a KEY means it is alive. */
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

/** A registered pane: the shell pid to root the descendant search + the ssh children currently watched. */
interface WatchedPane {
  shellPid: number;
  /** pid → creation-time of every `ssh` descendant seen last tick (identity guards pid reuse). */
  ssh: Map<number, number>;
}

const SSH_PROGRAM = "ssh";

/**
 * Watches registered panes for their `ssh` child processes exiting, driving the SessionTracker's
 * pop / markUnknown. Pure reconciliation: `tick()` snapshots the tree and diffs each pane's ssh
 * descendants against the previous tick. Register a pane with `watchPane` when its session is anchored
 * on a known shell pid; `unwatchPane` when the window closes.
 */
export class SshSessionWatch {
  private readonly panes = new Map<string, WatchedPane>();

  constructor(private readonly deps: SshWatchDeps) {}

  /**
   * Start watching `paneId`, rooted at its shell pid (`getWindowProcessId(hwnd)` — the window-owning
   * pid, value-consistent with L2's re-verify). Seeds the watched-ssh set from a snapshot NOW, so a
   * `tick` does not mistake an ALREADY-open ssh (present at registration) for a fresh exit later. Re-
   * registering a pane resets it.
   */
  watchPane(paneId: string, shellPid: number): void {
    const snap = this.deps.snapshot();
    this.panes.set(paneId, { shellPid, ssh: this.sshDescendants(snap, shellPid) });
  }

  /** Stop watching a pane (its window closed / the tracker forgot it). Idempotent. */
  unwatchPane(paneId: string): void {
    this.panes.delete(paneId);
  }

  /** Is this pane currently watched? (Lets the assembly avoid double-registration.) */
  isWatching(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /**
   * One poll tick: snapshot once, then for each watched pane reconcile its `ssh` descendants against the
   * previous tick and drive the tracker. Cheap: one Toolhelp snapshot + a bounded per-pane walk.
   */
  tick(): void {
    if (this.panes.size === 0) return;
    const snap = this.deps.snapshot();
    for (const [paneId, pane] of this.panes) {
      // (a) Shell gone ⇒ the pane is unobservable ⇒ fail-safe to UNKNOWN and stop watching it. A live
      //     process always appears as a KEY in the Toolhelp map, so absence = dead.
      if (!snap.parentMap.has(pane.shellPid)) {
        this.deps.tracker.markUnknown(paneId);
        this.panes.delete(paneId);
        continue;
      }
      const current = this.sshDescendants(snap, pane.shellPid);
      // A previously-watched ssh whose pid is gone OR whose creation time changed (pid REUSE) has exited.
      let anyExited = false;
      for (const [pid, startedAt] of pane.ssh) {
        if (current.get(pid) !== startedAt) { anyExited = true; break; }
      }
      if (anyExited) {
        // (b) Depth pivot (SP-L3-OQ-7): the local tree only ever shows the OUTERMOST ssh, so a lone pop is
        //     safe only when the tracker holds ≤ 1 remote frame. With NESTED frames (≥ 2) the watch cannot
        //     tell which ended → markUnknown rather than strand an inner remote frame (wrong-target guard).
        if (this.deps.tracker.remoteDepth(paneId) <= 1) this.deps.tracker.noteSessionEnd(paneId);
        else this.deps.tracker.markUnknown(paneId);
      }
      pane.ssh = current; // adopt the new set (new ssh added, exited ssh dropped)
    }
  }

  /** Every `ssh`-named process descended from `rootPid` (walk the parent map), pid → creation time. */
  private sshDescendants(snap: ProcessSnapshot, rootPid: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const pid of descendantsOf(snap.parentMap, rootPid)) {
      const id = snap.identify(pid);
      if (id.name === SSH_PROGRAM) out.set(pid, id.startTimeMs);
    }
    return out;
  }
}

/**
 * All descendant pids of `rootPid` in a pid→parentPid map (excludes `rootPid` itself). Iterative BFS
 * with a visited guard so a cyclic/self-parented snapshot (pid reuse mid-enumeration) cannot loop.
 */
function descendantsOf(parentMap: Map<number, number>, rootPid: number): number[] {
  // Invert once to children lists so the walk is O(n) not O(n·depth).
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parentMap) {
    if (pid === parent) continue; // a self-parented root (System/Idle) is not its own child
    (children.get(parent) ?? children.set(parent, []).get(parent)!).push(pid);
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = children.get(pid);
    if (kids !== undefined) queue.push(...kids);
  }
  return out;
}
