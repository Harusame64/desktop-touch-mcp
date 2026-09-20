/**
 * internal #142 — a read says which silence it is, and which client said it.
 *
 * Two facts that this product had and threw away.
 *
 * **Which silence.** `getElementBounds` answered `null` for a window that does not exist, for an
 * element that does not exist, and for a read that failed. Both clients know the difference:
 * `get_element_bounds_impl` (`src/uia/tree.rs`) turns a failed `find_window` and a failed
 * `find_element_in_window` into the same `Ok(None)`, and the PowerShell script prints
 * `{"error":"Window not found"}` and `{"error":"Element not found"}` as distinct answers which
 * `uia-bridge.ts` collapsed with `if (parsed.error) return null`. MEASURED 2026-09-20 win2: a wait
 * against a title matching no window at all answered `why: "element_not_found"` and advised
 * checking the ELEMENT name. The element name was never the problem.
 *
 * **Which client.** Every road in the bridge answers a native failure with a `console.warn` and a
 * PowerShell result. That was a bounded cost while the two clients were believed to see the same
 * tree. They do not: internal #136 measured a caption button as `Minimize` to one and `最小化` to
 * the other, twenty of Notepad's twenty-six elements differing, control types included. So a
 * fallback does not only change who answered — it changes the vocabulary the answer is in, and the
 * caller's name came from the other one.
 *
 * MEASURED 2026-09-20 win2 (internal `25da27f`), with the before and after controls in one run:
 * hanging the target window's UI thread makes the native call throw `UIA operation timed out after
 * 8000ms` at 8013 ms while the PowerShell road answers the same question normally in 3600 ms. The
 * caller got an ordinary answer and never knew the road had changed under it.
 *
 * These cells drive the bridge's own mapping and the one caller whose whole job is to explain a
 * silence. Nothing here routes on `via`; it is an answer, not a branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── the bridge's mapping, against the scripts and the addon it actually talks to ───────────────

const psOutputs: string[] = [];
let psThrows: Error | null = null;
let nativeAnswer: (() => unknown) | null = null;

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    if (psThrows) { cb(psThrows, { stdout: "", stderr: "" }); return; }
    // An unplanned fall-back is LOUD. `?? "{}"` used to answer a script nobody queued with an
    // empty object, which reads downstream as a found element with no fields — so a cell that
    // meant "the native road did not fall back" passed whether it fell back or not (gate 2).
    const queued = psOutputs.shift();
    if (queued === undefined) { cb(new Error("a script ran that this cell did not queue"), { stdout: "", stderr: "" }); return; }
    cb(null, { stdout: queued, stderr: "" });
  },
}));

vi.mock("../../index.js", () => ({
  default: {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    win32EnumTopLevelWindows: () => [],
    uiaGetElements: async () => ({ windowTitle: "T", elementCount: 0, elements: [] }),
    uiaGetFocusedAndPoint: async () => ({ focused: null, atPoint: null }),
    // The addon is PRESENT here — that is the point. A build with no addon can never show the
    // fallback, and the fallback is what this file is about.
    uiaGetElementBounds: async () => {
      if (!nativeAnswer) throw new Error("no native answer configured");
      return nativeAnswer();
    },
  },
}));

vi.resetModules();
const { getElementBounds } = await import("../../src/engine/uia-bridge.js");

function scripts_reset(): void { psOutputs.length = 0; }
beforeEach(() => { psOutputs.length = 0; psThrows = null; nativeAnswer = null; });
afterEach(() => { vi.unstubAllEnvs(); });

const ELEMENT = {
  name: "Save", controlType: "Button", automationId: "btnSave",
  boundingRect: { x: 1, y: 2, width: 3, height: 4 }, value: null,
};

describe("the bridge says which silence the read was", () => {
  it("keeps the two misses the PowerShell road already tells apart", async () => {
    // The script prints one or the other and exits. Collapsing them was a decision in TypeScript,
    // not a limit of the client.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psOutputs.push('{"error":"Window not found"}');
    expect(await getElementBounds("Nothing", "Save")).toMatchObject({ found: null, why: "window_not_found" });

    psOutputs.push('{"error":"Element not found"}');
    expect(await getElementBounds("App", "Nope")).toMatchObject({ found: null, why: "element_not_found" });
  });

  it("does not call a read that failed a missing element", async () => {
    // Nothing looked, so nothing can be concluded about either the window or the element — and the
    // error is carried so the caller is not left guessing at a silence with no content.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = new Error("powershell.exe: spawn failed");
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: null, why: "read_failed", via: "none" });
    expect((answer as { error?: string }).error).toMatch(/spawn failed/);
  });

  it("separates a read that was cut off from one that failed, because only one can change with time", async () => {
    // FOUND ON THE MACHINE, not here (win2, internal `0c5547d`): against a window whose UI thread
    // is hung, this road answers nothing in 16 seconds — 8000 ms of native timeout and then
    // 8000 ms of `runPS` timeout, spent one after the other, with the script killed and stdout
    // empty. That is not "the element is not there"; it is "nobody finished asking", and it is the
    // only silence a longer wait can turn into an answer. It looked exactly like the other three.
    nativeAnswer = () => { throw new Error("UIA operation timed out after 8000ms"); };
    psThrows = Object.assign(new Error("Command failed: powershell.exe"), { killed: true, signal: "SIGTERM" });
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: null, why: "read_unfinished", via: "none" });
    // …and it still says the engine was asked first and what it said, which is how a reader sees
    // that the sixteen seconds were two budgets and not one.
    expect((answer as { nativeFailed?: string }).nativeFailed).toMatch(/timed out after 8000ms/);
  });

  it("does not put the whole generated script into the answer", async () => {
    // MEASURED 2026-09-20 win2 (internal `c4374e9`): `error` carried 2361 characters of PowerShell,
    // because `execFile` builds its message out of the entire command line. This field goes back
    // through a tool response to a model that reads every word of it, and the script is the same
    // string on every call — it is not evidence about the failure.
    //
    // THE FIXTURE IS MULTI-LINE BECAUSE THE PRODUCER IS (gate 2). The first version of this cell
    // put the script on one line, and under it a `slice(1)` implementation looked correct while
    // against the real thirty-line script it kept the script's remaining lines and clamped the
    // stderr off the end — the exact opposite of the claim. A cell whose fixture the producer
    // never emits measures a road nobody travels.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    const script = [
      "", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName UIAutomationClient",
      "$root = [System.Windows.Automation.AutomationElement]::RootElement",
      ...Array.from({ length: 30 }, (_, i) => `$line${i} = 'padding padding padding padding padding'`),
    ].join("\n");
    psThrows = Object.assign(
      new Error(`Command failed: powershell.exe -NoProfile -NonInteractive -Command ${script}\n`),
      { killed: true, stderr: "the real reason", stdout: "" },
    );
    const answer = await getElementBounds("App", "Save") as { error?: string };
    expect(answer.error).not.toContain("AutomationElement");
    expect(answer.error).not.toContain("padding");
    expect(answer.error!.length).toBeLessThan(400);
    // …and what the process actually SAID is kept, which is the only part that differs per call.
    expect(answer.error).toMatch(/the real reason/);
    expect(answer.error).toMatch(/cut off at its own budget/);
  });

  it("keeps a short failure whole, because clamping it would throw away the only evidence", async () => {
    // `spawn powershell.exe ENOENT` never reached a process, so it has no `stderr` field at all:
    // the message IS the finding. A rule written as "always read stderr" would answer with a bare
    // heading.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = new Error("spawn powershell.exe ENOENT");
    const answer = await getElementBounds("App", "Save") as { error?: string };
    expect(answer.error).toMatch(/ENOENT/);
  });

  it("does not tell a plain failure it was cut off, because only one of them means 'wait'", async () => {
    // FOUND BY MUTATION (gate 2): making the heading unconditional kills nothing — the two cells
    // above assert only the tail. A read that failed outright would then advise waiting for a
    // slowness that is not there.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = Object.assign(new Error("Command failed: powershell.exe -Command …"), {
      killed: false, signal: null, stderr: "the real reason", stdout: "",
    });
    const answer = await getElementBounds("App", "Save") as { error?: string };
    expect(answer.error).toMatch(/^PowerShell read failed/);
    expect(answer.error).not.toMatch(/cut off/);
  });

  it("clamps a long message that has no script behind it", async () => {
    // FOUND BY MUTATION (gate 2): dropping the clamp on that branch kills nothing, because no cell
    // drives a long message down it.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = new Error("spawn failed: " + "y".repeat(2000));
    const answer = await getElementBounds("App", "Save") as { error?: string };
    expect(answer.error!.length).toBeLessThan(400);
  });

  it("does not read a number as an element", async () => {
    // `5`, `"text"` and `null` are valid JSON. Without a guard the first two become a truthy
    // `found` with no fields, which downstream reads as an element with no rectangle and advises
    // scrolling something that does not exist (gate 2) — a wrong answer, not a crash.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    for (const printed of ["5", '"text"', "null"]) {
      scripts_reset();
      psOutputs.push(printed);
      expect(await getElementBounds("App", "Save"), printed).toMatchObject({ found: null, why: "read_failed", via: "powershell" });
    }
  });

  it("does not read an ARRAY as an element, which is the hole the object check left open", async () => {
    // GATE 2, THIRD PASS. `typeof [] === "object"` and `[] !== null`, so an array walked straight
    // past a guard written to stop exactly this class and became `found: []` — truthy, no fields,
    // read downstream as an element with no rectangle. Today's script cannot print one; the guard
    // is a TIER, and a tier with a gap in it is the shape this whole change is about.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    for (const printed of ["[]", '[{"name":"Save"}]']) {
      scripts_reset();
      psOutputs.push(printed);
      expect(await getElementBounds("App", "Save"), printed).toMatchObject({ found: null, why: "read_failed", via: "powershell" });
    }
  });

  it("does not call an outside kill our own budget, because only one of them means 'wait'", async () => {
    // FOUND BY MUTATION (gate 2): `killed === true` → `signal !== undefined` survives every cell.
    // It is not equivalent — measured on node, a process killed by SOMEONE ELSE arrives as
    // `{killed:false, signal:"SIGTERM"}`. Under the mutant that becomes `read_unfinished`, whose
    // advice is "wait, the slowness may pass"; nothing will change, because nothing timed out.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = Object.assign(new Error("Command failed"), { killed: false, signal: "SIGTERM" });
    expect(await getElementBounds("App", "Save")).toMatchObject({ found: null, why: "read_failed" });
  });

  it("keeps what the script said when it said something this road does not recognise", async () => {
    // FOUND BY MUTATION (gate 2): the third-string arm mapping to `element_not_found` survives,
    // because no cell drives an error outside the two known strings. And `unreadable` here does
    // NOT mean what it means on the native road: the script said something specific, and only
    // this file failed to recognise it — so it carries the words rather than shrugging.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psOutputs.push('{"error":"Access is denied. (0x80070005)"}');
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: null, why: "unreadable", via: "powershell" });
    expect((answer as { error?: string }).error).toMatch(/Access is denied/);
  });

  it("uses an answer the script printed before it was killed", async () => {
    // Measured on node (gate 2): a child that prints a complete answer and is THEN killed at the
    // timeout arrives as `{killed:true, signal:"SIGTERM", stdout:'…'}`. Answering "nothing was
    // learned" would throw away the one thing that was.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psThrows = Object.assign(new Error("Command failed: powershell.exe"), {
      killed: true, stdout: '{"error":"Window not found"}',
    });
    expect(await getElementBounds("Nothing", "Save")).toMatchObject({ found: null, why: "window_not_found", via: "powershell" });
  });

  it("names PowerShell, not nobody, when PowerShell answered with something unreadable", async () => {
    // A client spoke; it spoke nonsense. `via: "none"` would be a claim the code cannot support.
    nativeAnswer = () => { throw new Error("engine unavailable"); };
    psOutputs.push("not json at all");
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: null, why: "read_failed", via: "powershell" });
    expect((answer as { error?: string }).error).toMatch(/not JSON/);
  });

  it("credits no client when no client answered", async () => {
    // "If the native client fails, the PowerShell road answers" is false when the cause of the
    // failure is SLOWNESS — both budgets are 8000 ms and they are spent serially (win2,
    // `0c5547d`). Writing `via: "powershell"` on that answer would name a client that never spoke.
    nativeAnswer = () => { throw new Error("UIA operation timed out after 8000ms"); };
    psThrows = Object.assign(new Error("Command failed"), { killed: true });
    expect(await getElementBounds("App", "Save")).toMatchObject({ via: "none" });
  });

  it("says the native road cannot tell the two apart, instead of picking one", async () => {
    // THE HONEST VALUE, and the one a later Rust change replaces. `Ok(None)` really does mean both
    // things today; writing `element_not_found` here would be a guess with a measured 50% chance
    // of sending the caller to re-read a name that was fine.
    nativeAnswer = () => null;
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: null, why: "unreadable", via: "native" });
    // …and it did NOT fall back: a "no" is an answer, only a throw is a failure. The proof is
    // `via: "native"` above plus a mock that now THROWS on an unqueued script — the old
    // `expect(psOutputs).toHaveLength(0)` was true whether or not the road ran (gate 2).
  });
});

describe("the bridge says which client answered", () => {
  it("names the native client when the native client answered", async () => {
    nativeAnswer = () => ELEMENT;
    expect(await getElementBounds("App", "Save")).toMatchObject({ found: ELEMENT, via: "native" });
  });

  it("names the PowerShell client, and what the native one threw, when the road changed mid-call", async () => {
    // The measured case: the window's UI thread hangs, the native call times out, PowerShell
    // answers. Before this the caller got `{name:"Save",…}` and could not tell it from an answer
    // the engine gave — while the two clients name some controls differently (internal #136).
    nativeAnswer = () => { throw new Error("UIA operation timed out after 8000ms"); };
    psOutputs.push(JSON.stringify(ELEMENT));
    const answer = await getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: ELEMENT, via: "powershell" });
    expect((answer as { nativeFailed?: string }).nativeFailed).toMatch(/timed out after 8000ms/);
  });

  it("carries the fall-back onto a MISS too, which is the shape that hides the vocabulary", async () => {
    // The harm this makes visible, in the shape win2 predicted for the machine: on a WinForms
    // window, `最小化` is what the native client calls the caption button and `Minimize` is what
    // this one calls it. With the engine hung, the same call falls back and the answer becomes
    // "not found" — for an element that is on the screen the whole time. Without `nativeFailed`
    // the caller sees a plain miss and blames the name.
    nativeAnswer = () => { throw new Error("UIA operation timed out after 8000ms"); };
    psOutputs.push('{"error":"Element not found"}');
    const answer = await getElementBounds("App", "最小化");
    expect(answer).toMatchObject({ found: null, why: "element_not_found", via: "powershell" });
    expect((answer as { nativeFailed?: string }).nativeFailed).toBeDefined();
  });

  it("says nothing about the native client when it was never asked", async () => {
    // `nativeFailed` is evidence that a fall-back HAPPENED. Present on every PowerShell answer it
    // would say nothing; absent here, a caller can read it as "the road did not change".
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", "1");
    vi.resetModules();
    const fresh = await import("../../src/engine/uia-bridge.js");
    psOutputs.push(JSON.stringify(ELEMENT));
    const answer = await fresh.getElementBounds("App", "Save");
    expect(answer).toMatchObject({ found: ELEMENT, via: "powershell" });
    expect(answer).not.toHaveProperty("nativeFailed");
  });
});
