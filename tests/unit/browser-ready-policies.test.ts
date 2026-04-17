/**
 * tests/unit/browser-ready-policies.test.ts
 *
 * Phase F — browser readiness action-sensitive policies (v3 §4.2, §12.3).
 * Verifies the 3 policies:
 *   "strict"             — blocks on readyState !== "complete"
 *   "selectorInViewport" — pass-with-note when inViewport + readyState !== "complete"
 *   "navigationGate"     — pass-with-note when readyState === "interactive"
 */

import { describe, it, expect } from "vitest";
import { evaluateGuard } from "../../src/engine/perception/guards.js";
import type { GuardContext } from "../../src/engine/perception/guards.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { PerceptionLens, GuardResult } from "../../src/engine/perception/types.js";

// Helper: build a minimal browserTab lens stub
function makeBrowserLens(hwnd = "tab-123"): PerceptionLens {
  return {
    lensId: "lens-1",
    spec: {
      name: "test",
      target: { kind: "browserTab" as const, match: { tabId: hwnd } },
      maintain: [],
      guards: ["browser.ready"] as never[],
      guardPolicy: "block" as const,
      maxEnvelopeTokens: 0,
      salience: "normal" as const,
    },
    binding: { hwnd, windowTitle: "Test" },
    boundIdentity: { tabId: hwnd, title: "Test", url: "https://example.com", port: 9222 },
    fluentKeys: [`browserTab:${hwnd}.browser.readyState`],
    registeredAtSeq: 0,
    registeredAtMs: 0,
  } as unknown as PerceptionLens;
}

// Helper: build FluentStore with a readyState fluent
function makeStoreWithReadyState(hwnd: string, readyState: string): FluentStore {
  const store = new FluentStore();
  store.apply([{
    seq: 1, tsMs: Date.now(), source: "cdp" as const,
    entity: { kind: "browserTab" as const, id: hwnd },
    property: "browser.readyState",
    value: readyState,
    confidence: 1,
    evidence: { source: "cdp" as const, observedAtSeq: 1, observedAtMs: Date.now(), cost: "cheap" as const },
  }]);
  return store;
}

function evalBrowserReady(hwnd: string, readyState: string, ctx: GuardContext): GuardResult {
  const lens  = makeBrowserLens(hwnd);
  const store = makeStoreWithReadyState(hwnd, readyState);
  return evaluateGuard("browser.ready", lens, store, Date.now(), ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// strict policy (default)
// ─────────────────────────────────────────────────────────────────────────────

describe("strict policy (default, browser_eval)", () => {
  it("passes when readyState=complete", () => {
    const r = evalBrowserReady("tab-1", "complete", { browserReadinessPolicy: "strict" });
    expect(r.ok).toBe(true);
  });

  it("blocks when readyState=interactive", () => {
    const r = evalBrowserReady("tab-1", "interactive", { browserReadinessPolicy: "strict" });
    expect(r.ok).toBe(false);
  });

  it("blocks when readyState=loading", () => {
    const r = evalBrowserReady("tab-1", "loading", { browserReadinessPolicy: "strict" });
    expect(r.ok).toBe(false);
  });

  it("blocks when no policy specified (undefined = strict)", () => {
    const r = evalBrowserReady("tab-1", "interactive", {});
    expect(r.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectorInViewport policy (browser_click_element)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectorInViewport policy (browser_click_element)", () => {
  it("passes with note when readyState=interactive and inViewport=true", () => {
    const r = evalBrowserReady("tab-2", "interactive", {
      browserReadinessPolicy: "selectorInViewport",
      browserSelectorInViewport: true,
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("warn");
    expect(r.note).toContain("interactive");
  });

  it("passes with note when readyState=loading and inViewport=true", () => {
    const r = evalBrowserReady("tab-2", "loading", {
      browserReadinessPolicy: "selectorInViewport",
      browserSelectorInViewport: true,
    });
    expect(r.ok).toBe(true);
    expect(r.note).toBeTruthy();
  });

  it("blocks when readyState=interactive and inViewport=false", () => {
    const r = evalBrowserReady("tab-2", "interactive", {
      browserReadinessPolicy: "selectorInViewport",
      browserSelectorInViewport: false,
    });
    expect(r.ok).toBe(false);
  });

  it("blocks when readyState=interactive and inViewport=undefined", () => {
    const r = evalBrowserReady("tab-2", "interactive", {
      browserReadinessPolicy: "selectorInViewport",
    });
    expect(r.ok).toBe(false);
  });

  it("still passes when readyState=complete (regardless of inViewport)", () => {
    const r = evalBrowserReady("tab-2", "complete", {
      browserReadinessPolicy: "selectorInViewport",
      browserSelectorInViewport: false,
    });
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// navigationGate policy (browser_navigate)
// ─────────────────────────────────────────────────────────────────────────────

describe("navigationGate policy (browser_navigate)", () => {
  it("passes with note when readyState=interactive", () => {
    const r = evalBrowserReady("tab-3", "interactive", {
      browserReadinessPolicy: "navigationGate",
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("interactive");
  });

  it("blocks when readyState=loading", () => {
    const r = evalBrowserReady("tab-3", "loading", {
      browserReadinessPolicy: "navigationGate",
    });
    expect(r.ok).toBe(false);
  });

  it("passes when readyState=complete", () => {
    const r = evalBrowserReady("tab-3", "complete", {
      browserReadinessPolicy: "navigationGate",
    });
    expect(r.ok).toBe(true);
    expect(r.note).toBeUndefined();
  });
});
