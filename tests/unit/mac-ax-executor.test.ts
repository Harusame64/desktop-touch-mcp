import { describe, it, expect, vi } from "vitest";
import { createMacAxExecutor } from "../../src/tools/mac/ax-executor.js";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";
import { deriveEntityCapabilities } from "../../src/tools/desktop-capabilities.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

const AX = { pid: 7, id: "a.0.1", role: "AXButton", rootKey: "R", elementKey: "E" };
const entity = { locator: { ax: AX } } as any;
const TARGET = { pid: 7, id: "a.0.1", expectedRole: "AXButton", expectedRootKey: "R", expectedElementKey: "E" };

const setup = () => {
  const perform = vi.fn();
  const setValue = vi.fn();
  return { perform, setValue, exec: createMacAxExecutor({ perform, setValue }) };
};

describe("mac AX executor", () => {
  it("click presses the named element", async () => {
    const { perform, exec } = setup();
    perform.mockResolvedValue({ ok: true });
    await expect(exec(entity, "click")).resolves.toBe("ax");
    expect(perform).toHaveBeenCalledWith(TARGET, "AXPress");
  });
  it("element_changed is TargetGoneError saying nothing was done", async () => {
    const { perform, exec } = setup();
    perform.mockResolvedValue({ ok: false, reason: "element_changed" });
    await expect(exec(entity, "click")).rejects.toMatchObject({
      name: "TargetGoneError",
      callerDetail: expect.stringContaining("Nothing was done"),
    });
  });
  it("element_not_found is TargetGoneError", async () => {
    const { perform, exec } = setup();
    perform.mockResolvedValue({ ok: false, reason: "element_not_found" });
    await expect(exec(entity, "click")).rejects.toMatchObject({ name: "TargetGoneError" });
  });
  it("action_not_advertised is MacAxActError", async () => {
    const { perform, exec } = setup();
    perform.mockResolvedValue({ ok: false, reason: "action_not_advertised" });
    await expect(exec(entity, "click")).rejects.toMatchObject({
      name: "MacAxActError",
      callerDetail: expect.stringContaining("action_not_advertised"),
    });
  });
  it("type writes the value and does not press", async () => {
    const { perform, setValue, exec } = setup();
    setValue.mockResolvedValue({ ok: true, valueAfter: "abc" });
    await expect(exec(entity, "type", "abc")).resolves.toBe("ax");
    expect(setValue).toHaveBeenCalledWith(TARGET, "abc");
    expect(perform).not.toHaveBeenCalled();
  });
  it("a different read-back is ValueNotAppliedError", async () => {
    const { setValue, exec } = setup();
    setValue.mockResolvedValue({ ok: true, valueAfter: "abX" });
    await expect(exec(entity, "type", "abc")).rejects.toMatchObject({ name: "ValueNotAppliedError" });
  });
  it("read-back is capped at 2000 chars", async () => {
    const { setValue, exec } = setup();
    setValue.mockResolvedValue({ ok: true, valueAfter: "x".repeat(2000) });
    await expect(exec(entity, "setValue", "x".repeat(2500))).resolves.toBe("ax");
  });
  it("an entity without locator.ax is MacAxActError", async () => {
    const { exec } = setup();
    await expect(exec({ locator: {} } as any, "click")).rejects.toMatchObject({ name: "MacAxActError" });
  });
});

describe("resolveCandidates and locator.ax", () => {
  it("carries locator.ax onto the entity", () => {
    const entities = resolveCandidates([{
      source: "ax", target: { kind: "window", id: "W" }, role: "button", label: "OK",
      rect: { x: 0, y: 0, width: 10, height: 10 }, actionability: ["click", "invoke"],
      confidence: 0.9, observedAtMs: Date.now(), locator: { ax: AX },
    } as any], "gen-1");
    expect(entities).toHaveLength(1);
    expect(entities[0].locator?.ax).toEqual(AX);
  });
});

