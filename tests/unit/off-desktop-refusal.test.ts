/**
 * internal #221 — the refusal a tool gives instead of bringing a window on another virtual desktop
 * forward: which window it names, whether a same-titled one is here, and the code a caller gets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** What `IVirtualDesktopManager` answers per handle; `undefined` models an engine without it. */
const { vdm } = vi.hoisted(() => ({ vdm: { answer: undefined as undefined | ((h: string) => boolean), calls: 0 } }));
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return {
    ...actual,
    get nativeUia() {
      if (!vdm.answer) return null;
      return {
        uiaGetVirtualDesktopStatus: async (hs: string[]) => {
          vdm.calls++;
          return Object.fromEntries(hs.map((h) => [h, vdm.answer!(h)]));
        },
      };
    },
  };
});

const { offDesktopTarget, offDesktopFailure } = await import("../../src/tools/_off-desktop.js");

const w = (hwnd: bigint, title: string, isCloaked?: boolean) => ({ hwnd, title, ...(isCloaked !== undefined && { isCloaked }) });

beforeEach(() => { vdm.answer = () => false; vdm.calls = 0; });

describe("offDesktopTarget", () => {
  it("is null for a window that is not cloaked, and does not ask the desktop manager", async () => {
    expect(await offDesktopTarget(w(1n, "A", false), [], "A")).toBeNull();
    expect(await offDesktopTarget(w(1n, "A"), [], "A")).toBeNull();
    expect(vdm.calls).toBe(0);
  });

  it("is null for a cloaked window the desktop manager says is on this desktop (an app-hidden window)", async () => {
    vdm.answer = () => true;
    expect(await offDesktopTarget(w(1n, "A", true), [], "A")).toBeNull();
    expect(vdm.calls).toBe(1);
  });

  it("names a cloaked window the desktop manager says is elsewhere", async () => {
    expect(await offDesktopTarget(w(1n, "A", true), [], "A")).toEqual({ hwnd: 1n, title: "A", sameTitleOnScreen: false });
  });

  it("takes a cloaked window to be elsewhere when the desktop manager cannot be asked", async () => {
    vdm.answer = undefined;
    expect(await offDesktopTarget(w(1n, "A", true), [], "A")).not.toBeNull();
  });

  it("says whether another window wearing the named title is on this desktop", async () => {
    const away = w(1n, "QV221 - x", true);
    expect((await offDesktopTarget(away, [away, w(2n, "qv221", false)], "QV221"))?.sameTitleOnScreen).toBe(true);
    // Not the target itself, not another cloaked one, not a different title.
    expect((await offDesktopTarget(away, [away, w(3n, "QV221", true), w(4n, "Other", false)], "QV221"))?.sameTitleOnScreen).toBe(false);
  });

  it("does not look for a same-titled window when the call named a handle", async () => {
    const away = w(1n, "QV221", true);
    expect(await offDesktopTarget(away, [away, w(2n, "QV221", false)], undefined)).toEqual({ hwnd: 1n, title: "QV221", sameTitleOnScreen: false });
  });

  it("enumerates lazily: a window list passed as a function is not read for a window that is not cloaked", async () => {
    const list = vi.fn(() => [] as never[]);
    await offDesktopTarget(w(1n, "A", false), list, "A");
    expect(list).not.toHaveBeenCalled();
  });
});

describe("offDesktopFailure", () => {
  it("answers WindowOnOtherDesktop, with the window and the advice", () => {
    const r = JSON.parse(offDesktopFailure("keyboard:type", { hwnd: 7n, title: "QV221", sameTitleOnScreen: true }).content[0]!.text as string);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowOnOtherDesktop");
    expect(r.error).toMatch(/another virtual desktop/);
    expect(r.context).toMatchObject({ hwnd: "7", windowTitle: "QV221", sameTitleOnScreen: true });
    expect(r.suggest.length).toBe(3);
  });
});
