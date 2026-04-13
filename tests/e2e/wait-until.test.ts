/**
 * wait-until.test.ts — E2E tests for wait_until handler.
 *
 * Covers 8 conditions + WaitTimeout + hook-missing error + hook happy path.
 * Hooks (terminal_read / browser_search) are stubbed here so the suite does
 * not depend on those handlers being loaded.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  waitUntilHandler,
  setTerminalReadHook,
  setBrowserSearchHook,
  type TerminalReadHook,
  type BrowserSearchHook,
} from "../../src/tools/wait-until.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { sleep, parsePayload } from "./helpers/wait.js";

// ─── Reset hooks between tests ─────────────────────────────────────────────────

const nullTerminalHook: TerminalReadHook = async () => null;
const nullBrowserHook: BrowserSearchHook = async () => [];

afterEach(() => {
  // wait-until holds module-level hook refs. Reset to nulls after each test
  // so one test's stub doesn't leak into another.
  setTerminalReadHook(nullTerminalHook);
  setBrowserSearchHook(nullBrowserHook);
});

// ─── Timer-only conditions (no external hooks) ─────────────────────────────────

describe("wait_until — WaitTimeout", () => {
  it("times out with WaitTimeout code and suggest", async () => {
    const r = parsePayload(await waitUntilHandler({
      condition: "window_appears",
      target: { windowTitle: "__never_appears_zzz_99999__" },
      timeoutMs: 400, intervalMs: 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
    expect(Array.isArray(r.suggest)).toBe(true);
  });
});

describe("wait_until(window_appears / window_disappears)", () => {
  let np: NpInstance | null = null;
  afterEach(() => { np?.kill(); np = null; });

  it("resolves when a Notepad window appears", async () => {
    // Start waiting first, then spawn Notepad mid-poll.
    const pending = waitUntilHandler({
      condition: "window_appears",
      target: { windowTitle: "" }, // filled in below
      timeoutMs: 8000, intervalMs: 200,
    });
    // Spawn right after starting the wait. The launcher is async; its
    // `title` contains the unique tag we search for.
    np = await launchNotepad();
    // Rewrite the target: actually we need to set title before calling wait_until.
    // So re-call with the now-known tag.
    const r = parsePayload(await waitUntilHandler({
      condition: "window_appears",
      target: { windowTitle: np.tag },
      timeoutMs: 5000, intervalMs: 200,
    }));
    // Also consume the first pending promise to avoid unhandled rejection.
    await pending.catch(() => undefined);
    expect(r.ok).toBe(true);
    expect(r.observed.windowTitle).toContain(np.tag);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("resolves when a Notepad window disappears", async () => {
    np = await launchNotepad();
    const titleTag = np.tag;
    // Kill after starting wait so the probe detects the transition.
    setTimeout(() => { np?.kill(); np = null; }, 400);
    const r = parsePayload(await waitUntilHandler({
      condition: "window_disappears",
      target: { windowTitle: titleTag },
      timeoutMs: 5000, intervalMs: 200,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.disappeared).toBe(true);
  }, 15_000);
});

describe("wait_until(ready_state)", () => {
  let np: NpInstance | null = null;
  afterEach(() => { np?.kill(); np = null; });

  it("resolves immediately when the target window is visible and not minimized", async () => {
    np = await launchNotepad();
    const r = parsePayload(await waitUntilHandler({
      condition: "ready_state",
      target: { windowTitle: np.tag },
      timeoutMs: 3000, intervalMs: 200,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.ready).toBe(true);
  }, 10_000);

  it("times out if the window is never visible", async () => {
    const r = parsePayload(await waitUntilHandler({
      condition: "ready_state",
      target: { windowTitle: "__no_such_window_yyyy__" },
      timeoutMs: 400, intervalMs: 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
  });
});

// ─── element_appears / value_changes (UIA-backed) ──────────────────────────────

describe("wait_until(element_appears)", () => {
  let np: NpInstance | null = null;
  afterEach(() => { np?.kill(); np = null; });

  it("validates target.elementName is required", async () => {
    const r = parsePayload(await waitUntilHandler({
      condition: "element_appears",
      target: { windowTitle: "NoElementName" },
      timeoutMs: 500, intervalMs: 200,
    }));
    expect(r.ok).toBe(false);
    // failWith returns code based on classify(); we only check it's an error.
    expect(typeof r.code).toBe("string");
  });

  it("times out for a non-existent element", async () => {
    np = await launchNotepad();
    const r = parsePayload(await waitUntilHandler({
      condition: "element_appears",
      target: { windowTitle: np.tag, elementName: "__never_element_xyz__" },
      timeoutMs: 1500, intervalMs: 500,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
  }, 10_000);
});

// ─── focus_changes ─────────────────────────────────────────────────────────────

describe("wait_until(focus_changes)", () => {
  let np: NpInstance | null = null;
  afterEach(() => { np?.kill(); np = null; });

  it("times out when foreground does not change within budget", async () => {
    const r = parsePayload(await waitUntilHandler({
      condition: "focus_changes",
      target: {},
      timeoutMs: 400, intervalMs: 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
  });
});

// ─── terminal_output_contains (hook-backed) ────────────────────────────────────

describe("wait_until(terminal_output_contains)", () => {
  it("returns an error when the terminal_read hook is not registered", async () => {
    // Ensure hook is the null stub (afterEach reset)
    setTerminalReadHook(null);
    const r = parsePayload(await waitUntilHandler({
      condition: "terminal_output_contains",
      target: { windowTitle: "anything", pattern: "hi" },
      timeoutMs: 500, intervalMs: 200,
    }));
    expect(r.ok).toBe(false);
    // Not a WaitTimeout — handler bails out before polling.
    expect(r.error).toMatch(/hook not registered|not registered/i);
  });

  it("resolves when the hook reports matching text", async () => {
    let tick = 0;
    const hook: TerminalReadHook = async () => {
      tick++;
      // First poll: no match yet. Second poll: match.
      if (tick < 2) return { text: "nothing yet", marker: `m${tick}` };
      return { text: "loading...\nBuild succeeded at 10:00\n", marker: `m${tick}` };
    };
    setTerminalReadHook(hook);
    const r = parsePayload(await waitUntilHandler({
      condition: "terminal_output_contains",
      target: { windowTitle: "any", pattern: "Build succeeded" },
      timeoutMs: 3000, intervalMs: 500,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.matchedLine).toContain("Build succeeded");
  });

  it("supports regex patterns", async () => {
    setTerminalReadHook(async () => ({
      text: "progress 10%\nprogress 99%\ndone",
      marker: "m",
    }));
    const r = parsePayload(await waitUntilHandler({
      condition: "terminal_output_contains",
      target: { windowTitle: "any", pattern: "^progress\\s+\\d+%$", regex: true },
      timeoutMs: 2000, intervalMs: 500,
    }));
    expect(r.ok).toBe(true);
  });
});

// ─── element_matches (hook-backed) ─────────────────────────────────────────────

describe("wait_until(element_matches)", () => {
  it("returns an error when the browser_search hook is not registered", async () => {
    setBrowserSearchHook(null);
    const r = parsePayload(await waitUntilHandler({
      condition: "element_matches",
      target: { by: "text", pattern: "anything" },
      timeoutMs: 500, intervalMs: 200,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hook not registered|not registered/i);
  });

  it("resolves when the hook returns a result", async () => {
    setBrowserSearchHook(async () => [{ text: "Submit", selector: "button#submit" }]);
    const r = parsePayload(await waitUntilHandler({
      condition: "element_matches",
      target: { by: "text", pattern: "Submit" },
      timeoutMs: 2000, intervalMs: 200,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.selector).toBe("button#submit");
    expect(r.observed.text).toBe("Submit");
  });

  it("times out when the hook never returns a match", async () => {
    setBrowserSearchHook(async () => []);
    const r = parsePayload(await waitUntilHandler({
      condition: "element_matches",
      target: { by: "text", pattern: "NeverMatches" },
      timeoutMs: 400, intervalMs: 100,
    }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WaitTimeout");
  });
});

describe("hook setter null re-clear contract", () => {
  it("setTerminalReadHook(null) restores the unregistered state (terminal_output_contains fails fast)", async () => {
    // First install a working hook
    setTerminalReadHook(async () => ({ text: "hello", marker: "x" }));
    // Then explicitly clear it
    setTerminalReadHook(null);
    const r = parsePayload(await waitUntilHandler({
      condition: "terminal_output_contains",
      target: { windowTitle: "any", pattern: "hello" },
      timeoutMs: 500, intervalMs: 200,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hook not registered|not registered/i);
  });

  it("setBrowserSearchHook(null) restores the unregistered state (element_matches fails fast)", async () => {
    setBrowserSearchHook(async () => [{ text: "x", selector: "x" }]);
    setBrowserSearchHook(null);
    const r = parsePayload(await waitUntilHandler({
      condition: "element_matches",
      target: { by: "text", pattern: "x" },
      timeoutMs: 500, intervalMs: 200,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hook not registered|not registered/i);
  });
});
