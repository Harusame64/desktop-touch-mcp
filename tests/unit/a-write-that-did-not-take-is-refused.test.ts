/**
 * internal #182 — a write the control accepted and did not take is refused, not reported written.
 *
 * MEASURED before the change (win2, 2026-09-24, the AB test's arm B-7, internal `7055e3dc`, three of
 * three, on public `main` `e072b1e0`): `desktop_act type "4242"` on GOLF, a WinForms NumericUpDown,
 * answered `ok:true` from `uia_set_value`. The fixture's text and value stayed at 0 and no event
 * fired. The native client reads GOLF as a ComboBox with a ValuePattern whose SetValue answers S_OK
 * and changes nothing; its value reads "" before and after (`d58b673d`).
 *
 * The check lives in the native writer (`src/uia/actions.rs`, `set_value_impl`), which reads the
 * value before and after on the same element and answers `code: "ValueNotApplied"` when it did not
 * move and differs from what was written. These cells pin everything above the addon: the code is
 * typed, refused before the keyboard rung (which win2 measured writing `42420` for `4242` at the inner
 * edit's caret), and reaches the caller as `value_not_applied`.
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

const HWND = 4919n;
const GOLF = 6423322n;

function golf(): UiEntity {
  return {
    entityId: "golf", role: "textbox", label: "GOLF", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "GOLF", automationId: "GOLF", via: "native", nativeWindowHandle: GOLF.toString(), nativeWindowHandleRead: "value" } },
    affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect: { x: 330, y: 523, width: 320, height: 19 }, controlType: "ComboBox",
    origin: { kind: "window", id: "AB-CELL", hwnd: HWND.toString() },
  };
}

/** A receipt the rung would accept: the focus is in GOLF's own window. The rung must not be reached. */
const receipt: KeyboardReceipt = {
  windowHwnd: HWND, receiverHwnd: GOLF, receiverClass: "WindowsForms10.EDIT.app.0.1", receiverRect: null,
  receiverRootHwnd: HWND, receiverStyle: 0x50010080, receiverAncestors: [GOLF, HWND], ancestorsComplete: true,
  entityRootHwnd: HWND, entityWindowAlive: true, originRootHwnd: HWND, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
};

async function notApplied() {
  const { ValueNotAppliedError } = await import("../../src/engine/aim.js");
  return vi.fn(async () => { throw new ValueNotAppliedError("SetValue returned success, but the element's value did not change"); });
}

async function deps(over: Partial<ExecutorDeps> = {}): Promise<ExecutorDeps> {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: await notApplied(),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt),
    keyboardResolve: vi.fn(async () => receipt),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

const titleRoad = { windowTitle: "AB-CELL" };
const handleRoad: Aim = { kind: "aim", title: "AB-CELL", hwnd: HWND };
const roads = [["title road", titleRoad], ["handle road", handleRoad]] as const;

async function write(target: typeof titleRoad | Aim, d: ExecutorDeps, action: "type" | "setValue" = "type") {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target, d)(golf(), action, "4242");
}

const outcome = (p: Promise<unknown>) => p.then((v) => ({ v, e: null }), (e: unknown) => ({ v: null, e: e as { name?: string; callerDetail?: string } }));

describe("#182 — the value road wrote, the control said yes, and nothing changed", () => {
  for (const [road, target] of roads) {
    for (const action of ["type", "setValue"] as const) {
      it(`is refused, and the keyboard rung is not reached — ${action}, ${road}`, async () => {
        const d = await deps();
        const { e } = await outcome(write(target, d, action));
        expect(e).toMatchObject({ name: "ValueNotAppliedError" });
        expect(e?.callerDetail).toMatch(/nothing was written/);
        expect(e?.callerDetail).toMatch(/GOLF/);
        // The engine's words, not the backend's.
        expect(e?.callerDetail).not.toContain("SetValue returned success");
        expect(d.keyboardResolve).not.toHaveBeenCalled();
        expect(d.keyboardTypeBg).not.toHaveBeenCalled();
        expect(d.keyboardPost).not.toHaveBeenCalled();
      });
    }
  }

  it("CONTROL: a value road failure of another kind still goes to the rung", async () => {
    // Without this, "refuse every value-road failure" passes the cell above.
    const d = await deps({ uiaSetValue: vi.fn(async () => { throw Object.assign(new Error("ValuePattern not supported by this element"), { uiaVia: "native" }); }) });
    await outcome(write(titleRoad, d));
    expect(d.keyboardPost).toHaveBeenCalledOnce();
  });

  it("CONTROL: a write the control took answers as before", async () => {
    const d = await deps({ uiaSetValue: vi.fn(async () => {}) });
    const { v, e } = await outcome(write(titleRoad, d));
    expect(e).toBeNull();
    expect(v).toBe("uia");
  });

  it("writes one refusal row on the value road, and no keyboard row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vna-row-"));
    const logPath = join(dir, "aim-probe.jsonl");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
    vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
    try {
      await outcome(write(titleRoad, await deps()));
      const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const refusals = rows.filter((r) => r.route === "refusal");
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ rung: "uia_set_value", refused: "value_not_applied", addressedWindowBy: "title" });
      expect(rows.some((r) => r.route === "keyboard")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches the loop as value_not_applied, not executor_failed", async () => {
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const entity = golf();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(entity, "v1");
    const d = await deps();
    const exec = createDesktopExecutor(titleRoad, d);
    const result = await new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [entity],
      currentGeneration: () => "gen-1",
      isModalBlocking: () => false,
      checkViewport: () => null,
      execute: (e, a, t) => exec(e, a, t),
      resolvePostTouchEntities: async () => [entity],
    }).touch({ lease, action: "type", text: "4242" });
    expect(result).toMatchObject({ ok: false, reason: "value_not_applied" });
    expect((result as { detail?: string }).detail).toMatch(/nothing was written/);
  });
});

describe("#182 — the production dep reads the addon's code", () => {
  async function depWith(answer: { ok: boolean; error?: string; code?: string; via?: "native" | "powershell" }) {
    vi.doMock("../../src/engine/uia-bridge.js", async (orig) => ({
      ...(await orig<typeof import("../../src/engine/uia-bridge.js")>()),
      setElementValue: vi.fn(async () => answer),
    }));
    const { _realExecutorDepsForTest } = await import("../../src/tools/desktop-executor.js");
    return _realExecutorDepsForTest().uiaSetValue("AB-CELL", "4242", "GOLF", "GOLF")
      .then(() => null, (e: unknown) => e as { name?: string; uiaVia?: unknown });
  }
  it("throws ValueNotAppliedError on `ValueNotApplied`", async () => {
    const err = await depWith({ ok: false, error: "SetValue returned success, but the element's value did not change", code: "ValueNotApplied", via: "native" });
    expect(err?.name).toBe("ValueNotAppliedError");
  });
  it("CONTROL: any other failure is the plain error it was, carrying which client answered", async () => {
    const err = await depWith({ ok: false, error: "ValuePattern not supported by this element", code: "PatternNotSupported", via: "native" });
    expect(err?.name).toBe("Error");
    expect(err?.uiaVia).toBe("native");
  });
});

describe("#182 — the advice", () => {
  it("names the recovery and forbids a keystroke into the same control", async () => {
    const { getSuggestsForCode } = await import("../../src/tools/_errors.js");
    const advice = getSuggestsForCode("ValueNotApplied");
    expect(advice.length).toBeGreaterThan(0);
    const text = advice.join(" ");
    expect(text).toMatch(/nothing was written/);
    expect(text).toMatch(/desktop_discover/);
    expect(text).toMatch(/do NOT[^.]*keyboard/i);
  });
});
