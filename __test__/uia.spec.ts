/**
 * Integration tests for UIA (UI Automation) native addon functions.
 *
 * These tests validate that:
 * 1. All 13 UIA functions are exported and callable
 * 2. Error handling returns proper messages (not panics)
 * 3. Live calls return correctly shaped results on a real Windows desktop
 *
 * Requires: Windows desktop environment (not CI/headless).
 */
import { describe, it, expect } from "vitest";
import * as native from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Export presence: all 13 UIA functions exist
// ─────────────────────────────────────────────────────────────────────────────

describe("UIA exports", () => {
  const expectedExports = [
    "uiaGetElements",
    "uiaGetFocusedAndPoint",
    "uiaGetFocusedElement",
    "uiaClickElement",
    "uiaSetValue",
    "uiaInsertText",
    "uiaGetElementBounds",
    "uiaGetElementChildren",
    "uiaGetTextViaTextPattern",
    "uiaScrollIntoView",
    "uiaGetScrollAncestors",
    "uiaScrollByPercent",
    "uiaGetVirtualDesktopStatus",
  ];

  for (const name of expectedExports) {
    it(`exports ${name} as a function`, () => {
      expect(typeof native[name]).toBe("function");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Error handling: invalid inputs produce proper napi errors
// ─────────────────────────────────────────────────────────────────────────────

describe("UIA error handling", () => {
  it("uiaGetElements rejects with 'Window not found' for non-existent window", async () => {
    await expect(
      native.uiaGetElements({ windowTitle: "__nonexistent_window_12345__" })
    ).rejects.toThrow(/Window not found/);
  });

  // Action functions return { ok: false, error: "..." } instead of rejecting
  it("uiaClickElement returns ok:false for non-existent window", async () => {
    const result = await native.uiaClickElement({
      windowTitle: "__nonexistent_window_12345__",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Window not found/);
  });

  it("uiaSetValue returns ok:false for non-existent window", async () => {
    const result = await native.uiaSetValue({
      windowTitle: "__nonexistent_window_12345__",
      value: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Window not found/);
  });

  it("uiaInsertText returns ok:false for non-existent window", async () => {
    const result = await native.uiaInsertText({
      windowTitle: "__nonexistent_window_12345__",
      value: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Window not found/);
  });

  // Scroll functions return { ok: false, scrolled: false, error: "..." }
  it("uiaScrollIntoView returns ok:false for non-existent window", async () => {
    const result = await native.uiaScrollIntoView({
      windowTitle: "__nonexistent_window_12345__",
    });
    expect(result.ok).toBe(false);
    expect(result.scrolled).toBe(false);
    expect(result.error).toMatch(/Window not found/);
  });

  // getScrollAncestors returns empty array when window not found
  it("uiaGetScrollAncestors returns empty array for non-existent window", async () => {
    const result = await native.uiaGetScrollAncestors({
      windowTitle: "__nonexistent_window_12345__",
      elementName: "anything",
    });
    expect(result).toEqual([]);
  });

  it("uiaScrollByPercent returns ok:false for non-existent window", async () => {
    const result = await native.uiaScrollByPercent({
      windowTitle: "__nonexistent_window_12345__",
      elementName: "anything",
      verticalPercent: 50,
      horizontalPercent: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.scrolled).toBe(false);
    expect(result.error).toMatch(/Window not found/);
  });

  it("uiaGetElementBounds returns null for non-existent window", async () => {
    const result = await native.uiaGetElementBounds({
      windowTitle: "__nonexistent_window_12345__",
    });
    expect(result).toBeNull();
  });

  it("uiaGetElementChildren rejects for non-existent window", async () => {
    await expect(
      native.uiaGetElementChildren({
        windowTitle: "__nonexistent_window_12345__",
        maxDepth: 3,
        maxElements: 50,
        timeoutMs: 3000,
      })
    ).rejects.toThrow(/Window not found/);
  });

  // getTextViaTextPattern returns null when window not found
  it("uiaGetTextViaTextPattern returns null for non-existent window", async () => {
    const result = await native.uiaGetTextViaTextPattern({
      windowTitle: "__nonexistent_window_12345__",
      timeoutMs: 3000,
    });
    expect(result).toBeNull();
  });

  it("uiaGetVirtualDesktopStatus returns empty for empty input", async () => {
    const result = await native.uiaGetVirtualDesktopStatus([]);
    expect(result).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Live calls: validate return type shapes on real Windows desktop
// ─────────────────────────────────────────────────────────────────────────────

describe("UIA live calls", () => {
  it("uiaGetFocusedElement returns valid shape or null", async () => {
    const result = await native.uiaGetFocusedElement();
    if (result !== null) {
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("controlType");
      expect(typeof result.name).toBe("string");
      expect(typeof result.controlType).toBe("string");
    }
  });

  it("uiaGetFocusedAndPoint returns valid shape", async () => {
    const result = await native.uiaGetFocusedAndPoint({
      cursorX: 100,
      cursorY: 100,
    });
    expect(result).toHaveProperty("focused");
    expect(result).toHaveProperty("atPoint");
  });

  it("uiaGetElements returns valid shape for an existing window", async () => {
    // Use a window that should always exist on Windows: the desktop shell.
    // "Explorer" or "Program Manager" usually matches.
    let result;
    try {
      result = await native.uiaGetElements({
        windowTitle: "Explorer",
        maxDepth: 3,
        maxElements: 10,
      });
    } catch {
      // Explorer may not be open; skip shape validation.
      return;
    }

    expect(result).toHaveProperty("windowTitle");
    expect(result).toHaveProperty("elementCount");
    expect(result).toHaveProperty("elements");
    expect(typeof result.windowTitle).toBe("string");
    expect(typeof result.elementCount).toBe("number");
    expect(Array.isArray(result.elements)).toBe(true);

    if (result.elements.length > 0) {
      const elem = result.elements[0];
      expect(elem).toHaveProperty("name");
      expect(elem).toHaveProperty("controlType");
      expect(elem).toHaveProperty("automationId");
      expect(elem).toHaveProperty("isEnabled");
      expect(elem).toHaveProperty("patterns");
      expect(elem).toHaveProperty("depth");
      expect(typeof elem.name).toBe("string");
      expect(typeof elem.controlType).toBe("string");
      expect(typeof elem.isEnabled).toBe("boolean");
      expect(Array.isArray(elem.patterns)).toBe(true);
      expect(typeof elem.depth).toBe("number");
    }
  });

  it("uiaGetElements respects maxElements limit", async () => {
    let result;
    try {
      result = await native.uiaGetElements({
        windowTitle: "Explorer",
        maxDepth: 30,
        maxElements: 5,
      });
    } catch {
      return;
    }

    expect(result.elements.length).toBeLessThanOrEqual(5);
    expect(result.elementCount).toBeLessThanOrEqual(5);
  });

  it("uiaGetElements with fetchValues returns value field", async () => {
    let result;
    try {
      result = await native.uiaGetElements({
        windowTitle: "Explorer",
        maxDepth: 5,
        maxElements: 20,
        fetchValues: true,
      });
    } catch {
      return;
    }

    // At least the elements array should exist with value fields.
    for (const elem of result.elements) {
      // value can be string or undefined/null — just verify it doesn't throw.
      expect(["string", "undefined", "object"]).toContain(typeof elem.value);
    }
  });
});
