/**
 * tests/unit/lens-matcher.test.ts
 * Unit tests for lens compilation, binding resolution, and fluent key expansion.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  compileLens,
  resolveBindingFromSnapshot,
  expandFluentKeys,
  fluentKeyFor,
  resetLensCounter,
  type WindowSnapshot,
} from "../../src/engine/perception/lens.js";
import type { LensSpec, WindowIdentity } from "../../src/engine/perception/types.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

const baseSpec: LensSpec = {
  name: "test-lens",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget"],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

const baseIdentity: WindowIdentity = {
  hwnd: "100",
  pid: 1234,
  processName: "notepad.exe",
  processStartTimeMs: 1700000000000,
  titleResolved: "Untitled - Notepad",
};

const windows: WindowSnapshot[] = [
  { hwnd: "100", title: "Untitled - Notepad", zOrder: 0, isActive: true, pid: 1234 },
  { hwnd: "200", title: "Chrome", zOrder: 1, isActive: false },
  { hwnd: "300", title: "Another Notepad window", zOrder: 2, isActive: false },
];

beforeEach(() => {
  resetLensCounter();
});

describe("resolveBindingFromSnapshot", () => {
  it("matches foreground window when title includes needle", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows);
    expect(binding).not.toBeNull();
    expect(binding!.hwnd).toBe("100");
  });

  it("is case-insensitive", () => {
    const spec: LensSpec = { ...baseSpec, target: { kind: "window", match: { titleIncludes: "notepad" } } };
    const binding = resolveBindingFromSnapshot(spec, windows);
    expect(binding).not.toBeNull();
    expect(binding!.hwnd).toBe("100");
  });

  it("prefers foreground over lower-zOrder background window", () => {
    const winsFgHighZ: WindowSnapshot[] = [
      { hwnd: "100", title: "Untitled - Notepad", zOrder: 5, isActive: true },
      { hwnd: "300", title: "Another Notepad window", zOrder: 1, isActive: false },
    ];
    const binding = resolveBindingFromSnapshot(baseSpec, winsFgHighZ);
    expect(binding!.hwnd).toBe("100"); // foreground wins even with higher zOrder
  });

  it("falls back to lowest-zOrder when no foreground matches", () => {
    const noFgWins: WindowSnapshot[] = [
      { hwnd: "300", title: "Another Notepad window", zOrder: 2, isActive: false },
      { hwnd: "100", title: "Untitled - Notepad", zOrder: 0, isActive: false },
    ];
    const binding = resolveBindingFromSnapshot(baseSpec, noFgWins);
    expect(binding!.hwnd).toBe("100"); // lowest zOrder
  });

  it("returns null when no window matches", () => {
    const spec: LensSpec = { ...baseSpec, target: { kind: "window", match: { titleIncludes: "NonExistent" } } };
    const binding = resolveBindingFromSnapshot(spec, windows);
    expect(binding).toBeNull();
  });

  it("returns null for empty window list", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, []);
    expect(binding).toBeNull();
  });
});

describe("compileLens", () => {
  it("produces a lens with the expected lensId pattern", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows)!;
    const lens = compileLens(baseSpec, binding, baseIdentity, 1);
    expect(lens.lensId).toMatch(/^perc-\d+$/);
  });

  it("uses injected seed when provided", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows)!;
    const lens = compileLens(baseSpec, binding, baseIdentity, 1, () => "fixed-id");
    expect(lens.lensId).toBe("fixed-id");
  });

  it("populates fluentKeys from maintain list", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows)!;
    const lens = compileLens(baseSpec, binding, baseIdentity, 1);
    expect(lens.fluentKeys).toHaveLength(FLUENT_KINDS.length);
    expect(lens.fluentKeys).toContain(`window:${binding.hwnd}.target.title`);
  });

  it("stores boundIdentity correctly", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows)!;
    const lens = compileLens(baseSpec, binding, baseIdentity, 5);
    expect(lens.boundIdentity.pid).toBe(1234);
    expect(lens.boundIdentity.processStartTimeMs).toBe(1700000000000);
  });

  it("stores registeredAtSeq", () => {
    const binding = resolveBindingFromSnapshot(baseSpec, windows)!;
    const lens = compileLens(baseSpec, binding, baseIdentity, 42);
    expect(lens.registeredAtSeq).toBe(42);
  });
});

describe("fluentKeyFor", () => {
  it("formats key as window:<hwnd>.<property>", () => {
    expect(fluentKeyFor("100", "target.title")).toBe("window:100.target.title");
    expect(fluentKeyFor("999", "modal.above")).toBe("window:999.modal.above");
  });
});

describe("expandFluentKeys", () => {
  it("expands maintain list to concrete keys", () => {
    const lens = {
      spec: { ...baseSpec, maintain: ["target.title", "target.rect"] as LensSpec["maintain"] },
      binding: { hwnd: "100", windowTitle: "Untitled - Notepad" },
    };
    const keys = expandFluentKeys(lens);
    expect(keys).toEqual(["window:100.target.title", "window:100.target.rect"]);
  });

  it("returns empty array for empty maintain list", () => {
    const lens = {
      spec: { ...baseSpec, maintain: [] as LensSpec["maintain"] },
      binding: { hwnd: "100", windowTitle: "Test" },
    };
    expect(expandFluentKeys(lens)).toHaveLength(0);
  });
});
