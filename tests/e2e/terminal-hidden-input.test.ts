/**
 * terminal-hidden-input.test.ts — E2E for issue #183:
 * `terminal({action:'send', method:'background'})` hidden-input prompt
 * detection (matrix doc §3.1 terminal action:send BG row, §4.2 verifyDelivery
 * regular shape, §4.3 reason `hidden_input_prompt`).
 *
 * Coverage:
 *  1. PowerShell `Read-Host -Prompt 'Password' -AsSecureString` → BG send a
 *     password → ok:true with hints.verifyDelivery = { status:"unverifiable",
 *     reason:"hidden_input_prompt", channel:"wm_char", fallback:"method:'foreground'" }.
 *     Without #183 the post-send UIA read-back would mis-fire
 *     BackgroundInputNotDelivered because the prompt suppresses echo.
 *
 *  2. Regression guard — a normal `PS C:\>` prompt MUST NOT trigger detection.
 *     A regular BG send to that prompt either succeeds with no verifyDelivery
 *     hint (current behaviour for delivered Strict path) or surfaces a real
 *     verification failure if the channel itself broke. The point is that
 *     `hidden_input_prompt` reason is NEVER emitted on a non-hidden prompt.
 *
 * Skip policy: conhost scenarios are default-on (matches terminal.test.ts
 * default). WT host coverage is OPT-IN via `DTM_E2E_WT=1` — WT-launcher cleanup
 * is single-PID kill but the env gate keeps casual `npm test` runs from
 * spawning WT processes (memory: feedback_e2e_wt_host_taskkill_risk.md).
 *
 * sudo-style prompt simulation requires WSL/Linux and is left out — the unit
 * tests in `tests/unit/terminal-hidden-input.test.ts` already pin the regex
 * for `Password for ` and the keyword-anchor case.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { terminalReadHandler, terminalSendHandler } from "../../src/tools/terminal.js";
import { launchPowerShell, type PsInstance, type TerminalHost } from "./helpers/powershell-launcher.js";
import { sleep, parsePayload } from "./helpers/wait.js";

interface HostScenario {
  host: TerminalHost;
  label: string;
}

const WT_E2E_ENABLED = process.env["DTM_E2E_WT"] === "1";

const SCENARIOS: HostScenario[] = [
  { host: "conhost", label: "conhost" },
  ...(WT_E2E_ENABLED
    ? [{ host: "wt" as const, label: "Windows Terminal" }]
    : []),
];

/**
 * Wait until `terminal_read` returns text whose last non-empty line contains
 * `marker`. Used to confirm the PowerShell prompt has rendered the
 * `Read-Host` prompt before sending the password into it.
 */
async function waitForPromptLine(
  windowTitle: string,
  marker: RegExp,
  timeoutMs = 5000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = parsePayload(await terminalReadHandler({
      windowTitle,
      lines: 50,
      stripAnsi: true,
      source: "auto",
      ocrLanguage: "ja",
    }));
    if (r.ok && typeof r.text === "string") {
      const lines = r.text.split(/\r?\n/);
      // Last non-empty line
      let last = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!.replace(/\s+$/, "");
        if (l) { last = l; break; }
      }
      if (marker.test(last)) return last;
    }
    await sleep(150);
  }
  return null;
}

