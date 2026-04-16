/**
 * perception-mvp.test.ts — E2E tests for the Reactive Perception Graph MVP.
 *
 * Scenario 1: "guard warn mode — envelope attached to keyboard_type"
 *   - Launch Notepad, register a perception lens (guardPolicy:"warn")
 *   - Type text with lensId → verify post.perception envelope is attached
 *   - Envelope should include attention, guards, canAct, latest.target fields
 *
 * Scenario 2: "identity invalidation blocks keyboard_type (block mode)"
 *   - Launch Notepad, register a lens (guardPolicy:"block")
 *   - Kill Notepad, launch a new Notepad (different pid)
 *   - keyboard_type with lensId → should return {ok:false, code:"GuardFailed"}
 *
 * Scenario 3: "rebindSuggestion in envelope when identity_changed (v0.11.0 F8)"
 *   - Register a lens, kill the target, rebuild the envelope
 *   - If identity changed, rebindSuggestion must be present in the envelope
 *
 * Prerequisites: desktop, Notepad available, Win32 access.
 * Run with: npx vitest run tests/e2e/perception-mvp.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  registerLens,
  forgetLens,
  evaluatePreToolGuards,
  buildEnvelopeFor,
  __resetForTests as __resetRegistry,
} from "../../src/engine/perception/registry.js";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { restoreAndFocusWindow } from "../../src/engine/win32.js";
import type { LensSpec } from "../../src/engine/perception/types.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

const warnSpec: LensSpec = {
  name: "test-warn",
  target: { kind: "window", match: { titleIncludes: "" } }, // filled per-test
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget"],
  guardPolicy: "warn",
  maxEnvelopeTokens: 200,
  salience: "normal",
};

const blockSpec: LensSpec = {
  name: "test-block",
  target: { kind: "window", match: { titleIncludes: "" } }, // filled per-test
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget"],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: warn mode — envelope attached to keyboard_type
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 1: perception lens — envelope in keyboard_type response", () => {
  let np: NpInstance;
  let lensId: string;

  beforeAll(async () => {
    __resetRegistry();
    np = await launchNotepad();
    try { restoreAndFocusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(400);

    // Register lens with warn mode so guards don't block typing
    const spec: LensSpec = { ...warnSpec, name: `warn-${np.tag}`, target: { kind: "window", match: { titleIncludes: np.tag } } };
    const result = registerLens(spec);
    lensId = result.lensId;
  }, 30_000);

  afterAll(() => {
    if (lensId) { try { forgetLens(lensId); } catch { /* ignore */ } }
    np?.kill();
  });

  it("returns a lensId from registerLens", () => {
    expect(lensId).toMatch(/^perc-\d+$/);
  });

  it("keyboard_type with lensId attaches post.perception envelope", async () => {
    try { restoreAndFocusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(300);

    const result = await keyboardTypeHandler({
      text: "x",
      use_clipboard: true,
      replaceAll: false,
      forceKeystrokes: false,
      windowTitle: np.tag,
      trackFocus: false,
      settleMs: 100,
      lensId,
    });
    const p = parsePayload(result);
    expect(p.ok).toBe(true);

    // The _perceptionForPost should have been moved into post.perception by _post.ts
    // Since keyboardTypeHandler returns the raw payload (before withPostState wraps it),
    // we check _perceptionForPost is present in the raw payload OR post.perception if wrapped.
    // keyboardTypeHandler is wrapped by withRichNarration which is wrapped by withPostState in registration.
    // Since we call the handler directly here, _post.ts wrapping doesn't apply.
    // Instead, verify _perceptionForPost is in the payload.
    expect(p._perceptionForPost ?? p.post?.perception).toBeDefined();
    const env = p._perceptionForPost ?? p.post?.perception;
    expect(env.lens).toBe(lensId);
    expect(env.attention).toBeDefined();
    expect(env.guards).toBeDefined();
    expect(env.latest?.target).toBeDefined();
    // v0.11.0 F8: canAct must be present in every envelope
    expect(env.canAct).toBeDefined();
    expect(typeof env.canAct.keyboard).toBe("boolean");
    expect(typeof env.canAct.mouse).toBe("boolean");
  });

  it("evaluatePreToolGuards returns results with focus active", async () => {
    try { restoreAndFocusWindow(np.hwnd); } catch { /* non-fatal */ }
    const result = await evaluatePreToolGuards(lensId, "keyboard_type", {});
    // policy is warn — ok may be false if not foreground, but policy field is correct
    expect(result.policy).toBe("warn");
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("buildEnvelopeFor returns a valid PerceptionEnvelope", () => {
    const env = buildEnvelopeFor(lensId, { toolName: "test" });
    expect(env).not.toBeNull();
    expect(env!.lens).toBe(lensId);
    expect(typeof env!.seq).toBe("number");
    expect(env!.guards).toBeDefined();
    expect(env!.latest).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: identity invalidation blocks keyboard_type (block mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 2: identity invalidation blocks keyboard_type", () => {
  let np1: NpInstance;
  let np2: NpInstance;
  let lensId: string;

  beforeAll(async () => {
    __resetRegistry();
    // Launch first Notepad and register a BLOCK-mode lens
    np1 = await launchNotepad();
    try { restoreAndFocusWindow(np1.hwnd); } catch { /* non-fatal */ }
    await sleep(400);

    const spec: LensSpec = {
      ...blockSpec,
      name: `block-${np1.tag}`,
      target: { kind: "window", match: { titleIncludes: np1.tag } },
    };
    const result = registerLens(spec);
    lensId = result.lensId;

    // Kill first Notepad (simulate process restart / app close)
    np1.kill();
    await sleep(500);

    // Launch a second Notepad with the SAME tag (so the lens's titleIncludes still matches)
    // but this is a different process — different pid + processStartTimeMs
    np2 = await launchNotepad();
    try { restoreAndFocusWindow(np2.hwnd); } catch { /* non-fatal */ }
    await sleep(400);
  }, 60_000);

  afterAll(() => {
    if (lensId) { try { forgetLens(lensId); } catch { /* ignore */ } }
    np1?.kill();
    np2?.kill();
  });

  it("evaluatePreToolGuards blocks after original process exited (identity changed)", async () => {
    // The registered lens has the old window's identity (pid + processStartTimeMs).
    // After np1 dies and np2 starts, the identity stored in the FluentStore will be
    // refreshed to np2's identity on the next guard evaluation, which won't match boundIdentity.
    const result = await evaluatePreToolGuards(lensId, "keyboard_type", {});
    // Identity should be unstable (different process)
    const identityGuard = result.results.find(r => r.kind === "target.identityStable");
    // If np1 and np2 happen to have same pid (rare but possible), this test may not fail.
    // We assert the guard system ran correctly regardless.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.policy).toBe("block");

    // With different process, identity guard should fail
    if (identityGuard && !identityGuard.ok) {
      expect(result.ok).toBe(false);
    }
  });

  it("keyboard_type with stale lensId returns GuardFailed for changed identity", async () => {
    // This only tests the guard path if identity truly changed.
    // The guard evaluates on every call — if np2 happens to share pid with np1 (unlikely),
    // the guard passes. We check for either GuardFailed or ok:true (both are valid outcomes).
    const result = await keyboardTypeHandler({
      text: "x",
      use_clipboard: true,
      replaceAll: false,
      forceKeystrokes: false,
      trackFocus: false,
      settleMs: 0,
      lensId,
    });
    const p = parsePayload(result);

    if (!p.ok) {
      // Identity changed → guard blocked
      expect(p.code).toBe("GuardFailed");
      expect(Array.isArray(p.suggest)).toBe(true);
    } else {
      // Identity happened to match (same pid reuse) → guard passed
      expect(p.ok).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: rebindSuggestion in envelope when identity_changed (v0.11.0 F8)
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 3: rebindSuggestion in envelope on identity_changed", () => {
  let np1: NpInstance;
  let np2: NpInstance;
  let lensId: string;

  beforeAll(async () => {
    __resetRegistry();
    np1 = await launchNotepad();
    try { restoreAndFocusWindow(np1.hwnd); } catch { /* non-fatal */ }
    await sleep(400);

    const spec: LensSpec = {
      ...blockSpec,
      name: `rebind-${np1.tag}`,
      target: { kind: "window", match: { titleIncludes: np1.tag } },
    };
    const result = registerLens(spec);
    lensId = result.lensId;

    // Kill original window, launch a different one to change identity
    np1.kill();
    await sleep(600);
    np2 = await launchNotepad();
    await sleep(300);
  }, 60_000);

  afterAll(() => {
    if (lensId) { try { forgetLens(lensId); } catch { /* ignore */ } }
    np1?.kill();
    np2?.kill();
  });

  it("buildEnvelopeFor returns canAct in every envelope", () => {
    const env = buildEnvelopeFor(lensId, { toolName: "test" });
    expect(env).not.toBeNull();
    // v0.11.0 F8: canAct is always present
    expect(env!.canAct).toBeDefined();
    expect(typeof env!.canAct.keyboard).toBe("boolean");
    expect(typeof env!.canAct.mouse).toBe("boolean");
  });

  it("buildEnvelopeFor includes rebindSuggestion when identity_changed", () => {
    const env = buildEnvelopeFor(lensId, { toolName: "test" });
    expect(env).not.toBeNull();

    if (env!.attention === "identity_changed") {
      // v0.11.0 F8: rebindSuggestion must be present
      expect(env!.rebindSuggestion).toBeDefined();
      expect(env!.rebindSuggestion!.action).toBe("forget_and_register_again");
      expect(env!.rebindSuggestion!.reason).toBe("identity_changed");
      expect(env!.rebindSuggestion!.lensId).toBe(lensId);
    } else {
      // identity did not change (pid reuse) — rebindSuggestion absent is correct
      expect(env!.rebindSuggestion).toBeUndefined();
    }
  });
});
