/**
 * internal #211 — a window holding a web page (the UIA lane's `webArea`) is ordered page-first, so
 * discover's first `maxEntities` are the page and not the browser's tabs and toolbar. It does not
 * start OCR: on #746 OCR cost 340–435 ms per discover and almost none of it reached the first 50
 * (win2); a caller that misses the page's text switches to screenshot's OCR (the user, 2026-09-29).
 * `pageFirst` itself still places OCR and visual text when a blind window's OCR ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";

const mocks = vi.hoisted(() => ({
  resolveWindowTarget: vi.fn(),
  uia: vi.fn(),
  ocr: vi.fn(),
  none: vi.fn(async () => ({ candidates: [], warnings: [] })),
  visual: vi.fn(async () => ({ candidates: [], warnings: [] })),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({ resolveWindowTarget: mocks.resolveWindowTarget }));
vi.mock("../../src/tools/desktop-providers/uia-provider.js", () => ({ fetchUiaCandidates: mocks.uia }));
vi.mock("../../src/tools/desktop-providers/ocr-provider.js", () => ({ fetchOcrCandidates: mocks.ocr }));
vi.mock("../../src/tools/desktop-providers/browser-provider.js", () => ({ fetchBrowserCandidates: mocks.none }));
vi.mock("../../src/tools/desktop-providers/terminal-provider.js", () => ({ fetchTerminalCandidates: mocks.none }));
vi.mock("../../src/tools/desktop-providers/visual-provider.js", () => ({ fetchVisualCandidates: mocks.visual }));
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
  getWindowIdentity: vi.fn(() => undefined),
  getWindowClassName: vi.fn(() => "Chrome_WidgetWin_1"),
  getWindowTitleW: vi.fn(() => "FX-HTML - Google Chrome"),
  getWindowRectByHwnd: vi.fn(() => ({ x: 0, y: 0, width: 900, height: 700 })),
}));

import { composeCandidates, pageFirst } from "../../src/tools/desktop-providers/compose-providers.js";

const PAGE = { x: 0, y: 100, width: 900, height: 600 };

function uia(label: string, rect: UiEntityCandidate["rect"], automationId?: string): UiEntityCandidate {
  return {
    source: "uia",
    target: { kind: "window", id: "500" },
    label,
    role: "button",
    rect,
    actionability: ["click"],
    confidence: 1,
    observedAtMs: 0,
    provisional: false,
    locator: { uia: { name: label, ...(automationId && { automationId }) } },
  } as UiEntityCandidate;
}
const ocr = (label: string): UiEntityCandidate =>
  ({ source: "ocr", target: { kind: "window", id: "500" }, label, role: "label", rect: { x: 50, y: 300, width: 80, height: 20 }, actionability: ["click"], confidence: 0.8, observedAtMs: 0, provisional: false }) as UiEntityCandidate;

// Read order, as the breadth-first walk returns it: the browser's chrome, then the page.
const tabs = uia("New Tab", { x: 10, y: 10, width: 100, height: 30 });
const address = uia("Address and search bar", { x: 120, y: 50, width: 600, height: 30 });
const root = uia("FX-HTML", PAGE, "RootWebArea");
const inc = uia("Increment", { x: 40, y: 200, width: 100, height: 30 }, "inc");

beforeEach(() => {
  mocks.resolveWindowTarget.mockReset().mockResolvedValue({ title: "FX-HTML - Google Chrome", hwnd: 500n, warnings: [] });
  mocks.ocr.mockReset().mockResolvedValue({ candidates: [ocr("Count: 3")], warnings: [] });
  mocks.visual.mockReset().mockResolvedValue({ candidates: [], warnings: [] });
});


const withPage = (candidates: UiEntityCandidate[]) => ({ candidates, warnings: [], webArea: PAGE });

describe("a window holding a web page", () => {
  it("runs no OCR: UIA reads it", async () => {
    mocks.uia.mockResolvedValue(withPage([tabs, address, root, inc]));
    await composeCandidates({ hwnd: "500" });
    expect(mocks.ocr).not.toHaveBeenCalled();
  });

  it("is ordered page-first: page controls, then the browser's chrome", async () => {
    mocks.uia.mockResolvedValue(withPage([tabs, address, root, inc]));
    const result = await composeCandidates({ hwnd: "500" });
    expect(result.candidates.map((c) => c.label)).toEqual(["Increment", "New Tab", "Address and search bar", "FX-HTML"]);
  });

  it("drops the visual lane's replay of text that repeats a page control", async () => {
    const replay = { ...ocr("Increment"), source: "visual_gpu", rect: { x: 50, y: 205, width: 70, height: 18 } } as UiEntityCandidate;
    mocks.visual.mockResolvedValue({ candidates: [replay], warnings: [] });
    mocks.uia.mockResolvedValue(withPage([root, inc]));
    const result = await composeCandidates({ hwnd: "500" });
    expect(result.candidates.filter((c) => c.label === "Increment").map((c) => c.source)).toEqual(["uia"]);
  });

  it("counts a control half scrolled out of the page as on the page (its centre is)", async () => {
    const half = uia("Half link", { x: 40, y: 680, width: 100, height: 30 });
    mocks.uia.mockResolvedValue(withPage([tabs, root, half]));
    const result = await composeCandidates({ hwnd: "500" });
    expect(result.candidates[0].label).toBe("Half link");
  });
});

describe("pageFirst, where a blind window's OCR ran", () => {
  it("puts OCR on the page after the page's controls, and OCR of the chrome behind", () => {
    const tabText = { ...ocr("GitHub - Pull request"), rect: { x: 12, y: 12, width: 90, height: 20 } } as UiEntityCandidate;
    const ordered = pageFirst([tabs, root, inc, tabText, ocr("Count: 3")], PAGE);
    expect(ordered.map((c) => c.label)).toEqual(["Increment", "Count: 3", "New Tab", "FX-HTML", "GitHub - Pull request"]);
  });

  it("drops OCR that repeats a page control, and keeps the same text elsewhere on the page", () => {
    const same = { ...ocr("Increment"), rect: { x: 50, y: 205, width: 70, height: 18 } } as UiEntityCandidate;
    const elsewhere = { ...ocr("Increment"), rect: { x: 400, y: 500, width: 70, height: 18 } } as UiEntityCandidate;
    const ordered = pageFirst([root, inc, same, elsewhere], PAGE);
    expect(ordered.filter((c) => c.label === "Increment").map((c) => c.rect?.x)).toEqual([40, 400]);
  });

  it("does not drop page text that only matches the page's own title or the browser's chrome", () => {
    const heading = { ...ocr("FX-HTML"), rect: { x: 40, y: 150, width: 120, height: 30 } } as UiEntityCandidate;
    const word = { ...ocr("New Tab"), rect: { x: 400, y: 400, width: 80, height: 20 } } as UiEntityCandidate;
    const ordered = pageFirst([tabs, root, inc, heading, word], PAGE);
    expect(ordered.filter((c) => c.source === "ocr").map((c) => c.label)).toEqual(["FX-HTML", "New Tab"]);
  });
});

describe("a window without one (the control)", () => {
  it("runs no OCR and keeps read order", async () => {
    const save = uia("Save", { x: 10, y: 10, width: 60, height: 20 });
    const cancel = uia("Cancel", { x: 80, y: 10, width: 60, height: 20 });
    const text = uia("Text editor", { x: 0, y: 40, width: 900, height: 600 });
    mocks.uia.mockResolvedValue({ candidates: [save, cancel, text], warnings: [] });
    const result = await composeCandidates({ hwnd: "500" });
    expect(mocks.ocr).not.toHaveBeenCalled();
    expect(result.candidates.map((c) => c.label)).toEqual(["Save", "Cancel", "Text editor"]);
  });

  it("does not read a page from a RootWebArea candidate the lane did not report as one", async () => {
    mocks.uia.mockResolvedValue({ candidates: [tabs, inc, root], warnings: [] });
    const result = await composeCandidates({ hwnd: "500" });
    expect(result.candidates.map((c) => c.label)).toEqual(["New Tab", "Increment", "FX-HTML"]);
  });
});

describe("a blind window (OCR as before)", () => {
  it("still gets OCR, with its lane warnings", async () => {
    mocks.ocr.mockResolvedValue({ candidates: [], warnings: ["ocr_attempted_empty"] });
    mocks.uia.mockResolvedValue({ candidates: [root], warnings: ["uia_blind_single_pane"] });
    const result = await composeCandidates({ hwnd: "500" });
    expect(mocks.ocr).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain("ocr_attempted_empty");
  });
});