describe.each(SCENARIOS)("[$label] terminal hidden-input detection (#183)", ({ host, label }) => {
  let ps: PsInstance;
  const BANNER_TAG = `pstest-hi-${host}-${Date.now().toString(36)}`;

  beforeAll(async () => {
    ps = await launchPowerShell({ host, banner: `ready-${BANNER_TAG}` });
  }, 15_000);

  afterAll(() => {
    ps?.kill();
  });

  it(`fires hidden_input_prompt for Read-Host -AsSecureString [${label}]`, async ({ skip }) => {
    // Step 1: arm the Read-Host prompt. The command itself is sent via the
    // foreground (clipboard paste) path so we exercise only the hidden-input
    // detection on the SECOND send (the password). Using preferClipboard:true
    // and method:'auto' on a non-terminal? Actually conhost IS a terminal.
    // We want this initial command to use the BG path is fine — but we must
    // wait for the prompt to render. Simplest: send via default settings and
    // then wait for the `Password:` line.
    const armRes = parsePayload(await terminalSendHandler({
      windowTitle: ps.title,
      input: `$pw = Read-Host -Prompt 'Password' -AsSecureString`,
      pressEnter: true,
      focusFirst: true,
      restoreFocus: false,
      preferClipboard: true,
      pasteKey: "auto",
      // method:'auto' picks BG on terminal-class targets. That fires the
      // verifier (verificationNeeded? auto + isTerminalTarget → false for
      // conhost — only `method:'background'` or `DTM_BG_AUTO=1+non-terminal`
      // verifies). So no hidden-input check fires for the arm command — the
      // baseline at that moment is a normal `PS C:\> ` prompt anyway.
      trackFocus: false,
      settleMs: 100,
    }));

    if (!armRes.ok) {
      const warnings = armRes.hints?.warnings ?? [];
      if (warnings.some((w: string) => w.startsWith("ForegroundNotTransferred"))) {
        skip(`arm step refused foreground transfer — env condition`);
      }
      throw new Error(`arm Read-Host failed: ${JSON.stringify(armRes)}`);
    }

    const lastLine = await waitForPromptLine(ps.title, /Password:\s*$/, 5000);
    if (lastLine === null) {
      // The prompt did not render — likely a focus / paste env issue, not a
      // verification regression. Skip rather than fail to keep the test stable.
      skip(`Password prompt did not render within 5s on ${label} — env condition`);
    }

    // Step 2: BG send the password. Force method:'background' so verification
    // would normally run; #183 must short-circuit it via hidden_input_prompt.
    const password = "hunter2-shh";
    const sendRes = parsePayload(await terminalSendHandler({
      windowTitle: ps.title,
      input: password,
      method: "background",
      pressEnter: true,
      focusFirst: false,
      restoreFocus: false,
      preferClipboard: false,
      pasteKey: "auto",
      trackFocus: false,
      settleMs: 0,
    }));

    expect(sendRes.ok, JSON.stringify(sendRes)).toBe(true);
    expect(sendRes.method).toBe("background");
    expect(sendRes.channel).toBe("wm_char");

    // The matrix doc §4.2 regular shape:
    //   { status:"unverifiable", reason:"hidden_input_prompt",
    //     channel:"wm_char", fallback:"method:'foreground'" }
    expect(sendRes.hints).toBeDefined();
    expect(sendRes.hints.verifyDelivery).toBeDefined();
    expect(sendRes.hints.verifyDelivery.status).toBe("unverifiable");
    expect(sendRes.hints.verifyDelivery.reason).toBe("hidden_input_prompt");
    expect(sendRes.hints.verifyDelivery.channel).toBe("wm_char");
    expect(sendRes.hints.verifyDelivery.fallback).toMatch(/foreground/);

    // Drain Read-Host so the buffer is back at PS> for the next test.
    await sleep(500);
  }, 25_000);

  it(`does NOT fire hidden_input_prompt at a normal PS> prompt [${label}]`, async ({ skip }) => {
    // Sanity: drain any pending Read-Host first.
    await sleep(500);

    // Confirm the prompt is at a normal `PS C:\>` shape.
    const lastLine = await waitForPromptLine(ps.title, /[>]\s*$/, 3000);
    if (lastLine === null) {
      skip(`PS> prompt did not render within 3s on ${label} — env condition`);
    }
    // Defensive: explicitly reject the pathological case where a Password:
    // prompt is still pending. If it is, our previous test left a Read-Host
    // armed — we'd produce a false negative below.
    const baselineRead = parsePayload(await terminalReadHandler({
      windowTitle: ps.title,
      lines: 20,
      stripAnsi: true,
      source: "auto",
      ocrLanguage: "ja",
    }));
    expect(baselineRead.ok).toBe(true);
    expect(/Password:\s*$/.test(baselineRead.text.trimEnd())).toBe(false);

    // BG send a unique echo with method:'background' so verification runs.
    // On conhost the read-back should succeed and verifyDelivery hint should
    // either be absent (current Strict-path delivered behaviour) or carry
    // status:"delivered" — but it must NEVER be reason:"hidden_input_prompt".
    const tag = `nh-${host}-${Date.now().toString(36)}`;
    const sendRes = parsePayload(await terminalSendHandler({
      windowTitle: ps.title,
      input: `echo ${tag}`,
      method: "background",
      pressEnter: true,
      focusFirst: false,
      restoreFocus: false,
      preferClipboard: false,
      pasteKey: "auto",
      trackFocus: false,
      settleMs: 0,
    }));

    if (host === "wt" && !sendRes.ok) {
      // WT silent drop — known per terminal.test.ts. The point of THIS test
      // is to assert hidden_input_prompt is NOT the reason.
      expect(sendRes.code).toBe("BackgroundInputNotDelivered");
      // No verifyDelivery hint expected on the failure envelope.
      return;
    }

    expect(sendRes.ok, JSON.stringify(sendRes)).toBe(true);
    const verifyDelivery = sendRes.hints?.verifyDelivery;
    if (verifyDelivery !== undefined) {
      expect(verifyDelivery.reason).not.toBe("hidden_input_prompt");
    }
  }, 20_000);
});
