// key-locker-capture-driver.test.ts — ADR-014 R3 L3-4 W-2 (the live-wiring CRUX).
//
// The driver wires the merged pure pipeline into a running loop while honoring W1/W2/W3. These tests drive
// the REAL SessionTracker + REAL SshSessionWatch against a mutable fake process tree (so the reconcile
// behavior is exercised end-to-end), faking only the capture/inject/prompt seams. Pins:
//   * W1 anchor: only a LAUNCHED pane derives; a pre-existing pane stays UNKNOWN → declines (P1-B).
//   * RECONCILE-then-FREEZE (W3): reconcile-at-dispatch pops a dead ssh so a post-exit `sudo x` freezes
//     localhost, NOT stale host-a (P1-A); the frozen frame survives an interleaved tick.
//   * derive-then-record: `ssh b@host-b` derives from the host-a frame (pre-push).
//   * single-flight (P2-E / W4-O2): a re-entrant onDispatch during an in-flight loop does not record.
//   * §3.1 before/after ssh-child DIFF: register the NEW interactive child, not a pre-existing tunnel (Q2).
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
import type { CaptureLoopOutcome } from "../../src/engine/key-locker/capture-loop.js";

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

/** Records the (command, session) passed to every deriveBinding call (arm + loop). */
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

  // Default derive: sudo → sudo binding bound to the session host; ssh user@host → ssh binding for host;
  // anything else → null (not a credential). Records the session it was handed (the frozen frame).
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
  it("a LAUNCHED pane is anchored known-local + watched; a credential dispatch arms + derives localhost", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
    expect(h.watch.isWatching("pane-1")).toBe(true);

    await h.driver.onDispatch("pane-1", "sudo apt update");
    expect(h.driver.armedPaneIds()).toEqual(["pane-1"]);
    expect(h.deriveCalls.at(-1)?.session).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("a PRE-EXISTING pane (never launched) is NOT anchored: onDispatch is a no-op, no derive, no arm", async () => {
    const h = makeHarness({}, shellTree());
    await h.driver.onDispatch("pane-x", "sudo apt update"); // never launched
    expect(h.deriveCalls).toEqual([]);
    expect(h.driver.armedPaneIds()).toEqual([]);
    expect(h.tracker.get("pane-x")).toEqual({ unknown: true });
  });

  it("cwd from launch is anchored (for L1's configured-git-remote resolution)", () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000, "C:/work");
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false, cwd: "C:/work" });
  });
});

describe("KeyLockerCaptureDriver — poller arm filter (OQ-W-3)", () => {
  it("a non-credential command (`ls`) does NOT arm", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ls -la");
    expect(h.driver.armedPaneIds()).toEqual([]);
  });

  it("an UNKNOWN pane (sunk by reconcile) does not arm even for a credential command", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.tracker.markUnknown("pane-1"); // simulate a prior sink
    await h.driver.onDispatch("pane-1", "sudo apt update");
    expect(h.driver.armedPaneIds()).toEqual([]);
    // the derive is skipped for an unknown session (never guess localhost)
    expect(h.deriveCalls).toEqual([]);
  });
});

describe("KeyLockerCaptureDriver — derive-then-record ordering (§3.1 point 1)", () => {
  it("`ssh b@host-b` from a host-a session derives from the host-a frame (PRE-push), not host-b", async () => {
    // W4-O1: the ssh child does NOT exist at dispatch (the hook fires before the send) — it appears later.
    const sshA: Proc = { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] };
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // pushes host-a, arms
    h.setTree(shellTree({ 2000: sshA }));                     // the interactive login now spawns
    await h.driver.poll("pane-1");                            // correlates + registers ssh 2000
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "host-a", isRemote: true });

    // now a nested login — its OWN binding must derive from the host-a frame it launches from
    await h.driver.onDispatch("pane-1", "ssh admin@host-b");
    expect(h.deriveCalls.at(-1)?.command).toBe("ssh admin@host-b");
    expect(h.deriveCalls.at(-1)?.session).toEqual({ execHost: "host-a", isRemote: true });
  });
});

