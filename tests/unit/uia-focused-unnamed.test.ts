/**
 * tests/unit/uia-focused-unnamed.test.ts
 * #352 follow-up (ADR-022 §5.5) — `getFocusedAndPointInfo` `includeUnnamed` opt-in.
 *
 * Pins the bridge-level guard relax (G1 native `toInfo`, via the shared
 * `dropFocusRow` predicate) and — critically — the REGRESSION invariant: without
 * the flag, a name-empty row is still dropped, so `_mouse-verify` / `desktop_state`
 * / perception (none of which pass the flag) stay byte-equal. The native path is
 * mocked; G2 (PowerShell) shares the same `dropFocusRow` predicate, so this also
 * covers the predicate logic G2 uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeUia: { uiaGetFocusedAndPoint: vi.fn() },
}));

import { getFocusedAndPointInfo } from "../../src/engine/uia-bridge.js";
import { nativeUia } from "../../src/engine/native-engine.js";

const mockGetFocusedAndPoint = vi.mocked(nativeUia!.uiaGetFocusedAndPoint);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFocusedAndPointInfo — includeUnnamed opt-in (#352)", () => {
  it("DEFAULT (no flag): drops a name-empty editable row (byte-equal regression pin)", async () => {
    // mouse-verify / desktop_state / perception all call WITHOUT the flag. A
    // name-empty Edit must still resolve to null exactly as before this change.
    mockGetFocusedAndPoint.mockResolvedValue({
      focused: { name: "", controlType: "Edit", value: "" },
      atPoint: null,
    } as never);
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800);
    expect(focused).toBeNull();
  });

  it("includeUnnamed=true: keeps a name-empty editable row (name:'')", async () => {
    mockGetFocusedAndPoint.mockResolvedValue({
      focused: { name: "", controlType: "Edit", value: "" },
      atPoint: null,
    } as never);
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800, true);
    expect(focused).not.toBeNull();
    expect(focused!.name).toBe("");
    expect(focused!.controlType).toBe("Edit");
    expect(focused!.value).toBe("");
  });

  it("includeUnnamed=true: still drops a DEGENERATE row (no name AND no controlType)", async () => {
    mockGetFocusedAndPoint.mockResolvedValue({
      focused: { name: "", controlType: "" },
      atPoint: null,
    } as never);
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800, true);
    expect(focused).toBeNull();
  });

  it("named rows are unaffected by the flag (kept either way)", async () => {
    mockGetFocusedAndPoint.mockResolvedValue({
      focused: { name: "Editor", controlType: "Edit", value: "v" },
      atPoint: null,
    } as never);
    const off = await getFocusedAndPointInfo(0, 0, false, 800);
    const on = await getFocusedAndPointInfo(0, 0, false, 800, true);
    expect(off.focused).toEqual({ name: "Editor", controlType: "Edit", value: "v" });
    expect(on.focused).toEqual({ name: "Editor", controlType: "Edit", value: "v" });
  });
});
