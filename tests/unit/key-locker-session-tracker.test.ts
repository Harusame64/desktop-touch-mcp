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

  it("`cd x && ssh host` REACHES the ssh but, being conditional, sinks to UNKNOWN (Codex #495 P1)", () => {
    // The scan still does not stop at `cd` (Opus R1 P1-1). But the ssh is `&&`-guarded: if the cd
    // failed the ssh never runs, so a confident remote push would be a wrong-target. Fail safe.
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:/srv && ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ unknown: true });
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

  it("background / no-shell ssh (`-f` / `-N`) does NOT push a remote frame (#495 P2)", () => {
    // `ssh -f -N host` backgrounds a tunnel and returns THIS pane to the local prompt; pushing a
    // remote frame would mislabel a later local `sudo` as remote → wrong-target. No push for any of:
    for (const cmd of [
      "ssh -f -N deploy@prod.example.com",
      "ssh -fN deploy@prod.example.com",
      "ssh -N -L 8080:localhost:80 deploy@prod.example.com",
      "ssh -f deploy@prod.example.com",
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
    }
  });

  it("a with-arg flag VALUE containing f/N does NOT false-trigger the no-push (`-F conf` still pushes)", () => {
    // Only NO-ARG flag tokens are scanned, so `-F <file>` (config file "fN.cfg") must NOT be read as
    // a `-f`/`-N` background form — an ordinary interactive login still opens a session.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -F fN.cfg deploy@prod.example.com");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("a `&&` / `||`-conditional ssh sinks to UNKNOWN — the shell may skip it (Codex #495 P1)", () => {
    for (const cmd of [
      "false && ssh deploy@prod.example.com",       // ssh runs only if the prior succeeds
      "cd /missing && ssh deploy@prod.example.com", // cd may fail → ssh skipped
      "echo ok || ssh deploy@prod.example.com",     // ssh runs only if the prior fails
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ unknown: true });
    }
  });

  it("a `;`-sequenced ssh is UNCONDITIONAL → still pushes the remote frame (Codex #495 P1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "echo hi ; ssh deploy@prod.example.com"); // `;` always reaches the ssh
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("a conditional cd drops cwd to unknown rather than trusting a maybe-skipped directory (Codex #495 P1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "test -d x && cd C:/srv"); // cd is conditional → cwd unknown, pane stays local
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false }); // no cwd
  });

  it("clustered `-vQ cipher` is a QUERY, not an interactive login to host `cipher` (Codex #495 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -vQ cipher");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a non-session ssh does NOT stop the scan — a LATER `; ssh host` still pushes (Codex #495 P1)", () => {
    // `ssh -G prod` is a query that opens no session; the scan must continue so the following
    // interactive `ssh host-b` is recorded. Stopping at the first ssh token left the pane LOCAL while
    // the shell was actually at host-b's prompt → a later sudo/credential wrong-targets localhost.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -G prod ; ssh deploy@host-b");
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-b");
  });

  it("a one-shot ssh followed by `; cd` still applies the cd (scan continues past it — Codex #495 P1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "ssh prod uptime ; cd C:/srv/app"); // one-shot returns local, then cd runs
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/srv/app");
    expect((t.get(P) as { isRemote: boolean }).isRemote).toBe(false); // stayed local throughout
  });

  it("a BACKGROUNDED `ssh host &` opens no interactive login → pane stays local (Codex #495 P1)", () => {
    // `&` returns the shell to the LOCAL prompt immediately; a backgrounded ssh cannot grab the tty
    // for an interactive login, so pushing a remote frame would mislabel a later local command.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com &");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a backgrounded ssh does not stop the scan — `ssh a & ssh b@host-b` reaches the fg login (Codex #495 P1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh a@host-a & ssh b@host-b"); // first backgrounded, second is a fg interactive login
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-b");
  });

  it("a pipeline guarded by an earlier `&&` stays conditional → UNKNOWN, not a spurious push (Codex #495 P2)", () => {
    // `false && echo ok | ssh prod` = `false && (echo ok | ssh prod)`: the whole pipeline is skipped
    // when `false` fails, so a confident remote push would strand the pane remote. Fail safe.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "false && echo ok | ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ unknown: true });
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