describe("KeyLockerCaptureDriver — RECONCILE-then-FREEZE (W3, P1-A)", () => {
  it("reconcile-at-dispatch pops a dead ssh so a post-exit `sudo x` freezes localhost, NOT stale host-a", async () => {
    const sshA: Proc = { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] };
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // push host-a (depth 1)
    h.setTree(shellTree({ 2000: sshA }));                     // the ssh child now appears (W4-O1)
    await h.driver.poll("pane-1");                             // register ssh 2000 with the watch
    expect(h.tracker.remoteDepth("pane-1")).toBe(1);

    // the ssh session ended (2000 gone) — but the tracker STILL holds the stale host-a frame
    h.setTree(shellTree());
    // a later credential dispatch: reconcile-at-dispatch (tick) must pop host-a BEFORE the freeze
    await h.driver.onDispatch("pane-1", "sudo x");
    expect(h.deriveCalls.at(-1)?.command).toBe("sudo x");
    expect(h.deriveCalls.at(-1)?.session).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("the FROZEN frame survives an interleaved tick that pops the session before the prompt loop runs", async () => {
    const sshA: Proc = { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] };
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    h.setTree(shellTree({ 2000: sshA }));                     // ssh child appears (W4-O1)
    await h.driver.poll("pane-1"); // this poll's prompt fires a loop for the ssh; ignore its outcome

    // dispatch a REMOTE `sudo x` (frozen = host-a)
    await h.driver.onDispatch("pane-1", "sudo x");
    // an EXTERNAL event pops the ssh: 2000 exits + a tick reconciles → tracker now local
    h.setTree(shellTree());
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });

    // the prompt loop for `sudo x` must still use the FROZEN host-a frame, not the now-local live value
    h.deriveCalls.length = 0;
    await h.driver.poll("pane-1");
    const loopDerive = h.deriveCalls.find((c) => c.command === "sudo x");
    expect(loopDerive?.session).toEqual({ execHost: "host-a", isRemote: true });
  });
});

describe("KeyLockerCaptureDriver — single-flight (P2-E / W4-O2)", () => {
  it("a re-entrant onDispatch while a loop is in flight does NOT record (no frame push, no derive)", async () => {
    let releaseCapture!: () => void;
    const capture = vi.fn(() => new Promise<{ captured: boolean }>((res) => { releaseCapture = () => res({ captured: true }); }));
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)), capture }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "sudo x"); // arm

    // start the loop; it BLOCKS in capture() → loopInFlight stays true
    const loopP = h.driver.poll("pane-1");
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks until poll reaches capture()
    expect(capture).toHaveBeenCalledTimes(1);

    const derivesBefore = h.deriveCalls.length;
    const depthBefore = h.tracker.remoteDepth("pane-1");
    // the Mode-A re-run (W4-O2) or a buffered dispatch re-enters — must be dropped
    await h.driver.onDispatch("pane-1", "ssh evil@attacker");
    expect(h.deriveCalls.length).toBe(derivesBefore);       // no arm-derive
    expect(h.tracker.remoteDepth("pane-1")).toBe(depthBefore); // no frame push

    releaseCapture();
    await loopP;
  });
});

