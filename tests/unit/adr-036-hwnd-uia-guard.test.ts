/**
 * adr-036-hwnd-uia-guard.test.ts — ADR-036 I-1 for the UIA writes.
 *
 * `click_element` / `set_element_value` already routed the ACTION through the
 * resolved handle (`FromHandle`, the H3 path), and only the guard in front of
 * them still resolved by title. So a caller who passed `hwnd` was refused with
 * `ambiguous_target` by a check standing in front of a call that would have
 * gone to exactly the right window.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const SIBLING = 0x1111n;
const LIVE = 0x2222n;

// The enumeration the guard counts. Mutable so the separability cases below can
// put two DIFFERENT titles on the desktop; `beforeEach` puts the shared-title
// pair back, which is what every other test in this file expects.
const { winsRef } = vi.hoisted(() => ({ winsRef: { list: [] as unknown[] } }));
const win = (hwnd: bigint, title: string, zOrder: number) => ({
  hwnd, title, zOrder, isActive: zOrder === 0,
  region: { x: 0, y: 0, width: 800, height: 600 },
  isMinimized: false, isMaximized: false, className: "Chrome_WidgetWin_1", ownerHwnd: null,
});

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => winsRef.list),
    getWindowProcessId: vi.fn(() => 7),
    getWindowIdentity: vi.fn(() => ({ pid: 7, processName: "chrome.exe", processStartTimeMs: 0 })),
    // Kept deterministic so the identity hints below describe the fixture and
    // not whatever process happens to own pid 7 on the machine running this.
    getProcessIdentityByPid: vi.fn(() => ({ pid: 7, processName: "chrome.exe", processStartTimeMs: 0 })),
  };
});

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: vi.fn(() => []),
  buildWindowIdentity: vi.fn((hwnd: string) => ({
    hwnd, pid: 7, processName: "chrome.exe", processStartTimeMs: 1700000000000, titleResolved: SHARED_TITLE,
  })),
}));

vi.mock("../../src/engine/perception/guards.js", () => ({
  evaluateGuards: vi.fn(() => ({
    ok: true, policy: "block", attention: "ok", results: [], failedGuard: undefined,
  })),
}));

const { mockClickElement, mockSetElementValue, mockGetUiElements, mockInsertText } = vi.hoisted(() => ({
  mockClickElement: vi.fn(async () => ({ ok: true })),
  mockSetElementValue: vi.fn(async () => ({ ok: true })),
  mockGetUiElements: vi.fn(async () => ({ ok: true, elements: [] })),
  mockInsertText: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    clickElement: (...a: unknown[]) => mockClickElement(...(a as [])),
    setElementValue: (...a: unknown[]) => mockSetElementValue(...(a as [])),
    getUiElements: (...a: unknown[]) => mockGetUiElements(...(a as [])),
    insertTextViaTextPattern2: (...a: unknown[]) => mockInsertText(...(a as [])),
  };
});

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) =>
      p.hwnd !== undefined
        ? { hwnd: BigInt(p.hwnd), title: SHARED_TITLE, warnings: [], className: "Chrome_WidgetWin_1" }
        : null
    ),
  };
});

const { mockRunActionGuard } = vi.hoisted(() => ({ mockRunActionGuard: vi.fn() }));
vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  mockRunActionGuard.mockImplementation(actual.runActionGuard);
  return { ...actual, runActionGuard: mockRunActionGuard };
});

const { clickElementHandler, setElementValueHandler, getUiElementsHandler } =
  await import("../../src/tools/ui-elements.js");
import { _resetForTest as resetHotCache } from "../../src/engine/perception/hot-target-cache.js";
import { buildHintsForTitle } from "../../src/engine/identity-tracker.js";

function parse(result: { content?: Array<{ type: string; text: string }> }): Record<string, any> {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

function guardDescriptor(): Record<string, unknown> | null {
  expect(mockRunActionGuard).toHaveBeenCalled();
  const last = mockRunActionGuard.mock.calls.at(-1)![0] as { descriptor: Record<string, unknown> | null };
  return last.descriptor;
}

beforeEach(() => {
  winsRef.list = [win(SIBLING, SHARED_TITLE, 0), win(LIVE, SHARED_TITLE, 1)];
  resetHotCache();
  mockRunActionGuard.mockClear();
  mockClickElement.mockClear();
  mockSetElementValue.mockClear();
  mockGetUiElements.mockClear();
  mockInsertText.mockClear();
  mockSetElementValue.mockResolvedValue({ ok: true });
  delete process.env.DTM_SET_VALUE_CHAIN;
  delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
});

describe("ADR-036 I-1 — UIA writes carry the caller's handle into the guard", () => {
  it("click_element by title alone is refused with ambiguous_target", async () => {
    const r = parse(await clickElementHandler({ windowTitle: SHARED_TITLE, name: "OK" } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(mockClickElement).not.toHaveBeenCalled();
  });

  it("click_element with a handle passes and clicks through that handle", async () => {
    const r = parse(await clickElementHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), name: "OK",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
    // The action was already handle-addressed before this ADR — pinned as a
    // regression so the guard and the click cannot drift apart again.
    expect(mockClickElement.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
  });

  it("set_element_value by title alone is refused", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(mockSetElementValue).not.toHaveBeenCalled();
  });

  it("set_element_value with a handle passes and sets through that handle", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
    expect(mockSetElementValue.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
  });

  it("keeps set_element_value refused while the fallback chain can leave the handle", async () => {
    // With DTM_SET_VALUE_CHAIN=1 a failed ValuePattern attempt continues to the
    // TextPattern2 insert and then to a foreground select-all-and-replace, and
    // BOTH still resolve by title. Lifting the refusal there would trade a stop
    // for a write into the sibling's field, so the pin waits for those channels.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(mockSetElementValue).not.toHaveBeenCalled();
  });

  it("does not tell that caller to pass the handle it just passed", async () => {
    // The generic `ambiguous_target` advice is "pass hwnd", and here the
    // descriptor withholds the handle on purpose — so following that advice
    // returns to this same refusal. That loop is the shape this whole PR
    // exists to remove; it must not survive in the one case still refused.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    const said = JSON.stringify(r);
    expect(said).toContain("DTM_SET_VALUE_CHAIN");

    // Nothing in the whole response may tell this caller to pass hwnd TO THIS
    // TOOL: the descriptor withholds it on purpose while the chain is armed, so
    // that advice comes straight back to this refusal. Sentence-scoped rather
    // than a ban on the two words — "pass hwnd to click_element or keyboard" is
    // the correct advice and has to stay sayable. Case-insensitive because the
    // catalogue's lower-case "pass hwnd to name one window exactly" sat in this
    // same response, contradicting its own error text, while an assertion
    // written against the capitalised form did not see it.
    for (const sentence of said.split(/(?<=[.;])\s+/)) {
      if (!/pass\s+hwnd/i.test(sentence)) continue;
      expect(sentence).toMatch(/click_element|keyboard/);
    }

    // Read the field the guard fills, not the serialised envelope.
    // `_perceptionForPost` is spread onto the ROOT of a failure, not into
    // `context`; an earlier version of this test looked in `context`, got
    // `undefined`, and silently asserted against the whole JSON blob — which
    // includes the static suggest catalogue, so an edit there could have
    // flipped these.
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).not.toBe("");

    // The recoveries the caller can perform on its next call, named first.
    expect(next).toContain("click_element");
    expect(next).toContain("keyboard");
    // …and the one only an operator can perform, after them. Keyed on the
    // INSTRUCTION to unset rather than on a chosen word, so a rewrite that keeps
    // the order keeps passing — and so an extra unset-first sentence cannot slip
    // in ahead of the tools while a later mention keeps the check happy.
    const unsetAt = next.search(/unset\w*\s+(?:that variable|the variable|DTM_SET_VALUE_CHAIN)/i);
    expect(unsetAt).toBeGreaterThan(-1);
    expect(next.indexOf("click_element")).toBeLessThan(unsetAt);

    // The title advice is never offered flat, and the condition it carries is
    // the matcher's: this window's NORMALIZED title must not be contained in
    // any other's. Three weaker conditions have been shot in review — identical
    // titles, titles differing ahead of the browser suffix, and raw-title
    // uniqueness — each true and each useless.
    expect(next).toMatch(/windowTitle[^.]*only/i);
    expect(next).toMatch(/not contained in any other/i);
    expect(next).toMatch(/suffix/i);
    // The containment example is asymmetric and has been flattened once: for
    // "Report" beside "Report archive" the SHORTER one cannot be named and the
    // longer one still can, so a text that calls the pair inseparable takes a
    // working recovery away from half the callers. Whatever words carry that,
    // one of them survives here.
    expect(next).toMatch(/Report archive[^.]*(?:longer|still can)|(?:shorter|longer)[^.]*Report archive/i);
    // These three are prose checks and cannot be more than that: a rewrite can
    // keep every word and weaken the meaning. What holds the meaning is the
    // describe below, which puts each of those cases on the desktop and asks
    // the matcher — so a text that promises narrowing where narrowing does not
    // work is contradicted by a test rather than by a reviewer.

    // The tailored `suggest` replaces a catalogue keyed on guard status, and
    // nothing had pinned it: deleting it outright, or appending the catalogue's
    // other statuses back into it, both left this file green.
    expect(r.suggest).toEqual([
      expect.stringMatching(/error message/i),
      expect.stringMatching(/desktop_discover/),
    ]);
    // The other statuses' advice must not come back with it — those lines are
    // about target_not_found, modals, elevation, and none of them is what
    // happened here.
    expect(JSON.stringify(r.suggest)).not.toMatch(/target_not_found|blocked_by_modal|needs_escalation/);

    // This is the first production use of `failCode`'s `rootExtras`, which —
    // unlike `failWith`'s `context` — is spread onto the root unfiltered. Pin
    // the key set so a second key cannot arrive there unnoticed, and so the
    // shape stays what the twelve `AutoGuardBlocked` producers hand back.
    expect(Object.keys(r).sort()).toEqual(["_perceptionForPost", "code", "error", "ok", "suggest"]);
    expect(r.code).toBe("AutoGuardBlocked");
  });

  it("keeps the generic advice in the SAME tool when the handle can rescue it", async () => {
    // The pairing has to be set_element_value itself: with the chain off,
    // passing hwnd IS the recovery here, so the special case must not reach
    // this call. Asserting it on another tool would leave "special-case every
    // ambiguous set_element_value" indistinguishable from the real rule.
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, value: "x", name: "Field",
    } as never));
    expect(JSON.stringify(r)).toContain("Pass hwnd to name one window exactly");
    expect(JSON.stringify(r)).not.toContain("DTM_SET_VALUE_CHAIN");
    // The second half of that same generic line used to offer `name` and
    // `automationId` as ways to narrow an ambiguous target. The guard counts
    // WINDOWS — `resolveActionTarget` sees `titleIncludes` and nothing else —
    // so neither can change the count, in this tool or in any other that shares
    // the catalogue.
    // Keyed on the axes rather than on the slashes: the wrong advice reads the
    // same written "windowTitle, name or automationId". What must not appear is
    // either of them standing as something to narrow UNTIL the count changes.
    expect(JSON.stringify(r)).not.toMatch(/narrow[^.]*\b(?:name|automationId)\b[^.]*until/i);
    // And the correction itself has to survive: the line says outright that the
    // two cannot move the count, which is the fact a reader needs.
    expect(JSON.stringify(r)).toMatch(/name \/ automationId do not change the count/);
  });
});

// ─── The response hints describe the window that was acted on ────────────────

describe("ADR-036 — hints report the named window, not the first title match", () => {
  it("buildHintsForTitle answers on the handle when one is given", () => {
    expect(buildHintsForTitle(SHARED_TITLE)?.hwnd).toBe(SIBLING);   // the defect
    expect(buildHintsForTitle(SHARED_TITLE, LIVE)?.hwnd).toBe(LIVE);
  });

  it("yields no hints for a handle that is not open, rather than a title match", () => {
    // Answering with the sibling would hand the caller a handle to reuse for a
    // window they never named — the failure mode this whole ADR is about.
    expect(buildHintsForTitle(SHARED_TITLE, 0x9999n)).toBeNull();
  });

  it("does NOT pin get_ui_elements' hints, because its read is still by title", async () => {
    // The first cut of this pinned them and asserted the handle reached
    // `getUiElements`. It did — as a CACHE KEY. The read itself passes only the
    // title to both backends, so pinned hints would have labelled the response
    // with the named window while the elements came from its sibling, and then
    // filed those elements under the named window's handle. A wrong answer
    // stored under the right key is worse than a uniformly wrong one, and the
    // mock in that first version is what made it look right.
    const r = parse(await getUiElementsHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), maxDepth: 2, maxElements: 30,
    } as never));
    expect(mockGetUiElements).toHaveBeenCalled();
    // The read got a title and no handle-scoped path.
    expect(mockGetUiElements.mock.calls[0]![0]).toBe(SHARED_TITLE);
    // And the response says so: the hints name the window the read actually
    // went to. Asserted on the RESPONSE, not on the helper, so re-pinning the
    // hints without pinning the read breaks this test — which is the whole
    // point, since that combination is what shipped and had to be undone.
    expect(r.hints?.target?.hwnd).toBe(String(SIBLING));
  });

  it("click_element reports the handle it clicked", async () => {
    const r = parse(await clickElementHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), name: "OK",
    } as never));
    // Asserted positively, not as "!== sibling": an absent hints block would
    // satisfy the negative form while telling the caller nothing.
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
  });
});

// ─── The report follows the channel that actually wrote ──────────────────────

describe("ADR-036 — set_element_value's hints name the channel's window, not the caller's handle", () => {
  it("reports the handle when the write went through it (channel 1)", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(r.channel).toBe("value");
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
  });

  it("does NOT report the handle when the write fell through to a title-resolved channel", async () => {
    // The guard's own gate (`mayPinHandle`) cannot cover this: `lensId` and
    // `DESKTOP_TOUCH_AUTO_GUARD=0` both skip `runActionGuard`, so with the chain
    // armed the fallbacks stay reachable and the refusal is never consulted.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    mockSetElementValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    // Channel 2 ran, and it resolved its window by title — so the report says
    // the window a title resolves to, not the one the caller named.
    expect(r.channel).toBe("text2");
    expect(mockInsertText).toHaveBeenCalled();
    expect(mockInsertText.mock.calls[0]![0]).toBe(SHARED_TITLE);
    expect(r.hints?.target?.hwnd).toBe(String(SIBLING));
  });
});

// ─── The facts the refusal states about narrowing, asked of the matcher ──────

describe("ADR-036 — when a narrower windowTitle can and cannot separate two windows", () => {
  // Title-only calls: `resolveWindowTarget` returns null for these, so the
  // guard counts exactly what `resolveActionTarget` sees.
  const ask = async (windowTitle: string) =>
    JSON.stringify(parse(await setElementValueHandler({ windowTitle, value: "x", name: "Field" } as never)));
  const refused = async (t: string) => (await ask(t)).includes("ambiguous_target");

  it("cannot separate a title that is a substring of its sibling — no query escapes", async () => {
    winsRef.list = [win(SIBLING, "Report", 0), win(LIVE, "Report archive", 1)];
    // Every query that names the first window names the second as well.
    for (const q of ["Report", "report", "Repor", "R", "Report "]) {
      expect(await refused(q)).toBe(true);
    }
    // The only query that narrows resolves the OTHER window.
    expect(await refused("Report archive")).toBe(false);
  });

  it("cannot separate titles that differ only in case or padding — normalization eats it", async () => {
    winsRef.list = [win(SIBLING, "Report", 0), win(LIVE, "  REPORT  ", 1)];
    for (const q of ["Report", "REPORT", " report "]) {
      expect(await refused(q)).toBe(true);
    }
  });

  it("cannot separate one page open in Chrome and in Edge — the suffix is stripped from the query too", async () => {
    winsRef.list = [
      win(SIBLING, "pictkura - Google Chrome", 0),
      win(LIVE, "pictkura - Microsoft Edge", 1),
    ];
    // Including the query that names one of them in full.
    for (const q of ["pictkura", "pictkura - Google Chrome", "pictkura - Microsoft Edge"]) {
      expect(await refused(q)).toBe(true);
    }
  });

  it("CAN separate them when the suffix is one the matcher does not strip", async () => {
    // The positive control the refusal's promise rests on: narrowing works when
    // the normalized title is not contained in the other. Brave is not in
    // BROWSER_SUFFIXES, so its suffix survives normalization and separates.
    winsRef.list = [
      win(SIBLING, "pictkura - Google Chrome", 0),
      win(LIVE, "pictkura - Brave", 1),
    ];
    expect(await refused("pictkura")).toBe(true);
    expect(await refused("pictkura - Brave")).toBe(false);
  });
});
