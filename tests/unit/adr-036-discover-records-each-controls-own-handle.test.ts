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
 * entity, and the keyboard rung's row says whether its receiver is the named control
 * (`receiverIsEntity`) or a window inside it (`receiverInEntity`). The second is what a compound
 * control needs, an editable ComboBox or a NumericUpDown, which keeps the focus in a child window of its
 * own. Both sides are compared as the unsigned low 32 bits, because UIA writes the control's handle
 * that way and `GetFocus` hands the receiver over widened to 64.
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
  "../../src/engine/bg-input.js",
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

  it("does not let the handle change who the element is: a recreated handle must not orphan a lease", async () => {
    const withIt = (await candidatesFrom(element("5001"))).entities[0]!;
    const other = (await candidatesFrom(element("9999"))).entities[0]!;
    const without = (await candidatesFrom(element())).entities[0]!;
    expect(other.entityId).toBe(withIt.entityId);
    expect(without.entityId).toBe(withIt.entityId);
    expect(other.evidenceDigest).toBe(withIt.evidenceDigest);
    expect(without.evidenceDigest).toBe(withIt.evidenceDigest);
  });
});

/** The #626 stand-in: an addon whose UIA engine answers what it is given. */
async function bridgeOverAddon(addon: Record<string, unknown>, disableNativeUia: string | undefined) {
  vi.resetModules();
  vi.doMock("../../index.js", () => ({
    default: {
      computeChangeFraction: () => 0,
      dhashFromRaw: () => 0n,
      hammingDistance: () => 0,
      ...addon,
    },
  }));
  vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
    enumWindowsInZOrder: () => [], isExcludedTitle: () => false, isExcludedWindowHandle: () => false, isWindowGone: () => false,
  }));
  vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", disableNativeUia);
  return await import("../../src/engine/uia-bridge.js");
}

describe("the native read carries it, and leaves the key out when Rust says None", () => {
  it("on the element read", async () => {
    const { getUiElements } = await bridgeOverAddon({
      uiaGetElements: async () => ({ windowTitle: "RFS-CELL", elementCount: 2, elements: [element("5001"), element(null)] }),
    }, undefined);
    const r = await getUiElements("RFS-CELL");
    expect(r.via).toBe("native");
    expect(r.elements[0]!.nativeWindowHandle).toBe("5001");
    expect(r.elements[1]).not.toHaveProperty("nativeWindowHandle");
  });

  it("on the children read (scope_element)", async () => {
    const { getElementChildren } = await bridgeOverAddon({
      uiaGetElements: async () => { throw new Error("not this read"); },
      uiaGetElementChildren: async () => [element("5001"), element(null)],
    }, undefined);
    const kids = await getElementChildren("RFS-CELL", "PANEL", undefined, undefined);
    expect(kids[0]!.nativeWindowHandle).toBe("5001");
    expect(kids[1]).not.toHaveProperty("nativeWindowHandle");
  });
});

