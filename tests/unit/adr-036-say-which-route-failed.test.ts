/**
 * An aimed act the UIA route could not finish says which failure it was — when it is one the
 * backend is known to give, and nothing more when it is not.
 *
 * ADR-036, the `aim_route_failed` classifier. win2's P1 round (2026-09-11,
 * `dev/route-failure-strings/RESULTS.md`) measured the gap on a real machine: an element REMOVED
 * (arm Pi-a) and an element present with no Invoke pattern (arm Pi-b) returned the same caller
 * sentence, word for word — two failures with opposite recoveries, indistinguishable to the caller.
 * The same round collected every string the backend gave, and the classifier matches those strings
 * and no others.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyUiaRouteFailure } from "../../src/engine/uia-route-failure.js";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

/** Every string the backend returned in that round, verbatim, with the class it belongs to. */
const MEASURED: Array<[string, string]> = [
  ["Element not found", "element_not_found"],
  ["InvokePattern not supported by this element", "pattern_not_supported"],
  ["ValuePattern not supported by this element", "pattern_not_supported"],
  ['Exception calling "GetCurrentPattern" with "1" argument(s): "Unsupported Pattern."', "pattern_not_supported"],
  ["Element is disabled", "element_disabled"],
  ['Exception calling "SetValue" with "1" argument(s): "The operation is not allowed on a nonenabled element."', "element_disabled"],
];

describe("the classifier knows the answers the backend gave, and only those", () => {
  it.each(MEASURED)("reads %j as %s", (text, kind) => {
    expect(classifyUiaRouteFailure(new Error(text))).toBe(kind);
  });

  it("does not read a shell rejection as a failure it names, though the script carries the same words", () => {
    // The PowerShell road's rejection is `Command failed:` plus the whole script, and the script
    // contains the literals it would have printed. A substring match would call this "not found".
    const rejection = new Error(
      'Command failed: powershell.exe -NoProfile -Command "if (-not $el) { @{ok=$false; error=\'Element not found\'} | ConvertTo-Json }"',
    );
    expect(classifyUiaRouteFailure(rejection)).toBeUndefined();
  });

  it("does not guess at a text it has not seen, a localised one included", () => {
    for (const text of [
      "要素が見つかりません",
      'Exception calling "Invoke" with "0" argument(s): "Operation is not valid due to the current state of the object."',
      "UIA click failed",
      "Element not found: ALPHA",
      "",
    ]) {
      expect(classifyUiaRouteFailure(new Error(text)), text).toBeUndefined();
    }
    expect(classifyUiaRouteFailure("Element not found")).toBeUndefined();
  });
});

describe("the refusal says which failure it was", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "route-failed-"));
    logPath = join(dir, "aim-probe.jsonl");
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  const HWND = 4919n;
  const aim: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };
  const alpha: UiEntity = {
    entityId: "u1", role: "button", label: "ALPHA", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "ALPHA", automationId: "ALPHA" } },
    affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
  };

  function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
    return {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
      mouseClick: vi.fn(async () => {}),
      ...over,
    };
  }

  type Refusal = Error & { callerDetail: string };

  async function refusalOn(action: "click" | "type", d: ExecutorDeps, text?: string): Promise<Refusal> {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const thrown = await createDesktopExecutor(aim, d)(alpha, action, text).then(() => undefined, (e: unknown) => e);
    expect(thrown, "the aimed route has to refuse for this cell to say anything").toBeInstanceOf(Error);
    expect(d.mouseClick).not.toHaveBeenCalled();
    return thrown as Refusal;
  }

  const clickFailingWith = (err: Error) => refusalOn("click", deps({ uiaClick: vi.fn(async () => { throw err; }) }));

  function refusalRows(): Array<Record<string, unknown>> {
    return readFileSync(logPath, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.route === "refusal");
  }

  it("tells the element that has gone from the element that cannot be invoked", async () => {
    // The measured gap, as a pair: arms Pi-a and Pi-b returned the same sentence on `5b5b4d58`.
    const gone = await clickFailingWith(new Error("Element not found"));
    const noInvoke = await clickFailingWith(new Error("InvokePattern not supported by this element"));
    expect(gone.callerDetail).not.toBe(noInvoke.callerDetail);
    expect(gone.callerDetail).toContain("was not found in that window's accessibility tree");
    expect(noInvoke.callerDetail).toContain("does not support this action through UI Automation");
  });

  it("says nothing it cannot vouch for, and never the backend's words", async () => {
    const e = await clickFailingWith(new Error('Command failed: powershell.exe -NoProfile -Command "…$secret… Element not found …"'));
    // Exactly the sentence this refusal had before the classifier existed.
    expect(e.callerDetail).toBe(`The UIA route to window ${HWND} failed for "ALPHA", and the act was not finished as a coordinate click.`);
    expect(e.callerDetail).not.toContain("Command failed");
  });

  it("names the UIA value route's failure on a write, and not the text being typed", async () => {
    const e = await refusalOn("type", deps({
      uiaSetValue: vi.fn(async () => {
        throw new Error('Exception calling "SetValue" with "1" argument(s): "The operation is not allowed on a nonenabled element."');
      }),
      keyboardTypeBg: vi.fn(async () => { throw new Error("background write refused for PROBE-TYPED-TEXT"); }),
    }), "PROBE-TYPED-TEXT");
    expect(e.callerDetail).toContain("the UIA value route failed because the element is disabled, and the background write failed too");
    expect(e.callerDetail).not.toContain("PROBE-TYPED-TEXT");
    expect(e.callerDetail).not.toContain("Exception calling");
  });

  it("writes the class into the refusal row, and never the backend's text", async () => {
    await clickFailingWith(new Error("InvokePattern not supported by this element"));
    await clickFailingWith(new Error('Command failed: powershell.exe "…SECRET-SCRIPT-BODY…"'));
    expect(refusalRows().map((r) => [r.rung, r.refused, r.routeFailure])).toEqual([
      ["uia_click", "aim_route_failed", "pattern_not_supported"],
      ["uia_click", "aim_route_failed", null],
    ]);
    expect(readFileSync(logPath, "utf8")).not.toContain("SECRET-SCRIPT-BODY");
  });

  it("keeps the reason the envelope uses, and hands it this sentence as the detail", async () => {
    const e = await clickFailingWith(new Error("Element is disabled"));
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(alpha, "view-1");
    const loop = new GuardedTouchLoop(store, {
      resolveLiveEntities:      () => [alpha],
      currentGeneration:        () => "gen-1",
      isModalBlocking:          () => false,
      checkViewport:            () => null,
      execute:                  async () => { throw e; },
      resolvePostTouchEntities: async () => [],
    });
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("aim_route_failed");
      expect(result.detail).toBe(e.callerDetail);
      expect(result.detail).toContain("the element is disabled");
    }
  });
});
