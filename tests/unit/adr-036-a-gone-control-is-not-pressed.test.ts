/**
 * A control that has gone is not pressed where it was.
 *
 * ADR-036 item 16. On the title-only road a failed UIA click downgraded to the mouse whatever the
 * failure was. MEASURED 2026-09-11 win2 (internal `dev/route-failure-strings/RESULTS.md`, arm Pii-a,
 * on `5b5b4d58`): a control removed after discover — UIA answered `Element not found` — was pressed
 * at its remembered point, the press landed on the empty form, and the act reported `ok:true`. The
 * specification's Guard `target.exists` ("The tracked entity has not disappeared") and "RPG should
 * fail closed for actions" say it should have been refused. The same arm with the control present but
 * lacking Invoke (Pii-b) is what the downgrade exists for, and it pressed the label correctly — so
 * the refusal is for "not found" only — and only when the native client both read the entity and
 * answered the click. Another client can see another tree, where a present element is "not found"
 * (gate 2 on #624).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

/** What a title-only discover leaves behind: a title, and nothing else. */
const titleOnly: Aim = { kind: "aim", title: "RFS-CELL" };

/**
 * `via` — which client read it, as the UIA provider stamps it. Omitted means native; an explicit
 * `undefined` means no mark (a default parameter would turn that back into native).
 */
