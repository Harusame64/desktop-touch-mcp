/**
 * tests/unit/browser-resolver-modal.test.ts
 * — ADR-023 Phase 2 (PR-2a) detectModal pure-decision + gather-JS snapshot.
 *
 * detectModal classifies page-level ModalFacts (gathered by injected JS) into a
 * ModalVerdict. The decision layer is DOM-free, so it is unit-tested here with
 * synthetic facts covering the §2.3 rule branches (strong-signal-first, positive
 * drawer exclusion, backdrop-mandatory CSS-modal rescue, fail-safe) plus the
 * fixture corpus (tests/fixtures/browser-modal/*.json). The injected-JS gatherer
 * is string-snapshot pinned.
 *
 * Plan: desktop-touch-mcp-internal:docs/adr-023-phase-2-modal-plan.md §2.2-2.4, S2/S6.
 * @see src/tools/browser-resolver.ts  detectModal / buildPageLevelModalFactsJs
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  detectModal,
  buildPageLevelModalFactsJs,
  type DialogFacts,
  type ModalFacts,
} from "../../src/tools/browser-resolver.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dir, "..", "fixtures", "browser-modal");

/** Full-viewport rect default; override per case. */
function mkDialog(over: Partial<DialogFacts> = {}): DialogFacts {
  return {
    role: "dialog",
    tag: "div",
    ariaModal: false,
    nativeDialogOpen: false,
    name: "",
    visible: true,
    rect: { x: 200, y: 100, w: 600, h: 400 },
    viewportCoverage: 0.6,
    offscreenTransform: false,
    zIndex: 1000,
    landmarkRole: null,
    hasBackdrop: false,
    siblingsInert: false,
    ...over,
  };
}

function mkFacts(dialogCandidates: DialogFacts[], over: Partial<ModalFacts> = {}): ModalFacts {
  return {
    viewport: { innerWidth: 1280, innerHeight: 720 },
    bodyScrollLock: false,
    activeElement: null,
    dialogCandidates,
    ...over,
  };
}

