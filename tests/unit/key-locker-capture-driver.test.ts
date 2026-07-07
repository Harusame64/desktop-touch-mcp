// key-locker-capture-driver.test.ts — ADR-014 R3 L3-4 W-2 REDO (the live-wiring CRUX, fire-AFTER-delivery).
//
// The driver wires the merged pure pipeline into a running loop while honoring W1/W2/W3. These tests drive
// the REAL SessionTracker + REAL SshSessionWatch against a mutable fake process tree (so the reconcile
// behavior is exercised end-to-end), faking only the capture/inject/prompt seams.
//
// ⚠ FIRE-AFTER-DELIVERY (§0-CORR): the S-A hook fires only AFTER a confirmed delivery, so the just-dispatched
// ssh child is USUALLY ALREADY in the process tree at `onDispatch` — the tests set the child in the tree
// BEFORE `onDispatch` and assert it is ARMED + CORRELATED (registered), NOT markUnknown'd. `onDispatch` is
// now SYNCHRONOUS and arms on a CHEAP pre-filter (`looksLikeCredential`); the authoritative `deriveBinding`
// runs only in the poll's capture loop. Pins:
//   * W1 anchor: only a LAUNCHED pane derives; a pre-existing pane stays UNKNOWN → declines (P1-B).
//   * §0-CORR.2 exempt: the assistant's OWN just-dispatched ssh (proven pid) is NOT flagged by the W-2b scan,
//     yet a user's pre-existing / same-host DIFFERENT-pid ssh STILL flags → markUnknown (disclosure guard).
//   * RECONCILE-then-FREEZE (W3, P1-A): a post-exit `sudo x` freezes localhost, NOT stale host-a.
//   * §0-CORR.3 loopPhase: a dispatch during the PRE-landed window is DROPPED; a POST-landed one is admitted.
//   * derive-then-record: `ssh b@host-b` derives from the host-a frame (pre-push).
//   * single-flight (pollBusy): concurrent polls run one loop; a stale arm is superseded.
//   * every CaptureLoopOutcome flows through as { status: "filled", outcome }.
//   * W2 close: unwatchPane + forget same-turn.
import { describe, expect, it, vi } from "vitest";
import {
  KeyLockerCaptureDriver,
  type CaptureDriverDeps,
  type PromptVerdict,
} from "../../src/engine/key-locker/key-locker-capture-driver.js";
import { SessionTracker, type SessionFrame } from "../../src/engine/key-locker/session-tracker.js";
import { SshSessionWatch, type ProcessSnapshot } from "../../src/engine/key-locker/ssh-session-watch.js";
import type { BindingUri } from "../../src/engine/key-locker/binding.js";
import type { InjectResult } from "../../src/engine/key-locker/injector.js";
import type { CaptureLoopOutcome, SaveChoice } from "../../src/engine/key-locker/capture-loop.js";
import type { ExitCompletion } from "../../src/engine/key-locker/landed-detection.js";

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
    commandLine: (pid) => procs[pid]?.argv ?? null,
  };
}

const SENDINPUT_OK = (verified = true): InjectResult => ({ ok: true, injector: "sendinput", verified });
const PROMPT = (isCredentialPrompt: boolean): PromptVerdict => ({ isCredentialPrompt, tail: "", stillHiddenPrompt: false });
const sshProc = (parent: number, host: string, start: number): Proc =>
  ({ parent, name: "ssh", start, argv: ["ssh", `deploy@${host}`] });

/** Records the (command, session) passed to every deriveBinding call (the loop derives; onDispatch does not). */
interface Harness {
  driver: KeyLockerCaptureDriver;
  tracker: SessionTracker;
  watch: SshSessionWatch;
  setTree(procs: Record<number, Proc>): void;
  deriveCalls: { command: string; session: SessionFrame }[];
  deps: CaptureDriverDeps;
  clock: { ms: number };
}

