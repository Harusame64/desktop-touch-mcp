// key-locker-fill-once.test.ts — `fill_once` (internal #277): an assistant-requested, one-shot, never-saved
// fill. Pins the gates and their ORDER in the pure `runFillOnce`, and the driver's claim/release:
//   * nothing opens a dialog unless the pane is anchored, free, the stop is clear and a credential prompt shows;
//   * after the dialog, the prompt is re-read and the stop re-probed before the write — the stop probe is the
//     LAST await before `injectAt`;
//   * the captured secret is deleted on EVERY exit, the filled one included (nothing is ever saved);
//   * the claim is released on every exit, and only the claimed record is reset.
import { describe, expect, it } from "vitest";

import { runFillOnce, type FillOnceDeps, type FillOnceOutcome } from "../../src/engine/key-locker/fill-once.js";
import { KeyLockerCaptureDriver, type CaptureDriverDeps, type PromptVerdict } from "../../src/engine/key-locker/key-locker-capture-driver.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";
import { SessionTracker } from "../../src/engine/key-locker/session-tracker.js";
import { SshSessionWatch, type ProcessSnapshot } from "../../src/engine/key-locker/ssh-session-watch.js";

const ANCHOR: PaneAnchor = { kind: "classic", hwnd: 1234n, shellPid: 4321, shellStartTimeMs: 10 };
const PROMPT = (isCredentialPrompt: boolean): PromptVerdict => ({ isCredentialPrompt, tail: "", stillHiddenPrompt: isCredentialPrompt });

class FailsafeError extends Error {
  constructor() { super("stop"); this.name = "FailsafeError"; }
}

interface Fake {
  deps: FillOnceDeps;
  calls: string[];
  deleted: string[];
  released: number;
}

/** A fake whose every seam records its call, so a test can assert both the outcome and the ORDER. */
function fake(o: {
  claim?: FillOnceDeps["claim"];
  prompts?: (PromptVerdict | null)[];
  failsafe?: (null | Error)[];
  captured?: boolean;
  captureThrows?: boolean;
  anchored?: boolean;
  inject?: { ok: true; verified: boolean } | { ok: false; code: string };
} = {}): Fake {
  const calls: string[] = [];
  const deleted: string[] = [];
  const prompts = [...(o.prompts ?? [PROMPT(true), PROMPT(true)])];
  const failsafe = [...(o.failsafe ?? [null, null])];
  const f: Fake = { calls, deleted, released: 0, deps: undefined as unknown as FillOnceDeps };
  f.deps = {
    claim: o.claim ?? ((id) => { calls.push(`claim:${id}`); return { ok: true, anchor: ANCHOR }; }),
    release: () => { calls.push("release"); f.released++; },
    checkFailsafe: async () => { calls.push("failsafe"); const e = failsafe.shift() ?? null; if (e !== null) throw e; },
    readPromptTail: async () => { calls.push("prompt"); return prompts.length > 0 ? prompts.shift()! : PROMPT(true); },
    mintOpaqueId: () => "op-1",
    capture: async (id, dialog) => {
      calls.push(`capture:${id}:${dialog.label}:${dialog.note}`);
      if (o.captureThrows) throw new Error("pipe drop");
      return { captured: o.captured ?? true };
    },
    stillAnchored: () => { calls.push("anchored"); return o.anchored ?? true; },
    injectAt: async (anchor, id, submit) => { calls.push(`inject:${anchor.shellPid}:${id}:${submit}`); return o.inject ?? { ok: true, verified: true }; },
    deleteSecret: async (id) => { calls.push(`delete:${id}`); deleted.push(id); },
  };
  return f;
}

const REQ = { paneId: "1234", dialog: { label: "the locker console", note: "log in via the jump host" }, submit: true };
const run = (f: Fake): Promise<FillOnceOutcome> => runFillOnce(f.deps, REQ);

