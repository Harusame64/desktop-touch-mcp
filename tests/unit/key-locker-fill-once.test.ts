// key-locker-fill-once.test.ts — `fill_once` (internal #277): an assistant-requested, one-shot, never-saved
// fill. Pins the gates and their ORDER in the pure `runFillOnce`, and the driver's claim/release:
//   * nothing opens a dialog unless the pane is anchored, free, the stop is clear, a credential prompt shows,
//     AND a credential program (ssh / sudo / su / doas) runs under the shell — a PRINTED `Password:` has none;
//   * after the dialog the pane must be the SAME (prompt text + credential processes), then the stop is
//     probed as the LAST await before `injectAt`;
//   * the captured secret is deleted on EVERY exit, the filled one included (nothing is ever saved);
//   * the claim is released with its own token on every exit, and a release never resets another claim.
import { describe, expect, it, vi } from "vitest";

// key-locker-tool imports the failsafe, which loads the nut-js mouse at module scope.
vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: vi.fn() } }));

import { runFillOnce, type FillOnceDeps, type FillOnceOutcome } from "../../src/engine/key-locker/fill-once.js";
import { KeyLockerCaptureDriver, type CaptureDriverDeps, type PromptVerdict } from "../../src/engine/key-locker/key-locker-capture-driver.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";
import { SessionTracker } from "../../src/engine/key-locker/session-tracker.js";
import { SshSessionWatch, type ProcessSnapshot } from "../../src/engine/key-locker/ssh-session-watch.js";
import { sanitizeFillOnceReason } from "../../src/tools/key-locker-tool.js";

const ANCHOR: PaneAnchor = { kind: "classic", hwnd: 1234n, shellPid: 4321, shellStartTimeMs: 10 };
const TAIL = "PS C:\\> ssh hop\nharus@hop:~$ ssh harus@192.168.1.20\nharus@192.168.1.20's password: ";
const PROMPT = (isCredentialPrompt: boolean, tail = TAIL): PromptVerdict => ({ isCredentialPrompt, tail, stillHiddenPrompt: isCredentialPrompt });
const SSH = (): Map<number, number> => new Map([[777, 5000]]);

class FailsafeError extends Error {
  constructor() { super("stop"); this.name = "FailsafeError"; }
}

interface Fake {
  deps: FillOnceDeps;
  calls: string[];
  deleted: string[];
  released: object[];
}

const TOKEN = {};

/** A fake whose every seam records its call, so a test can assert both the outcome and the ORDER. */
function fake(o: {
  claims?: ReturnType<FillOnceDeps["claim"]>[];
  prompts?: (PromptVerdict | null)[];
  procs?: (Map<number, number> | null)[];
  failsafe?: (null | Error)[];
  captured?: boolean;
  captureThrows?: boolean;
  anchored?: boolean;
  inject?: { ok: true; verified: boolean } | { ok: false; code: string };
  deleteFails?: number;
} = {}): Fake {
  const calls: string[] = [];
  const deleted: string[] = [];
  const released: object[] = [];
  const claims = [...(o.claims ?? [])];
  const prompts = [...(o.prompts ?? [PROMPT(true), PROMPT(true)])];
  const procs = [...(o.procs ?? [SSH(), SSH()])];
  const failsafe = [...(o.failsafe ?? [null, null])];
  const deps: FillOnceDeps = {
    claim: (id) => { calls.push(`claim:${id}`); return claims.length > 0 ? claims.shift()! : { ok: true, anchor: ANCHOR, token: TOKEN }; },
    release: (_id, token) => { calls.push("release"); released.push(token); },
    credentialProcesses: () => { calls.push("procs"); return procs.length > 0 ? procs.shift()! : SSH(); },
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
    deleteSecret: async (id) => {
      calls.push(`delete:${id}`);
      if ((o.deleteFails ?? 0) > deleted.filter((d) => d === "fail").length) { deleted.push("fail"); throw new Error("pipe closed"); }
      deleted.push(id);
    },
    sleep: async () => { calls.push("sleep"); },
  };
  return { deps, calls, deleted, released };
}

const REQ = { paneId: "1234", dialog: { label: "the locker console", note: "log in via the jump host" }, submit: true };
const run = (f: Fake): Promise<FillOnceOutcome> => runFillOnce(f.deps, REQ);
const opened = (f: Fake): boolean => f.calls.some((c) => c.startsWith("capture"));
const wrote = (f: Fake): boolean => f.calls.some((c) => c.startsWith("inject"));