function makeHarness(o: Partial<CaptureDriverDeps> = {}, initialTree: Record<number, Proc> = {}): Harness {
  let procs = initialTree;
  const snapshot = (): ProcessSnapshot => snapshotOf(procs);
  const tracker = new SessionTracker();
  const watch = new SshSessionWatch({ snapshot, tracker });
  const deriveCalls: { command: string; session: SessionFrame }[] = [];
  const clock = { ms: 1000 };

  // Default derive (the LOOP's authoritative gate): sudo → sudo binding bound to the frozen host; ssh
  // user@host → ssh binding for host; anything else → null. Records the frozen session it was handed.
  const deriveBinding = vi.fn(async (command: string, session: SessionFrame): Promise<BindingUri | null> => {
    deriveCalls.push({ command, session: { ...session } });
    if (command.startsWith("sudo")) return { scheme: "sudo", host: session.execHost, targetUser: "root" };
    const m = /^ssh\s+(?:\S+@)?(\S+)/.exec(command);
    if (m) return { scheme: "ssh", user: "u", host: m[1].replace(/^\S+@/, ""), port: 22, fpSet: [`SHA256:${m[1]}`] };
    return null;
  });

  const deps: CaptureDriverDeps = {
    tracker,
    watch,
    snapshot,
    deriveBinding,
    resolveBinding: vi.fn(async () => undefined), // NO MATCH by default (capture path)
    bindBinding: vi.fn(),
    confirmPolicyFor: vi.fn(() => false),
    capture: vi.fn(async () => ({ captured: true })),
    deleteSecret: vi.fn(async () => {}),
    injectPane: vi.fn(async () => SENDINPUT_OK()),
    confirmInjection: vi.fn(async () => true),
    offerSave: vi.fn(async () => "save"),
    mintOpaqueId: vi.fn(() => "opaque-1"),
    now: vi.fn(() => "2026-07-07T00:00:00.000Z"),
    runToExit: vi.fn(async () => ({ reason: "exited", exitCode: 0 })),
    readPaneAfterAuth: vi.fn(async () => ({ tail: "", stillHiddenPrompt: false })),
    readPromptTail: vi.fn(async () => PROMPT(false)), // no prompt by default
    nowMs: vi.fn(() => clock.ms),
    ...o,
  };
  const driver = new KeyLockerCaptureDriver(deps);
  return { driver, tracker, watch, setTree: (p) => { procs = p; }, deriveCalls, deps, clock };
}

// A shell (1000) under a terminal host (500), with configurable ssh children.
const shellTree = (extra: Record<number, Proc> = {}): Record<number, Proc> => ({
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
  ...extra,
});

describe("KeyLockerCaptureDriver — W1 anchoring (launched panes only, P1-B)", () => {
  it("a LAUNCHED pane is anchored known-local + watched; a credential dispatch arms", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
    expect(h.watch.isWatching("pane-1")).toBe(true);

    h.driver.onDispatch("pane-1", "sudo apt update");
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]);
    // onDispatch is synchronous and does NOT derive — the loop derives on poll.
    expect(h.deriveCalls).toEqual([]);
  });

  it("a PRE-EXISTING pane (never launched) is NOT anchored: onDispatch is a no-op, no arm, unknown", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onDispatch("pane-x", "sudo apt update"); // never launched
    expect(h.driver.armedPaneIds()).toEqual([]);
    expect(h.tracker.get("pane-x")).toEqual({ unknown: true });
  });

  it("cwd from launch is anchored (for L1's configured-git-remote resolution)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000, "C:/work");
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false, cwd: "C:/work" });
  });

  it("the anchored localhost frame is the one the loop derives from", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo apt update");
    await h.driver.poll("pane-1");
    expect(h.deriveCalls.at(-1)?.session).toEqual({ execHost: "localhost", isRemote: false });
  });
});

