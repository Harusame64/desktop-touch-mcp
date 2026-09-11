/**
 * Discover records each control's own window handle — ADR-036 family 2, the observation the refusal needs.
 *
 * The user's contract for family 2 is to refuse a write when the grounds are clear. Its third ground
 * is "the keyboard rung's receiver is a different control in the same window". That could only be
 * decided from positions, and the title road, which is the commonest way of naming a window, records
 * no window position (`readOriginRectForTarget` answers nothing without a handle). So the user chose
 * to record the missing fact first. A Win32 or WinForms control is a window of its own, and its handle
 * is what the keyboard rung's WM_CHAR reaches when it holds the focus. A handle does not move with the
 * window, so "the receiver's handle is not the named control's" answers on either road.
 *
 * This changes nothing the act does. It carries UIA's `NativeWindowHandle` from both reads to the
 * entity, and the keyboard rung's row says whether its receiver is the named control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const MOCKED = [
  "../../src/engine/uia-bridge.js",
  "../../index.js",
  "../../src/engine/win32.js",
  "node:child_process",
];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of MOCKED) vi.doUnmock(m);
  vi.restoreAllMocks();
  vi.resetModules();
});

/** One enabled, named element, with or without its own handle. */
function element(nativeWindowHandle?: string | null) {
  return {
    name: "DELTA",
    automationId: "DELTA",
    controlType: "Edit",
    className: "WindowsForms10.EDIT.app.0.1",
    isEnabled: true,
    boundingRect: { x: 100, y: 200, width: 120, height: 24 },
    patterns: ["Value"],
    depth: 1,
    ...(nativeWindowHandle !== undefined && { nativeWindowHandle }),
  };
}

describe("the UIA lane carries each element's own handle to the entity", () => {
  async function candidatesFrom(el: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("../../src/engine/uia-bridge.js", () => ({
      getUiElements: vi.fn(async () => ({
        windowTitle: "RFS-CELL", windowRect: { x: 0, y: 0, width: 800, height: 600 },
        elementCount: 1, elements: [el], via: "native",
      })),
      detectUiaBlind: vi.fn().mockReturnValue({ blind: false }),
    }));
    const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
    const { resolveCandidates } = await import("../../src/engine/world-graph/resolver.js");
    const { candidates } = await fetchUiaCandidates({ windowTitle: "RFS-CELL" });
    return { candidates, entities: resolveCandidates(candidates, "gen-1") };
  }

  it("puts the handle on the candidate's UIA locator, and the resolver keeps it on the entity", async () => {
    const { candidates, entities } = await candidatesFrom(element("5001"));
    expect(candidates[0]!.locator?.uia).toMatchObject({ name: "DELTA", nativeWindowHandle: "5001" });
    expect(entities[0]!.locator?.uia).toMatchObject({ nativeWindowHandle: "5001" });
  });

  it("records none when the element has no window of its own, rather than an empty or zero one", async () => {
    const { candidates } = await candidatesFrom(element());
    expect(candidates[0]!.locator?.uia).not.toHaveProperty("nativeWindowHandle");
  });
});

/** The #626 stand-in: an addon whose UIA engine answers what it is given. */
async function bridgeOverAddon(uiaGetElements: unknown, disableNativeUia: string | undefined) {
  vi.resetModules();
  vi.doMock("../../index.js", () => ({
    default: {
      computeChangeFraction: () => 0,
      dhashFromRaw: () => 0n,
      hammingDistance: () => 0,
      uiaGetElements,
    },
  }));
  vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
    enumWindowsInZOrder: () => [], isExcludedTitle: () => false, isExcludedWindowHandle: () => false, isWindowGone: () => false,
  }));
  vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", disableNativeUia);
  return await import("../../src/engine/uia-bridge.js");
}

describe("the native read carries it", () => {
  it("passes the element's handle through, and reads Rust's None as absent", async () => {
    const { getUiElements } = await bridgeOverAddon(
      async () => ({ windowTitle: "RFS-CELL", elementCount: 2, elements: [element("5001"), element(null)] }),
      undefined,
    );
    const r = await getUiElements("RFS-CELL");
    expect(r.via).toBe("native");
    expect(r.elements[0]!.nativeWindowHandle).toBe("5001");
    expect(r.elements[1]!.nativeWindowHandle).toBeUndefined();
  });
});

