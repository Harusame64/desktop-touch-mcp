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

import { describe, it, expect, vi } from "vitest";
import { wrapHandlerArg } from "../../src/utils/failsafe-wrap.js";

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
