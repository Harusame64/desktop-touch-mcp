/**
 * internal #126 — `productionFindBlockingWindow` with NO injected reads: the production defaults.
 *
 * Gate 2, round 3: every other cell hands the finder its OS reads, so reverting the default owner
 * walk to `getWindowRootOwner` — the very defect win2 measured on WinForms (internal `e7f3980`) —
 * left them all green. Here the win32 module itself is the model, and it answers the way the
 * machine did: `GA_ROOTOWNER` returns a WinForms dialog ITSELF, only `GW_OWNER` names its owner,
 * and the filtered enumeration drops untitled windows.
 */
import { describe, expect, it, vi } from "vitest";

import type { UiEntity } from "../../src/engine/world-graph/types.js";

interface W { owner: bigint | null; enabled: boolean; title: string; thread: number }
const desktop = new Map<bigint, W>();
const order: bigint[] = [];

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...original,
    getWindowRoot: (h: bigint) => h,
    isWindowEnabled: (h: bigint) => desktop.get(h)?.enabled ?? true,
    getWindowOwner: (h: bigint) => desktop.get(h)?.owner ?? null,
    // What the machine answered for a WinForms Form dialog: itself.
    getWindowRootOwner: (h: bigint) => h,
    getWindowThreadId: (h: bigint) => desktop.get(h)?.thread ?? 0,
    enumTopLevelWindowHandles: () => [...order],
    // The filtered enumeration skips untitled windows — a finder that switched to it would lose them.
    enumWindowsInZOrder: () => order.filter((h) => (desktop.get(h)?.title ?? "") !== "").map((hwnd) => ({ hwnd, title: desktop.get(hwnd)!.title })),
    getWindowRenderState: () => ({ rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, minimized: false, cloaked: false }),
    getWindowTitleW: (h: bigint) => desktop.get(h)?.title ?? "",
    getWindowClassName: () => "WindowsForms10.Window",
    getWindowIdentity: () => ({ pid: 0, processName: "", processStartTimeMs: 0 }),
  };
});

const { productionFindBlockingWindow } = await import("../../src/tools/desktop-register.js");

function setDesktop(windows: [bigint, W][]): void {
  desktop.clear();
  order.length = 0;
  for (const [h, w] of windows) {
    desktop.set(h, w);
    order.push(h);
  }
}

const entityIn = (hwnd: string): UiEntity => ({
  entityId: "e1",
  role: "button",
  label: "OK",
  confidence: 0.9,
  sources: ["uia"],
  affordances: [],
  generation: "g",
  evidenceDigest: "d",
  origin: { kind: "window", id: "Editor", hwnd },
});

describe("the production defaults", () => {
  it("walk GW_OWNER, so a WinForms dialog that is its own GA_ROOTOWNER is found", () => {
    setDesktop([
      [777n, { owner: 500n, enabled: true, title: "MODAL", thread: 1 }],
      [500n, { owner: null, enabled: false, title: "MAIN", thread: 1 }],
    ]);
    // On the main window's thread the thread fallback would find the dialog even with a broken
    // owner walk, so the dialog is put on another thread: this cell answers for the walk alone.
    desktop.get(777n)!.thread = 2;
    expect(productionFindBlockingWindow(entityIn("500"), undefined)).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("walk the whole owner chain, not a fixed two steps", () => {
    // MAIN ← A ← B ← C: the live dialog is three owners from the top.
    setDesktop([
      [800n, { owner: 700n, enabled: true, title: "C", thread: 3 }],
      [700n, { owner: 600n, enabled: false, title: "B", thread: 1 }],
      [600n, { owner: 500n, enabled: false, title: "A", thread: 1 }],
      [500n, { owner: null, enabled: false, title: "MAIN", thread: 1 }],
    ]);
    expect(productionFindBlockingWindow(entityIn("500"), undefined)).toMatchObject({ kind: "blocked", blocker: { hwnd: "800" } });
  });

  it("list every top-level window, untitled ones included", () => {
    setDesktop([
      [777n, { owner: 500n, enabled: true, title: "", thread: 2 }],
      [500n, { owner: null, enabled: false, title: "MAIN", thread: 1 }],
    ]);
    expect(productionFindBlockingWindow(entityIn("500"), undefined)).toMatchObject({ kind: "blocked", blocker: { hwnd: "777" } });
  });

  it("ask the thread when the modal owns nothing and nothing owns it", () => {
    setDesktop([
      [880n, { owner: null, enabled: true, title: "Task modal", thread: 1 }],
      [500n, { owner: null, enabled: false, title: "MAIN", thread: 1 }],
    ]);
    expect(productionFindBlockingWindow(entityIn("500"), undefined)).toMatchObject({ kind: "blocked", blocker: { hwnd: "880" } });
  });
});