describe("the PowerShell reads carry it, written the way the window's handle is", () => {
  /** The scripts the bridge hands PowerShell, with the addon out of the way. */
  async function scriptsFor(read: (bridge: typeof import("../../src/engine/uia-bridge.js")) => Promise<unknown>) {
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_file: string, args: string[], _options: unknown, cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]!);
        cb(null, { stdout: JSON.stringify({ windowTitle: "RFS-CELL", elementCount: 0, elements: [] }), stderr: "" });
      },
    }));
    // The switch sends the element read down the PowerShell road; an addon without the children
    // entry point sends the children read there too.
    const bridge = await bridgeOverAddon({ uiaGetElements: async () => { throw new Error("native must not answer"); } }, "1");
    await read(bridge);
    return scripts.join("\n");
  }

  // The same expression as $winHwnd: a plain [int64] would sign-extend a high-bit handle into a
  // negative string, and 0xFFFFFFFF is Int32 -1 in PowerShell (the item-15 lesson). The reset comes
  // first in each element's turn: without it a windowless element would inherit the handle of the
  // element read before it.
  const MASKED = String.raw`if \(\$eh -ne 0\) \{ \$elHwnd = \[string\]\[uint32\]\(\[int64\]\$eh -band \[uint32\]::MaxValue\) \}`;

  it("on the element read: resets per element, masks unsigned, drops zero, adds only when there is one", async () => {
    const script = await scriptsFor((b) => b.getUiElements("RFS-CELL"));
    expect(script).toMatch(new RegExp(String.raw`\$elHwnd = \$null\s+try \{\s+\$eh = \$el\.Current\.NativeWindowHandle\s+` + MASKED));
    expect(script).toContain("if ($null -ne $elHwnd) { $elObj['nativeWindowHandle'] = $elHwnd }");
  });

  it("on the children read, in the same form, so scope_element answers alike on either road", async () => {
    const script = await scriptsFor((b) => b.getElementChildren("RFS-CELL", "PANEL", undefined, undefined));
    expect(script).toMatch(new RegExp(String.raw`\$elHwnd = \$null\s+try \{\s+\$eh = \$c\.NativeWindowHandle\s+` + MASKED));
    expect(script).toContain("if ($null -ne $elHwnd) { $item['nativeWindowHandle'] = $elHwnd }");
  });
});

// ── The keyboard rung's row ─────────────────────────────────────────────────────────────────────

const HWND = 4919n; // the window
const CTRL = 5001n; // the named control's own window
const OTHER = 5002n; // another control in the same window
const INNER = 5003n; // a child window of the named control: an editable ComboBox's edit
const PANEL = 6000n; // a container between the control and the window
const aim: Aim = { kind: "aim", title: "RFS-CELL", hwnd: HWND };
const RECT = { x: 100, y: 200, width: 120, height: 24 };
const WRITABLE = 0x50010080;
const READ_ONLY_PS = new Error('Exception calling "SetValue" with "1" argument(s): "Value is read-only."');

function delta(ownHandle?: string): UiEntity {
  return {
    entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "DELTA", automationId: "DELTA", ...(ownHandle !== undefined && { nativeWindowHandle: ownHandle }) } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
  };
}

let dir: string;
let logPath: string;

function probeOn() {
  dir = mkdtempSync(join(tmpdir(), "own-handle-"));
  logPath = join(dir, "aim-probe.jsonl");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
  vi.resetModules();
}

function keyboardRow(): Record<string, unknown> | undefined {
  const rows = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return rows.find((r) => r.seam === "act.route" && r.route === "keyboard");
}