describe("KeyLockerCaptureDriver — arm pre-filter (looksLikeCredential, OQ-W-3)", () => {
  it("a non-credential command (`ls`) does NOT arm", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ls -la");
    expect(h.driver.armedPaneIds()).toEqual([]);
  });

  it("`sudo`/`doas`/`su` arm; a leading env-assignment is skipped (`LC_ALL=C sudo …` still arms)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "LC_ALL=C sudo apt update");
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]);
  });

  it("an UNKNOWN pane (sunk by reconcile) does not arm even for a credential command", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.tracker.markUnknown("pane-1"); // simulate a prior sink
    h.driver.onDispatch("pane-1", "sudo apt update");
    expect(h.driver.armedPaneIds()).toEqual([]);
  });

  it("a conditional ssh that recordDispatch SINKS to UNKNOWN ⇒ decline (Codex R5 P1)", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    // `false && ssh host` is a conditional (skipped) ssh → recordDispatch markUnknowns the pane; the pre-record
    // frozen still looks local, so the post-record gate must decline rather than arm the skipped ssh binding.
    h.driver.onDispatch("pane-1", "false && ssh deploy@host-a ; sudo -v");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true }); // recordDispatch sank it
    expect(h.driver.armedPaneIds()).toEqual([]);                 // declined — not armed
    expect((await h.driver.poll("pane-1")).status).toBe("idle");
    expect(h.deps.capture).not.toHaveBeenCalled();               // the sudo prompt is left for the human
  });
});

