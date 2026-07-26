/**
 * tests/unit/failsafe-wrap.test.ts
 *
 * Regression test for Codex PR #40 (P1) — `s.registerTool` was not being
 * monkey-patched in `createMcpServer`, so Phase 2/3 dispatchers
 * (keyboard / clipboard / window_dock / scroll / terminal / browser_eval)
 * silently bypassed the failsafe pre-check. The fix factors the wrapping
 * logic into `wrapHandlerArg` so it can be applied uniformly to both
 * `s.tool` and `s.registerTool` and exercised in isolation here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  wrapHandlerArg,
  getActiveToolCallCount,
  getActiveToolCallIds,
  _resetActiveToolCallsForTest,
} from "../../src/utils/failsafe-wrap.js";

describe("wrapHandlerArg", () => {
  it("wraps the last argument so preCheck runs before the original handler", async () => {
    const order: string[] = [];
    const preCheck = vi.fn(async () => {
      order.push("preCheck");
    });
    const original = vi.fn(async (...args: unknown[]) => {
      order.push(`original:${JSON.stringify(args)}`);
      return "ok";
    });

    const toolArgs: unknown[] = ["toolName", { description: "desc" }, original];
    wrapHandlerArg(toolArgs, preCheck);

    const wrapped = toolArgs[2] as (...args: unknown[]) => Promise<unknown>;
    const result = await wrapped("a", 1);

    expect(result).toBe("ok");
    expect(order).toEqual(["preCheck", `original:["a",1]`]);
    expect(preCheck).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("forwards arguments verbatim to the original handler", async () => {
    const original = vi.fn(async () => null);
    const preCheck = vi.fn(async () => {});
    const args: unknown[] = ["name", original];
    wrapHandlerArg(args, preCheck);
    await (args[1] as (...a: unknown[]) => Promise<unknown>)(
      { foo: "bar" },
      [1, 2, 3],
      "literal",
    );
    expect(original).toHaveBeenCalledWith({ foo: "bar" }, [1, 2, 3], "literal");
  });

  it("propagates preCheck rejection without invoking the original handler", async () => {
    const original = vi.fn(async () => "should-not-run");
    const preCheck = vi.fn(async () => {
      throw new Error("emergency-stop");
    });
    const args: unknown[] = ["name", original];
    wrapHandlerArg(args, preCheck);

    await expect(
      (args[1] as (...a: unknown[]) => Promise<unknown>)(),
    ).rejects.toThrow(/emergency-stop/);
    expect(original).not.toHaveBeenCalled();
  });

  it("works with the s.tool 4-arg shape (name, desc, schema, handler)", async () => {
    const order: string[] = [];
    const preCheck = vi.fn(async () => order.push("preCheck"));
    const handler = vi.fn(async () => order.push("handler"));
    const args: unknown[] = ["myTool", "description", { x: "schema" }, handler];

    wrapHandlerArg(args, preCheck);
    await (args[3] as () => Promise<unknown>)();

    expect(order).toEqual(["preCheck", "handler"]);
    // First three args untouched
    expect(args[0]).toBe("myTool");
    expect(args[1]).toBe("description");
    expect(args[2]).toEqual({ x: "schema" });
  });

  it("works with the s.registerTool 3-arg shape (name, config, handler)", async () => {
    const order: string[] = [];
    const preCheck = vi.fn(async () => order.push("preCheck"));
    const handler = vi.fn(async () => order.push("handler"));
    const args: unknown[] = [
      "browser_eval",
      { description: "...", inputSchema: { x: "schema" } },
      handler,
    ];

    wrapHandlerArg(args, preCheck);
    await (args[2] as () => Promise<unknown>)();

    expect(order).toEqual(["preCheck", "handler"]);
    expect(args[0]).toBe("browser_eval");
    expect(typeof args[1]).toBe("object");
  });

  it("returns the same array reference (mutates in place)", () => {
    const args: unknown[] = ["name", async () => null];
    const result = wrapHandlerArg(args, async () => {});
    expect(result).toBe(args);
  });

  it("is a no-op on empty args", () => {
    const args: unknown[] = [];
    const result = wrapHandlerArg(args, async () => {});
    expect(result).toEqual([]);
  });

  it("is a no-op when the last arg is not a function (defensive)", () => {
    const args: unknown[] = ["name", { not: "a function" }];
    const before = args[1];
    wrapHandlerArg(args, async () => {});
    // Last arg unchanged
    expect(args[1]).toBe(before);
  });
});

/**
 * ADR-030 Phase 1 (AC6 / plan §4.5) — the ACTIVE tool-call counter: the
 * failsafe watcher's exit-gate input. The load-bearing property is that a
 * call the pre-check REFUSES never counts (plan Round 4 Codex P2: gating the
 * watcher on the transport-level inflight — which counts refusals — let an
 * idle corner-park plus an LLM retry burst kill the server anyway).
 */
