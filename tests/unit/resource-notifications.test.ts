/**
 * tests/unit/resource-notifications.test.ts
 *
 * Unit tests for ResourceNotificationScheduler — coalesced attention-change notifications.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResourceNotificationScheduler } from "../../src/engine/perception/resource-notifications.js";
import type { AttentionState } from "../../src/engine/perception/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScheduler(
  attentionMap: Map<string, AttentionState>,
  onNotify: (uris: Set<string>) => void,
  debounceMs = 500
): ResourceNotificationScheduler {
  return new ResourceNotificationScheduler(
    (lensId) => [`perception://lens/${lensId}/summary`, `perception://lens/${lensId}/guards`],
    (lensId) => attentionMap.get(lensId),
    { onNotify },
    debounceMs,
  );
}

describe("ResourceNotificationScheduler — coalescing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires exactly once per debounce window for 100 attention changes", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris), 500);

    // Simulate ok → dirty transition
    attention.set("perc-1", "dirty");
    for (let i = 0; i < 100; i++) {
      sched.maybeNotify(new Set(["perc-1"]), "attention_change");
    }

    expect(notifications).toHaveLength(0); // pending

    vi.advanceTimersByTime(500);
    expect(notifications).toHaveLength(1); // coalesced into one

    sched.dispose();
  });

  it("ok → dirty fires notification (degradation)", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    attention.set("perc-1", "dirty");
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");

    vi.advanceTimersByTime(500);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].has("perception://lens/perc-1/summary")).toBe(true);

    sched.dispose();
  });

  it("ok → dirty → ok fires two notifications (degradation + recovery)", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    attention.set("perc-1", "dirty");
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");
    vi.advanceTimersByTime(500); // fire first notification

    attention.set("perc-1", "ok");
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");
    vi.advanceTimersByTime(500); // fire second notification

    expect(notifications).toHaveLength(2);

    sched.dispose();
  });

  it("ok → changed does NOT fire (changed alone is too noisy)", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    // "changed" is not a degradation from "ok" — both are "good"
    attention.set("perc-1", "changed" as AttentionState);
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");

    vi.advanceTimersByTime(500);
    // "changed" → no meaningful transition (both good)
    expect(notifications).toHaveLength(0);

    sched.dispose();
  });

  it("guard_failed → ok fires notification (recovery)", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "guard_failed"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    // Prime state with guard_failed
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");
    vi.advanceTimersByTime(500);

    attention.set("perc-1", "ok");
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");
    vi.advanceTimersByTime(500);

    expect(notifications.length).toBeGreaterThanOrEqual(1);

    sched.dispose();
  });

  it("no notification when attention stays the same", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    // Same attention over and over
    for (let i = 0; i < 10; i++) {
      sched.maybeNotify(new Set(["perc-1"]), "attention_change");
      vi.advanceTimersByTime(100);
    }

    expect(notifications).toHaveLength(0);
    sched.dispose();
  });
});

describe("ResourceNotificationScheduler — dispose", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("dispose cancels pending timers", () => {
    const attention = new Map<string, AttentionState>([["perc-1", "ok"]]);
    const notifications: Set<string>[] = [];
    const sched = makeScheduler(attention, (uris) => notifications.push(uris));

    attention.set("perc-1", "dirty");
    sched.maybeNotify(new Set(["perc-1"]), "attention_change");

    sched.dispose();
    vi.advanceTimersByTime(1000);

    expect(notifications).toHaveLength(0); // cancelled
  });
});
