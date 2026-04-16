/**
 * tests/unit/browser-ready-guard.test.ts
 *
 * Tests for the browser.ready guard and its integration with safe.keyboardTarget
 * on browserTab lenses.
 */

import { describe, it, expect } from "vitest";
import { evaluateGuard } from "../../src/engine/perception/guards.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { PerceptionLens, LensSpec, BrowserTabIdentity } from "../../src/engine/perception/types.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TAB_ID = "tab-abc-123";

function makeStore(): FluentStore {
  const s = new FluentStore();
  s.__resetForTests();
  return s;
}

function setReadyState(store: FluentStore, value: string | null, confidence = 0.95) {
  const nowMs = Date.now();
  const seq = 1;
  store.apply([{
    seq,
    tsMs: nowMs,
    source: "cdp",
    entity: { kind: "browserTab", id: TAB_ID },
    property: "browser.readyState",
    value,
    confidence,
    evidence: makeEvidence("cdp", seq, nowMs),
  }]);
}

const baseLens: PerceptionLens = {
  lensId: "perc-tab-1",
  spec: {
    name: "test-tab",
    target: { kind: "browserTab", match: { urlIncludes: "example.com" } },
    maintain: ["browser.url", "browser.title", "browser.readyState"],
    guards: ["browser.ready"],
    guardPolicy: "block",
    maxEnvelopeTokens: 120,
    salience: "normal",
  } satisfies LensSpec,
  binding: { hwnd: TAB_ID, windowTitle: "Example Domain" },
  boundIdentity: {
    tabId: TAB_ID,
    title: "Example Domain",
    url: "https://example.com",
    port: 9222,
  } satisfies BrowserTabIdentity,
  fluentKeys: [`browserTab:${TAB_ID}.browser.url`, `browserTab:${TAB_ID}.browser.title`, `browserTab:${TAB_ID}.browser.readyState`],
  registeredAtSeq: 0,
  registeredAtMs: Date.now(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("browser.ready guard", () => {
  it("passes when readyState is 'complete'", () => {
    const store = makeStore();
    setReadyState(store, "complete");
    const result = evaluateGuard("browser.ready", baseLens, store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("browser.ready");
  });

  it("fails when readyState is 'loading'", () => {
    const store = makeStore();
    setReadyState(store, "loading");
    const result = evaluateGuard("browser.ready", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("browser.ready");
    expect(result.reason).toContain("loading");
    expect(result.suggestedAction).toContain("document.readyState");
  });

  it("fails when readyState is 'interactive'", () => {
    const store = makeStore();
    setReadyState(store, "interactive");
    const result = evaluateGuard("browser.ready", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("interactive");
  });

  it("fails with suggestion when browser.readyState fluent is absent", () => {
    const store = makeStore(); // no fluents set
    const result = evaluateGuard("browser.ready", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.suggestedAction).toContain("perception_read");
  });
});

describe("browser.ready guard on window lens (vacuous pass)", () => {
  it("passes vacuously — browser.ready is not applicable to window lenses", () => {
    const windowLens: PerceptionLens = {
      ...baseLens,
      spec: {
        ...baseLens.spec,
        target: { kind: "window", match: { titleIncludes: "Notepad" } },
        guards: ["browser.ready"],
      },
    };
    const store = makeStore(); // no fluents needed
    const result = evaluateGuard("browser.ready", windowLens, store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(1);
  });
});

describe("safe.keyboardTarget on browserTab lens", () => {
  it("passes when readyState is 'complete'", () => {
    const store = makeStore();
    setReadyState(store, "complete");
    const lensWithKbGuard: PerceptionLens = {
      ...baseLens,
      spec: { ...baseLens.spec, guards: ["safe.keyboardTarget"] },
    };
    const result = evaluateGuard("safe.keyboardTarget", lensWithKbGuard, store, Date.now());
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("safe.keyboardTarget");
  });

  it("fails when readyState is 'loading'", () => {
    const store = makeStore();
    setReadyState(store, "loading");
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("safe.keyboardTarget");
  });
});
