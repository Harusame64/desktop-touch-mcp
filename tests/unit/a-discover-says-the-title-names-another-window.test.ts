/**
 * internal #223 — a discover that names a handle and a title says when they name different windows.
 *
 * MEASURED win2 (2026-09-30, `main` `101f43b8`): with Notepads A "*QA23 - メモ帳" and B
 * "*QB23 - メモ帳" open, `{hwnd: A, windowTitle: "QB23"}` read A with `warnings: null`. The title
 * was dropped on the way (the ingress fetches by the session key `window:<hwnd>`). The user chose
 * (2026-09-30) to keep the handle winning and say so: `target_title_mismatch`.
 */
import { describe, expect, it } from "vitest";

import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { SnapshotIngress } from "../../src/engine/world-graph/candidate-ingress.js";
import { DesktopFacade, type DesktopWindowMeta } from "../../src/tools/desktop.js";

const A = "1772848";
const B = "1772900";

function win(hwnd: string, title: string): DesktopWindowMeta {
  return { hwnd, title, region: { x: 0, y: 0, width: 800, height: 600 }, zOrder: 0, isActive: false } as unknown as DesktopWindowMeta;
}

const button = {
  source: "uia", target: { kind: "window", id: A }, label: "保存", role: "button",
  rect: { x: 10, y: 10, width: 60, height: 20 }, actionability: ["invoke"], confidence: 0.9,
  observedAtMs: 0, provisional: false, digest: "d-save", locator: { uia: { name: "保存" } },
} as unknown as UiEntityCandidate;

async function discover(target: { hwnd?: string; windowTitle?: string }, windows = [win(A, "*QA23 - メモ帳"), win(B, "*QB23 - メモ帳")]) {
  const facade = new DesktopFacade(async () => [button], { windowsProvider: () => windows });
  return facade.see({ target });
}

/** As production reads: through the ingress, whose target carries the title the read resolved. */
async function discoverRead(target: { hwnd: string; windowTitle: string }, resolvedTitle: string, windows = [win(A, "*QA23 - メモ帳")]) {
  const ingress = new SnapshotIngress(async () => ({
    candidates: [button], warnings: [], target: { hwnd: target.hwnd, windowTitle: resolvedTitle },
  }));
  const facade = new DesktopFacade(async () => [button], { ingress, windowsProvider: () => windows });
  return facade.see({ target });
}

describe("desktop_discover with a handle and a title, against the title the read resolved (gate 2)", () => {
  it("says nothing when the read moved to the popup the caller named (Save As over Notepad)", async () => {
    const view = await discoverRead({ hwnd: A, windowTitle: "名前を付けて保存" }, "名前を付けて保存");
    expect(view.warnings).toBeUndefined();
  });

  it("says it for a window the windows list leaves out (untitled or small), from the read's title", async () => {
    const view = await discoverRead({ hwnd: "4242", windowTitle: "QB23" }, "Game Surface", []);
    expect(view.warnings).toEqual(["target_title_mismatch"]);
  });

  it("says it when the read's title disagrees, though the list's would agree (the read wins)", async () => {
    const view = await discoverRead({ hwnd: A, windowTitle: "QA23" }, "*Renamed - メモ帳");
    expect(view.warnings).toEqual(["target_title_mismatch"]);
  });
});

describe("desktop_discover with a handle and a title", () => {
  it("says nothing for @active, a keyword and not a title, and for a blank title (gate 2)", async () => {
    expect((await discover({ hwnd: A, windowTitle: "@active" })).warnings).toBeUndefined();
    expect((await discover({ hwnd: A, windowTitle: "  " })).warnings).toBeUndefined();
  });

  it("trims the title before matching it", async () => {
    expect((await discover({ hwnd: A, windowTitle: " QA23 " })).warnings).toBeUndefined();
  });

  it("says target_title_mismatch when the handle's window does not carry the title, and still reads it", async () => {
    const view = await discover({ hwnd: A, windowTitle: "QB23" });
    expect(view.warnings).toEqual(["target_title_mismatch"]);
    expect(view.entities.map((e) => e.label)).toEqual(["保存"]);
  });

  it("says nothing when the title is part of the handle's window's own, whatever its case", async () => {
    expect((await discover({ hwnd: A, windowTitle: "qa23" })).warnings).toBeUndefined();
    expect((await discover({ hwnd: A, windowTitle: "*QA23 - メモ帳" })).warnings).toBeUndefined();
  });

  it("says nothing for a handle alone or a title alone (the controls)", async () => {
    expect((await discover({ hwnd: A })).warnings).toBeUndefined();
    expect((await discover({ windowTitle: "QB23" })).warnings).toBeUndefined();
  });

  it("says nothing when the windows list does not hold the handle: nothing says what its title is", async () => {
    expect((await discover({ hwnd: A, windowTitle: "QB23" }, [win(B, "*QB23 - メモ帳")])).warnings).toBeUndefined();
  });

  it("does not make the mismatch a constraint: it is not a reason for an empty list", async () => {
    const view = await discover({ hwnd: A, windowTitle: "QB23" });
    expect(view.constraints).toBeUndefined();
  });
});
