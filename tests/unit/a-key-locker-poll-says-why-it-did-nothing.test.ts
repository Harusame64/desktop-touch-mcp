/**
 * internal #283: the wiring armed every armed pane's poll with `.catch(() => {})`, and the driver cleared arms
 * in several places outside the poll, so a locker that "did nothing" at a prompt left no trace. Every end of an
 * arm is now reported by the driver (`onArmEnded`), wherever it is cleared, and written as one diagnostic line;
 * a poll that throws before the loop is written once per arm. Nothing written is a secret.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: vi.fn() } }));
const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return { ...actual, logDiagnostic: vi.fn((e: unknown) => { logged.push(e); }) };
});

import { KeyLockerCaptureDriver, type ArmEnd, type CaptureDriverDeps, type PromptVerdict } from "../../src/engine/key-locker/key-locker-capture-driver.js";
import { SessionTracker } from "../../src/engine/key-locker/session-tracker.js";
import { SshSessionWatch, type ProcessSnapshot } from "../../src/engine/key-locker/ssh-session-watch.js";
import { KeyLockerError } from "../../src/engine/key-locker-host.js";
import { armEndEvent, pollErrorEvent, writePollEvent } from "../../src/engine/key-locker/poll-log.js";

const procs: Record<number, { parent: number; name: string; start: number }> = {
  500: { parent: 0, name: "windowsterminal", start: 1 },
  1000: { parent: 500, name: "powershell", start: 10 },
};
const snapshot = (): ProcessSnapshot => {
  const parentMap = new Map<number, number>();
  for (const [pid, p] of Object.entries(procs)) parentMap.set(Number(pid), p.parent);
  return { parentMap, identify: (pid) => procs[pid] ?? { name: "", startTimeMs: 0 }, commandLine: () => null } as unknown as ProcessSnapshot;
};
const PROMPT = (isCredentialPrompt: boolean): PromptVerdict => ({ isCredentialPrompt, tail: "", stillHiddenPrompt: false });

function harness(o: Partial<CaptureDriverDeps> = {}) {
  const tracker = new SessionTracker();
  const watch = new SshSessionWatch({ snapshot, tracker });
  const ends: [string, ArmEnd][] = [];
  const clock = { ms: 1000 };
  const deps: CaptureDriverDeps = {
    tracker, watch, snapshot,
    deriveBinding: vi.fn(async (_c: string, s) => ({ scheme: "sudo", host: (s as { execHost: string }).execHost, targetUser: "root" }) as never),
    resolveBinding: vi.fn(async () => undefined),
    bindBinding: vi.fn(), unbindBinding: vi.fn(), confirmPolicyFor: vi.fn(() => false),
    capture: vi.fn(async () => ({ captured: true })),
    deleteSecret: vi.fn(async () => {}), persistSecret: vi.fn(async () => true),
    injectPane: vi.fn(async () => ({ ok: true, injector: "console", verified: true }) as never),
    confirmInjection: vi.fn(async () => true), offerSave: vi.fn(async () => "save" as never),
    mintOpaqueId: vi.fn(() => "opaque-1"), now: vi.fn(() => "2026-11-10T00:00:00.000Z"),
    runToExit: vi.fn(async () => ({ reason: "exited", exitCode: 0 }) as never),
    readPaneAfterAuth: vi.fn(async () => ({ tail: "", stillHiddenPrompt: false })),
    readPromptTail: vi.fn(async () => PROMPT(false)),
    nowMs: vi.fn(() => clock.ms),
    checkFailsafe: vi.fn(async () => {}),
    onArmEnded: (paneId, end) => { ends.push([paneId, end]); },
    ...o,
  };
  const driver = new KeyLockerCaptureDriver(deps);
  driver.onLocalPaneLaunched("pane-1", { kind: "classic", hwnd: 1000n, shellPid: 1000, shellStartTimeMs: 10 } as never);
  return { driver, ends, clock, tracker };
}

describe("the driver reports every end of an arm, once", () => {
  it("timed out with no prompt", async () => {
    const h = harness();
    h.driver.onDispatch("pane-1", "sudo apt update");
    h.clock.ms += 10 * 60_000;
    await h.driver.poll("pane-1");
    await h.driver.poll("pane-1"); // not armed any more: nothing more
    expect(h.ends).toEqual([["pane-1", { end: "timed_out" }]]);
  });
  it("replaced by a newer dispatch (credential or not)", () => {
    const h = harness();
    h.driver.onDispatch("pane-1", "sudo apt update");
    h.driver.onDispatch("pane-1", "ls");
    h.driver.onDispatch("pane-1", "ls"); // no arm to replace: nothing
    expect(h.ends).toEqual([["pane-1", { end: "replaced" }]]);
  });
  it("the pane closed, or fill_once took it", () => {
    const h = harness();
    h.driver.onDispatch("pane-1", "sudo apt update");
    expect(h.driver.claimForFillOnce("pane-1").ok).toBe(true);
    const g = harness();
    g.driver.onDispatch("pane-1", "sudo apt update");
    g.driver.onPaneClosed("pane-1");
    expect([...h.ends, ...g.ends].map(([, e]) => e.end)).toEqual(["taken_by_fill_once", "pane_closed"]);
  });
  it("the session changed under the arm (the tick's hygiene)", () => {
    const h = harness();
    h.driver.onDispatch("pane-1", "sudo apt update");
    h.tracker.markUnknown("pane-1");
    h.driver.tickWatch();
    expect(h.ends.map(([, e]) => e.end)).toEqual(["session_changed"]);
  });
  it("the capture loop's outcome: saved, and a cancelled dialog", async () => {
    const h = harness({ readPromptTail: vi.fn(async () => PROMPT(true)) });
    h.driver.onDispatch("pane-1", "sudo apt update");
    await h.driver.poll("pane-1");
    const c = harness({ readPromptTail: vi.fn(async () => PROMPT(true)), capture: vi.fn(async () => ({ captured: false })) });
    c.driver.onDispatch("pane-1", "sudo apt update");
    await c.driver.poll("pane-1");
    expect(h.ends[0]![1]).toMatchObject({ end: "loop_outcome", outcome: { kind: "saved" } });
    expect(c.ends[0]![1]).toMatchObject({ end: "loop_outcome", outcome: { kind: "capture_cancelled" } });
  });
  it("a throwing listener does not disturb the driver", async () => {
    const h = harness({ onArmEnded: () => { throw new Error("boom"); } });
    h.driver.onDispatch("pane-1", "sudo apt update");
    h.clock.ms += 10 * 60_000;
    await expect(h.driver.poll("pane-1")).resolves.toMatchObject({ status: "timed_out" });
  });
  it("a poll that throws before the loop is reported once per arm", async () => {
    const h = harness({ readPromptTail: vi.fn(async () => { throw new Error("uia"); }) });
    h.driver.onDispatch("pane-1", "sudo apt update");
    await expect(h.driver.poll("pane-1")).rejects.toThrow("uia");
    expect(h.driver.firstPollErrorOfArm("pane-1")).toBe(true);
    await expect(h.driver.poll("pane-1")).rejects.toThrow("uia");
    expect(h.driver.firstPollErrorOfArm("pane-1")).toBe(false);
    h.driver.onDispatch("pane-1", "sudo ls"); // a new arm logs its first error again
    expect(h.driver.firstPollErrorOfArm("pane-1")).toBe(true);
  });
});

describe("the diagnostic line holds no secret", () => {
  it("an outcome's fields are picked by kind: no detail, and a loop_error code is cut to its prefix", () => {
    expect(armEndEvent("p", { end: "loop_outcome", outcome: { kind: "discarded", reason: "not_landed", detail: "probe_error:hunter2" } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p", end: "loop_outcome", outcome: "discarded", reason: "not_landed" });
    const aborted = armEndEvent("p", { end: "loop_outcome", outcome: { kind: "fill_aborted", matched: false, code: "loop_error:write failed: hunter2" } });
    expect(aborted).toEqual({ kind: "key_locker_poll", paneId: "p", end: "loop_outcome", outcome: "fill_aborted", reason: "loop_error", matched: false });
    expect(armEndEvent("p", { end: "loop_outcome", outcome: { kind: "fill_aborted", matched: true, code: "target mismatch: hunter2" } }).reason).toBe("other");
    expect(armEndEvent("p", { end: "loop_outcome", outcome: { kind: "saved", verified: true } }))
      .toEqual({ kind: "key_locker_poll", paneId: "p", end: "loop_outcome", outcome: "saved", verified: true });
  });
  it("an error is written by its name and a KeyLockerError's code, never its message", () => {
    const e = pollErrorEvent("p", new KeyLockerError("KeyLockerPipeUnavailable", "pipe gone while typing hunter2"));
    expect(e).toEqual({ kind: "key_locker_poll", paneId: "p", end: "poll_threw", errorName: "KeyLockerError", errorCode: "KeyLockerPipeUnavailable" });
    expect(JSON.stringify(e)).not.toContain("hunter2");
    const odd = Object.assign(new Error("x"), { code: "has spaces hunter2" });
    expect(pollErrorEvent("p", odd)).toEqual({ kind: "key_locker_poll", paneId: "p", end: "poll_threw", errorName: "Error" });
    expect(armEndEvent("p", { end: "loop_threw", errorName: "Error" })).toEqual({ kind: "key_locker_poll", paneId: "p", end: "loop_threw", errorName: "Error" });
  });
  it("writing never throws", () => {
    logged.length = 0;
    writePollEvent(armEndEvent("p", { end: "timed_out" }));
    expect(logged).toEqual([{ kind: "key_locker_poll", paneId: "p", end: "timed_out" }]);
  });
});
