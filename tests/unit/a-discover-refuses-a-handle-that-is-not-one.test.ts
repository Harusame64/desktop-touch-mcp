/**
 * internal #295 — `desktop_discover` with a `target.hwnd` that is not a handle, and nothing else to aim
 * by, is refused instead of reading the foreground window.
 *
 * MEASURED win2 (2026-10-14, the #289 round on PR #822): a discover whose `target.hwnd` was `""` read the
 * window in front, and the act on its lease wrote into it and answered ok:true.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopDiscoverRawHandler,
  desktopDiscoverRegistrationHandler,
  getDesktopFacade,
  unusableHandleRefusal,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";

afterEach(() => {
  vi.restoreAllMocks();
  _resetFacadeForTest();
});

function spySee() {
  return vi.spyOn(getDesktopFacade(), "see").mockResolvedValue({ viewId: "v", entities: [] } as never);
}

describe("discover by a target.hwnd that is not a handle", () => {
  it.each(["", "abc", "0", "-1", " ", "1e3", "12abc"])("refuses %j alone, with InvalidArgs, and reads nothing", async (hwnd) => {
    const see = spySee();
    const result = await desktopDiscoverRawHandler({ target: { hwnd } });
    const body = JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean; code: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("InvalidArgs");
    expect(body.error).toContain(`target.hwnd ${JSON.stringify(hwnd)} is not a window handle`);
    expect(see).not.toHaveBeenCalled();
  });

  it("still reads by a handle, decimal or hex, as BigInt reads it (whitespace around it is allowed)", async () => {
    const see = spySee();
    await desktopDiscoverRawHandler({ target: { hwnd: "123" } });
    await desktopDiscoverRawHandler({ target: { hwnd: "0x7B" } });
    await desktopDiscoverRawHandler({ target: { hwnd: " 123" } });
    expect(see).toHaveBeenCalledTimes(3);
  });

  it("refuses through the registered tool too, the one run_macro calls, and inside an envelope", async () => {
    const see = spySee();
    const result = await desktopDiscoverRegistrationHandler({ target: { hwnd: "" }, include: ["envelope"] });
    const body = JSON.parse((result.content[0] as { text: string }).text) as { data: { ok: boolean; code: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.code).toBe("InvalidArgs");
    expect(see).not.toHaveBeenCalled();
  });

  it("still aims by a title or a tab sent beside it", async () => {
    const see = spySee();
    await desktopDiscoverRawHandler({ target: { hwnd: "", windowTitle: "メモ帳" } });
    await desktopDiscoverRawHandler({ target: { hwnd: "-1", tabId: "t1" } });
    await desktopDiscoverRawHandler({ target: { hwnd: "", windowTitle: "メモ帳", tabId: "" } });
    expect(see).toHaveBeenCalledTimes(3);
  });

  it("refuses when the title and the tab beside it are empty too", () => {
    expect(unusableHandleRefusal({ hwnd: "", windowTitle: "", tabId: "" })).toBeDefined();
  });

  it("leaves a call with no target, or no hwnd, to read the foreground as before", async () => {
    const see = spySee();
    await desktopDiscoverRawHandler({});
    await desktopDiscoverRawHandler({ target: {} });
    expect(see).toHaveBeenCalledTimes(2);
  });
});
