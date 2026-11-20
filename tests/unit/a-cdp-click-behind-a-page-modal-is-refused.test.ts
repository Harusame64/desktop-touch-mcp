/**
 * internal #418 — `Input.dispatchMouseEvent` presses whatever is on top of the point, so a dialog's backdrop took
 * desktop_act's CDP click and the act answered ok. The click now runs browser_click's modal preflight (ADR-023
 * Phase 2b): refused only when the point is covered AND the cover is the dialog `detectModal` names as the blocker.
 * Every other cover is pressed as before — a banner, a non-modal drawer, a label over a custom checkbox — and so is
 * a click whose probe cannot answer (a probe failure must never break a click).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogFacts, ModalFacts } from "../../src/tools/browser-resolver.js";

function dialog(over: Partial<DialogFacts> = {}): DialogFacts {
  return {
    role: "dialog", tag: "div", ariaModal: false, nativeDialogOpen: false, name: "", visible: true,
    rect: { x: 200, y: 100, w: 600, h: 400 }, viewportCoverage: 0.6, offscreenTransform: false, zIndex: 1000,
    landmarkRole: null, hasBackdrop: false, siblingsInert: false, ...over,
  };
}
function facts(dialogCandidates: DialogFacts[]): ModalFacts {
  return { viewport: { innerWidth: 1280, innerHeight: 720 }, bodyScrollLock: false, activeElement: null, dialogCandidates };
}

const MODAL = facts([dialog({ ariaModal: true, name: "Sign in to continue", role: "dialog", hasBackdrop: true })]);

type ModalAnswer = { found: true; occludedByDialogIndex: number | null; insideDialogIndices?: number[]; modalFacts: ModalFacts } | "throws";

async function clickWith(occluded: boolean, modal: ModalAnswer, order: string[]) {
  vi.resetModules();
  vi.doMock("../../src/engine/cdp-bridge.js", async (orig) => ({
    ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
    evaluateInTab: async (expr: string) => {
      if (expr.includes("occludedByDialogIndex")) {
        order.push("modal-probe");
        if (modal === "throws") throw new Error("Target closed");
        return modal;
      }
      if (expr.includes("elementFromPoint") && expr.includes("scrollIntoView")) return { x: 10, y: 20, occluded };
      if (expr.includes("__dtmClickProbe") && expr.includes("MutationObserver")) return { ok: true, selectorFound: true, inIframe: false };
      return { ok: true, mutationCount: 1, urlChanged: false, activeElementChanged: false, inIframe: false };
    },
    listTabsLight: async () => [{ id: "T1", title: "T1", url: "about:blank", type: "page" }],
    dispatchMouseMoveInTab: async () => { order.push("move"); },
    dispatchClickInTab: async () => { order.push("press"); },
  }));
  const { cdpDispatchClickAndVerify } = await import("../../src/tools/browser.js");
  return cdpDispatchClickAndVerify("#go", "T1", 9335).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e: e as Error & { callerDetail?: string } }),
  );
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../src/engine/cdp-bridge.js");
});

describe("a CDP click behind a dialog that blocks the page (internal #418)", () => {
  it("is refused as ModalBlockingError, names the dialog, and presses nothing", async () => {
    const order: string[] = [];
    const out = await clickWith(true, { found: true, occludedByDialogIndex: 0, modalFacts: MODAL }, order);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.e.name).toBe("ModalBlockingError");
    expect(out.e.callerDetail).toBe(out.e.message);
    expect(out.e.message).toContain('"Sign in to continue"');
    expect(out.e.message).toContain("nothing was clicked");
    expect(order).toEqual(["modal-probe"]);
  });

  it("presses when the cover is not the blocking dialog (a banner over the point)", async () => {
    const order: string[] = [];
    const out = await clickWith(true, { found: true, occludedByDialogIndex: null, modalFacts: MODAL }, order);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["modal-probe", "move", "press"]);
  });

  it("presses when the covering dialog is not modal (a drawer)", async () => {
    const order: string[] = [];
    const drawer = facts([dialog({ viewportCoverage: 0.1, hasBackdrop: false, name: "Menu" })]);
    const out = await clickWith(true, { found: true, occludedByDialogIndex: 0, modalFacts: drawer }, order);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["modal-probe", "move", "press"]);
  });

  it("does not run the probe when the point is not covered (a button inside the dialog)", async () => {
    const order: string[] = [];
    const out = await clickWith(false, { found: true, occludedByDialogIndex: 0, modalFacts: MODAL }, order);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["move", "press"]);
  });

  it("presses an element inside the blocking dialog that a part of the same dialog covers (/code-review on #1002)", async () => {
    // A styled box over a hidden checkbox in a consent dialog: the cover maps to the dialog's index, and so
    // does the element. Refusing it would send the caller to the dialog's own buttons — this is one of them.
    const order: string[] = [];
    const out = await clickWith(true, { found: true, occludedByDialogIndex: 0, insideDialogIndices: [0], modalFacts: MODAL }, order);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["modal-probe", "move", "press"]);
  });

  it("still refuses an element inside another dialog that the blocking one covers", async () => {
    const order: string[] = [];
    const two = facts([dialog({ name: "Help", viewportCoverage: 0.2 }), dialog({ ariaModal: true, name: "Sign in", hasBackdrop: true, zIndex: 2000 })]);
    const out = await clickWith(true, { found: true, occludedByDialogIndex: 1, insideDialogIndices: [0], modalFacts: two }, order);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.e.name).toBe("ModalBlockingError");
    expect(order).toEqual(["modal-probe"]);
  });

  it("says a dialog with no name has none, rather than quoting detectModal's placeholder", async () => {
    const order: string[] = [];
    const unnamed = facts([dialog({ ariaModal: true, name: "", hasBackdrop: true })]);
    const out = await clickWith(true, { found: true, occludedByDialogIndex: 0, modalFacts: unnamed }, order);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.e.message).toContain("with no name");
    expect(out.e.message).not.toContain('"modal"');
  });

  it("presses when the probe cannot answer", async () => {
    const order: string[] = [];
    const out = await clickWith(true, "throws", order);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["modal-probe", "move", "press"]);
  });
});
