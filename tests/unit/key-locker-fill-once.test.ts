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

import {
  isKeyUnlockPrompt, runFillOnce, widenForFillOnce, type FillOnceDeps, type FillOnceOutcome,
} from "../../src/engine/key-locker/fill-once.js";
import { KeyLockerCaptureDriver, type CaptureDriverDeps, type PromptVerdict } from "../../src/engine/key-locker/key-locker-capture-driver.js";
import type { PaneAnchor } from "../../src/engine/key-locker/inject-target.js";
import { KeptTags, MAX_KEPT_TAGS_PER_PANE } from "../../src/engine/key-locker/kept-tags.js";
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
  /** internal #335: the locker's checks before the dialog (default: would pass). */
  probe?: { ok: false; code: string };
  deleteFails?: number;
  /** internal #281: the kept-tag map (a real `KeptTags` by default) and the confirm dialog's answer. */
  kept?: KeptTags;
  confirm?: boolean | "fill_always";
  confirmThrows?: boolean;
  anchoredSeq?: boolean[];
  opaqueId?: string;
} = {}): Fake {
  const calls: string[] = [];
  const deleted: string[] = [];
  const released: object[] = [];
  const claims = [...(o.claims ?? [])];
  const prompts = [...(o.prompts ?? [PROMPT(true), PROMPT(true)])];
  const procs = [...(o.procs ?? [SSH(), SSH()])];
  const failsafe = [...(o.failsafe ?? [null, null])];
  const anchoredSeq = [...(o.anchoredSeq ?? [])];
  const kept = o.kept ?? keptTags().tags;
  const deps: FillOnceDeps = {
    claim: (id) => { calls.push(`claim:${id}`); return claims.length > 0 ? claims.shift()! : { ok: true, anchor: ANCHOR, token: TOKEN }; },
    release: (_id, token) => { calls.push("release"); released.push(token); },
    credentialProcesses: () => { calls.push("procs"); return procs.length > 0 ? procs.shift()! : SSH(); },
    checkFailsafe: async () => { calls.push("failsafe"); const e = failsafe.shift() ?? null; if (e !== null) throw e; },
    readPromptTail: async () => { calls.push("prompt"); return prompts.length > 0 ? prompts.shift()! : PROMPT(true); },
    mintOpaqueId: () => o.opaqueId ?? "op-1",
    capture: async (id, dialog) => {
      calls.push(`capture:${id}:${dialog.label}:${dialog.note}${dialog.tag !== undefined ? `:tag=${dialog.tag}` : ""}`);
      if (o.captureThrows) throw new Error("pipe drop");
      return { captured: o.captured ?? true };
    },
    stillAnchored: () => { calls.push("anchored"); return anchoredSeq.length > 0 ? anchoredSeq.shift()! : (o.anchored ?? true); },
    probeAt: async () => { calls.push("probe"); return o.probe ?? { ok: true }; },
    injectAt: async (anchor, id, submit) => { calls.push(`inject:${anchor.shellPid}:${id}:${submit}`); return o.inject ?? { ok: true, verified: true }; },
    deleteSecret: async (id) => {
      calls.push(`delete:${id}`);
      if ((o.deleteFails ?? 0) > deleted.filter((d) => d === "fail").length) { deleted.push("fail"); throw new Error("pipe closed"); }
      deleted.push(id);
    },
    kept: {
      lookup: (id, anchor, tag) => kept.lookup(id, anchor, tag),
      count: (id, anchor) => kept.count(id, anchor),
      confirm: async (dialog) => {
        calls.push(`confirm:${dialog.tag}:${dialog.label}:${dialog.note}`);
        if (o.confirmThrows) throw new Error("pipe drop");
        const c = o.confirm ?? true;
        return c === true ? "fill" : c === false ? "cancel" : c;
      },
      alwaysAt: (id, anchor, tag) => kept.alwaysAt(id, anchor, tag),
      allowAlways: (id, anchor, tag, opaqueId, line) => {
        calls.push(`always:${tag}:${opaqueId}:${line}`);
        kept.allowAlways(id, anchor, tag, opaqueId, line);
      },
      keep: (id, anchor, tag, opaqueId) => { calls.push(`keep:${tag}:${opaqueId}`); return kept.keep(id, anchor, tag, opaqueId, HELPER); },
    },
    sleep: async () => { calls.push("sleep"); },
  };
  return { deps, calls, deleted, released };
}

