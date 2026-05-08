/**
 * terminal.test.ts — E2E tests for terminal_read / terminal_send.
 *
 * Issue #173 — parameterized over [conhost, WindowsTerminal] hosts:
 *  - conhost: ConsoleWindowClass — WM_CHAR friendly. terminal_send takes the
 *    BG (WM_CHAR) path with post-send UIA read-back verification.
 *  - wt: CASCADIA_HOSTING_WINDOW_CLASS — WinUI/XAML pipeline silently swallows
 *    WM_CHAR. terminal_send falls through to the foreground (clipboard paste)
 *    path. Explicit method:'background' must surface BackgroundInputNotDelivered.
 *
 * Skip policy (issue #173 §S-2): the only env condition that may skip a
 * delivery assertion is foreground-stealing protection (warning
 * "ForegroundNotTransferred"). Anything else — silent send/read mismatch,
 * tag missing without that warning — is a product invariant violation and
 * MUST fail. Generic skip-on-failure paths are removed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { terminalReadHandler, terminalSendHandler } from "../../src/tools/terminal.js";
import { launchPowerShell, isWindowsTerminalAvailable, type PsInstance, type TerminalHost } from "./helpers/powershell-launcher.js";
import { sleep, parsePayload } from "./helpers/wait.js";

interface HostScenario {
  host: TerminalHost;
  label: string;
  /** Expected window class for sanity assertion. */
  expectedClassPattern: RegExp;
}

// Issue #175: WT host scenario is now default-on. Background:
//
// On 2026-05-08 a launcher cleanup mishap (taskkill /T against a PS hosted
// in the shared WT instance) escalated to the user's whole WT tree and
// closed every tab. As an immediate mitigation issue #173 demoted the WT
// matrix entry to opt-in via `DTM_E2E_WT=1`. Issue #175 brings it back to
// default-on once the launcher had independent isolation guarantees.
//
// Isolation guarantees provided by `tests/e2e/helpers/powershell-launcher.ts`
// (host:'wt' branch) — keep these in sync if you touch the launcher:
//   1. `-w <unique>`: each launch forces a brand-new, uniquely-named WT
//      top-level window. Our WT window is therefore disjoint from every
//      window the user already has open.
//   2. `-p __dtm_e2e__`: profile name reserved for E2E. WT falls back to
//      the default profile if it does not exist, without writing settings.
//   3. Single-PID kill (NEVER `/T`): cleanup targets the spawned PS PID
//      only. /T is forbidden — see launcher kill() comment.
//
// If you re-introduce a process-tree-wide kill (taskkill /T, similar) the
// gate must come back. This regression would not be caught in CI; protect
// it with a code review check.
const SCENARIOS: HostScenario[] = [
  { host: "conhost", label: "conhost", expectedClassPattern: /^ConsoleWindowClass$/ },
  { host: "wt", label: "Windows Terminal", expectedClassPattern: /^CASCADIA_HOSTING_WINDOW_CLASS$/ },
];

/**
 * Returns true when the response carries a "ForegroundNotTransferred" warning,
 * i.e. Windows foreground-stealing protection refused the focus shift. That is
 * the only env-dependent outcome we permit a test to skip on.
 */
function hasForegroundNotTransferred(payload: { hints?: { warnings?: string[] } }): boolean {
  const warnings = payload.hints?.warnings;
  return Array.isArray(warnings) && warnings.some((w) => w.startsWith("ForegroundNotTransferred"));
}

