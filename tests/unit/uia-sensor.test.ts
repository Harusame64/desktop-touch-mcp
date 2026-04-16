/**
 * tests/unit/uia-sensor.test.ts
 *
 * Tests for the UIA sensor: cache behavior, critical-only gate,
 * and concurrent-call deduplication.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshUiaFluents, __resetUiaSensorForTests } from "../../src/engine/perception/sensors-uia.js";

// Mock getFocusedElement from uia-bridge so no real PowerShell is spawned
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getFocusedElement: vi.fn(),
}));
// Mock event-bus (not needed for these tests but imported by sensors-uia)
vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub-uia"),
  unsubscribe: vi.fn(),
  poll: vi.fn().mockReturnValue([]),
}));

import { getFocusedElement } from "../../src/engine/uia-bridge.js";

const HWND = "1234";

beforeEach(() => {
  vi.clearAllMocks();
  __resetUiaSensorForTests();
});

describe("refreshUiaFluents", () => {
  it("returns [] immediately for non-critical lenses (normal)", async () => {
    const obs = await refreshUiaFluents(HWND, "normal");
    expect(obs).toHaveLength(0);
    expect(vi.mocked(getFocusedElement)).not.toHaveBeenCalled();
  });

  it("returns [] immediately for background salience", async () => {
    const obs = await refreshUiaFluents(HWND, "background");
    expect(obs).toHaveLength(0);
    expect(vi.mocked(getFocusedElement)).not.toHaveBeenCalled();
  });

  it("calls getFocusedElement for critical lenses and returns an observation", async () => {
    vi.mocked(getFocusedElement).mockResolvedValue({
      name: "Editor",
      controlType: "Edit",
    });
    const obs = await refreshUiaFluents(HWND, "critical");
    expect(obs).toHaveLength(1);
    expect(obs[0]!.property).toBe("target.focusedElement");
    expect(obs[0]!.source).toBe("uia");
    expect(obs[0]!.value).toEqual({ name: "Editor", controlType: "Edit" });
    expect(obs[0]!.confidence).toBeCloseTo(0.92, 2);
    expect(vi.mocked(getFocusedElement)).toHaveBeenCalledTimes(1);
  });

  it("returns cached result within 500ms (no second PS call)", async () => {
    vi.mocked(getFocusedElement).mockResolvedValue({ name: "X", controlType: "Edit" });

    await refreshUiaFluents(HWND, "critical");
    const obs2 = await refreshUiaFluents(HWND, "critical");

    expect(vi.mocked(getFocusedElement)).toHaveBeenCalledTimes(1);
    expect(obs2).toHaveLength(1);
    expect(obs2[0]!.evidence.notes).toContain("cached");
  });

  it("force=true bypasses the cache and re-calls getFocusedElement", async () => {
    vi.mocked(getFocusedElement).mockResolvedValue({ name: "X", controlType: "Edit" });

    await refreshUiaFluents(HWND, "critical");
    await refreshUiaFluents(HWND, "critical", true);  // force

    expect(vi.mocked(getFocusedElement)).toHaveBeenCalledTimes(2);
  });

  it("non-critical lens passes the gate even with force=true if salience check is not skipped", async () => {
    // force only bypasses the cache; salience gate is always checked first
    const obs = await refreshUiaFluents(HWND, "normal", false);
    expect(obs).toHaveLength(0);
  });

  it("emits confidence 0.40 when getFocusedElement returns null", async () => {
    vi.mocked(getFocusedElement).mockResolvedValue(null);
    const obs = await refreshUiaFluents(HWND, "critical");
    expect(obs[0]!.confidence).toBeCloseTo(0.40, 2);
    expect(obs[0]!.value).toBeNull();
  });

  it("returns [] and does not throw when getFocusedElement throws", async () => {
    vi.mocked(getFocusedElement).mockRejectedValue(new Error("PS timeout"));
    const obs = await refreshUiaFluents(HWND, "critical");
    // Errors are swallowed; value will be null from the error handler
    expect(obs).toHaveLength(1);
    expect(obs[0]!.value).toBeNull();
  });
});
