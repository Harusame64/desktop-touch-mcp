/**
 * ADR-036 — the two clocks a PowerShell read runs against.
 *
 * A scoped read leaves the Rust engine, because `uiaGetElements` and `uiaGetTextViaTextPattern`
 * take a title and nothing else: 184 ms against 517 ms on the same window (Windows, 2026-09-09).
 * That price is paid on every pinned read now — the predicate that used to skip it was refused
 * by both gates, because a Win32 caption sweep cannot vouch for what a UIA `Name` search will
 * reach, and it is a photograph taken before the read anyway.
 *
 * So what is left to get right is the time. The two reads answer it differently: the tree walk
 * measures its own start and stops inside the caller's deadline, while the TextPattern read
 * cannot be interrupted at all, so its WAIT is what has to be long enough.
 */
import { describe, it, expect } from "vitest";
import { psReadWaitMs } from "../../src/engine/uia-bridge.js";


describe("psReadWaitMs — the other shape of read, where the deadline is what moves", () => {
  it("adds the process start to the caller's read budget", () => {
    // `getTextViaTextPattern` is one `FindAll(Descendants)` and a `GetText`; neither can be
    // stopped early, so nothing inside the script can be shortened to fit a deadline the way
    // the tree walk's budget is. Sharing one number left the read a fraction of it.
    expect(psReadWaitMs(6000)).toBe(10000);
    expect(psReadWaitMs(2000)).toBe(6000);
  });

  it("is generous on purpose, and that is free here", () => {
    // The startup it allows for was measured at 233 ms median (Windows, 2026-09-09), and 4000 is
    // roughly seventeen times that — deliberately, because a cold machine was never measured and
    // a wait that is too long costs nothing until something has already failed. The same
    // generosity was NOT free on the walk's budget, which is why that one measures instead.
    expect(psReadWaitMs(0)).toBeGreaterThan(1044); // the worst of sixteen spawning at once
  });
});
