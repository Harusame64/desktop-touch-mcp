/**
 * internal #403, gate 2 on #981 — the CDP wheel's verdict (WHEEL_VERDICT_FN) times each of its waits from its own
 * start: "seen" from when the verdict is asked, the first move from when the page saw the wheel, the settle from
 * the first move. Timed all from the call, a wheel seen late had almost nothing left of the move wait (and was
 * answered room_not_moved while it scrolled), and a move found late had its settle cut short.
 *
 * The function runs here as shipped, on a stand-in observer and element, with a fake clock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WHEEL_VERDICT_FN, type WheelVerdict } from "../../src/engine/cdp-bridge.js";
import { CDP_WHEEL_SEEN_MS, CDP_WHEEL_SETTLE_MS, CDP_WHEEL_MAX_MS } from "../../src/tools/_input-pipeline.js";

interface El { scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number; isConnected: boolean; tagName: string; id: string }
interface Obs { seen: boolean; seenAt: number; ended: boolean; path: El[]; pre: number[]; ev: null; vertical: boolean; cleanup: () => void }

const verdictFn = new Function(`return ${WHEEL_VERDICT_FN}`)() as (this: Obs, sign: number, seenMs: number, settleMs: number, maxMs: number) => Promise<WheelVerdict>;

let pane: El;
let obs: Obs;
let answeredAt: number | undefined;

function ask(): Promise<WheelVerdict> {
  const p = verdictFn.call(obs, 1, CDP_WHEEL_SEEN_MS, CDP_WHEEL_SETTLE_MS, CDP_WHEEL_MAX_MS);
  void p.then(() => { answeredAt = performance.now(); });
  return p;
}
function seeWheel(): void { obs.seen = true; obs.seenAt = performance.now(); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  pane = { scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, clientHeight: 400, scrollWidth: 300, clientWidth: 300, isConnected: true, tagName: "DIV", id: "L" };
  const root = { ...pane, scrollHeight: 400, id: "" };
  vi.stubGlobal("document", { scrollingElement: root, documentElement: root, body: null });
  vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto", overflowX: "hidden", display: "block", direction: "ltr", flexDirection: "row" }));
  obs = { seen: false, seenAt: 0, ended: false, path: [pane], pre: [0], ev: null, vertical: true, cleanup: () => {} };
  answeredAt = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the CDP wheel verdict times each wait from its own start", () => {
  it("a wheel seen late still gets the whole move wait: seen at 240 ms, moved 160 ms later, answered moved", async () => {
    const t0 = performance.now();
    const p = ask();
    await vi.advanceTimersByTimeAsync(240);
    seeWheel();
    await vi.advanceTimersByTimeAsync(160);
    pane.scrollTop = 120;
    await vi.advanceTimersByTimeAsync(1000);
    const v = await p;
    expect(v).toMatchObject({ seen: true, moved: "div#L" });
    expect(v.under).toBeUndefined();
    expect(answeredAt! - t0).toBeGreaterThan(240 + 160 + CDP_WHEEL_SETTLE_MS);
  });

  it("nothing moving is answered from when the wheel was seen, not from the call", async () => {
    const t0 = performance.now();
    const p = ask();
    await vi.advanceTimersByTimeAsync(200);
    seeWheel();
    await vi.advanceTimersByTimeAsync(CDP_WHEEL_MAX_MS - 20);
    expect(answeredAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    const v = await p;
    expect(v).toMatchObject({ seen: true, under: "room", underLabel: "div#L" });
    expect(v.moved).toBeUndefined();
    expect(answeredAt! - t0).toBeGreaterThan(200 + CDP_WHEEL_MAX_MS);
    expect(answeredAt! - t0).toBeLessThan(200 + CDP_WHEEL_MAX_MS + 40);
  });

  it("a move found late keeps its whole settle: no scrollend, answered only settleMs after the first move", async () => {
    const t0 = performance.now();
    const p = ask();
    seeWheel();
    await vi.advanceTimersByTimeAsync(CDP_WHEEL_MAX_MS - 40);
    pane.scrollTop = 30;
    await vi.advanceTimersByTimeAsync(CDP_WHEEL_SETTLE_MS - 40);
    expect(answeredAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ moved: "div#L" });
    expect(answeredAt! - t0).toBeGreaterThan(CDP_WHEEL_MAX_MS - 40 + CDP_WHEEL_SETTLE_MS);
  });

  it("a scrollend on the path ends the settle at once", async () => {
    const t0 = performance.now();
    const p = ask();
    seeWheel();
    pane.scrollTop = 120;
    obs.ended = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ moved: "div#L" });
    expect(answeredAt! - t0).toBeLessThan(40);
  });

  it("a wheel never seen is given up seenMs after the call", async () => {
    const t0 = performance.now();
    const p = ask();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toMatchObject({ seen: false });
    expect(answeredAt! - t0).toBeGreaterThan(CDP_WHEEL_SEEN_MS);
    expect(answeredAt! - t0).toBeLessThan(CDP_WHEEL_SEEN_MS + 40);
  });
});
