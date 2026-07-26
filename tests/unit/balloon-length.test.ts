/**
 * tests/unit/balloon-length.test.ts
 *
 * ADR-030 Phase 1 — every failsafe balloon must fit what `NotifyIcon` actually delivers:
 * 255 UTF-16 code units of body, 63 of title.
 *
 * `ShowBalloonTip` marshals into `NOTIFYICONDATA`, whose `szInfo` / `szInfoTitle` are `ByValTStr`
 * with `SizeConst` 256 / 64. MEASURED 2026-07-26 (Windows 11 26100, PowerShell 5.1 / CLR 4.0.30319):
 * over-long strings are NOT rejected — no exception from the property assignment, none from
 * `ShowBalloonTip`, and a `Marshal.StructureToPtr` round-trip of the same layout comes back silently
 * cut to 63 / 255. The ghost-zone notice was 272 characters and its title 66, so users got a sentence
 * that stopped mid-word, once per session, with nothing recording the loss.
 *
 * Length is not something a reviewer can eyeball, so it is pinned here (強制命令 7 — enforce by
 * mechanism). Bodies interpolate `holdMs` (`DESKTOP_TOUCH_FAILSAFE_HOLD_MS`, user-settable), so each
 * one is measured at an absurd value too — the guard must not depend on the default being small.
 */

import { describe, it, expect, vi } from "vitest";

// failsafe.ts loads the nut-js mouse at module scope — mock the native module away.
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: vi.fn() },
}));

import {
  NOTIFYICON_BALLOON_TEXT_MAX,
  NOTIFYICON_BALLOON_TITLE_MAX,
  buildBalloonScript,
  fitBalloonText,
  fitBalloonTitle,
} from "../../src/utils/balloon.js";
import {
  ghostBalloonBody,
  PER_TOOL_BALLOON_BODY,
  BALLOON_TITLE,
  GHOST_BALLOON_TITLE,
} from "../../src/utils/failsafe.js";
import {
  exitBalloonBody,
  AVERTED_BALLOON_BODY,
  EXIT_BALLOON_TITLE,
} from "../../src/utils/failsafe-watcher.js";

/** Default, a long dwell, and an absurd one — the interpolated digits must never push a body over. */
const HOLDS = [0, 500, 3_600_000, 999_999_999_999] as const;

