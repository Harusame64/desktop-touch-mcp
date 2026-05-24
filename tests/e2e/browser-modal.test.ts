/**
 * browser-modal.test.ts — E2E for ADR-023 Phase 2 (PR-2a) modal detection.
 *
 * Real headless Chrome validates the injected `buildPageLevelModalFactsJs`
 * gatherer against real layout / `:modal` / landmark / scroll-lock — the layer
 * the node unit tests cannot cover (no DOM) — then runs the pure `detectModal`
 * on the gathered facts end to end. CDP-eval only (NO OS clicks), so this is
 * headless-safe and never trips the failsafe.
 *
 * @see src/tools/browser-resolver.ts  buildPageLevelModalFactsJs / detectModal
 * Plan: desktop-touch-mcp-internal:docs/adr-023-phase-2-modal-plan.md §4, S6.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import {
  buildPageLevelModalFactsJs,
  detectModal,
  resolveBrowserActionTarget,
  probeSelectorModalOcclusion,
  type ModalFacts,
} from "../../src/tools/browser-resolver.js";
import { evaluateInTab, disconnectAll, getElementScreenCoords } from "../../src/engine/cdp-bridge.js";

async function openDialog(): Promise<void> {
  await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (!d.open) d.showModal(); return true; })()`, null, TEST_PORT);
}
async function closeDialog(): Promise<void> {
  await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (d.open) d.close(); return true; })()`, null, TEST_PORT);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "modal-cases.html");
const TEST_PORT = 9233; // separate from other suites
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, true /* headless */, FIXTURE_URL);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluateInTab(
        `document.readyState === 'complete' && document.querySelector('#drawer') !== null && ` +
          `document.querySelector('#drawer').getBoundingClientRect().height > 0`,
        null,
        TEST_PORT,
      );
      if (ready === true) return;
    } catch {
      /* ignore */
    }
    await sleep(250);
  }
  throw new Error("Modal fixture did not lay out within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

async function gather(): Promise<ModalFacts> {
  // Ensure no native dialog is open from a previous test, then gather.
  return (await evaluateInTab(buildPageLevelModalFactsJs(), null, TEST_PORT)) as ModalFacts;
}

describe.skipIf(!CHROME_AVAILABLE)("ADR-023 Phase 2 (PR-2a): page-level modal facts + detectModal (real Chrome)", () => {
  it("NON-modal nav drawer (role=dialog) → isModal:false + drawerExcluded:true (AC-7)", async () => {
    await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (d.open) d.close(); return true; })()`, null, TEST_PORT);
    const facts = await gather();
    // The closed native dialog (display:none) is filtered; only the visible nav drawer remains.
    const verdict = detectModal(facts);
    expect(verdict.isModal, JSON.stringify(verdict)).toBe(false);
    expect(verdict.signals.drawerExcluded).toBe(true);
    // gather correctly read the nav landmark on the role=dialog drawer — find by
    // the landmark contract (what detectModal excludes on), not the tag.
    const drawer = facts.dialogCandidates.find((c) => c.role === "dialog" && c.landmarkRole === "navigation");
    expect(drawer, JSON.stringify(facts.dialogCandidates)).toBeDefined();
    expect(drawer?.ariaModal).toBe(false);
    expect(drawer?.hasBackdrop).toBe(false);
  });

  it("native <dialog> showModal → isModal:true, blocker, nativeDialogOpen + backdrop from real :modal", async () => {
    await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (!d.open) d.showModal(); return d.matches(':modal'); })()`, null, TEST_PORT);
    const facts = await gather();
    const verdict = detectModal(facts);
    expect(verdict.isModal, JSON.stringify(verdict)).toBe(true);
    expect(verdict.blocker?.name).toBe("Confirm changes"); // aria-label read by gather
    expect(verdict.blocker?.role).toBe("dialog"); // native dialog has no role attr → defaulted
    expect(verdict.signals.nativeDialogOpen).toBe(true); // real :modal detected
    expect(verdict.signals.backdrop).toBe(true); // ::backdrop via :modal
    // strong signal wins even though the nav drawer candidate is also present.
    expect(verdict.signals.drawerExcluded).toBe(false);
    // cleanup for any subsequent run
    await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (d.open) d.close(); return true; })()`, null, TEST_PORT);
  });

  it("blockerDialogIndex points into the gathered dialogCandidates", async () => {
    await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (!d.open) d.showModal(); return true; })()`, null, TEST_PORT);
    const facts = await gather();
    const verdict = detectModal(facts);
    expect(verdict.blockerDialogIndex).not.toBeUndefined();
    const blocker = facts.dialogCandidates[verdict.blockerDialogIndex!];
    expect(blocker.nativeDialogOpen).toBe(true);
    await evaluateInTab(`(function(){ const d=document.getElementById('dlg'); if (d.open) d.close(); return true; })()`, null, TEST_PORT);
  });
});

