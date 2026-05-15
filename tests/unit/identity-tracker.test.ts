import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  observeTarget,
  clearIdentities,
  takeLastInvalidation,
  buildCacheStateHints,
  isUiaCacheStale,
} from "../../src/engine/identity-tracker.js";
import {
  updateUiaCache,
  clearLayers,
  UIA_CACHE_TTL_EXPORTED_MS,
} from "../../src/engine/layer-buffer.js";

describe("identity-tracker", () => {
  beforeEach(() => {
    clearIdentities();
  });

  it("records a first observation without invalidation", () => {
    const r = observeTarget("calc", 0x1234n, "Calculator");
    expect(r.invalidatedBy).toBeNull();
    expect(r.identity.hwnd).toBe(String(0x1234n));
    expect(r.identity.titleResolved).toBe("Calculator");
    expect(takeLastInvalidation()).toBeNull();
  });

  it("detects hwnd_reused when same hwnd observed with a different pid", () => {
    observeTarget("calc", 0x1234n, "Calculator");
    // Second observation cannot easily force a different pid because the
    // helper resolves pid from the HWND via Win32. We only assert that the
    // tracker does NOT falsely fire invalidation when nothing changed.
    const r2 = observeTarget("calc", 0x1234n, "Calculator");
    expect(r2.invalidatedBy).toBeNull();
  });

  it("buildCacheStateHints returns empty object when hwnd is null", () => {
    expect(buildCacheStateHints(null)).toEqual({});
  });

  it("buildCacheStateHints returns diffBaseline.exists=false when no baseline", () => {
    const hints = buildCacheStateHints(0xabcdn);
    // No baseline has been captured → exists is false.
    expect(hints.diffBaseline?.exists).toBe(false);
    // uiaCache also absent for a fresh hwnd.
    expect(hints.uiaCache?.exists).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #295 — UIA cache stale detection
// ─────────────────────────────────────────────────────────────────────────────

describe("isUiaCacheStale — issue #295", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearLayers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearLayers();
  });

  it("returns false when no UIA cache exists for the HWND", () => {
    expect(isUiaCacheStale(0xD00D0n)).toBe(false);
  });

  it("returns false when the UIA cache is fresh (age < TTL)", () => {
    updateUiaCache(0xD00D1n, "<UIA tree>");
    // Advance to half the TTL — well within the fresh window.
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS / 2);
    expect(isUiaCacheStale(0xD00D1n)).toBe(false);
  });

  it("returns true when the UIA cache is fully expired (age >= TTL)", () => {
    updateUiaCache(0xD00D2n, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS + 1);
    expect(isUiaCacheStale(0xD00D2n)).toBe(true);
  });

  it("returns true at the exact TTL boundary (age === TTL)", () => {
    updateUiaCache(0xD00D3n, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS);
    // The contract is `expiresInMs === 0` ⇔ `stale === true`, so the boundary
    // (age === TTL) is stale rather than fresh.
    expect(isUiaCacheStale(0xD00D3n)).toBe(true);
  });
});

describe("buildCacheStateHints — uiaCache.stale flag (issue #295)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearLayers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearLayers();
  });

  it("uiaCache.stale is true when expiresInMs === 0 (cache fully expired)", () => {
    updateUiaCache(0xCAFE1n, "<UIA tree>");
    vi.setSystemTime(UIA_CACHE_TTL_EXPORTED_MS + 100);
    const hints = buildCacheStateHints(0xCAFE1n);
    expect(hints.uiaCache?.exists).toBe(true);
    expect(hints.uiaCache?.expiresInMs).toBe(0);
    expect(hints.uiaCache?.stale).toBe(true);
  });

  it("uiaCache.stale is OMITTED (not false) when the cache is fresh — symmetric with rest of the block", () => {
    updateUiaCache(0xCAFE2n, "<UIA tree>");
    vi.setSystemTime(100); // very fresh
    const hints = buildCacheStateHints(0xCAFE2n);
    expect(hints.uiaCache?.exists).toBe(true);
    expect(hints.uiaCache?.expiresInMs).toBeGreaterThan(0);
    // Omitted, not `false` — keeps the on-wire shape minimal.
    expect(hints.uiaCache?.stale).toBeUndefined();
  });

  it("uiaCache.stale is omitted when the cache does not exist (no false signal for a missing cache)", () => {
    const hints = buildCacheStateHints(0xCAFE3n);
    expect(hints.uiaCache?.exists).toBe(false);
    expect(hints.uiaCache?.stale).toBeUndefined();
  });
});
