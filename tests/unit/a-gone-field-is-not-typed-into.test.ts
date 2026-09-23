/**
 * ADR-036 item 16 on the WRITE road — a field UIA says is gone is not typed into.
 *
 * MEASURED before the change (win2, 2026-09-23, cell t1, internal `9fc97d75`, on public `main`
 * `192941e6`, three of three): FOXTROT was removed after discover and `type` was sent on its lease
 * while DELTA held the focus. The value road answered `element_not_found`; the keyboard rung could not
 * compare handles (FOXTROT's window had been destroyed — `entity_handle_stale`) and posted; the
 * characters landed in DELTA, and the act answered `ok:true` with `landing:{confirmed:false}`. The
 * spec-side table's row 1 (`target.exists`) × type.
 *
 * The click path has refused this since #624, believing "not found" only when the client that read
 * the entity and the client that answered are both native. The type road now does the same.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { Aim } from "../../src/engine/aim.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const HWND = 4919n; // the window
const GONE = 6423322n; // FOXTROT's own window, destroyed since discover
const DELTA = 5002n; // the field that holds the focus

function foxtrot(readVia: "native" | "powershell" | undefined = "native", handle: bigint | null = GONE): UiEntity {
  return {
    entityId: "foxtrot", role: "textbox", label: "FOXTROT", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "FOXTROT", ...(readVia !== undefined && { via: readVia }), ...(handle !== null && { nativeWindowHandle: handle.toString() }) } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 100, y: 200, width: 120, height: 24 }, controlType: "Edit",
    origin: { kind: "window", id: "T1-FIXTURE", hwnd: HWND.toString() },
  };
}

/**
 * What t1 read at the rung: DELTA holds the focus, and FOXTROT's own window is not alive
 * (`entityRootHwnd: null`, the OS's answer). `alive` puts FOXTROT's window back, focused.
 */
function receipt(over: Partial<KeyboardReceipt> = {}): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: DELTA, receiverClass: "WindowsForms10.EDIT.app.0.1", receiverRect: null,
    receiverRootHwnd: HWND, receiverStyle: 0x50010080, receiverAncestors: [HWND], ancestorsComplete: true,
    entityRootHwnd: null, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
    ...over,
  };
}
const alive = { entityRootHwnd: HWND, receiverHwnd: GONE, receiverAncestors: [HWND] };

const failing = (message: string, via?: "native" | "powershell") =>
  vi.fn(async () => { throw Object.assign(new Error(message), via !== undefined ? { uiaVia: via } : {}); });

function deps(over: Partial<ExecutorDeps> = {}, r: KeyboardReceipt = receipt()): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: failing("Element not found", "native"),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => r),
    keyboardResolve: vi.fn(async () => r),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "T1-FIXTURE" };
const handleRoad: Aim = { kind: "aim", title: "T1-FIXTURE", hwnd: HWND };
const roads = [["title road", titleRoad], ["handle road", handleRoad]] as const;

async function type(target: typeof titleRoad | Aim, entity: UiEntity, d: ExecutorDeps, action: "type" | "setValue" = "type") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(entity, action, "PROBE-T1");
}

const outcome = (p: Promise<unknown>) => p.then((v) => ({ v, e: null }), (e: unknown) => ({ v: null, e: e as { name?: string; callerDetail?: string } }));

describe("t1 — the named field's own window is gone, and UIA says the element is", () => {
  for (const [road, target] of roads) {
    for (const action of ["type", "setValue"] as const) {
      it(`is refused as gone, and nothing is posted — ${action}, ${road}`, async () => {
        const d = deps();
        const { e } = await outcome(type(target, foxtrot(), d, action));
        expect(e).toMatchObject({ name: "TargetGoneError" });
        expect(e?.callerDetail).toMatch(/nothing was typed/);
        expect(e?.callerDetail).toMatch(/FOXTROT/);
        // The engine's words, not the backend's.
        expect(e?.callerDetail).not.toContain("Element not found");
        expect(d.keyboardPost).not.toHaveBeenCalled();
      });
    }
    it(`is refused whichever client answered — the OS says the window is gone (PowerShell write, ${road})`, async () => {
      const d = deps({ uiaSetValue: failing("Element not found", "powershell") });
      const { e } = await outcome(type(target, foxtrot("powershell"), d));
      expect(e).toMatchObject({ name: "TargetGoneError" });
      expect(d.keyboardPost).not.toHaveBeenCalled();
    });
  }

  it("writes one refusal row, with the ground it was believed on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t1-row-"));
    const logPath = join(dir, "aim-probe.jsonl");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
    try {
      await outcome(type(titleRoad, foxtrot(), deps()));
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const refusals = rows.filter((r) => r.route === "refusal");
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        rung: "keyboard", refused: "entity_not_found", why: "uia_set_value_failed",
        routeFailure: "element_not_found", gone: "own_window_destroyed", readVia: "native", setVia: "native",
        addressedWindowBy: "title",
      });
      expect(rows.some((r) => r.route === "keyboard")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches the loop as entity_not_found, not executor_failed", async () => {
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const entity = foxtrot();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(entity, "v1");
    const d = deps();
    const exec = createDesktopExecutor(titleRoad, d);
    const result = await new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [entity],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: (e, a, t) => exec(e, a, t),
      resolvePostTouchEntities: async () => [entity],
    }).touch({ lease, action: "type", text: "PROBE-T1" });
    expect(result).toMatchObject({ ok: false, reason: "entity_not_found" });
    expect((result as { detail?: string }).detail).toMatch(/nothing was typed/);
    expect(d.keyboardPost).not.toHaveBeenCalled();
  });
});

