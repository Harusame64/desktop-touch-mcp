/**
 * internal #126 — a disabled element is not pressed, and the modal check writes what it asked.
 *
 * MEASURED 2026-09-19 win2 (internal `248304a`, arm 3): the main window `Enabled=false`, no modal.
 * UIA answered "Element is disabled", the title-only road downgraded to a coordinate press, the
 * fixture recorded no click, and `desktop_act` answered `ok:true` with `motion:"any_change"`. That is
 * the forbidden road of 2026-09-11: a success reported for an act that did not happen.
 *
 * "Disabled" is what the route answered for the element it MATCHED, and both clients match by a
 * name substring. So the refusal needs item 16's condition (the native client read the entity and
 * answered the click) AND evidence that the answer is about this element: the OS saying its own
 * window, or the window it was captured in, does not take input. An AutomationId is not unique.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Aim } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";

const titleOnly: Aim = { kind: "aim", title: "AIM-FIXTURE" };

function uiaEntity(via: "native" | "powershell" = "native", over: { automationId?: string; nativeWindowHandle?: string } = { automationId: "TARGET" }): UiEntity {
  return {
    entityId: "u1", role: "button", label: "TARGET", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "TARGET", via, ...over } },
    affordances: [{ verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 100, y: 200, width: 80, height: 30 },
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const failingWith = (text: string, uiaVia: "native" | "powershell" = "native") =>
  vi.fn(async () => { throw Object.assign(new Error(text), { uiaVia }); });

let dir: string;
let logPath: string;
const rows = (): Record<string, unknown>[] =>
  readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "disabled-element-"));
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

async function act(d: ExecutorDeps, e: UiEntity = uiaEntity()): Promise<unknown> {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(titleOnly, d)(e, "click").then((outcome) => outcome, (err: unknown) => err);
}

describe("a title-only click on an element UIA reports disabled", () => {
  it("is refused as aim_route_failed, and nothing is pressed", async () => {
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput: (h: bigint) => h !== 900n });
    const thrown = await act(d, uiaEntity("native", { automationId: "TARGET", nativeWindowHandle: "900" }));
    expect((thrown as Error).name).toBe("AimedRouteFailedError");
    expect(d.mouseClick).not.toHaveBeenCalled();
    const detail = (thrown as { callerDetail: string }).callerDetail;
    expect(detail).toContain('"TARGET"');
    expect(detail).toContain("is disabled");
    // The engine's words, never the backend's text.
    expect(detail).not.toContain("Element is disabled");
    const refusal = rows().find((r) => r.route === "refusal");
    expect(refusal).toMatchObject({ rung: "uia_downgrade", refused: "aim_route_failed", routeFailure: "element_disabled", evidence: "own_window_disabled" });
    expect(rows().some((r) => r.route === "mouse")).toBe(false);
  });

  it("keeps the downgrade when the only thing narrowing the match is an AutomationId — it is not unique", async () => {
    // codex on #685: templated items share an AutomationId with their name, and the search takes
    // the first match — a disabled one discovery's enabled-only filter never showed.
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput: () => true });
    await act(d, uiaEntity("native", { automationId: "TARGET" }));
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the downgrade with NO evidence the answer is about this element — no AutomationId, no window state", async () => {
    // Gate 2 on this change: the native route matches by a name substring too, first in tree order,
    // so a disabled "TARGET list" earlier in the tree answers for an enabled "TARGET". Believing
    // "disabled" there refused a press that would have worked.
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput: () => undefined });
    await act(d, uiaEntity("native", {}));
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("refuses without an AutomationId when the element's OWN window does not take input", async () => {
    const windowTakesInput = vi.fn((h: bigint) => (h === 900n ? false : true));
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput });
    const thrown = await act(d, uiaEntity("native", { nativeWindowHandle: "900" }));
    expect((thrown as Error).name).toBe("AimedRouteFailedError");
    expect(d.mouseClick).not.toHaveBeenCalled();
    expect(windowTakesInput).toHaveBeenCalledWith(900n);
    expect(rows().find((r) => r.route === "refusal")).toMatchObject({ evidence: "own_window_disabled" });
  });

  it("refuses without an AutomationId when the window the entity was captured in does not take input (arm 3's shape)", async () => {
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput: (h: bigint) => (h === 500n ? false : true) });
    const e = { ...uiaEntity("native", {}), origin: { kind: "window" as const, id: "AIM-FIXTURE", hwnd: "500" } };
    const thrown = await act(d, e);
    expect((thrown as Error).name).toBe("AimedRouteFailedError");
    expect(d.mouseClick).not.toHaveBeenCalled();
    expect(rows().find((r) => r.route === "refusal")).toMatchObject({ evidence: "window_disabled" });
  });

  it("keeps the downgrade when the OS could not be asked about the captured window — not asked is not evidence", async () => {
    // A mutation that read `undefined` as "does not take input" survived without this cell.
    const d = deps({ uiaClick: failingWith("Element is disabled"), windowTakesInput: () => undefined });
    const e = { ...uiaEntity("native", {}), origin: { kind: "window" as const, id: "AIM-FIXTURE", hwnd: "500" } };
    await act(d, e);
    expect(d.mouseClick).toHaveBeenCalled();
  });

  it("keeps the downgrade when the PowerShell client answered — the element it matched need not be this one", async () => {
    // The by-title scripts take the first descendant whose name contains the label; "disabled" can
    // be about a heading "TARGET list" (`uia-route-failure.ts`). Item 16's condition, kept.
    const d = deps({ uiaClick: failingWith("Element is disabled", "powershell") });
    await act(d);
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the downgrade when the PowerShell client read the entity", async () => {
    const d = deps({ uiaClick: failingWith("Element is disabled") });
    await act(d, uiaEntity("powershell"));
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the downgrade it exists for: the element is there and has no Invoke", async () => {
    const d = deps({ uiaClick: failingWith("InvokePattern not supported by this element") });
    const outcome = await act(d);
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
    expect(outcome).toMatchObject({ kind: "mouse", downgrade: { from: "uia" } });
  });
});

describe("the modal check writes an act.modal row for what it asked", () => {
  async function find(entity: Partial<UiEntity>, aim: Aim | undefined, over: Record<string, unknown> = {}) {
    const { productionFindBlockingWindow } = await import("../../src/tools/desktop-register.js");
    return productionFindBlockingWindow({ ...uiaEntity(), ...entity } as UiEntity, aim, {
      root: (h: bigint) => h,
      owner: (h: bigint) => (h === 777n ? 500n : null),
      isEnabled: (h: bigint) => h === 777n,
      isVisible: () => true,
      threadOf: () => 1,
      topLevelWindows: () => [777n, 500n],
      title: () => "Save changes?",
      className: () => "#32770",
      ...over,
    });
  }
  const modalRow = () => rows().find((r) => r.seam === "act.modal");

  it("says it asked NOTHING when neither the entity nor the aim has a handle", async () => {
    // The user's call, 2026-09-19: recorded in the row, not in the response. A check that asked
    // nothing answered exactly like one that found the window clear (win2).
    expect(await find({ origin: { kind: "window", id: "AIM-FIXTURE" } }, titleOnly)).toBeNull();
    expect(modalRow()).toMatchObject({ asked: false, askedFrom: null, handle: null, answer: "no_handle" });
  });

  it("names the handle it asked and what it found", async () => {
    await find({ origin: { kind: "window", id: "AIM-FIXTURE", hwnd: "500" } }, undefined);
    expect(modalRow()).toMatchObject({ asked: true, askedFrom: "entity_origin", handle: "500", answer: "blocked", blocker: "777" });
  });

  it("says the window was enabled when it was", async () => {
    await find({ origin: { kind: "window", id: "AIM-FIXTURE", hwnd: "500" } }, undefined, { isEnabled: () => true });
    expect(modalRow()).toMatchObject({ asked: true, answer: "window_enabled" });
  });

  it("says the aim's window was asked when the entity had no handle", async () => {
    await find({ origin: { kind: "window", id: "AIM-FIXTURE" } }, { kind: "aim", title: "AIM-FIXTURE", hwnd: 500n }, {
      identityNow: () => undefined,
    });
    expect(modalRow()).toMatchObject({ asked: true, askedFrom: "aim", handle: "500" });
  });
});