/** The live helper the fake kept-tag map treats as holding every kept secret. */
const HELPER = { helper: 1 };
/** A real kept-tag map whose erasures are recorded (`erased`), as the wiring erases on the live helper. */
function keptTags(): { tags: KeptTags; erased: string[] } {
  const erased: string[] = [];
  return { tags: new KeptTags({ liveHolder: () => HELPER, erase: (ids) => erased.push(...ids) }), erased };
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
      "claim:1234", "failsafe", "prompt", "procs", "probe",
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

describe("fill_once accepts OpenSSH's key-unlock prompts (internal #280)", () => {
  // The user's own case: Windows OpenSSH unlocking a key, which the loop's classifier declined not_at_prompt.
  // Each tail is what the pane read returns; the prompt is its cursor row (and, wrapped, the rows above it).
  const accepted = [
    "PS C:\\> ssh jump\r\nEnter passphrase for key 'owner\\.ssh\\ssh_key':",
    "Enter passphrase for key 'C:\\Users\\a/.ssh/id_ed25519': \r\n\r\n", // trailing blank rows
    "\u001b[32mEnter passphrase for key 'k':\u001b[0m", // ANSI around it
    "Enter passphrase for /home/a/.ssh/id_rsa:", // the ssh-add shape (a remote ssh-add inside a session)
    "Enter passphrase for /home/a/.ssh/id_rsa:\r\n   \r\n", // ...with blank rows below the cursor row
    "Enter PIN for ED25519-SK key /home/a/.ssh/id_ed25519_sk:", // a Unix ssh's security-key PIN
    // PR #812 codex P2: a long path soft-wraps and the read breaks the row there.
    "PS C:\\> ssh -i C:\\Users\\a\\keys\\deploy host\r\nEnter passphrase for key 'C:\\Users\\a\\ke\r\nys\\deploy':",
    "Enter passphrase for \r\nkey 'k':", // the wrap fell on a space (trimmed)
    "Enter passphrase for key 'C:\\Users\\a\\.ssh\\very    \r\n  long\\id_ed25519':", // padded rows
  ];
  const declined = [
    "Enter passphrase for key 'x'", // no colon: not waiting for input
    "PS C:\\> echo Enter passphrase for key x:", // a command line that only mentions it
    "$ Enter passphrase for key 'x':", // prefixed: not at the line start
    "Enter passphrase (empty for no passphrase):", // ssh-keygen choosing a NEW passphrase
    "Enter passphrase for key 'x': typed",
    "id_ed25519':", // a wrapped tail with its start scrolled out of the read
    "Enter passphrase for key 'k':\r\nPS C:\\>", // the prompt is not on the cursor row any more
    // An ANSWERED prompt, its output, and a later row ending in a colon must not join into one prompt.
    "Enter passphrase for key 'k':\r\nuser@h: Permission denied (publickey).\r\nnote:",
    "Enter passphrase for key 'a':\r\nwarning: key 'b':", // ...nor a later row quoting something
    // A wrapped prompt past the row bound (the rows tried are bounded).
    `Enter passphrase for key '${Array.from({ length: 7 }, () => "a").join("\r\n")}':`,
  ];
  it.each(accepted)("accepts %j", (tail) => expect(isKeyUnlockPrompt(tail)).toBe(true));
  it.each(declined)("declines %j", (tail) => expect(isKeyUnlockPrompt(tail)).toBe(false));
  it("declines null / empty", () => {
    expect(isKeyUnlockPrompt(null)).toBe(false);
    expect(isKeyUnlockPrompt("")).toBe(false);
  });

  it("widens only a non-prompt verdict whose tail ends in a key-unlock prompt", () => {
    const tail = "PS> ssh jump\nEnter passphrase for key 'k':";
    const no: PromptVerdict = { isCredentialPrompt: false, tail, stillHiddenPrompt: false };
    expect(widenForFillOnce(no)).toEqual({ isCredentialPrompt: true, tail, stillHiddenPrompt: true });
    const other: PromptVerdict = { isCredentialPrompt: false, tail: "PS C:\\>", stillHiddenPrompt: false };
    expect(widenForFillOnce(other)).toBe(other);
    expect(widenForFillOnce(null)).toBeNull(); // unreadable stays unreadable
    const yes: PromptVerdict = { isCredentialPrompt: true, tail: "Password:", stillHiddenPrompt: true };
    expect(widenForFillOnce(yes)).toBe(yes);
  });

  it("a key-unlock prompt reaches the dialog and fills through runFillOnce; unwidened it declines", async () => {
    const raw = PROMPT(false, "PS> ssh jump\nEnter passphrase for key 'owner\\.ssh\\ssh_key':");
    const widened = fake({ prompts: [widenForFillOnce(raw), widenForFillOnce(raw)] });
    expect(await run(widened)).toEqual({ kind: "filled", verified: true });
    expect(opened(widened)).toBe(true);
    const plain = fake({ prompts: [raw] });
    expect(await run(plain)).toEqual({ kind: "declined", reason: "not_at_prompt" });
    expect(opened(plain)).toBe(false);
  });
});

// ── internal #281: kept tags ──────────────────────────────────────────────────────────────────────────

const TAGGED = { ...REQ, tag: "jump" };
const ANCHOR_REUSED: PaneAnchor = { ...ANCHOR, shellPid: 9999, shellStartTimeMs: 77 };
const confirmed = (f: Fake): boolean => f.calls.some((c) => c.startsWith("confirm"));

/** A map that already keeps `jump` → `kept-1` for pane 1234 under ANCHOR. */
function withKept(): { tags: KeptTags; erased: string[] } {
  const k = keptTags();
  k.tags.keep("1234", ANCHOR, "jump", "kept-1", HELPER);
  return k;
}

describe("runFillOnce — a NEW tag: typed once, then kept", () => {
  it("the typing dialog shows the tag; after the fill the secret is KEPT, not deleted", async () => {
    const k = keptTags();
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true });
    expect(f.calls).toEqual([
      "claim:1234", "failsafe", "prompt", "procs", "probe",
      "capture:op-1:the locker console:log in via the jump host:tag=jump",
      "prompt", "procs", "failsafe", "anchored",
      "inject:4321:op-1:true", "anchored", "keep:jump:op-1", "release",
    ]);
    expect(f.deleted).toEqual([]);
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("op-1");
  });

  it.each([
    ["the user cancels", { captured: false }, { kind: "cancelled" }],
    ["the prompt changed", { prompts: [PROMPT(true), PROMPT(false, "$ ")] }, { kind: "declined", reason: "prompt_changed" }],
    ["the locker refused the write", { inject: { ok: false as const, code: "echo_on" } }, { kind: "fill_aborted", code: "echo_on" }],
  ])("%s → nothing is kept and the typed secret is deleted", async (_name, opts, outcome) => {
    const k = keptTags();
    const f = fake({ kept: k.tags, ...opts });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual(outcome);
    expect(f.deleted).toEqual(["op-1"]);
    expect(k.tags.hasAny()).toBe(false);
  });

  it("the pane closed during the write → filled, but NOT kept (no tag for a dead pane); deleted", async () => {
    const k = keptTags();
    const f = fake({ kept: k.tags, anchoredSeq: [true, false] });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true });
    expect(f.deleted).toEqual(["op-1"]);
    expect(k.tags.hasAny()).toBe(false);
  });

  it(`a new tag past ${MAX_KEPT_TAGS_PER_PANE} per pane declines tag_limit before any dialog`, async () => {
    const k = keptTags();
    for (let i = 0; i < MAX_KEPT_TAGS_PER_PANE; i++) k.tags.keep("1234", ANCHOR, `t${i}`, `id-${i}`, HELPER);
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, { ...REQ, tag: "ninth" })).toEqual({ kind: "declined", reason: "tag_limit" });
    expect(opened(f) || confirmed(f) || wrote(f)).toBe(false);
    expect(f.released).toEqual([TOKEN]);
    // A tag already kept still fills through its confirm.
    const g = fake({ kept: k.tags });
    expect(await runFillOnce(g.deps, { ...REQ, tag: "t3" })).toEqual({ kind: "filled", verified: true, kept: true });
    expect(g.calls).toContain("inject:4321:id-3:true");
  });

  it("no tag: unchanged — nothing is kept, the secret is deleted, the kept secret is never written", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags });
    expect(await run(f)).toEqual({ kind: "filled", verified: true });
    expect(f.calls).not.toContain("inject:4321:kept-1:true");
    expect(f.deleted).toEqual(["op-1"]);
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("kept-1");
  });
});

