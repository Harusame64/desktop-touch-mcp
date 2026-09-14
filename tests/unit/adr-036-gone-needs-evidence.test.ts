/**
 * ADR-036 — "the window you aimed at is gone" is a claim, and it needs evidence.
 *
 * `isExcludedWindowHandle` fails CLOSED on a PID it cannot read, and a destroyed window reads as
 * PID 0 — so while a key locker is armed, an ordinary closed window came back as a security
 * refusal. Splitting the two is right; doing it with `getWindowProcessId(h) === 0` was not,
 * because that function also answers 0 when the native binding is missing or the call throws.
 * Every fail-closed refusal would then have been re-labelled "gone" — the same wrong sentence
 * with the two cases swapped.
 *
 * So the split asks the binding directly and treats "could not ask" as NOT gone, leaving the
 * stricter refusal standing. This machine has no Windows binding, which makes it exactly the
 * "could not ask" case.
 */
import { describe, it, expect } from "vitest";
import { isWindowGone } from "../../src/engine/win32.js";

describe("isWindowGone", () => {
  it("says no when it cannot ask, rather than reading silence as an answer", () => {
    // No native win32 here, so the call throws inside. A handle that was never a window on this
    // machine still does not earn the claim that it *used* to be one.
    expect(isWindowGone(0x1234n)).toBe(false);
  });
});
