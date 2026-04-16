/**
 * tests/unit/flush-scheduler.test.ts
 *
 * Unit tests for FlushScheduler — debounced sensor refresh scheduling.
 * Uses vitest fake timers for deterministic timer control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FlushScheduler, DEFAULT_DEBOUNCE_MS } from "../../src/engine/perception/flush-scheduler.js";

describe("FlushScheduler — default debounce", () => {
  it("DEFAULT_DEBOUNCE_MS exports expected values", () => {
    expect(DEFAULT_DEBOUNCE_MS.foreground).toBe(100);
    expect(DEFAULT_DEBOUNCE_MS.location).toBe(150);
    expect(DEFAULT_DEBOUNCE_MS.overflow).toBe(0);
    expect(DEFAULT_DEBOUNCE_MS.move_end).toBe(50);
  });
});

describe("FlushScheduler — trailing debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the debounce window for a single schedule call", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    scheduler.schedule("foreground", "fg1");
    expect(calls).toHaveLength(0); // not fired yet

    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS.foreground);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fg1");

    scheduler.dispose();
  });

  it("coalesces multiple schedule calls into one flush (trailing)", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    // 50 location events within 150ms → only one flush
    for (let i = 0; i < 50; i++) {
      scheduler.schedule("location", `loc${i}`);
      vi.advanceTimersByTime(2); // 2ms per event, 100ms total (< 150ms debounce)
    }
    expect(calls).toHaveLength(0); // still pending

    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS.location);
    expect(calls).toHaveLength(1);

    scheduler.dispose();
  });

  it("fires again after quiet window reset", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    scheduler.schedule("foreground", "fg1");
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS.foreground);
    expect(calls).toHaveLength(1);

    // Second batch
    scheduler.schedule("foreground", "fg2");
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS.foreground);
    expect(calls).toHaveLength(2);

    scheduler.dispose();
  });

  it("fires synchronously for overflow (debounce=0)", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    scheduler.schedule("overflow", "queue_overflow");
    // No timer advance needed — debounce=0 fires synchronously
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("queue_overflow");

    scheduler.dispose();
  });

  it("fires synchronously for move_start (debounce=0)", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    scheduler.schedule("move_start", "drag_started");
    expect(calls).toHaveLength(1);

    scheduler.dispose();
  });

  it("custom debounce override is respected", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({
      debounceMs: { foreground: 200 },
      onFlush: (r) => { calls.push(r); },
    });

    scheduler.schedule("foreground", "fg");
    vi.advanceTimersByTime(150); // less than 200ms
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(60); // total 210ms > 200ms
    expect(calls).toHaveLength(1);

    scheduler.dispose();
  });
});

describe("FlushScheduler — scheduleImmediate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels all pending timers and fires immediately", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    // Queue several pending
    scheduler.schedule("foreground", "fg");
    scheduler.schedule("location", "loc");
    expect(calls).toHaveLength(0);

    scheduler.scheduleImmediate("forced");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("forced");

    // Advance timers — no extra calls from the cancelled timers
    vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(1);

    scheduler.dispose();
  });
});

describe("FlushScheduler — dispose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispose cancels pending timers and ignores future schedule calls", () => {
    const calls: string[] = [];
    const scheduler = new FlushScheduler({ onFlush: (r) => { calls.push(r); } });

    scheduler.schedule("foreground", "fg");
    scheduler.dispose();

    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0); // timer was cancelled
  });
});
