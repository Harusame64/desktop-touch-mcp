// key-locker-ssh-session-watch.test.ts — ADR-014 R3 L3-3 PR3 (SP-L3-OQ-7, the ssh session-end watch).
// Pins the depth pivot (≤1 pop / ≥2 markUnknown), shell-gone markUnknown, the REGISTERED-session-pid
// contract (a sibling tunnel/one-shot ssh exiting must NOT fire — Opus R1 P2-A), pid-reuse-is-an-exit,
// bad/late-pid registration, the degenerate-snapshot skip (P3-A), the live-but-UNREADABLE session ssh
// never popping-to-local (R2 P2), an unwatchable remote frame sinking to markUnknown rather than stranding
// isRemote:true (R3 P2), the R4 fold to depth-1-only trust — nested logins (depth ≥ 2) and zero-creation-
// time partial reads decline — and the R5 depth-exactly-1 guard (depth 0 + live ssh ⇒ sink, depth 0 + gone
// ⇒ drop-keep-local). Pure reconciliation over a fake process snapshot + a fake tracker sink.
import { describe, expect, it } from "vitest";
import {
  SshSessionWatch,
  type ProcessSnapshot,
  type SessionTrackerSink,
  type SshWatchDeps,
} from "../../src/engine/key-locker/ssh-session-watch.js";

// `argv` (W-2b): the process's launch argv (as `getProcessCommandLineByPid` would return). Only the
// W-2b unregistered-ssh scan reads it, and ONLY for `ssh`-named descendants of a LOCAL-anchored pane
// (session===null AND remoteDepth===0). An ssh proc with no `argv` reads as UNREADABLE (null ⇒ fail-safe
// "possibly interactive"). Non-ssh procs are never queried, so their `argv` is irrelevant.
interface Proc { parent: number; name: string; start: number; argv?: string[] }

function snapshotOf(procs: Record<number, Proc>): ProcessSnapshot {
  const parentMap = new Map<number, number>();
  for (const [pid, p] of Object.entries(procs)) parentMap.set(Number(pid), p.parent);
  return {
    parentMap,
    identify: (pid) => {
      const p = procs[pid];
      return p !== undefined ? { name: p.name, startTimeMs: p.start } : { name: "", startTimeMs: 0 };
    },
    commandLine: (pid) => procs[pid]?.argv ?? null, // null = unreadable (fail-safe in the W-2b scan)
  };
}

class FakeSink implements SessionTrackerSink {
  ends: string[] = [];
  unknowns: string[] = [];
  private readonly depth = new Map<string, number>();
  setDepth(paneId: string, d: number): void { this.depth.set(paneId, d); }
  // Model the REAL SessionTracker's depth side-effects so multi-tick tests (and the session===null
  // backstop) see faithful `remoteDepth`: a pop removes one remote frame, markUnknown nulls the stack.
  noteSessionEnd(paneId: string): void { this.ends.push(paneId); this.depth.set(paneId, Math.max(0, (this.depth.get(paneId) ?? 0) - 1)); }
  markUnknown(paneId: string): void { this.unknowns.push(paneId); this.depth.set(paneId, 0); }
  remoteDepth(paneId: string): number { return this.depth.get(paneId) ?? 0; }
}

/** Build a watch whose snapshot reads a MUTABLE `procs` ref (so a test can change the tree between ticks). */
function setup(initial: Record<number, Proc>): { watch: SshSessionWatch; sink: FakeSink; set: (p: Record<number, Proc>) => void } {
  let procs = initial;
  const sink = new FakeSink();
  const deps: SshWatchDeps = { snapshot: () => snapshotOf(procs), tracker: sink };
  return { watch: new SshSessionWatch(deps), sink, set: (p) => { procs = p; } };
}

// A shell (1000) with a direct interactive ssh child (2000). 500 is the shell's parent (terminal host).
const SHELL_WITH_SSH: Record<number, Proc> = {
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
  2000: { parent: 1000, name: "ssh", start: 20 },
};
const SHELL_ONLY: Record<number, Proc> = {
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
};