describe.each(SCENARIOS)("[$label] terminal", ({ host, label, expectedClassPattern }) => {
  let ps: PsInstance;
  const BANNER_TAG = `pstest-${host}-${Date.now().toString(36)}`;

  beforeAll(async (ctx) => {
    // Codex P2 (#175): WT scenarios are now default-on (no DTM_E2E_WT gate),
    // so on hosts without wt.exe (Linux CI, stripped Windows images) the
    // launcher would time out and fail the file. Skip cleanly when the
    // dependency is absent — this is environmental, not a product bug.
    if (host === "wt" && !(await isWindowsTerminalAvailable())) {
      ctx.skip();
      return;
    }
    ps = await launchPowerShell({ host, banner: `ready-${BANNER_TAG}` });
  }, 15_000);

  afterAll(() => {
    ps?.kill();
  });

  describe(`terminal_read [${label}]`, () => {
    it("reads the PowerShell buffer (UIA TextPattern or OCR fallback)", async () => {
      const res = await terminalReadHandler({
        windowTitle: ps.title,
        lines: 100,
        stripAnsi: true,
        source: "auto",
        ocrLanguage: "ja",
      });
      const p = parsePayload(res);
      expect(p.ok).toBe(true);
      expect(["uia", "ocr"]).toContain(p.source);
      expect(p.text).toContain(`ready-${BANNER_TAG}`);
      expect(p.marker).toMatch(/^[a-f0-9]{16}$/);
      expect(p.hints.target.hwnd).toBe(String(ps.hwnd));
      expect(p.hints.target.processName.toLowerCase()).toMatch(/powershell|pwsh|windowsterminal|conhost/);
    });

    it("sinceMarker returns an empty (or shorter) diff on immediate re-read", async () => {
      const r1 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 100, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      const r2 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 100, stripAnsi: true, source: "auto", ocrLanguage: "ja",
        sinceMarker: r1.marker,
      }));
      expect(r2.ok).toBe(true);
      if (r2.hints.terminalMarker.previousMatched) {
        expect(r2.text.length).toBeLessThan(r1.text.length);
      }
      expect(r2.hints.terminalMarker.current).toMatch(/^[a-f0-9]{16}$/);
      expect(r2.hints.target.hwnd).toBe(r1.hints.target.hwnd);
    });

    it("fails cleanly for an unknown window with suggest[]", async () => {
      const r = parsePayload(await terminalReadHandler({
        windowTitle: "__no_such_terminal_xyz_12345__",
        lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe("TerminalWindowNotFound");
      expect(Array.isArray(r.suggest)).toBe(true);
      expect(r.suggest.some((s: string) => /desktop_discover/.test(s))).toBe(true);
    });

    it("returns hints.target and hints.caches", async () => {
      const r = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 10, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r.hints.target).toEqual(expect.objectContaining({
        hwnd: expect.any(String),
        pid: expect.any(Number),
        processName: expect.any(String),
        processStartTimeMs: expect.any(Number),
        titleResolved: expect.any(String),
      }));
      expect(r.hints.caches).toBeDefined();
    });
  });

  describe(`terminal_send [${label}]`, () => {
    it("delivers a unique line that terminal_read observes", async ({ skip }) => {
      const sentTag = `sent-${host}-${Date.now().toString(36)}`;
      const sendRes = parsePayload(await terminalSendHandler({
        windowTitle: ps.title,
        input: `echo ${sentTag}`,
        pressEnter: true,
        focusFirst: true,
        restoreFocus: true,
        preferClipboard: true,
        pasteKey: "auto",
      }));

      // Issue #173 §S-2: skip ONLY when Windows refused the foreground shift.
      // Any other failure is a product invariant violation and MUST fail.
      if (!sendRes.ok) {
        if (hasForegroundNotTransferred(sendRes)) {
          skip(`terminal_send foreground transfer refused — env condition. payload=${JSON.stringify(sendRes)}`);
        }
        // Treat all other failures as real bugs.
      }
      expect(sendRes.ok).toBe(true);
      expect(sendRes.post).toBeDefined();
      expect(sendRes.post.elapsedMs).toBeGreaterThan(0);

      // Let PowerShell render the output
      await sleep(1500);

      const readRes = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 200, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(readRes.ok, JSON.stringify(readRes)).toBe(true);

      // If the send response carried ForegroundNotTransferred, the keystrokes
      // landed on the previously-focused window — env condition, skip the
      // strict read-back. Otherwise the tag MUST be in the buffer.
      if (!readRes.text.includes(sentTag) && hasForegroundNotTransferred(sendRes)) {
        skip(
          `terminal_send focus did not transfer — read-back skipped. ` +
          `Buffer tail: ${readRes.text.slice(-200)}`
        );
      }
      expect(readRes.text).toContain(sentTag);
    }, 20_000);

    it("reports TerminalWindowNotFound for an unknown window", async () => {
      const r = parsePayload(await terminalSendHandler({
        windowTitle: "__no_such_terminal_xyz_9876__",
        input: "noop",
        pressEnter: false,
        focusFirst: true,
        restoreFocus: true,
        preferClipboard: true,
        pasteKey: "auto",
      }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe("TerminalWindowNotFound");
    });

    it("D2: immediate terminal_read after slow command may be empty — not an error", async ({ skip }) => {
      const tag = `d2-${host}-${Date.now().toString(36)}`;
      const sendRes = parsePayload(await terminalSendHandler({
        windowTitle: ps.title,
        input: `Start-Sleep -Milliseconds 800; echo ${tag}`,
        pressEnter: true,
        focusFirst: true,
        restoreFocus: true,
        preferClipboard: true,
        pasteKey: "auto",
      }));
      if (!sendRes.ok) {
        if (hasForegroundNotTransferred(sendRes)) {
          skip(`terminal_send foreground transfer refused — env condition`);
        }
      }
      expect(sendRes.ok).toBe(true);

      const r1 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r1.ok).toBe(true);
      expect(r1.marker).toMatch(/^[a-f0-9]{16}$/);
      const immediateHasOutput = r1.text.includes(tag);

      await sleep(1500);
      const r2 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 50, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r2.ok).toBe(true);
      if (!r2.text.includes(tag) && hasForegroundNotTransferred(sendRes)) {
        skip(`D2: output tag not found — focus did not transfer (env).`);
      }
      expect(r2.text).toContain(tag);
      if (!immediateHasOutput) {
        expect(r2.text).toContain(tag);
      }
    }, 20_000);
  });

  describe(`D1: sinceMarker after new command output [${label}]`, () => {
    it("previousMatched:true and diff contains new output after a command runs", async ({ skip }) => {
      const r1 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 2000, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r1.ok).toBe(true);
      const marker1 = r1.marker;

      const tag = `d1-${host}-${Date.now().toString(36)}`;
      const sendRes = parsePayload(await terminalSendHandler({
        windowTitle: ps.title,
        input: `echo ${tag}`,
        pressEnter: true,
        focusFirst: true,
        restoreFocus: true,
        preferClipboard: true,
        pasteKey: "auto",
      }));
      if (!sendRes.ok) {
        if (hasForegroundNotTransferred(sendRes)) {
          skip(`terminal_send foreground transfer refused — env condition`);
        }
      }
      expect(sendRes.ok).toBe(true);

      await sleep(1000);

      const r2 = parsePayload(await terminalReadHandler({
        windowTitle: ps.title,
        lines: 2000,
        stripAnsi: true,
        source: "auto",
        ocrLanguage: "ja",
        sinceMarker: marker1,
      }));
      expect(r2.ok).toBe(true);

      if (!r2.hints.terminalMarker.previousMatched) {
        if (hasForegroundNotTransferred(sendRes)) {
          skip(`D1: sinceMarker did not match — focus did not transfer (env).`);
        }
        // Otherwise: marker miss is a product bug (rendering churn we should
        // have absorbed via normalizeForMarker). Fall through to fail.
      }
      expect(r2.hints.terminalMarker.previousMatched).toBe(true);
      if (!r2.text.includes(tag) && hasForegroundNotTransferred(sendRes)) {
        skip(`D1: tag not in diff — focus did not transfer (env).`);
      }
      expect(r2.text).toContain(tag);
      expect(r2.text.length).toBeLessThan(r1.text.length);
    }, 25_000);
  });

  describe(`D3: terminal_read returns actual buffer — not tab title (regression guard) [${label}]`, () => {
    it("returned text is multi-line (a tab title is a single line)", async () => {
      const r = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 100, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r.ok).toBe(true);
      const lineCount = r.text.split("\n").filter((l: string) => l.trim()).length;
      expect(lineCount).toBeGreaterThan(1);
    });

    it("returned text contains the banner (not just window title)", async () => {
      const r = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 200, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r.ok).toBe(true);
      expect(r.text).toContain(`ready-${BANNER_TAG}`);
      expect(r.text.length).toBeGreaterThan(ps.title.length * 3);
    });

    it("text does NOT equal window title (direct tab-title match guard)", async () => {
      const r = parsePayload(await terminalReadHandler({
        windowTitle: ps.title, lines: 10, stripAnsi: true, source: "auto", ocrLanguage: "ja",
      }));
      expect(r.ok).toBe(true);
      expect(r.text.trim()).not.toBe(ps.title.trim());
    });
  });

  // Issue #173: explicit method:'background' on Windows Terminal must surface
  // BackgroundInputNotDelivered (post-send UIA read-back catches the silent
  // swallow). On conhost the BG path is the default and must succeed.
  describe(`issue #173: BG path delivery [${label}]`, () => {
    it("class sanity check (host produced the expected window class)", async () => {
      const { getWindowClassName } = await import("../../src/engine/win32.js");
      const cls = getWindowClassName(ps.hwnd);
      expect(cls).toMatch(expectedClassPattern);
    });

    if (host === "wt") {
      it("method:'background' on Windows Terminal returns BackgroundInputNotDelivered", async () => {
        const tag = `bg-wt-${Date.now().toString(36)}`;
        const sendRes = parsePayload(await terminalSendHandler({
          windowTitle: ps.title,
          input: `echo ${tag}`,
          method: "background",
          pressEnter: true,
          focusFirst: false,
          restoreFocus: false,
          preferClipboard: false,
          pasteKey: "auto",
        }));
        expect(sendRes.ok, JSON.stringify(sendRes)).toBe(false);
        expect(sendRes.code).toBe("BackgroundInputNotDelivered");
        expect(Array.isArray(sendRes.suggest)).toBe(true);
        expect(sendRes.suggest.some((s: string) => /foreground/i.test(s))).toBe(true);
      }, 10_000);
    }

    if (host === "conhost") {
      it("method:'background' on conhost succeeds and the line shows up", async () => {
        const tag = `bg-conhost-${Date.now().toString(36)}`;
        const sendRes = parsePayload(await terminalSendHandler({
          windowTitle: ps.title,
          input: `echo ${tag}`,
          method: "background",
          pressEnter: true,
          focusFirst: false,
          restoreFocus: false,
          preferClipboard: false,
          pasteKey: "auto",
        }));
        expect(sendRes.ok, JSON.stringify(sendRes)).toBe(true);
        expect(sendRes.method).toBe("background");
        expect(sendRes.channel).toBe("wm_char");

        await sleep(1000);
        const readRes = parsePayload(await terminalReadHandler({
          windowTitle: ps.title, lines: 100, stripAnsi: true, source: "auto", ocrLanguage: "ja",
        }));
        expect(readRes.ok).toBe(true);
        expect(readRes.text).toContain(tag);
      }, 15_000);
    }
  });
});
