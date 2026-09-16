/**
 * The native window handle's absence says WHICH absence — ADR-036 `internal#118`, observation only.
 *
 * The rule that refuses `other_control` is decided from `entityHwnd` alone, and `entityHwnd` is
 * `locator.uia.nativeWindowHandle`. Both read paths dropped three different cases into one missing
 * key: the property answered a real handle, it answered 0 (UIA says the element is not a window of
 * its own), or the read did not answer at all. **So "the element has no window" — correct — and "the
 * read failed" — a defect — were indistinguishable to the RULE, not only to a reader.**
 *
 * Measured on 2026-09-16 (win2): `c4-refuse-other-control` does not fire on main for a WinForms edit
 * whose control demonstrably has a window, while `c4-refuse-read-only` passes in the same run because
 * rung 6 reads the receiver's state instead. Nothing in the record said which of the three it was.
 *
 * Nothing branches on the new field. These cells drive the PROVIDER — the mapping this PR adds —
 * rather than a hand-built entity, because a cell that builds the locator itself would pass with the
 * mapping deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function uiaAnswering(elements: unknown[]) {
  vi.doMock("../../src/engine/uia-bridge.js", () => ({
    getUiElements: vi.fn(async () => ({ elements, elementCount: elements.length, windowHwnd: "4919" })),
    detectUiaBlind: () => ({ blind: false }),
  }));
  return (await import("../../src/tools/desktop-providers/uia-provider.js")).fetchUiaCandidates;
}

const EL = {
  name: "DELTA", controlType: "Edit", isEnabled: true, automationId: "d1",
  boundingRect: { x: 1, y: 2, width: 3, height: 4 }, patterns: ["Value"],
};

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.resetAllMocks(); vi.resetModules(); });

describe("the three absences of a native window handle", () => {
  it("carries `zero` — the element saying it is not a window of its own", async () => {
    const fetch = await uiaAnswering([{ ...EL, nativeWindowHandleRead: "zero" }]);
    const r = await fetch({ windowTitle: "Dialog", hwnd: "4919" });
    expect(r.candidates[0]?.locator?.uia).toMatchObject({ nativeWindowHandleRead: "zero" });
    expect(r.candidates[0]?.locator?.uia?.nativeWindowHandle).toBeUndefined();
  });

  it("carries `failed` — nobody answered, which is not the same fact", async () => {
    // The pair this field exists for: `zero` is a correct fall-through for rungs 2 and 3, `failed`
    // is a hole. One missing key could not say which, and the rule reads the missing key.
    const fetch = await uiaAnswering([{ ...EL, nativeWindowHandleRead: "failed" }]);
    const r = await fetch({ windowTitle: "Dialog", hwnd: "4919" });
    expect(r.candidates[0]?.locator?.uia).toMatchObject({ nativeWindowHandleRead: "failed" });
  });

  it("carries `value` beside the handle it belongs to", async () => {
    const fetch = await uiaAnswering([{ ...EL, nativeWindowHandle: "12345", nativeWindowHandleRead: "value" }]);
    const r = await fetch({ windowTitle: "Dialog", hwnd: "4919" });
    expect(r.candidates[0]?.locator?.uia).toMatchObject({
      nativeWindowHandle: "12345", nativeWindowHandleRead: "value",
    });
  });

  it("leaves it absent when the read is older than the field, rather than guessing", async () => {
    // A build that predates the field sends nothing, and absent stays absent: reporting `"zero"` for
    // a read that never had an opinion is the defect this field exists to end, one layer over.
    const fetch = await uiaAnswering([EL]);
    const r = await fetch({ windowTitle: "Dialog", hwnd: "4919" });
    expect(r.candidates[0]?.locator?.uia?.nativeWindowHandleRead).toBeUndefined();
    expect(r.candidates[0]?.locator?.uia?.name).toBe("DELTA");
  });
});
