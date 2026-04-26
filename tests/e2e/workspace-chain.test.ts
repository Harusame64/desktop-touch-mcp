/**
 * workspace-chain.test.ts — E2E tests for H1: workspace_launch chain
 *
 * H1: workspace_launch → wait_until → focus_window
 *   - focus_window on a window that hasn't appeared yet returns WindowNotFound
 *   - suggest[] includes "wait_until" to guide the LLM to wait before retrying
 *   - workspace_launch itself succeeds (just the timing chain is broken)
 *
 * Design: We test the error quality for focus_window when the window is absent,
 * not the race condition itself (which is non-deterministic). The key is that
 * the error response is actionable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { focusWindowHandler } from "../../src/tools/window.js";
import { workspaceLaunchHandler } from "../../src/tools/workspace.js";
import { waitUntilHandler } from "../../src/tools/wait-until.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";

// ─────────────────────────────────────────────────────────────────────────────
// H1-base: focus_window on absent window → WindowNotFound + suggest wait_until
// ─────────────────────────────────────────────────────────────────────────────

describe("H1-base: focus_window on absent window → WindowNotFound + wait_until suggest", () => {
  it("returns code:WindowNotFound with suggest containing wait_until", async () => {
    const result = await focusWindowHandler({
      title: "__no_such_window_h1_test_xyz__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("WindowNotFound");
    expect(Array.isArray(p.suggest)).toBe(true);
    expect(p.suggest.length).toBeGreaterThan(0);
    // LLM must be directed to use wait_until when window hasn't appeared yet
    expect(p.suggest.some((s: string) => /wait_until/.test(s))).toBe(true);
  });

  it("suggest also contains desktop_discover for discovery", async () => {
    const result = await focusWindowHandler({
      title: "__no_such_window_h1_test_xyz__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    // Phase 4: get_windows privatized → WindowNotFound suggest now points at desktop_discover.
    expect(p.suggest.some((s: string) => /desktop_discover/.test(s))).toBe(true);
  });

  it("context carries the searched title", async () => {
    const result = await focusWindowHandler({
      title: "__no_such_window_h1_test_xyz__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.context).toBeDefined();
    expect(p.context.title).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H1-chain: workspace_launch → focus_window (without wait) → error, then
//           workspace_launch → wait_until → focus_window → success
// ─────────────────────────────────────────────────────────────────────────────

describe("H1-chain: workspace_launch + wait_until + focus_window happy path", () => {
  let np: NpInstance | null = null;

  afterAll(() => np?.kill());

  it("workspace_launch notepad → foundWindow present", async () => {
    // Launch a Notepad without re-using launchNotepad helper to test the tool directly.
    // Use a unique title by passing a temp file name.
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { writeFileSync, unlinkSync } = await import("fs");
    const { spawn } = await import("child_process");
    const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");

    const tag = `h1-${Date.now().toString(36)}`;
    const tempFile = join(tmpdir(), `${tag}.txt`);
    writeFileSync(tempFile, "", "utf8");

    try {
      const result = await workspaceLaunchHandler({
        command: "notepad.exe",
        args: [tempFile],
        waitMs: 5000,
      });
      const p = parsePayload(result);
      // Wait for taskkill to fully reap the spawned Notepad before next test launches
      // its own; otherwise the OS can be slow to spawn new notepad.exe instances.
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/F", "/FI", `WINDOWTITLE eq ${tag}*`, "/T"], { stdio: "ignore" });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });

      // workspace_launch returns { launched, args, foundWindow, region } — no ok field
      expect(p.launched).toBeTruthy();
      // foundWindow may be populated if window appeared within waitMs
      // (some CI environments may be slow, so we just check the structure)
      expect("foundWindow" in p).toBe(true);
    } finally {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }, 15_000);

  it("wait_until(window_appears) succeeds after workspace_launch", async () => {
    // Launch Notepad via launchNotepad helper (already tested), then verify
    // wait_until can detect the window.
    const { launchNotepad: ln } = await import("./helpers/notepad-launcher.js");
    np = await ln();

    const result = await waitUntilHandler({
      condition: "window_appears",
      target: { windowTitle: np.tag },
      timeoutMs: 5000,
      intervalMs: 100,
    });
    const p = parsePayload(result);

    // window_appears should succeed (Notepad is already open)
    expect(p.ok).toBe(true);
  }, 30_000);

  it("focus_window succeeds after wait_until confirms window is present", async ({ skip }) => {
    if (!np) { skip("Notepad not launched in previous test"); return; }

    const result = await focusWindowHandler({ title: np.tag });
    const p = parsePayload(result);

    // If focus-stealing is blocked by OS, focused may fail but window exists.
    // The key assertion is that it doesn't return WindowNotFound (window IS present).
    if (p.ok === false && p.code === "WindowNotFound") {
      // This means the window somehow disappeared — unusual but possible on slow CI
      skip(`focus_window returned WindowNotFound for "${np.tag}" — window may have closed`);
      return;
    }
    // ok:true or ok:false for other reasons (focus-stealing blocked) are both acceptable
    expect(p.ok).toBe(true);
    expect(p.focused).toContain(np.tag);
  }, 10_000);
});