describe("runFillOnce — the happy path", () => {
  it("fills once, in order: claim → stop → prompt → procs → dialog → prompt → procs → stop → anchor → inject → delete → release", async () => {
    const f = fake();
    expect(await run(f)).toEqual({ kind: "filled", verified: true });
    expect(f.calls).toEqual([
      "claim:1234", "failsafe", "prompt", "procs",
      "capture:op-1:the locker console:log in via the jump host",
      "prompt", "procs", "failsafe", "anchored",
      "inject:4321:op-1:true", "delete:op-1", "release",
    ]);
    expect(f.released).toEqual([TOKEN]); // released with ITS token
  });

  it("passes submit:false through to the write", async () => {
    const f = fake();
    await runFillOnce(f.deps, { ...REQ, submit: false });
    expect(f.calls).toContain("inject:4321:op-1:false");
  });

  it("retries a busy claim (the poll holds the pane for one read) before declining", async () => {
    const f = fake({ claims: [{ ok: false, reason: "busy" }, { ok: false, reason: "busy" }] });
    expect(await run(f)).toEqual({ kind: "filled", verified: true });
    expect(f.calls.filter((c) => c === "sleep")).toHaveLength(2);
  });

  it("a pane that stays busy declines busy after the retries", async () => {
    const busy = { ok: false as const, reason: "busy" as const };
    const f = fake({ claims: Array(10).fill(busy) });
    expect(await run(f)).toEqual({ kind: "declined", reason: "busy" });
    expect(f.calls.filter((c) => c.startsWith("claim"))).toHaveLength(6);
    expect(f.released).toEqual([]);
  });
});

