/**
 * An e2e fixture may only take a window it opened.
 *
 * The launchers found their window by title alone. internal #129 first read win2's leftovers as a
 * tab added to the user's terminal and renamed by the tag; win2 measured it on 2026-09-19 (internal
 * `927fa66`) and every `host:"wt"` launch opened a new window — the shared WindowsTerminal process
 * was reporting another window's title. The invariant is kept anyway, because what a fixture takes
 * is typed into and closed: the launchers now list every top-level window before the spawn and take
 * only a tagged window that was not on the list.
 */
import { describe, expect, it } from "vitest";

import { classifyTaggedWindows } from "../e2e/helpers/powershell-launcher.js";

const region = { x: 0, y: 0, width: 100, height: 100 };
const w = (hwnd: bigint, title: string) => ({ hwnd, title, region });

describe("classifyTaggedWindows", () => {
  it("takes a tagged window that did not exist before the launch", () => {
    const got = classifyTaggedWindows([w(1n, "user terminal"), w(2n, "ps-abc")], new Set([1n]), "ps-abc");
    expect(got.opened?.hwnd).toBe(2n);
    expect(got.preexisting).toBeNull();
  });

  it("does NOT take a tagged window that existed before the launch, and names it", () => {
    // A host that joined an existing window, which now carries the tag (not observed with WT; see the header).
    const got = classifyTaggedWindows([w(1n, "ps-abc")], new Set([1n]), "ps-abc");
    expect(got.opened).toBeNull();
    expect(got.preexisting?.hwnd).toBe(1n);
  });

  it("reports the pre-existing one even when a fresh one also carries the tag", () => {
    // Z-order puts the user's window first; the scan must not stop at the first tagged window.
    const got = classifyTaggedWindows([w(1n, "ps-abc"), w(2n, "ps-abc")], new Set([1n]), "ps-abc");
    expect(got.preexisting?.hwnd).toBe(1n);
    expect(got.opened?.hwnd).toBe(2n);
  });

  it("ignores windows that do not carry the tag, listed or not", () => {
    const got = classifyTaggedWindows([w(1n, "other"), w(3n, "also other")], new Set([1n]), "ps-abc");
    expect(got).toEqual({ opened: null, preexisting: null });
  });
});
