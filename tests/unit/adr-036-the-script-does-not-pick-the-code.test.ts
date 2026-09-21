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
const { runPS, isPowerShellFailure, getElementBounds, getUiElements } = await import("../../src/engine/uia-bridge.js");

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
    // A spawn failure's message is the whole evidence, and node's `Command failed:` prefix is the
    // boundary (hardcoded and unlocalised in node, so the test is on the string it really emits).
    //
    // THE FIXTURE SAID SOMETHING THE PRODUCER DOES NOT DO (gate 2): it claimed a spawn failure has
    // no `stderr` field at all. Promisified `execFile` attaches `stdout`/`stderr` as `""` to EVERY
    // rejection, spawn errors included — so the cell passed because `""` is falsy after `.trim()`,
    // not because the field was absent. Same fixture-versus-producer mismatch `shortPsFailure`'s
    // own doc records from an earlier round; the shape is the producer's now.
    psError = Object.assign(new Error("spawn powershell.exe ENOENT"), { stdout: "", stderr: "", code: "ENOENT" }) as Error & Record<string, unknown>;
    const err = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/spawn powershell\.exe ENOENT/);
  });

  it("keeps the first line of stderr and not the source line under it", async () => {
    // GATE 2: PowerShell's NormalView error record is the message, then `At line:N char:M`, then
    // THE OFFENDING SOURCE LINE — which is the script. Keeping 300 characters of stderr put the
    // script back through the other door, carrying both a code-deciding token and, on the write
    // roads, the caller's own typed text (`$vp.SetValue('…')`).
    psError = execFileFailure({
      killed: false,
      stderr: [
        "Exception calling \"SetValue\" with \"1\" argument(s): \"Value does not fall within the expected range.\"",
        "At line:12 char:5",
        "+     $vp.SetValue('hunter2')",
        "+     ~~~~~~~~~~~~~~~~~~~~~~~",
        "    + CategoryInfo          : NotSpecified: (:) [], MethodInvocationException",
      ].join("\r\n"),
    });
    const err = await runPS("$x = 1").catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/Value does not fall within the expected range/);
    expect(err.message).not.toMatch(/hunter2/);
    expect(err.message).not.toMatch(/At line:/);
    expect(err.message).not.toMatch(/CategoryInfo/);
  });

  it("uses a tree the killed process had already printed, instead of saying nothing was observed", async () => {
    // GATE 2's P1. The clamp carries `stdout` BECAUSE a killed process may have answered first —
    // and the discover road threw it away, then published "nothing was observed" about a complete
    // tree sitting in `err.stdout`. `getElementBounds` has salvaged this since #697; this is the
    // same shape one road over.
    psError = execFileFailure({
      killed: true,
      stdout: '{"windowTitle":"App","elementCount":1,"elements":[{"name":"Save","type":"Button"}]}',
      stderr: "",
    });
    const answer = await getUiElements("App", 3, 50, 10000);
    expect(answer).toMatchObject({ windowTitle: "App", via: "powershell" });
    expect(answer.elements).toHaveLength(1);
  });

  it("does not salvage a half-printed tree, or one that carries an error", async () => {
    // The control for the arm above: only a parseable answer WITHOUT an `error` key is an answer.
    psError = execFileFailure({ killed: true, stdout: '{"windowTitle":"App","elem', stderr: "" });
    await expect(getUiElements("App", 3, 50, 10000)).rejects.toThrow(/cut off at its own budget/);

    psError = execFileFailure({ killed: true, stdout: '{"error":"Window not found"}', stderr: "" });
    await expect(getUiElements("App", 3, 50, 10000)).rejects.toThrow(/cut off at its own budget/);
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
