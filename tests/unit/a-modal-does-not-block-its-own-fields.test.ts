/**
 * internal #321 — a modal does not block what is inside it.
 *
 * win2 (2026-10-30, Chrome): a side panel with role="dialog" aria-modal="true" reads as a UIA `Window`
 * with IsModal true. desktop_act on the panel's own textarea answered modal_blocking naming the panel;
 * a field outside the panel was refused the same way. Behind a real `<dialog>` opened with
 * showModal() the page's fields leave the UIA tree. "Inside" is below the window in the tree the read
 * walked, not within its rect: an owned dialog is listed in its owner's tree, over the owner's controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyModal } from "../../src/engine/world-graph/session-registry.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

function entity(id: string, path: string | undefined, opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: id, role: "unknown", confidence: 0.9, sources: ["uia"], affordances: [], generation: "g", evidenceDigest: "d",
    locator: { uia: { name: id, ...(path !== undefined && { path }) } },
    ...opts,
  };
}
const modalWindow = (id: string, path: string | undefined) => {
  const e = entity(id, path, { controlType: "Window" });
  e.locator!.uia!.isModal = true;
  return e;
};

const panel = modalWindow("URL の送信", "/Pane[0]/Document[0]/Window[1]");
const ta = entity("ta", "/Pane[0]/Document[0]/Window[1]/Edit[0]", { role: "textbox" });
const bi = entity("bi", "/Pane[0]/Document[0]/Edit[0]", { role: "textbox" });

describe("internal #321 — classifyModal and a target below the window", () => {
  it("does not count the panel against its own textarea", () => {
    expect(classifyModal(panel, "pre-touch", { excludeSelf: ta })).toBe(false);
  });

  it("counts the panel against a field outside it", () => {
    expect(classifyModal(panel, "pre-touch", { excludeSelf: bi })).toBe(true);
  });

  it("counts an owned dialog against the owner's control under it, whatever the rects", () => {
    const dialog = modalWindow("Save As", "/Window[3]");
    const ownerButton = entity("Save", "/Pane[0]/Button[2]", { rect: { x: 10, y: 10, width: 60, height: 20 } });
    dialog.rect = { x: 0, y: 0, width: 300, height: 200 };
    expect(classifyModal(dialog, "pre-touch", { excludeSelf: ownerButton })).toBe(true);
  });

  it("does not take a sibling whose path only starts with the same characters", () => {
    const sibling = entity("x", "/Pane[0]/Document[0]/Window[10]/Edit[0]");
    expect(classifyModal(panel, "pre-touch", { excludeSelf: sibling })).toBe(true);
  });

  it("counts it when either path is unknown, as before", () => {
    expect(classifyModal(panel, "pre-touch", { excludeSelf: entity("x", undefined) })).toBe(true);
    expect(classifyModal(modalWindow("w", undefined), "pre-touch", { excludeSelf: ta })).toBe(true);
  });

  it("leaves the post-touch reading alone (a modal that appeared is news wherever it is)", () => {
    expect(classifyModal(panel, "post-touch-diff", { excludeSelf: ta })).toBe(true);
  });
});

describe("internal #321 — through the facade, from the read's candidates", () => {
  const cand = (label: string, path: string, extra: Record<string, unknown> = {}) => ({
    source: "uia", target: { kind: "window", id: "Chrome" }, label, role: "textbox", confidence: 0.9, observedAtMs: 0,
    provisional: false, actionability: ["click", "type"], rect: { x: 605, y: 187, width: 306, height: 127 },
    locator: { uia: { name: label, path } }, ...extra,
  }) as unknown as UiEntityCandidate;
  const panelCand = {
    source: "uia", target: { kind: "window", id: "Chrome" }, label: "URL の送信", role: "unknown", controlType: "Window",
    rect: { x: 587, y: 97, width: 360, height: 917 }, actionability: [], confidence: 0.9, observedAtMs: 0, provisional: false,
    locator: { uia: { name: "URL の送信", isModal: true, path: "/Pane[0]/Document[0]/Window[1]" } },
  } as unknown as UiEntityCandidate;

  async function click(label: string) {
    const execute = vi.fn(async () => "uia" as const);
    const facade = new DesktopFacade(async () => [
      cand("ta-field", "/Pane[0]/Document[0]/Window[1]/Edit[0]"),
      cand("bi-field", "/Pane[0]/Document[0]/Edit[0]", { rect: { x: 38, y: 185, width: 227, height: 28 } }),
      panelCand,
    ], { executorFn: execute });
    const view = await facade.see({ target: { windowTitle: "Chrome" } });
    const result = await facade.touch({ lease: view.entities.find((e) => e.label === label)!.lease, action: "click" });
    return { result, execute };
  }

  it("clicks the panel's own field", async () => {
    const { result, execute } = await click("ta-field");
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("still refuses a field outside the panel, naming it", async () => {
    const { result, execute } = await click("bi-field");
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking", blockingElement: { name: "URL の送信" } });
    expect(execute).not.toHaveBeenCalled();
  });
});

// Driven through the provider, so the cell fails when the mapping that carries the path is removed.
describe("internal #321 — the read's path reaches the candidate", () => {
  afterEach(() => { vi.doUnmock("../../src/engine/uia-bridge.js"); vi.resetModules(); });

  async function candidatesFrom(elements: unknown[]) {
    vi.resetModules();
    vi.doMock("../../src/engine/uia-bridge.js", () => ({
      getUiElements: vi.fn(async () => ({ elements, elementCount: elements.length, windowHwnd: "4919" })),
      detectUiaBlind: () => ({ blind: false }),
    }));
    const { fetchUiaCandidates } = await import("../../src/tools/desktop-providers/uia-provider.js");
    return (await fetchUiaCandidates({ windowTitle: "Chrome", hwnd: "4919" })).candidates;
  }
  const EL = { name: "ta-field", controlType: "Edit", isEnabled: true, boundingRect: { x: 1, y: 2, width: 3, height: 4 }, patterns: ["Value"] };

  it("carries it", async () => {
    const [c] = await candidatesFrom([{ ...EL, path: "/Pane[0]/Window[1]/Edit[0]" }]);
    expect(c?.locator?.uia?.path).toBe("/Pane[0]/Window[1]/Edit[0]");
  });

  it("leaves it absent when the read did not record it", async () => {
    const [c] = await candidatesFrom([EL]);
    expect(c?.locator?.uia).not.toHaveProperty("path");
  });
});
