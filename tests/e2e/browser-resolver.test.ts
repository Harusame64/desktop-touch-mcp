/**
 * browser-resolver.test.ts — E2E for the ADR-023 Phase 1 action-target resolver.
 *
 * Real headless Chrome + a GSC-like fixture exercise the gather→decide pipeline
 * end to end (§2.bis): the injected fact gatherer reads real layout /
 * elementFromPoint, and the pure decision drives resolved / ambiguous /
 * noActionable. This is the layer the node unit tests cannot cover (no DOM); the
 * pure decision itself is unit-tested in browser-resolver-decision.test.ts.
 *
 * @see src/tools/browser-resolver.ts  resolveBrowserActionTarget
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { resolveBrowserActionTarget } from "../../src/tools/browser-resolver.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "resolver-gsc-like.html");
const TEST_PORT = 9226; // separate from other suites (9223/9224/9225)
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, true /* headless */, FIXTURE_URL);
  // Wait until the fixture is fully laid out — headless Chrome reports zero-size
  // rects before the first layout pass even after readyState === 'complete'.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluateInTab(
        `document.readyState === 'complete' && ` +
        `document.querySelector('#real-settings') !== null && ` +
        `document.querySelector('#real-settings').getBoundingClientRect().width > 0`,
        null, TEST_PORT);
      if (ready === true) return;
    } catch { /* ignore */ }
    await sleep(250);
  }
  throw new Error("Resolver fixture did not fully lay out within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

async function resolve(args: Partial<Parameters<typeof resolveBrowserActionTarget>[0]>) {
  return resolveBrowserActionTarget({
    by: "text", pattern: "", action: "click", port: TEST_PORT, ...args,
  } as Parameters<typeof resolveBrowserActionTarget>[0]);
}

describe.skipIf(!CHROME_AVAILABLE)("resolveBrowserActionTarget — unique resolution (AC-1/AC-2)", () => {
  it("resolves a dynamic-class button to actionable==1 when an off-viewport duplicate exists", async () => {
    // "Open Settings" matches BOTH the off-viewport drawer link and the real
    // in-viewport button; only the button is actionable (drawer link center is
    // off-screen → receivesEvents=false). One distinct actionable → resolved.
    const r = await resolve({ by: "text", pattern: "Open Settings", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.climbDepth).toBe(0);
      // physical point is finite and derived from the in-viewport rect center
      expect(Number.isFinite(r.physical.x)).toBe(true);
      expect(Number.isFinite(r.physical.y)).toBe(true);
      expect(r.rect.w).toBeGreaterThan(0);
      expect(r.rect.h).toBeGreaterThan(0);
    }
  });

  it("climbs from a matched label span to its button ancestor (depth 1)", async () => {
    const r = await resolve({ by: "text", pattern: "Compose Email", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("resolved");
    if (r.kind === "resolved") expect(r.climbDepth).toBe(1);
  });
});

describe.skipIf(!CHROME_AVAILABLE)("resolveBrowserActionTarget — ambiguity & safety (AC-3)", () => {
  it("two distinct actionable same-text buttons → ambiguous (no auto-act), with fingerprints", async () => {
    // "Save" matches the two in-viewport buttons AND the off-viewport drawer
    // link. The link is non-actionable (receivesEvents=false) so it does NOT
    // cause the ambiguity, but it IS returned in the fingerprint list (with its
    // actionability flags) so the agent sees every match. The ambiguity is the
    // 2 distinct actionable buttons → must stop, not auto-act.
    const r = await resolve({ by: "text", pattern: "Save", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.length).toBe(3); // 2 buttons + 1 off-viewport drawer link
      expect(r.total).toBe(3);
      expect(r.next.length).toBeGreaterThan(0);
      const actionable = r.candidates.filter((c) => c.actionability.receivesEvents);
      expect(actionable.length).toBe(2); // exactly the two visible buttons
      for (const c of r.candidates) expect(c.rect.w).toBeGreaterThan(0);
    }
  });

  it("matched text with no strong clickable ancestor → noActionable (candidates still returned)", async () => {
    const r = await resolve({ by: "text", pattern: "Just a label Foobar", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("noActionable");
    if (r.kind === "noActionable") expect(r.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("occluded button (covered by a higher z-index overlay) → noActionable", async () => {
    const r = await resolve({ by: "text", pattern: "Covered Action", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("noActionable");
  });
});

describe.skipIf(!CHROME_AVAILABLE)("resolveBrowserActionTarget — role filter (plan §S4)", () => {
  it("role:'button' keeps the in-viewport button → resolved", async () => {
    const r = await resolve({ by: "text", pattern: "Open Settings", role: "button", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("resolved");
  });

  it("role:'link' keeps only the off-viewport drawer link → noActionable", async () => {
    const r = await resolve({ by: "text", pattern: "Open Settings", role: "link", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("noActionable");
  });
});

describe.skipIf(!CHROME_AVAILABLE)("resolveBrowserActionTarget — fill path (AC-4)", () => {
  it("resolves an input by aria-label without the receivesEvents gate", async () => {
    const r = await resolve({ by: "ariaLabel", pattern: "Email address", action: "fill" });
    expect(r.kind, JSON.stringify(r)).toBe("resolved");
    if (r.kind === "resolved") expect(r.climbDepth).toBe(0);
  });
});

describe.skipIf(!CHROME_AVAILABLE)("resolveBrowserActionTarget — gather errors", () => {
  it("a scope that matches nothing surfaces a ScopeNotFound error outcome", async () => {
    const r = await resolve({ by: "text", pattern: "Save", scope: "#no-such-scope-xyz", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("ScopeNotFound");
  });

  it("an invalid CSS selector throws inside the eval but is normalised to an error outcome (Codex P2)", async () => {
    // by:'selector' with malformed CSS makes querySelectorAll throw a SyntaxError
    // out of the IIFE; the wrapper must return { kind:'error' }, not reject.
    const r = await resolve({ by: "selector", pattern: "div::::bad((", action: "click" });
    expect(r.kind, JSON.stringify(r)).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("EvalError");
  });
});