// Mac port M2-2: an AX entity advertises the AX executor, never the mouse — the rule table reads a
// rect as "the mouse can press it", and an AX act never moves the pointer.
describe("capabilities of an AX entity", () => {
  const aff = (verb: string) => ({ verb, executors: ["ax"], confidence: 0.9, preconditions: [], postconditions: [] });
  it("advertises ax only, even with a rect", () => {
    const entity: any = {
      entityId: "e", role: "button", label: "OK", confidence: 0.9, sources: ["ax"], affordances: [aff("click")],
      generation: "g", evidenceDigest: "d", rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(deriveEntityCapabilities(entity)).toEqual({ preferredExecutors: ["ax"] });
  });
  it("advertises nothing for a text that only reads", () => {
    const entity: any = {
      entityId: "e", role: "label", label: "56", confidence: 0.9, sources: ["ax"], affordances: [aff("read")],
      generation: "g", evidenceDigest: "d", rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(deriveEntityCapabilities(entity)).toBeUndefined();
  });
});

// Gate 2 (#780): an AX entity is acted on only with the verbs the provider gave it.
describe("the facade refuses an action an AX entity does not offer", () => {
  const now = Date.now();
  const cand = (role: string, actionability: string[], label: string) => ({
    source: "ax", target: { kind: "window", id: "W" }, role, label, rect: { x: 0, y: label === "Box" ? 0 : 40, width: 20, height: 20 },
    actionability, confidence: 0.9, observedAtMs: now, digest: `d_${label}`,
    locator: { ax: { pid: 7, id: `a.${label}`, role: "AXCheckBox", rootKey: "R", elementKey: label } },
  });
  it("type on a check box (click only) → action_not_offered, nothing executed", async () => {
    const exec = vi.fn(async () => "ax" as const);
    const f = new DesktopFacade(async () => [cand("button", ["click", "invoke"], "Box"), cand("label", ["read"], "Text")] as any, { executorFn: exec });
    const see = await f.see({ target: { windowTitle: "W" } });
    const box = see.entities.find((e) => e.label === "Box")!;
    const text = see.entities.find((e) => e.label === "Text")!;
    expect((await f.touch({ lease: box.lease, action: "type", text: "hello" })).reason).toBe("action_not_offered");
    expect((await f.touch({ lease: text.lease, action: "click" })).reason).toBe("action_not_offered");
    expect(exec).not.toHaveBeenCalled();
    expect((await f.touch({ lease: box.lease, action: "click" })).ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("type without text (codex, #780)", () => {
  it("refuses with text_required instead of falling to a press", async () => {
    const perform = vi.fn(), setValue = vi.fn();
    const exec = createMacAxExecutor({ perform, setValue } as any);
    const entity: any = { locator: { ax: { pid: 7, id: "a.0.1", role: "AXTextField", rootKey: "R", elementKey: "E" } } };
    const err: any = await exec(entity, "type", undefined).catch((e) => e);
    expect(err.name).toBe("MacAxActError");
    expect(err.callerDetail).toContain("text_required");
    expect(perform).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });
});

describe("an incomplete read after the act (codex, #780)", () => {
  it("drops entity_disappeared and says why", async () => {
    const { qualifyPostRead } = await import("../../src/tools/mac/desktop-discover-act.js");
    const r = qualifyPostRead({ ok: true, diff: ["entity_disappeared", "value_changed"] }, { warnings: ["ax_error:cannot_complete"] });
    expect(r).toEqual({ ok: true, diff: ["value_changed"], postReadWarnings: ["ax_error:cannot_complete"] });
  });
  it("leaves a complete read alone", async () => {
    const { qualifyPostRead } = await import("../../src/tools/mac/desktop-discover-act.js");
    const res = { ok: true, diff: ["entity_disappeared"] };
    expect(qualifyPostRead(res, { warnings: [] })).toBe(res);
  });
});

describe("a sheet or modal window blocks the act (2026-10-04)", () => {
  const target: any = { locator: { ax: { pid: 7, id: "a.0.1", role: "AXTextArea", rootKey: "R", elementKey: "E" } } };
  it("maps modal_blocking to ModalBlockingError with the sheet in the detail", async () => {
    const exec = createMacAxExecutor({ perform: vi.fn(), setValue: vi.fn(async () => ({ ok: false, reason: "modal_blocking", blocker: "sheet:" })) } as any);
    const err: any = await exec(target, "type", "x").catch((e) => e);
    expect(err.name).toBe("ModalBlockingError");
    expect(err.callerDetail).toContain("sheet");
  });
  it("the touch loop reports modal_blocking, not executor_failed", async () => {
    const now = Date.now();
    const cand: any = { source: "ax", target: { kind: "window", id: "W" }, role: "textbox", label: "Body", rect: { x: 0, y: 0, width: 10, height: 10 },
      actionability: ["type"], confidence: 0.9, observedAtMs: now, digest: "d_body", locator: target.locator };
    const exec = createMacAxExecutor({ perform: vi.fn(), setValue: vi.fn(async () => ({ ok: false, reason: "modal_blocking", blocker: "modal_window:Alert" })) } as any);
    const f = new DesktopFacade(async () => [cand], { executorFn: exec });
    const see = await f.see({ target: { windowTitle: "W" } });
    const r = await f.touch({ lease: see.entities[0]!.lease, action: "type", text: "x" });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("modal_blocking");
    expect(String((r as any).detail)).toContain("Alert");
  });
});

describe("append (codex #782: never replace with a cut value)", () => {
  const entity: any = { locator: { ax: { pid: 7, id: "a.0.1", role: "AXTextArea", rootKey: "R", elementKey: "E" } } };
  it("inserts at the end and does not replace", async () => {
    const setValue = vi.fn(), insertText = vi.fn(async () => ({ ok: true, valueAfter: "old\nnew" }));
    const exec = createMacAxExecutor({ perform: vi.fn(), setValue, insertText, appendMode: () => true } as any);
    expect(await exec(entity, "type", "new")).toBe("ax");
    expect(insertText).toHaveBeenCalledWith(expect.anything(), "new", -1);
    expect(setValue).not.toHaveBeenCalled();
  });
  it("refuses value_not_applied when the whole text came back without the new end", async () => {
    const exec = createMacAxExecutor({ perform: vi.fn(), setValue: vi.fn(), insertText: vi.fn(async () => ({ ok: true, valueAfter: "old" })), appendMode: () => true } as any);
    expect((await exec(entity, "type", "new").catch((e: any) => e)).name).toBe("ValueNotAppliedError");
  });
  it("does not judge the end of a capped read-back", async () => {
    const exec = createMacAxExecutor({ perform: vi.fn(), setValue: vi.fn(), insertText: vi.fn(async () => ({ ok: true, valueAfter: "x".repeat(2000) })), appendMode: () => true } as any);
    expect(await exec(entity, "type", "new")).toBe("ax");
  });
});
