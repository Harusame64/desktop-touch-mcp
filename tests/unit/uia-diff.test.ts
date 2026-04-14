/**
 * uia-diff.test.ts — Unit tests for computeUiaDiff
 *
 * Pure function tests — no I/O, no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { computeUiaDiff, degradedRichBlock } from "../../src/engine/uia-diff.js";
import type { UiElement } from "../../src/engine/uia-bridge.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function el(
  name: string,
  controlType = "Button",
  opts: Partial<UiElement> & { boundingRect?: UiElement["boundingRect"] } = {}
): UiElement {
  const hasBoundsKey = Object.prototype.hasOwnProperty.call(opts, "boundingRect");
  return {
    name,
    controlType,
    automationId: opts.automationId ?? "",
    className: opts.className,
    isEnabled: opts.isEnabled ?? true,
    boundingRect: hasBoundsKey ? opts.boundingRect! : { x: 10, y: 10, width: 100, height: 30 },
    patterns: opts.patterns ?? ["InvokePattern"],
    depth: opts.depth ?? 0,
    value: opts.value,
  };
}

function invisible(name: string): UiElement {
  return {
    name,
    controlType: "Button",
    automationId: "",
    isEnabled: true,
    boundingRect: null,
    patterns: [],
    depth: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeUiaDiff", () => {
  it("returns empty diff when snapshots are identical", () => {
    const snap = [el("OK"), el("Cancel")];
    const result = computeUiaDiff(snap, snap);
    expect(result.appeared).toHaveLength(0);
    expect(result.disappeared).toHaveLength(0);
    expect(result.valueDeltas).toHaveLength(0);
    expect(result.truncated).toBeUndefined();
  });

  it("detects appeared elements", () => {
    const before = [el("OK")];
    const after  = [el("OK"), el("Error Dialog", "Dialog")];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(1);
    expect(result.appeared[0].name).toBe("Error Dialog");
    expect(result.appeared[0].type).toBe("Dialog");
    expect(result.disappeared).toHaveLength(0);
  });

  it("detects disappeared elements", () => {
    const before = [el("OK"), el("Spinner", "ProgressBar")];
    const after  = [el("OK")];
    const result = computeUiaDiff(before, after);
    expect(result.disappeared).toHaveLength(1);
    expect(result.disappeared[0].name).toBe("Spinner");
    expect(result.appeared).toHaveLength(0);
  });

  it("detects value deltas when fetchValues was used", () => {
    const before = [el("Email", "Edit", { automationId: "email", value: "old@example.com" })];
    const after  = [el("Email", "Edit", { automationId: "email", value: "new@example.com" })];
    const result = computeUiaDiff(before, after);
    expect(result.valueDeltas).toHaveLength(1);
    expect(result.valueDeltas[0].name).toBe("Email");
    expect(result.valueDeltas[0].before).toBe("old@example.com");
    expect(result.valueDeltas[0].after).toBe("new@example.com");
  });

  it("no value deltas when value field is absent", () => {
    const before = [el("Email", "Edit", { automationId: "email" })];
    const after  = [el("Email", "Edit", { automationId: "email" })];
    const result = computeUiaDiff(before, after);
    expect(result.valueDeltas).toHaveLength(0);
  });

  it("no value deltas when value is unchanged", () => {
    const before = [el("Field", "Edit", { automationId: "f1", value: "same" })];
    const after  = [el("Field", "Edit", { automationId: "f1", value: "same" })];
    const result = computeUiaDiff(before, after);
    expect(result.valueDeltas).toHaveLength(0);
  });

  it("filters out invisible elements (null boundingRect) from appeared/disappeared", () => {
    const before = [el("OK")];
    const after  = [el("OK"), invisible("Hidden")];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
  });

  it("filters out invisible elements from disappeared", () => {
    const before = [el("OK"), invisible("Hidden")];
    const after  = [el("OK")];
    const result = computeUiaDiff(before, after);
    expect(result.disappeared).toHaveLength(0);
  });

  it("filters out elements with empty names", () => {
    const before: UiElement[] = [];
    const after = [el("", "Pane", { automationId: "pane1" })];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
  });

  it("uses automationId as identity key (name change not counted as appeared+disappeared)", () => {
    const before = [el("Old Label", "Edit", { automationId: "field1", value: "x" })];
    const after  = [el("New Label", "Edit", { automationId: "field1", value: "x" })];
    // Same automationId → same element, no appearance/disappearance
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
    expect(result.disappeared).toHaveLength(0);
  });

  it("caps appeared at 5 and reports truncated count", () => {
    const before: UiElement[] = [];
    const after = Array.from({ length: 8 }, (_, i) => el(`Item${i}`));
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(5);
    expect(result.truncated?.appeared).toBe(3);
  });

  it("caps disappeared at 5 and reports truncated count", () => {
    const before = Array.from({ length: 7 }, (_, i) => el(`Item${i}`));
    const after: UiElement[] = [];
    const result = computeUiaDiff(before, after);
    expect(result.disappeared).toHaveLength(5);
    expect(result.truncated?.disappeared).toBe(2);
  });

  it("caps valueDeltas at 3 and reports truncated count", () => {
    const before = Array.from({ length: 5 }, (_, i) =>
      el(`Field${i}`, "Edit", { automationId: `f${i}`, value: "before" })
    );
    const after = Array.from({ length: 5 }, (_, i) =>
      el(`Field${i}`, "Edit", { automationId: `f${i}`, value: "after" })
    );
    const result = computeUiaDiff(before, after);
    expect(result.valueDeltas).toHaveLength(3);
    expect(result.truncated?.valueDeltas).toBe(2);
  });

  it("does not mutate input arrays", () => {
    const before = [el("OK")];
    const after  = [el("OK"), el("Cancel")];
    const beforeLen = before.length;
    const afterLen = after.length;
    computeUiaDiff(before, after);
    expect(before).toHaveLength(beforeLen);
    expect(after).toHaveLength(afterLen);
  });

  it("trims long values to 80 chars with ellipsis", () => {
    const longBefore = "a".repeat(100);
    const longAfter  = "b".repeat(100);
    const before = [el("Field", "Edit", { automationId: "f1", value: longBefore })];
    const after  = [el("Field", "Edit", { automationId: "f1", value: longAfter })];
    const result = computeUiaDiff(before, after);
    expect(result.valueDeltas[0].before.endsWith("…")).toBe(true);
    expect(result.valueDeltas[0].before.length).toBe(81);  // VALUE_TRIM_PREFIX(80) chars + "…"
    expect(result.valueDeltas[0].after.endsWith("…")).toBe(true);
  });

  it("includes automationId in appeared items when present", () => {
    const before: UiElement[] = [];
    const after = [el("Submit", "Button", { automationId: "submit-btn" })];
    const result = computeUiaDiff(before, after);
    expect(result.appeared[0].automationId).toBe("submit-btn");
  });

  it("omits automationId from appeared items when empty", () => {
    const before: UiElement[] = [];
    const after = [el("Submit", "Button")];
    const result = computeUiaDiff(before, after);
    expect(result.appeared[0].automationId).toBeUndefined();
  });

  it("both empty arrays produce empty diff", () => {
    const result = computeUiaDiff([], []);
    expect(result.appeared).toHaveLength(0);
    expect(result.disappeared).toHaveLength(0);
    expect(result.valueDeltas).toHaveLength(0);
    expect(result.truncated).toBeUndefined();
  });

  it("elements with same name but different automationId are tracked independently", () => {
    const before = [el("Field", "Edit", { automationId: "f1", value: "a" })];
    const after  = [el("Field", "Edit", { automationId: "f2", value: "a" })];
    const result = computeUiaDiff(before, after);
    // f1 disappeared, f2 appeared
    expect(result.appeared).toHaveLength(1);
    expect(result.appeared[0].automationId).toBe("f2");
    expect(result.disappeared).toHaveLength(1);
  });

  it("degradedRichBlock returns correct shape", () => {
    const block = degradedRichBlock("chromium_sparse");
    expect(block.diffSource).toBe("none");
    expect(block.diffDegraded).toBe("chromium_sparse");
    expect(block.appeared).toHaveLength(0);
    expect(block.disappeared).toHaveLength(0);
    expect(block.valueDeltas).toHaveLength(0);
  });

  it("degradedRichBlock for timeout has correct diffDegraded", () => {
    const block = degradedRichBlock("timeout");
    expect(block.diffDegraded).toBe("timeout");
  });

  it("degradedRichBlock for no_target has correct diffDegraded", () => {
    const block = degradedRichBlock("no_target");
    expect(block.diffDegraded).toBe("no_target");
    expect(block.diffSource).toBe("none");
  });

  it("detects element that was hidden and became visible (appeared)", () => {
    const before = [el("OK"), invisible("Panel")];
    const after  = [el("OK"), el("Panel", "Pane")];
    const result = computeUiaDiff(before, after);
    // Panel was hidden (null boundingRect) before, now visible → appeared
    expect(result.appeared.some((a) => a.name === "Panel")).toBe(true);
    expect(result.disappeared).toHaveLength(0);
  });

  it("detects element that was visible and became hidden (disappeared)", () => {
    const before = [el("OK"), el("Panel", "Pane")];
    const after  = [el("OK"), invisible("Panel")];
    const result = computeUiaDiff(before, after);
    // Panel was visible, now hidden (null boundingRect) → disappeared
    expect(result.disappeared.some((d) => d.name === "Panel")).toBe(true);
    expect(result.appeared).toHaveLength(0);
  });

  // ── J3 supplement: truncated shape ────────────────────────────────────────

  it("truncated only contains keys for overflowed categories", () => {
    // Only appeared overflows — truncated.disappeared should be absent
    const before: UiElement[] = [];
    const after = Array.from({ length: 7 }, (_, i) => el(`Item${i}`));
    const result = computeUiaDiff(before, after);
    expect(result.truncated?.appeared).toBe(2);
    expect(result.truncated?.disappeared).toBeUndefined();
    expect(result.truncated?.valueDeltas).toBeUndefined();
  });

  it("truncated is undefined when no category overflows", () => {
    const before = [el("A"), el("B")];
    const after  = [el("A"), el("C")];
    const result = computeUiaDiff(before, after);
    // 1 appeared, 1 disappeared — both within caps
    expect(result.truncated).toBeUndefined();
  });

  // ── J3 supplement: name-only fallback key ─────────────────────────────────

  it("uses name+controlType+depth as fallback key when automationId is empty", () => {
    // Same name/type/depth → same key → no appeared/disappeared
    const before = [el("Save", "Button")];
    const after  = [el("Save", "Button")];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
    expect(result.disappeared).toHaveLength(0);
  });

  it("treats same name at different depths as different elements", () => {
    const before = [el("Item", "ListItem", { depth: 1 })];
    const after  = [el("Item", "ListItem", { depth: 2 })];
    const result = computeUiaDiff(before, after);
    // depth differs → different key → appeared + disappeared
    expect(result.appeared).toHaveLength(1);
    expect(result.disappeared).toHaveLength(1);
  });

  // ── J3 supplement: zero-size bounding rect ────────────────────────────────

  it("treats zero-width bounding rect as invisible", () => {
    const zeroWidth: UiElement = {
      ...el("Ghost"), boundingRect: { x: 0, y: 0, width: 0, height: 30 },
    };
    const before: UiElement[] = [];
    const after = [zeroWidth];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
  });

  it("treats zero-height bounding rect as invisible", () => {
    const zeroHeight: UiElement = {
      ...el("Ghost"), boundingRect: { x: 0, y: 0, width: 100, height: 0 },
    };
    const before: UiElement[] = [];
    const after = [zeroHeight];
    const result = computeUiaDiff(before, after);
    expect(result.appeared).toHaveLength(0);
  });
});
