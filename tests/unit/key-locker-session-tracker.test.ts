// ADR-014 v2 R3 L3 — SessionTracker (§3): the per-pane {execHost,isRemote,cwd} provider that keeps
// deriveBinding from localhost-collapsing a remote pane (or remote-collapsing a local one).
// Plan: desktop-touch-mcp-internal@<plan>:docs/adr-014-v2-r3-l3-capture-plan.md
import { describe, expect, it } from "vitest";
import { SessionTracker, isKnownSession, type PaneSession } from "../../src/engine/key-locker/session-tracker.js";

const P = "pane-1";

describe("SessionTracker — anchoring + the unknown fail-safe (§3)", () => {
  it("a never-anchored pane is UNKNOWN → caller declines to derive", () => {
    const t = new SessionTracker();
    expect(t.get(P)).toEqual({ unknown: true });
    expect(isKnownSession(t.get(P))).toBe(false);
    // recording a dispatch on an unknown pane keeps it unknown (never guesses localhost).
    t.recordDispatch(P, "sudo apt update");
    expect(t.get(P)).toEqual({ unknown: true });
  });

  it("beginLocalSession anchors a known-local pane", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false, cwd: "C:/work" });
  });

  it("markUnknown sinks a pane to UNKNOWN (unconfirmable session-end — Opus R2 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com");
    expect(isKnownSession(t.get(P))).toBe(true);
    t.markUnknown(P);
    expect(t.get(P)).toEqual({ unknown: true });
  });
});

describe("SessionTracker — ssh in/out (the wrong-target crux)", () => {
  it("interactive ssh user@host pushes a remote frame; a bare sudo then targets the REMOTE host", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ execHost: "prod.example.com", isRemote: true });
  });

  it("ssh child exit pops the frame → a later command is LOCAL again (no stale-remote wrong-target)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
    t.noteSessionEnd(P); // the manager observed the ssh child exit
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("nested ssh stacks and pops one frame at a time", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh a@host-a");
    t.recordDispatch(P, "ssh b@host-b");
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-b");
    t.noteSessionEnd(P);
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-a");
    t.noteSessionEnd(P);
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("popping the base local frame is a no-op (can't ssh-out of the local shell)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.noteSessionEnd(P);
    t.noteSessionEnd(P);
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a one-shot `ssh host cmd` does NOT open a session (no push)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh prod.example.com uptime");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("ssh query modes (-G/-Q/-V) do NOT open a session", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    for (const cmd of ["ssh -G host", "ssh -Q cipher", "ssh -V"]) t.recordDispatch(P, cmd);
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("ssh with -l user and a port still pushes the resolved host label", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -p 2222 -l deploy prod.example.com");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("a typed `exit`/`logout` does NOT speculatively pop (pop authority is the process-tree watch)", () => {
    // Opus R1 P1-2: a typed-exit pop here would double-pop a nested ssh (recordDispatch + the watch),
    // and a FAILED exit (stopped jobs) never ends the session. The frame stays until noteSessionEnd.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh a@host-a");
    t.recordDispatch(P, "exit");
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-a"); // still remote until the watch fires
    t.noteSessionEnd(P);
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });
});

describe("SessionTracker — wrong-target regressions (Opus R1 P1-1/P1-2/P2-1)", () => {
  it("env-prefixed ssh still pushes: `LC_ALL=C ssh user@host` → remote (P1-1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "LC_ALL=C ssh deploy@prod.example.com");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("`cd x && ssh host` still sees the ssh (does not stop scanning after cd) (P1-1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:/srv && ssh deploy@prod.example.com");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("nested ssh does NOT double-pop: typed exit + one watch pop leaves the OUTER remote frame (P1-2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh a@host-a");
    t.recordDispatch(P, "ssh b@host-b");
    t.recordDispatch(P, "exit");                // no speculative pop
    t.noteSessionEnd(P);                         // the ONE authoritative pop for the exited inner ssh
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-a"); // still on host-a, NOT localhost
  });

  it("`ssh -l host host` (option-arg equals the dest) is NOT misread as a one-shot (P2-1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -l host host"); // -l host, destination host, NO trailing command
    expect((t.get(P) as { execHost: string }).execHost).toBe("host");
  });
});

describe("SessionTracker — cwd tracking (best-effort, fails safe to undefined)", () => {
  it("absolute cd sets cwd; a later relative cd resolves locally", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:/srv/app");
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/srv/app");
    t.recordDispatch(P, "cd sub"); // relative → resolves against the known local cwd
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/srv/app/sub");
  });

  it("cd ~ / home leaves cwd undefined (L1 fails safe → declines cwd-dependent derivation)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd ~");
    expect((t.get(P) as { cwd?: string }).cwd).toBeUndefined();
  });

  it("cwd inside a REMOTE frame stays undefined (relative cd unresolvable locally)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "ssh deploy@prod.example.com");
    t.recordDispatch(P, "cd app");
    expect((t.get(P) as { cwd?: string }).cwd).toBeUndefined();
  });
});

describe("SessionTracker — the get() shape feeds deriveBinding's SessionContext", () => {
  it("a known session is structurally a valid SessionContext-ish (execHost/isRemote[/cwd])", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    const s: PaneSession = t.get(P);
    expect(isKnownSession(s)).toBe(true);
    if (isKnownSession(s)) {
      expect(typeof s.execHost).toBe("string");
      expect(typeof s.isRemote).toBe("boolean");
    }
  });
});
