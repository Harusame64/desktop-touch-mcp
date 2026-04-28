/**
 * tests/unit/browser-launch-killexisting.test.ts
 *
 * Unit tests for the killExisting option added to browser_launch (#22).
 *
 * Section 1: killProcessesByName — spawnSync mock via node:child_process
 * Section 2: browserLaunchSchema — killExisting default and coercion
 * Section 3: browserLaunchHandler — flow assertions via vi.mock partial stubs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// ── Top-level mocks (hoisted by Vitest) ──────────────────────────────────────

// Mock node:child_process so spawnSync is controllable in section 1.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

// Mock the external dependencies that browser.ts calls, so that
// browserLaunchHandler can be exercised without real network / OS calls.
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabs: vi.fn(),
  navigateTo: vi.fn(),
  // stub out all other exports that browser.ts might use
  evaluateInTab: vi.fn(),
  getElementScreenCoords: vi.fn(),
  getDomHtml: vi.fn(),
  disconnectAll: vi.fn(),
  getTabContext: vi.fn(),
}));

vi.mock("../../src/engine/poll.js", () => ({
  pollUntil: vi.fn(),
}));

// Partial mock of launch.js: keep the real killProcessesByName (used in
// section 1), but stub out resolveWellKnownPath and spawnDetached so
// handler tests do not hit the filesystem.
vi.mock("../../src/utils/launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/launch.js")>();
  return {
    ...actual,
    resolveWellKnownPath: vi.fn(),
    spawnDetached: vi.fn(),
    // killProcessesByName is kept as the real implementation so section 1 works.
    // For section 3 we spy on it via vi.spyOn after import.
  };
});

// ── Import modules after mocks are declared ───────────────────────────────────

import * as childProcess from "node:child_process";
import * as launchModule from "../../src/utils/launch.js";
import * as cdpModule from "../../src/engine/cdp-bridge.js";
import * as pollModule from "../../src/engine/poll.js";
import { browserLaunchHandler, browserLaunchSchema } from "../../src/tools/browser.js";

// ── 1. killProcessesByName ────────────────────────────────────────────────────

describe("killProcessesByName", () => {
  beforeEach(() => {
    vi.mocked(childProcess.spawnSync).mockReset();
  });

  it("returns exe in killed list when taskkill exits 0", () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 0, pid: 1, output: [], stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0), signal: null, error: undefined,
    });

    const result = launchModule.killProcessesByName(["chrome.exe"]);
    expect(result).toEqual(["chrome.exe"]);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      "taskkill.exe", ["/F", "/IM", "chrome.exe"],
      { windowsHide: true, timeout: 5000 },
    );
  });

  it("does NOT include exe in killed when exit code is 128 (process not found)", () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 128, pid: 0, output: [], stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0), signal: null, error: undefined,
    });

    const result = launchModule.killProcessesByName(["chrome.exe"]);
    expect(result).toEqual([]);
  });

  it("does NOT include exe in killed when spawnSync throws", () => {
    vi.mocked(childProcess.spawnSync).mockImplementation(() => { throw new Error("ENOENT"); });

    const result = launchModule.killProcessesByName(["chrome.exe"]);
    expect(result).toEqual([]);
  });

  it("calls taskkill for each exe and collects only exit-0 ones", () => {
    vi.mocked(childProcess.spawnSync)
      .mockReturnValueOnce({
        status: 0, pid: 1, output: [], stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0), signal: null, error: undefined,
      })
      .mockReturnValueOnce({
        status: 128, pid: 0, output: [], stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0), signal: null, error: undefined,
      });

    const result = launchModule.killProcessesByName(["chrome.exe", "msedge.exe"]);
    expect(result).toEqual(["chrome.exe"]);
    expect(childProcess.spawnSync).toHaveBeenCalledTimes(2);
  });
});

// ── 2. browserLaunchSchema — killExisting field ───────────────────────────────

describe("browserLaunchSchema killExisting field", () => {
  it("defaults to false when not provided", () => {
    const schema = z.object(browserLaunchSchema);
    expect(schema.parse({}).killExisting).toBe(false);
  });

  it("parses boolean true correctly", () => {
    const schema = z.object(browserLaunchSchema);
    expect(schema.parse({ killExisting: true }).killExisting).toBe(true);
  });

  it('coerces string "true" to boolean true', () => {
    const schema = z.object(browserLaunchSchema);
    expect(schema.parse({ killExisting: "true" }).killExisting).toBe(true);
  });

  it('coerces string "false" to boolean false', () => {
    const schema = z.object(browserLaunchSchema);
    expect(schema.parse({ killExisting: "false" }).killExisting).toBe(false);
  });
});

// ── 3. browserLaunchHandler flow with killExisting ───────────────────────────

describe("browserLaunchHandler flow with killExisting", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const EDGE_PATH = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";

  const GOOD_TABS = [
    { id: "1", type: "page", title: "Tab", url: "about:blank", webSocketDebuggerUrl: "" },
  ];

  beforeEach(() => {
    vi.mocked(launchModule.resolveWellKnownPath).mockReturnValue({
      resolved: CHROME_PATH,
      wasResolved: true,
    });
    vi.mocked(launchModule.spawnDetached).mockResolvedValue(undefined);
    vi.mocked(cdpModule.listTabs).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(pollModule.pollUntil).mockResolvedValue({ ok: true, value: GOOD_TABS });
    killSpy = vi.spyOn(launchModule, "killProcessesByName").mockReturnValue([]);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it("does NOT call killProcessesByName when CDP is already live (alreadyRunning)", async () => {
    vi.mocked(cdpModule.listTabs).mockResolvedValue(GOOD_TABS);

    await browserLaunchHandler({
      browser: "chrome", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: true,
    });

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("calls killProcessesByName with msedge.exe when chosenKey is edge", async () => {
    vi.mocked(launchModule.resolveWellKnownPath).mockReturnValue({
      resolved: EDGE_PATH,
      wasResolved: true,
    });

    await browserLaunchHandler({
      browser: "edge", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: true,
    });

    expect(killSpy).toHaveBeenCalledWith(["msedge.exe"]);
  });

  it("calls killProcessesByName with chrome.exe when chosenKey is chrome", async () => {
    await browserLaunchHandler({
      browser: "chrome", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: true,
    });

    expect(killSpy).toHaveBeenCalledWith(["chrome.exe"]);
  });

  it("does NOT call killProcessesByName when killExisting is false", async () => {
    await browserLaunchHandler({
      browser: "chrome", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: false,
    });

    expect(killSpy).not.toHaveBeenCalled();
  });

  it("response includes killed:[] in alreadyRunning path", async () => {
    vi.mocked(cdpModule.listTabs).mockResolvedValue(GOOD_TABS);

    const result = await browserLaunchHandler({
      browser: "chrome", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: false,
    });

    const parsed = JSON.parse(
      result.content[0]?.type === "text" ? result.content[0].text : "{}",
    );
    expect(parsed.alreadyRunning).toBe(true);
    expect(parsed.killed).toEqual([]);
  });

  it("response includes killed field in new launch path", async () => {
    const result = await browserLaunchHandler({
      browser: "chrome", port: 9222, userDataDir: "C:\\tmp\\cdp",
      url: undefined, waitMs: 10000, killExisting: false,
    });

    const parsed = JSON.parse(
      result.content[0]?.type === "text" ? result.content[0].text : "{}",
    );
    expect(parsed.alreadyRunning).toBe(false);
    expect(Array.isArray(parsed.killed)).toBe(true);
  });
});