describe("ADR-023 Phase 2 (PR-2a): detectModal — rule branches", () => {
  it("rule 2 strong: aria-modal → isModal, blocker, blockerDialogIndex", () => {
    const v = detectModal(mkFacts([mkDialog({ ariaModal: true, name: "Settings", role: "dialog" })]));
    expect(v.isModal).toBe(true);
    expect(v.blocker).toEqual({ name: "Settings", role: "dialog" });
    expect(v.blockerDialogIndex).toBe(0);
    expect(v.signals.ariaModal).toBe(true);
    expect(v.signals.drawerExcluded).toBe(false);
  });

  it("rule 2 strong: role=alertdialog → isModal, role concrete", () => {
    const v = detectModal(mkFacts([mkDialog({ role: "alertdialog", name: "Delete?" })]));
    expect(v.isModal).toBe(true);
    expect(v.blocker?.role).toBe("alertdialog");
    expect(v.signals.alertdialog).toBe(true);
  });

  it("rule 2 strong: native <dialog> showModal → isModal", () => {
    const v = detectModal(mkFacts([mkDialog({ tag: "dialog", role: null, nativeDialogOpen: true, hasBackdrop: true })]));
    expect(v.isModal).toBe(true);
    expect(v.signals.nativeDialogOpen).toBe(true);
    expect(v.blocker?.role).toBe("dialog"); // role attr absent → defaulted
  });

  it("blocker.name empty → 'modal' (native non-empty parity)", () => {
    const v = detectModal(mkFacts([mkDialog({ ariaModal: true, name: "" })]));
    expect(v.blocker?.name).toBe("modal");
  });

  it("rule 2 strong wins over drawer evidence: aria-modal drawer IS modal (P2-R2-3)", () => {
    const v = detectModal(
      mkFacts([mkDialog({ ariaModal: true, landmarkRole: "navigation", name: "Menu", hasBackdrop: true })]),
    );
    expect(v.isModal).toBe(true);
    expect(v.signals.drawerExcluded).toBe(false);
  });

  it("rule 3 drawer exclusion: nav-landmark drawer, no strong → not modal, drawerExcluded (課題③)", () => {
    const v = detectModal(
      mkFacts([mkDialog({ role: "dialog", landmarkRole: "navigation", ariaModal: false, hasBackdrop: false })]),
    );
    expect(v.isModal).toBe(false);
    expect(v.signals.drawerExcluded).toBe(true);
  });

  it("rule 3 drawer exclusion: offscreen-transform drawer → not modal, drawerExcluded", () => {
    const v = detectModal(
      mkFacts([mkDialog({ offscreenTransform: true, viewportCoverage: 0, hasBackdrop: false })]),
    );
    expect(v.isModal).toBe(false);
    expect(v.signals.drawerExcluded).toBe(true);
  });

  it("rule 4 rescue: no strong + backdrop + scroll-lock + coverage → isModal", () => {
    const v = detectModal(
      mkFacts([mkDialog({ hasBackdrop: true, viewportCoverage: 0.6 })], { bodyScrollLock: true }),
    );
    expect(v.isModal).toBe(true);
    expect(v.signals.backdrop).toBe(true);
    expect(v.signals.scrollLock).toBe(true);
  });

  it("rule 4 fail-safe: backdrop + high coverage but NO behavior signal → not modal (full-bleed banner, P2-R2-2)", () => {
    const v = detectModal(mkFacts([mkDialog({ hasBackdrop: true, viewportCoverage: 0.95 })]));
    expect(v.isModal).toBe(false);
  });

  it("rule 4 gate: backdrop + behavior but coverage below threshold → not modal", () => {
    const v = detectModal(
      mkFacts([mkDialog({ hasBackdrop: true, viewportCoverage: 0.1 })], { bodyScrollLock: true }),
    );
    expect(v.isModal).toBe(false);
  });

  it("rule 4 fail-safe: behavior signals but NO backdrop → not modal", () => {
    const v = detectModal(
      mkFacts([mkDialog({ hasBackdrop: false, viewportCoverage: 0.6, siblingsInert: true })], { bodyScrollLock: true }),
    );
    expect(v.isModal).toBe(false);
  });

  it("no dialog candidates → not modal, no blocker", () => {
    const v = detectModal(mkFacts([]));
    expect(v.isModal).toBe(false);
    expect(v.blocker).toBeUndefined();
    expect(v.blockerDialogIndex).toBeUndefined();
  });

  it("invisible candidate ignored", () => {
    const v = detectModal(mkFacts([mkDialog({ ariaModal: true, visible: false })]));
    expect(v.isModal).toBe(false);
  });

  it("focusInside counts as a rule-4 behavior signal (via activeElement.inDialogCandidate)", () => {
    const v = detectModal(
      mkFacts([mkDialog({ hasBackdrop: true, viewportCoverage: 0.6 })], {
        activeElement: { tag: "input", role: null, inDialogCandidate: true },
      }),
    );
    expect(v.isModal).toBe(true);
    expect(v.signals.focusInside).toBe(true);
  });

  it("blockerDialogIndex points at the topmost (z-index) of multiple modals", () => {
    const v = detectModal(
      mkFacts([
        mkDialog({ ariaModal: true, name: "Lower", zIndex: 10 }),
        mkDialog({ ariaModal: true, name: "Upper", zIndex: 9999 }),
      ]),
    );
    expect(v.isModal).toBe(true);
    expect(v.blockerDialogIndex).toBe(1);
    expect(v.blocker?.name).toBe("Upper");
  });
});

describe("ADR-023 Phase 2 (PR-2a): detectModal — fixture corpus (tests/fixtures/browser-modal)", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  it("has fixtures", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`fixture ${f}`, () => {
      const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as {
        facts: ModalFacts;
        expect: { isModal: boolean; drawerExcluded?: boolean; blockerRole?: string };
      };
      const v = detectModal(fx.facts);
      expect(v.isModal).toBe(fx.expect.isModal);
      if (fx.expect.drawerExcluded !== undefined) expect(v.signals.drawerExcluded).toBe(fx.expect.drawerExcluded);
      if (fx.expect.blockerRole !== undefined) expect(v.blocker?.role).toBe(fx.expect.blockerRole);
    });
  }
});

describe("ADR-023 Phase 2 (PR-2a): buildPageLevelModalFactsJs — gather JS", () => {
  it("emits the self-contained page-level modal facts IIFE (snapshot)", () => {
    expect(buildPageLevelModalFactsJs()).toMatchSnapshot();
  });

  it("is self-contained (no outer-helper refs) and queries only the dialog candidate set", () => {
    const js = buildPageLevelModalFactsJs();
    expect(js).toContain(`querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog')`);
    expect(js).toContain("function hasBackdropFor(el)");
    expect(js).toContain("el.matches(':modal')"); // native modal detection
    expect(js).toContain("dialogCandidates: cands");
    expect(js).toContain("bodyScrollLock:");
    // structural only — no class-name heuristics (plan §5.1)
    expect(js).not.toContain("overlay");
    expect(js).not.toContain("backdrop'"); // no class*=backdrop matching
  });
});