describe("runFillOnce — the happy path", () => {
  it("fills once, in order: claim → stop → prompt → dialog → prompt → stop → anchor → inject → delete → release", async () => {
    const f = fake();
    expect(await run(f)).toEqual({ kind: "filled", verified: true });
    expect(f.calls).toEqual([
      "claim:1234",
      "failsafe",
      "prompt",
      "capture:op-1:the locker console:log in via the jump host",
      "prompt",
      "failsafe",
      "anchored",
      "inject:4321:op-1:true",
      "delete:op-1",
      "release",
    ]);
  });

  it("passes submit:false through to the write", async () => {
    const f = fake();
    await runFillOnce(f.deps, { ...REQ, submit: false });
    expect(f.calls).toContain("inject:4321:op-1:false");
  });
});

describe("runFillOnce — before the dialog, nothing opens", () => {
  it.each([
    ["not_anchored", { claim: () => ({ ok: false, reason: "not_anchored" }) }],
    ["busy", { claim: () => ({ ok: false, reason: "busy" }) }],
  ] as const)("a claim refused as %s declines without a dialog or a release", async (reason, o) => {
    const f = fake(o as Parameters<typeof fake>[0]);
    expect(await run(f)).toEqual({ kind: "declined", reason });
    expect(f.calls.some((c) => c.startsWith("capture"))).toBe(false);
    expect(f.released).toBe(0);
  });

  it("the stop armed → failsafe_engaged; no dialog, nothing deleted (nothing was captured)", async () => {
    const f = fake({ failsafe: [new FailsafeError()] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_engaged" });
    expect(f.calls).toEqual(["claim:1234", "failsafe", "release"]);
  });

  it("a probe that fails some other way declines (fail-closed), it does not proceed", async () => {
    const f = fake({ failsafe: [new Error("probe broke")] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_unknown" });
    expect(f.calls.some((c) => c.startsWith("capture"))).toBe(false);
  });

  it("not at a credential prompt → not_at_prompt, no dialog", async () => {
    const f = fake({ prompts: [PROMPT(false)] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "not_at_prompt" });
    expect(f.calls.some((c) => c.startsWith("capture"))).toBe(false);
    expect(f.released).toBe(1);
  });

  it("an unreadable pane → prompt_unreadable, no dialog", async () => {
    const f = fake({ prompts: [null] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_unreadable" });
    expect(f.calls.some((c) => c.startsWith("capture"))).toBe(false);
  });
});

describe("runFillOnce — after the dialog, nothing is typed unless it is still safe", () => {
  it("the user cancels → cancelled; no write", async () => {
    const f = fake({ captured: false });
    expect(await run(f)).toEqual({ kind: "cancelled" });
    expect(f.calls.some((c) => c.startsWith("inject"))).toBe(false);
    expect(f.released).toBe(1);
  });

  it("the prompt went away while the user typed → prompt_gone; no write; the secret is deleted", async () => {
    const f = fake({ prompts: [PROMPT(true), PROMPT(false)] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_gone" });
    expect(f.calls.some((c) => c.startsWith("inject"))).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("the stop armed while the dialog was open → failsafe_engaged; no write; deleted", async () => {
    const f = fake({ failsafe: [null, new FailsafeError()] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_engaged" });
    expect(f.calls.some((c) => c.startsWith("inject"))).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("the pane closed while the dialog was open → target_gone; no write; deleted", async () => {
    const f = fake({ anchored: false });
    expect(await run(f)).toEqual({ kind: "declined", reason: "target_gone" });
    expect(f.calls.some((c) => c.startsWith("inject"))).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("the stop probe is the LAST await before the write (no read between it and injectAt)", async () => {
    const f = fake();
    await run(f);
    const i = f.calls.indexOf("inject:4321:op-1:true");
    expect(f.calls.slice(i - 2, i)).toEqual(["failsafe", "anchored"]);
  });

  it("the locker refuses the write → fill_aborted with its code; deleted", async () => {
    const f = fake({ inject: { ok: false, code: "target_mismatch" } });
    expect(await run(f)).toEqual({ kind: "fill_aborted", code: "target_mismatch" });
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("a dialog that throws → fill_aborted; the possibly-stored secret is still deleted; released", async () => {
    const f = fake({ captureThrows: true });
    const out = await run(f);
    expect(out.kind).toBe("fill_aborted");
    expect(f.deleted).toEqual(["op-1"]);
    expect(f.released).toBe(1);
  });

  it("a FILLED secret is deleted too — fill_once never saves", async () => {
    const f = fake();
    await run(f);
    expect(f.deleted).toEqual(["op-1"]);
  });
});

// ── the driver's claim/release (the serialization against its own poll + capture loop) ────────────────

function emptySnapshot(): ProcessSnapshot {
  // Both shells the tests anchor (4321, and 5555 for the re-anchored record) are alive; no ssh anywhere.
  return { parentMap: new Map([[4321, 1], [5555, 1]]), identify: () => ({ name: "cmd.exe", startTimeMs: 10 }), commandLine: () => null };
}

function makeDriver(readPromptTail: () => Promise<PromptVerdict | null> = async () => PROMPT(false)): KeyLockerCaptureDriver {
  const tracker = new SessionTracker();
  const watch = new SshSessionWatch({ tracker, snapshot: emptySnapshot });
  const deps = {
    tracker,
    watch,
    snapshot: emptySnapshot,
    readPromptTail,
    checkFailsafe: async () => {},
    nowMs: () => 0,
  } as unknown as CaptureDriverDeps;
  return new KeyLockerCaptureDriver(deps);
}

describe("KeyLockerCaptureDriver.claimForFillOnce", () => {
  it("refuses a pane the driver never anchored (a user's own terminal)", () => {
    expect(makeDriver().claimForFillOnce("999")).toEqual({ ok: false, reason: "not_anchored" });
  });

  it("returns the spawn-captured anchor, and a second claim is busy until released", () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    expect(d.claimForFillOnce("1234")).toEqual({ ok: true, anchor: ANCHOR });
    expect(d.claimForFillOnce("1234")).toEqual({ ok: false, reason: "busy" });
    d.releaseFillOnce("1234");
    expect(d.claimForFillOnce("1234").ok).toBe(true);
  });

  it("serializes against the driver's own poll: a poll during a claim reports busy", async () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    d.onDispatch("1234", "sudo -v"); // arm the pane
    expect(d.armedPaneIds()).toContain("1234");
    d.claimForFillOnce("1234");
    // The claim drops the arm: the assistant took this prompt over (a surviving arm would open a 2nd dialog).
    expect(d.armedPaneIds()).not.toContain("1234");
    d.releaseFillOnce("1234");
  });

  it("a release after the pane was re-anchored under the same id leaves the NEW record's poll serialized", async () => {
    let finishRead: (v: PromptVerdict) => void = () => {};
    const d = makeDriver(() => new Promise<PromptVerdict>((r) => { finishRead = r; }));
    d.onLocalPaneLaunched("1234", ANCHOR);
    expect(d.claimForFillOnce("1234").ok).toBe(true);        // fill_once holds record A
    d.onLocalPaneLaunched("1234", { ...ANCHOR, shellPid: 5555 }); // a reused hwnd → record B
    d.onDispatch("1234", "sudo -v");                          // arm B
    expect(d.armedPaneIds()).toContain("1234");
    const polling = d.poll("1234");                           // B's poll is in flight (pollBusy on B)
    d.releaseFillOnce("1234");                                // A's late release must NOT clear B's pollBusy
    expect(d.claimForFillOnce("1234")).toEqual({ ok: false, reason: "busy" });
    finishRead(PROMPT(false));
    await polling;
    expect(d.claimForFillOnce("1234").ok).toBe(true);         // free once B's poll finished
  });
});
