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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #257 — keyboard(action='sequence') 6-pin contract
// ─────────────────────────────────────────────────────────────────────────────

import { withKeyboardLock, rawKeyboard } from "../../src/engine/nutjs.js";
import { keyboardSchema } from "../../src/tools/keyboard.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";
import { assertKeyComboSafe } from "../../src/utils/key-safety.js";

describe("keyboard(action='sequence') — issue #257 contract pins", () => {
  beforeEach(() => {
    events.length = 0;
    _resetInputQueueForTests();
  });

  // ── Pin 1: outer-lock serialization ────────────────────────────────────────
  it("withKeyboardLock blocks concurrent keyboard.pressKey callers", async () => {
    // Open the lock, hold it across two raw key-down/up pairs, and confirm
    // that an external keyboard.pressKey() call queued during the hold waits
    // until the lock body completes. This is the structural pin behind issue
    // #257's atomic-sequence guarantee.
    //
    // Note: rawKeyboard.pressKeyDown is bound to _rawKeyboard.pressKey so it
    // produces the same "press-start"/"press-end" events as keyboard.pressKey.
    // The seq-start / seq-end markers around the lock body let us distinguish
    // in-lock vs out-of-lock events purely by index.
    const sequenceDone = withKeyboardLock(async () => {
      events.push("seq-start");
      await rawKeyboard.pressKeyDown();
      await rawKeyboard.pressKeyUp();
      await rawKeyboard.pressKeyDown();
      await rawKeyboard.pressKeyUp();
      events.push("seq-end");
    });

    // External caller fires after the lock has been claimed.
    const external = keyboard.pressKey();

    await Promise.all([sequenceDone, external]);

    const seqEndIdx = events.indexOf("seq-end");
    expect(seqEndIdx).toBeGreaterThanOrEqual(0);

    // Every event AFTER seq-end must belong to the external pressKey call —
    // press-start → press-end with no interleaving. The lock kept the
    // external caller out until the sequence completed.
    const tail = events.slice(seqEndIdx + 1);
    expect(tail).toEqual(["press-start", "press-end"]);

    // BEFORE seq-end, we should see seq-start + the lock body's own
    // press/release pairs but NO external pressKey completion. Equivalently:
    // press-end count before seq-end equals press-start count before seq-end
    // (every started in-lock press finished before the next started).
    const head = events.slice(0, seqEndIdx + 1);
    const headPressStarts = head.filter((e) => e === "press-start").length;
    const headPressEnds = head.filter((e) => e === "press-end").length;
    expect(headPressStarts).toBe(2); // 2 pressKeyDown calls inside the lock
    expect(headPressEnds).toBe(2);   // each finished inside the lock
  });

  // ── Pin 2: classify() routes typed codes BEFORE generic arms ────────────────
  it("classify() routes MenuFocusLostMidSequence to its typed code, not ToolError", () => {
    const failure = failWith(
      new Error("MenuFocusLostMidSequence: focus left target before step 1 (stolen by Notepad)"),
      "keyboard:sequence",
    );
    // failWith returns a ToolResult whose first content block carries the JSON
    // envelope; rather than re-parse, we rely on the SUGGESTS dict being
    // populated for the typed code — proof that the cascade matched.
    const suggests = getSuggestsForCode("MenuFocusLostMidSequence");
    expect(suggests.length).toBeGreaterThan(0);
    expect(suggests.join(" ")).toMatch(/context\.remaining/);

    // Also verify the failure envelope text encodes the typed code, not the
    // generic ToolError. ToolFailure shape: content[0].text is a JSON string.
    const text = (failure.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toMatch(/"code":\s*"MenuFocusLostMidSequence"/);
  });

  // ── Pin 3: macro pre-validate scans steps[].keys ────────────────────────────
  // macro.ts pre-loop should iterate params.steps[] and call assertKeyComboSafe
  // on each .keys before Zod parse. Reproduce that loop logic here (the macro
  // doesn't expose its pre-validate function; this pin asserts the contract a
  // future change must keep — see `src/tools/macro.ts` action==='sequence' branch).
  it("macro-style pre-validate rejects win+r inside a sequence step", () => {
    const params = {
      action: "sequence",
      steps: [{ keys: "alt+i" }, { keys: "win+r" }, { keys: "m" }],
    };
    expect(() => {
      if (
        params.action === "sequence" &&
        Array.isArray(params.steps)
      ) {
        for (const rawStep of params.steps as Array<unknown>) {
          const keys = (rawStep as { keys?: unknown } | null)?.keys;
          if (typeof keys === "string") {
            assertKeyComboSafe(keys);
          }
        }
      }
    }).toThrow(/win\+r|shell|allowed/i);
  });

  // ── Pin 4: stub-catalog emits sequence variant with per-item shape ──────────
  it("stub-tool-catalog includes the sequence variant with full items shape", () => {
    const kb = STUB_TOOL_CATALOG.find((t) => t.name === "keyboard");
    expect(kb).toBeDefined();
    const variants = kb!.inputSchema.oneOf;
    expect(Array.isArray(variants)).toBe(true);
    const seq = variants!.find(
      (v) => (v.properties?.action as { const?: unknown })?.const === "sequence",
    );
    expect(seq).toBeDefined();

    // The steps array must surface its inner item shape; if regen drops the
    // recursion, Linux stub callers lose all per-step contract info.
    const steps = seq!.properties!.steps as {
      type?: string;
      items?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
    };
    expect(steps.type).toBe("array");
    expect(steps.items).toBeDefined();
    expect(steps.items!.properties).toMatchObject({
      keys: expect.any(Object),
      holdMs: expect.any(Object),
      gapMs: expect.any(Object),
    });
    expect(steps.items!.required).toContain("keys");
    expect(steps.items!.additionalProperties).toBe(false);

    // Variant-level required must list steps (regression pin for the
    // optional-scan-scope fix in generate-stub-tool-catalog.mjs).
    expect(seq!.required).toContain("action");
    expect(seq!.required).toContain("steps");

    // method literal "foreground" const should evaluate, not stay as undefined.
    const method = seq!.properties!.method as { const?: unknown };
    expect(method.const).toBe("foreground");
  });

  // ── Pin 5: context.remaining is directly re-invocable via the same schema ──
  it("MenuFocusLostMidSequence context.remaining round-trips through keyboardSchema", () => {
    // Simulate a sequence where step 0 succeeded and step 1+2 are the
    // unsent tail. The handler's catch path returns Step[] objects (with
    // optional holdMs/gapMs); the caller must be able to re-call sequence
    // with those steps as-is.
    const original = [
      { keys: "alt+i" },
      { keys: "m" },
      { keys: "enter", holdMs: 50, gapMs: 100 },
    ];
    const remaining = original.slice(1); // step 0 done, [m, enter] remain

    const reinvoke = {
      action: "sequence" as const,
      steps: remaining,
      windowTitle: "VBE",
    };
    const result = keyboardSchema.safeParse(reinvoke);
    expect(result.success).toBe(true);
    if (result.success) {
      // After parse, all fields must survive (esp. holdMs/gapMs).
      if (result.data.action !== "sequence") throw new Error("variant mismatch");
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.steps[1]).toMatchObject({ keys: "enter", holdMs: 50, gapMs: 100 });
    }
  });

  // ── Pin 6: schema rejects method:'background' and 'foreground_flash' ────────
  it("keyboardSchema rejects method:'background' on sequence variant", () => {
    const bg = keyboardSchema.safeParse({
      action: "sequence",
      steps: [{ keys: "alt+i" }],
      method: "background",
    });
    expect(bg.success).toBe(false);

    const ff = keyboardSchema.safeParse({
      action: "sequence",
      steps: [{ keys: "alt+i" }],
      method: "foreground_flash",
    });
    expect(ff.success).toBe(false);

    // foreground and omitted both pass.
    const fg = keyboardSchema.safeParse({
      action: "sequence",
      steps: [{ keys: "alt+i" }],
      method: "foreground",
    });
    expect(fg.success).toBe(true);

    const omitted = keyboardSchema.safeParse({
      action: "sequence",
      steps: [{ keys: "alt+i" }],
    });
    expect(omitted.success).toBe(true);
  });

  // ── Bonus pin: refine() rejects total > 5000ms across step boundaries ──────
  it("keyboardSchema refine rejects total duration > 5000ms", () => {
    // 11 steps × (holdMs=500 + gapMs=0 default 80) ≈ 5000ms+ headroom.
    // Push past 5000 with two big holds.
    const tooLong = {
      action: "sequence" as const,
      steps: [
        { keys: "a", holdMs: 500, gapMs: 500 },
        { keys: "b", holdMs: 500, gapMs: 500 },
        { keys: "c", holdMs: 500, gapMs: 500 },
        { keys: "d", holdMs: 500, gapMs: 500 },
        { keys: "e", holdMs: 500, gapMs: 500 },
        { keys: "f", holdMs: 500 }, // total: 6000ms - last gap ignored
      ],
    };
    const result = keyboardSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
  });
});