describe("KeyLockerCaptureDriver — §3.1 before/after ssh-child DIFF (Q2)", () => {
  it("registers the NEW interactive child, NOT a pre-existing background tunnel", async () => {
    // pre-existing tunnel 1500 (ssh -fNL, non-interactive) is a SIBLING of the future login
    const tunnel: Proc = { parent: 1000, name: "ssh", start: 15, argv: ["ssh", "-fNL", "9000", "host-t"] };
    const h = makeHarness({}, shellTree({ 1500: tunnel }));
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // baseline = {1500 tunnel}

    // the interactive login 2000 now spawns (tunnel 1500 still present)
    h.setTree(shellTree({ 1500: tunnel, 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] } }));
    await h.driver.poll("pane-1"); // correlate → register 2000 (NOT 1500)

    // PROOF: kill the TUNNEL 1500, keep the login 2000 → the frame must NOT pop (2000 was registered)
    h.setTree(shellTree({ 2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] } }));
    h.driver.tickWatch();
    expect(h.tracker.remoteDepth("pane-1")).toBe(1); // still remote — the registered login lives

    // now kill the LOGIN 2000 → the frame pops to local (proves 2000 was the registered pid)
    h.setTree(shellTree());
    h.driver.tickWatch();
    expect(h.tracker.get("pane-1")).toEqual({ execHost: "localhost", isRemote: false });
  });

  it("an argv-UNREADABLE new ssh child ⇒ markUnknown (fail-safe, never guess)", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a"); // baseline = {} (no ssh yet)
    // the new ssh child is present but its argv is unreadable (elevated/cross-user)
    h.setTree(shellTree({ 2000: { parent: 1000, name: "ssh", start: 20 /* no argv → null */ } }));
    await h.driver.poll("pane-1");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true }); // sunk, not guessed
  });

  it(">1 new interactive ssh child ⇒ markUnknown (ambiguous, never guess)", async () => {
    const h = makeHarness({}, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "ssh deploy@host-a");
    h.setTree(shellTree({
      2000: { parent: 1000, name: "ssh", start: 20, argv: ["ssh", "deploy@host-a"] },
      2001: { parent: 1000, name: "ssh", start: 21, argv: ["ssh", "admin@host-b"] },
    }));
    await h.driver.poll("pane-1");
    expect(h.tracker.get("pane-1")).toEqual({ unknown: true });
  });
});

describe("KeyLockerCaptureDriver — poll lifecycle + outcome pass-through", () => {
  it("polls until a credential prompt appears, then runs the loop and disarms", async () => {
    const verdicts = [PROMPT(false), PROMPT(false), PROMPT(true)];
    let i = 0;
    const h = makeHarness({ readPromptTail: vi.fn(async () => verdicts[Math.min(i++, verdicts.length - 1)]) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "sudo x");

    expect((await h.driver.poll("pane-1")).status).toBe("polling");
    expect((await h.driver.poll("pane-1")).status).toBe("polling");
    const filled = await h.driver.poll("pane-1");
    expect(filled.status).toBe("filled");
    expect(h.driver.armedPaneIds()).toEqual([]); // disarmed after the loop
  });

  it("a MATCH autofill flows through as { status: 'filled', outcome: filled_from_store }", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      resolveBinding: vi.fn(async () => ({ opaqueId: "stored-1" })), // MATCH
      confirmPolicyFor: vi.fn(() => false),
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "filled_from_store", verified: true } satisfies CaptureLoopOutcome });
  });

  it("a NO-MATCH capture→inject→landed→[Save] flows through as { status: 'filled', outcome: saved }", async () => {
    const h = makeHarness({ readPromptTail: vi.fn(async () => PROMPT(true)) }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "sudo x");
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
    await h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r).toEqual({ status: "filled", outcome: { kind: "capture_cancelled" } satisfies CaptureLoopOutcome });
  });

  it("a not-landed credential flows through as { status: 'filled', outcome: discarded/not_landed }", async () => {
    const h = makeHarness({
      readPromptTail: vi.fn(async () => PROMPT(true)),
      runToExit: vi.fn(async () => ({ reason: "timeout" })), // Mode A not exit-0
    }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    await h.driver.onDispatch("pane-1", "sudo x");
    const r = await h.driver.poll("pane-1");
    expect(r.status).toBe("filled");
    expect((r as { outcome: CaptureLoopOutcome }).outcome).toMatchObject({ kind: "discarded", reason: "not_landed" });
    expect(h.deps.deleteSecret).toHaveBeenCalledOnce(); // reverse-orphan delete
  });

  it("poller lifetime elapses with no prompt ⇒ timed_out + disarm (OQ-W-2)", async () => {
    const h = makeHarness({ pollTimeoutMs: 5000 }, shellTree());
    h.driver.onLocalPaneLaunched("pane-1", 1000);
    h.clock.ms = 1000;
    await h.driver.onDispatch("pane-1", "sudo x"); // armedAt = 1000
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