describe("KeyLockerCaptureDriver — fire-AFTER-delivery correlation (§0-CORR.2)", () => {
  it("the child is ALREADY visible at dispatch ⇒ armed + correlated (noteSshOpened), NOT markUnknown'd", () => {
    // THE fire-after case: `ssh deploy@host-a`'s child is in the tree when onDispatch fires. The exempt delta
    // proves pid 2000 is THIS dispatch's child → the W-2b scan skips it (no mis-flag) → the frame is pushed
    // and 2000 is registered synchronously in the SAME onDispatch turn.
    const h = makeHarness({}, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true }); // NOT markUnknown'd
    expect(h.tracker.remoteDepth("pane-1")).toBe(1);

    // PROOF the registration took: kill 2000 → the watch pops the frame to local.
    h.setTree(shellTree());
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("without the exempt the assistant's OWN ssh would be mis-flagged — so the exempt is load-bearing", () => {
    // Demonstrate the negative: a plain `tickWatch` (no exempt) over the same tree DOES flag the ssh child,
    // which is exactly why onDispatch passes the exempt. Here we drive tickWatch on a pane with a live but
    // UNregistered interactive ssh — the W-2b scan markUnknowns it (the shared-pane disclosure guard).
    const h = makeHarness({}, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.tickWatch(); // no exempt — the unregistered interactive ssh trips the W-2b scan
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });

  it("a USER hand-ssh (unregistered) + assistant `sudo x` (dHost null, no exempt) ⇒ markUnknown (disclosure guard)", () => {
    // The security crux: a local secret must never reach a remote prompt in a shared L3-launched pane the user
    // drove an in-bound ssh into. `sudo x` has no interactive-ssh host ⇒ NO exempt ⇒ the W-2b scan flags the
    // user's ssh ⇒ markUnknown ⇒ decline.
    const h = makeHarness({}, shellTree({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "admin@secret-host"] } }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true }); // sunk — LOCAL secret must not reach remote
    expect(h.driver.armedPaneIds()).toEqual([]);
  });

  it("a PRE-EXISTING user ssh to the SAME host still flags even though the assistant's NEW child is exempt", () => {
    // §0-CORR.2 counterexample: the user has an ssh to host-a open (pid 1500, in the baseline after a tick);
    // the assistant then dispatches `ssh deploy@host-a` spawning a NEW child 2000. Only 2000 is exempt — the
    // user's 1500 is a DIFFERENT pid the W-2b scan STILL flags ⇒ markUnknown (host is not identity).
    const h = makeHarness({}, shellTree({ 1500: sshProc(1000, "host-a", 15) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.tickWatch(); // fold the pre-existing 1500 into the baseline (and it markUnknowns — user ssh)
    h.tracker.beginLocalSession("pane-1"); // re-anchor (the user pane is shared; simulate the driver re-seeing local)
    // now the assistant dispatches ssh host-a → new child 2000 appears alongside the user's 1500
    h.setTree(shellTree({ 1500: sshProc(1000, "host-a", 15), 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    // 2000 is the assistant's (new since the baseline) and exempt; 1500 is pre-existing (in baseline) and NOT
    // exempt → the W-2b scan flags it → markUnknown. The assistant's login does not get trusted over a lurking
    // user session.
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });

  it("a straggler child (not visible at dispatch) is correlated on a later tick (fire-after slow-spawn backstop)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // child NOT visible yet → pending correlation
    // the pane pushed host-a but has no registered child; a tick before the child appears markUnknowns (fail-safe)
    // — but here the child appears, then a tick correlates it (register), and the frame survives.
    h.setTree(shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true });
    expect(h.tracker.remoteDepth("pane-1")).toBe(1);
  });

  it("a straggler that never appears before a tick ⇒ the unwatched frame markUnknowns (fail-safe OQ-W-9 residual)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // push, but the child has NOT spawned yet
    h.driver.tickWatch(); // child invisible ⇒ nothing to register ⇒ backstop markUnknowns (safe decline)
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true }); // declines, NEVER wrong-targets
  });

  it("an argv-UNREADABLE new ssh child ⇒ NO exempt ⇒ markUnknown (fail-safe, never guess)", () => {
    // The just-dispatched ssh's argv is unreadable (elevated/cross-user), so the exempt delta cannot host-match
    // it → NO exempt → the W-2b scan flags the unreadable ssh descendant → markUnknown.
    const h = makeHarness({}, shellTree({ 2000: { parent: 1000, name: "ssh", start: 20 /* no argv → null */ } }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });

  it(">1 new same-host ssh at dispatch ⇒ ambiguous ⇒ NO exempt ⇒ markUnknown", () => {
    // The assistant's ssh AND a user's same-host ssh both appear new in this window → newHostMatch length 2 →
    // exemptPid null → the W-2b scan flags them → markUnknown (never guess which is the assistant's).
    const h = makeHarness({}, shellTree({
      2000: sshProc(1000, "host-a", 20),
      2001: { parent: 1000, name: "ssh", start: 21, argv: ["ssh", "admin@host-a"] },
    }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });

  it("a pre-existing background TUNNEL is not mis-registered as the interactive login", () => {
    // A pre-existing `ssh -fNL` tunnel (host-t, non-interactive) is a sibling. The interactive login to host-a
    // spawns; only host-a is registered. Killing the TUNNEL must not pop the frame; killing the LOGIN must.
    const tunnel: Proc = { parent: 1000, name: "ssh", start: 15, argv: ["ssh", "-fNL", "9000", "host-t"] };
    const h = makeHarness({}, shellTree({ 1500: tunnel, 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // exempt 2000 (host-a), tunnel host is null ≠ host-a
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true });

    h.setTree(shellTree({ 2000: sshProc(1000, "host-a", 20) })); // kill the tunnel, keep the login
    h.driver.tickWatch();
    expect(h.tracker.remoteDepth("pane-1")).toBe(1); // still remote — the registered login lives

    h.setTree(shellTree()); // kill the login
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
  });
});

describe("KeyLockerCaptureDriver — derive-then-record ordering (§3.1 point 1)", () => {
  it("`ssh deploy@host-a` from localhost derives its OWN binding from the PRE-push (localhost) frame", async () => {
    // The login command IS a credential (its ssh password prompt) AND session-changing. Its own binding must
    // derive from the LOCALHOST frame it authenticates FROM (the frozen pre-push frame), while `recordDispatch`
    // pushes host-a for SUBSEQUENT commands. (A NESTED `ssh @host-b` from host-a is a different case: the module
    // deliberately declines it — depth≥2 is an unobservable inner login → markUnknown.)
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // frozen = localhost (pre-push); records host-a after
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true }); // post-push frame
    await h.driver.poll("pane-1"); // the loop derives the armed command from the FROZEN pre-push frame
    const loopDerive = h.deriveCalls.find((c) => c.command === "ssh deploy@host-a");
    expect(loopDerive?.session).toEqual({ execHost: "localhost", isRemote: false });
  });
});

describe("KeyLockerCaptureDriver — RECONCILE-then-FREEZE (W3, P1-A)", () => {
  it("reconcile-at-dispatch pops a dead ssh so a post-exit `sudo x` freezes localhost, NOT stale host-a", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // register host-a (child present)
    expect(h.tracker.remoteDepth("pane-1")).toBe(1);

    // the ssh session ended (2000 gone) — but the tracker STILL holds the stale host-a frame
    h.setTree(shellTree());
    // a later credential dispatch: reconcile-at-dispatch (tick) must pop host-a BEFORE the freeze
    h.driver.onDispatch("pane-1", "sudo x");
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
    await h.driver.poll("pane-1");
    expect(h.deriveCalls.at(-1)).toEqual({ command: "sudo x", session: { execHost: "localhost", isRemote: false } });
  });

  it("a remote `sudo x` whose ssh session POPS to local between arm and fill DECLINES (Opus R2 P2 — no cross-host disclosure)", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // register host-a
    await h.driver.poll("pane-1"); // this poll's prompt fires a loop for the ssh; ignore its outcome

    // dispatch a REMOTE `sudo x` (frozen = host-a, expected = host-a)
    h.driver.onDispatch("pane-1", "sudo x");
    // an EXTERNAL event pops the ssh: 2000 exits + a tick reconciles → tracker now LOCAL (a valid pop, still KNOWN)
    h.setTree(shellTree());
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });

    // the arm's expected=host-a no longer matches the live localhost → filling frozen host-a's secret into the
    // now-LOCAL pane would be a cross-host disclosure. DECLINE (isKnownSession alone would MISS this — both
    // frames are KNOWN — which is why the guard matches execHost+isRemote against `expected`).
    h.deriveCalls.length = 0;
    vi.mocked(h.deps.capture).mockClear();      // the earlier ssh-login poll captured; isolate the sudo-x poll
    vi.mocked(h.deps.injectPane).mockClear();
    const r = await h.driver.poll("pane-1");
    expect(r.status).toBe("declined");
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.deps.injectPane).not.toHaveBeenCalled();
    expect(h.deriveCalls).toEqual([]); // never even derived
  });

  it("a remote `sudo x` whose session is UNCHANGED between arm and fill DOES fill from the frozen host-a frame", async () => {
    // The legitimate remote fill: no external change, so live == expected == host-a → the loop derives the
    // armed command from the FROZEN host-a frame (the freeze still gives a deterministic derive).
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // register host-a
    await h.driver.poll("pane-1"); // ignore the ssh login loop
    h.driver.onDispatch("pane-1", "sudo x"); // frozen = host-a, expected = host-a (2000 still alive)
    h.deriveCalls.length = 0;
    const r = await h.driver.poll("pane-1");
    expect(r.status).toBe("filled");
    const loopDerive = h.deriveCalls.find((c) => c.command === "sudo x");
    expect(loopDerive?.session).toEqual({ execHost: "host-a", isRemote: true }); // derived from the frozen frame
  });
});

