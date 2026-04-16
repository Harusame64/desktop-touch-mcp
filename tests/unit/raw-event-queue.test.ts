/**
 * tests/unit/raw-event-queue.test.ts
 *
 * Unit tests for RawEventQueue — bounded ring buffer for WinEvents.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RawEventQueue } from "../../src/engine/perception/raw-event-queue.js";
import type { RawWinEvent } from "../../src/engine/perception/raw-event-queue.js";

function makeEvent(seq: number, hwnd = "100"): RawWinEvent {
  return {
    event: 0x0003, // EVENT_SYSTEM_FOREGROUND
    hwnd,
    idObject: 0,
    idChild: 0,
    eventThread: 1234,
    sourceEventTimeMs: 0,
    sidecarSeq: seq,
    receivedAtMonoMs: seq * 10,
    receivedAtUnixMs: 1700000000000 + seq,
    globalSeq: seq,
  };
}

describe("RawEventQueue — basic operations", () => {
  let queue: RawEventQueue;

  beforeEach(() => {
    queue = new RawEventQueue({ maxSize: 8, batchMax: 4 });
    queue.__resetForTests();
  });

  it("starts empty with zero diagnostics", () => {
    const d = queue.diagnostics();
    expect(d.pendingCount).toBe(0);
    expect(d.totalEnqueued).toBe(0);
    expect(d.totalDropped).toBe(0);
    expect(queue.overflowPending).toBe(false);
  });

  it("enqueues events and returns them via drain", () => {
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    const batch = queue.drain();
    expect(batch).toHaveLength(2);
    expect(batch[0].sidecarSeq).toBe(1);
    expect(batch[1].sidecarSeq).toBe(2);
  });

  it("drain returns at most batchMax events", () => {
    for (let i = 1; i <= 6; i++) queue.enqueue(makeEvent(i));
    const batch = queue.drain();
    expect(batch).toHaveLength(4); // batchMax=4
    expect(queue.pendingCount).toBe(2);
  });

  it("drain returns empty array when queue is empty", () => {
    expect(queue.drain()).toHaveLength(0);
  });

  it("drain clears overflowPending", () => {
    // Fill to overflow
    for (let i = 1; i <= 9; i++) queue.enqueue(makeEvent(i));
    expect(queue.overflowPending).toBe(true);
    queue.drain();
    expect(queue.overflowPending).toBe(false);
  });
});

describe("RawEventQueue — overflow behavior", () => {
  it("drops oldest when maxSize is exceeded", () => {
    const queue = new RawEventQueue({ maxSize: 3, batchMax: 10 });

    queue.enqueue(makeEvent(1)); // will be dropped
    queue.enqueue(makeEvent(2));
    queue.enqueue(makeEvent(3));
    queue.enqueue(makeEvent(4)); // triggers overflow, drops seq=1

    const batch = queue.drain();
    const seqs = batch.map(e => e.sidecarSeq);
    expect(seqs).not.toContain(1); // oldest dropped
    expect(seqs).toContain(4);
    expect(queue.diagnostics().totalDropped).toBe(1);
    expect(queue.diagnostics().overflowCount).toBe(1);
  });

  it("sets overflowPending on overflow", () => {
    const queue = new RawEventQueue({ maxSize: 2, batchMax: 10 });
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    expect(queue.overflowPending).toBe(false);
    queue.enqueue(makeEvent(3)); // overflow
    expect(queue.overflowPending).toBe(true);
  });

  it("multiple overflows accumulate overflowCount", () => {
    const queue = new RawEventQueue({ maxSize: 2, batchMax: 10 });
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    queue.enqueue(makeEvent(3)); // overflow 1
    queue.enqueue(makeEvent(4)); // overflow 2
    expect(queue.diagnostics().overflowCount).toBe(2);
    expect(queue.diagnostics().totalDropped).toBe(2);
  });

  it("diagnostics track totalEnqueued and totalDrained accurately", () => {
    const queue = new RawEventQueue({ maxSize: 10, batchMax: 4 });
    for (let i = 1; i <= 6; i++) queue.enqueue(makeEvent(i));
    queue.drain();
    const d = queue.diagnostics();
    expect(d.totalEnqueued).toBe(6);
    expect(d.totalDrained).toBe(4);
    expect(d.pendingCount).toBe(2);
  });
});

describe("RawEventQueue — __resetForTests", () => {
  it("clears all state", () => {
    const queue = new RawEventQueue({ maxSize: 4, batchMax: 4 });
    queue.enqueue(makeEvent(1));
    queue.enqueue(makeEvent(2));
    queue.enqueue(makeEvent(3));
    queue.enqueue(makeEvent(4));
    queue.enqueue(makeEvent(5)); // overflow
    queue.__resetForTests();
    const d = queue.diagnostics();
    expect(d.pendingCount).toBe(0);
    expect(d.totalEnqueued).toBe(0);
    expect(d.overflowCount).toBe(0);
    expect(queue.overflowPending).toBe(false);
  });
});
