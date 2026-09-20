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
    cb(null, { stdout: psOutputs.shift() ?? "{}", stderr: "" });
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
    // …and it did NOT fall back: a "no" is an answer, only a throw is a failure.
    expect(psOutputs).toHaveLength(0);
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
