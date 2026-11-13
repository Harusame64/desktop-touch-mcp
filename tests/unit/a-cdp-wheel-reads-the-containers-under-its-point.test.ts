/**
 * internal #403 item 2 — the page-side code that finds the inner scroll containers under a CDP wheel's point
 * (markScrollersExpr) and reads them again after it (READ_SCROLLERS_FN). Run here as shipped, in a small fake
 * DOM that answers the way a browser does where it matters: `document.elementFromPoint` answers the outermost
 * shadow host (retargeting), a shadow root answers inside itself, a slotted element climbs to its slot, and a
 * same-origin iframe has its own document. The dispatcher's cells (input-pipeline-dispatch.test.ts) stub these.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { markScrollersExpr, READ_SCROLLERS_FN } from "../../src/engine/cdp-bridge.js";

interface Fake {
  nodeType: number;
  name: string;
  tagName: string;
  parentElement: Fake | null;
  assignedSlot?: Fake | null;
  shadowRoot?: { elementFromPoint: (x: number, y: number) => Fake | null } | null;
  root?: { host?: Fake };
  contentDocument?: unknown;
  overflowX: string;
  overflowY: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  clientLeft: number;
  clientTop: number;
  getRootNode: () => { host?: Fake };
  getBoundingClientRect?: () => { left: number; top: number };
}

const el = (name: string, parent: Fake | null, o: Partial<Fake> = {}): Fake => {
  const e: Fake = {
    nodeType: 1, name, tagName: name.toUpperCase(), parentElement: parent, overflowX: "visible", overflowY: "visible",
    scrollTop: 0, scrollLeft: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100,
    clientLeft: 0, clientTop: 0,
    getRootNode: () => e.root ?? {},
    ...o,
  };
  return e;
};
const scrollsY = (top = 0) => ({ overflowY: "auto", scrollHeight: 3000, clientHeight: 500, scrollTop: top });

const style = (e: Fake) => ({ overflowX: e.overflowX, overflowY: e.overflowY });

function doc(html: Fake, at: (x: number, y: number) => Fake | null) {
  return { scrollingElement: html, documentElement: html, elementFromPoint: at, defaultView: { getComputedStyle: style } };
}

/** Runs the shipped expression on a page; answers the containers' names and positions. */
function run(document: ReturnType<typeof doc>) {
  const ctx = vm.createContext({ window: { getComputedStyle: style }, document });
  const chain = vm.runInContext(markScrollersExpr(640, 400), ctx) as Fake[];
  const read = vm.runInContext(`(${READ_SCROLLERS_FN})`, ctx) as (this: Fake[]) => Array<{ top: number; left: number }>;
  return { names: chain.map((e) => e.name), positions: () => read.call(chain), chain };
}

