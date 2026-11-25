/**
 * A wait answers by its timeoutMs, however slow one poll is.
 *
 * MEASURED on main (mac, headless Chrome): wait_until(element_matches) with intervalMs 5000 and
 * timeoutMs 1000 answered at 5003 ms; with one 6 s poll and timeoutMs 2000, at 6002 ms; and
 * url_matches on a page whose script held its thread answered at 15004 ms against timeoutMs 3000,
 * as BrowserNotConnected, though the browser was connected.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type EvalStep = () => Promise<unknown>;
const evalSteps: EvalStep[] = [];
let evalCalls = 0;
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  DEFAULT_CDP_PORT: 9222,
  portForTab: () => 9333,
  evaluateInTab: vi.fn().mockImplementation(async () => {
    evalCalls += 1;
    const step = evalSteps.shift();
    return step ? step() : "https://app.example.com/login";
  }),
}));
vi.mock("../../src/utils/desktop-config.js", () => ({ getCdpPort: () => 9333 }));
vi.mock("../../src/engine/win32.js", () => ({ enumWindowsInZOrder: () => [], getWindowProcessId: () => 0 }));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => ({ found: null, why: "element_not_found", via: "powershell" }),
}));

import { pollUntil } from "../../src/engine/poll.js";
import { waitUntilHandler, setBrowserSearchHook } from "../../src/tools/wait-until.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const payload = (r: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(r.content.find((b) => b.type === "text")!.text!);

beforeEach(() => {
  evalSteps.length = 0;
  evalCalls = 0;
});

describe("pollUntil answers by its timeout", () => {
  it("an interval longer than the time left is cut to it", async () => {
    let calls = 0;
    const t = Date.now();
    const r = await pollUntil(async () => { calls += 1; return null; }, { intervalMs: 5000, timeoutMs: 300 });
    const wall = Date.now() - t;
    expect(r.ok).toBe(false);
    expect(wall).toBeGreaterThanOrEqual(290);
    expect(wall).toBeLessThan(600);
    // No poll starts at or after the deadline.
    expect(calls).toBe(1);
    expect(r.ok === false && r.unfinishedPollMs).toBeUndefined();
  });

  it("a poll still running at the deadline is dropped and says how long it ran", async () => {
    const t = Date.now();
    const r = await pollUntil(async () => { await sleep(2000); return "late"; }, { intervalMs: 50, timeoutMs: 300 });
    const wall = Date.now() - t;
    expect(r.ok).toBe(false);
    expect(wall).toBeLessThan(600);
    expect(r.ok === false && r.unfinishedPollMs).toBeGreaterThanOrEqual(290);
  });

  it("a dropped poll that rejects later is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = await pollUntil(async () => { await sleep(400); throw new Error("late failure"); }, { intervalMs: 50, timeoutMs: 150 });
      expect(r.ok).toBe(false);
      await sleep(500);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a poll that throws before the deadline still throws", async () => {
    await expect(pollUntil(async () => { throw new Error("BrowserNotConnected: gone"); }, { intervalMs: 50, timeoutMs: 1000 }))
      .rejects.toThrow("BrowserNotConnected: gone");
  });

  it("a slow poll that answers before the deadline is the answer", async () => {
    const r = await pollUntil(async () => { await sleep(200); return "seen"; }, { intervalMs: 50, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, value: "seen" });
  });

  it("polls go on at the interval while time is left", async () => {
    let calls = 0;
    const r = await pollUntil(async () => (++calls === 4 ? "fourth" : null), { intervalMs: 50, timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, value: "fourth" });
    expect(calls).toBe(4);
  });
});

describe("wait_until answers by its timeoutMs", () => {
  it("element_matches with one slow poll answers WaitTimeout at the deadline, with lastPoll", async () => {
    setBrowserSearchHook(async () => { await sleep(2000); return []; });
    const t = Date.now();
    const out = payload(await waitUntilHandler({
      condition: "element_matches", target: { by: "text", pattern: "zz" }, timeoutMs: 300, intervalMs: 50,
    }));
    expect(Date.now() - t).toBeLessThan(700);
    expect(out.code).toBe("WaitTimeout");
    expect(out.context.lastPoll.answered).toBe(false);
    expect(out.context.lastPoll.ranMs).toBeGreaterThanOrEqual(250);
    expect(out.suggest[0]).toMatch(/^The last look had not answered when timeoutMs ran out/);
  });

  it("a wait whose last poll answered has no lastPoll and no such line", async () => {
    setBrowserSearchHook(async () => []);
    const out = payload(await waitUntilHandler({
      condition: "element_matches", target: { by: "text", pattern: "zz" }, timeoutMs: 200, intervalMs: 50,
    }));
    expect(out.code).toBe("WaitTimeout");
    expect(out.context).not.toHaveProperty("lastPoll");
    expect(out.suggest.join("\n")).not.toMatch(/had not answered/);
  });

  it("url_matches: a CDP call that timed out is waited past, not BrowserNotConnected", async () => {
    evalSteps.push(async () => { throw new Error("CDP timeout: Runtime.evaluate did not respond within 15000ms"); });
    evalSteps.push(async () => "https://app.example.com/dashboard");
    const out = payload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/dashboard" }, timeoutMs: 1000, intervalMs: 50,
    }));
    expect(out.ok).toBe(true);
    expect(evalCalls).toBe(2);
  });

  it("url_matches: a closed connection is still BrowserNotConnected at once", async () => {
    evalSteps.push(async () => { throw new Error("CDP connection closed unexpectedly"); });
    const t = Date.now();
    const out = payload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/dashboard" }, timeoutMs: 2000, intervalMs: 50,
    }));
    expect(Date.now() - t).toBeLessThan(500);
    expect(out.code).toBe("BrowserNotConnected");
  });
});