describe("wrapHandlerArg — active tool-call counter (ADR-030)", () => {
  beforeEach(() => {
    _resetActiveToolCallsForTest();
  });

  function wrap(
    handler: (...a: unknown[]) => Promise<unknown>,
    preCheck: () => Promise<void> = async () => {},
  ): (...a: unknown[]) => Promise<unknown> {
    const args: unknown[] = ["tool", handler];
    wrapHandlerArg(args, preCheck);
    return args[1] as (...a: unknown[]) => Promise<unknown>;
  }

  it("a refused call never increments: handler not invoked, counter stays 0 throughout", async () => {
    const handler = vi.fn(async () => "never");
    const wrapped = wrap(handler, async () => {
      // Observed DURING the pre-check too — the refusal path must never
      // have bumped the counter at any point.
      expect(getActiveToolCallCount()).toBe(0);
      throw new Error("FAILSAFE refused");
    });
    await expect(wrapped()).rejects.toThrow(/FAILSAFE refused/);
    expect(handler).not.toHaveBeenCalled();
    expect(getActiveToolCallCount()).toBe(0);
  });

  it("counts 1 while the handler runs, 0 after it resolves", async () => {
    let during = -1;
    const wrapped = wrap(async () => {
      during = getActiveToolCallCount();
      return "ok";
    });
    expect(getActiveToolCallCount()).toBe(0);
    await wrapped();
    expect(during).toBe(1);
    expect(getActiveToolCallCount()).toBe(0);
  });

  it("decrements when the handler rejects (no leak on the failure path)", async () => {
    const wrapped = wrap(async () => {
      throw new Error("handler failed");
    });
    await expect(wrapped()).rejects.toThrow(/handler failed/);
    expect(getActiveToolCallCount()).toBe(0);
  });

  it("decrements when the handler throws synchronously (no leak)", async () => {
    const wrapped = wrap((() => {
      throw new Error("sync throw");
    }) as unknown as (...a: unknown[]) => Promise<unknown>);
    await expect(wrapped()).rejects.toThrow(/sync throw/);
    expect(getActiveToolCallCount()).toBe(0);
  });

  it("two interleaved calls: 2 while both run, 1 after the first settles, 0 after both; never negative", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    const wrappedA = wrap(async () => gateA);
    const wrappedB = wrap(async () => gateB);

    const pA = wrappedA();
    const pB = wrappedB();
    // Both passed the pre-check and are executing (macrotask hop lets the
    // wrappers advance past their pre-check awaits deterministically).
    await new Promise((r) => setTimeout(r, 0));
    expect(getActiveToolCallCount()).toBe(2);

    releaseA();
    await pA;
    expect(getActiveToolCallCount()).toBe(1);

    releaseB();
    await pB;
    expect(getActiveToolCallCount()).toBe(0);
  });

  it("concurrent calls get DISTINCT ids, and each id disappears when its own call settles", async () => {
    // The watcher intersects trigger-time ids with post-await ids to tell a surviving triggering
    // call from a brand-new one (Codex Round 5 P2). That only works if ids are unique per call and
    // the `finally` removes exactly the call's own id.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const wrappedA = wrap(async () => new Promise<void>((r) => (releaseA = r)));
    const wrappedB = wrap(async () => new Promise<void>((r) => (releaseB = r)));

    const pA = wrappedA();
    const pB = wrappedB();
    await new Promise((r) => setTimeout(r, 0));

    const both = getActiveToolCallIds();
    expect(both).toHaveLength(2);
    expect(new Set(both).size).toBe(2); // distinct — not one id reused
    const [idA, idB] = both;

    releaseA();
    await pA;
    expect(getActiveToolCallIds()).toEqual([idB]); // A's id, and only A's, was removed

    releaseB();
    await pB;
    expect(getActiveToolCallIds()).toEqual([]);
    void idA;
  });

  it("getActiveToolCallIds hands out a fresh copy (the watcher holds its snapshot across an await)", async () => {
    let release!: () => void;
    const wrapped = wrap(async () => new Promise<void>((r) => (release = r)));
    const p = wrapped();
    await new Promise((r) => setTimeout(r, 0));

    const snapshot = getActiveToolCallIds();
    expect(snapshot).toHaveLength(1);
    release();
    await p;
    // Mutating the registry must not rewrite a snapshot taken earlier.
    expect(snapshot).toHaveLength(1);
    expect(getActiveToolCallIds()).toEqual([]);
  });

  it("_resetActiveToolCallsForTest zeroes the counter (test isolation)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const wrapped = wrap(async () => gate);
    const p = wrapped();
    await new Promise((r) => setTimeout(r, 0));
    expect(getActiveToolCallCount()).toBe(1);
    _resetActiveToolCallsForTest();
    expect(getActiveToolCallCount()).toBe(0);
    release();
    await p; // decrement runs after reset — goes negative only if reset misused mid-flight; drain cleanly
    _resetActiveToolCallsForTest();
    expect(getActiveToolCallCount()).toBe(0);
  });
});
