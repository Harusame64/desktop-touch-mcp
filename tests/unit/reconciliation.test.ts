/**
 * tests/unit/reconciliation.test.ts
 *
 * Unit tests for ReconciliationScheduler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReconciliationScheduler } from "../../src/engine/perception/reconciliation.js";
import { DirtyJournal } from "../../src/engine/perception/dirty-journal.js";
import { createLensEventIndex } from "../../src/engine/perception/lens-event-index.js";
import type { PerceptionLens } from "../../src/engine/perception/types.js";

function makeScheduler(onReconcile: ConstructorParameters<typeof ReconciliationScheduler>[4]["onReconcile"]) {
  const journal = new DirtyJournal();
  journal.__resetForTests();
  const index = createLensEventIndex();

  return new ReconciliationScheduler(
    () => [] as PerceptionLens[],
    () => journal,
    () => index,
    () => new Set(["100", "200"]),
    { onReconcile },
  );
}

describe("ReconciliationScheduler — triggerImmediate", () => {
  it("calls onReconcile immediately with overflow trigger when dirty", () => {
    const calls: string[] = [];
    const journal = new DirtyJournal();
    journal.__resetForTests();
    journal.mark({ entityKey: "window:100", props: ["target.rect"], cause: "move", monoMs: 100 });

    const index = createLensEventIndex();
    const scheduler = new ReconciliationScheduler(
      () => [],
      () => journal,
      () => index,
      () => new Set(["100"]),
      {
        onReconcile: (opts) => { calls.push(opts.trigger); },
      }
    );

    scheduler.triggerImmediate();
    expect(calls).toContain("overflow");
    scheduler.stop();
  });

  it("calls onReconcile even when nothing is dirty (overflow forces full sweep)", () => {
    const calls: unknown[] = [];
    const scheduler = makeScheduler((opts) => calls.push(opts));
    scheduler.triggerImmediate();
    // overflow always reconciles regardless of dirty state
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });
});

describe("ReconciliationScheduler — sweep timer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT fire sweep when nothing is dirty", () => {
    const calls: unknown[] = [];
    const scheduler = makeScheduler((opts) => calls.push(opts));
    scheduler.start();

    vi.advanceTimersByTime(5_001);
    expect(calls).toHaveLength(0); // nothing dirty → skip

    scheduler.stop();
  });

  it("fires sweep when there are dirty entries", () => {
    const journal = new DirtyJournal();
    journal.__resetForTests();
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 100 });

    const index = createLensEventIndex();
    const calls: unknown[] = [];
    const scheduler = new ReconciliationScheduler(
      () => [],
      () => journal,
      () => index,
      () => new Set(["100"]),
      { onReconcile: (opts) => calls.push(opts) }
    );
    scheduler.start();

    vi.advanceTimersByTime(5_001);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { trigger: string }).trigger).toBe("sweep");

    scheduler.stop();
  });

  it("stop() prevents future sweeps", () => {
    const journal = new DirtyJournal();
    journal.__resetForTests();
    journal.mark({ entityKey: "window:100", props: ["target.foreground"], cause: "fg", monoMs: 100 });

    const index = createLensEventIndex();
    const calls: unknown[] = [];
    const scheduler = new ReconciliationScheduler(
      () => [],
      () => journal,
      () => index,
      () => new Set(["100"]),
      { onReconcile: (opts) => calls.push(opts) }
    );
    scheduler.start();
    scheduler.stop();

    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(0); // stopped before any sweep
  });
});