describe("KeyLockerCaptureDriver — loopPhase gate (§0-CORR.3)", () => {
  it("a dispatch during the PRE-landed window (shell blocked at the prompt) is DROPPED (not recorded)", async () => {
    let releaseCapture!: () => void;
    const capture = vi.fn(() => new Promise<{ captured: boolean }>((res) => { releaseCapture = () => res({ captured: true }); }));
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)), capture }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // arm

    // start the loop; it BLOCKS in capture() → loopPhase = pre-landed (the shell is at the prompt)
    const loopP = h.driver.poll("pane-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(capture).toHaveBeenCalledTimes(1);

    // a command delivered while the shell is blocked has NOT run — onDispatch must DROP it (no recordDispatch).
    const derivesBefore = h.deriveCalls.length;
    h.driver.onDispatch("pane-1", "ssh admin@host-b"); // would push host-b if wrongly admitted
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false }); // NOT host-b — dropped

    releaseCapture();
    expect((await loopP).status).toBe("filled"); // the original loop still completes correctly
    expect(h.deriveCalls.length).toBeGreaterThanOrEqual(derivesBefore); // (the loop's own derive may run)
  });

  it("a REAL dispatch during a Mode-B loop's POST-landed window IS admitted (armed), not dropped", async () => {
    let releaseOffer!: (c: SaveChoice) => void;
    const offerSave = vi.fn(() => new Promise<SaveChoice>((res) => { releaseOffer = res; }));
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)), offerSave }, shellTree({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // Mode-B login, arms host-a; child registered
    const pLoop = h.driver.poll("pane-1");               // runs the loop; awaitLanded(Mode B) accepts → post-landed → blocks in offerSave
    await new Promise((r) => setTimeout(r, 0));
    expect(offerSave).toHaveBeenCalledTimes(1);
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true }); // logged into host-a

    // the login SUCCEEDED (post-landed) — a genuine remote `sudo x2` now arrives while the loop is in offerSave.
    // It must be ADMITTED (a fresh arm on host-a), not dropped as it would be during the pre-landed window.
    h.driver.onDispatch("pane-1", "sudo x2");

    releaseOffer("save");
    await pLoop;
    // PROOF of admission: the loop's finally clears ONLY its own (`ssh deploy@host-a`) arm. If `sudo x2` had
    // been DROPPED, rec.armed would still BE that ssh arm → cleared → []. armedPaneIds=[pane-1] means a NEW arm
    // (x2, admitted) replaced it and survived. (Contrast the pre-landed-drop test above, which stays localhost.)
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]);
  });

  it("the Mode-A landed re-run fires onDispatch while still PRE-landed ⇒ dropped (W4-O2)", async () => {
    let releaseRun!: () => void;
    const runToExit = vi.fn((): Promise<ExitCompletion> => new Promise((res) => { releaseRun = () => res({ reason: "exited", exitCode: 0 }); }));
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)), runToExit }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // Mode-A one-shot, arms
    const pLoop = h.driver.poll("pane-1");    // loop blocks in runToExit (awaitLanded Mode A) — still pre-landed
    await new Promise((r) => setTimeout(r, 0));
    const derivesBefore = h.deriveCalls.length;
    h.driver.onDispatch("pane-1", "sudo x");  // the SAME-command Mode-A re-run → must be dropped (pre-landed)
    expect(h.deriveCalls.length).toBe(derivesBefore); // no new arm-derive path ran (dropped)
    releaseRun();
    await pLoop;
  });
});