// A snapshot where the session ssh (2000) is STILL ALIVE (present as a parentMap key) but its per-process
// identity read fails (empty name) — models win32 `getProcessIdentityByPid` returning "" on an OpenProcess
// ACCESS_DENIED against a LIVE elevated/other-user ssh. The generic `snapshotOf` helper can't express this
// (it couples parentMap presence to a readable identity), so build the snapshot by hand.
function unreadableSession(): ProcessSnapshot {
  const parentMap = new Map<number, number>([[500, 0], [1000, 500], [2000, 1000]]); // 2000 alive
  return {
    parentMap,
    identify: (pid) => {
      if (pid === 500) return { name: "windowsterminal", startTimeMs: 1 };
      if (pid === 1000) return { name: "powershell", startTimeMs: 10 };
      return { name: "", startTimeMs: 0 }; // 2000 present but UNREADABLE (and any gone pid also reads "")
    },
    commandLine: () => null, // not reached: these snapshots drive REGISTERED-session tests (W-2b scan skipped)
  };
}

// A snapshot where the session ssh (2000) is ALIVE and its NAME reads "ssh", but its creation-time read
// failed (startTimeMs 0) — models the win32 partial read (OpenProcess ok, GetProcessTimes failed; name and
// time are read INDEPENDENTLY). A real running process never has creation time 0, so 0 is a doubt sentinel.
function sshWithZeroTime(): ProcessSnapshot {
  const parentMap = new Map<number, number>([[500, 0], [1000, 500], [2000, 1000]]); // 2000 alive
  return {
    parentMap,
    identify: (pid) => {
      if (pid === 500) return { name: "windowsterminal", startTimeMs: 1 };
      if (pid === 1000) return { name: "powershell", startTimeMs: 10 };
      return { name: "ssh", startTimeMs: 0 }; // 2000: live ssh, creation-time read failed
    },
    commandLine: () => null, // not reached: this snapshot drives a REGISTERED-session test (W-2b scan skipped)
  };
}

describe("SshSessionWatch — the depth pivot on a registered session ssh exit (SP-L3-OQ-7)", () => {
  it("depth ≤ 1: the registered session ssh exits ⇒ noteSessionEnd (pop one frame)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 1);
    set(SHELL_ONLY); // the session ssh exited
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
    expect(sink.unknowns).toEqual([]);
  });

  it("depth ≥ 2 (nested ssh): the visible outer session ssh exits ⇒ markUnknown (never strand an inner frame)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH); // only the OUTER ssh is locally visible
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 2); // tracker holds two remote frames (ssh a → ssh b)
    set(SHELL_ONLY);
    watch.tick(); // the nested guard declines at depth ≥ 2 before the exit is even evaluated (R4)
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("the registered session ssh still alive ⇒ no signal", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 1);
    watch.tick(); // same tree
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });

  it("consumes the exit (does not re-fire on the next tick until a new session is registered)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 1);
    set(SHELL_ONLY);
    watch.tick();
    watch.tick(); // no new session — must not fire again
    expect(sink.ends).toEqual(["pane-1"]);
  });
});

describe("SshSessionWatch — P2-A: a NON-session ssh must never pop the frame", () => {
  it("a sibling tunnel ssh exiting while the session ssh is alive ⇒ NO signal", () => {
    // Two ssh under the shell: 2000 is the interactive session (registered); 3000 is a background
    // tunnel (`ssh -f -L …`, pushes no tracker frame). The tunnel dying must NOT pop the live frame.
    const withTunnel: Record<number, Proc> = {
      ...SHELL_WITH_SSH,
      3000: { parent: 1000, name: "ssh", start: 30 },
    };
    const { watch, sink, set } = setup(withTunnel);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // register ONLY the interactive session
    sink.setDepth("pane-1", 1);
    set(SHELL_WITH_SSH); // tunnel 3000 gone, session 2000 still alive
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
    // …and the session ssh's OWN later exit still fires.
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
  });

  it("with NO session registered (only a tunnel present), an ssh exit is ignored", () => {
    const withTunnelOnly: Record<number, Proc> = { ...SHELL_ONLY, 3000: { parent: 1000, name: "ssh", start: 30 } };
    const { watch, sink, set } = setup(withTunnelOnly);
    watch.watchPane("pane-1", 1000); // watched, but no interactive session registered
    sink.setDepth("pane-1", 0);
    set(SHELL_ONLY); // tunnel gone
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });
});

