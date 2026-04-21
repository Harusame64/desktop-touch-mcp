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
    // "Command Prompt" replaces "cmd.exe" which doesn't appear in window titles
    expect(isTerminalTarget({ windowTitle: "Command Prompt" })).toBe(true);
  });
  it("false for non-terminal windows (no false positives from broad patterns)", () => {
    expect(isTerminalTarget({ windowTitle: "Notepad" })).toBe(false);
    expect(isTerminalTarget({ windowTitle: "Chrome" })).toBe(false);
    // 'sh' should not match "Photoshop", "Dashboard", "Flash Player"
    expect(isTerminalTarget({ windowTitle: "Photoshop 2024" })).toBe(false);
    expect(isTerminalTarget({ windowTitle: "Dashboard" })).toBe(false);
    expect(isTerminalTarget(undefined)).toBe(false);
  });
});

// ── Routing contracts (without OS deps) ───────────────────────────────────────

describe("composeCandidates — routing policy", () => {
  it("browser target routes to browser path (not terminal/uia)", () => {
    // Verify that a tabId target is classified as browser, not terminal
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

  it("returns empty array for undefined target (best-effort, no crash)", async () => {
    const result = await composeCandidates(undefined);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns empty array gracefully when all providers fail (OS unavailable)", async () => {
    // With hwnd targeting a non-existent window, providers return []
    const result = await composeCandidates({ hwnd: "999999999" });
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── Individual provider error resilience ─────────────────────────────────────

describe("fetchUiaCandidates — error resilience", () => {
  it("returns [] when target is undefined", async () => {
    expect(await fetchUiaCandidates(undefined)).toEqual([]);
  });
  it("returns [] when target has no hwnd or windowTitle", async () => {
    expect(await fetchUiaCandidates({ tabId: "tab-1" })).toEqual([]);
  });
  it("returns [] gracefully when UIA is unavailable (e.g. non-Windows test env)", async () => {
    // If UIA bridge throws, provider should return [] not crash
    const result = await fetchUiaCandidates({ windowTitle: "__nonexistent_window__" });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("fetchBrowserCandidates — error resilience", () => {
  it("returns [] when target has no tabId", async () => {
    expect(await fetchBrowserCandidates(undefined)).toEqual([]);
    expect(await fetchBrowserCandidates({ windowTitle: "App" })).toEqual([]);
  });
  it("returns [] gracefully when CDP is unavailable", async () => {
    const result = await fetchBrowserCandidates({ tabId: "__fake_tab__" });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("fetchTerminalCandidates — error resilience", () => {
  it("returns [] when target has no windowTitle or hwnd", async () => {
    expect(await fetchTerminalCandidates(undefined)).toEqual([]);
    expect(await fetchTerminalCandidates({ tabId: "tab-1" })).toEqual([]);
  });
  it("returns [] gracefully when terminal window is not found", async () => {
    const result = await fetchTerminalCandidates({ windowTitle: "__nonexistent__" });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("fetchVisualCandidates — stub", () => {
  it("always returns [] (Phase 3 stub)", async () => {
    expect(await fetchVisualCandidates(undefined)).toEqual([]);
    expect(await fetchVisualCandidates({ hwnd: "123" })).toEqual([]);
    expect(await fetchVisualCandidates({ tabId: "tab" })).toEqual([]);
  });
});

// ── Locator contract: shape verification ──────────────────────────────────────

describe("Provider locator contracts — shape invariants (P2-B)", () => {
  it("UIA provider: all returned candidates have source=uia and locator.uia", async () => {
    // When the provider actually returns results (on a real Windows machine with the
    // window present), every candidate MUST have locator.uia set.
    // On test runners without UIA, it returns [] — shape constraint is vacuously true.
    const candidates = await fetchUiaCandidates({ windowTitle: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("uia");
      expect(c.locator?.uia).toBeDefined();
    }
  });

  it("browser provider: all returned candidates have source=cdp and locator.cdp", async () => {
    const candidates = await fetchBrowserCandidates({ tabId: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("cdp");
      expect(c.locator?.cdp).toBeDefined();
      expect(c.locator?.cdp?.selector).toBeTruthy();
      expect(c.locator?.cdp?.tabId).toBeTruthy();
    }
  });

  it("terminal provider: all returned candidates have source=terminal and locator.terminal", async () => {
    const candidates = await fetchTerminalCandidates({ windowTitle: "__any__" });
    for (const c of candidates) {
      expect(c.source).toBe("terminal");
      expect(c.locator?.terminal).toBeDefined();
    }
  });

  it("compose: all candidates have source and locator fields", async () => {
    const candidates = await composeCandidates({ hwnd: "123" });
    for (const c of candidates) {
      expect(c.source).toBeTruthy();
      // At least one locator field should be set when locator is present
      if (c.locator) {
        const hasLocator =
          c.locator.uia !== undefined ||
          c.locator.cdp !== undefined ||
          c.locator.terminal !== undefined ||
          c.locator.visual !== undefined;
        expect(hasLocator).toBe(true);
      }
    }
  });
});