describe("KeyLockerCaptureDriver — a pane sunk to UNKNOWN after arming is not filled (Codex W-2 REDO P1)", () => {
  it("a launched pane armed for `sudo x` (frozen localhost), then user-ssh'd in + markUnknown'd by a tick, DECLINES the fill", async () => {
    // THE disclosure the dispatch-time reconcile cannot catch: the sink happens AFTER the freeze. Without the
    // poll's live-session re-check the loop would fill the LOCAL sudo secret into the now-REMOTE pane's prompt.
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // armed, frozen = { localhost }
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]);

    // the USER hand-ssh's into the shared launched pane; a periodic tick's W-2b scan markUnknowns the pane
    h.setTree(shellTree({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "admin@secret-host"] } }));
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });

    // a poll must DECLINE (the frozen localhost binding must NOT reach the remote prompt) and disarm
    const r = await h.driver.poll("pane-1");
    expect(r.status).toBe("declined");
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.deps.injectPane).not.toHaveBeenCalled();
    expect(h.driver.armedPaneIds()).toEqual([]); // disarmed — no stale arm lingers
  });

  it("the poll RECONCILES before trusting the live session — a user hand-ssh'd in with NO tickWatch between still declines (Codex R3 P1)", async () => {
    // The deepest form: the poll is the FIRST code to observe reality after the arm. Without a poll-time
    // reconcile, `tracker.get()` still reads the STALE arm-time localhost session (no tickWatch has run to
    // markUnknown it), so the live-check would PASS and fill the local secret into the now-remote prompt.
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // armed, expected = { localhost }
    // the USER hand-ssh's in — but NO tickWatch fires. The tracker is still stale-local until the poll reconciles.
    h.setTree(shellTree({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "admin@secret-host"] } }));
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false }); // STALE — not yet reconciled

    const r = await h.driver.poll("pane-1"); // the poll's own reconcile must W-2b-markUnknown the pane, then decline
    expect(r.status).toBe("declined");
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true }); // the poll reconcile sank it
  });

  it("a pane sunk to UNKNOWN mid prompt-read (async) declines rather than fills", async () => {
    let releasePrompt!: (v: PromptVerdict) => void;
    const readPromptTail = vi.fn(() => new Promise<PromptVerdict>((res) => { releasePrompt = res; }));
    const h = makeHarness({ readPromptTail }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // armed on localhost
    const p = h.driver.poll("pane-1");         // awaits the blocked prompt read
    await new Promise((r) => setTimeout(r, 0));
    // the pane is sunk WHILE the prompt read is pending (a user ssh'd in + an interleaved tick)
    h.tracker.markUnknown("pane-1");
    releasePrompt(PROMPT(true));
    expect((await p).status).toBe("declined");
    expect(h.deps.capture).not.toHaveBeenCalled();
  });
});