describe("SshSessionWatch — R2 P2: a live-but-UNREADABLE session ssh must not pop-to-local", () => {
  it("present in parentMap but identify() empty ⇒ markUnknown, NEVER noteSessionEnd (no pop-to-local)", () => {
    const sink = new FakeSink();
    let snap: ProcessSnapshot = snapshotOf(SHELL_WITH_SSH);
    const watch = new SshSessionWatch({ snapshot: () => snap, tracker: sink });
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // registers start=20 from the readable snapshot
    sink.setDepth("pane-1", 1); // depth ≤ 1: the OLD code would have popped-to-local here
    snap = unreadableSession(); // session ssh now alive-but-unreadable
    watch.tick();
    expect(sink.ends).toEqual([]); // NOT popped — a live remote session must never be relabelled local
    expect(sink.unknowns).toEqual(["pane-1"]); // declined to derive instead (fail-safe)
    expect(watch.isWatching("pane-1")).toBe(true); // shell alive ⇒ still watched (only the session is consumed)
  });
});

describe("SshSessionWatch — R3 P2: an unwatchable remote frame must sink, not strand isRemote:true", () => {
  it("registration-time: an unreadable pid while a frame is up (remoteDepth>0) ⇒ markUnknown, no watch", () => {
    const sink = new FakeSink();
    const watch = new SshSessionWatch({ snapshot: () => unreadableSession(), tracker: sink });
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1); // the wiring pushed the interactive frame FIRST (push-then-register contract)
    watch.noteSshOpened("pane-1", 2000); // 2000 is alive but UNREADABLE — cannot confirm a live ssh to watch
    expect(sink.unknowns).toEqual(["pane-1"]); // sink the unwatchable remote frame (stale-remote wrong-target guard)
    expect(sink.ends).toEqual([]); // NEVER a pop-to-local
    // A later tick re-derives from scratch (the module is stateless per tick). No session was registered and
    // the frame is sunk (depth 0), BUT pid 2000 is STILL a live-but-UNREADABLE descendant of the local shell,
    // so the depth-0 W-2b scan now correctly re-declines it (Codex PR#512 P1): an unreadable live ssh candidate
    // must keep the pane sunk, never drift back to trusted-local. markUnknown is the safe idempotent decline
    // and re-fires each tick the doubt persists (same steady-state as R2's unreadable-session guard).
    watch.tick();
    expect(sink.ends).toEqual([]); // NEVER a pop-to-local
    expect(sink.unknowns).toEqual(["pane-1", "pane-1"]); // registration sink + tick re-decline
    expect(watch.isWatching("pane-1")).toBe(true); // shell alive ⇒ still watched
  });

  it("registration-time: an unreadable pid on a LOCAL pane (remoteDepth 0) ⇒ no markUnknown (anchor kept)", () => {
    const sink = new FakeSink();
    const watch = new SshSessionWatch({ snapshot: () => unreadableSession(), tracker: sink });
    watch.watchPane("pane-1", 1000);
    // No frame pushed (remoteDepth 0): a speculative/early bad-or-unreadable register must NOT nuke the local anchor.
    watch.noteSshOpened("pane-1", 2000);
    expect(sink.unknowns).toEqual([]);
    expect(sink.ends).toEqual([]);
  });

  it("tick backstop: a pushed frame with NO registered session (remoteDepth>0) ⇒ markUnknown", () => {
    // The non-atomic push↔register window: the wiring pushed the interactive frame but a tick fired before
    // noteSshOpened ran. A remote frame with no live watch is unsafe ⇒ sink it rather than strand it.
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });
});