function uiaEntity(...mark: [via: "native" | "powershell" | undefined] | []): UiEntity {
  const via = mark.length ? mark[0] : "native";
  return {
    entityId: "u1", role: "button", label: "ALPHA", confidence: 0.9, sources: ["uia"],
    locator: { uia: { name: "ALPHA", automationId: "ALPHA", ...(via !== undefined && { via }) } },
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

/**
 * A UIA click that fails with this text, answered by this client — the mark the real adapter puts
 * on. Omitted means native; an explicit `undefined` means no mark.
 */
const failingWith = (text: string, ...mark: [uiaVia: "native" | "powershell" | undefined] | []) =>
  vi.fn(async () => { throw Object.assign(new Error(text), { uiaVia: mark.length ? mark[0] : "native" }); });

describe("a title-only click whose element UIA reports gone", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gone-control-"));
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

  it("is refused, and nothing is pressed where it used to be", async () => {
    const d = deps({ uiaClick: failingWith("Element not found") });
    const thrown = await act(d);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("TargetGoneError");
    expect(d.mouseClick).not.toHaveBeenCalled();
    // The caller's sentence is the engine's, never the backend's text.
    const detail = (thrown as { callerDetail: string }).callerDetail;
    expect(detail).toContain('UIA found no element for "ALPHA"');
    expect(detail).not.toContain("Element not found");
  });

  it("keeps the downgrade for the case it exists for: the element is there and has no Invoke", async () => {
    // The control. Arm Pii-b pressed the label correctly through this downgrade.
    const d = deps({ uiaClick: failingWith("InvokePattern not supported by this element") });
    const outcome = await act(d);
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
    expect(outcome).toMatchObject({ kind: "mouse", downgrade: { from: "uia" } });
  });

  it("keeps it for an answer the classifier cannot read, which cannot say the element is gone", async () => {
    const d = deps({ uiaClick: failingWith('Command failed: powershell.exe -NoProfile -Command "…Element not found…"') });
    await act(d);
    expect(d.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("keeps the downgrade when another client read the entity, or answered the click (gate 2 on #624)", async () => {
    // Without the native engine the read registers the clientside providers and the title-road
    // click does not (2 elements against 26 on Notepad); a native read that fell back once names
    // elements in the MSAA vocabulary; a native click that threw falls back to that script. A
    // present element answers "not found" in each, so none of them may say it has gone.
    for (const [readVia, clickVia] of [["powershell", "native"], ["native", "powershell"], ["powershell", "powershell"]] as const) {
      const d = deps({ uiaClick: failingWith("Element not found", clickVia) });
      await act(d, uiaEntity(readVia));
      expect(d.mouseClick, `${readVia} read, ${clickVia} click`).toHaveBeenCalledWith(140, 215);
    }
  });

  it("keeps it when either half carries no mark — an entity or an answer from before the mark", async () => {
    for (const [readVia, clickVia] of [[undefined, "native"], ["native", undefined]] as const) {
      const d = deps({ uiaClick: failingWith("Element not found", clickVia) });
      await act(d, uiaEntity(readVia));
      expect(d.mouseClick, `${readVia} read, ${clickVia} click`).toHaveBeenCalledWith(140, 215);
    }
  });

  it("gets the click's mark from the real adapter — without it the refusal could never fire", async () => {
    // Every cell above hands the executor a fake `uiaClick` that marks its own error. The real one
    // has to carry the bridge's `via` across, or production would downgrade every "not found" and
    // no cell here would notice. No rect: the mouse must not be reachable from this cell.
    vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      clickElement: vi.fn(async () => ({ ok: false, error: "Element not found", via: "native" })),
    }));
    try {
      const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
      const { rect: _rect, ...noRect } = uiaEntity();
      const thrown = await createDesktopExecutor(titleOnly)(noRect as UiEntity, "click").then(() => undefined, (e: unknown) => e);
      expect((thrown as Error | undefined)?.name).toBe("TargetGoneError");
    } finally {
      vi.doUnmock("../../src/engine/uia-bridge.js");
    }
  });

  it("writes a refusal row that names the rung, the reason and the class — and no backend text", async () => {
    await act(deps({ uiaClick: failingWith("Element not found") }));
    const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const refusals = rows.filter((r) => r.route === "refusal");
    expect(refusals.map((r) => [r.rung, r.refused, r.routeFailure, r.readVia, r.clickVia]))
      .toEqual([["uia_downgrade", "entity_not_found", "element_not_found", "native", "native"]]);
    expect(rows.some((r) => r.route === "mouse")).toBe(false);
  });

  it("writes the class on the downgrade row too — null for an answer the classifier did not recognise", async () => {
    // The unrecognised answers collect in the log, where the next class to add can be read from.
    await act(deps({ uiaClick: failingWith("InvokePattern not supported by this element") }));
    await act(deps({ uiaClick: failingWith("Command failed: powershell.exe -NoProfile -Command \"RFS-SCRIPT\"") }));
    const rows = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const downgrades = rows.filter((r) => r.route === "mouse");
    expect(downgrades.map((r) => [r.routeFailure, r.readVia, r.clickVia]))
      .toEqual([["pattern_not_supported", "native", "native"], [null, "native", "native"]]);
    expect(JSON.stringify(rows)).not.toContain("RFS-SCRIPT");
  });

  it("reaches the caller as entity_not_found, with the executor's sentence as the detail", async () => {
    const thrown = await act(deps({ uiaClick: failingWith("Element not found") }));
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const e = uiaEntity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(e, "view-1");
    const loop = new GuardedTouchLoop(store, {
      resolveLiveEntities:      () => [e],
      currentGeneration:        () => "gen-1",
      isModalBlocking:          () => false,
      checkViewport:            () => null,
      execute:                  async () => { throw thrown; },
      resolvePostTouchEntities: async () => [],
    });
    const result = await loop.touch({ lease });
    expect(result).toMatchObject({ ok: false, reason: "entity_not_found", detail: (thrown as { callerDetail: string }).callerDetail });
  });
});

describe("the envelope entity_not_found goes out in", () => {
  it("names re-discovering, and never a coordinate press", async () => {
    const { toFailureEnvelope } = await import("../../src/tools/_envelope.js");
    const { Err } = await import("../../src/types/result.js");
    const { EntityNotFoundRefusalError } = await import("../../src/errors/typed-errors.js");
    const { getSuggestsForCode } = await import("../../src/tools/_errors.js");
    const raw = toFailureEnvelope(Err(new EntityNotFoundRefusalError("x")), { optIn: false }) as { reason?: string };
    expect(raw.reason).toBe("entity_not_found");
    const advice = getSuggestsForCode("EntityNotFound");
    expect(advice.join(" ")).toMatch(/desktop_discover/);
    for (const line of advice) {
      if (/mouse_click|by coordinate|rect/i.test(line)) expect(line).toMatch(/do not|never/i);
    }
  });

  it("is the same whichever check caught it — the lease check before the touch, or the touch", async () => {
    // The lease check answered `Unknown` with no advice until item 16: one condition, two answers.
    const { makeCommitWrapper, toFailureEnvelope } = await import("../../src/tools/_envelope.js");
    const { Err } = await import("../../src/types/result.js");
    const { EntityNotFoundRefusalError } = await import("../../src/errors/typed-errors.js");
    const wrapped = makeCommitWrapper(
      async () => ({ content: [{ type: "text" as const, text: '{"ok":true}' }] }),
      "gone_control_lease_check",
      {
        leaseValidator: async () => ({ ok: false, reason: "entity_not_found" }),
        getEnvValue: () => undefined,
        l1Emitter: { pushStarted: () => {}, pushCompleted: () => {} },
      },
    );
    const first = await wrapped({} as Record<string, unknown>);
    const byLease = JSON.parse((first.content[0] as { text: string }).text) as { reason: string; if_unexpected: { most_likely_cause: string; try_next: unknown[] } };
    const byTouch = toFailureEnvelope(Err(new EntityNotFoundRefusalError("x")), { optIn: false }) as { if_unexpected: { try_next: unknown[] } };
    expect(byLease.reason).toBe("entity_not_found");
    expect(byLease.if_unexpected.most_likely_cause).toBe("EntityNotFound");
    expect(byLease.if_unexpected.try_next).toEqual(byTouch.if_unexpected.try_next);
    expect(JSON.stringify(byLease.if_unexpected.try_next)).toMatch(/desktop_discover/);
  });

  it("is built by desktop_act for a touch that reports entity_not_found, which went out raw before", () => {
    // A source read, as the public-text cells do: the rebuild is a branch in the handler.
    const source = readFileSync(new URL("../../src/tools/desktop-register.ts", import.meta.url), "utf8");
    expect(source).toMatch(/result\.reason === "entity_not_found"\) \{\s*const failure = toFailureEnvelope\(\s*Err\(new EntityNotFoundRefusalError/);
  });
});