describe("KeyLockerCaptureDriver — single-flight + stale-arm guards", () => {
  it("concurrent polls for one pane run only ONE capture loop (pollBusy serialize)", async () => {
    let releasePrompt!: (v: PromptVerdict) => void;
    const readPromptTail = vi.fn(() => new Promise<PromptVerdict>((res) => { releasePrompt = res; }));
    const h = makeHarness({ readPromptTail }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");

    const p1 = h.driver.poll("pane-1");             // sets pollBusy, awaits the (blocked) prompt read
    await new Promise((r) => setTimeout(r, 0));
    const p2 = await h.driver.poll("pane-1");        // re-entrant while p1 pends → dropped
    expect(p2.status).toBe("busy");
    expect(readPromptTail).toHaveBeenCalledTimes(1);

    releasePrompt(PROMPT(true));
    expect((await p1).status).toBe("filled");
    expect(h.deps.capture).toHaveBeenCalledTimes(1); // exactly ONE capture loop
  });

  it("a poll whose arm was overwritten mid-read aborts (superseded) — never fills the newer prompt under the older binding", async () => {
    let releasePrompt!: (v: PromptVerdict) => void;
    const readPromptTail = vi.fn(() => new Promise<PromptVerdict>((res) => { releasePrompt = res; }));
    const h = makeHarness({ readPromptTail }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x"); // arm A (sudo, cached — no prompt of its own)

    const pA = h.driver.poll("pane-1");        // captures armed=A(sudo), awaits the blocked prompt read
    await new Promise((r) => setTimeout(r, 0));
    // a NEWER credential command lands while the read is pending — onDispatch is not gated by pollBusy
    h.driver.onDispatch("pane-1", "sudo -u alice other"); // overwrites rec.armed = B
    releasePrompt(PROMPT(true));

    expect((await pA).status).toBe("superseded");   // aborts — does NOT fill the newer prompt under A
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]); // the newer arm B survives to be polled next
  });
});

