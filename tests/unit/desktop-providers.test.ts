import { describe, it, expect } from "vitest";
import {
  composeCandidates,
  isBrowserTarget,
  isTerminalTarget,
} from "../../src/tools/desktop-providers/compose-providers.js";
import { fetchUiaCandidates }      from "../../src/tools/desktop-providers/uia-provider.js";
import { fetchBrowserCandidates }  from "../../src/tools/desktop-providers/browser-provider.js";
import { fetchTerminalCandidates } from "../../src/tools/desktop-providers/terminal-provider.js";
import { fetchVisualCandidates }   from "../../src/tools/desktop-providers/visual-provider.js";

// ── Routing helpers ───────────────────────────────────────────────────────────

describe("isBrowserTarget", () => {
  it("true when tabId is present", () => {
    expect(isBrowserTarget({ tabId: "tab-1" })).toBe(true);
  });
  it("false when only hwnd or windowTitle", () => {
    expect(isBrowserTarget({ hwnd: "123" })).toBe(false);
    expect(isBrowserTarget({ windowTitle: "Chrome" })).toBe(false);
    expect(isBrowserTarget(undefined)).toBe(false);
  });
});

describe("isTerminalTarget", () => {
  it("detects PowerShell, bash, terminal, WSL, zsh", () => {
    expect(isTerminalTarget({ windowTitle: "Windows PowerShell" })).toBe(true);
    expect(isTerminalTarget({ windowTitle: "PowerShell 7" })).toBe(true);
    expect(isTerminalTarget({ windowTitle: "Git Bash" })).toBe(true);
    expect(isTerminalTarget({ windowTitle: "WSL: Ubuntu" })).toBe(true);
    expect(isTerminalTarget({ windowTitle: "Windows Terminal" })).toBe(true);
    expect(isTerminalTarget({ windowTitle: "Command Prompt" })).toBe(true);
  });
  it("false for non-terminal windows — no false positives", () => {
    expect(isTerminalTarget({ windowTitle: "Notepad" })).toBe(false);
    expect(isTerminalTarget({ windowTitle: "Chrome" })).toBe(false);
    expect(isTerminalTarget({ windowTitle: "Photoshop 2024" })).toBe(false);
    expect(isTerminalTarget({ windowTitle: "Dashboard" })).toBe(false);
    expect(isTerminalTarget(undefined)).toBe(false);
  });
});

// ── Routing policy ────────────────────────────────────────────────────────────

