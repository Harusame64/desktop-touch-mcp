/**
 * internal #262 — desktop_discover on macOS hands a checkbox's, radio button's and pop-up's state to
 * the caller as `value`, through the tool's output (not only the provider's notes; gate 2 on #926).
 * Safari's web checkbox and select read as plain buttons with no state before (2026-10-05).
 */
import { describe, it, expect, vi } from "vitest";
import { createMacFacade, macDiscoverHandler, type MacFacadeState } from "../../src/tools/mac/desktop-discover-act.js";
import type { NativeMacAxElement } from "../../src/engine/native-types.js";

const WIN = "k262\u001f\u001f0,0,800,600";
const ctl = (id: string, role: string, title: string, value: string): NativeMacAxElement => ({
  id, rootKey: WIN, elementKey: `k|${title}`, depth: 1, role, title, value, actions: ["AXPress"], valueSettable: false, childCount: 0,
  valueTruncated: false,
});

describe("desktop_discover says a control's state (internal #262)", () => {
  it("puts the checkbox's, pop-up's and radio buttons' state on their entities, and none on a plain button", async () => {
    const elements = [
      ctl("a.0.1", "AXCheckBox", "同意", "true"),
      ctl("a.0.2", "AXPopUpButton", "色", "緑"),
      ctl("a.0.3", "AXRadioButton", "小", "1"),
      ctl("a.0.4", "AXRadioButton", "大", "0"),
      ctl("a.0.5", "AXButton", "送信", "x"),
    ];
    const ok = { ok: true };
    const m = {
      macPermissions: () => ({ accessibility: true, screenCapture: true }),
      macListWindows: () => [{ windowId: 1, pid: 7, layer: 0, onScreen: true, title: "k262" }],
      macGetFocus: async () => ({ pid: 7 }),
      macAxTree: vi.fn(async () => ({ pid: 7, appTitle: "Safari", truncated: false, selfReference: false, displayAsleep: false, elapsedMs: 1, elements })),
      macAxPerform: vi.fn(async () => ok),
      macAxSetValue: vi.fn(async () => ok),
      macAxInsertText: vi.fn(async () => ok),
    };
    const state: MacFacadeState = { phase: "discover" };
    const facade = createMacFacade(m as never, state);
    const r = await macDiscoverHandler(m as never, facade, state, { target: { windowTitle: "k262" }, view: "explore" });
    const d = JSON.parse((r as { content: { text?: string }[] }).content[0]!.text!);
    const valueOf = (label: string) => d.entities.find((e: { label?: string }) => e.label === label)?.value;
    expect([valueOf("同意"), valueOf("色"), valueOf("小"), valueOf("大")]).toEqual(["1", "緑", "1", "0"]);
    expect(d.entities.find((e: { label?: string }) => e.label === "送信")).toBeDefined();
    expect(valueOf("送信")).toBeUndefined();
  });
});