describe("SshSessionWatch — R4: fold to depth-1-only trust (nested + zero creation time decline)", () => {
  it("registration at depth ≥ 2 (nested login) ⇒ markUnknown, no session registered (even for a valid ssh)", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 2); // a second interactive frame already pushed (ssh a → ssh b)
    watch.noteSshOpened("pane-1", 2000); // 2000 is a valid live ssh, but the pane is already nested
    expect(sink.unknowns).toEqual(["pane-1"]); // decline — the inner login is unobservable, never poppable
    expect(sink.ends).toEqual([]);
    watch.tick(); // no session registered (frame sunk to depth 0) ⇒ nothing more fires
    expect(sink.ends).toEqual([]);
  });

  it("tick at depth ≥ 2 with the outer ssh still ALIVE ⇒ markUnknown (self-enforced nested guard)", () => {
    // The user exited only the INNER login (invisible locally) — the outer ssh is still alive. A depth ≥ 2
    // session-bearing pane must decline rather than keep trusting the now-wrong top frame.
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // registered at depth 0…
    sink.setDepth("pane-1", 2); // …then the tracker deepened without a re-registration
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("tick: a live registered ssh with a ZERO creation time ⇒ markUnknown, NEVER noteSessionEnd", () => {
    const sink = new FakeSink();
    let snap: ProcessSnapshot = snapshotOf(SHELL_WITH_SSH);
    const watch = new SshSessionWatch({ snapshot: () => snap, tracker: sink });
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // registers startedAt=20 from a readable snapshot
    sink.setDepth("pane-1", 1);
    snap = sshWithZeroTime(); // 2000 alive, name "ssh", but its creation-time read failed (startTimeMs 0)
    watch.tick();
    expect(sink.ends).toEqual([]); // a partial read is NOT a confirmed exit — never pop a live remote
    expect(sink.unknowns).toEqual(["pane-1"]);
  });

  it("registration: a live ssh with a ZERO creation time is not watched; an already-pushed frame is sunk", () => {
    const sink = new FakeSink();
    const watch = new SshSessionWatch({ snapshot: () => sshWithZeroTime(), tracker: sink });
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1); // frame pushed
    watch.noteSshOpened("pane-1", 2000); // 2000 present + "ssh" but startTimeMs 0 ⇒ no reliable baseline
    expect(sink.unknowns).toEqual(["pane-1"]); // sink the unwatchable frame rather than store a 0 baseline
    expect(sink.ends).toEqual([]);
  });
});

describe("SshSessionWatch — R5: trust ONLY at exactly depth 1 (decline a re-anchored live remote)", () => {
  it("depth 0 with a LIVE registered ssh ⇒ markUnknown (the tracker was re-anchored local while ssh lives)", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // registers {2000, 20}
    sink.setDepth("pane-1", 0); // the tracker re-anchored the pane to LOCAL without resetting the watch
    watch.tick(); // 2000 is still ALIVE — trusting local would derive a local binding for a live remote
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("depth 0 with a GONE pid ⇒ drop the stale watch, do NOT markUnknown (benign re-anchor race)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // registers {2000, 20}
    sink.setDepth("pane-1", 0); // re-anchored local…
    set(SHELL_ONLY); // …and the ssh already exited — the local anchor is LEGITIMATE
    watch.tick();
    expect(sink.unknowns).toEqual([]); // must NOT nuke a correct local pane
    expect(sink.ends).toEqual([]); // and no pop (the tracker is already local)
    expect(watch.isWatching("pane-1")).toBe(true); // pane still watched; only the stale session slot is dropped
  });
});

describe("SshSessionWatch — R6: re-watching a pane must not silently drop a live ssh session", () => {
  it("re-watching a pane that holds a LIVE ssh session ⇒ markUnknown before resetting (never trust-local silently)", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000); // a live ssh session is registered
    watch.watchPane("pane-1", 1000); // re-anchor the same shell — must NOT silently reset to a trusted-local slot
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(watch.isWatching("pane-1")).toBe(true); // still watched (session reset to null)
  });

  it("the FIRST watchPane (no prior session) does not markUnknown", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000); // initial registration — nothing to decline
    expect(sink.unknowns).toEqual([]);
  });

  it("re-watching a pane with NO live session (session already null) does not markUnknown", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.watchPane("pane-1", 1000); // no session was registered ⇒ nothing to decline
    expect(sink.unknowns).toEqual([]);
  });
});

