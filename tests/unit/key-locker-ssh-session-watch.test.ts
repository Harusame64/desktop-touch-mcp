// key-locker-ssh-session-watch.test.ts — ADR-014 R3 L3-3 PR3 (SP-L3-OQ-7, the ssh session-end watch).
// Pins the depth pivot (≤1 pop / ≥2 markUnknown), shell-gone markUnknown, new-ssh-is-not-an-exit,
// pid-reuse-is-an-exit, grandchild ssh discovery, and the seed-on-register (no false exit). Pure
// reconciliation over a fake process snapshot + a fake tracker sink.
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
  noteSessionEnd(paneId: string): void { this.ends.push(paneId); }
  markUnknown(paneId: string): void { this.unknowns.push(paneId); }
  remoteDepth(paneId: string): number { return this.depth.get(paneId) ?? 0; }
}

/** Build a watch whose snapshot reads a MUTABLE `procs` ref (so a test can change the tree between ticks). */
function setup(initial: Record<number, Proc>): { watch: SshSessionWatch; sink: FakeSink; set: (p: Record<number, Proc>) => void } {
  let procs = initial;
  const sink = new FakeSink();
  const deps: SshWatchDeps = { snapshot: () => snapshotOf(procs), tracker: sink };
  return { watch: new SshSessionWatch(deps), sink, set: (p) => { procs = p; } };
}

// A shell (1000) with a direct ssh child (2000). 500 is the shell's parent (terminal host).
const SHELL_WITH_SSH: Record<number, Proc> = {
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
  2000: { parent: 1000, name: "ssh", start: 20 },
};
const SHELL_ONLY: Record<number, Proc> = {
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
};

describe("SshSessionWatch — the depth pivot on an ssh exit (SP-L3-OQ-7)", () => {
  it("depth ≤ 1: the outermost ssh exits ⇒ noteSessionEnd (pop one frame)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    set(SHELL_ONLY); // the ssh process exited
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
    expect(sink.unknowns).toEqual([]);
  });

  it("depth ≥ 2 (nested ssh): the visible outer ssh exits ⇒ markUnknown (never strand an inner frame)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH); // only the OUTER ssh is locally visible
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 2); // tracker holds two remote frames (ssh a → ssh b)
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(sink.ends).toEqual([]);
  });

  it("no ssh exited ⇒ no signal", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    watch.tick(); // same tree
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });
});

describe("SshSessionWatch — unwatchable / lifecycle", () => {
  it("the shell pid vanishing ⇒ markUnknown + stops watching (fail-safe)", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    set({ 500: { parent: 0, name: "windowsterminal", start: 1 } }); // shell 1000 gone
    watch.tick();
    expect(sink.unknowns).toEqual(["pane-1"]);
    expect(watch.isWatching("pane-1")).toBe(false);
  });

  it("unwatchPane stops all further signalling for that pane", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    watch.unwatchPane("pane-1");
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });

  it("tick with no watched panes is a no-op", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });
});

describe("SshSessionWatch — reconciliation edge cases", () => {
  it("seeds from an ALREADY-open ssh ⇒ the first tick does not mistake it for an exit", () => {
    const { watch, sink } = setup(SHELL_WITH_SSH); // ssh already present at registration
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    watch.tick(); // ssh still there — nothing changed
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
  });

  it("a NEW ssh appearing is a session OPENING, not an exit (no signal)", () => {
    const { watch, sink, set } = setup(SHELL_ONLY); // no ssh at register
    watch.watchPane("pane-1", 1000);
    set(SHELL_WITH_SSH); // ssh 2000 now opened
    sink.setDepth("pane-1", 1);
    watch.tick();
    expect(sink.ends).toEqual([]);
    expect(sink.unknowns).toEqual([]);
    // …and its LATER exit does fire.
    set(SHELL_ONLY);
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
  });

  it("pid REUSE (same pid, different creation time) counts as an exit", () => {
    const { watch, sink, set } = setup(SHELL_WITH_SSH);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    // pid 2000 is now a DIFFERENT process (creation time changed) — the watched ssh really exited.
    set({ ...SHELL_ONLY, 2000: { parent: 1000, name: "ssh", start: 999 } });
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
  });

  it("discovers an ssh that is a GRANDCHILD of the shell (conhost in between)", () => {
    const nested: Record<number, Proc> = {
      1000: { parent: 500, name: "powershell", start: 10 },
      1500: { parent: 1000, name: "conhost", start: 15 },
      2000: { parent: 1500, name: "ssh", start: 20 },
    };
    const { watch, sink, set } = setup(nested);
    watch.watchPane("pane-1", 1000);
    sink.setDepth("pane-1", 1);
    set({ 1000: { parent: 500, name: "powershell", start: 10 }, 1500: { parent: 1000, name: "conhost", start: 15 } }); // ssh gone
    watch.tick();
    expect(sink.ends).toEqual(["pane-1"]);
  });
});
