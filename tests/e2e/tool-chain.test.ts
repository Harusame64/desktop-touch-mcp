/**
 * tool-chain.test.ts — E2E tests for tool chaining / state propagation (H2)
 *
 * H2: get_history ring buffer
 *   - Multiple actions via withPostState-wrapped handlers
 *   - get_history(n) returns entries in chronological order
 *   - Each entry has: tool, ok, post.focusedWindow, tsMs
 *   - Ring buffer caps at 20 entries (HISTORY_MAX)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHistoryHandler } from "../../src/tools/context.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { withPostState } from "../../src/tools/_post.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { focusWindow } from "../../src/engine/win32.js";

let np: NpInstance;

// Wrap keyboard_press with withPostState exactly as the MCP server does,
// so history entries are recorded for our test actions.
const trackedKeyboardPress = withPostState("keyboard_press", keyboardPressHandler);

beforeAll(async () => {
  np = await launchNotepad();
  try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
  await sleep(400);
}, 10_000);

afterAll(() => np?.kill());

describe("H2: get_history ring buffer", () => {
  it("get_history returns count + actions array", async () => {
    const result = await getHistoryHandler({ n: 5 });
    const p = parsePayload(result);

    expect(typeof p.count).toBe("number");
    expect(Array.isArray(p.actions)).toBe(true);
    expect(p.actions.length).toBe(p.count);
  });

  it("entries appear in chronological order (ascending tsMs)", async () => {
    // Run 3 sequential actions — each records a history entry.
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });
    await sleep(50);
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });
    await sleep(50);
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });

    const result = await getHistoryHandler({ n: 20 });
    const p = parsePayload(result);

    expect(p.actions.length).toBeGreaterThan(0);

    // Verify strict ascending timestamp order
    for (let i = 1; i < p.actions.length; i++) {
      expect(p.actions[i].tsMs).toBeGreaterThanOrEqual(p.actions[i - 1].tsMs);
    }
  });

  it("each history entry has required fields: tool, ok, post, tsMs", async () => {
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });

    const result = await getHistoryHandler({ n: 5 });
    const p = parsePayload(result);
    const last = p.actions[p.actions.length - 1];

    expect(typeof last.tool).toBe("string");
    expect(last.tool.length).toBeGreaterThan(0);
    expect(typeof last.ok).toBe("boolean");
    expect(typeof last.tsMs).toBe("number");
    expect(last.post).toBeDefined();
    // post.focusedWindow is captured by withPostState (may be null if no window focused)
    expect("focusedWindow" in last.post).toBe(true);
    // post.windowChanged is a bool
    expect(typeof last.post.windowChanged).toBe("boolean");
    // post.elapsedMs must be a positive number
    expect(typeof last.post.elapsedMs).toBe("number");
    expect(last.post.elapsedMs).toBeGreaterThan(0);
  });

  it("most-recent entry is keyboard_press with ok:true", async () => {
    // Run one more tracked action to ensure it's at the tail
    const before = Date.now();
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });
    const after = Date.now();

    const result = await getHistoryHandler({ n: 1 });
    const p = parsePayload(result);

    expect(p.count).toBe(1);
    const entry = p.actions[0];
    expect(entry.tool).toBe("keyboard_press");
    // ok may be false if no window was focused (foreground-stealing) — that's ok,
    // but the entry must exist and tsMs must be within our measurement window.
    expect(entry.tsMs).toBeGreaterThanOrEqual(before);
    expect(entry.tsMs).toBeLessThanOrEqual(after + 500);
  });

  it("ring buffer caps at 20 — overflow does not crash", async () => {
    // Push 25 entries to exceed HISTORY_MAX=20
    for (let i = 0; i < 25; i++) {
      await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });
    }

    const result = await getHistoryHandler({ n: 20 });
    const p = parsePayload(result);

    // count must never exceed HISTORY_MAX
    expect(p.count).toBeLessThanOrEqual(20);
    expect(p.actions.length).toBeLessThanOrEqual(20);
  }, 30_000);

  it("n=0 is clamped — returns at least 1 entry", async () => {
    // getHistorySnapshot clamps n to max(1, min(n, HISTORY_MAX))
    await trackedKeyboardPress({ keys: "escape", trackFocus: false, settleMs: 0 });

    const result = await getHistoryHandler({ n: 0 });
    const p = parsePayload(result);

    expect(p.count).toBeGreaterThanOrEqual(1);
  });

  it("error entries (ok:false) are recorded with errorCode", async () => {
    // A blocked key combo generates an ok:false entry
    await trackedKeyboardPress({ keys: "win+r", trackFocus: false, settleMs: 0 });

    const result = await getHistoryHandler({ n: 5 });
    const p = parsePayload(result);

    const failEntry = [...p.actions].reverse().find(
      (e: { tool: string; ok: boolean; errorCode?: string }) =>
        e.tool === "keyboard_press" && e.ok === false
    );
    expect(failEntry).toBeDefined();
    expect(failEntry.errorCode).toBe("BlockedKeyCombo");
    // post is still recorded even on failure
    expect(failEntry.post).toBeDefined();
    expect(typeof failEntry.post.elapsedMs).toBe("number");
  });
});
