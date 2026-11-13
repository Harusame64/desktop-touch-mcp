/**
 * internal #403 — the CDP wheel's hit-path observer (armWheelObserver: wheelObserverExpr + WHEEL_VERDICT_FN) in a
 * real headless Chrome. The unit cells stub it; this runs the shipped page code against real hit-testing,
 * composedPath, shadow roots, preventDefault and scrollend. CDP only, no OS input, so it is headless-safe.
 * Set CHROME_PATH on a machine where the launcher's Windows paths do not apply (macOS:
 * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { armWheelObserver, dispatchWheelInTab, evaluateInTab, disconnectAll, type WheelVerdict } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = `file:///${join(__dirname, "fixtures", "wheel-hit-path.html").replace(/\\/g, "/")}`;
const PORT = 9234;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

async function open(mode: string): Promise<void> {
  await evaluateInTab(`location.href = ${JSON.stringify(`${FIXTURE}#${mode}`)}; location.reload(); true`, null, PORT).catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(150);
    const ok = await evaluateInTab(`document.readyState === 'complete' && location.hash === ${JSON.stringify(`#${mode}`)}`, null, PORT).catch(() => false);
    if (ok === true) { await sleep(150); return; }
  }
  throw new Error(`fixture ${mode} did not load`);
}

/** A point in the right half of the viewport (the R pane, or the shadow host), whatever the window's size. */
async function rightHalf(): Promise<[number, number]> {
  const [w, h] = (await evaluateInTab("[innerWidth, innerHeight]", null, PORT)) as [number, number];
  return [Math.floor(w * 0.75), Math.floor(h / 2)];
}

/** Arms the observer, sends one notch at the viewport point, and answers the verdict. */
async function wheelAt(x: number, y: number, deltaY = 120, deltaX = 0): Promise<WheelVerdict | null> {
  const vertical = deltaX === 0;
  const obs = await armWheelObserver(vertical, null, PORT);
  if (obs === null) throw new Error("observer not armed");
  try {
    await dispatchWheelInTab(deltaX, vertical ? deltaY : 0, x, y, null, PORT);
    return await obs.verdict((vertical ? deltaY : deltaX) > 0 ? 1 : -1, 250, 300, 800);
  } finally {
    await obs.release();
  }
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(PORT, true, `${FIXTURE}#panes`);
  await sleep(500);
  await evaluateInTab("true", null, PORT);
});
afterAll(async () => {
  disconnectAll(PORT);
  chrome?.kill?.();
});