describe("failsafe balloon bodies fit NotifyIcon's szInfo", () => {
  it("the pinned limit is the measured 255", () => {
    expect(NOTIFYICON_BALLOON_TEXT_MAX).toBe(255);
  });

  for (const holdMs of HOLDS) {
    it(`ghost-zone notice fits at holdMs=${holdMs}`, () => {
      expect(ghostBalloonBody(holdMs).length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
    });

    it(`watcher exit balloon fits at holdMs=${holdMs}`, () => {
      expect(exitBalloonBody(holdMs).length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
    });
  }

  it("the averted-exit correction fits", () => {
    expect(AVERTED_BALLOON_BODY.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
  });

  it("the per-tool refusal notice fits", () => {
    expect(PER_TOOL_BALLOON_BODY.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
  });

  it("bodies keep headroom (<=240) so a future edit does not land right on the limit", () => {
    const bodies = [
      ghostBalloonBody(500),
      exitBalloonBody(500),
      AVERTED_BALLOON_BODY,
      PER_TOOL_BALLOON_BODY,
    ];
    for (const b of bodies) expect(b.length).toBeLessThanOrEqual(240);
  });
});

describe("failsafe balloon titles fit NotifyIcon's szInfoTitle", () => {
  it("the pinned limit is the measured 63", () => {
    expect(NOTIFYICON_BALLOON_TITLE_MAX).toBe(63);
  });

  // Every title this codebase hands to `showBalloonTip`. (`notification_show`'s title is
  // user-supplied and is covered by the sink instead — see the wiring pin below.)
  const TITLES: ReadonlyArray<readonly [string, string]> = [
    ["GHOST_BALLOON_TITLE", GHOST_BALLOON_TITLE],
    ["BALLOON_TITLE (per-tool refusal)", BALLOON_TITLE],
    ["EXIT_BALLOON_TITLE (watcher)", EXIT_BALLOON_TITLE],
  ];

  for (const [name, title] of TITLES) {
    it(`${name} fits`, () => {
      expect(title.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TITLE_MAX);
    });
  }

  it("titles keep headroom (<=60)", () => {
    for (const [, title] of TITLES) expect(title.length).toBeLessThanOrEqual(60);
  });
});

/** Is any surrogate in `s` missing its partner? A lone half renders as a replacement box. */
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("fitBalloonText / fitBalloonTitle — the sink's last-resort net", () => {
  it("clips an over-long body and marks the cut with an ellipsis", () => {
    const fitted = fitBalloonText("x".repeat(400));
    expect(fitted.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("clips an over-long title the same way", () => {
    const fitted = fitBalloonTitle("x".repeat(200));
    expect(fitted.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TITLE_MAX);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("leaves text that already fits completely untouched (no silent rewriting)", () => {
    const body = ghostBalloonBody(500);
    expect(fitBalloonText(body)).toBe(body);
    expect(fitBalloonTitle(GHOST_BALLOON_TITLE)).toBe(GHOST_BALLOON_TITLE);
    // The boundary itself is legal — `SizeConst` counts the NUL separately.
    const exactBody = "y".repeat(NOTIFYICON_BALLOON_TEXT_MAX);
    expect(fitBalloonText(exactBody)).toBe(exactBody);
    const exactTitle = "y".repeat(NOTIFYICON_BALLOON_TITLE_MAX);
    expect(fitBalloonTitle(exactTitle)).toBe(exactTitle);
  });

  it("never cuts an emoji in half (astral characters are two code units)", () => {
    // "🙂" is a surrogate PAIR, so a run of them puts a character boundary at every other code unit;
    // prefixing "a" shifts the parity, so both alignments of the cut point get exercised.
    for (const [fit, max] of [
      [fitBalloonText, NOTIFYICON_BALLOON_TEXT_MAX],
      [fitBalloonTitle, NOTIFYICON_BALLOON_TITLE_MAX],
    ] as const) {
      for (const lead of ["", "a"]) {
        const fitted = fit(lead + "🙂".repeat(400));
        expect(hasLoneSurrogate(fitted)).toBe(false);
        expect(fitted.length).toBeLessThanOrEqual(max);
        expect(fitted.endsWith("…")).toBe(true);
      }
    }
  });

  it("the surrogate guard is not vacuous: a naive slice at the same point DOES split a pair", () => {
    // Pins that the emoji case above actually hits the bad alignment rather than getting lucky.
    const naive = ("a" + "🙂".repeat(400)).slice(0, NOTIFYICON_BALLOON_TEXT_MAX - 3);
    expect(hasLoneSurrogate(naive)).toBe(true);
  });
});

describe("buildBalloonScript — the sink actually applies the fitting (wiring pin)", () => {
  it("embeds the FITTED title and body, never the raw over-long input", () => {
    // Calling `fitBalloonText` directly proves nothing about the sink: this asserts that the script
    // handed to the spawn is the fitted one, so dropping either fit call fails here.
    const title = "T".repeat(200);
    const body = "B".repeat(400);
    const script = buildBalloonScript(title, body);

    expect(script).toContain(`$notify.BalloonTipTitle = '${fitBalloonTitle(title)}'`);
    expect(script).toContain(`$notify.BalloonTipText = '${fitBalloonText(body)}'`);
    expect(script).not.toContain(title); // the raw 200-unit run must not survive
    expect(script).not.toContain(body);
  });

  it("still escapes embedded single quotes for PowerShell", () => {
    const script = buildBalloonScript("it's", "don't");
    expect(script).toContain("$notify.BalloonTipTitle = 'it''s'");
    expect(script).toContain("$notify.BalloonTipText = 'don''t'");
  });
});
