// key-locker-ssh-session-watch.test.ts — ADR-014 R3 L3-3 PR3 (SP-L3-OQ-7, the ssh session-end watch).
// Pins the depth pivot (≤1 pop / ≥2 markUnknown), shell-gone markUnknown, the REGISTERED-session-pid
// contract (a sibling tunnel/one-shot ssh exiting must NOT fire — Opus R1 P2-A), pid-reuse-is-an-exit,
// bad/late-pid registration, the degenerate-snapshot skip (P3-A), the live-but-UNREADABLE session ssh
// never popping-to-local (R2 P2), and an unwatchable remote frame sinking to markUnknown rather than
// stranding isRemote:true (R3 P2). Pure reconciliation over a fake process snapshot + a fake tracker sink.
import { describe, expect, it } from "vitest";
import {
  SshSessionWatch,
  type ProcessSnapshot,
  type SessionTrackerSink,
  type SshWatchDeps,
} from "../../src/engine/key-locker/ssh-session-watch.js";

interface Proc { parent: number; name: string; start: number }

function snapshotOf(procs: Record<number, Proc>): ProcessSnapshot {
  const parentMap = new Map<number, number>();
  for (const [pid, p] of Object.entries(procs)) parentMap.set(Number(pid), p.parent);
  return {
    parentMap,
    identify: (pid) => {
      const p = procs[pid];
      return p !== undefined ? { name: p.name, startTimeMs: p.start } : { name: "", startTimeMs: 0 };
    },
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
    watch.tick();
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
    // …no session was registered, and the frame is already sunk (depth 0), so a later tick fires nothing more.
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual(["pane-1"]);
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
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.noteSshOpened("pane-1", 9999); // 9999 doesn't exist / isn't ssh; pane still local (remoteDepth 0)
    watch.tick(); // nothing registered, no remote frame ⇒ nothing fires
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
