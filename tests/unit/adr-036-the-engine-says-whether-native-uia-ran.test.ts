/**
 * Whether native UIA ran, answered by the engine and the OS rather than by the switch (ADR-036 H2).
 *
 * `DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1` sends UIA through PowerShell, and `nativeUiaState()` reports it.
 * But that report reads the same env var the switch does, so it confirms the configuration and proves
 * nothing about what ran. #626's second gate found native UIA running under the switch anyway:
 * foreground_flash's paste-warning scan started the UIA thread from inside a win32 call.
 *
 * The addon now counts, where its COM thread starts and where a task is sent to it, and asks the OS
 * whether UIAutomationCore.dll is loaded. This file pins how the TypeScript side reads that:
 *   - from the binding, not from `nativeUia`, which the switch nulls;
 *   - on every call;
 *   - `null` when it cannot say — never zeros.
 *
 * The addon is a stand-in (`../../index.js` mocked): this machine has none. The counts themselves are
 * the engine's, and a real-machine round proves them.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QUIET = { comThreadStarts: 0, tasksSent: 0, uiaCoreLoaded: false };
const RAN = { comThreadStarts: 1, tasksSent: 3, uiaCoreLoaded: true };

/**
 * Load the real native-engine over a stand-in addon that has the UIA engine and, unless `evidence` is
 * undefined, the evidence export answering with `evidence` (or calling it, when it is a function).
 */
async function engineWith(evidence: unknown, env: string | undefined = "1") {
  const binding: Record<string, unknown> = {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    uiaGetElements: async () => ({ windowTitle: "T", elementCount: 0, elements: [] }),
    ...(evidence !== undefined && { uiaEngineEvidence: typeof evidence === "function" ? evidence : () => evidence }),
  };
  vi.resetModules();
  vi.doMock("../../index.js", () => ({ default: binding }));
  // Stubbed every time, `undefined` included, so a switch left set in the shell cannot decide a cell.
  vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", env);
  return await import("../../src/engine/native-engine.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../index.js");
  vi.resetModules();
});

describe("nativeUiaEvidence", () => {
  it("passes the engine's own answer through, whatever the switch says", async () => {
    expect((await engineWith(RAN, "1")).nativeUiaEvidence()).toEqual(RAN);
    expect((await engineWith(QUIET, undefined)).nativeUiaEvidence()).toEqual(QUIET);
  });

  it("is read from the binding, so the switch that nulls nativeUia does not hide it", async () => {
    const engine = await engineWith(RAN, "1");
    expect(engine.nativeUia).toBeNull();
    expect(engine.nativeUiaState()).toBe("disabled");
    // The case #626's second gate found: configured off, and the engine ran anyway.
    expect(engine.nativeUiaEvidence()).toMatchObject({ comThreadStarts: 1, tasksSent: 3 });
  });

  it("is read on every call, so a check made after the act sees what the act did", async () => {
    let answer: typeof QUIET = QUIET;
    const engine = await engineWith(() => answer);
    expect(engine.nativeUiaEvidence()).toEqual(QUIET);
    answer = RAN;
    expect(engine.nativeUiaEvidence()).toEqual(RAN);
  });

  it("says it cannot say — null, not zeros — when the addon has no such export", async () => {
    expect((await engineWith(undefined)).nativeUiaEvidence()).toBeNull();
  });

  it("says it cannot say when the call throws, or the answer is not the shape it should be", async () => {
    expect((await engineWith(() => { throw new Error("gone"); })).nativeUiaEvidence()).toBeNull();
    expect((await engineWith(null)).nativeUiaEvidence()).toBeNull();
    expect((await engineWith({ comThreadStarts: 0, tasksSent: 0 })).nativeUiaEvidence()).toBeNull();
    expect((await engineWith({ comThreadStarts: "0", tasksSent: 0, uiaCoreLoaded: false })).nativeUiaEvidence()).toBeNull();
  });

  it("does not hand back the addon's object itself, only the three facts", async () => {
    const engine = await engineWith({ ...RAN, extra: "not ours" });
    expect(engine.nativeUiaEvidence()).toEqual(RAN);
  });
});

describe("where it is reported", () => {
  it("server_status carries it, read at the call", async () => {
    let answer: typeof QUIET = QUIET;
    await engineWith(() => answer, "1");
    const { getEngineStatus } = await import("../../src/engine/status.js");
    expect(getEngineStatus()).toMatchObject({ uia: "powershell", nativeUia: "disabled", nativeUiaEvidence: QUIET });
    answer = RAN;
    expect(getEngineStatus().nativeUiaEvidence).toEqual(RAN);
  });

  it("server_status says null, not zeros, when the addon cannot say", async () => {
    await engineWith(undefined, "1");
    const { getEngineStatus } = await import("../../src/engine/status.js");
    expect(getEngineStatus()).toHaveProperty("nativeUiaEvidence", null);
  });

  it("the probe's row zero carries it, beside the switch it checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uia-evidence-"));
    const path = join(dir, "aim-probe.jsonl");
    try {
      vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
      vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", path);
      await engineWith(QUIET, "1");
      const { probeAim } = await import("../../src/engine/aim-probe.js");
      probeAim("see.enter", { key: "k" });
      const zero = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as Record<string, unknown>;
      expect(zero).toMatchObject({ seq: 0, seam: "probe.start", nativeUia: "disabled", nativeUiaEvidence: QUIET });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