describe("the keyboard rung's row says whether its receiver is the named control, or inside it", () => {
  beforeEach(probeOn);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writingTo(receiverHwnd: bigint | null, over: Partial<KeyboardReceipt> = {}): ExecutorDeps {
    const receipt: KeyboardReceipt = {
      windowHwnd: HWND, receiverHwnd, receiverClass: "WindowsForms10.EDIT.app.0.1",
      receiverRect: RECT, receiverRootHwnd: HWND, receiverStyle: WRITABLE,
      ...over,
    };
    return deps(async () => receipt);
  }

  function deps(keyboardTypeBg: ExecutorDeps["keyboardTypeBg"]): ExecutorDeps {
    return {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => { throw READ_ONLY_PS; }),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(keyboardTypeBg),
      mouseClick: vi.fn(async () => {}),
    };
  }

  async function rowFor(entity: UiEntity, d: ExecutorDeps) {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const answer = await createDesktopExecutor(aim, d)(entity, "type", "PROBE-OH");
    return { answer, row: keyboardRow() };
  }

  it("says yes when the receiver's handle is the named control's own", async () => {
    const { answer, row } = await rowFor(delta("5001"), writingTo(CTRL));
    expect(answer).toBe("keyboard"); // an observation: the act answers as it did
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: true, receiverInEntity: true, receiver: { hwnd: "5001" } });
  });

  it("says no when it is another control's", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(OTHER, { receiverAncestors: [] }));
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: false, receiverInEntity: false, receiver: { hwnd: "5002" } });
  });

  it("compares in one width: a receiver handed over 64 bits wide is the control UIA named 32 bits wide", async () => {
    // USER handles are sign-extended 32-bit values. `GetFocus` arrives through `as usize as u64`, so a
    // handle with bit 31 set reads 0xFFFFFFFF8000_1389 there and 2147488649 in UIA's record.
    const { row } = await rowFor(
      delta("2147488649"),
      writingTo(0xFFFF_FFFF_8000_1389n, { windowHwnd: 0xFFFF_FFFF_8000_1337n, receiverRootHwnd: 0x8000_1337n }),
    );
    expect(row).toMatchObject({
      entityHwnd: "2147488649",
      receiverIsEntity: true,
      receiver: { hwnd: "2147488649", windowHwnd: "2147488567", rootHwnd: "2147488567", isWindowItself: false, inWindow: true },
    });
  });

  it("says the receiver is inside the named control when the focus sits in a child window of it", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(INNER, { receiverAncestors: [CTRL] }));
    expect(row).toMatchObject({
      receiverIsEntity: false, // the text still went into the control named
      receiverInEntity: true,
      receiver: { hwnd: "5003", ancestors: ["5001"] },
    });
  });

  it("finds the named control among the parents across widths too", async () => {
    const { row } = await rowFor(delta("2147488649"), writingTo(INNER, { receiverAncestors: [PANEL, 0xFFFF_FFFF_8000_1389n] }));
    expect(row).toMatchObject({ receiverInEntity: true, receiver: { ancestors: ["6000", "2147488649"] } });
  });

  it("counts the receiver's top-level window as holding it: UIA lists an owned dialog under its owner, so a dialog can be named", async () => {
    // The walk stops short of the top-level window, so the root is checked on its own. A high-bit
    // handle, so the root is compared in the one width too: 0x8000_1E61 is 2147491425.
    const { row } = await rowFor(
      delta("2147491425"),
      writingTo(INNER, { receiverRootHwnd: 0xFFFF_FFFF_8000_1E61n, receiverAncestors: [] }),
    );
    expect(row).toMatchObject({
      receiverIsEntity: false,
      receiverInEntity: true,
      receiver: { rootHwnd: "2147491425", inWindow: false },
    });
  });

  it("says the receiver is the window itself across widths too", async () => {
    const { row } = await rowFor(
      delta("5001"),
      writingTo(0xFFFF_FFFF_8000_1337n, { windowHwnd: 0x8000_1337n, receiverRootHwnd: 0x8000_1337n }),
    );
    expect(row).toMatchObject({ receiver: { hwnd: "2147488567", isWindowItself: true } });
  });

  it("says no when the named control is not among the receiver's parents", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(INNER, { receiverAncestors: [PANEL] }));
    expect(row).toMatchObject({ receiverIsEntity: false, receiverInEntity: false });
  });

  it("cannot say whether it is inside — null, not false — when the parents were not read", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(INNER));
    expect(row).toMatchObject({ receiverIsEntity: false, receiverInEntity: null, receiver: { ancestors: null } });
  });

  it("is yes for the control itself without the parents", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(CTRL));
    expect(row).toMatchObject({ receiverInEntity: true, receiver: { ancestors: null } });
  });

  it("cannot say — null, not false — when the named control has no handle of its own", async () => {
    const { row } = await rowFor(delta(), writingTo(OTHER, { receiverAncestors: [CTRL] }));
    expect(row).toMatchObject({ entityHwnd: null, receiverIsEntity: null, receiverInEntity: null });
  });

  it("cannot say when the receiver is unknown", async () => {
    const { row } = await rowFor(delta("5001"), writingTo(null, { receiverAncestors: [CTRL] }));
    expect(row).toMatchObject({ entityHwnd: "5001", receiverIsEntity: null, receiverInEntity: null });
  });

  it("cannot say when the backend handed back no receipt at all", async () => {
    const { answer, row } = await rowFor(delta("5001"), deps(async () => {}));
    expect(answer).toBe("keyboard");
    expect(row).toMatchObject({ entityHwnd: "5001", receiver: null, receiverIsEntity: null, receiverInEntity: null });
  });
});