describe("the PowerShell read carries it, written the way the window's handle is", () => {
  async function psRead(stdout: unknown) {
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_file: string, args: string[], _options: unknown, cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]!);
        cb(null, { stdout: JSON.stringify(stdout), stderr: "" });
      },
    }));
    // The switch sends the read down the PowerShell road.
    const { getUiElements } = await bridgeOverAddon(async () => { throw new Error("native must not answer"); }, "1");
    const r = await getUiElements("RFS-CELL");
    return { r, script: scripts.join("\n") };
  }

  it("masks the handle unsigned, drops zero, and adds it to the element only when there is one", async () => {
    const { script } = await psRead({ windowTitle: "RFS-CELL", elementCount: 0, elements: [] });
    // The same expression as $winHwnd: a plain [int64] would sign-extend a high-bit handle into a
    // negative string, and 0xFFFFFFFF is Int32 -1 in PowerShell (the item-15 lesson).
    expect(script).toContain("$eh = $el.Current.NativeWindowHandle");
    expect(script).toContain("if ($eh -ne 0) { $elHwnd = [string][uint32]([int64]$eh -band [uint32]::MaxValue) }");
    expect(script).toContain("if ($null -ne $elHwnd) { $elObj['nativeWindowHandle'] = $elHwnd }");
  });

  it("hands the script's answer through to the element", async () => {
    const { r } = await psRead({ windowTitle: "RFS-CELL", elementCount: 2, elements: [element("5001"), element()] });
    expect(r.via).toBe("powershell");
    expect(r.elements[0]!.nativeWindowHandle).toBe("5001");
    expect(r.elements[1]).not.toHaveProperty("nativeWindowHandle");
  });
});

describe("the keyboard rung's row says whether its receiver is the named control", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "own-handle-"));
    logPath = join(dir, "aim-probe.jsonl");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const HWND = 4919n; // the window
  const CTRL = 5001n; // the named control's own window
  const OTHER = 5002n; // another control in the same window
  const aim: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };
  const RECT = { x: 100, y: 200, width: 120, height: 24 };
  const READ_ONLY_PS = new Error('Exception calling "SetValue" with "1" argument(s): "Value is read-only."');

  function delta(ownHandle?: string): UiEntity {
    return {
      entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
      locator: { uia: { name: "DELTA", automationId: "DELTA", ...(ownHandle !== undefined && { nativeWindowHandle: ownHandle }) } },
      affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
    };
  }

  function writingTo(receiverHwnd: bigint | null): ExecutorDeps {
    const receipt: KeyboardReceipt = {
      windowHwnd: HWND, receiverHwnd, receiverClass: "WindowsForms10.EDIT.app.0.1",
      receiverRect: RECT, receiverRootHwnd: HWND, receiverStyle: 0x50010080,
    };
    return {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => { throw READ_ONLY_PS; }),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => receipt),
      mouseClick: vi.fn(async () => {}),
    };
  }

  async function rowFor(entity: UiEntity, d: ExecutorDeps) {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const answer = await createDesktopExecutor(aim, d)(entity, "type", "PROBE-OH");
    const rows = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { answer, row: rows.find((r) => r.seam === "act.route" && r.route === "keyboard") };
  }

  it("says yes when the receiver's handle is the named control's own", async () => {
    const { answer, row } = await rowFor(delta("5001"), writingTo(CTRL));
    expect(answer).toBe("keyboard"); // an observation: the act answers as it did
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: true, receiver: { hwnd: "5001" } });
  });

  it("says no when it is another control's", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(OTHER));
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: false, receiver: { hwnd: "5002" } });
  });

  it("cannot say — null, not false — when the named control has no handle of its own", async () => {
    const { row } = await rowFor(delta(), writingTo(OTHER));
    expect(row).toMatchObject({ entityHwnd: null, receiverIsEntity: null });
  });

  it("cannot say when the receiver is unknown", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(null));
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: null });
  });
});
