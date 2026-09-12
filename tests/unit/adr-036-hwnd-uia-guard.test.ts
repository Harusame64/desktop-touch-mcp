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
/** A window that IS on the desktop and has no title — the population the
 *  titleless refusal is for, as distinct from a caller who passed `""`. */
const UNTITLED = 0x3333n;
/** A window whose title is whitespace: the enumeration keeps it (`!title` is
 *  untrimmed) but `namesAWindow` trims, so the two rules disagree about it. */
const WSTITLED = 0x4444n;

// The enumeration the guard counts. Mutable so the separability cases below can
// put two DIFFERENT titles on the desktop; `beforeEach` puts the shared-title
// pair back, which is what every other test in this file expects.
const { winsRef, mockIsExcluded } = vi.hoisted(() => ({
  winsRef: { list: [] as unknown[] },
  mockIsExcluded: vi.fn(() => false),
}));
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
    // The pair that tells an UNTITLED window from a dead handle. `UNTITLED` is
    // a real window the enumeration refuses to list; `0xDEAD` is nothing.
    // A DEAD handle also reports `""` — that is why the rect is what separates
    // them, and a fixture where only the live one is blank cannot test it.
    getWindowTitleW: vi.fn((h: bigint) =>
      (h === UNTITLED || h === 0xDEADn ? "" : h === WSTITLED ? "   " : SHARED_TITLE)),
    getWindowRectByHwnd: vi.fn((h: bigint) =>
      h === 0xDEADn ? null : { x: 0, y: 0, width: 800, height: 600 }),
    isExcludedWindowHandle: mockIsExcluded,
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
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) => {
      // `@active` resolves to the foreground, which is how an UNTITLED window is
      // named at all — the enumeration that answers a plain title drops it.
      if (p.hwnd === undefined && p.windowTitle === "@active") {
        return { hwnd: UNTITLED, title: "", warnings: [], className: "X" };
      }
      if (p.hwnd === undefined) return null;
      const h = BigInt(p.hwnd);
      return {
        hwnd: h,
        title: h === UNTITLED ? "" : h === WSTITLED ? "   " : SHARED_TITLE,
        warnings: [], className: "Chrome_WidgetWin_1",
      };
    }),
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
  winsRef.list = [win(SIBLING, SHARED_TITLE, 0), win(LIVE, SHARED_TITLE, 1), win(WSTITLED, "   ", 2)];
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

    // Nothing in the response may tell this caller to pass hwnd TO THIS TOOL:
    // the descriptor withholds it on purpose while the chain is armed, so that
    // advice comes straight back to this refusal. "Pass hwnd to click_element
    // or keyboard" is the correct advice and has to stay sayable, so the rule
    // is about the OBJECT of the pass, not about the two words co-occurring.
    //
    // Over the individual strings rather than `JSON.stringify(r)`: the blob's
    // `","` separators carry no whitespace, so a split on sentence ends runs
    // chunks across field boundaries and a mention in one field satisfied a
    // check reading another. Split unconditionally on [.;] for the same reason
    // — a comma before "and you can also pass hwnd to this tool" defeated a
    // splitter that only broke on sentence ends.
    const strings = [
      String(r.error ?? ""),
      ...((r.suggest ?? []) as string[]),
      String((r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? ""),
    ];
    // EVERY occurrence, not the first acceptable one: `toMatch` succeeds on a
    // clause like "Pass hwnd to click_element, and also pass hwnd to this tool"
    // and never looks at the second directive — the comma-joined regression
    // this check exists for, walking in behind a correct phrasing.
    for (const clause of strings.flatMap((t) => t.split(/[.;]/))) {
      for (const m of clause.matchAll(/\bpass(?:ing|es)?\s+(?:the\s+|an?\s+)?hwnd\s+to\s+(\S+)/gi)) {
        expect(m[1]).toMatch(/^(?:click_element|keyboard)\b/);
      }
      // And a bare "pass hwnd" with no object names nothing that works. The
      // stem carries the inflections: "pass the hwnd to this tool" and
      // "Passing hwnd to this tool also works" both slipped past `pass\s+hwnd`.
      // Not "passed": that is how the message DESCRIBES what the caller did
      // ("if you passed hwnd, windowTitle was ignored"), which is the opposite
      // of telling them to do it.
      const bare = clause.replace(/\bpass(?:ing|es)?\s+(?:the\s+|an?\s+)?hwnd\s+to\s+\S+/gi, "");
      expect(bare).not.toMatch(/\bpass(?:ing|es)?\s+(?:the\s+|an?\s+)?hwnd/i);
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

    // The title advice says WHO it is for. Sentence 1 addresses the caller who
    // passed hwnd, and for that caller windowTitle is inert — the guard counted
    // with the RESOLVED window's own full title, so narrowing the argument
    // changes nothing. Unscoped, the longest half of this message sent the
    // reader it had just addressed back to the same refusal.
    expect(next).toMatch(/passed hwnd[^.]*ignored/i);
    expect(next).toMatch(/by title alone/i);

    // The title advice is never offered flat, and the condition it carries is
    // the matcher's: this window's NORMALIZED title must not be contained in
    // any other's. Three weaker conditions have been shot in review — identical
    // titles, titles differing ahead of the browser suffix, and raw-title
    // uniqueness — each true and each useless.
    expect(next).toMatch(/windowTitle[^.]*only/i);
    expect(next).toMatch(/not contained in any other/i);
    // Each example is pinned, because each answers a different way the advice
    // was wrong before: containment, case collapse, and the browser suffix —
    // the last one being Codex's own finding, which "strips a suffix" would
    // have quietly dropped from the text while this file stayed green.
    expect(next).toMatch(/Chrome, Edge or Firefox suffix/i);
    expect(next).toMatch(/REPORT/);
    // The containment example is asymmetric, and the asymmetry has a direction:
    // the SHORTER title cannot be named (every query matching it matches the
    // longer one too) and the LONGER one still can. Flattening it to "this pair
    // cannot be separated" was one regression; saying it backwards is another,
    // and a check that only looks for the words accepts both. Each side is
    // asserted where it belongs, and the pair below measures the same two facts
    // against the matcher.
    // Anchored on the phrases rather than the words: `[^.]*` reaches across
    // clauses, and the inverted sentence — longer unreachable, shorter still
    // reachable — satisfied a word-level check by borrowing "can never" from
    // the clause after it. Tight, and knowingly so; the direction is a fact
    // about the matcher, measured in the pair below.
    expect(next).toMatch(/shorter of[^.]*can never/i);
    // Affirmative by construction, not by excluding negators: "still can" is a
    // prefix of "still can never be named" AND of "still can no longer be
    // named", and a lookahead listing the negations it knows about is a race
    // with the language. The clause has to complete the verb.
    expect(next).toMatch(/longer one still can be named/i);
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

  it("does not promise the handle to a titleless target — nothing can reach it", async () => {
    // `@active` on an untitled foreground window resolves to an empty title,
    // which matches every window, so the count is ambiguous. Unsetting the
    // variable does NOT rescue that caller: `enumWindowsInZOrder` drops
    // untitled windows, so the by-handle guard comes back `target_not_found`.
    // Promising the handle here would be the same loop one shape over.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: "@active", value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(next).toMatch(/no title/i);
    expect(next).not.toMatch(/click_element and keyboard take hwnd here/);
    // It says what actually happens…
    expect(next).toMatch(/target_not_found/);
    // …and names the one recovery that does work, with its limit. `keyboard`
    // passes a titleless handle while the window is in the foreground
    // (`keyboardDestinationMiss` — "the legitimate @active case"), so leaving it
    // out was this PR's own defect with the sign flipped: denying a recovery
    // that works.
    expect(next).toMatch(/keyboard[^.]*foreground/i);
    expect(next).toMatch(/@active/);

    // The `suggest` list, which is what the server instructions tell the model
    // to read, and which had no assertion at all until a mutant that deleted
    // this whole arm survived the suite. It said "nothing addresses it by
    // handle" — denying the one recovery the message two lines up offers.
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/desktop_discover cannot list this window/);
    expect(suggests).toMatch(/keyboard does accept its hwnd, but only while this window is in the foreground/);
    expect(suggests).not.toMatch(/nothing addresses it by handle/);
    // And it must not offer the whitespace arm's wording, which promises
    // `click_element` a handle it cannot use here.
    expect(suggests).not.toMatch(/click_element accepts it on this window/);
  });

  it("answers the titleless caller on the DEFAULT path too, not only with the chain armed", async () => {
    // `allSetValueChannelsAreHandleAddressed` is `!chain`, so all of the text
    // above was reachable only with a flag set. With the chain OFF — the
    // default — the handle IS accepted and the generic catalogue answers "pass
    // hwnd (desktop_discover returns it)". For a titleless window both halves
    // are dead: the enumeration drops it on `!title`, so `desktop_discover`
    // cannot list it and the by-handle guard comes back `target_not_found`.
    // Measured: pass hwnd → run desktop_discover → pass hwnd. A two-step loop,
    // on the path nobody has to configure.
    delete process.env.DTM_SET_VALUE_CHAIN;
    const r = parse(await setElementValueHandler({
      windowTitle: "@active", value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(next).toMatch(/no title/i);
    // Chain-aware: with the chain off there is nothing to unset, so naming the
    // variable here would send an operator after a flag that is already unset.
    expect(next).toMatch(/passing hwnd to this tool returns target_not_found/);
    expect(next).not.toMatch(/unsetting DTM_SET_VALUE_CHAIN/);
    expect(next).toMatch(/keyboard[^.]*foreground/i);
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/desktop_discover cannot list this window/);
    // The generic catalogue, whose ambiguous_target line is the dead half, is
    // replaced rather than appended to.
    expect(suggests).not.toMatch(/pass hwnd to name one window exactly/);
  });

  it("does not send a titleless-handle caller to a listing that cannot show it", async () => {
    // Both gates found this from opposite ends. `enumWindowsInZOrder` drops a
    // window on `!title`, and BOTH the guard's by-handle lookup and
    // `desktop_discover` read it — so a caller who named an untitled window by
    // handle got `target_not_found` with "call desktop_discover", which cannot
    // contain it, and whose own recovery is to pass the handle they had just
    // passed. Two steps, closed loop, on the shipping default configuration.
    delete process.env.DTM_SET_VALUE_CHAIN;
    // The window is REAL — it just is not in the enumeration, which is exactly
    // the state the message has to describe.
    winsRef.list = [win(SIBLING, SHARED_TITLE, 0)];
    const r = parse(await clickElementHandler({
      windowTitle: "anything", hwnd: String(UNTITLED), name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    // The STATUS field, not the serialised blob: `suggest` carries the literal
    // "(target_not_found)" on every AutoGuardBlocked, so `toContain` on the JSON
    // was satisfied by the catalogue and would have passed for the ambiguous
    // case too.
    expect((r as { _perceptionForPost?: { status?: string } })._perceptionForPost?.status)
      .toBe("target_not_found");
    expect(next).not.toMatch(/Call desktop_discover to verify the window title/);
    expect(next).toMatch(/does not list/i);
    expect(next).toMatch(/keyboard[^.]*foreground/i);
    expect(next).toMatch(/@active/);

    // And the array beside it. Twenty-five rounds audited `next`; nobody opened
    // `suggest`, which said "run desktop_discover" and "pass hwnd" — the two
    // things the message had just ruled out — in the same payload.
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/desktop_discover cannot list this window/);
    expect(suggests).not.toMatch(/run desktop_discover — the window or element/);
    expect(suggests).not.toMatch(/pass hwnd to name one window exactly/);
  });

  it("set_element_value gets the same tailored suggest, not the catalogue", async () => {
    // The first version honoured the per-refusal `suggest` in `click_element`
    // and left `set_element_value` rebuilding the catalogue — so the same
    // response carried the tailored recovery in `next` and its contradiction in
    // `suggest`, one TOOL over from where the defect was found one FIELD over.
    // Rendered centrally now.
    delete process.env.DTM_SET_VALUE_CHAIN;
    winsRef.list = [win(SIBLING, SHARED_TITLE, 0)];
    const r = parse(await setElementValueHandler({
      windowTitle: "anything", hwnd: String(UNTITLED), value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).toMatch(/does not list/i);
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/desktop_discover cannot list this window/);
    expect(suggests).not.toMatch(/run desktop_discover — the window or element/);
    // …and the perception object handed to `_post` is the summary WITHOUT the
    // presentation field.
    expect((r as { _perceptionForPost?: Record<string, unknown> })._perceptionForPost)
      .not.toHaveProperty("suggest");
  });

  it("catches a window the enumeration drops for a reason OTHER than the title", async () => {
    // The enumeration drops on several conditions and the first version of this
    // asked about one — the empty title. A window that HAS a title and is
    // dropped for any of the others produces the identical dead loop, so the
    // predicate asks the enumeration rather than guessing which rule bit.
    //
    // The fixture models the predicate's own definition ("live, and not in the
    // list"), which is all it can: the drop happens inside the native
    // enumeration and this suite mocks that enumeration wholesale. What it does
    // discriminate is the change — with the title-only predicate this call gets
    // the generic catalogue instead.
    winsRef.list = [win(SIBLING, SHARED_TITLE, 0)];   // LIVE is titled but absent
    const r = parse(await clickElementHandler({
      windowTitle: "anything", hwnd: String(LIVE), name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).toMatch(/does not list it/i);
    // The message states the rule rather than asserting which clause failed —
    // it cannot know, and its previous wording told a titled window it had no
    // title.
    expect(next).toMatch(/visible, titled, have a\s+rectangle/i);
    expect(next).not.toMatch(/usually an untitled one/i);
  });

  it("reaches the caller whose handle the descriptor deliberately withholds", async () => {
    // With `DTM_SET_VALUE_CHAIN=1` the descriptor drops the handle on purpose —
    // the fallback channels resolve by title, so pinning the guard to a handle
    // the write will not use is worse than refusing. That also hid this refusal
    // on exactly the configuration the tool's tailoring exists for: a caller who
    // DID pass `hwnd` was told to run `desktop_discover` for a window it cannot
    // list. The handle now reaches the guard for wording only.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    winsRef.list = [win(SIBLING, "Nothing matches this", 0)];
    const r = parse(await setElementValueHandler({
      windowTitle: "anything", hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).toMatch(/does not list it/i);
    expect(next).not.toMatch(/Call desktop_discover to verify the window title/);
  });

  it("says nothing to a caller holding the key locker's handle", async () => {
    // The enumeration drops that window ON PURPOSE, so "not in the list" is true
    // of it — and this refusal would then explain how to reach it. Unreachable
    // today because every descriptor builder resolves first and
    // `resolveWindowTarget` throws `WindowExcluded`; it fails closed here so it
    // stays unreachable when a seventh builder appears.
    // `mockReturnValue`, not `…Once`: something upstream of the predicate asks
    // the same question, and a one-shot answer was consumed before it got there.
    mockIsExcluded.mockReturnValue(true);
    winsRef.list = [win(SIBLING, SHARED_TITLE, 0)];
    const r = parse(await clickElementHandler({
      windowTitle: "anything", hwnd: String(LIVE), name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).not.toMatch(/does not list it/i);
    expect(next).toMatch(/Call desktop_discover to verify the window title/);
    mockIsExcluded.mockReturnValue(false);
  });

  it("still says to check the title when the handle names nothing at all", async () => {
    // The pairing, and the reason the predicate reads the RECT: a dead handle
    // reports an empty title too, so a check on the title alone would tell a
    // caller whose window is gone that it merely has no name.
    delete process.env.DTM_SET_VALUE_CHAIN;
    winsRef.list = [win(SIBLING, SHARED_TITLE, 0)];
    const r = parse(await clickElementHandler({
      windowTitle: "anything", hwnd: "0xDEAD", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).not.toMatch(/no title/i);
    expect(next).toMatch(/Call desktop_discover to verify the window title/);
  });

  it("an EMPTY windowTitle is not a titleless window — that caller keeps the generic advice", async () => {
    // The two populations `effectiveTitle === ""` collapsed together. Nothing on
    // this desktop is untitled; the caller passed an empty query, which the
    // schema allows and which matches every window. Both recoveries the
    // titleless text calls broken work here: `desktop_discover` lists these
    // windows and the handle reaches them. Every test written for this branch
    // across three rounds used THIS fixture and read it as the other one.
    delete process.env.DTM_SET_VALUE_CHAIN;
    const r = parse(await setElementValueHandler({
      windowTitle: "", value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(next).not.toMatch(/no title/i);
    expect(next).not.toMatch(/desktop_discover cannot list/);
    // The catalogue's own advice, which is right for this caller.
    expect(next).toMatch(/pass hwnd/i);
  });

  it("and the same empty query with the chain armed takes the ordinary refusal", async () => {
    // The chain-on half of the same separation: `!mayPinHandle` still routes
    // this caller into the tailored block, and inside it the ORDINARY message is
    // the true one — the window it names does have a title.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: "", value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).not.toMatch(/no title/i);
    // The FLAT promise, named exactly: `toContain("click_element")` was
    // satisfied by both arms of the recovery sentence, so it was blind to the
    // one clause that was wrong here. Nothing resolved, so `keyboard` never
    // sees this query — it adopts a resolved title — and both channels take the
    // handle outright.
    expect(next).toContain("click_element and keyboard take hwnd here");
    expect(next).not.toMatch(/keyboard[^.]*only while it is in the foreground/i);
  });

  it("still names the variable when it IS the thing standing in the way", async () => {
    // The pairing for the sentence above: with the chain armed, unsetting it is
    // a real (operator-level) recovery and the text has to keep saying so.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: "@active", value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).toMatch(/unsetting DTM_SET_VALUE_CHAIN/);
    expect(next).not.toMatch(/passing hwnd to this tool returns target_not_found/);
  });

  it("a whitespace title is NOT titleless — the enumeration keeps it, so the handle reaches it", async () => {
    // `enumWindowsInZOrder` drops a window on `!title`, UNTRIMMED, so "   "
    // survives and stays addressable by handle. `normalizeTitle` does trim, so
    // it still matches everything and is still refused — but with the ordinary
    // message, whose "unsetting lets this tool take hwnd" is true here. Testing
    // the predicate with `.trim()` told that caller the opposite.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    // The RESOLVED window's title is whitespace — not the caller's query. The
    // first version of both these tests passed `"   "` with no handle on a
    // desktop of titled windows, so `effectiveTitle` was the query and no
    // window in the fixture had a blank title at all: the same two populations
    // the titleless predicate confused, in the tests written to separate them.
    const r = parse(await setElementValueHandler({
      windowTitle: "anything", hwnd: String(WSTITLED), value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(JSON.stringify(r)).toContain("ambiguous_target");
    expect(next).not.toMatch(/no title/i);
    expect(next).toContain("click_element takes hwnd here");
  });

  it("…but keyboard carries the titleless limit here, because its check trims", async () => {
    // The half the ordinary message got wrong. `namesAWindow` trims, so for
    // "   " the destination check sees no window named and `keyboard` falls
    // back to the foreground-only path — the same limit the `""` branch spells
    // out, reached by a caller who was told the opposite in the same sentence.
    // Moving the predicate from `.trim()` to `=== ""` fixed the `click_element`
    // half and moved the false promise to `keyboard`: the third sign-flipped
    // mirror this branch has produced.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    // The RESOLVED window's title is whitespace — not the caller's query. The
    // first version of both these tests passed `"   "` with no handle on a
    // desktop of titled windows, so `effectiveTitle` was the query and no
    // window in the fixture had a blank title at all: the same two populations
    // the titleless predicate confused, in the tests written to separate them.
    const r = parse(await setElementValueHandler({
      windowTitle: "anything", hwnd: String(WSTITLED), value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).not.toContain("click_element and keyboard take hwnd here");
    // Anchored on the clause this branch alone produces. `/keyboard[^.]*
    // foreground/` is satisfied by the TITLELESS text too ("keyboard does reach
    // it while it stays in the foreground"), so it could not tell the two
    // branches apart — the same blindness that let the last two versions of
    // these tests pass on the wrong fixture.
    expect(next).toContain("click_element takes hwnd here");
    expect(next).toMatch(/keyboard reaches this window by handle only while it is in the foreground/i);
    // …and the suggest list, which is what the server instructions tell the
    // model to read, says the same thing rather than the flat promise.
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/keyboard only while this window is in the foreground/);
  });

  it("keeps the flat promise when the title really does name a window", async () => {
    // The pairing. With an ordinary title `namesAWindow` is true, the
    // destination check has a window to guard, and both channels take the
    // handle without a limit — so the conditional above cannot be passing by
    // simply deleting the promise everywhere.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    const next = (r as { _perceptionForPost?: { next?: string } })._perceptionForPost?.next ?? "";
    expect(next).toContain("click_element and keyboard take hwnd here");
    const suggests = JSON.stringify((r as { suggest?: string[] }).suggest ?? []);
    expect(suggests).toMatch(/click_element and keyboard accept it on this window/);
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
    // In either order: "narrow … name … until" and "keep narrowing until only
    // one does — name and automationId are the axes" say the same wrong thing.
    expect(JSON.stringify(r)).not.toMatch(/narrow[^.]*\b(?:name|automationId)\b[^.]*until/i);
    expect(JSON.stringify(r)).not.toMatch(/narrow[^.]*until[^.]*\b(?:name|automationId)\b(?![^.]*do not change)/i);
    // And the correction has to survive — keyed on the two axes and the claim,
    // not on the slash between them, so rewriting it as "name and automationId"
    // is not a failure.
    expect(JSON.stringify(r)).toMatch(/\bname\b[^.]*\bautomationId\b[^.]*do not change the count/i);
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

  it("pins get_ui_elements' hints AND its read, together", async () => {
    // This test used to assert the opposite, and the reason it gave was true at the time: the
    // read passed only a title to both backends, so pinning the hints alone would have
    // labelled the response with the named window while the elements came from its sibling,
    // and then filed those elements under the named window's handle. It named its own
    // condition for changing — pin both together when the read takes a handle — and the read
    // takes one now (`options.pinnedHwnd`, `AutomationElement::FromHandle`).
    //
    // Asserted on both halves on purpose. Pinning either one alone is a different defect:
    // hints alone describe a window the elements did not come from; read alone makes the
    // response name whichever window the title found first while the elements came from the
    // handle. The pair is the contract.
    const r = parse(await getUiElementsHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), maxDepth: 2, maxElements: 30,
    } as never));
    expect(mockGetUiElements).toHaveBeenCalled();
    expect(mockGetUiElements.mock.calls[0]![0]).toBe(SHARED_TITLE);
    // The read is scoped to the window the caller named …
    expect(mockGetUiElements.mock.calls[0]![4]?.pinnedHwnd).toBe(LIVE);
    // … and the response names that same window, not the first title match.
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
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

describe("ADR-036 — set_element_value's hints name the window the channel wrote to, whichever that is", () => {
  it("reports the handle when the write went through it (channel 1)", async () => {
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(r.channel).toBe("value");
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
  });

  it("reports the handle when the write fell through to channel 2, which is addressed by it", async () => {
    // The guard's own gate (`mayPinHandle`) cannot cover this: `lensId` and
    // `DESKTOP_TOUCH_AUTO_GUARD=0` both skip `runActionGuard`, so with the chain
    // armed the fallbacks stay reachable and the refusal is never consulted.
    //
    // This cell read the other way while channel 2 resolved by title: with two same-titled windows
    // open it pinned SIBLING — the window a title resolves to — for a write the caller had aimed at
    // LIVE. Channel 2 takes the handle since #631 (PR 側 codex, P1), so the report names the window
    // the text went into. "A title-resolved channel reports no handle" is still the rule; its cells
    // are channel 3's, in `adr-036-set-value-observation.test.ts`, because this block has none.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    mockSetElementValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    const r = parse(await setElementValueHandler({
      windowTitle: SHARED_TITLE, hwnd: String(LIVE), value: "x", name: "Field",
    } as never));
    expect(r.channel).toBe("text2");
    expect(mockInsertText).toHaveBeenCalled();
    expect(mockInsertText.mock.calls[0]![0]).toBe(SHARED_TITLE);
    // The handle rides along with the title, and that is what makes the pin below a fact rather than
    // a label: without this argument the write can land in SIBLING while the report names LIVE.
    expect(mockInsertText.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
    expect(r.hints?.target?.hwnd).toBe(String(LIVE));
  });
});

// ─── The facts the refusal states about narrowing, asked of the matcher ──────

describe("ADR-036 — when a narrower windowTitle can and cannot separate two windows", () => {
  // Title-only calls: `resolveWindowTarget` returns null for these, so the
  // guard counts exactly what `resolveActionTarget` sees.
  const call = async (windowTitle: string) =>
    parse(await setElementValueHandler({ windowTitle, value: "x", name: "Field" } as never));
  const refused = async (t: string) => JSON.stringify(await call(t)).includes("ambiguous_target");
  // "not refused" is not the same as "resolved": a call that failed for another
  // reason also carries no `ambiguous_target`, and the positive control is what
  // the whole promise rests on.
  const resolved = async (t: string) => (await call(t)).ok === true;

  it("cannot separate a title that is a substring of its sibling — no query escapes", async () => {
    winsRef.list = [win(SIBLING, "Report", 0), win(LIVE, "Report archive", 1)];
    // Every query that names the first window names the second as well.
    for (const q of ["Report", "report", "Repor", "R", "Report "]) {
      expect(await refused(q)).toBe(true);
    }
    // The only query that narrows resolves the OTHER window.
    expect(await resolved("Report archive")).toBe(true);
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
    expect(await resolved("pictkura - Brave")).toBe(true);
  });
});
