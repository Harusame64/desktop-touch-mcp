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

function foxtrot(readVia: "native" | "powershell" | undefined = "native"): UiEntity {
  return {
    entityId: "foxtrot", role: "textbox", label: "FOXTROT", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "FOXTROT", ...(readVia !== undefined && { via: readVia }), nativeWindowHandle: GONE.toString() } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 100, y: 200, width: 120, height: 24 }, controlType: "Edit",
    origin: { kind: "window", id: "T1-FIXTURE", hwnd: HWND.toString() },
  };
}

/** What t1 read at the rung: DELTA holds the focus, and FOXTROT's handle has no root any more. */
function receipt(): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: DELTA, receiverClass: "WindowsForms10.EDIT.app.0.1", receiverRect: null,
    receiverRootHwnd: HWND, receiverStyle: 0x50010080, receiverAncestors: [HWND], ancestorsComplete: true,
    entityRootHwnd: null, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
  };
}

const failing = (message: string, via?: "native" | "powershell") =>
  vi.fn(async () => { throw Object.assign(new Error(message), via !== undefined ? { uiaVia: via } : {}); });

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: failing("Element not found", "native"),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt()),
    keyboardResolve: vi.fn(async () => receipt()),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "T1-FIXTURE" };
const handleRoad: Aim = { kind: "aim", title: "T1-FIXTURE", hwnd: HWND };

async function type(target: typeof titleRoad | Aim, entity: UiEntity, d: ExecutorDeps, action: "type" | "setValue" = "type") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(entity, action, "PROBE-T1");
}

describe("t1 — a field UIA says is gone", () => {
  for (const [road, target] of [["title road", titleRoad], ["handle road", handleRoad]] as const) {
    for (const action of ["type", "setValue"] as const) {
      it(`is refused as gone, and nothing is posted — ${action}, ${road}`, async () => {
        const d = deps();
        const err = await type(target, foxtrot(), d, action).then(() => null, (e: unknown) => e as { name?: string; callerDetail?: string });
        expect(err).toMatchObject({ name: "TargetGoneError" });
        expect(err?.callerDetail).toMatch(/nothing was typed/);
        expect(err?.callerDetail).toMatch(/FOXTROT/);
        // The engine's words, not the backend's.
        expect(err?.callerDetail).not.toContain("Element not found");
        expect(d.keyboardResolve).not.toHaveBeenCalled();
        expect(d.keyboardPost).not.toHaveBeenCalled();
      });
    }
  }

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

describe("where \"not found\" is not believed, the rung keeps the write", () => {
  it("a PowerShell answer to the write — the script registers fewer providers than the read did", async () => {
    const d = deps({ uiaSetValue: failing("Element not found", "powershell") });
    await type(titleRoad, foxtrot(), d).catch(() => undefined);
    // The rung ran and posted — t1's answer before this change, kept where the answer is not believed.
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("an entity the PowerShell client read", async () => {
    const d = deps();
    await type(titleRoad, foxtrot("powershell"), d).catch(() => undefined);
    // The rung ran and posted — t1's answer before this change, kept where the answer is not believed.
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("an answer that does not say which client gave it", async () => {
    const d = deps({ uiaSetValue: failing("Element not found") });
    await type(titleRoad, foxtrot(), d).catch(() => undefined);
    // The rung ran and posted — t1's answer before this change, kept where the answer is not believed.
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("a failure that is not \"not found\" — no ValuePattern is what the rung exists for", async () => {
    const d = deps({ uiaSetValue: failing("ValuePattern not supported by this element", "native") });
    await type(titleRoad, foxtrot(), d).catch(() => undefined);
    // The rung ran and posted — t1's answer before this change, kept where the answer is not believed.
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });
});

describe("the bridge says which client answered the write", () => {
  it("the production dep carries the bridge's via on its error, as uiaClick does", async () => {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => ({ ok: false, error: "Element not found", via: "native" as const })),
    }));
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    // No deps: the executor uses the production ones, whose uiaSetValue calls the mocked bridge. The
    // keyboard rung is not reached, so nothing native is needed past the value road.
    const err = await createDesktopExecutor(titleRoad)(foxtrot(), "type", "PROBE-T1").then(() => null, (e: unknown) => e as { name?: string });
    expect(err).toMatchObject({ name: "TargetGoneError" });
  });
});
