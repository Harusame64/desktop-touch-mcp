/**
 * tests/unit/uia-focused-guard.test.ts
 *
 * Tests for the additive focused-element gate in safe.keyboardTarget.
 * The gate must be backward-compatible: absent fluent must pass the guard
 * for normal/background lenses that never populate target.focusedElement.
 */

import { describe, it, expect } from "vitest";
import { evaluateGuard } from "../../src/engine/perception/guards.js";
import { FluentStore } from "../../src/engine/perception/fluent-store.js";
import type { PerceptionLens, LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";
import { makeEvidence } from "../../src/engine/perception/evidence.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const HWND = "9999";

function makeStore(): FluentStore {
  const s = new FluentStore();
  s.__resetForTests();
  return s;
}

function setFluent(store: FluentStore, property: string, value: unknown, confidence = 0.98) {
  const nowMs = Date.now();
  const seq = 1;
  store.apply([{
    seq,
    tsMs: nowMs,
    source: "win32",
    entity: { kind: "window", id: HWND },
    property,
    value,
    confidence,
    evidence: makeEvidence("win32", seq, nowMs),
  }]);
}

function setUiaFluent(store: FluentStore, value: unknown, confidence = 0.92) {
  const nowMs = Date.now();
  const seq = 2;
  store.apply([{
    seq,
    tsMs: nowMs,
    source: "uia",
    entity: { kind: "window", id: HWND },
    property: "target.focusedElement",
    value,
    confidence,
    evidence: makeEvidence("uia", seq, nowMs),
  }]);
}

const baseLens: PerceptionLens = {
  lensId: "perc-1",
  spec: {
    name: "test",
    target: { kind: "window", match: { titleIncludes: "Notepad" } },
    maintain: [...FLUENT_KINDS],
    guards: ["safe.keyboardTarget"],
    guardPolicy: "block",
    maxEnvelopeTokens: 120,
    salience: "critical",
  } satisfies LensSpec,
  binding: { hwnd: HWND, windowTitle: "Untitled - Notepad" },
  boundIdentity: {
    hwnd: HWND,
    pid: 1234,
    processName: "notepad.exe",
    processStartTimeMs: 1700000000000,
    titleResolved: "Untitled - Notepad",
  } satisfies WindowIdentity,
  fluentKeys: FLUENT_KINDS.map(k => `window:${HWND}.${k}`),
  registeredAtSeq: 0,
  registeredAtMs: Date.now(),
};

/** Set up the minimum Win32 fluents so foreground + identity checks pass. */
function setupPassingFluents(store: FluentStore) {
  setFluent(store, "target.foreground", true, 0.98);
  setFluent(store, "target.identity", {
    pid: 1234,
    processName: "notepad.exe",
    processStartTimeMs: 1700000000000,
    hwnd: HWND,
    titleResolved: "Untitled - Notepad",
  }, 0.98);
  setFluent(store, "modal.above", false, 0.95);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("safe.keyboardTarget focused-element gate", () => {
  it("passes when target.focusedElement fluent is absent (backward-compat, normal lens)", () => {
    const store = makeStore();
    setupPassingFluents(store);
    // No UIA fluent set — normal/background lens behavior
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("passes when focused element has an editable controlType (Edit)", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Content", controlType: "Edit", automationId: "" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("passes when focused element has ComboBox controlType", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Dropdown", controlType: "ComboBox" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("fails when focused element is a read-only Text control", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Label", controlType: "Text" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("safe.keyboardTarget");
    expect(result.reason).toContain("read-only Text");
    expect(result.suggestedAction).toContain("editable control");
  });

  it("fails when focused element is a TitleBar", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Window Title", controlType: "TitleBar" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("TitleBar");
  });

  it("fails when focused element is an Image", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Logo", controlType: "Image" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
  });

  it("fails when focused element is a ToolBar", () => {
    const store = makeStore();
    setupPassingFluents(store);
    setUiaFluent(store, { name: "Actions", controlType: "ToolBar" });
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
  });

  it("passes when focused element value is null (no focused element found)", () => {
    const store = makeStore();
    setupPassingFluents(store);
    // Null value = no element focused (common when app is in background briefly)
    setUiaFluent(store, null, 0.40);
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(true);
  });

  it("focused-element check carries the UIA confidence in the guard result", () => {
    const store = makeStore();
    setupPassingFluents(store);
    // Pass 0.88 as the observation confidence — readValue returns BASE_CONFIDENCE["uia"]=0.90
    // for fresh evidence because confidenceFor(evidence, nowMs) is source-based, not per-observation.
    setUiaFluent(store, { name: "Status", controlType: "StatusBar" }, 0.88);
    const result = evaluateGuard("safe.keyboardTarget", baseLens, store, Date.now());
    expect(result.ok).toBe(false);
    expect(result.confidence).toBeCloseTo(0.90, 2);
  });
});
