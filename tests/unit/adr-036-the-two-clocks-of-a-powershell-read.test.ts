/**
 * ADR-036 — the two clocks a PowerShell read runs against.
 *
 * A scoped read leaves the Rust engine, because `uiaGetElements` and `uiaGetTextViaTextPattern`
 * take a title and nothing else: 184 ms against 517 ms on the same window (Windows, 2026-09-09).
 * That price is paid on every pinned read now — the predicate that used to skip it was refused
 * by both gates, because a Win32 caption sweep cannot vouch for what a UIA `Name` search will
 * reach, and it is a photograph taken before the read anyway.
 *
 * So what is left to get right is the time: the walk must finish inside the wait, and the wait
 * must be long enough for the read to happen at all.
 */
import { describe, it, expect } from "vitest";
import { psTreeBudgetMs, psReadWaitMs } from "../../src/engine/uia-bridge.js";


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
