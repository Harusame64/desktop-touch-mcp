/**
 * tests/unit/browser-tab-lens.test.ts
 *
 * Tests for browserTab lens binding resolution and CDP sensor fluent population.
 * CDP, event-bus are mocked so tests run without a running browser.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock impure dependencies ─────────────────────────────────────────────────

vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabsLight: vi.fn(),
  getTabContext: vi.fn(),
  DEFAULT_CDP_PORT: 9222,
}));

vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub-1"),
  unsubscribe: vi.fn(),
  poll: vi.fn().mockReturnValue([]),
}));

import * as cdpBridge from "../../src/engine/cdp-bridge.js";
import {
  resolveBrowserTabBindingFromTabs,
  buildBrowserTabIdentity,
  fluentKeyForEntity,
} from "../../src/engine/perception/lens.js";
import { refreshCdpFluents } from "../../src/engine/perception/sensors-cdp.js";
import type { LensSpec } from "../../src/engine/perception/types.js";

// ── Tests: resolveBrowserTabBindingFromTabs ──────────────────────────────────

describe("resolveBrowserTabBindingFromTabs", () => {
  const tabs = [
    { id: "tab-1", title: "Google", url: "https://www.google.com/" },
    { id: "tab-2", title: "Example Domain", url: "https://example.com/path" },
    { id: "tab-3", title: "GitHub", url: "https://github.com/user/repo" },
  ];

  it("resolves by urlIncludes (case-insensitive)", () => {
    const spec: LensSpec = {
      name: "test",
      target: { kind: "browserTab", match: { urlIncludes: "example.com" } },
      maintain: [],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    };
    const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
    expect(binding).not.toBeNull();
    expect(binding!.hwnd).toBe("tab-2");
    expect(binding!.windowTitle).toBe("Example Domain");
  });

  it("resolves by titleIncludes (case-insensitive)", () => {
    const spec: LensSpec = {
      name: "test",
      target: { kind: "browserTab", match: { titleIncludes: "github" } },
      maintain: [],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    };
    const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
    expect(binding).not.toBeNull();
    expect(binding!.hwnd).toBe("tab-3");
  });

  it("returns null when no tab matches", () => {
    const spec: LensSpec = {
      name: "test",
      target: { kind: "browserTab", match: { urlIncludes: "nonexistent.xyz" } },
      maintain: [],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    };
    const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
    expect(binding).toBeNull();
  });

  it("returns null for window-kind spec", () => {
    const spec: LensSpec = {
      name: "test",
      target: { kind: "window", match: { titleIncludes: "Notepad" } },
      maintain: [],
      guards: [],
      guardPolicy: "block",
      maxEnvelopeTokens: 120,
      salience: "normal",
    };
    const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
    expect(binding).toBeNull();
  });
});

// ── Tests: buildBrowserTabIdentity ────────────────────────────────────────────

describe("buildBrowserTabIdentity", () => {
  it("builds identity with correct fields", () => {
    const identity = buildBrowserTabIdentity("tab-99", "My Page", "https://test.local/", 9222);
    expect(identity.tabId).toBe("tab-99");
    expect(identity.title).toBe("My Page");
    expect(identity.url).toBe("https://test.local/");
    expect(identity.port).toBe(9222);
  });
});

// ── Tests: refreshCdpFluents ──────────────────────────────────────────────────

describe("refreshCdpFluents", () => {
  it("emits browser.url/title/readyState observations on success", async () => {
    vi.mocked(cdpBridge.getTabContext).mockResolvedValueOnce({
      id: "tab-1",
      title: "Test Page",
      url: "https://test.com/",
      readyState: "complete",
    });

    const obs = await refreshCdpFluents("tab-1", 9222);
    expect(obs).toHaveLength(3);
    const props = obs.map(o => o.property);
    expect(props).toContain("browser.url");
    expect(props).toContain("browser.title");
    expect(props).toContain("browser.readyState");

    const urlObs = obs.find(o => o.property === "browser.url")!;
    expect(urlObs.value).toBe("https://test.com/");
    expect(urlObs.entity).toEqual({ kind: "browserTab", id: "tab-1" });
    expect(urlObs.confidence).toBeGreaterThan(0.9);
  });

  it("emits null low-confidence observations when CDP returns null id", async () => {
    vi.mocked(cdpBridge.getTabContext).mockResolvedValueOnce({
      id: null,
      title: "",
      url: "",
      readyState: "loading",
    });

    const obs = await refreshCdpFluents("tab-closed", 9222);
    expect(obs).toHaveLength(3);
    expect(obs[0]!.value).toBeNull();
    expect(obs[0]!.confidence).toBe(0.30);
  });

  it("emits null low-confidence observations when CDP throws", async () => {
    vi.mocked(cdpBridge.getTabContext).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const obs = await refreshCdpFluents("tab-x", 9222);
    expect(obs).toHaveLength(3);
    expect(obs[0]!.value).toBeNull();
    expect(obs[0]!.confidence).toBe(0.30);
  });
});

// ── Tests: fluentKeyForEntity browserTab format ───────────────────────────────

describe("fluentKeyForEntity browserTab prefix", () => {
  it("produces browserTab:<id>.<property> format", () => {
    const key = fluentKeyForEntity({ kind: "browserTab", id: "tab-abc" }, "browser.readyState");
    expect(key).toBe("browserTab:tab-abc.browser.readyState");
  });
});