describe("runFillOnce — a KEPT tag: confirm, never type", () => {
  it("no typing dialog: a confirm showing tag, label and reason, then EVERY after-dialog gate, then the kept secret", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true });
    expect(f.calls).toEqual([
      "claim:1234", "failsafe", "prompt", "procs", "probe",
      "confirm:jump:the locker console:log in via the jump host",
      "prompt", "procs", "failsafe", "anchored",
      "inject:4321:kept-1:true", "release",
    ]);
    expect(opened(f)).toBe(false);
    expect(f.deleted).toEqual([]); // the kept secret stays
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("kept-1");
  });

  it("Cancel → cancelled; nothing typed; the tag stays", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, confirm: false });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "cancelled", kept: true });
    expect(wrote(f)).toBe(false);
    expect(f.deleted).toEqual([]);
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("kept-1");
    expect(f.released).toEqual([TOKEN]);
  });

  it("a confirm that throws → fill_aborted; nothing typed; released; the tag stays", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, confirmThrows: true });
    expect((await runFillOnce(f.deps, TAGGED)).kind).toBe("fill_aborted");
    expect(wrote(f)).toBe(false);
    expect(f.released).toEqual([TOKEN]);
  });

  // Every gate the typed path runs, on the kept path. Each must decline with nothing written.
  const gates: Array<[string, Parameters<typeof fake>[0], string, boolean]> = [
    ["the stop armed before the confirm", { failsafe: [new FailsafeError()] }, "failsafe_engaged", false],
    ["not at a credential prompt", { prompts: [PROMPT(false)] }, "not_at_prompt", false],
    ["an unreadable pane", { prompts: [null] }, "prompt_unreadable", false],
    ["a printed prompt (no ssh / sudo running)", { procs: [new Map()] }, "no_credential_program", false],
    ["the prompt went away during the confirm", { prompts: [PROMPT(true), PROMPT(false, "$ ")] }, "prompt_changed", true],
    ["a DIFFERENT prompt after the confirm", { prompts: [PROMPT(true), PROMPT(true, "x@other's password: ")] }, "prompt_changed", true],
    ["a different ssh process after the confirm", { procs: [SSH(), new Map([[778, 6000]])] }, "prompt_changed", true],
    ["the pane's processes unreadable after the confirm", { procs: [SSH(), null] }, "target_gone", true],
    ["the stop armed during the confirm", { failsafe: [null, new FailsafeError()] }, "failsafe_engaged", true],
    ["the pane closed during the confirm", { anchored: false }, "target_gone", true],
  ];
  it.each(gates)("%s → declined; nothing typed; the tag stays, and the reply says so", async (_n, opts, reason, didConfirm) => {
    const k = withKept();
    const f = fake({ kept: k.tags, ...opts });
    // `kept` on every decline, the early ones too (codex on #883: a decline before the lookup said false).
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "declined", reason, kept: true });
    expect(wrote(f)).toBe(false);
    expect(opened(f)).toBe(false);
    expect(confirmed(f)).toBe(didConfirm);
    expect(f.deleted).toEqual([]);
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("kept-1");
  });

  it("the stop probe is the LAST await before the kept write", async () => {
    const f = fake({ kept: withKept().tags });
    await runFillOnce(f.deps, TAGGED);
    const i = f.calls.indexOf("inject:4321:kept-1:true");
    expect(f.calls.slice(i - 2, i)).toEqual(["failsafe", "anchored"]);
  });

  it("a REUSED paneId (another anchor) never fills the old tag: the user types, and the old id is erased", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, claims: [{ ok: true, anchor: ANCHOR_REUSED, token: TOKEN }] });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true });
    expect(confirmed(f)).toBe(false);
    expect(f.calls.some((c) => c.includes("kept-1"))).toBe(false);
    expect(f.calls).toContain("inject:9999:op-1:true");
    expect(k.erased).toEqual(["kept-1"]);
    expect(k.tags.lookup("1234", ANCHOR_REUSED, "jump")).toBe("op-1");
  });
});

