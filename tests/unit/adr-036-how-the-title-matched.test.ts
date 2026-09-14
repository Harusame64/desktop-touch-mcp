/**
 * adr-036-how-the-title-matched.test.ts — the response says HOW the title matched.
 *
 * THE ACCIDENT THIS ADR WAS STARTED FOR, in one line: two windows whose titles both match the
 * caller's query. The guard refuses while both are alive; close the one the caller meant, so that
 * only the WRONG one still matches, and the call answers `ok:true` with the keystrokes in the
 * decoy. The guard protects the caller in the case they could have noticed, and stands aside in
 * the case they could not.
 *
 * NAMING THE RESOLVED WINDOW DOES NOT CLOSE IT. Measured on the accident itself (win2, `95927b9`):
 * five of six answers name the decoy somewhere, and the only check a caller can run against them
 * is "does what came back contain what I passed?" — which the decoy passes, because its title
 * contains the query. Zero of the five let the accident be noticed.
 *
 * NOR DOES A MATCH COUNT (win2, `8ae3cbf`, counted across the whole desktop): both windows alive
 * → 2; the accident → 1; the ordinary case → 1. The count is the GUARD's signal, and the accident
 * is defined by the intended window being gone.
 *
 * WHAT SPLITS THEM is whether the resolved title IS the query or merely contains it. And that is
 * a REPORT, not a verdict: a correct `windowTitle:"Notepad"` resolves a 24-character decorated
 * title from a 14-character query, so "not exact" is the ordinary case for every application that
 * renames itself — a product-side warning on it would fire on the most common right call there is.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  getWindowProcessId: vi.fn(() => null),
  getProcessIdentityByPid: vi.fn(() => null),
  getWindowTitleW: vi.fn(() => ""),
  getWindowRectByHwnd: vi.fn(() => null),
  getForegroundHwnd: vi.fn(() => null),
  getWindowClassName: vi.fn(() => "Notepad"),
  getWindowOwner: vi.fn(() => null),
  isWindowEnabled: vi.fn(() => true),
  getLastActivePopup: vi.fn(() => null),
  // The locker exclusions answer "not excluded" here: this file is about how a title matched, and
  // a refusal would be a different road with a different envelope.
  isExcludedWindowHandle: vi.fn(() => false),
  isExcludedTitle: vi.fn(() => false),
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getFocusedAndPointInfo: vi.fn().mockResolvedValue(null),
}));

import { withPostState } from "../../src/tools/_post.js";
import { resolveWindowTarget } from "../../src/tools/_resolve-window.js";
import { ok } from "../../src/tools/_types.js";
import { enumWindowsInZOrder } from "../../src/engine/win32.js";

type Win = { hwnd: bigint; title: string; isActive: boolean; className: string; isVisible: boolean };

const win = (hwnd: bigint, title: string): Win => ({
  hwnd, title, isActive: false, className: "Notepad", isVisible: true,
});

/** The desktop for one call, and the query the handler resolves against it. */
async function matchOf(titles: string[], query: string): Promise<Record<string, unknown> | undefined> {
  vi.mocked(enumWindowsInZOrder).mockImplementation(
    () => titles.map((t, i) => win(BigInt(4000 + i), t)) as never,
  );
  const wrapped = withPostState("keyboard", async () => {
    await resolveWindowTarget({ windowTitle: query });
    return ok({ ok: true, typed: true });
  });
  const out = JSON.parse((await wrapped({ action: "type", text: "x", windowTitle: query }))
    .content[0]!.text as string) as Record<string, unknown>;
  const hints = out.hints as Record<string, unknown> | undefined;
  return hints?.windowMatch as Record<string, unknown> | undefined;
}

/** The two marks are chosen so neither is a substring of the other except where the test says. */
const AIM = "AIM7F3";
const DECOY = "AIM7F3 notes";
const NEUTRAL = "scratch pad";

describe("ADR-036: the response says how the title matched, and lets the caller decide", () => {
  it("splits the accident from the ordinary case, which is the whole point", async () => {
    // THE ACCIDENT: the window the caller meant is gone, so the query resolves the decoy — by
    // substring, because the decoy's title CONTAINS the query rather than being it.
    const accident = await matchOf([DECOY, NEUTRAL], AIM);
    // THE ORDINARY CASE: same call, same query, same everything — the only difference is which
    // window survived.
    const normal = await matchOf([AIM, NEUTRAL], AIM);

    expect(accident).toEqual({ query: AIM, resolvedTitle: DECOY, exact: false, matchCount: 1 });
    expect(normal).toEqual({ query: AIM, resolvedTitle: AIM, exact: true, matchCount: 1 });

    // THE COUNT IS THE SAME IN BOTH, which is why it could not have been the field. Stated as its
    // own row so a later reader does not "simplify" this to a count and lose the accident.
    expect(accident!.matchCount).toBe(normal!.matchCount);
    expect(accident!.exact).not.toBe(normal!.exact);
  });

  it("counts what the resolver saw, including the case the guard refuses", async () => {
    // Both alive: the guard's case, and the only one where a count says anything. The report says
    // two so a caller who reads it after a refusal sees the same fact the guard acted on.
    const both = await matchOf([AIM, DECOY, NEUTRAL], AIM);
    expect(both).toMatchObject({ matchCount: 2 });
  });

  it("reports the ordinary decorated title without calling it a problem", async () => {
    // The row that forbids a verdict. A correct call on a window that renames itself is a
    // non-exact match; if this layer warned on `exact:false`, it would warn here — on the most
    // common right call there is.
    const decorated = await matchOf(["memo.txt - Notepad", NEUTRAL], "Notepad");
    expect(decorated).toEqual({
      query: "Notepad", resolvedTitle: "memo.txt - Notepad", exact: false, matchCount: 1,
    });
  });

  it("publishes on the exact rows too, so its presence is not the signal", async () => {
    // Withholding it when nothing looks wrong would make the FIELD a verdict even with no verdict
    // written in it: a caller would learn "it is here, so be worried".
    const exact = await matchOf([AIM, NEUTRAL], AIM);
    expect(exact).toBeDefined();
    expect(exact).toMatchObject({ exact: true });
  });

  it("says nothing when no title decided the target", async () => {
    // A call that named no window took no title road, so there is nothing to report — an absent
    // field here means "not applicable", never "it matched fine".
    vi.mocked(enumWindowsInZOrder).mockImplementation(() => [] as never);
    const wrapped = withPostState("clipboard", async () => ok({ ok: true }));
    const out = JSON.parse((await wrapped({ action: "read" })).content[0]!.text as string) as Record<string, unknown>;
    expect((out.hints as Record<string, unknown> | undefined)?.windowMatch).toBeUndefined();
  });

  it("keeps the handler's own hints, because this wrapper owns one field of them", async () => {
    vi.mocked(enumWindowsInZOrder).mockImplementation(() => [win(4000n, AIM)] as never);
    const wrapped = withPostState("keyboard", async () => {
      await resolveWindowTarget({ windowTitle: AIM });
      return ok({ ok: true, hints: { verifyDelivery: { channel: "postmessage" } } });
    });
    const out = JSON.parse((await wrapped({ action: "type", text: "x", windowTitle: AIM }))
      .content[0]!.text as string) as Record<string, unknown>;
    expect(out.hints).toMatchObject({
      verifyDelivery: { channel: "postmessage" },
      windowMatch: { query: AIM, exact: true },
    });
  });
});
