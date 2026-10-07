/**
 * internal #235, arm 9 — the first batch of a new DXGI duplication is the desktop's initial image.
 *
 * win2 measured it on every `miss-init`, 6 of 6: one rect covering the whole output, then ordinary
 * rects. Rects are in desktop coordinates, so the image is matched against the output's bounds, not
 * the origin. While the dirty-rect router ran it held the broker warm and no consumer saw
 * that batch; with the router opt-in, the first consumer after a 20 s idle would count it as a
 * repaint. The production factory drops exactly that shape and passes everything else on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Rect = { x: number; y: number; width: number; height: number };

const nativeBatches = vi.hoisted(() => ({ queue: [] as Rect[][] }));

vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeDirtyRectSubscription {
    isDisposed = false;
    readonly outputBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    constructor(readonly outputIndex: number) {}
    async next(): Promise<Rect[]> { return nativeBatches.queue.shift() ?? []; }
    dispose(): void { this.isDisposed = true; }
  }
  return { ...actual, nativeDuplication: { DirtyRectSubscription: FakeDirtyRectSubscription } };
});

const { dropInitialDesktopImage, getSharedDirtyRectBroker, disposeSharedDirtyRectBroker } = await import(
  "../../src/engine/dxgi-broker.js"
);

const FULL: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const WINDOW: Rect = { x: 560, y: 240, width: 800, height: 600 };
const PRIMARY: Rect = FULL;
const SECONDARY: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };
const CORNER: Rect = { x: 0, y: 0, width: 40, height: 20 };

function stubOf(batches: Rect[][]) {
  const queue = [...batches];
  const stub = {
    isDisposed: false,
    next: vi.fn(async () => queue.shift() ?? []),
    dispose: vi.fn(() => { stub.isDisposed = true; }),
  };
  return stub;
}

async function drain(sub: { next(t: number): Promise<Rect[]> }, n: number): Promise<Rect[][]> {
  const out: Rect[][] = [];
  for (let i = 0; i < n; i++) out.push(await sub.next(10));
  return out;
}

describe("dropInitialDesktopImage", () => {
  it("drops the measured shape: the first batch is one rect equal to the output", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[FULL], [WINDOW]]), PRIMARY), 2)).toEqual([[], [WINDOW]]);
  });

  it("drops it when empty batches come first", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[], [FULL], [WINDOW]]), PRIMARY), 3)).toEqual([[], [], [WINDOW]]);
  });

  it("drops a secondary output's image, which does not start at the origin", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[SECONDARY], [WINDOW]]), SECONDARY), 2)).toEqual([[], [WINDOW]]);
  });

  it("passes a small first change in the top-left corner", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[CORNER]]), PRIMARY), 1)).toEqual([[CORNER]]);
  });

  it("passes the primary's whole rect on a secondary output", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[FULL]]), SECONDARY), 1)).toEqual([[FULL]]);
  });

  it("passes a first batch that is not the output", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[WINDOW], [FULL]]), PRIMARY), 2)).toEqual([[WINDOW], [FULL]]);
  });

  it("passes a first batch of several rects, even one starting at the origin", async () => {
    const two = [FULL, WINDOW];
    expect(await drain(dropInitialDesktopImage(stubOf([two]), PRIMARY), 1)).toEqual([two]);
  });

  it("passes a later whole-output rect", async () => {
    expect(await drain(dropInitialDesktopImage(stubOf([[FULL], [FULL]]), PRIMARY), 2)).toEqual([[], [FULL]]);
  });

  it("forwards dispose and isDisposed", () => {
    const stub = stubOf([]);
    const sub = dropInitialDesktopImage(stub, PRIMARY);
    expect(sub.isDisposed).toBe(false);
    sub.dispose();
    expect(stub.dispose).toHaveBeenCalledTimes(1);
    expect(sub.isDisposed).toBe(true);
  });
});

describe("the shared broker's native subscriptions drop it", () => {
  afterEach(() => {
    disposeSharedDirtyRectBroker();
    nativeBatches.queue = [];
  });

  it("a polling consumer after miss-init never sees the initial image", async () => {
    nativeBatches.queue = [[FULL], [WINDOW]];
    const broker = getSharedDirtyRectBroker();
    expect(broker).not.toBeNull();
    const acquired = broker!.acquire(0);
    expect(acquired.state).toBe("miss-init");
    expect(await acquired.sub!.next(1000)).toEqual([WINDOW]);
  });
});
