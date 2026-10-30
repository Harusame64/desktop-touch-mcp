/**
 * internal #323 — the engine's keyboard.type types a line break as a plain Enter.
 *
 * win2 (2026-10-30, 2.3.4): libnut typed "\n" as Ctrl+Enter (VkKeyScanA('\n') = 0x0A0D): Chrome's
 * textarea got no line break, and chat and mail apps send on Ctrl+Enter. "\r\n" was Enter then
 * Ctrl+Enter, two line breaks in Notepad; "\r" alone was a plain Enter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 0 } },
  keyboard: {
    config: { autoDelayMs: 0 },
    pressKey: vi.fn(async (...k: unknown[]) => { calls.push(`down:${k.join("+")}`); }),
    releaseKey: vi.fn(async (...k: unknown[]) => { calls.push(`up:${k.join("+")}`); }),
    type: vi.fn(async (...a: unknown[]) => { calls.push(`type:${JSON.stringify(a)}`); }),
  },
  screen: {},
  getWindows: vi.fn(),
  getActiveWindow: vi.fn(),
  Key: { Enter: "Enter", LeftControl: "LeftControl", A: "A" },
  Button: {}, Point: class {}, Region: class {}, Size: class {},
  straightTo: vi.fn(), up: vi.fn(), down: vi.fn(), left: vi.fn(), right: vi.fn(),
}));
vi.mock("../../src/engine/win32.js", () => ({ isExcludedWindowHandle: vi.fn(() => false) }));
vi.mock("../../src/engine/tool-exclusion.js", () => ({ hasExcludedPids: vi.fn(() => false) }));

import { keyboard, Key, _resetInputQueueForTests } from "../../src/engine/nutjs.js";

const ENTER = ["down:Enter", "up:Enter"];
const typed = (s: string) => `type:${JSON.stringify([s])}`;

beforeEach(() => {
  calls.length = 0;
  _resetInputQueueForTests();
});

describe("internal #323 — keyboard.type and line breaks", () => {
  it.each([
    ["LF", "a\nb"],
    ["CRLF", "a\r\nb"],
    ["CR", "a\rb"],
  ])("types %s as one plain Enter between the runs", async (_label, text) => {
    await keyboard.type(text);
    expect(calls).toEqual([typed("a"), ...ENTER, typed("b")]);
  });

  it("presses one Enter per line break, with no empty runs typed", async () => {
    await keyboard.type("\n\r\nx\n");
    expect(calls).toEqual([...ENTER, ...ENTER, typed("x"), ...ENTER]);
  });

  it("types a text with no line break in one call (the control)", async () => {
    await keyboard.type("hello world");
    expect(calls).toEqual([typed("hello world")]);
  });

  it("passes a Key list through untouched", async () => {
    await keyboard.type(Key.LeftControl, Key.A);
    expect(calls).toEqual([`type:${JSON.stringify(["LeftControl", "A"])}`]);
  });
});