describe("runFillOnce — retype replaces a kept tag", () => {
  it("retype: the typing dialog opens; after the fill the new secret replaces the old, which is erased", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, opaqueId: "op-2" });
    expect(await runFillOnce(f.deps, { ...TAGGED, retype: true })).toEqual({ kind: "filled", verified: true, kept: true });
    expect(confirmed(f)).toBe(false);
    expect(f.calls).toContain("capture:op-2:the locker console:log in via the jump host:tag=jump");
    expect(f.calls).toContain("inject:4321:op-2:true");
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("op-2");
    expect(k.erased).toEqual(["kept-1"]);
    expect(f.deleted).toEqual([]);
  });

  it("a retype that does not fill leaves the old kept secret as it was; the new one is deleted", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, opaqueId: "op-2", captured: false });
    expect(await runFillOnce(f.deps, { ...TAGGED, retype: true })).toEqual({ kind: "cancelled", kept: true });
    expect(f.deleted).toEqual(["op-2"]);
    expect(k.tags.lookup("1234", ANCHOR, "jump")).toBe("kept-1");
    expect(k.erased).toEqual([]);
  });

  it("a retype at the tag cap is allowed (it replaces, it does not add)", async () => {
    const k = keptTags();
    for (let i = 0; i < MAX_KEPT_TAGS_PER_PANE; i++) k.tags.keep("1234", ANCHOR, `t${i}`, `id-${i}`, HELPER);
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, { ...REQ, tag: "t0", retype: true })).toEqual({ kind: "filled", verified: true, kept: true });
  });
});

