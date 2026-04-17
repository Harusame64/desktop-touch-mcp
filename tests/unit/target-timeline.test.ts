/**
 * tests/unit/target-timeline.test.ts
 *
 * Tests for Target-Identity Timeline (v3 §6.3, Phase D).
 * Covers D-1 (ring/global), D-1b (debounce), D-1c (compaction).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  appendEvent,
  listEventsForTarget,
  listRecentTargetKeys,
  listAllRecent,
  compactOlderThan,
  subscribe,
  startCompactionSweeper,
  stopCompactionSweeper,
  deriveLensTargetKey,
  _resetForTest,
  TARGET_RING_MAX,
  GLOBAL_EVENTS_MAX,
  DEBOUNCE_WINDOW_MS,
} from "../../src/engine/perception/target-timeline.js";
import { deriveTargetKey } from "../../src/engine/perception/action-target.js";

function makeEv(
  targetKey: string,
  semantic: Parameters<typeof appendEvent>[0]["semantic"],
  source: Parameters<typeof appendEvent>[0]["source"] = "action_guard",
  tsMs?: number
): ReturnType<typeof appendEvent> {
  return appendEvent({
    targetKey,
    identity: null,
    source,
    semantic,
    summary: `test ${semantic}`,
    ...(tsMs !== undefined ? { tsMs } : {}),
  });
}

beforeEach(() => {
  _resetForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1: Core store
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1: appendEvent / listEventsForTarget / listRecentTargetKeys", () => {
  it("appends an event and assigns a unique eventId", () => {
    const ev = makeEv("window:notepad", "target_bound");
    expect(ev).not.toBeNull();
    expect(ev!.eventId).toMatch(/^evt-/);
    expect(ev!.targetKey).toBe("window:notepad");
    expect(ev!.semantic).toBe("target_bound");
  });

  it("listEventsForTarget returns the appended event", () => {
    makeEv("window:notepad", "target_bound");
    makeEv("window:notepad", "action_attempted");
    const events = listEventsForTarget("window:notepad");
    expect(events).toHaveLength(2);
    expect(events[0].semantic).toBe("target_bound");
    expect(events[1].semantic).toBe("action_attempted");
  });

  it("listEventsForTarget returns empty for unknown key", () => {
    expect(listEventsForTarget("window:unknown")).toEqual([]);
  });

  it("listEventsForTarget respects n limit", () => {
    for (let i = 0; i < 10; i++) makeEv("window:notepad", "rect_changed");
    expect(listEventsForTarget("window:notepad", 3)).toHaveLength(3);
  });

  it("listRecentTargetKeys returns most-recent keys newest-first", () => {
    makeEv("window:notepad", "target_bound");
    makeEv("window:explorer", "target_bound");
    makeEv("window:notepad", "action_attempted");
    const keys = listRecentTargetKeys(5);
    expect(keys[0]).toBe("window:notepad");  // most recent
    expect(keys[1]).toBe("window:explorer");
  });

  it("eventId is unique across events", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const ev = makeEv("window:notepad", "rect_changed");
      ids.add(ev!.eventId);
    }
    expect(ids.size).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1: Per-key ring eviction
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1: per-key ring eviction (TARGET_RING_MAX = 32)", () => {
  it("ring evicts oldest when exceeds TARGET_RING_MAX", () => {
    for (let i = 0; i < TARGET_RING_MAX + 5; i++) {
      makeEv("window:notepad", "rect_changed");
    }
    const events = listEventsForTarget("window:notepad", TARGET_RING_MAX + 10);
    expect(events).toHaveLength(TARGET_RING_MAX);
  });

  it("ring for different keys are independent", () => {
    for (let i = 0; i < TARGET_RING_MAX + 5; i++) {
      makeEv("window:notepad", "rect_changed");
    }
    makeEv("window:explorer", "target_bound");
    expect(listEventsForTarget("window:explorer")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1: Global FIFO cap eviction
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1: global FIFO cap eviction (GLOBAL_EVENTS_MAX = 256)", () => {
  it("global order is capped at GLOBAL_EVENTS_MAX", () => {
    for (let i = 0; i < GLOBAL_EVENTS_MAX + 10; i++) {
      makeEv("window:notepad", "rect_changed");
    }
    expect(listAllRecent(GLOBAL_EVENTS_MAX + 100)).toHaveLength(GLOBAL_EVENTS_MAX);
  });

  it("global eviction also removes event from per-key ring (cross-key overflow)", () => {
    // Strategy: fill global with key A events (which also fill key A's ring),
    // then add 1 key B event that pushes global over cap → oldest key A event is
    // dropped from global → that eventId must NOT appear in key A's per-key ring either.
    //
    // To make the oldest global event still be in the per-key ring, we use
    // GLOBAL_EVENTS_MAX unique keys so per-key rings stay small.
    const KEYS = GLOBAL_EVENTS_MAX;  // one event per key
    const evIds: string[] = [];
    for (let i = 0; i < KEYS; i++) {
      const ev = makeEv(`window:key${i}`, "rect_changed");
      evIds.push(ev!.eventId);
    }
    // Now add 1 more to trigger eviction of the oldest (key0)
    makeEv("window:keylast", "rect_changed");

    // The oldest event (evIds[0] for window:key0) should have been dropped from both
    const key0Events = listEventsForTarget("window:key0");
    const key0Ids = new Set(key0Events.map(e => e.eventId));
    expect(key0Ids.has(evIds[0])).toBe(false);  // removed from per-key ring
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1b: Debounce (sensor only)
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1b: debounce — sensor events only", () => {
  it("sensor burst within DEBOUNCE_WINDOW_MS: only 1 event stored", () => {
    const base = 1000000;
    for (let i = 0; i < 10; i++) {
      makeEv("window:notepad", "rect_changed", "sensor", base + i * 10);
    }
    expect(listEventsForTarget("window:notepad")).toHaveLength(1);
  });

  it("sensor events past DEBOUNCE_WINDOW_MS are stored", () => {
    const base = 1000000;
    makeEv("window:notepad", "rect_changed", "sensor", base);
    makeEv("window:notepad", "rect_changed", "sensor", base + DEBOUNCE_WINDOW_MS + 1);
    expect(listEventsForTarget("window:notepad")).toHaveLength(2);
  });

  it("action_guard events are NEVER debounced", () => {
    const base = 1000000;
    for (let i = 0; i < 5; i++) {
      makeEv("window:notepad", "action_attempted", "action_guard", base + i * 5);
    }
    expect(listEventsForTarget("window:notepad")).toHaveLength(5);
  });

  it("post_check events are NEVER debounced", () => {
    const base = 1000000;
    for (let i = 0; i < 3; i++) {
      makeEv("window:notepad", "action_succeeded", "post_check", base + i * 5);
    }
    expect(listEventsForTarget("window:notepad")).toHaveLength(3);
  });

  it("manual_lens events are NEVER debounced", () => {
    const base = 1000000;
    for (let i = 0; i < 3; i++) {
      makeEv("window:notepad", "target_bound", "manual_lens", base + i * 5);
    }
    expect(listEventsForTarget("window:notepad")).toHaveLength(3);
  });

  it("different semantics from sensor are debounced independently", () => {
    const base = 1000000;
    makeEv("window:notepad", "rect_changed", "sensor", base);
    makeEv("window:notepad", "title_changed", "sensor", base + 10);
    makeEv("window:notepad", "rect_changed", "sensor", base + 20);  // suppressed
    makeEv("window:notepad", "title_changed", "sensor", base + 30); // suppressed
    expect(listEventsForTarget("window:notepad")).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1c: Compaction
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1c: compactOlderThan", () => {
  it("compacts 10 old events into 1 compacted event", () => {
    const now = Date.now();
    const old = now - 20 * 60 * 1000;  // 20 minutes ago
    for (let i = 0; i < 10; i++) {
      appendEvent({
        targetKey: "window:notepad",
        identity: null,
        source: "sensor",
        semantic: "rect_changed",
        summary: `test ${i}`,
        tsMs: old + i * 1000,
      });
    }
    compactOlderThan(15 * 60 * 1000, now);
    const events = listEventsForTarget("window:notepad", 100);
    expect(events).toHaveLength(1);
    expect(events[0].semantic).toBe("compacted");
    expect(events[0].summary).toContain("10 rect_changed");
  });

  it("compaction summary includes minute count", () => {
    const now = Date.now();
    const old = now - 20 * 60 * 1000;
    appendEvent({ targetKey: "window:notepad", identity: null, source: "sensor", semantic: "rect_changed", summary: "r", tsMs: old });
    appendEvent({ targetKey: "window:notepad", identity: null, source: "sensor", semantic: "title_changed", summary: "t", tsMs: old + 1000 });
    appendEvent({ targetKey: "window:notepad", identity: null, source: "action_guard", semantic: "action_succeeded", summary: "a", tsMs: old + 2000 });
    compactOlderThan(15 * 60 * 1000, now);
    const events = listEventsForTarget("window:notepad", 100);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("rect_changed");
    expect(events[0].summary).toContain("title_changed");
    expect(events[0].summary).toContain("action_succeeded");
    expect(events[0].summary).toContain("15 min");
  });

  it("compactOlderThan is idempotent: 2nd call is no-op", () => {
    const now = Date.now();
    const old = now - 20 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      appendEvent({ targetKey: "window:notepad", identity: null, source: "sensor", semantic: "rect_changed", summary: "r", tsMs: old + i * 100 });
    }
    compactOlderThan(15 * 60 * 1000, now);
    compactOlderThan(15 * 60 * 1000, now);
    const events = listEventsForTarget("window:notepad", 100);
    expect(events).toHaveLength(1);
    expect(events[0].semantic).toBe("compacted");
  });

  it("recent events are not compacted", () => {
    const now = Date.now();
    makeEv("window:notepad", "rect_changed");  // tsMs ≈ now
    compactOlderThan(15 * 60 * 1000, now);
    expect(listEventsForTarget("window:notepad")).toHaveLength(1);
    expect(listEventsForTarget("window:notepad")[0].semantic).toBe("rect_changed");
  });

  it("single old event is not compacted (threshold: > 1)", () => {
    const now = Date.now();
    appendEvent({ targetKey: "window:notepad", identity: null, source: "sensor", semantic: "rect_changed", summary: "r", tsMs: now - 20 * 60 * 1000 });
    compactOlderThan(15 * 60 * 1000, now);
    expect(listEventsForTarget("window:notepad")[0].semantic).toBe("rect_changed");
  });

  it("compaction sweeper compacts stale events after period elapses", () => {
    vi.useFakeTimers();
    const now = 1_000_000_000;
    vi.setSystemTime(now - 20 * 60 * 1000);  // time of old events
    for (let i = 0; i < 5; i++) {
      appendEvent({ targetKey: "window:notepad", identity: null, source: "sensor", semantic: "rect_changed", summary: "r" });
    }
    vi.setSystemTime(now);
    startCompactionSweeper(1000);
    vi.advanceTimersByTime(1500);  // triggers one sweep
    stopCompactionSweeper();
    const events = listEventsForTarget("window:notepad", 100);
    expect(events.length).toBeLessThan(5);  // compaction ran
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-1: subscribe / unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe("D-1: subscribe / unsubscribe", () => {
  it("subscriber receives new events", () => {
    const received: TargetIdentityTimelineEvent[] = [];
    subscribe("window:notepad", ev => received.push(ev));
    makeEv("window:notepad", "target_bound");
    makeEv("window:other", "target_bound");
    expect(received).toHaveLength(1);
    expect(received[0].targetKey).toBe("window:notepad");
  });

  it("unsubscribe stops receiving events", () => {
    const received: TargetIdentityTimelineEvent[] = [];
    const unsub = subscribe("window:notepad", ev => received.push(ev));
    makeEv("window:notepad", "target_bound");
    unsub();
    makeEv("window:notepad", "action_attempted");
    expect(received).toHaveLength(1);
  });

  it("subscriber Map is cleaned up after unsubscribe", () => {
    const unsub = subscribe("window:notepad", () => {});
    unsub();
    // After unsub, no more entries for that key in _subscribers
    // We verify indirectly: appending should not throw
    expect(() => makeEv("window:notepad", "target_bound")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveTargetKey
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveTargetKey (shared from action-target.ts)", () => {
  it("window descriptor: normalizeTitle applied", () => {
    expect(deriveTargetKey({ kind: "window", titleIncludes: "Notepad - Google Chrome" }))
      .toBe("window:notepad");
  });

  it("browserTab with tabId", () => {
    expect(deriveTargetKey({ kind: "browserTab", tabId: "ABC", port: 9222 }))
      .toBe("browserTab:ABC");
  });

  it("browserTab with urlIncludes", () => {
    expect(deriveTargetKey({ kind: "browserTab", urlIncludes: "example.com", port: 9222 }))
      .toBe("browserTab:url:example.com");
  });

  it("coordinate with windowTitle", () => {
    expect(deriveTargetKey({ kind: "coordinate", x: 100, y: 200, windowTitle: "Notepad" }))
      .toBe("window:notepad");
  });

  it("coordinate without windowTitle returns null", () => {
    expect(deriveTargetKey({ kind: "coordinate", x: 100, y: 200 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveLensTargetKey
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveLensTargetKey", () => {
  it("derives key from window lens spec (normalizeTitle applied)", () => {
    // "- Google Chrome" is a browser suffix and will be stripped by normalizeTitle
    const fakeLens = {
      lensId: "lens-1",
      spec: { target: { kind: "window" as const, match: { titleIncludes: "Notepad - Google Chrome" } } },
      binding: { hwnd: "1000", windowTitle: "Notepad" },
      boundIdentity: {} as never,
      fluentKeys: [],
      registeredAtSeq: 0,
      registeredAtMs: 0,
    };
    expect(deriveLensTargetKey(fakeLens as never)).toBe("window:notepad");
  });

  it("derives key from plain window title without browser suffix", () => {
    const fakeLens = {
      lensId: "lens-1b",
      spec: { target: { kind: "window" as const, match: { titleIncludes: "Notepad" } } },
      binding: { hwnd: "1000", windowTitle: "Notepad" },
      boundIdentity: {} as never,
      fluentKeys: [],
      registeredAtSeq: 0,
      registeredAtMs: 0,
    };
    expect(deriveLensTargetKey(fakeLens as never)).toBe("window:notepad");
  });

  it("derives key from browserTab lens (hwnd = tabId, prefix preserved)", () => {
    const fakeLens = {
      lensId: "lens-2",
      spec: { target: { kind: "browserTab" as const, match: {} } },
      binding: { hwnd: "TAB-123", windowTitle: "" },
      boundIdentity: {} as never,
      fluentKeys: [],
      registeredAtSeq: 0,
      registeredAtMs: 0,
    };
    // browserTab prefix preserved; hwnd lowercased
    expect(deriveLensTargetKey(fakeLens as never)).toBe("browserTab:tab-123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _resetForTest
// ─────────────────────────────────────────────────────────────────────────────

describe("_resetForTest", () => {
  it("clears all internal state", () => {
    makeEv("window:notepad", "target_bound");
    makeEv("window:explorer", "target_bound");
    _resetForTest();
    expect(listEventsForTarget("window:notepad")).toEqual([]);
    expect(listAllRecent(100)).toEqual([]);
    expect(listRecentTargetKeys(10)).toEqual([]);
  });
});
