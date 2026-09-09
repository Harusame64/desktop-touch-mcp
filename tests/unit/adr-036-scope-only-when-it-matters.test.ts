/**
 * ADR-036 — scoping a read to a handle is a correction for ambiguity, not a different read.
 *
 * It is not free: neither `uiaGetElements` nor `uiaGetTextViaTextPattern` takes a handle, so a
 * scoped read leaves the Rust engine for a PowerShell round trip — 184 ms against 517 ms on the
 * same window (Windows, 2026-09-09). `normalizeTarget` fills a handle from the foreground even
 * for a bare `desktop_discover()`, so scoping unconditionally put every discover on that path.
 *
 * The predicate decides when the title already reaches exactly the window the handle names.
 */
import { describe, it, expect } from "vitest";
import { titleAlreadyNamesOnly, psTreeBudgetMs, psReadWaitMs } from "../../src/engine/uia-bridge.js";

const A = { hwnd: 0x1111n, title: "Untitled - Notepad" };
const B = { hwnd: 0x2222n, title: "Untitled - Notepad" };
const C = { hwnd: 0x3333n, title: "Calculator" };

describe("titleAlreadyNamesOnly", () => {
  it("is true when the title matches one window and it is the pinned one", () => {
    expect(titleAlreadyNamesOnly([A, C], "Notepad", A.hwnd)).toBe(true);
  });

  it("is false with a same-titled sibling — the case this ADR exists for", () => {
    expect(titleAlreadyNamesOnly([A, B, C], "Notepad", A.hwnd)).toBe(false);
    expect(titleAlreadyNamesOnly([A, B, C], "Notepad", B.hwnd)).toBe(false);
  });

  it("is false when the one match is a different window", () => {
    // The title would reach C; the caller named A. Scoping is exactly what is needed.
    expect(titleAlreadyNamesOnly([A, C], "Calculator", A.hwnd)).toBe(false);
  });

  it("is false when the pinned window is not in the enumeration at all", () => {
    // `enumWindowsInZOrder` drops untitled, sub-50 px and excluded windows. A handle naming one
    // of those cannot be reached by title, so the read has to be scoped.
    expect(titleAlreadyNamesOnly([C], "Notepad", A.hwnd)).toBe(false);
    expect(titleAlreadyNamesOnly([], "Notepad", A.hwnd)).toBe(false);
  });

  it("matches on substring and ignores case, the way the reads do", () => {
    expect(titleAlreadyNamesOnly([A, C], "notepad", A.hwnd)).toBe(true);
    expect(titleAlreadyNamesOnly([A, C], "UNTITLED", A.hwnd)).toBe(true);
  });

  it("is false for a query that matches both windows even without a shared full title", () => {
    // "Report" and "Report archive" are two windows to a substring search, and the shorter
    // query reaches both — the asymmetry ADR-036's refusal text has to explain.
    const short = { hwnd: 0x4444n, title: "Report" };
    const long  = { hwnd: 0x5555n, title: "Report archive" };
    expect(titleAlreadyNamesOnly([short, long], "Report", short.hwnd)).toBe(false);
    // The longer query names only one, so a read by title reaches it and scoping adds nothing.
    expect(titleAlreadyNamesOnly([short, long], "Report archive", long.hwnd)).toBe(true);
  });
});

describe("psTreeBudgetMs — the walk always ends before the wait around it", () => {
  it("leaves room for process start and the assembly loads", () => {
    expect(psTreeBudgetMs(10000)).toBe(6000);
    expect(psTreeBudgetMs(8000)).toBe(4000);
  });

  it("follows a caller who asks for less, rather than overriding them", () => {
    // `workspace.ts` passes 2000 and `_narration.ts` 4000 on purpose. A fixed budget made both
    // wait twelve seconds; a fixed wait killed the walk before it printed. Neither is the
    // caller's business — the budget is derived from what they asked for.
    expect(psTreeBudgetMs(2000)).toBeLessThan(2000);
    expect(psTreeBudgetMs(4000)).toBeLessThan(4000);
  });

  it("never asks for a walk too short to reach anything", () => {
    expect(psTreeBudgetMs(0)).toBe(1000);
    expect(psTreeBudgetMs(-5000)).toBe(1000);
  });
});

describe("psReadWaitMs — the other shape of read, where the deadline is what moves", () => {
  it("adds the process start to the caller's read budget", () => {
    // `getTextViaTextPattern` is one `FindAll(Descendants)` and a `GetText`; neither can be
    // stopped early, so nothing inside the script can be shortened to fit a deadline the way
    // the tree walk's budget is. Sharing one number left the read a fraction of it.
    expect(psReadWaitMs(6000)).toBe(10000);
    expect(psReadWaitMs(2000)).toBe(6000);
  });

  it("is the inverse of psTreeBudgetMs above the floor", () => {
    // Both roads then mean the same thing by the number: how long the READ may take. The native
    // path always read it that way — it pays no process start.
    for (const budget of [2000, 6000, 20000]) {
      expect(psTreeBudgetMs(psReadWaitMs(budget))).toBe(budget);
    }
  });
});
