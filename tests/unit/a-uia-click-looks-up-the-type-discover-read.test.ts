/**
 * internal #233 PR4 — the UIA click looked its element up by name alone (a substring of the name), so
 * another element whose name contains the same text, such as the label beside the button it names,
 * could be the one pressed. The executor now hands the lookup the control type discover read.
 */
import { describe, expect, it, vi } from "vitest";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const aim: Aim = { kind: "aim", title: "PR4-CELL", hwnd: 4920n };
const entity = (over: Partial<UiEntity> = {}): UiEntity => ({
  entityId: "u1", role: "button", label: "Save", confidence: 0.9, sources: ["uia"], controlType: "Button",
  locator: { uia: { name: "Save", via: "native" } },
  affordances: [{ verb: "invoke", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
  generation: "gen-1", evidenceDigest: "d", rect: { x: 1, y: 2, width: 3, height: 4 },
  ...over,
} as UiEntity);

function deps(): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
  };
}

describe("the UIA click looks the element up by the control type discover read (internal #233 PR4)", () => {
  it("passes the entity's control type to the lookup", async () => {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const d = deps();
    await createDesktopExecutor(aim, d)(entity(), "invoke");
    expect(d.uiaClick).toHaveBeenCalledTimes(1);
    expect((d.uiaClick as ReturnType<typeof vi.fn>).mock.calls[0]![4]).toBe("Button");
  });

  it("leaves the argument off for an entity no UIA read typed, as before", async () => {
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const d = deps();
    await createDesktopExecutor(aim, d)(entity({ controlType: undefined }), "invoke");
    expect((d.uiaClick as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(4);
  });

  it("does not filter by a type the click's client might name differently (gate 2 on #920)", async () => {
    const { clickLookupControlType } = await import("../../src/tools/desktop-executor.js");
    // read by the PowerShell client: its type names differ from the native click's
    expect(clickLookupControlType(entity({ locator: { uia: { name: "Save", via: "powershell" } } } as Partial<UiEntity>))).toBeUndefined();
    expect(clickLookupControlType(entity({ locator: { uia: { name: "Save" } } } as Partial<UiEntity>))).toBeUndefined();
    // the types the clients, or the native one by state, name differently
    for (const ct of ["Edit", "Document", "Text"]) expect(clickLookupControlType(entity({ controlType: ct }))).toBeUndefined();
    // the ones measured in the WPF twin
    for (const ct of ["Button", "MenuItem", "Hyperlink"]) expect(clickLookupControlType(entity({ controlType: ct }))).toBe(ct);
  });
});