describe("SshSessionWatch — noteSshOpened hygiene", () => {
  it("noteSshOpened on an UNWATCHED pane is a no-op (no throw, no registration)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.noteSshOpened("ghost", 2000); // never watchPane'd
    sink.setDepth("ghost", 1);
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });

  it("registering a bad pid on a LOCAL pane (depth 0) is ignored (no exit, no spurious sink)", () => {
    // The pane's only ssh child (2000) is a background TUNNEL, so the pane is legitimately local — the W-2b
    // scan classifies it non-interactive and keeps the anchor (the disclosure guard fires only on an
    // interactive in-bound login, see the W-2b describe block below).
    const localWithTunnel: Record<number, Proc> = {
      ...SHELL_WITH_SSH,
      2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "-N", "-L", "9000:127.0.0.1:9000", "bastion"] },
    };
    const { watch, sink } = setup(localWithTunnel);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 9999); // 9999 doesn't exist / isn't ssh; pane still local (remoteDepth 0)
    watch.tick(); // nothing registered, no remote frame, only a tunnel child ⇒ nothing fires
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]); // must NOT nuke the local anchor
  });

  it("pid REUSE (same pid, different creation time) counts as an exit", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 1);
    // pid 2000 is now a DIFFERENT process (creation time changed) — the registered ssh really exited.
    set({ ...SHELL_ONLY, 2000: { parent: 1000, name: "ssh", start: 999 } });
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
  });
});

describe("SshSessionWatch — unwatchable / lifecycle", () => {
  it("the shell pid vanishing ⇒ markUnknown + stops watching (fail-safe)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    set({ 500: { parent: 0, name: "windowsterminal", start: 1 } }); // shell 1000 gone
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(watch.isWatching("pane-1")).toBe(false);
  });

  it("unwatchPane stops all further signalling for that pane", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    watch.unwatchPane("pane-1");
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });

  it("a degenerate (empty) snapshot skips the tick — does NOT markUnknown every pane (P3-A)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    set({}); // native snapshot failure ⇒ empty map
    watch.tick();
    expect(sink.unknowns).toEqual([]);
    expect(watch.isWatching("pane-1")).toBe(true); // still watched — a transient glitch is not a death
  });

  it("tick with no watched panes is a no-op", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });
});

