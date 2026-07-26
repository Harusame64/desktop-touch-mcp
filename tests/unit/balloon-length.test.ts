/**
 * tests/unit/balloon-length.test.ts
 *
 * ADR-030 Phase 1 (Codex Round 2) — every failsafe balloon body must fit
 * `System.Windows.Forms.NotifyIcon.BalloonTipText`.
 *
 * The limit is a HARD one: assigning a longer string throws inside PowerShell, so the balloon never
 * appears. Nothing upstream notices — `showBalloonTip` resolves as soon as the child SPAWNS, and the
 * ghost-zone notice latches `_ghostNoticeShown` before that. The once-per-session "the corner moved"
 * notice was 272 characters and therefore never reached a single user. Length is not something a
 * reviewer can eyeball, so it is pinned here (強制命令 7 — enforce by mechanism).
 *
 * Bodies interpolate `holdMs` (`DESKTOP_TOUCH_FAILSAFE_HOLD_MS`, user-settable), so each one is
 * measured at an absurd value too — the guard must not depend on the default being small.
 */

import { describe, it, expect, vi } from "vitest";

// failsafe.ts loads the nut-js mouse at module scope — mock the native module away.
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: vi.fn() },
}));

import { NOTIFYICON_BALLOON_TEXT_MAX, fitBalloonText } from "../../src/utils/balloon.js";
import { ghostBalloonBody, PER_TOOL_BALLOON_BODY } from "../../src/utils/failsafe.js";
import { exitBalloonBody, AVERTED_BALLOON_BODY } from "../../src/utils/failsafe-watcher.js";

/** Default, a long dwell, and an absurd one — the interpolated digits must never push a body over. */
const HOLDS = [0, 500, 3_600_000, 999_999_999_999] as const;

describe("failsafe balloon bodies fit NotifyIcon.BalloonTipText", () => {
  it("the pinned limit is NotifyIcon's documented 255", () => {
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

describe("fitBalloonText — the sink's last-resort net", () => {
  it("clips an over-long body and marks the cut with an ellipsis", () => {
    const fitted = fitBalloonText("x".repeat(400));
    expect(fitted.length).toBeLessThanOrEqual(NOTIFYICON_BALLOON_TEXT_MAX);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("leaves a body that already fits completely untouched (no silent rewriting)", () => {
    const body = ghostBalloonBody(500);
    expect(fitBalloonText(body)).toBe(body);
    const exact = "y".repeat(NOTIFYICON_BALLOON_TEXT_MAX);
    expect(fitBalloonText(exact)).toBe(exact); // the boundary itself is legal
  });
});