describe.skipIf(!CHROME_AVAILABLE)("ADR-023 Phase 2b: modal-blocking preflight (real Chrome, no OS click)", () => {
  // When the native dialog is open, the #open button (in <main>) sits behind the
  // dialog's ::backdrop → occluded by the modal. These exercise the gather→decide
  // plumbing end to end; the actual STOP (BrowserModalBlocking) returns before any
  // OS click, so this is headless-safe.

  it("by-axis: a button behind the modal → noActionable with modalFacts + matching occludedTopByDialogIndex", async () => {
    await openDialog();
    const r = await resolveBrowserActionTarget({ by: "text", pattern: "Open dialog", action: "click", port: TEST_PORT });
    expect(r.kind, JSON.stringify(r)).toBe("noActionable");
    if (r.kind === "noActionable") {
      expect(r.modalFacts).toBeDefined();
      const verdict = detectModal(r.modalFacts!);
      expect(verdict.isModal).toBe(true);
      // the handler upgrades to BrowserModalBlocking exactly on this index match.
      expect(r.occludedTopByDialogIndex).toBe(verdict.blockerDialogIndex);
      expect(r.occludedTopByDialogIndex).not.toBeNull();
    }
    await closeDialog();
  });

  it("by-axis: includeModal off for fill (resolve action='fill' carries no modalFacts)", async () => {
    await openDialog();
    const r = await resolveBrowserActionTarget({ by: "text", pattern: "Open dialog", action: "fill", port: TEST_PORT });
    // fill gather is modal-free (bit-equal with Phase 1) — no modalFacts even when a modal is open.
    if (r.kind === "noActionable") expect(r.modalFacts).toBeUndefined();
    await closeDialog();
  });

  it("selector probe: #open is occluded by the modal; probe maps it to the blocker dialog", async () => {
    await openDialog();
    const coords = await getElementScreenCoords("#open", null, TEST_PORT);
    expect(coords.occluded).toBe(true); // generic hit-test flag from getElementScreenCoords
    const probe = await probeSelectorModalOcclusion("#open", null, TEST_PORT);
    expect(probe, "probe should find the element").not.toBeNull();
    const verdict = detectModal(probe!.modalFacts);
    expect(verdict.isModal).toBe(true);
    expect(probe!.occludedByDialogIndex).toBe(verdict.blockerDialogIndex);
    await closeDialog();
  });

  it("no modal open: #open is not occluded (no false preflight stop)", async () => {
    await closeDialog();
    const coords = await getElementScreenCoords("#open", null, TEST_PORT);
    expect(coords.occluded).toBe(false);
    const r = await resolveBrowserActionTarget({ by: "text", pattern: "Open dialog", action: "click", port: TEST_PORT });
    // unoccluded, actionable → resolves normally (no modal escalation).
    expect(r.kind, JSON.stringify(r)).toBe("resolved");
  });
});
