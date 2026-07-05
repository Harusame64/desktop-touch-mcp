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

  it("remoteDepth counts pushed remote frames (the ssh-watch pop-vs-markUnknown pivot, SP-L3-OQ-7)", () => {
    const t = new SessionTracker();
    expect(t.remoteDepth(P)).toBe(0);           // never anchored
    t.beginLocalSession(P);
    expect(t.remoteDepth(P)).toBe(0);           // local base only
    t.recordDispatch(P, "ssh a@host-a");
    expect(t.remoteDepth(P)).toBe(1);           // one remote frame → a lone pop is safe
    t.recordDispatch(P, "ssh b@host-b");
    expect(t.remoteDepth(P)).toBe(2);           // nested → the watch must markUnknown, not pop
    t.noteSessionEnd(P);
    expect(t.remoteDepth(P)).toBe(1);
    t.markUnknown(P);
    expect(t.remoteDepth(P)).toBe(0);           // unknown pane has no trusted remote depth
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

  it("a DOWNSTREAM pipe `echo hi | ssh h` opens no interactive login → pane stays local (Opus #495 R4 P2)", () => {
    // ssh's stdin is the pipe, not the tty, so it runs non-interactively and returns the pane to the
    // LOCAL prompt. Pushing a remote frame here would wrong-target a later local `sudo` to host h.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "echo hi | ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a guarded downstream-pipe ssh also stays local (pipe stdin, whether or not the guard passes — Opus #495 R4 P2)", () => {
    // `false && echo ok | ssh prod` = `false && (echo ok | ssh prod)`: skipped when `false` fails, and
    // even if it ran the piped-stdin ssh is non-interactive — the pane is local either way.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "false && echo ok | ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("an UPSTREAM pipe `ssh h | tee log` DOES push — ssh's stdin is still the tty (Opus #495 R4 P2 asymmetry)", () => {
    // Only the DOWNSTREAM side of `|` has piped stdin; the first stage keeps the tty, so an interactive
    // login there is real and must push. Guards against the pipe fix over-broadly killing all pipes.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com | tee log");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("`ssh h 2>&1 | tee log` (explicit `2>&1 |`) pushes like the `|&` form — the redirect is not a one-shot cmd (Codex #495 P2)", () => {
    // The `2>&1` is I/O plumbing, not a remote command and not a background `&`; the upstream ssh keeps
    // the tty → an interactive login. Must behave identically to `ssh h | tee log` (push), never stay
    // local (which would wrong-target a later local sudo to the remote host).
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com 2>&1 | tee log");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("a trailing redirect alone (`ssh h > log`) is still an interactive login, but a real remote cmd is a one-shot (Codex #495 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com > session.log"); // redirect only → interactive login
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
    const u = new SessionTracker();
    u.beginLocalSession(P);
    u.recordDispatch(P, "ssh deploy@prod.example.com uptime 2>&1"); // real remote cmd + redirect → one-shot
    expect(u.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a redirect BEFORE the destination (`ssh 2>&1 h`, `ssh >log h`) is still an interactive login → pushes (Codex #495 P2)", () => {
    // parseSshCommand would otherwise read the leading `2>&1` / `>log` as the destination and the real
    // host as a one-shot remote command, stranding the pane local while an interactive login opened.
    for (const cmd of [
      "ssh 2>&1 deploy@prod.example.com",
      "ssh >session.log deploy@prod.example.com",
      "ssh > session.log deploy@prod.example.com", // space-separated target
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
    }
  });

  it("a space-separated fd-dup target (`ssh h >& log`) consumes its target, not stranded as a fake remote cmd (Opus R6 P2)", () => {
    // A lone `>&` takes the FOLLOWING token as its file; leaving `log` behind would look like a
    // one-shot remote command and wrongly keep the pane local (`sudo` then wrong-targets localhost).
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com >& out.log");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("an INPUT redirect (`ssh h < file`) feeds ssh's stdin from a non-tty → non-interactive, pane stays local", () => {
    // Only OUTPUT redirects are stripped; a stdin redirect makes ssh non-interactive (like a piped
    // stdin), so it must NOT push — pushing would wrong-target a later local sudo to the remote host.
    for (const cmd of [
      "ssh deploy@prod.example.com < script.txt",
      "ssh deploy@prod.example.com <<EOF",
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
    }
  });

  it("an explicit fd-0 OUTPUT redirect (`ssh 0>f h`) still redirects stdin → non-interactive, pane stays local (Codex #495 P2)", () => {
    // `0>file` is an output operator but its fd is 0 = stdin, so it takes ssh's stdin off the tty just
    // like `< file`. It must NOT be stripped as harmless output plumbing (that would leave a lone host
    // and mis-classify an interactive login), and it must NOT push — a later local sudo would then be
    // wrong-targeted to the remote host. Covers redirect BEFORE and AFTER the destination, and fd-dup.
    for (const cmd of [
      "ssh 0>stdin.log deploy@prod.example.com",
      "ssh deploy@prod.example.com 0>stdin.log",
      "ssh deploy@prod.example.com 0>|stdin.log",
      "ssh deploy@prod.example.com 0>&2",
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
    }
  });

  it("a NON-zero explicit fd output redirect (`ssh h 10>f`) is still stripped → interactive login pushes (fd 10 ≠ stdin)", () => {
    // The fd-0 carve-out must not regress ordinary numbered output redirects: fd 1/2/10 leave stdin on
    // the tty, so the ssh stays an interactive login and the frame must push.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com 10>build.log");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("a redirect BEFORE the program token (`>log ssh h`, `2>err ssh h`) still detects the interactive login → pushes (Codex #495 R9 P2)", () => {
    // The shell applies the redirect before exec, so `ssh` still runs with tty stdin. The segment scan
    // must skip leading redirects (not just env-assigns) to find the `ssh` program token, else it reads
    // the redirect as the program and never pushes — leaving the pane local while a remote login opened.
    for (const cmd of [
      ">session.log ssh deploy@prod.example.com",
      "2>err.log ssh deploy@prod.example.com",
      "> session.log ssh deploy@prod.example.com", // bare op + space-separated target before the program
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
    }
  });

  it("a LEADING fd-0 redirect before the program (`< in ssh h`, `0>f ssh h`) makes ssh non-interactive → pane stays local (Codex #495 R9)", () => {
    // A leading redirect that touches stdin takes ssh's stdin off the tty even though the program token
    // is `ssh`; it must NOT push.
    for (const cmd of [
      "< script.txt ssh deploy@prod.example.com",
      "0>stdin.log ssh deploy@prod.example.com",
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
    }
  });

  it("a NONZERO-fd INPUT redirect (`ssh 3<in h`, `ssh h 3<&0`) leaves stdin on the tty → interactive login pushes (Codex #495 R9 P2)", () => {
    // fd 3 (or any fd ≠ 0) input redirect does not touch stdin, so the ssh is still an interactive login.
    // The token must be stripped, not left to inflate the trailing-token count into a false one-shot.
    for (const cmd of [
      "ssh 3<input.txt deploy@prod.example.com",
      "ssh deploy@prod.example.com 3<input.txt",
      "ssh deploy@prod.example.com 3<&0",
      "ssh 3< input.txt deploy@prod.example.com", // bare op + space-separated target
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P);
      t.recordDispatch(P, cmd);
      expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
    }
  });

  it("`cd > log /srv` strips the redirect and records the real path (`/srv`), not the `>` operator (Opus #495 R8 P3)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd > log C:/srv");
    expect((t.get(P) as { cwd: string }).cwd).toBe("C:/srv");
  });

  it("a trailing `# comment` is stripped → `ssh host # note` is an interactive login → pushes (Codex #495 R9 P2)", () => {
    // The comment is removed before exec, so this is a bare `ssh host`, not `ssh host <remote-command>`;
    // it must push the remote frame, else a later remote sudo wrong-targets localhost.
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com # open a shell");
    expect((t.get(P) as { execHost: string }).execHost).toBe("prod.example.com");
  });

  it("an interactive ssh with a SEQUENTIAL trailing command sinks to UNKNOWN (post-exit trajectory unmodelable — Codex #495 R5 P1)", () => {
    for (const cmd of [
      "ssh a@host-a ; ssh b@host-b", // after host-a exits the shell logs into host-b, not the popped-to localhost
      "ssh a@host-a ; cd C:/repoB",  // after host-a exits the shell cd's — a lone pop leaves the old cwd
      "ssh a@host-a ; sudo foo",     // sudo runs locally after host-a exits — a lone pop is fine, but host-b/cd is not
    ]) {
      const t = new SessionTracker();
      t.beginLocalSession(P, "C:/work");
      t.recordDispatch(P, cmd);
      expect(t.get(P)).toEqual({ unknown: true });
    }
  });

  it("an interactive ssh piped then followed SEQUENTIALLY still sinks to unknown (`ssh h | tee ; sudo` — sudo is sequential)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh deploy@prod.example.com | tee log ; sudo foo");
    expect(t.get(P)).toEqual({ unknown: true });
  });

  it("`ssh -W host:port bastion` forwards stdio (implies -N/-T) → opens no session, pane stays local (Codex #495 R5 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -W db.internal:5432 bastion.example.com");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("clustered `-4p 2222 host-x` keeps the real destination (a login to host-x, not a stray `2222`) — Codex #495 R5 P2", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "ssh -4p 2222 host-x");
    expect((t.get(P) as { execHost: string }).execHost).toBe("host-x");
  });

  it("a `cd C:\\srv\\app` (backslash path) is tracked, not mangled to a bogus relative path (Codex #495 R5 P1)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:\\srv\\app");
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/srv/app");
  });

  it("a `cmd |& ssh h` downstream ssh opens no session (piped stdin via `|&`) → pane stays local (Codex #495 R5 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P);
    t.recordDispatch(P, "make |& ssh deploy@prod.example.com");
    expect(t.get(P)).toEqual({ execHost: "localhost", isRemote: false });
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

  it("a backgrounded `cd C:/other &` runs in a subshell → the pane cwd is UNCHANGED (Codex #495 P2)", () => {
    // The backgrounded builtin's chdir dies with its subshell; the foreground prompt stays put. Applying
    // it would let a later configured-remote `git -C C:/other` bind the wrong repo/host.
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:/other &");
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/work"); // still the pre-cd dir
  });

  it("a downstream-pipe `echo x | cd C:/other` also runs in a subshell → cwd UNCHANGED (Codex #495 P2)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "echo x | cd C:/other");
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/work");
  });

  it("a backgrounded cd does not block a later unconditional cd in the same line (scan continues)", () => {
    const t = new SessionTracker();
    t.beginLocalSession(P, "C:/work");
    t.recordDispatch(P, "cd C:/bg & cd C:/fg"); // the bg cd is a no-op; the fg cd actually moves the pane
    expect((t.get(P) as { cwd: string }).cwd.replace(/\\/g, "/")).toBe("C:/fg");
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