describe.skipIf(!CHROME_AVAILABLE)("the CDP wheel is judged by the path the browser hit (internal #403)", () => {
  it("two panes: the one under the point moved, the document did not", async () => {
    await open("panes");
    const v = await wheelAt(200, 300);
    expect(v).toMatchObject({ seen: true, defaultPrevented: false, moved: "div#L" });
    const pos = await evaluateInTab("[document.getElementById('L').scrollTop, document.getElementById('R').scrollTop, document.scrollingElement.scrollTop]", null, PORT);
    expect((pos as number[])[0]).toBeGreaterThan(0);
    expect((pos as number[]).slice(1)).toEqual([0, 0]);
  });

  it("a pane at its end that way: nothing moved, every scroller on the path at its end", async () => {
    await open("panes");
    await evaluateInTab("document.getElementById('L').scrollTop = 1e9; true", null, PORT);
    await sleep(100);
    const v = await wheelAt(200, 300);
    expect(v).toMatchObject({ seen: true, under: "end", underLabel: "div#L" });
    expect(v?.moved).toBeUndefined();
  });

  it("the other way from the end: it moves", async () => {
    await open("panes");
    await evaluateInTab("document.getElementById('L').scrollTop = 1e9; true", null, PORT);
    await sleep(100);
    expect(await wheelAt(200, 300, -120)).toMatchObject({ moved: "div#L" });
  });

  it("an open shadow root with a slot: the scroller inside it is on the path and is seen moving", async () => {
    await open("shadow-open");
    expect(await wheelAt(...(await rightHalf()))).toMatchObject({ seen: true, moved: "div#inner" });
  });

  it("a closed shadow root: the path stops at the host, nothing on it scrolls — rooms 0, ends 0 (unobservable), though the inside moved", async () => {
    await open("shadow-closed");
    const v = await wheelAt(...(await rightHalf()));
    expect(v).toMatchObject({ seen: true, defaultPrevented: false });
    expect(v?.moved).toBeUndefined();
    expect(v?.under).toBeUndefined();
    expect(await evaluateInTab("window.__inner.scrollTop", null, PORT)).toBeGreaterThan(0);
  });

  it("the page cancels the wheel: defaultPrevented, nothing moved, and the pane could still move", async () => {
    await open("handled");
    const v = await wheelAt(200, 300);
    expect(v).toMatchObject({ seen: true, defaultPrevented: true, under: "room" });
    expect(v?.moved).toBeUndefined();
  });

  it("a pane that moves the other way while the wheel turns (the page easing back) is not counted as moved", async () => {
    await open("against");
    const v = await wheelAt(200, 300);
    expect(v).toMatchObject({ seen: true, defaultPrevented: true });
    expect(v?.moved).toBeUndefined();
    expect(await evaluateInTab("document.getElementById('L').scrollTop", null, PORT)).toBeLessThan(400);
  });

  it("a page that moves its content by transform: defaultPrevented, nothing scrolls on the path", async () => {
    await open("transform");
    const v = await wheelAt(200, 300);
    expect(v).toMatchObject({ seen: true, defaultPrevented: true });
    expect(v?.under).toBeUndefined();
  });

  it("a page whose document scrolls: the document is what moved", async () => {
    await open("doc");
    expect(await wheelAt(...(await rightHalf()))).toMatchObject({ seen: true, moved: "document" });
  });

  it("overscroll-behavior:contain at its end with the document still able to move: the one under the point is at its end (gate 2 on #980)", async () => {
    await open("contain");
    const v = await wheelAt(200, 300);
    expect(v?.moved).toBeUndefined();
    expect(v).toMatchObject({ under: "end", underLabel: "div#L" });
  });

  it("a locked page (body overflow:hidden, a modal's list at its end): at its end, not room (gate 2 on #980)", async () => {
    await open("locked");
    const v = await wheelAt(200, 300);
    expect(v?.moved).toBeUndefined();
    expect(v).toMatchObject({ under: "end", underLabel: "div#L" });
  });

  it("a locked page with nothing else under the point: the document does not count as a scroller (its overflow is hidden)", async () => {
    await open("lockedbare");
    const v = await wheelAt(200, 300);
    expect(v?.moved).toBeUndefined();
    expect(v?.under).toBeUndefined();
  });

  it("right-to-left: at the right edge, right is the end and left moves (gate 2 on #980)", async () => {
    await open("rtl");
    expect(await wheelAt(200, 300, 0, 120)).toMatchObject({ under: "end", underLabel: "div#W" });
    expect(await wheelAt(200, 300, 0, -120)).toMatchObject({ moved: "div#W" });
  });

  it("the listeners come off when no verdict is read (release alone)", async () => {
    await open("panes");
    const obs = await armWheelObserver(true, null, PORT);
    await obs!.release();
    // A wheel after the release is not seen by a leftover listener: a fresh observer sees exactly one.
    expect(await wheelAt(200, 300)).toMatchObject({ seen: true, moved: "div#L" });
  });

  it("nothing is left in the page's own globals", async () => {
    await open("panes");
    const before = await evaluateInTab("Object.keys(window).length", null, PORT);
    await wheelAt(200, 300);
    expect(await evaluateInTab("Object.keys(window).length", null, PORT)).toBe(before);
  });
});