describe("a field with no window of its own — item 16's condition, as on the click path", () => {
  for (const [road, target] of roads) {
    it(`is refused when the read and the write were both native — ${road}`, async () => {
      const d = deps();
      const { e } = await outcome(type(target, foxtrot("native", null), d));
      expect(e).toMatchObject({ name: "TargetGoneError" });
      expect(d.keyboardPost).not.toHaveBeenCalled();
    });
    for (const [what, entity, over] of [
      ["a PowerShell answer to the write", foxtrot("native", null), { uiaSetValue: failing("Element not found", "powershell") }],
      ["an entity the PowerShell client read", foxtrot("powershell", null), {}],
      ["an answer that does not say which client gave it", foxtrot("native", null), { uiaSetValue: failing("Element not found") }],
    ] as const) {
      it(`keeps the rung for ${what} — ${road}`, async () => {
        const d = deps(over);
        await outcome(type(target, entity, d));
        // The rung ran and posted — t1's answer before this change, kept where the answer is not believed.
        expect(d.keyboardPost).toHaveBeenCalledOnce();
      });
    }
  }
});

describe("the named field's own window is ALIVE — not refused as gone, whatever UIA said (gate 2)", () => {
  for (const [road, target] of roads) {
    it(`a field renamed since discover, holding the focus, is written and confirmed — ${road}`, async () => {
      const d = deps({}, receipt(alive));
      const { v, e } = await outcome(type(target, foxtrot(), d));
      expect(e).toBeNull();
      expect(v).toBe("keyboard");
      expect(d.keyboardPost).toHaveBeenCalledOnce();
    });
    it(`with the focus elsewhere, the rung's own ground refuses it, not "gone" — ${road}`, async () => {
      const d = deps({}, receipt({ entityRootHwnd: HWND }));
      const { e } = await outcome(type(target, foxtrot(), d));
      expect(e).toMatchObject({ name: "KeyboardTargetUnsafeError", ground: "other_control" });
    });
  }

  it("a backend that did not read the field's window is not evidence it is gone", async () => {
    const d = deps({ uiaSetValue: failing("Element not found", "powershell") }, receipt({ entityRootHwnd: undefined }));
    await outcome(type(titleRoad, foxtrot("powershell"), d));
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("a failure that is not \"not found\" goes to the rung — no ValuePattern is what the rung exists for", async () => {
    const d = deps({ uiaSetValue: failing("ValuePattern not supported by this element", "native") });
    await outcome(type(titleRoad, foxtrot(), d));
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });
});

describe("the escape hatch still restores the old path", () => {
  it("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED=1 posts, as before any rule (gate 2)", async () => {
    vi.stubEnv("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED", "1");
    const d = deps();
    const { e } = await outcome(type(titleRoad, foxtrot(), d));
    expect(e).toBeNull();
    expect(d.keyboardTypeBg).toHaveBeenCalledOnce();
  });
});

describe("the bridge says which client answered a failed write", () => {
  it("the production dep carries the bridge's via on its error, as uiaClick does", async () => {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => ({ ok: false, error: "Element not found", via: "native" as const })),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    const err = await _realExecutorDepsForTest().uiaSetValue("T1-FIXTURE", "x", "FOXTROT").then(() => null, (e: unknown) => e as { uiaVia?: unknown });
    expect(err?.uiaVia).toBe("native");
  });
});