describe("KeyLockerCaptureDriver — poll lifecycle + outcome pass-through", () => {
  it("polls until a credential prompt appears, then runs the loop and disarms", async () => {
    const verdicts = [PROMPT(false), PROMPT(false), PROMPT(true)];
    let i = 0;
    const h = makeHarness({ readPromptTail: vi.fn(async () => verdicts[Math.min(i++, verdicts.length - 1)]) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");

    expect((await h.driver.poll("pane-1")).status).toBe("polling");
    expect((await h.driver.poll("pane-1")).status).toBe("polling");
    expect((await h.driver.poll("pane-1")).status).toBe("filled");
    expect(h.driver.armedPaneIds()).toEqual([]); // disarmed after the loop
  });

  it("a MATCH autofill flows through as { status: 'filled', outcome: filled_from_store }", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })), // MATCH
      confirmPolicyFor: vi.fn(() => false),
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "filled_from_store", verified: true } satisfies CaptureLoopOutcome });
  });

  it("a rejected D2 confirm on a MATCH flows through as { status: 'filled', outcome: confirm_rejected }", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })),
      confirmPolicyFor: vi.fn(() => true),
      confirmInjection: vi.fn(async () => false),
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "confirm_rejected" } satisfies CaptureLoopOutcome });
    expect(h.deps.injectPane).not.toHaveBeenCalled();
  });

  it("a NO-MATCH capture→inject→landed→[Save] flows through as { status: 'filled', outcome: saved }", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "saved", verified: true } satisfies CaptureLoopOutcome });
    expect(h.deps.bindBinding).toHaveBeenCalledOnce();
  });

  it("a cancelled capture flows through as { status: 'filled', outcome: capture_cancelled }", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      capture: vi.fn(async () => ({ captured: false })),
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "capture_cancelled" } satisfies CaptureLoopOutcome });
  });

  it("a not-landed credential flows through as discarded/not_landed + reverse-orphan delete", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      runToExit: vi.fn(async () => ({ reason: "timeout" })), // Mode A not exit-0
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r.status).toBe("filled");
    expect((r as { outcome: CaptureLoopOutcome }).outcome).toMatchObject({ kind: "discarded", reason: "not_landed" });
    expect(h.deps.deleteSecret).toHaveBeenCalledOnce();
  });

  it("poller lifetime elapses with no prompt ⇒ timed_out + disarm (OQ-W-2)", async () => {
    const h = makeHarness({ pollTimeoutMs: 5000 }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.clock.ms = 1000;
    h.driver.onDispatch("pane-1", "sudo x"); // armedAt = 1000
    h.clock.ms = 7000; // > 1000 + 5000
    expect((await h.driver.poll("pane-1")).status).toBe("timed_out");
    expect(h.driver.armedPaneIds()).toEqual([]);
  });

  it("poll on an idle / unarmed pane ⇒ idle", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    expect((await h.driver.poll("pane-1")).status).toBe("idle");
    expect((await h.driver.poll("never-launched")).status).toBe("idle");
  });
});

describe("KeyLockerCaptureDriver — multi-pane correlation isolation", () => {
  const twoShells = (extra: Record<number, Proc> = {}): Record<number, Proc> => ({
    500: { parent: 0, name: "windowsterminal", start: 1 },
    1000: { parent: 500, name: "powershell", start: 10 },
    1100: { parent: 500, name: "powershell", start: 11 },
    ...extra,
  });

  it("another pane's onDispatch does NOT markUnknown pane-1's registered ssh frame", () => {
    const h = makeHarness({}, twoShells({ 2000: sshProc(1000, "host-a", 20) }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.driver.onLocalPaneLaunched("pane-2", 1100);
    h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // pane-1 registers host-a (child present)
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true });
    h.driver.onDispatch("pane-2", "ls");                // pane-2's tick reconciles ALL panes
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true }); // pane-1 survives
  });
});

describe("KeyLockerCaptureDriver — W2 close atomicity", () => {
  it("onPaneClosed unwatches + forgets the pane (same turn)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    expect(h.watch.isWatching("pane-1")).toBe(true);
    h.driver.onPaneClosed("pane-1");
    expect(h.watch.isWatching("pane-1")).toBe(false);
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });
});