describe("KeyLockerCaptureDriver — a closed or re-anchored pane forgets its kept tags (internal #281)", () => {
  function driverWithForget(procs: Record<number, Proc> = SHELLS): { d: KeyLockerCaptureDriver; forgotten: string[] } {
    const forgotten: string[] = [];
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
    const d = new KeyLockerCaptureDriver({
      tracker, watch, snapshot, readPromptTail: async () => PROMPT(false), checkFailsafe: async () => {}, nowMs: () => 0,
      onPaneForgotten: (id: string) => forgotten.push(id),
    } as unknown as CaptureDriverDeps);
    return { d, forgotten };
  }

  it("onPaneClosed (window_disappeared) reports the pane", () => {
    const { d, forgotten } = driverWithForget();
    d.onLocalPaneLaunched("1234", ANCHOR);
    d.onPaneClosed("1234");
    expect(forgotten).toEqual(["1234"]);
  });

  it("the wt shell-exit prune reports the pane", () => {
    const procs: Record<number, Proc> = { ...SHELLS, 6000: { parent: 1, name: "powershell", start: 20 } };
    const { d, forgotten } = driverWithForget(procs);
    d.onLocalPaneLaunched("wt:6000:20", { kind: "wt", shellPid: 6000, shellStartTimeMs: 20 });
    d.tickWatch();
    expect(forgotten).toEqual([]);
    delete procs[6000]; // the tab's shell exited
    d.tickWatch();
    expect(forgotten).toEqual(["wt:6000:20"]);
  });

  it("a re-launch under the same id (a reused hwnd) reports the old pane before re-anchoring", () => {
    const { d, forgotten } = driverWithForget();
    d.onLocalPaneLaunched("1234", ANCHOR);
    expect(forgotten).toEqual([]);
    d.onLocalPaneLaunched("1234", { ...ANCHOR, shellPid: 5555 });
    expect(forgotten).toEqual(["1234"]);
  });
});

