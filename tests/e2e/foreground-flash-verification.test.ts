/**
 * foreground-flash-verification.test.ts — E2E for ADR-013 Option E
 * (`method: 'foreground_flash'`、Phase 3 wired、Phase 4 verification)。
 *
 * Coverage (Phase 4 MVP):
 *  1. Input validation — 改行 / 5KiB 超 で input_exceeds_paste_warning_threshold
 *     (native validate_input、副作用なしで CI どこでも実行可)
 *  2. keyboard:type method:'foreground_flash' on WT — clipboard_flash channel
 *     を取得、ok:true + hints.backgroundChannel === 'clipboard_flash' +
 *     hints.typingLeakRisk:true + flashDurationMs > 0 + foregroundStealMethod
 *     が AttachThreadInput / alt_unlock / already_foreground のいずれか
 *  3. method:'foreground_flash' on conhost (= terminal class) — channel
 *     resolver が wm_char を picking、hints.backgroundChannel === 'wm_char'
 *     (foreground_flash は明示 opt-in だが target が wm_char で済むなら
 *      無駄 steal しない契約)
 *  4. terminal:send method:'foreground_flash' on WT — pressEnter:true で
 *     Ctrl+V + Enter 別送信、ok:true + hints.foregroundStealMethod
 *  5. keyboard:press method:'foreground_flash' は早期 reject
 *     (key combo paste は semantics に合わない、明示 suggest)
 *  6. Existing method:'background' on WT contract 維持
 *     (= BackgroundInputNotDelivered、`background` 契約 不変原則の regression guard)
 *
 * Heavy tests (100 連続 / clipboard race fixture / dialog scan trigger /
 * 画像 clipboard 復元不可) は `it.todo` で future work、Phase 4 MVP scope 外。
 *
 * Skip policy: WT scenario は default-on (issue #175)、launcher の
 * `host: 'wt'` で isolation 済の WT window を起動。ホストに wt.exe が
 * いない場合は describe.skipIf で全 suite skip。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { keyboardTypeHandler, keyboardPressHandler } from "../../src/tools/keyboard.js";
import { terminalSendHandler } from "../../src/tools/terminal.js";
import { launchPowerShell, type PsInstance } from "./helpers/powershell-launcher.js";
import { parsePayload } from "./helpers/wait.js";

const WT_AVAILABLE: boolean = (() => {
  if (process.platform !== "win32") return false;
  try {
    execSync("where wt.exe", { stdio: "ignore", timeout: 2000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Input validation (native validate_input、副作用なし、CI どこでも実行可)
// ─────────────────────────────────────────────────────────────────────────────

describe("foreground_flash — input validation (native validate_input、§3.3.1)", () => {
  it.skipIf(!WT_AVAILABLE)("rejects text containing LF with input_exceeds_paste_warning_threshold", async () => {
    // WT instance を立ち上げ、native flash の validate_input を経由するため
    // method:'foreground_flash' 経路を使う (Phase 3 wiring 済)。
    const ps = await launchPowerShell({ host: "wt", banner: "ready-ff-validate-lf" });
    try {
      const r = parsePayload(await keyboardTypeHandler({
        text: "hello\nworld",
        method: "foreground_flash",
        use_clipboard: false,
        replaceAll: false,
        forceKeystrokes: false,
        windowTitle: ps.title,
        trackFocus: false,
        settleMs: 0,
      }));
      expect(r.ok, JSON.stringify(r)).toBe(false);
      // Native validate_input は input_exceeds_paste_warning_threshold で fail
      // → handler が context.reason に snake_case で透過。
      expect(r.context?.reason).toBe("input_exceeds_paste_warning_threshold");
    } finally {
      ps?.kill();
    }
  }, 15_000);

  it.skipIf(!WT_AVAILABLE)("rejects oversize text (>= 5KiB UTF-16) with input_exceeds_paste_warning_threshold", async () => {
    const ps = await launchPowerShell({ host: "wt", banner: "ready-ff-validate-size" });
    try {
      // 2700 ASCII chars = 5400 bytes UTF-16, >= 5120 → reject
      const big = "a".repeat(2700);
      const r = parsePayload(await keyboardTypeHandler({
        text: big,
        method: "foreground_flash",
        use_clipboard: false,
        replaceAll: false,
        forceKeystrokes: false,
        windowTitle: ps.title,
        trackFocus: false,
        settleMs: 0,
      }));
      expect(r.ok, JSON.stringify(r)).toBe(false);
      expect(r.context?.reason).toBe("input_exceeds_paste_warning_threshold");
    } finally {
      ps?.kill();
    }
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. keyboard:type method:'foreground_flash' on WT — clipboard_flash 経路
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!WT_AVAILABLE)("foreground_flash — WT clipboard_flash channel (positive)", () => {
  let ps: PsInstance;
  beforeAll(async () => {
    ps = await launchPowerShell({ host: "wt", banner: "ready-ff-wt-positive" });
  }, 15_000);
  afterAll(() => { ps?.kill(); });

  it("keyboard:type single-line short text → ok:true with clipboard_flash hints", async () => {
    const tag = `ff-${Date.now().toString(36)}`;
    const r = parsePayload(await keyboardTypeHandler({
      text: tag,
      method: "foreground_flash",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      windowTitle: ps.title,
      trackFocus: false,
      settleMs: 0,
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.method).toBe("foreground_flash");
    expect(r.hints?.backgroundChannel).toBe("clipboard_flash");
    expect(r.hints?.typingLeakRisk).toBe(true);
    expect(r.hints?.typingLeakMitigation).toMatch(/userTyping/);
    expect(typeof r.hints?.flashDurationMs).toBe("number");
    expect(r.hints?.flashDurationMs).toBeGreaterThan(0);
    // foregroundStealMethod は実機依存だが、必ずどれか
    expect(["AttachThreadInput", "alt_unlock", "already_foreground"]).toContain(
      r.hints?.foregroundStealMethod
    );
    expect(typeof r.hints?.foregroundRestored).toBe("boolean");
    expect(typeof r.hints?.clipboardRestored).toBe("boolean");
    expect(Array.isArray(r.hints?.clipboardSkippedFormats)).toBe(true);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. method:'foreground_flash' on conhost — channel resolver は wm_char を picking
// ─────────────────────────────────────────────────────────────────────────────

describe("foreground_flash — conhost wm_char route (terminal class)", () => {
  let ps: PsInstance;
  beforeAll(async () => {
    ps = await launchPowerShell({ host: "conhost", banner: "ready-ff-conhost-wmchar" });
  }, 15_000);
  afterAll(() => { ps?.kill(); });

  it("keyboard:type method:'foreground_flash' on conhost → wm_char path", async () => {
    const tag = `ff-conhost-${Date.now().toString(36)}`;
    const r = parsePayload(await keyboardTypeHandler({
      text: tag,
      method: "foreground_flash",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      windowTitle: ps.title,
      trackFocus: false,
      settleMs: 0,
    }));
    // conhost (ConsoleWindowClass) は WM_CHAR supported → resolver が wm_char を返す
    // → handler は postCharsToHwnd で送信 + hints.backgroundChannel === 'wm_char'
    // (= 無駄な foreground steal をしない契約、§4 channel resolver 設計)。
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.method).toBe("foreground_flash");
    expect(r.hints?.backgroundChannel).toBe("wm_char");
    // wm_char 経路では typingLeakRisk hints は出ない (foreground 触らないため)
    expect(r.hints?.typingLeakRisk).toBeUndefined();
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. terminal:send method:'foreground_flash' on WT — pressEnter 透過
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!WT_AVAILABLE)("foreground_flash — terminal:send WT clipboard_flash (pressEnter)", () => {
  let ps: PsInstance;
  beforeAll(async () => {
    ps = await launchPowerShell({ host: "wt", banner: "ready-ff-terminal-wt" });
  }, 15_000);
  afterAll(() => { ps?.kill(); });

  it("terminal:send with pressEnter:true → Ctrl+V + Enter via flash", async () => {
    const r = parsePayload(await terminalSendHandler({
      windowTitle: ps.title,
      input: "echo ff_test",
      method: "foreground_flash",
      chunkSize: 100,
      pressEnter: true,
      focusFirst: false,
      restoreFocus: true,
      preferClipboard: false,
      pasteKey: "auto",
      trackFocus: false,
      settleMs: 0,
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.method).toBe("foreground_flash");
    expect(r.hints?.backgroundChannel).toBe("clipboard_flash");
    expect(r.hints?.typingLeakRisk).toBe(true);
    expect(typeof r.hints?.flashDurationMs).toBe("number");
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. keyboard:press method:'foreground_flash' は早期 reject
// ─────────────────────────────────────────────────────────────────────────────

describe("foreground_flash — keyboard:press explicit rejection", () => {
  it("rejects with ForegroundFlashNotApplicableToKeyPress", async () => {
    const r = parsePayload(await keyboardPressHandler({
      keys: "ctrl+a",
      method: "foreground_flash",
      windowTitle: "any",
      trackFocus: false,
      settleMs: 0,
    }));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("ForegroundFlashNotApplicableToKeyPress");
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.some((s: string) => /keyboard:type|terminal:send/.test(s))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Existing background contract regression guard
//    (§4.1 既存 API 不破壊 = method:'background' で WT は引き続き unsupported)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!WT_AVAILABLE)("foreground_flash — background contract regression guard", () => {
  let ps: PsInstance;
  beforeAll(async () => {
    ps = await launchPowerShell({ host: "wt", banner: "ready-ff-bg-contract" });
  }, 15_000);
  afterAll(() => { ps?.kill(); });

  it("method:'background' on WT remains unsupported (BackgroundInputNotDelivered)", async () => {
    const r = parsePayload(await keyboardTypeHandler({
      text: "regression-guard",
      method: "background",
      use_clipboard: false,
      replaceAll: false,
      forceKeystrokes: false,
      windowTitle: ps.title,
      trackFocus: false,
      settleMs: 0,
    }));
    // Phase 3 で canInjectViaPostMessage を touch していないため、WT で
    // 引き続き wt_xaml_pipeline reason の BackgroundInputNotDelivered。
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("BackgroundInputNotDelivered");
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Future work (Phase 4 MVP scope 外、heavy fixture / flaky / 別 PR 推奨)
// ─────────────────────────────────────────────────────────────────────────────

describe("foreground_flash — heavy fixtures (Phase 4 follow-up、別 PR / Phase 2 bench で扱う)", () => {
  it.todo("100 連続 inject で flaky < 1% (Phase 2 bench script で計測)");
  it.todo("foreground lock simulation → foreground_restore_failed");
  it.todo("clipboard race fixture (別 process が flash 中に SetClipboard) → clipboardRestored: false");
  it.todo("WT paste warning dialog 表示 → wt_paste_warning_intercepted (構造的回避で trigger 困難)");
  it.todo("画像 clipboard 状態で flash → clipboardSkippedFormats に CF_BITMAP 等記録");
});
