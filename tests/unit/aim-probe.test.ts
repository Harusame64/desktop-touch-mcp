/**
 * A probe that changes the run is not a probe.
 *
 * `aim-probe.ts` exists to record what the aim IS at each seam, while the mechanism it observes is
 * being moved toward the Reactive Perception Graph specification. That only works if it is inert
 * when off, silent about nothing, and incapable of throwing into the path it watches — the same
 * three properties every measuring tool in this repo has had to be taught the hard way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aim-probe-"));
  logPath = join(dir, "nested", "aim-probe.jsonl");
  vi.resetModules();
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

async function loadProbe() {
  return await import("../../src/engine/aim-probe.js");
}

describe("the probe is off unless it is asked for", () => {
  it("writes nothing, and says so, when the variable is unset", async () => {
    const { probeAim, aimProbeEnabled } = await loadProbe();
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;   // a path alone must not turn it on
    probeAim("see.enter", { key: "window:1" });
    expect(aimProbeEnabled()).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  it("writes one JSON line per seam when it is on", async () => {
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    const { probeAim } = await loadProbe();

    probeAim("see.enter", { key: "window:4919", rawTarget: null });
    probeAim("act.aim", { aimHwnd: "4919", winTitle: "Untitled - Notepad" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 1, seam: "see.enter", key: "window:4919" });
    expect(lines[1]).toMatchObject({ seq: 2, seam: "act.aim", aimHwnd: "4919" });
    // The directory did not exist: a probe that needs the operator to prepare a path is a probe
    // that does not run on the machine where the interesting failure happens.
    expect(lines[0]!.tsMs).toBeGreaterThan(0);
  });

  it("records an absent aim as a field, not as a missing row", async () => {
    // "The aim was empty here" and "this build never reached this line" have to be different
    // readings. Writing null is what keeps them apart.
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    const { probeAim } = await loadProbe();

    probeAim("act.aim", { aimHwnd: null, winTitle: "@active" });

    const row = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(Object.hasOwn(row, "aimHwnd")).toBe(true);
    expect(row.aimHwnd).toBeNull();
  });
});

describe("the probe cannot break what it observes", () => {
  it("swallows a path it cannot write to", async () => {
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    // A path whose parent is a FILE, so both the mkdir and the append fail.
    const blocker = join(dir, "blocker");
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = join(blocker, "deeper", "aim.jsonl");
    const { probeAim } = await loadProbe();
    const fs = await import("node:fs");
    fs.writeFileSync(blocker, "not a directory");

    expect(() => probeAim("see.enter", { key: "window:1" })).not.toThrow();
  });

  it("swallows a payload that cannot be serialised", async () => {
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    const { probeAim } = await loadProbe();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => probeAim("act.aim", circular)).not.toThrow();
    // A BigInt is the likelier accident on this path — every handle in the codebase is one — and
    // JSON.stringify throws on it. The rule is that callers convert; the probe must survive them
    // forgetting.
    expect(() => probeAim("act.aim", { aimHwnd: 4919n })).not.toThrow();
  });
});