// ── "Don't ask again" (user request 2026-10-30; scope 2026-10-31: that tag only, at the same prompt) ──────

/** The mark for TAIL: the prompt row and the row above it. */
const LINE = "harus@hop:~$ ssh harus@192.168.1.20\nharus@192.168.1.20's password:";
const ELSEWHERE = "PS C:\\> ssh hop\nharus@hop:~$ sudo -i\n[sudo] password for harus: ";

describe("runFillOnce — a kept tag marked \"Don't ask again\"", () => {
  it("Fill with the box ticked marks the prompt line; the next fill there skips the confirm and runs every gate", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, confirm: "fill_always" });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true, always: true });
    expect(f.calls).toContain(`always:jump:kept-1:${LINE}`);
    const g = fake({ kept: k.tags });
    expect(await runFillOnce(g.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true, always: true });
    expect(g.calls).toEqual([
      "claim:1234", "failsafe", "prompt", "procs", "probe",
      "prompt", "procs", "failsafe", "anchored",
      "inject:4321:kept-1:true", "release",
    ]);
  });

  it("a prompt with other text asks again (sudo, another host, a bare Password:)", async () => {
    for (const tail of [ELSEWHERE, "harus@hop:~$ ssh x@10.0.0.9\nx@10.0.0.9's password: ", "Password: "]) {
      const k = withKept();
      k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
      const f = fake({ kept: k.tags, prompts: [PROMPT(true, tail), PROMPT(true, tail)] });
      expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true, always: true });
      expect(confirmed(f)).toBe(true);
    }
  });

  it("the same login run again later skips (other output above it does not matter)", async () => {
    const k = withKept();
    k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
    const again = `${TAIL}\nharus@192.168.1.20:~$ exit\nlogout\n${LINE} `;
    const f = fake({ kept: k.tags, prompts: [PROMPT(true, again), PROMPT(true, again)] });
    await runFillOnce(f.deps, TAGGED);
    expect(confirmed(f)).toBe(false);
    expect(wrote(f)).toBe(true);
  });

  it("the same prompt row under a different row above asks again (a failed try; a wrapped `password:`)", async () => {
    for (const above of ["Permission denied, please try again.", "alice@another-very-long-host-name.example's"]) {
      const k = withKept();
      k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
      const tail = `${TAIL}\n${above}\nharus@192.168.1.20's password: `;
      const f = fake({ kept: k.tags, prompts: [PROMPT(true, tail), PROMPT(true, tail)] });
      await runFillOnce(f.deps, TAGGED);
      expect(confirmed(f)).toBe(true);
    }
  });

  it("a wrapped key-unlock prompt is bound to all its rows: another user's key asks again (codex on #885)", async () => {
    const wrapped = (user: string): string => `PS C:\\> ssh hop\nEnter passphrase for key '/home/${user}/.ssh/\r\nid_ed25519': `;
    const k = withKept();
    const f = fake({ kept: k.tags, confirm: "fill_always", prompts: [PROMPT(true, wrapped("alice")), PROMPT(true, wrapped("alice"))] });
    expect((await runFillOnce(f.deps, TAGGED)).always).toBe(true);
    const same = fake({ kept: k.tags, prompts: [PROMPT(true, wrapped("alice")), PROMPT(true, wrapped("alice"))] });
    await runFillOnce(same.deps, TAGGED);
    expect(confirmed(same)).toBe(false);
    const other = fake({ kept: k.tags, prompts: [PROMPT(true, wrapped("bobby")), PROMPT(true, wrapped("bobby"))] });
    await runFillOnce(other.deps, TAGGED);
    expect(confirmed(other)).toBe(true);
  });

  it("a marked tag still declines at a gate: nothing typed, no dialog", async () => {
    const k = withKept();
    k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
    const f = fake({ kept: k.tags, prompts: [PROMPT(false, "$ ")] });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "declined", reason: "not_at_prompt", kept: true, always: true });
    expect(confirmed(f) || wrote(f)).toBe(false);
  });

  it.each([
    ["the prompt changed during the dialog", { prompts: [PROMPT(true), PROMPT(true, ELSEWHERE)] }],
    ["the write was refused", { inject: { ok: false as const, code: "other_reader" } }],
    ["the pane closed during the dialog", { anchored: false }],
  ])("ticked, but %s → not marked: the next fill asks again", async (_name, opts) => {
    const k = withKept();
    const f = fake({ kept: k.tags, confirm: "fill_always", ...opts });
    expect((await runFillOnce(f.deps, TAGGED)).kind).not.toBe("filled");
    expect(k.tags.alwaysAt("1234", ANCHOR, "jump")).toBeNull();
  });

  it("only that tag: another kept tag in the same pane still asks", async () => {
    const k = withKept();
    k.tags.keep("1234", ANCHOR, "db1", "kept-2", HELPER);
    k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, { ...REQ, tag: "db1" })).toEqual({ kind: "filled", verified: true, kept: true });
    expect(confirmed(f)).toBe(true);
  });

  it("Fill without the tick does not mark", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "filled", verified: true, kept: true });
    expect(k.tags.alwaysAt("1234", ANCHOR, "jump")).toBeNull();
  });

  it("a retype that fills replaces the secret and clears the mark: the next fill asks again", async () => {
    const k = withKept();
    k.tags.allowAlways("1234", ANCHOR, "jump", "kept-1", LINE);
    const f = fake({ kept: k.tags, opaqueId: "op-2" });
    expect(await runFillOnce(f.deps, { ...TAGGED, retype: true })).toEqual({ kind: "filled", verified: true, kept: true });
    expect(opened(f)).toBe(true);
    const g = fake({ kept: k.tags });
    await runFillOnce(g.deps, TAGGED);
    expect(confirmed(g)).toBe(true);
  });
});

// ── internal #335: the locker's checks run before any dialog ─────────────────────────────────────────────

describe("runFillOnce — the locker's checks before the dialog (internal #335)", () => {
  it.each(["console_selecting", "echo_on", "other_reader"])("%s before the dialog → fill_aborted, no dialog opens, nothing typed", async (code) => {
    const f = fake({ probe: { ok: false, code } });
    expect(await run(f)).toEqual({ kind: "fill_aborted", code });
    expect(opened(f) || wrote(f)).toBe(false);
    expect(f.calls).toEqual(["claim:1234", "failsafe", "prompt", "procs", "probe", "release"]);
  });

  it("a kept tag's confirm is not shown either", async () => {
    const k = withKept();
    const f = fake({ kept: k.tags, probe: { ok: false, code: "console_selecting" } });
    expect(await runFillOnce(f.deps, TAGGED)).toEqual({ kind: "fill_aborted", code: "console_selecting", kept: true });
    expect(confirmed(f) || wrote(f)).toBe(false);
  });
});
