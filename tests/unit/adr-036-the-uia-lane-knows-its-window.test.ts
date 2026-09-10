/**
 * ADR-036 item 15 — the read that names a window has to say WHICH window.
 *
 * `getUiElements` reported a window's title, its class and its rectangle, and not the handle it
 * resolved. So a UIA candidate carried no `originHwnd`, a UIA-only entity carried no
 * `origin.hwnd`, `coordHwnd` was undefined, and `resolvePressPoint` returned before its first
 * rung — the whole coordinate ladder skipped on that road.
 *
 * The cost was measured rather than argued (win2, 2026-09-10, `dev/item13-detail/RESULTS-round2.md`):
 * discover a UIA entity by title, CLOSE its window, act. UIA cannot serve it, the executor
 * downgrades to the mouse, and a press goes out at coordinates belonging to a window that no
 * longer exists. The response is `ok:true`, with `act.route{route:"mouse", hasAim:false,
 * why:"uia_downgrade"}`.
 *
 * This is read-path work and nothing on the act path changed: the ladder was already written, and
 * item 12 already reads `entity.origin.hwnd` when the aim has no handle of its own. What was
 * missing was a lane that recorded one.
 *
 * **The handle has to be the read's own answer.** Three searches resolve a title in this codebase
 * and none of them agree by construction, so a second lookup here would pin the act to a window
 * the read may never have touched — precise about the wrong window, which is worse than having no
 * handle at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchUiaCandidates } from "../../src/tools/desktop-providers/uia-provider.js";
import { resolveCandidates } from "../../src/engine/world-graph/resolver.js";
import type { UiEntityCandidate } from "../../src/engine/world-graph/types.js";

const uiaBridgeMocks = vi.hoisted(() => ({
  getUiElements: vi.fn(),
  detectUiaBlind: vi.fn().mockReturnValue({ blind: false }),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getUiElements: uiaBridgeMocks.getUiElements,
  detectUiaBlind: uiaBridgeMocks.detectUiaBlind,
}));

/** One enabled, named element — the shape the provider turns into a candidate. */
const ELEMENT = {
  name: "Save",
  automationId: "btnSave",
  controlType: "Button",
  isEnabled: true,
  boundingRect: { x: 100, y: 200, width: 80, height: 30 },
  patterns: ["Invoke"],
  depth: 1,
};

function readReturning(over: Record<string, unknown>) {
  uiaBridgeMocks.getUiElements.mockResolvedValue({
    windowTitle: "Untitled - Notepad",
    windowRect: { x: 0, y: 0, width: 1000, height: 800 },
    elementCount: 1,
    elements: [ELEMENT],
    ...over,
  });
}

beforeEach(() => {
  uiaBridgeMocks.getUiElements.mockReset();
  uiaBridgeMocks.detectUiaBlind.mockReturnValue({ blind: false });
});

describe("the UIA lane records the window it read", () => {
  it("stamps the handle the read resolved onto every candidate", async () => {
    readReturning({ windowHwnd: "4919" });
    const { candidates } = await fetchUiaCandidates({ windowTitle: "Untitled - Notepad" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].originHwnd).toBe("4919");
  });

  it("records nothing when the read could not say, and that is not the same as zero", async () => {
    // A build whose read cannot report a handle keeps exactly the behaviour it had: no handle, no
    // ladder. The dangerous direction is a handle that is wrong, not a handle that is missing —
    // every rung below would then be precise about another window.
    for (const answer of [{}, { windowHwnd: null }, { windowHwnd: undefined }]) {
      readReturning(answer);
      const { candidates } = await fetchUiaCandidates({ windowTitle: "Untitled - Notepad" });
      expect(candidates[0], JSON.stringify(answer)).not.toHaveProperty("originHwnd");
    }
  });

  it("carries the handle through to the entity, which is the only reason it is collected", async () => {
    // The seam that matters is not the candidate field — it is `origin.hwnd`, which is what
    // `observedHwndOfOrigin` reads and what decides whether the ladder runs at all. A cell that
    // stopped at the candidate would stay green if the resolver dropped it.
    readReturning({ windowHwnd: "4919" });
    const { candidates } = await fetchUiaCandidates({ windowTitle: "Untitled - Notepad" });
    const [entity] = resolveCandidates(candidates, "gen-1");
    expect(entity.origin).toMatchObject({ hwnd: "4919" });
  });

  it("does not invent one from the caller's handle when the read is silent", async () => {
    // The caller passed a handle to SCOPE the read; that is the caller's claim about its own
    // title. If the read comes back without a handle, this lane says nothing rather than echoing
    // the claim back as though the read had confirmed it.
    readReturning({});
    const { candidates } = await fetchUiaCandidates({ windowTitle: "Untitled - Notepad", hwnd: "4919" });
    expect(candidates[0]).not.toHaveProperty("originHwnd");
  });
});

describe("a fourth lane with a handle can now share a group, which the other three cannot", () => {
  const TARGET = { kind: "window" as const, id: "Untitled - Notepad" };
  function candidate(over: Partial<UiEntityCandidate>): UiEntityCandidate {
    return {
      source: "uia",
      target: TARGET,
      label: "Save",
      role: "button",
      actionability: ["invoke", "click"],
      confidence: 0.9,
      observedAtMs: 1000,
      provisional: false,
      ...over,
    } as UiEntityCandidate;
  }

  it("pairs the winning handle with the rect it came from", async () => {
    // The resolver's derivation rested on "every handle in a group comes from a single stamping
    // call", true while the only two lanes recording one keyed differently. A uia+ocr merge is
    // what this resolver is FOR, so that no longer holds — and what makes it harmless is that the
    // primary's handle wins and `rect: primary.rect` comes from the same candidate. One lane's
    // rectangle, measured against that same lane's window.
    // They merge because the fallback key is target + label + snapped rect, which is exactly the
    // "same element seen twice" case — so the rects agree to within the snap and the HANDLES are
    // what can differ. That is the whole hazard: two title resolutions, one element.
    const rect = { x: 100, y: 200, width: 80, height: 30 };
    const ocr = candidate({ source: "ocr", observedAtMs: 1000, originHwnd: "777", rect });
    const uia = candidate({ source: "uia", observedAtMs: 2000, originHwnd: "4919", rect });
    const [e, ...rest] = resolveCandidates([ocr, uia], "gen-1");
    expect(rest, "the two candidates must land in one group or this cell tests nothing").toHaveLength(0);
    expect(e.sources.sort()).toEqual(["ocr", "uia"]);
    // The newest candidate is the primary, and both the rect and the handle come from it.
    expect(e.origin).toMatchObject({ hwnd: "4919" });
    expect(e.rect).toEqual(rect);
  });

  it("takes no handle at all when two lanes name different windows and the primary has none", async () => {
    // The state the deleted `hwndConflict` refusal was written for, now reachable. The answer is
    // not a refusal — it is the behaviour every entity had before any lane recorded a handle.
    const rect = { x: 100, y: 200, width: 80, height: 30 };
    const ocr = candidate({ source: "ocr", observedAtMs: 1000, originHwnd: "777", rect });
    const uia = candidate({ source: "uia", observedAtMs: 2000, originHwnd: "4919", rect });
    const primaryWithout = candidate({ source: "terminal", observedAtMs: 3000, rect });
    const [e, ...rest] = resolveCandidates([ocr, uia, primaryWithout], "gen-1");
    expect(rest, "all three must land in one group or this cell tests nothing").toHaveLength(0);
    expect(e.origin).toEqual(TARGET);
  });
});