describe("runFillOnce — before the dialog, nothing opens", () => {
  it("a pane the driver never anchored declines without a dialog or a release", async () => {
    const f = fake({ claims: [{ ok: false, reason: "not_anchored" }] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "not_anchored" });
    expect(opened(f)).toBe(false);
    expect(f.released).toEqual([]);
  });

  it("the stop armed → failsafe_engaged; no dialog, nothing deleted (nothing was captured)", async () => {
    const f = fake({ failsafe: [new FailsafeError()] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_engaged" });
    expect(f.calls).toEqual(["claim:1234", "failsafe", "release"]);
  });

  it("a probe that fails some other way declines (fail-closed), it does not proceed", async () => {
    const f = fake({ failsafe: [new Error("probe broke")] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_unknown" });
    expect(opened(f)).toBe(false);
  });

  it("not at a credential prompt → not_at_prompt, no dialog", async () => {
    const f = fake({ prompts: [PROMPT(false)] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "not_at_prompt" });
    expect(opened(f)).toBe(false);
    expect(f.released).toEqual([TOKEN]);
  });

  it("an unreadable pane → prompt_unreadable, no dialog", async () => {
    const f = fake({ prompts: [null] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_unreadable" });
    expect(opened(f)).toBe(false);
  });

  it("a PRINTED `Password:` with no ssh / sudo / su running → no_credential_program, no dialog (Opus P1)", async () => {
    // e.g. the assistant sent `# Password:` or `Read-Host "Password"` into its own pane: an ECHOING line
    // that `terminal read` would hand straight back.
    const f = fake({ prompts: [PROMPT(true, "PS C:\\> # Password:")], procs: [new Map()] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "no_credential_program" });
    expect(opened(f)).toBe(false);
  });
});

describe("runFillOnce — after the dialog, nothing is typed unless the pane is the same", () => {
  it("the user cancels → cancelled; no write", async () => {
    const f = fake({ captured: false });
    expect(await run(f)).toEqual({ kind: "cancelled" });
    expect(wrote(f)).toBe(false);
    expect(f.released).toEqual([TOKEN]);
  });

  it("the prompt went away while the user typed → prompt_changed; no write; the secret is deleted", async () => {
    const f = fake({ prompts: [PROMPT(true), PROMPT(false, "harus@hop:~$ ")] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_changed" });
    expect(wrote(f)).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("a DIFFERENT prompt now (Ctrl+C, then `ssh x@otherhost`) → prompt_changed; no write (Opus P2)", async () => {
    const other = "harus@hop:~$ ssh x@otherhost\nx@otherhost's password: ";
    const f = fake({ prompts: [PROMPT(true), PROMPT(true, other)] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_changed" });
    expect(wrote(f)).toBe(false);
  });

  it("the same prompt text but a different ssh process (a re-run) → prompt_changed; no write", async () => {
    const f = fake({ procs: [SSH(), new Map([[778, 6000]])] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "prompt_changed" });
    expect(wrote(f)).toBe(false);
  });

  it("the stop armed while the dialog was open → failsafe_engaged; no write; deleted", async () => {
    const f = fake({ failsafe: [null, new FailsafeError()] });
    expect(await run(f)).toEqual({ kind: "declined", reason: "failsafe_engaged" });
    expect(wrote(f)).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("the pane closed while the dialog was open → target_gone; no write; deleted", async () => {
    const f = fake({ anchored: false });
    expect(await run(f)).toEqual({ kind: "declined", reason: "target_gone" });
    expect(wrote(f)).toBe(false);
    expect(f.deleted).toEqual(["op-1"]);
  });

  it("the stop probe is the LAST await before the write", async () => {
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
    expect((await run(f)).kind).toBe("fill_aborted");
    expect(f.deleted).toEqual(["op-1"]);
    expect(f.released).toEqual([TOKEN]);
  });

  it("an erase that fails once is retried; the result stays clean", async () => {
    const f = fake({ deleteFails: 1 });
    expect(await run(f)).toEqual({ kind: "filled", verified: true });
    expect(f.deleted).toEqual(["fail", "op-1"]);
  });

  it("an erase that fails twice is REPORTED as cleanupFailed, never swallowed (codex P2)", async () => {
    const f = fake({ deleteFails: 2 });
    expect(await run(f)).toEqual({ kind: "filled", verified: true, cleanupFailed: true });
    expect(f.released).toEqual([TOKEN]);
  });

  it("a FILLED secret is deleted too — fill_once never saves", async () => {
    const f = fake();
    await run(f);
    expect(f.deleted).toEqual(["op-1"]);
  });
});

// ── the driver: claim / release / credential processes ───────────────────────────────────────────────

interface Proc { parent: number; name: string; start: number }

const SHELLS: Record<number, Proc> = {
  4321: { parent: 1, name: "powershell", start: 10 },
  5555: { parent: 1, name: "powershell", start: 10 },
};

function makeDriver(
  procs: Record<number, Proc> = SHELLS,
  readPromptTail: () => Promise<PromptVerdict | null> = async () => PROMPT(false),
): KeyLockerCaptureDriver {
  const snapshot = (): ProcessSnapshot => {
    const parentMap = new Map<number, number>();
    for (const [pid, p] of Object.entries(procs)) parentMap.set(Number(pid), p.parent);
    return {
      parentMap,
      identify: (pid) => (procs[pid] !== undefined ? { name: procs[pid].name, startTimeMs: procs[pid].start } : { name: "", startTimeMs: 0 }),
      commandLine: () => null,
    };
  };
  const tracker = new SessionTracker();
  const watch = new SshSessionWatch({ tracker, snapshot });
  return new KeyLockerCaptureDriver({ tracker, watch, snapshot, readPromptTail, checkFailsafe: async () => {}, nowMs: () => 0 } as unknown as CaptureDriverDeps);
}

describe("KeyLockerCaptureDriver.claimForFillOnce / releaseFillOnce", () => {
  it("refuses a pane the driver never anchored (a user's own terminal)", () => {
    expect(makeDriver().claimForFillOnce("999")).toEqual({ ok: false, reason: "not_anchored" });
  });

  it("returns the spawn-captured anchor; a second claim is busy until the first is released", () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    const c = d.claimForFillOnce("1234");
    expect(c.ok && c.anchor).toEqual(ANCHOR);
    expect(d.claimForFillOnce("1234")).toEqual({ ok: false, reason: "busy" });
    if (c.ok) d.releaseFillOnce("1234", c.token);
    expect(d.claimForFillOnce("1234").ok).toBe(true);
  });

  it("drops a pending arm (the assistant took this prompt over)", () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    d.onDispatch("1234", "sudo -v");
    expect(d.armedPaneIds()).toContain("1234");
    d.claimForFillOnce("1234");
    expect(d.armedPaneIds()).not.toContain("1234");
  });

  it("DROPS a command dispatched while the dialog holds the prompt — the prompt swallows it (Opus round 2 P2)", async () => {
    // Recording it would leave an arm for a command that never ran; the retried prompt could then be
    // filled under that command's binding.
    const d = makeDriver(SHELLS, async () => PROMPT(true));
    d.onLocalPaneLaunched("1234", ANCHOR);
    const c = d.claimForFillOnce("1234");
    d.onDispatch("1234", "sudo -v");                 // swallowed by the password prompt
    if (c.ok) d.releaseFillOnce("1234", c.token);
    expect(d.armedPaneIds()).not.toContain("1234");  // no arm survives the release
    expect(await d.poll("1234")).toEqual({ status: "idle" }); // the retried prompt is not autofilled
    d.onDispatch("1234", "sudo -v");                 // after release, dispatches record again
    expect(d.armedPaneIds()).toContain("1234");
  });

  it("a stale release never resets a LATER claim of a re-anchored pane (Opus P3)", () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    const a = d.claimForFillOnce("1234");                            // claim on record A
    d.onLocalPaneLaunched("1234", { ...ANCHOR, shellPid: 5555 });   // a reused hwnd → record B
    const b = d.claimForFillOnce("1234");                            // B's own claim (its dialog is open)
    expect(b.ok).toBe(true);
    if (a.ok) d.releaseFillOnce("1234", a.token);                   // A's late release
    expect(d.claimForFillOnce("1234")).toEqual({ ok: false, reason: "busy" }); // B is still held
    if (b.ok) d.releaseFillOnce("1234", b.token);
    expect(d.claimForFillOnce("1234").ok).toBe(true);
  });

  it("a stale release never un-serializes the re-anchored record's own poll", async () => {
    let finishRead: (v: PromptVerdict) => void = () => {};
    const d = makeDriver(SHELLS, () => new Promise<PromptVerdict>((r) => { finishRead = r; }));
    d.onLocalPaneLaunched("1234", ANCHOR);
    const a = d.claimForFillOnce("1234");
    d.onLocalPaneLaunched("1234", { ...ANCHOR, shellPid: 5555 });
    d.onDispatch("1234", "sudo -v");
    expect(d.armedPaneIds()).toContain("1234");
    const polling = d.poll("1234");                  // B's poll in flight (pollBusy on B)
    if (a.ok) d.releaseFillOnce("1234", a.token);
    expect(d.claimForFillOnce("1234")).toEqual({ ok: false, reason: "busy" });
    finishRead(PROMPT(false));
    await polling;
    expect(d.claimForFillOnce("1234").ok).toBe(true);
  });
});

describe("KeyLockerCaptureDriver.credentialProcessesOf", () => {
  it("finds ssh / sudo / su / doas anywhere under the anchored shell, with creation times", () => {
    const d = makeDriver({
      4321: { parent: 1, name: "powershell", start: 10 },
      777: { parent: 4321, name: "ssh", start: 5000 },
      778: { parent: 777, name: "conhost", start: 5001 },
      779: { parent: 778, name: "sudo", start: 5002 },
      900: { parent: 1, name: "ssh", start: 7000 },        // NOT under this shell
    });
    d.onLocalPaneLaunched("1234", ANCHOR);
    expect(d.credentialProcessesOf("1234")).toEqual(new Map([[777, 5000], [779, 5002]]));
  });

  it("is empty when only the shell runs (a printed prompt), and null for an unanchored pane", () => {
    const d = makeDriver();
    d.onLocalPaneLaunched("1234", ANCHOR);
    expect(d.credentialProcessesOf("1234")).toEqual(new Map());
    expect(d.credentialProcessesOf("999")).toBeNull();
  });
});

describe("sanitizeFillOnceReason", () => {
  it("keeps one plain line: no controls, no bidi / zero-width, no line or paragraph separators (Opus P3)", () => {
    expect(sanitizeFillOnceReason("log in\nto host")).toBe("log in to host");
    expect(sanitizeFillOnceReason("a\u2028b\u2029c\u0085d")).toBe("a b c d");
    expect(sanitizeFillOnceReason("x\u202Etxt.exe\u2066y\u200Bz")).toBe("x txt.exe y z");
    expect(sanitizeFillOnceReason("  log in to 192.168.1.20 via the jump host  ")).toBe("log in to 192.168.1.20 via the jump host");
  });
});