describe("the real backend reads the receiver's parents, and only while the probe is on", () => {
  beforeEach(probeOn);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const keyboardOnly = (h: string): UiEntity => ({ ...delta(h), unsupportedExecutors: ["uia"], preferredExecutors: ["keyboard"] });

  /** The window, a post whose focus landed on `target`, and a parent chain the test draws. */
  async function typeThroughTheRealBackend(target: bigint, parentOf: (h: bigint) => bigint | null) {
    const getWindowParent = vi.fn((h: unknown) => parentOf(h as bigint));
    vi.doMock("../../src/engine/win32.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
      enumWindowsInZOrder: () => [{ hwnd: HWND, title: "RFS-CELL" }],
      getWindowClassName: () => "Edit",
      getWindowRectByHwnd: () => RECT,
      getWindowRoot: () => HWND,
      getWindowStyle: () => WRITABLE,
      getWindowParent,
    }));
    vi.doMock("../../src/engine/bg-input.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
      canInjectAtTarget: () => ({ supported: true }),
      postCharsToHwnd: (_hwnd: unknown, text: string) => ({ sent: text.length, full: true, target }),
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const result = await createDesktopExecutor(aim)(keyboardOnly("5001"), "type", "PROBE-OH");
    return { result, getWindowParent, row: keyboardRow() };
  }

  const chain = new Map<bigint, bigint>([[INNER, CTRL], [CTRL, PANEL], [PANEL, HWND]]);

  it("walks up to the window, nearest first, and stops there", async () => {
    const { result, getWindowParent, row } = await typeThroughTheRealBackend(INNER, (h) => chain.get(h) ?? null);
    expect(result).toBe("keyboard");
    expect(getWindowParent.mock.calls.map((c) => c[0])).toEqual([INNER, CTRL, PANEL]);
    expect(row).toMatchObject({ receiverIsEntity: false, receiverInEntity: true, receiver: { hwnd: "5003", ancestors: ["5001", "6000"] } });
  });

  it("reads no parents for the window itself: an empty chain, not an unknown one", async () => {
    const { getWindowParent, row } = await typeThroughTheRealBackend(HWND, (h) => chain.get(h) ?? null);
    expect(getWindowParent).not.toHaveBeenCalled();
    expect(row).toMatchObject({ receiver: { isWindowItself: true, ancestors: [] } });
  });

  it("says nothing — null — when the chain breaks before the window", async () => {
    const { row } = await typeThroughTheRealBackend(INNER, () => null);
    expect(row).toMatchObject({ receiverInEntity: null, receiver: { ancestors: null } });
  });

  it("gives up on a chain that never reaches the window, after a bounded walk, and says nothing", async () => {
    const { result, getWindowParent, row } = await typeThroughTheRealBackend(INNER, (h) => h + 1n);
    expect(result).toBe("keyboard");
    expect(getWindowParent).toHaveBeenCalledTimes(16);
    expect(row).toMatchObject({ receiverInEntity: null, receiver: { ancestors: null } });
  });

  it("with the probe off, walks nothing and answers the same", async () => {
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", undefined);
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", undefined);
    const { result, getWindowParent, row } = await typeThroughTheRealBackend(INNER, (h) => chain.get(h) ?? null);
    expect(result).toBe("keyboard");
    expect(getWindowParent).not.toHaveBeenCalled();
    expect(row).toBeUndefined();
  });
});
