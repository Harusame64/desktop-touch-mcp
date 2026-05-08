/**
 * keyboard-bg-verification.test.ts — E2E for issue #177:
 * keyboard({action:'type'/'press', method:'background'}) post-send delivery
 * verification (matrix doc §3.1 keyboard rows).
 *
 * Coverage:
 *  1. type BG to Windows Terminal (WT) → BackgroundInputNotDelivered
 *     (`DTM_E2E_WT=1` opt-in; same channel/code as terminal({action:'send'})
 *     because WM_CHAR + WT XAML pipeline silently drops the message).
 *  2. type BG to conhost-hosted PowerShell → ok:true with
 *     hints.verifyDelivery: { status: "delivered", channel: "wm_char" }
 *     (regression guard for the well-tested path).
 *  3. type BG to Notepad → ok:true, regression guard for non-terminal.
 *     Verification is skipped when method:'auto' on a non-terminal class
 *     (no DTM_BG_AUTO=1), so the test forces method:'background' and
 *     accepts either status:"delivered" (TextPattern read-back succeeded)
 *     or status:"unverifiable" (TextPattern unavailable on the Edit child) —
 *     the contract is "no silent ok:true without a hint".
 *  4. press BG (non-arrow combo) on conhost → ok:true with
 *     hints.verifyDelivery: { status: "unverifiable", channel: "wm_keydown" }
 *     pinning the matrix doc §4.2 unverifiable shape (matrix doc §3.1
 *     "press BG" Indirect by-design degradation).
 *  5. press BG (enter) on conhost → ok:true with verifyDelivery:delivered
 *     (read-back-verifiable combo per allow-list).
 *
 * Skip policy: WT scenario is opt-in via `DTM_E2E_WT=1` — WT-launcher cleanup
 * has been hardened to single-PID kill (no /T) but the env-var gate prevents
 * accidental WT-tree damage for casual `npm test` runs (memory:
 * feedback_e2e_wt_host_taskkill_risk.md). conhost / Notepad cases run always.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keyboardTypeHandler, keyboardPressHandler } from "../../src/tools/keyboard.js";
import { launchPowerShell, type PsInstance } from "./helpers/powershell-launcher.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload } from "./helpers/wait.js";

const WT_E2E_ENABLED = process.env["DTM_E2E_WT"] === "1";

// ─────────────────────────────────────────────────────────────────────────────
// type BG verification
// ─────────────────────────────────────────────────────────────────────────────

describe("keyboard({action:'type', method:'background'}) — issue #177 verification", () => {
  // 1. Windows Terminal — opt-in; surfaces BackgroundInputNotDelivered.
  if (WT_E2E_ENABLED) {
    describe("[Windows Terminal] type BG", () => {
      let ps: PsInstance;
      beforeAll(async () => {
        ps = await launchPowerShell({ host: "wt", banner: "ready-bg-type-wt" });
      }, 15_000);
      afterAll(() => { ps?.kill(); });

      it("returns BackgroundInputNotDelivered (post-send UIA read-back catches WT silent drop)", async () => {
        const tag = `bg-type-wt-${Date.now().toString(36)}`;
        const r = parsePayload(await keyboardTypeHandler({
          text: tag,
          method: "background",
          use_clipboard: false,
          replaceAll: false,
          forceKeystrokes: false,
          windowTitle: ps.title,
          trackFocus: false,
          settleMs: 0,
        }));
        expect(r.ok, JSON.stringify(r)).toBe(false);
        expect(r.code).toBe("BackgroundInputNotDelivered");
        expect(Array.isArray(r.suggest)).toBe(true);
        expect(r.suggest.some((s: string) => /foreground/i.test(s))).toBe(true);
      }, 10_000);
    });
  }

  // 2. conhost — BG path is well-tested, must succeed with delivered hint.
  describe("[conhost] type BG", () => {
    let ps: PsInstance;
    beforeAll(async () => {
      ps = await launchPowerShell({ host: "conhost", banner: "ready-bg-type-conhost" });
    }, 15_000);
    afterAll(() => { ps?.kill(); });

    it("succeeds with hints.verifyDelivery: delivered/wm_char on conhost", async () => {
      const tag = `bg-type-conhost-${Date.now().toString(36)}`;
      const r = parsePayload(await keyboardTypeHandler({
        text: tag,
        method: "background",
        use_clipboard: false,
        replaceAll: false,
        forceKeystrokes: false,
        windowTitle: ps.title,
        trackFocus: false,
        settleMs: 0,
      }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.method).toBe("background");
      expect(r.channel).toBe("wm_char");
      // Verification ran (method:'background' explicit → verificationNeeded=true)
      // and conhost echoes WM_CHAR into the buffer → status:'delivered'.
      expect(r.hints?.verifyDelivery).toBeDefined();
      expect(r.hints.verifyDelivery.channel).toBe("wm_char");
      // We accept either "delivered" (TextPattern read-back found the tag) or
      // "unverifiable" (UIA TextPattern not available on this conhost build —
      // env-dependent). Bare ok:true without verifyDelivery is the regression.
      expect(["delivered", "unverifiable"]).toContain(r.hints.verifyDelivery.status);
    }, 10_000);
  });

  // 3. Notepad — non-terminal regression guard. Verification is opt-in
  //    (method:'background' explicit) so the path runs; result depends on
  //    whether TextPattern is available on the Edit child.
  describe("[Notepad] type BG", () => {
    let np: NpInstance;
    beforeAll(async () => {
      np = await launchNotepad();
    }, 25_000);
    afterAll(() => { np?.kill(); });

    it("succeeds and never returns ok:true without a verifyDelivery hint", async () => {
      const tag = `bg-type-np-${Date.now().toString(36)}`;
      const r = parsePayload(await keyboardTypeHandler({
        text: tag,
        method: "background",
        use_clipboard: false,
        replaceAll: false,
        forceKeystrokes: false,
        windowTitle: np.title,
        trackFocus: false,
        settleMs: 0,
      }));
      // Notepad accepts WM_CHAR — should never fail with NotDelivered. (If
      // canInjectViaPostMessage rejects Notepad on a future Win11 patch, the
      // test will surface that as a clear failure rather than a silent skip.)
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.method).toBe("background");
      // Core invariant of issue #177: when verification is requested
      // (method:'background' explicit), the response MUST carry
      // hints.verifyDelivery — otherwise we're back to the silent-success
      // regression that motivated this PR.
      expect(r.hints?.verifyDelivery).toBeDefined();
      expect(["delivered", "unverifiable"]).toContain(r.hints.verifyDelivery.status);
      expect(r.hints.verifyDelivery.channel).toBe("wm_char");
      if (r.hints.verifyDelivery.status === "unverifiable") {
        // matrix §4.2 fallback hint must be present so the caller knows the
        // next path to try.
        expect(r.hints.verifyDelivery.fallback).toMatch(/foreground/);
      }
    }, 15_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// press BG verification — pin the unverifiable hint shape
// ─────────────────────────────────────────────────────────────────────────────

describe("keyboard({action:'press', method:'background'}) — issue #177 verification", () => {
  describe("[conhost] press BG", () => {
    let ps: PsInstance;
    beforeAll(async () => {
      ps = await launchPowerShell({ host: "conhost", banner: "ready-bg-press-conhost" });
    }, 15_000);
    afterAll(() => { ps?.kill(); });

    // 4. Non-arrow combo — pin the unverifiable hint shape (matrix §4.2).
    it("non-arrow combo (ctrl+a) returns hints.verifyDelivery:unverifiable with channel/fallback", async () => {
      const r = parsePayload(await keyboardPressHandler({
        keys: "ctrl+a",
        method: "background",
        windowTitle: ps.title,
        trackFocus: false,
        settleMs: 0,
      }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.method).toBe("background");
      expect(r.hints?.verifyDelivery).toBeDefined();
      expect(r.hints.verifyDelivery.status).toBe("unverifiable");
      expect(r.hints.verifyDelivery.channel).toBe("wm_keydown");
      expect(r.hints.verifyDelivery.fallback).toMatch(/foreground/);
      // matrix §4.3 reason enum — read_back_unsupported is the regular
      // "no observation channel" reason.
      expect(r.hints.verifyDelivery.reason).toBe("read_back_unsupported");
    }, 10_000);

    // 5. enter on terminal-class — read-back-verifiable per allow-list.
    it("enter on conhost succeeds with verifyDelivery:delivered (read-back catches new line)", async () => {
      const r = parsePayload(await keyboardPressHandler({
        keys: "enter",
        method: "background",
        windowTitle: ps.title,
        trackFocus: false,
        settleMs: 0,
      }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.hints?.verifyDelivery).toBeDefined();
      // We accept "delivered" (read-back saw the new line) or "unverifiable"
      // (TextPattern not available on this build) — bare ok:true is the
      // regression. enter is dispatched as WM_CHAR '\r' (postEnterToHwnd),
      // so channel reflects that on the unverifiable branch; on the
      // delivered branch the press handler classifies the channel as
      // wm_keydown by default. Don't pin the channel on this case to keep
      // the assertion focused on the matrix-doc invariant.
      expect(["delivered", "unverifiable"]).toContain(r.hints.verifyDelivery.status);
    }, 10_000);
  });
});