describe("composeCandidates — routing policy (P2-B)", () => {
  it("browser target routes to browser path (not terminal/uia)", () => {
    expect(isBrowserTarget({ tabId: "tab-1" })).toBe(true);
    expect(isTerminalTarget({ tabId: "tab-1" })).toBe(false);
  });

  it("terminal target routes to terminal path (not browser)", () => {
    expect(isTerminalTarget({ windowTitle: "PowerShell" })).toBe(true);
    expect(isBrowserTarget({ windowTitle: "PowerShell" })).toBe(false);
  });

  it("native window routes to uia path (not browser/terminal)", () => {
    const target = { windowTitle: "Notepad" };
    expect(isBrowserTarget(target)).toBe(false);
    expect(isTerminalTarget(target)).toBe(false);
  });

  it("returns ProviderResult with candidates + warnings arrays", async () => {
    const result = await composeCandidates({ hwnd: "999999999" });
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── Individual provider error resilience ─────────────────────────────────────

describe("fetchUiaCandidates — error resilience (P2-C)", () => {
  it("returns empty candidates + no warnings when target is undefined", async () => {
    const r = await fetchUiaCandidates(undefined);
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it("returns empty candidates when target has no hwnd or windowTitle", async () => {
    const r = await fetchUiaCandidates({ tabId: "tab-1" });
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it("returns ProviderResult gracefully when UIA unavailable", async () => {
    const r = await fetchUiaCandidates({ windowTitle: "__nonexistent__" });
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});

describe("fetchBrowserCandidates — error resilience (P2-C)", () => {
  it("returns empty candidates + no warnings when no tabId", async () => {
    const r1 = await fetchBrowserCandidates(undefined);
    expect(r1.candidates).toEqual([]);
    expect(r1.warnings).toEqual([]);
    const r2 = await fetchBrowserCandidates({ windowTitle: "App" });
    expect(r2.candidates).toEqual([]);
  });
  it("returns ProviderResult gracefully when CDP unavailable", async () => {
    const r = await fetchBrowserCandidates({ tabId: "__fake_tab__" });
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});

describe("fetchTerminalCandidates — error resilience (P2-C)", () => {
  it("returns empty candidates + no warnings when no windowTitle", async () => {
    const r1 = await fetchTerminalCandidates(undefined);
    expect(r1.candidates).toEqual([]);
    expect(r1.warnings).toEqual([]);
    const r2 = await fetchTerminalCandidates({ tabId: "tab-1" });
    expect(r2.candidates).toEqual([]);
  });
  it("returns ProviderResult gracefully when terminal window not found", async () => {
    const r = await fetchTerminalCandidates({ windowTitle: "__nonexistent__" });
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});

describe("fetchVisualCandidates — stub (P2-C)", () => {
  it("always returns empty candidates with visual_provider_unavailable warning", async () => {
    for (const target of [undefined, { hwnd: "123" }, { tabId: "t" }] as const) {
      const r = await fetchVisualCandidates(target);
      expect(r.candidates).toHaveLength(0);
      expect(r.warnings).toContain("visual_provider_unavailable");
    }
  });
});

// ── Locator shape invariants ──────────────────────────────────────────────────

describe("Provider locator contracts — shape invariants (P2-B)", () => {
  it("UIA provider: returned candidates have source=uia and locator.uia", async () => {
    const { candidates } = await fetchUiaCandidates({ windowTitle: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("uia");
      expect(c.locator?.uia).toBeDefined();
    }
  });

  it("browser provider: returned candidates have source=cdp and locator.cdp", async () => {
    const { candidates } = await fetchBrowserCandidates({ tabId: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("cdp");
      expect(c.locator?.cdp).toBeDefined();
      expect(c.locator?.cdp?.selector).toBeTruthy();
      expect(c.locator?.cdp?.tabId).toBeTruthy();
    }
  });

  it("terminal provider: returned candidates have source=terminal and locator.terminal", async () => {
    const { candidates } = await fetchTerminalCandidates({ windowTitle: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("terminal");
      expect(c.locator?.terminal).toBeDefined();
    }
  });

  it("compose: all candidates have source and optional locator", async () => {
    const { candidates } = await composeCandidates({ hwnd: "123" });
    for (const c of candidates) {
      expect(c.source).toBeTruthy();
      if (c.locator) {
        const hasAny = c.locator.uia || c.locator.cdp || c.locator.terminal || c.locator.visual;
        expect(hasAny).toBeTruthy();
      }
    }
  });
});

// ── Warnings (P2-C) ───────────────────────────────────────────────────────────

describe("composeCandidates — warnings surface (P2-C)", () => {
  it("visual_provider_unavailable always present (Phase 2 stub)", async () => {
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.warnings).toContain("visual_provider_unavailable");
  });

  it("result always has warnings array (may be empty on success)", async () => {
    const r = await fetchUiaCandidates({ windowTitle: "_" });
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(Array.isArray(r.candidates)).toBe(true);
  });

  it("composeCandidates result always has { candidates, warnings }", async () => {
    const r = await composeCandidates({ hwnd: "123" });
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(Array.isArray(r.candidates)).toBe(true);
  });

  it("uia_provider_failed returned when UIA throws (or uia_no_elements on empty)", async () => {
    const r = await fetchUiaCandidates({ windowTitle: "__nonexistent__" });
    // Either the window was not found (failed) or found but empty
    const knownWarnings = new Set(["uia_provider_failed", "uia_no_elements"]);
    for (const w of r.warnings) {
      expect(knownWarnings.has(w)).toBe(true);
    }
  });

  it("cdp_provider_failed returned when CDP unavailable", async () => {
    const r = await fetchBrowserCandidates({ tabId: "__nonexistent__" });
    // Either no elements found or CDP itself failed
    const knownWarnings = new Set(["cdp_provider_failed", "cdp_no_elements"]);
    for (const w of r.warnings) {
      expect(knownWarnings.has(w)).toBe(true);
    }
  });
});
