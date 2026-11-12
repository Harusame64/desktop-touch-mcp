/**
 * internal #293 — a field whose UIA Name is empty is named by the label laid out beside it.
 *
 * MEASURED win2 (2026-11-12, dev/293-364-spike): a WPF `Label Content="_Name:" Target=tb` beside
 * `TextBox x:Name="tb"`. The TextBox reads as Edit, Name "", AutomationId "tb", at 964,163 220x26.
 * The Label reads as Text "Name:" at 920,163 44x26 in the same parent, and its inner TextBlock as
 * Text "_Name:" one level down. `LabeledBy` on the Edit is null, so layout is the only link.
 * discover dropped the box (its name is "").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiElement } from "../../src/engine/uia-bridge.js";
import { inferLabelsFromLayout } from "../../src/tools/desktop-providers/uia-provider.js";

type R = { x: number; y: number; width: number; height: number };
const el = (controlType: string, name: string, rect: R, path: string, extra: Partial<UiElement> = {}): UiElement =>
  ({ controlType, name, boundingRect: rect, path, isEnabled: true, patterns: [], depth: path.split("/").length - 1, automationId: "", ...extra }) as UiElement;

// The spike's window, as read.
const label = el("Text", "Name:", { x: 920, y: 163, width: 44, height: 26 }, "/Text[0]");
const inner = el("Text", "_Name:", { x: 925, y: 168, width: 34, height: 16 }, "/Text[0]/Text[0]");
const box = el("Edit", "", { x: 964, y: 163, width: 220, height: 26 }, "/Edit[1]", { automationId: "tb", patterns: ["Value"] });
const button = el("Button", "OK", { x: 1190, y: 163, width: 60, height: 26 }, "/Button[2]");

describe("inferLabelsFromLayout (internal #293)", () => {
  it("names the box by the Label left of it, without the colon", () => {
    const out = inferLabelsFromLayout([label, inner, box, button]);
    expect(out.get(2)).toBe("Name");
    expect(out.size).toBe(1);
  });

  it("takes a label above the field too, starting at its left edge", () => {
    const above = el("Text", "E-mail", { x: 964, y: 130, width: 60, height: 20 }, "/Text[0]");
    expect(inferLabelsFromLayout([above, box]).get(1)).toBe("E-mail");
    const offset = el("Text", "E-mail", { x: 1100, y: 130, width: 60, height: 20 }, "/Text[0]");
    expect(inferLabelsFromLayout([offset, box]).size).toBe(0);
  });

  it("drops a leading access-key underscore, and keeps one inside a word", () => {
    const only = el("Text", "_Name:", { x: 925, y: 163, width: 34, height: 26 }, "/Text[0]");
    expect(inferLabelsFromLayout([only, box]).get(1)).toBe("Name");
    const id = el("Text", "user_id:", { x: 900, y: 163, width: 60, height: 26 }, "/Text[0]");
    expect(inferLabelsFromLayout([id, box]).get(1)).toBe("user_id");
  });

  it("does not name a box whose AutomationId another element carries (gate 2 on #964)", () => {
    const row2Label = el("Text", "Qty:", { x: 920, y: 200, width: 44, height: 26 }, "/Pane[1]/Text[0]");
    const row2Box = el("Edit", "", { x: 964, y: 200, width: 220, height: 26 }, "/Pane[1]/Edit[1]", { automationId: "tb", patterns: ["Value"] });
    expect(inferLabelsFromLayout([label, box, row2Label, row2Box]).size).toBe(0);
  });

  it("does not lend a row's left label to the box on the next row (gate 2 on #964)", () => {
    // Rows touch; the Name label overlaps its box by 1 px.
    const nameLabel = el("Text", "Name:", { x: 920, y: 163, width: 45, height: 26 }, "/Text[0]");
    const nameBox = el("Edit", "", { x: 964, y: 163, width: 220, height: 26 }, "/Edit[1]", { automationId: "n", patterns: ["Value"] });
    const mailLabel = el("Text", "Email:", { x: 920, y: 189, width: 45, height: 26 }, "/Text[2]");
    const mailBox = el("Edit", "", { x: 964, y: 189, width: 220, height: 26 }, "/Edit[3]", { automationId: "m", patterns: ["Value"] });
    const out = inferLabelsFromLayout([nameLabel, nameBox, mailLabel, mailBox]);
    expect(out.get(1)).toBe("Name");
    expect(out.get(3)).toBe("Email");
  });

  it("does not lend a label above to the second box below it (gate 2 on #964)", () => {
    const addr = el("Text", "Address", { x: 964, y: 120, width: 60, height: 20 }, "/Text[0]");
    const line1 = el("Edit", "", { x: 964, y: 142, width: 220, height: 20 }, "/Edit[1]", { automationId: "a1", patterns: ["Value"] });
    const line2 = el("Edit", "", { x: 964, y: 164, width: 220, height: 20 }, "/Edit[2]", { automationId: "a2", patterns: ["Value"] });
    const out = inferLabelsFromLayout([addr, line1, line2]);
    expect(out.get(1)).toBe("Address");
    expect(out.has(2)).toBe(false);
  });

  it("does not take a separator between two boxes as a label (gate 2 on #964)", () => {
    const w = el("Edit", "", { x: 900, y: 163, width: 60, height: 26 }, "/Edit[0]", { automationId: "w", patterns: ["Value"] });
    const x = el("Text", "x", { x: 964, y: 163, width: 10, height: 26 }, "/Text[1]");
    const h = el("Edit", "", { x: 978, y: 163, width: 60, height: 26 }, "/Edit[2]", { automationId: "h", patterns: ["Value"] });
    expect(inferLabelsFromLayout([w, x, h]).has(2)).toBe(false);
  });

  it("prefers the label on its row to a heading above it", () => {
    const heading = el("Text", "Account", { x: 964, y: 151, width: 80, height: 12 }, "/Text[2]");
    expect(inferLabelsFromLayout([heading, label, box]).get(2)).toBe("Name");
  });

  it("does not name an Edit without ValuePattern (gate 2 on #964)", () => {
    const noValue = { ...box, patterns: [] } as UiElement;
    expect(inferLabelsFromLayout([label, noValue]).size).toBe(0);
  });

  it("does not name a field with no AutomationId (it would be addressed by an empty name)", () => {
    const anon = { ...box, automationId: "" } as UiElement;
    expect(inferLabelsFromLayout([label, anon]).size).toBe(0);
  });

  it("does not take text from another parent, or text too far away", () => {
    const elsewhere = { ...label, path: "/Pane[0]/Text[0]" } as UiElement;
    expect(inferLabelsFromLayout([elsewhere, box]).size).toBe(0);
    const far = { ...label, boundingRect: { x: 700, y: 163, width: 44, height: 26 } } as UiElement;
    expect(inferLabelsFromLayout([far, box]).size).toBe(0);
  });

  it("leaves a field with its own name alone (control)", () => {
    const named = { ...box, name: "Search" } as UiElement;
    expect(inferLabelsFromLayout([label, named]).size).toBe(0);
  });
});

afterEach(() => {
  vi.doUnmock("../../src/engine/uia-bridge.js");
  vi.resetModules();
});

describe("discover's UIA lane keeps the named box (internal #293)", () => {
  it("lists it with the inferred label, its UIA name still empty, and marks the label inferred", async () => {
    vi.resetModules();
    const elements = [label, inner, box, button];
    vi.doMock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
      getUiElements: vi.fn(async () => ({
        windowTitle: "FX293", windowRect: { x: 900, y: 140, width: 400, height: 80 },
        elementCount: elements.length, elements, via: "native",
      })),
    }));
    const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
    const { candidates } = await fetchUiaCandidates({ windowTitle: "FX293" });
    const tb = candidates.find((c) => c.locator?.uia?.automationId === "tb");
    expect(tb).toBeDefined();
    expect(tb!.label).toBe("Name");
    expect(tb!.labelInferred).toBe(true);
    expect(tb!.locator?.uia?.name).toBe("");
    // Offered to type into and read only: a click would go by the id's first match (codex on #964).
    expect(tb!.actionability).toContain("type");
    expect(tb!.actionability).not.toContain("click");
    expect(tb!.actionability).not.toContain("invoke");
    const ok = candidates.find((c) => c.label === "OK");
    expect(ok?.labelInferred).toBeUndefined();
  });
});

describe("discover's reply says the label was inferred, and the act still goes (internal #293)", () => {
  it("carries labelInferred to the entity view, and a type reaches the executor", async () => {
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const tb = {
      source: "uia", target: { kind: "window", id: "FX293" }, label: "Name", labelInferred: true, role: "textbox",
      controlType: "Edit", rect: { x: 964, y: 163, width: 220, height: 26 }, actionability: ["type", "click"],
      confidence: 1, observedAtMs: 0, provisional: false, locator: { uia: { automationId: "tb", name: "" } },
    } as unknown as import("../../src/engine/vision-gpu/types.js").UiEntityCandidate;
    const ok = { ...tb, label: "OK", labelInferred: undefined, role: "button", controlType: "Button", actionability: ["invoke"], locator: { uia: { automationId: "", name: "OK" } } } as typeof tb;
    const execute = vi.fn(async () => "uia" as const);
    const facade = new DesktopFacade(async () => [tb, ok], { executorFn: execute });
    const view = await facade.see({ target: { windowTitle: "FX293" } });
    const field = view.entities.find((e) => e.label === "Name");
    expect(field?.labelInferred).toBe(true);
    expect(view.entities.find((e) => e.label === "OK")?.labelInferred).toBeUndefined();
    const result = await facade.touch({ lease: field!.lease, action: "type", text: "abc" });
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
