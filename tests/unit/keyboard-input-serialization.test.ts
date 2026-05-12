/**
 * tests/unit/keyboard-input-serialization.test.ts
 *
 * Regression for issue #255 — concurrent keyboard input crashed the MCP
 * server because libnut's SendInput backend is not safe for interleaved
 * press/release sequences.
 *
 * The lock lives at the engine layer (`src/engine/nutjs.ts`) so it covers
 * every native-input caller: the `keyboard` tool, scroll PageDown / PageUp
 * keystrokes, `terminal:send` fallback, and any future tool that reaches
 * into the same libnut backend. These tests mock `@nut-tree-fork/nut-js`
 * (the raw library) and exercise the wrapper directly so they verify the
 * production lock — not a per-handler one.
 *
 *   1. Parallel pressKey / releaseKey / type calls — even across different
 *      methods — are serialized: the next native call does not start until
 *      the previous one has resolved.
 *   2. A rejection inside one call does not poison the queue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mock the raw library so the production engine wrap is exercised
// ─────────────────────────────────────────────────────────────────────────────

type Phase = "press-start" | "press-end" | "release-start" | "release-end" | "type-start" | "type-end";
const events: Phase[] = [];

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: {
    config: { autoDelayMs: 0, mouseSpeed: 0 },
  },
  keyboard: {
    config: { autoDelayMs: 0 },
    pressKey: vi.fn(async () => {
      events.push("press-start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("press-end");
    }),
    releaseKey: vi.fn(async () => {
      events.push("release-start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("release-end");
    }),
    type: vi.fn(async () => {
      events.push("type-start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("type-end");
    }),
  },
  screen: {},
  getWindows: vi.fn(),
  getActiveWindow: vi.fn(),
  Key: {},
  Button: {},
  Point: class {},
  Region: class {},
  Size: class {},
  straightTo: vi.fn(),
  up: vi.fn(),
  down: vi.fn(),
  left: vi.fn(),
  right: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import after mocks. Use the engine-wrapped `keyboard` export — the
// production object that real tools call into.
// ─────────────────────────────────────────────────────────────────────────────

import { keyboard, _resetInputQueueForTests } from "../../src/engine/nutjs.js";
import { keyboard as _rawKeyboard } from "@nut-tree-fork/nut-js";

beforeEach(() => {
  events.length = 0;
  _resetInputQueueForTests();
});

describe("engine-layer keyboard input serialization (issue #255)", () => {
  it("serializes parallel pressKey calls — no interleaving", async () => {
    // Three keyboard.pressKey calls in flight at once. With the lock,
    // every press-end must precede the next press-start.
    const p1 = keyboard.pressKey();
    const p2 = keyboard.pressKey();
    const p3 = keyboard.pressKey();

    await Promise.all([p1, p2, p3]);

    expect(events).toEqual([
      "press-start", "press-end",
      "press-start", "press-end",
      "press-start", "press-end",
    ]);
  });

  it("serializes interleaved press / type from different callers", async () => {
    // Simulates the scenario from issue #255: an LLM fires keyboard.press,
    // a scroll PageDown (keyboard.pressKey internally), and a terminal:send
    // (keyboard.type) all in the same Claude turn. All three must serialize
    // through the engine-layer queue.
    const a = keyboard.pressKey();   // stand-in for keyboard tool
    const b = keyboard.pressKey();   // stand-in for scroll PageDown
    const c = keyboard.type("hi");   // stand-in for terminal:send

    await Promise.all([a, b, c]);

    // Whatever the exact arrival order, every *-end must precede the next
    // *-start. The simplest assertion: no two -start events are adjacent.
    const startOrEnd = (e: Phase) => (e.endsWith("-start") ? "S" : "E");
    const compact = events.map(startOrEnd).join("");
    expect(compact).toBe("SESESE");
    expect(events).toHaveLength(6);
  });

  it("does not poison the queue when one call rejects", async () => {
    // Make the first pressKey throw. Subsequent calls must still execute.
    // Adjust the underlying raw mock (the engine wraps it; replacing the
    // wrapper would bypass the lock under test).
    vi.mocked(_rawKeyboard.pressKey)
      .mockImplementationOnce(async () => {
        events.push("press-start");
        throw new Error("simulated libnut crash");
      })
      .mockImplementationOnce(async () => {
        events.push("press-start");
        await new Promise((r) => setTimeout(r, 10));
        events.push("press-end");
      });

    const p1 = keyboard.pressKey().catch(() => undefined);
    const p2 = keyboard.pressKey();

    await Promise.all([p1, p2]);

    // Call 1 emitted press-start (and threw). Call 2 ran fully.
    expect(events).toEqual([
      "press-start",                 // call 1 (threw immediately after this)
      "press-start", "press-end",    // call 2 (queue advanced past the failure)
    ]);
  });
});