describe("SshSessionWatch — W-2b: an UNREGISTERED interactive ssh on a LOCAL pane sinks it (shared-terminal disclosure guard)", () => {
  // The user hand-`ssh host`s out of the SAME local pane the assistant launched. The wiring never
  // dispatched it (session===null, remoteDepth 0), so the tracker stays confidently local. A tick must
  // detect the unregistered ssh via its argv and markUnknown, else a later assistant `sudo` fills a LOCAL
  // secret into the REMOTE prompt (disclosure). Option B (OQ-W-7): decline ONLY an interactive in-bound
  // login — a tunnel / one-shot / scp keeps the pane local.
  const localPane = (extra: Record<number, Proc>): Record<number, Proc> => ({ ...SHELL_ONLY, ...extra });

  it("interactive DIRECT-child ssh (`ssh user@host`) ⇒ markUnknown", () => {
    const { watch, sink } = setup(localPane({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "user@host-a"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0); // local anchor, no session registered
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("interactive GRANDCHILD ssh (`sudo ssh user@host`) ⇒ markUnknown (subtree walk, not just direct children)", () => {
    const { watch, sink } = setup(localPane({
      2500: { parent: 1000, name: "sudo", start: 21 },
      2600: { parent: 2500, name: "ssh", start: 22, argv: ["ssh", "user@host-a"] },
    }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
  });

  it("a background TUNNEL (`ssh -N -L …`) ⇒ NOT flagged (pane keeps autofilling — option B)", () => {
    const { watch, sink } = setup(localPane({ 3000: { parent: 1000, name: "ssh", start: 30, argv: ["ssh", "-N", "-L", "9000:127.0.0.1:9000", "bastion"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual([]);
  });

  it("a ONE-SHOT (`ssh host cmd`) ⇒ NOT flagged", () => {
    const { watch, sink } = setup(localPane({ 3100: { parent: 1000, name: "ssh", start: 31, argv: ["ssh", "host-a", "uptime"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual([]);
  });

  it("scp's inner ssh (one-shot with a remote command) ⇒ NOT flagged", () => {
    const { watch, sink } = setup(localPane({
      3200: { parent: 1000, name: "scp", start: 32 },
      3201: { parent: 3200, name: "ssh", start: 33, argv: ["ssh", "-x", "host-a", "scp", "-t", "/tmp/f"] },
    }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual([]);
  });

  it("an ssh child with an UNREADABLE argv (null) ⇒ markUnknown (fail-safe: possibly interactive)", () => {
    // `commandLine` returns null (ACCESS_DENIED on an elevated/cross-user ssh) — the scan cannot classify it,
    // so it fails safe to decline rather than risk trusting local.
    const { watch, sink } = setup(localPane({ 4000: { parent: 1000, name: "ssh", start: 40 /* no argv ⇒ null */ } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
  });

  it("an ssh child with an EMPTY argv ([]) ⇒ markUnknown (fail-safe — a non-classifiable ssh must not trust-local)", () => {
    // Opus PR#512 P2: interactiveSshTarget([]) returns null; without the length===0 guard that would fall
    // through to "not flagged" = trust local (fail-OPEN). Treat an empty argv as unreadable.
    const { watch, sink } = setup(localPane({ 4100: { parent: 1000, name: "ssh", start: 41, argv: [] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
  });

  it("a LIVE descendant whose NAME is UNREADABLE (`sudo ssh` with the ssh elevated) ⇒ markUnknown (Codex PR#512 P1)", () => {
    // The ssh itself runs elevated/cross-user, so win32 identify() returns name "" — and it is a KEY in
    // parentMap (= ALIVE), NOT a gone pid. The name gate must NOT skip it before the fail-safe: an unreadable
    // LIVE descendant of a LOCAL shell could be an in-bound ssh login, so decline. Without the fix the pane
    // stayed trusted-local and a later assistant `sudo` would disclose a LOCAL secret to the REMOTE prompt.
    const { watch, sink } = setup(localPane({
      2500: { parent: 1000, name: "sudo", start: 21 },
      2600: { parent: 2500, name: "", start: 22 }, // the elevated ssh — unreadable name (and argv)
    }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("a LIVE DIRECT-child with an UNREADABLE name ⇒ markUnknown (any unreadable live descendant fails closed)", () => {
    // A readable non-ssh child is skipped (see the plain-local-pane case below); only an UNREADABLE live
    // child fails closed — we cannot rule out that it is an in-bound ssh.
    const { watch, sink } = setup(localPane({ 2700: { parent: 1000, name: "", start: 23 } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
  });

  it("option-bearing interactive logins (`ssh -p 2222 user@host`, `ssh -t user@host`) ⇒ markUnknown", () => {
    // Lock the classifier over option-bearing interactive forms (Opus PR#512 P3 coverage) — a future
    // regression that mis-parsed `-p`/`-t` as a one-shot would silently re-open the disclosure.
    for (const argv of [["ssh", "-p", "2222", "user@host-a"], ["ssh", "-t", "user@host-a"]]) {
      const { watch, sink } = setup(localPane({ 4200: { parent: 1000, name: "ssh", start: 42, argv } }));
      watch.watchPane("pane-1", 1000);
      sink.setDepth("pane-1", 0);
      watch.tick();
      expect(sink.unknowns).toEqual(["pane-1"]);
    }
  });

  it("only NON-ssh children ⇒ no scan effect (a plain local pane keeps its anchor)", () => {
    const { watch, sink } = setup(localPane({
      5000: { parent: 1000, name: "node", start: 50 },
      5001: { parent: 5000, name: "esbuild", start: 51 },
    }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick();
    expect(sink.unknowns).toEqual([]);
  });

  it("gating: an interactive ssh at depth>0 (a legit DISPATCHED login mid-registration) is handled by the unwatched-frame backstop, not this scan — still markUnknown once", () => {
    // recordDispatch pushed the frame (depth 1) but the poller has not registered the pid yet (session null).
    // The existing depth>0 backstop sinks it; the W-2b scan is depth-0-only, so it never runs here. Either
    // way the pane declines (bounded-safe), and it does so via ONE markUnknown, not a double-fire.
    const { watch, sink } = setup(localPane({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "user@host-a"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1); // frame pushed, no session registered
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("a REGISTERED session (session!==null) is NOT re-scanned even with other ssh children present", () => {
    // Once a session ssh is registered the depth-1 trust logic owns the pane; the W-2b scan (session===null
    // only) must not run and mistake a sibling for an unregistered login.
    const { watch, sink } = setup(localPane({
      2000: { parent: 1000, name: "ssh", start: 20 },                                             // the registered session
      3000: { parent: 1000, name: "ssh", start: 30, argv: ["ssh", "user@other"] },                 // a sibling that WOULD trip the scan
    }));
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 2000);
    sink.setDepth("pane-1", 1);
    watch.tick();
    expect(sink.unknowns).toEqual([]); // trusted depth-1 session; the sibling never triggers the scan
    expect(sink.ends).toEqual([]);
  });
});

describe("SshSessionWatch — W-2b SURGICAL exempt (§0-CORR.2, the fire-after-delivery correction)", () => {
  // With the S-A hook firing AFTER delivery, an `ssh host-a` the ASSISTANT dispatched is already in the tree
  // when onDispatch drives the tick. `tick({ paneId, host })` exempts ONLY the host-matching interactive
  // descendant of that pane, so the assistant's own login is not mis-flagged — while a DIFFERENT-host user ssh,
  // an unreadable ssh, and every other pane still flag.
  const localPane = (extra: Record<number, Proc>): Record<number, Proc> => ({ ...SHELL_ONLY, ...extra });

  it("the assistant's OWN host-matched ssh is NOT flagged when exempt names that host", () => {
    const { watch, sink } = setup(localPane({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick({ paneId: "pane-1", host: "host-a" }); // the assistant just dispatched `ssh …@host-a`
    expect(sink.unknowns).toEqual([]); // exempt → not sunk → the assistant's own login can be armed/filled
  });

  it("a DIFFERENT-host ssh STILL flags even under an exempt (a lurking user ssh)", () => {
    const { watch, sink } = setup(localPane({ 2100: { parent: 1000, name: "ssh", start: 21, argv: ["ssh", "user@host-evil"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick({ paneId: "pane-1", host: "host-a" }); // assistant dispatched host-a, but the tree has host-evil
    expect(sink.unknowns).toEqual(["pane-1"]); // surgical: host-evil ≠ host-a ⇒ still sunk (no disclosure)
  });

  it("exempt host-a + a lurking user ssh to host-evil ⇒ STILL flags (the OTHER login trips it)", () => {
    const { watch, sink } = setup(localPane({
      2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] },       // assistant's own
      2100: { parent: 1000, name: "ssh", start: 21, argv: ["ssh", "user@host-evil"] },      // user's, unregistered
    }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick({ paneId: "pane-1", host: "host-a" });
    expect(sink.unknowns).toEqual(["pane-1"]); // host-a exempt, but host-evil still flags
  });

  it("an UNREADABLE ssh descendant STILL flags even under an exempt (can't confirm it is the exempt one)", () => {
    const { watch, sink } = setup(localPane({ 4000: { parent: 1000, name: "ssh", start: 40 /* argv null */ } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick({ paneId: "pane-1", host: "host-a" });
    expect(sink.unknowns).toEqual(["pane-1"]); // fail-safe: unreadable ⇒ flag regardless of exempt
  });

  it("the exempt applies ONLY to its named pane — another pane's ssh still flags in the same tick", () => {
    const procs: Record<number, Proc> = {
      500: { parent: 0, name: "windowsterminal", start: 1 },
      1000: { parent: 500, name: "powershell", start: 10 },
      1100: { parent: 500, name: "powershell", start: 11 },
      2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] },  // pane-1's (exempt)
      2100: { parent: 1100, name: "ssh", start: 21, argv: ["ssh", "user@host-a"] },    // pane-2's (NOT exempt)
    };
    const { watch, sink } = setup(procs);
    watch.watchPane("pane-1", 1000);
    watch.watchPane("pane-2", 1100);
    sink.setDepth("pane-1", 0);
    sink.setDepth("pane-2", 0);
    watch.tick({ paneId: "pane-1", host: "host-a" }); // exempt names pane-1 only
    expect(sink.unknowns).toEqual(["pane-2"]); // pane-1 exempt, pane-2 (same host, but not exempt) still flags
  });

  it("no exempt (a sudo/non-ssh dispatch or the periodic timer) ⇒ full scan, host-a still flags", () => {
    const { watch, sink } = setup(localPane({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] } }));
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 0);
    watch.tick(); // omitting exempt preserves the pre-correction behavior
    expect(sink.unknowns).toEqual(["pane-1"]);
  });
});
