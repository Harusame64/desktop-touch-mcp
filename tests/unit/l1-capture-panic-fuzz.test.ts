// ADR-007 P5a panic-fuzz suite — shutdown/restart cycle, ring overflow with
// env-capped capacity, Failure event via l1PushFailure.
// Structure mirrors native-win32-panic-fuzz.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import { nativeL1 } from "../../src/engine/native-engine.js";

const native = nativeL1!;

describe.skipIf(!nativeL1)("ADR-007 P5a: L1 panic-fuzz", () => {
  afterAll(() => {
    // Leave worker running for other suites.
    nativeL1?.l1ShutdownForTest?.();
  });

  // ── shutdown / restart cycle ───────────────────────────────────────────────

  describe("5× shutdown → push → restart cycle (OnceLock<Mutex<Option<Arc<>>>> pattern)", () => {
    it("worker re-initialises after shutdown, each push returns a bigint", () => {
      for (let round = 0; round < 5; round++) {
        native.l1ShutdownForTest!();
        // After shutdown, next push must re-init the worker and succeed.
        const id = native.l1PushHwInputPostMessage!(0n, 0, 0n, BigInt(round));
        expect(typeof id).toBe("bigint");
        expect(id >= 0n).toBe(true);
      }
    });

    it("stats are fresh after each restart (push_count resets)", () => {
      native.l1ShutdownForTest!();
      // Push exactly 3 events into the fresh worker.
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 0n);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 1n);
      native.l1PushHwInputPostMessage!(0n, 0, 0n, 2n);
      const stats = native.l1GetCaptureStats!();
      // push_count includes the automatic SessionStart from worker_loop init.
      // At minimum it must be >= 3.
      expect(stats.pushCount >= 3n).toBe(true);
      // drop_count must be 0 (small push into fresh ring).
      expect(stats.dropCount).toBe(0n);
    });
  });

  // ── ring overflow with env capacity override ──────────────────────────────

  describe("ring overflow with DESKTOP_TOUCH_RING_CAPACITY=1024", () => {
    it("push 10_000 events → drop_count == push_count - 1024 (approx)", () => {
      native.l1ShutdownForTest!();

      const prevCap = process.env["DESKTOP_TOUCH_RING_CAPACITY"];
      process.env["DESKTOP_TOUCH_RING_CAPACITY"] = "1024";

      const pushCount = 10_000;
      for (let i = 0; i < pushCount; i++) {
        native.l1PushHwInputPostMessage!(0n, 0, 0n, BigInt(i));
      }

      const stats = native.l1GetCaptureStats!();
      // SessionStart is also pushed by the worker, but we can't control timing.
      // The invariant is: dropped + buffered == pushed.
      const pushed = Number(stats.pushCount);
      const dropped = Number(stats.dropCount);
      const buffered = Number(stats.currentBuffered);
      expect(pushed).toBeGreaterThanOrEqual(pushCount);
      expect(dropped + buffered).toBe(pushed);
      // With capacity 1024, at least pushCount - 1024 events must have dropped.
      expect(dropped).toBeGreaterThanOrEqual(pushCount - 1024);
      // Ring should be saturated (exactly 1024 buffered).
      expect(buffered).toBe(1024);

      native.l1ShutdownForTest!();
      if (prevCap === undefined) delete process.env["DESKTOP_TOUCH_RING_CAPACITY"];
      else process.env["DESKTOP_TOUCH_RING_CAPACITY"] = prevCap;
    });
  });

  // ── Failure event via l1PushFailure ──────────────────────────────────────

  describe("Failure event via l1PushFailure (panic simulation)", () => {
    it("l1PushFailure with panic_payload string returns event_id", () => {
      native.l1ShutdownForTest!();
      const id = native.l1PushFailure!(
        "L1-test",
        "worker_loop",
        "simulated_panic",
        "thread 'l1-capture' panicked at src/l1_capture/worker.rs:42",
        null,
        null,
      );
      expect(typeof id).toBe("bigint");
      expect(id >= 0n).toBe(true);
    });

    it("Failure event appears in poll results with a Buffer payload", () => {
      native.l1ShutdownForTest!();
      native.l1PollEvents!(0n, 100_000); // drain
      const stats0 = native.l1GetCaptureStats!();
      const since = stats0.eventIdHighWater;

      native.l1PushFailure!("L1-test", "crash_site", "TestReason", "stack trace here", null, null);
      const events = native.l1PollEvents!(since, 100);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const failureEv = events.find((e) => e.kind === 200 /* EventKind::Failure */);
      expect(failureEv).toBeDefined();
      expect(Buffer.isBuffer(failureEv!.payloadBytes)).toBe(true);
      expect(failureEv!.payloadBytes.length).toBeGreaterThan(0);
    });

    it("multiple l1PushFailure calls do not crash the process", () => {
      for (let i = 0; i < 10; i++) {
        const id = native.l1PushFailure!(`L${i}`, `op_${i}`, "stress", null, null, null);
        expect(typeof id).toBe("bigint");
      }
    });
  });

  // ── l1PushToolCallStarted / Completed round-trip ──────────────────────────

  describe("tool-call typed helpers survive adversarial args", () => {
    it("l1PushToolCallStarted with empty strings does not panic", () => {
      const id = native.l1PushToolCallStarted!("", "", null, null);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushToolCallStarted with very long args_json does not panic", () => {
      const bigJson = JSON.stringify({ x: "a".repeat(65536) });
      const id = native.l1PushToolCallStarted!("screenshot", bigJson, null, null);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushToolCallCompleted elapsed_ms = 0 does not panic", () => {
      const id = native.l1PushToolCallCompleted!("noop", 0, true, null, null, null);
      expect(typeof id).toBe("bigint");
    });

    it("l1PushToolCallCompleted with error_code does not panic", () => {
      const id = native.l1PushToolCallCompleted!("broken_tool", 999, false, "E_FAIL", null, null);
      expect(typeof id).toBe("bigint");
    });
  });

  // ── §13 acceptance item 14: PANIC_COUNTER hit → L1 ring Failure event ──────
  // l1TestForcePanic() panics inside napi_safe_call. The panic hook registered
  // by spawn_l1_inner() must push a Failure event (kind=200) to the L1 ring,
  // and PANIC_COUNTER must increment.

  describe.skipIf(typeof native.l1TestForcePanic !== "function")(
    "PANIC_COUNTER hit flows into L1 ring as Failure event (§13 item 14)",
    () => {
      it("l1TestForcePanic throws Error (panic caught by napi_safe_call)", () => {
        expect(() => native.l1TestForcePanic!()).toThrow();
      });

      it("panicCount increments after l1TestForcePanic", () => {
        native.l1ShutdownForTest!();
        native.l1PollEvents!(0n, 100_000); // drain
        const s0 = native.l1GetCaptureStats!();

        expect(() => native.l1TestForcePanic!()).toThrow();

        const s1 = native.l1GetCaptureStats!();
        expect(s1.panicCount > s0.panicCount).toBe(true);
      });

      it("Failure event (kind=200) appears in ring after l1TestForcePanic", () => {
        native.l1ShutdownForTest!();
        native.l1PollEvents!(0n, 100_000); // drain
        const s0 = native.l1GetCaptureStats!();
        const since = s0.eventIdHighWater;

        expect(() => native.l1TestForcePanic!()).toThrow();

        const events = native.l1PollEvents!(since, 100);
        const failureEv = events.find((e) => e.kind === 200);
        expect(failureEv).toBeDefined();
        // The Failure event must carry a payload describing the panic source.
        expect(Buffer.isBuffer(failureEv!.payloadBytes)).toBe(true);
        expect(failureEv!.payloadBytes.length).toBeGreaterThan(0);
      });
    },
  );
});
