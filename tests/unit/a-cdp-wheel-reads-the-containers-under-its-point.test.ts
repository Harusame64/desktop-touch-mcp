/**
 * internal #403 item 2 — the page-side expressions that find the inner scroll containers under a CDP
 * wheel's point and read them again after it. Run here as they ship, in a small fake DOM: the dispatcher's
 * cells (input-pipeline-dispatch.test.ts) stub these reads, so only this file runs the expressions.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { markScrollersExpr, READ_MARKED_SCROLLERS_EXPR } from "../../src/engine/cdp-bridge.js";

type Fake = {
  nodeType: number;
  name: string;
  parentElement: Fake | null;
  root?: { host?: Fake };
  overflowX: string;
  overflowY: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  getRootNode: () => { host?: Fake };
};

const el = (name: string, parent: Fake | null, o: Partial<Fake> = {}): Fake => {
  const e: Fake = {
    nodeType: 1, name, parentElement: parent, overflowX: "visible", overflowY: "visible",
    scrollTop: 0, scrollLeft: 0, scrollHeight: 100, clientHeight: 100, scrollWidth: 100, clientWidth: 100,
    getRootNode: () => e.root ?? {},
    ...o,
  };
  return e;
};

/** A page: html > body > app(scrolls Y) > list(scrolls Y, no room) > row; plus what the point hits. */
function page(hit: (doc: { html: Fake; body: Fake }) => Fake | null) {
  const html = el("html", null, { overflowY: "auto", scrollHeight: 5000, clientHeight: 800 });
  const body = el("body", html);
  const ctx = { window: {} as Record<string, unknown>, document: {} as Record<string, unknown>, getComputedStyle: (e: Fake) => ({ overflowX: e.overflowX, overflowY: e.overflowY }), Array };
  ctx.document = { scrollingElement: html, documentElement: html, elementFromPoint: () => hit({ html, body }) };
  vm.createContext(ctx);
  return { html, body, ctx, run: (expr: string) => vm.runInContext(expr, ctx) as unknown };
}

describe("markScrollersExpr: the containers a wheel at the point can scroll", () => {
  it("nearest first, only those whose overflow scrolls and that have room; not the document's own element", () => {
    let app!: Fake, list!: Fake, wide!: Fake;
    const p = page(({ body }) => {
      app = el("app", body, { overflowY: "auto", scrollHeight: 3000, clientHeight: 700, scrollTop: 40 });
      wide = el("wide", app, { overflowX: "scroll", scrollWidth: 900, clientWidth: 300, scrollLeft: 7 });
      list = el("list", wide, { overflowY: "auto", scrollHeight: 300, clientHeight: 300 }); // no room
      return el("row", list);
    });
    expect(p.run(markScrollersExpr(640, 400))).toEqual([{ top: 0, left: 7 }, { top: 40, left: 0 }]);
    expect((p.ctx.window.__dtmScrollChain as Fake[]).map((e) => e.name)).toEqual(["wide", "app"]);
    void list;
  });

  it("through a shadow root to its host", () => {
    const p = page(({ body }) => {
      const host = el("host", body, { overflowY: "scroll", scrollHeight: 2000, clientHeight: 500, scrollTop: 3 });
      const inner = el("inner", null, { overflowY: "overlay", scrollHeight: 900, clientHeight: 400, scrollTop: 11 });
      inner.root = { host };
      return el("leaf", inner);
    });
    expect(p.run(markScrollersExpr(1, 1))).toEqual([{ top: 11, left: 0 }, { top: 3, left: 0 }]);
  });

  it("nothing under the point scrolls (or nothing is there): an empty list and no slot kept", () => {
    for (const hit of [({ body }: { body: Fake }) => el("p", body), () => null]) {
      const p = page(hit as never);
      p.ctx.window.__dtmScrollChain = ["stale"];
      expect(p.run(markScrollersExpr(1, 1))).toEqual([]);
      expect("__dtmScrollChain" in p.ctx.window).toBe(false);
    }
  });

  it("the point is passed as numbers into the page", () => {
    expect(markScrollersExpr(640, 400)).toContain("})(640, 400)");
  });
});

describe("READ_MARKED_SCROLLERS_EXPR: the same containers after the wheel", () => {
  it("reads them in the same order and clears the slot", () => {
    let app!: Fake;
    const p = page(({ body }) => {
      app = el("app", body, { overflowY: "auto", scrollHeight: 3000, clientHeight: 700, scrollTop: 40 });
      return el("row", app);
    });
    p.run(markScrollersExpr(1, 1));
    app.scrollTop = 160;
    expect(p.run(READ_MARKED_SCROLLERS_EXPR)).toEqual([{ top: 160, left: 0 }]);
    expect("__dtmScrollChain" in p.ctx.window).toBe(false);
  });

  it("no slot (none was kept, or it was read already): null", () => {
    const p = page(() => null);
    expect(p.run(READ_MARKED_SCROLLERS_EXPR)).toBeNull();
  });
});
