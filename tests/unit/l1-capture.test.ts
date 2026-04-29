// ADR-007 P5a — L1 capture core unit tests.
// push via typed helpers, poll cursor, drop-oldest, stats integrity.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeL1 } from "../../src/engine/native-engine.js";

const native = nativeL1!;

describe.skipIf(!nativeL1)("ADR-007 P5a: L1 capture core", () => {
  beforeAll(async () => {
    // Ensure a clean worker before the suite starts.
    nativeL1?.l1ShutdownForTest?.();
    // First push will re-init the worker.
  });

  afterAll(() => {
    nativeL1?.l1ShutdownForTest?.();
  });

  // ── Basic push + poll ─────────────────────────────────────────────────────

  describe("push + poll round-trip via l1PushHwInputPostMessage", () => {
    it("returns a bigint event_id >= 0n", () => {
      const id = native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      expect(typeof id).toBe("bigint");
      expect(id >= 0n).toBe(true);
    });

    it("poll(0n, 100) returns at least the events just pushed", () => {
      // Push 5 events and then poll.
      for (let i = 0; i < 5; i++) {
        native.l1PushHwInputPostMessage!(0n, 0, 0n, BigInt(i));
      }
      const events = native.l1PollEvents!(0n, 100);
      // The ring may already hold events from other tests / SessionStart /
      // Heartbeats; we only assert we got some.
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("event_id values in a poll batch are monotonically increasing", () => {
      // Drain any stale events first, then push fresh batch.
      native.l1PollEvents!(0n, 100_000);
      const stats0 = native.l1GetCaptureStats!();
      const since = stats0.eventIdHighWater;

      for (let i = 0; i < 10; i++) {
        native.l1PushHwInputPostMessage!(0n, 0x0100 /* WM_KEYDOWN */, BigInt(i), 0n);
      }
      const events = native.l1PollEvents!(since, 100);
      expect(events.length).toBeGreaterThanOrEqual(10);

      for (let i = 1; i < events.length; i++) {
        expect(events[i].eventId > events[i - 1].eventId).toBe(true);
      }
    });

    it("poll with since_event_id excludes events already seen", () => {
      native.l1PollEvents!(0n, 100_000); // drain
      const id1 = native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const id2 = native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const id3 = native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);

      // Poll with cursor = id2; should only see id3
      const events = native.l1PollEvents!(id2, 100);
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (const ev of events) {
        expect(ev.eventId > id2).toBe(true);
      }
      void id1;
      void id3;
    });
  });

  // ── EventEnvelope field shapes ─────────────────────────────────────────────

  describe("EventEnvelope field shapes", () => {
    it("envelopeVersion is 1", () => {
      native.l1PollEvents!(0n, 100_000);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const events = native.l1PollEvents!(0n, 100);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const ev = events[events.length - 1];
      expect(ev.envelopeVersion).toBe(1);
    });

    it("wallclockMs is a reasonable unix timestamp (> 2025-01-01)", () => {
      native.l1PollEvents!(0n, 100_000);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const events = native.l1PollEvents!(0n, 100);
      const ev = events[events.length - 1];
      // 2025-01-01 as ms ≈ 1_735_689_600_000n
      expect(ev.wallclockMs >= 1_735_689_600_000n).toBe(true);
    });

    it("payloadBytes is a Buffer", () => {
      native.l1PollEvents!(0n, 100_000);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const events = native.l1PollEvents!(0n, 100);
      const ev = events[events.length - 1];
      expect(Buffer.isBuffer(ev.payloadBytes)).toBe(true);
      expect(ev.payloadBytes.length).toBeGreaterThan(0);
    });

    it("timestampSource is 0 (StdTime) in P5a", () => {
      native.l1PollEvents!(0n, 100_000);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const events = native.l1PollEvents!(0n, 100);
      const ev = events[events.length - 1];
      expect(ev.timestampSource).toBe(0); // TimestampSource::StdTime
    });
  });

  // ── drop-oldest (ring overflow) ────────────────────────────────────────────

  describe("drop-oldest semantics when ring overflows", () => {
    it("push_count == polled + buffered + dropped after overflow", () => {
      // Shut down + restart with small capacity.
      native.l1ShutdownForTest!();

      const prev = process.env["DESKTOP_TOUCH_RING_CAPACITY"];
      process.env["DESKTOP_TOUCH_RING_CAPACITY"] = "1024";

      // Push 2000 events — 976 are dropped, 1024 remain in ring.
      for (let i = 0; i < 2000; i++) {
        native.l1PushHwInputPostMessage!(0n, 0, 0n, BigInt(i));
      }

      const stats = native.l1GetCaptureStats!();
      // push_count includes SessionStart from worker init
      const pushed = Number(stats.pushCount);
      const dropped = Number(stats.dropCount);
      const buffered = Number(stats.currentBuffered);
      // Invariant: pushed == dropped + buffered (drained count is 0 here since we haven't polled)
      expect(pushed).toBeGreaterThanOrEqual(2000);
      expect(dropped + buffered).toBe(pushed);

      native.l1ShutdownForTest!();
      if (prev === undefined) delete process.env["DESKTOP_TOUCH_RING_CAPACITY"];
      else process.env["DESKTOP_TOUCH_RING_CAPACITY"] = prev;
    });
  });

  // ── Typed push helpers — panic-safety for adversarial inputs ──────────────

  describe("typed push helpers survive adversarial inputs", () => {
    it("l1PushHwInputPostMessage(0n, 0, 0n, 0n) — null hwnd returns event_id", () => {
      const id = native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushHwInputPostMessage(maxU64, 0, 0n, -1n) — all-ones hwnd, bit-31 lParam survives", () => {
      const id = native.l1PushHwInputPostMessage!(0xffff_ffff_ffff_ffffn, 0, 0n, -1n);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushFailure with long strings does not panic", () => {
      const long = "x".repeat(4096);
      const id = native.l1PushFailure!("L9-fake", long, "FakeReason", null, null, null);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushToolCallStarted returns a bigint event_id", () => {
      const id = native.l1PushToolCallStarted!("test_tool", "{}", undefined, undefined);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushToolCallCompleted returns a bigint event_id", () => {
      const id = native.l1PushToolCallCompleted!("test_tool", 42, true, undefined, undefined, undefined);
      expect(typeof id).toBe("bigint");
    });
  });

  // ── l1GetCaptureStats integrity ────────────────────────────────────────────

  describe("l1GetCaptureStats integrity", () => {
    it("push_count increases after each push", () => {
      const s0 = native.l1GetCaptureStats!();
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const s1 = native.l1GetCaptureStats!();
      expect(s1.pushCount > s0.pushCount).toBe(true);
    });

    it("event_id_high_water increases after each push", () => {
      const s0 = native.l1GetCaptureStats!();
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      const s1 = native.l1GetCaptureStats!();
      expect(s1.eventIdHighWater > s0.eventIdHighWater).toBe(true);
    });

    it("uptime_ms is > 0n after worker starts", () => {
      const s = native.l1GetCaptureStats!();
      expect(s.uptimeMs > 0n).toBe(true);
    });

    it("panicCount is a non-negative bigint", () => {
      const s = native.l1GetCaptureStats!();
      expect(typeof s.panicCount).toBe("bigint");
      expect(s.panicCount >= 0n).toBe(true);
    });

    it("push_count == drop_count + current_buffered after push-only (no poll)", () => {
      native.l1ShutdownForTest!();
      // Fresh worker: push 10, no poll.
      for (let i = 0; i < 10; i++) {
        native.l1PushHwInputPostMessage!(0n, 0, 0n, BigInt(i));
      }
      const s = native.l1GetCaptureStats!();
      const pushed = Number(s.pushCount);
      const dropped = Number(s.dropCount);
      const buffered = Number(s.currentBuffered);
      expect(pushed).toBe(dropped + buffered);
    });
  });
});