describe("markScrollersExpr: the containers a wheel at the point can scroll", () => {
  it("nearest first, only those whose overflow scrolls and that have room; not the document's own element", () => {
    const html = el("html", null, { overflowY: "auto", scrollHeight: 5000, clientHeight: 800 });
    const body = el("body", html);
    const app = el("app", body, scrollsY(40));
    const wide = el("wide", app, { overflowX: "scroll", scrollWidth: 900, clientWidth: 300, scrollLeft: 7 });
    const list = el("list", wide, { overflowY: "auto", scrollHeight: 300, clientHeight: 300 }); // no room
    const row = el("row", list);
    const r = run(doc(html, () => row));
    expect(r.names).toEqual(["wide", "app"]);
    expect(r.positions()).toEqual([{ top: 0, left: 7 }, { top: 40, left: 0 }]);
  });

  it("into an open shadow root: the document answers the host, the walk goes on from inside it", () => {
    const html = el("html", null);
    const body = el("body", html);
    const host = el("host", body, scrollsY(3));
    const pane = el("pane", null, scrollsY(11)); // the scroller inside the shadow tree
    pane.root = { host };
    const item = el("item", pane);
    host.shadowRoot = { elementFromPoint: () => item };
    expect(run(doc(html, () => host)).names).toEqual(["pane", "host"]);
  });

  it("a slotted element climbs to its slot, so the scroller wrapping the slot in the shadow tree is found", () => {
    const html = el("html", null);
    const body = el("body", html);
    const host = el("my-scroller", body);
    const wrap = el("wrap", null, scrollsY(5)); // shadow: <div overflow:auto><slot></slot></div>
    wrap.root = { host };
    const slot = el("slot", wrap);
    slot.root = { host };
    const child = el("child", host, { assignedSlot: slot }); // light DOM child of the host, slotted
    host.shadowRoot = { elementFromPoint: () => child }; // retargeting stops at the light child
    expect(run(doc(html, () => host)).names).toEqual(["wrap"]);
  });

  it("into a same-origin iframe at the point less the frame's offset; the frame's document and the frame's ancestors count", () => {
    const html = el("html", null);
    const body = el("body", html);
    const pane = el("pane", body, scrollsY(2));
    const frame = el("iframe", pane, { clientLeft: 2, clientTop: 2, getBoundingClientRect: () => ({ left: 100, top: 50 }) });
    const fhtml = el("frame-html", null, { scrollHeight: 4000, clientHeight: 600, scrollTop: 9 });
    const fbody = el("frame-body", fhtml);
    const box = el("frame-box", fbody, scrollsY(1));
    const asked: Array<[number, number]> = [];
    frame.contentDocument = doc(fhtml, (x, y) => { asked.push([x, y]); return box; });
    const r = run(doc(html, () => frame));
    expect(asked).toEqual([[640 - 100 - 2, 400 - 50 - 2]]);
    expect(r.names).toEqual(["frame-box", "frame-html", "pane"]);
  });

  it("a cross-origin iframe (contentDocument throws or is null): its ancestors only", () => {
    const html = el("html", null);
    const body = el("body", html);
    const pane = el("pane", body, scrollsY(2));
    const frame = el("iframe", pane);
    Object.defineProperty(frame, "contentDocument", { get: () => { throw new Error("SecurityError"); } });
    expect(run(doc(html, () => frame)).names).toEqual(["pane"]);
    const frame2 = el("iframe", pane, { contentDocument: null });
    expect(run(doc(html, () => frame2)).names).toEqual(["pane"]);
  });

  it("nothing under the point scrolls, or nothing is there: an empty list", () => {
    const html = el("html", null);
    const body = el("body", html);
    expect(run(doc(html, () => el("p", body))).names).toEqual([]);
    expect(run(doc(html, () => null)).names).toEqual([]);
  });

  it("leaves nothing in the page's globals", () => {
    const html = el("html", null);
    const body = el("body", html);
    const app = el("app", body, scrollsY());
    const win: Record<string, unknown> = { getComputedStyle: style };
    const ctx = vm.createContext({ window: win, document: doc(html, () => app) });
    vm.runInContext(markScrollersExpr(1, 1), ctx);
    expect(Object.keys(win)).toEqual(["getComputedStyle"]);
  });

  it("the point is passed as numbers into the page", () => {
    expect(markScrollersExpr(640, 400)).toContain("})(640, 400)");
  });
});

describe("READ_SCROLLERS_FN: the same containers after the wheel", () => {
  it("reads them in the same order", () => {
    const html = el("html", null);
    const body = el("body", html);
    const app = el("app", body, scrollsY(40));
    const r = run(doc(html, () => el("row", app)));
    app.scrollTop = 160;
    expect(r.positions()).toEqual([{ top: 160, left: 0 }]);
  });

  it("a container no longer in the document reads null (its scroll position would read 0)", () => {
    const html = el("html", null);
    const body = el("body", html);
    const app = el("app", body, scrollsY(40));
    const r = run(doc(html, () => el("row", app)));
    (app as unknown as { isConnected: boolean }).isConnected = false;
    expect(r.positions()).toEqual([null]);
  });
});
