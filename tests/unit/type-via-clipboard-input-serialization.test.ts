/**
 * type-via-clipboard-input-serialization.test.ts — ADR-033 PR-2.
 *
 * The paste chord `typeViaClipboard` sends used to go out through
 * `keyboard.pressKey` / `releaseKey`, which the engine wraps in a single input
 * queue (`src/engine/nutjs.ts`, issue #255 / #257). Everything that injects
 * keystrokes — the keyboard tool, scroll's PageDown, terminal's Enter, a
 * `keyboard(action='sequence')` holding Alt down across its whole step loop —
 * takes turns on that one queue.
 *
 * The native composite sends its chord from a libuv worker, which is outside
 * the queue entirely. Left unserialised, a Ctrl+V can arrive in the middle of a
 * sequence that is holding Alt or Shift: the target sees Ctrl+Alt+V, or the
 * paste lands in whichever window the sequence had just navigated to. Both are
 * silent — the tools report success and the user gets something else.
 *
 * So the whole native transaction takes the same lock, and these tests hold it
 * from BOTH sides, because one direction alone would not prove serialisation:
 *
 *   1. a paste in flight delays other keyboard input, and
 *   2. other keyboard input in flight delays the paste.
 *
 * `@nut-tree-fork/nut-js` is mocked and the real engine wrapper is used, which
 * is the same arrangement `keyboard-input-serialization.test.ts` uses — the
 * queue under test is the production one, not a stand-in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const events: string[] = [];

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 0 } },
  keyboard: {
    config: { autoDelayMs: 0 },
    pressKey: vi.fn(async () => {
      events.push("other-input-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("other-input-end");
    }),
    releaseKey: vi.fn(async () => undefined),
    type: vi.fn(async () => {
      events.push("other-input-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("other-input-end");
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

const nativeState = { composite: vi.fn() };

vi.mock(import("../../src/engine/native-engine.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hasNativeTypeViaClipboard: () => true,
    nativeWin32: {
      ...(actual.nativeWin32 ?? {}),
      win32TypeViaClipboard: (...a: unknown[]) => nativeState.composite(...a),
    } as unknown as typeof actual.nativeWin32,
  };
});

const { typeViaClipboard } = await import("../../src/tools/keyboard.js");
const { keyboard, withKeyboardLock, _resetInputQueueForTests } = await import(
  "../../src/engine/nutjs.js"
);

/** A composite result whose chord landed and whose restore ran. */
const nativeOk = {
  ok: true,
  verify: {
    ok: true,
    expectedBytes: 10,
    inSessionReadable: true,
    inSessionBytes: 10,
    inSessionMatch: true,
    postCloseChecked: true,
    postCloseBytes: 10,
    postCloseMatch: true,
    sequenceAfterWrite: 5,
  },
  pasted: true,
  clipboardModified: true,
  clipboardRestored: true,
  restoreSkippedRace: false,
  skippedFormats: [],
  settleMs: 120,
};

/** A composite that hangs until the returned function is called. */
function pendingComposite(): () => void {
  let release!: () => void;
  nativeState.composite.mockImplementation(() => {
    events.push("paste-start");
    return new Promise((resolve) => {
      release = () => {
        events.push("paste-end");
        resolve(nativeOk);
      };
    });
  });
  return () => release();
}

/** Let queued microtasks and any pending timers run. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  events.length = 0;
  nativeState.composite.mockReset();
  _resetInputQueueForTests();
});

describe("ADR-033 — the native paste shares the engine's keyboard input queue", () => {
  it("holds off other keyboard input until the paste transaction finishes", async () => {
    const releasePaste = pendingComposite();

    const paste = typeViaClipboard("hello");
    // Give the paste a turn to take the lock before the competing caller asks.
    await Promise.resolve();
    const other = keyboard.type("competing input");

    await settle();
    // The load-bearing assertion: the competing keystrokes have NOT started,
    // even though the paste is still waiting on the clipboard.
    expect(events).toEqual(["paste-start"]);

    releasePaste();
    await Promise.all([paste, other]);

    expect(events).toEqual([
      "paste-start",
      "paste-end",
      "other-input-start",
      "other-input-end",
    ]);
  });

  it("waits for input already in flight before pasting", async () => {
    // The direction that matters most: `keyboard(action='sequence')` takes this
    // lock around its WHOLE step loop precisely so nothing can splice between a
    // press and its release. A paste that ignored the queue would land in the
    // middle of a held Alt or Shift.
    nativeState.composite.mockImplementation(() => {
      events.push("paste-start");
      return Promise.resolve(nativeOk);
    });

    let releaseSequence!: () => void;
    const sequence = withKeyboardLock(async () => {
      events.push("sequence-start");
      await new Promise<void>((resolve) => {
        releaseSequence = () => {
          events.push("sequence-end");
          resolve();
        };
      });
    });

    await Promise.resolve();
    const paste = typeViaClipboard("hello");

    await settle();
    // Nothing has been pasted while the sequence holds the keyboard.
    expect(events).toEqual(["sequence-start"]);

    releaseSequence();
    await Promise.all([sequence, paste]);

    expect(events).toEqual(["sequence-start", "sequence-end", "paste-start"]);
  });

  it("does not start — or time out — while it is still waiting for the queue", async () => {
    // The nesting order, pinned. The give-up timeout is started INSIDE the
    // lock, so a paste stuck behind a long `keyboard(action='sequence')` waits
    // quietly instead of expiring in the queue.
    //
    // Were the timeout outside the lock, this test would show the failure it
    // exists to prevent: the caller is told the call failed at 5s, the sequence
    // then finishes, the queue hands over the turn — and the chord goes out
    // anyway, into whatever window has focus by then. That is the same hole the
    // addon's paste deadline closes one layer down, reopened in JS.
    vi.useFakeTimers();
    try {
      nativeState.composite.mockImplementation(() => {
        events.push("paste-start");
        return Promise.resolve(nativeOk);
      });

      let releaseSequence!: () => void;
      const sequence = withKeyboardLock(
        () => new Promise<void>((resolve) => (releaseSequence = resolve)),
      );
      await Promise.resolve();

      const paste = typeViaClipboard("hello");
      let settled: "resolved" | "rejected" | null = null;
      void paste.then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );

      // Well past the 5s give-up budget, still queued.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(nativeState.composite, "the addon must not be called while queued")
        .not.toHaveBeenCalled();
      expect(settled, "the caller must not be told it failed while queued").toBeNull();

      releaseSequence();
      await vi.advanceTimersByTimeAsync(0);

      // Only now does the work — and its clock — begin.
      expect(nativeState.composite).toHaveBeenCalledTimes(1);
      await sequence;
      await expect(paste).resolves.toMatchObject({ backend: "native" });
      expect(events).toEqual(["paste-start"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the lock when the transaction fails", async () => {
    // A rejection must not strand the queue — every later keystroke in the
    // session would be lost. (`withInputLock` schedules on both settlements;
    // this is the pin for it on THIS path.)
    nativeState.composite.mockRejectedValueOnce(new Error("clipboard exploded"));

    await expect(typeViaClipboard("hello")).rejects.toThrow();

    await keyboard.type("after the failure");
    expect(events).toEqual(["other-input-start", "other-input-end"]);
  });
});
