/**
 * tests/unit/keyboard-input-serialization.test.ts
 *
 * Regression for issue #255 — concurrent `keyboard` tool calls crashed the
 * MCP server because libnut's SendInput backend is not safe for interleaved
 * press/release sequences.
 *
 * The keyboardHandler entry serializes calls through a module-local FIFO
 * (`withInputLock` in src/tools/keyboard.ts). These tests verify:
 *
 *   1. parallel keyboardHandler({action:'press'}) invocations are serialized
 *      — call N+1's first native send does not start until call N's last
 *      native send has completed.
 *   2. a rejection inside one call does not poison the queue — the next
 *      queued call still runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Records `{ id, phase, t }` events. We deliberately use a shared `events`
// array (not vi.fn().mock.calls) so press / release of two calls can be
// compared on a single timeline.
type Phase = "press-start" | "press-end" | "release-start" | "release-end";
const events: Array<{ id: string; phase: Phase; t: number }> = [];
let _activeId: string | null = null;

function record(phase: Phase) {
  // _activeId is set by the test driver immediately before each handler
  // invocation. We use it to attribute the mock-fired event back to its
  // originating call, since nutjs mocks have no per-call identity.
  events.push({ id: _activeId ?? "?", phase, t: performance.now() });
}

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    pressKey: vi.fn(async () => {
      record("press-start");
      // Yield to the event loop so an interleaved call would have an
      // opportunity to start its own pressKey before this one resolves.
      await new Promise((r) => setTimeout(r, 10));
      record("press-end");
    }),
    releaseKey: vi.fn(async () => {
      record("release-start");
      await new Promise((r) => setTimeout(r, 10));
      record("release-end");
    }),
    type: vi.fn(),
  },
}));

vi.mock("../../src/tools/_focus.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_focus.js")
  >("../../src/tools/_focus.js");
  return {
    ...actual,
    detectFocusLoss: vi.fn().mockResolvedValue(null),
    checkForegroundOnce: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../../src/tools/_action-guard.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_action-guard.js")
  >("../../src/tools/_action-guard.js");
  return {
    ...actual,
    runActionGuard: vi.fn().mockResolvedValue({
      block: false,
      summary: { kind: "ag-summary" },
    }),
    isAutoGuardEnabled: vi.fn().mockReturnValue(false),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ─────────────────────────────────────────────────────────────────────────────

import { keyboardHandler } from "../../src/tools/keyboard.js";
import { keyboard as mockKeyboard } from "../../src/engine/nutjs.js";

beforeEach(() => {
  events.length = 0;
  _activeId = null;
  vi.mocked(mockKeyboard.pressKey).mockClear();
  vi.mocked(mockKeyboard.releaseKey).mockClear();
});

async function fire(id: string, keys: string): Promise<unknown> {
  _activeId = id;
  // The handler awaits enqueueing synchronously, so by the time it returns
  // its first microtask, the lock has been taken. Recording _activeId before
  // the call is sufficient for serial workloads; for the parallel test we
  // re-set _activeId from inside the press mock by attribution via the
  // first press event of each unique window.
  return keyboardHandler({ action: "press", keys } as never);
}

describe("keyboard input serialization (issue #255)", () => {
  it("serializes parallel press calls — no interleaving between calls", async () => {
    // Drive three calls in flight at once. Use distinct ids so we can verify
    // ordering on the event timeline.
    const p1 = (async () => {
      _activeId = "a";
      return keyboardHandler({ action: "press", keys: "a" } as never);
    })();
    const p2 = (async () => {
      _activeId = "b";
      return keyboardHandler({ action: "press", keys: "b" } as never);
    })();
    const p3 = (async () => {
      _activeId = "c";
      return keyboardHandler({ action: "press", keys: "c" } as never);
    })();

    await Promise.all([p1, p2, p3]);

    // The mock attributes events to whatever `_activeId` was at the time the
    // mock fired — which mid-flight gets overwritten as later calls reach
    // the handler entry. So we cannot rely on per-call labels for ordering.
    // Instead, assert structural serialization: every press-end is followed
    // by a release-start (same call's release) before the next press-start
    // begins.
    //
    // Expected sequence for 3 serialized press calls:
    //   press-start, press-end, release-start, release-end,  <- call 1
    //   press-start, press-end, release-start, release-end,  <- call 2
    //   press-start, press-end, release-start, release-end   <- call 3
    const phases = events.map((e) => e.phase);
    expect(phases).toEqual([
      "press-start", "press-end", "release-start", "release-end",
      "press-start", "press-end", "release-start", "release-end",
      "press-start", "press-end", "release-start", "release-end",
    ]);

    expect(vi.mocked(mockKeyboard.pressKey)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(mockKeyboard.releaseKey)).toHaveBeenCalledTimes(3);
  });

  it("does not poison the queue when one call rejects", async () => {
    // Make the first pressKey throw. The second call must still execute.
    vi.mocked(mockKeyboard.pressKey)
      .mockImplementationOnce(async () => {
        record("press-start");
        throw new Error("simulated libnut crash");
      })
      .mockImplementationOnce(async () => {
        record("press-start");
        await new Promise((r) => setTimeout(r, 10));
        record("press-end");
      });

    const p1 = keyboardHandler({ action: "press", keys: "a" } as never);
    const p2 = keyboardHandler({ action: "press", keys: "b" } as never);

    const [r1, r2] = await Promise.allSettled([p1, p2]);

    // The handler converts internal errors via `failWith`, so the outer
    // promise resolves (status === 'fulfilled') with an isError ToolResult,
    // not a rejection. What we really care about is: did call 2 still run?
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    // Call 1 made its pressKey attempt (and threw); call 2 made its
    // pressKey AND its pressEnd. Total = at least 2 press-starts and 1
    // press-end, proving the queue did not deadlock.
    const pressStarts = events.filter((e) => e.phase === "press-start").length;
    const pressEnds = events.filter((e) => e.phase === "press-end").length;
    expect(pressStarts).toBeGreaterThanOrEqual(2);
    expect(pressEnds).toBeGreaterThanOrEqual(1);
  });
});
