/**
 * internal #221 — the refusal a tool gives instead of bringing a window on another virtual desktop
 * forward: which window it names, whether a same-titled one is here, and the code a caller gets.
 */

import { describe, it, expect } from "vitest";
import { offDesktopTarget, offDesktopFailure } from "../../src/tools/_off-desktop.js";

const w = (hwnd: bigint, title: string, isCloaked?: boolean) => ({ hwnd, title, ...(isCloaked !== undefined && { isCloaked }) });

describe("offDesktopTarget", () => {
  it("is null for a window on this desktop, and for one whose cloak could not be read", () => {
    expect(offDesktopTarget(w(1n, "A", false), [], "A")).toBeNull();
    expect(offDesktopTarget(w(1n, "A"), [], "A")).toBeNull();
  });

  it("says whether another window wearing the named title is on this desktop", () => {
    const away = w(1n, "QV221 - x", true);
    expect(offDesktopTarget(away, [away, w(2n, "qv221", false)], "QV221")?.sameTitleOnScreen).toBe(true);
    // Not the target itself, not another cloaked one, not a different title.
    expect(offDesktopTarget(away, [away, w(3n, "QV221", true), w(4n, "Other", false)], "QV221")?.sameTitleOnScreen).toBe(false);
  });

  it("does not look for a same-titled window when the call named a handle", () => {
    const away = w(1n, "QV221", true);
    expect(offDesktopTarget(away, [away, w(2n, "QV221", false)], undefined)).toEqual({ hwnd: 1n, title: "QV221", sameTitleOnScreen: false });
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
