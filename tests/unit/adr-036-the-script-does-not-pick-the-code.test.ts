/**
 * internal #148 — a PowerShell failure must not hand the caller the script, and the script must
 * not choose the error code.
 *
 * MEASURED 2026-09-21 win2 on main `5bcd2cc3` (internal `58f4d6a`, `run-698-main/`): with a
 * window's UI thread hung, `get_ui_elements` answered **`InvokePatternNotSupported`** after
 * 18049 ms, with five suggestions about invoke patterns — about a window that was merely not
 * answering, whose element supports invoke perfectly well.
 *
 * The mechanism is three steps and none of them is a decision:
 *   1. `execFile` builds `Command failed: <the whole command line>`, and the command line is the
 *      script;
 *   2. the discover script contains `$wantedPats.Add('InvokePattern')` (`uia-bridge.ts:403`);
 *   3. `classify` reads messages by substring.
 *
 * Controls from the same round: a miss with no hang answered `WindowNotFound` in 539 ms, and the
 * same title before the hang answered nine elements in 114 ms. The defect is the hung path only.
 *
 * #697 clamped this at ONE road. These cells hold the clamp on the producer, where a road written
 * later cannot miss it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let psError: (Error & Record<string, unknown>) | null = null;

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    if (psError) { cb(psError, { stdout: "", stderr: "" }); return; }
    cb(null, { stdout: '{"elements":[]}', stderr: "" });
  },
}));
vi.mock("../../index.js", () => ({ default: {} }));

vi.resetModules();
const { runPS, isPowerShellFailure, getElementBounds } = await import("../../src/engine/uia-bridge.js");

beforeEach(() => { psError = null; });

/** What `execFile` really throws: the message carries the command, and the command is the script. */
const execFileFailure = (extra: Record<string, unknown> = {}) =>
  Object.assign(
    new Error(
      "Command failed: powershell.exe -NoProfile -NonInteractive -Command \n" +
      "$wantedPats = New-Object System.Collections.Generic.List[string]\n" +
      "$wantedPats.Add('InvokePattern')\n" +
      "$root = [System.Windows.Automation.AutomationElement]::RootElement\n",
    ),
    extra,
  ) as Error & Record<string, unknown>;

describe("internal #148 — the script leaves the failure at the producer", () => {
  it("does not hand the caller the script it just ran", async () => {
    psError = execFileFailure({ killed: true, stdout: "", stderr: "" });
    const err = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(err.message).not.toMatch(/InvokePattern/);
    expect(err.message).not.toMatch(/powershell\.exe/);
    expect(err.message).not.toMatch(/AutomationElement/);
    // 64 characters, measured: the whole message is the heading when there is no stderr.
    expect(err.message.length).toBeLessThan(200);
  });

  it("keeps the fields the roads read, because clamping a message is not discarding evidence", async () => {
    psError = execFileFailure({ killed: true, stdout: '{"name":"Save"}', stderr: "some words" });
    const err = await runPS("$x = 1").catch((e: unknown) => e as Error & Record<string, unknown>);
    expect(isPowerShellFailure(err)).toBe(true);
    // `killed` is what separates this module's own budget from someone else's kill; `stdout` is
    // the answer a killed process may already have printed and `getElementBounds` salvages it.
    expect(err["killed"]).toBe(true);
    expect(err["stdout"]).toBe('{"name":"Save"}');
    expect(err["stderr"]).toBe("some words");
  });

  it("says which silence it was, and carries what the client said", async () => {
    psError = execFileFailure({ killed: false, stderr: "Access is denied." });
    const cutOff = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(cutOff.message).toMatch(/PowerShell read failed: Access is denied\./);

    psError = execFileFailure({ killed: true, stderr: "" });
    const killed = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(killed.message).toMatch(/cut off at its own budget/);
  });

  it("does not clamp away a message that is NOT the command line, because there it is the finding", async () => {
    // A spawn failure has no `stderr` field at all and its message is the whole evidence.
    psError = Object.assign(new Error("spawn powershell.exe ENOENT"), {}) as Error & Record<string, unknown>;
    const err = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/spawn powershell\.exe ENOENT/);
  });

  it("still separates a read that was cut off from one that failed, on the road #697 built", async () => {
    // The control for the road that already had the clamp: moving it to the producer must not
    // collapse the two silences `getElementBounds` reports.
    psError = execFileFailure({ killed: true, stdout: "", stderr: "" });
    expect(await getElementBounds("App", "Save")).toMatchObject({ why: "read_unfinished", via: "none" });

    psError = execFileFailure({ killed: false, stdout: "", stderr: "" });
    expect(await getElementBounds("App", "Save")).toMatchObject({ why: "read_failed", via: "none" });
  });

  it("still salvages an answer a killed process had already printed", async () => {
    // The other half of #697's road: the kill is not a reason to throw away what was read.
    psError = execFileFailure({
      killed: true,
      stdout: '{"name":"Save","controlType":"Button","automationId":"btnSave","boundingRect":{"x":1,"y":2,"width":3,"height":4},"value":null}',
      stderr: "",
    });
    expect(await getElementBounds("App", "Save")).toMatchObject({ found: { name: "Save" }, via: "powershell" });
  });
});
