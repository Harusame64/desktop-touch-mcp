/**
 * adr-036-desktop-state-value-absent.test.ts — `desktop_state` says which ROAD left the value out.
 *
 * `focusedElement` comes from one of three roads, and two of them can name an element while
 * carrying no value: the perception view has no `value` field at all, and the CDP read
 * deliberately drops a masked one. Measured on Windows, those two produce output identical to an
 * empty field — 24 of 24 reads carried a value while the source hint said `uia`, 0 of 8 while it
 * said `view`, with the element's NAME the same in all thirty-two (win2, 2026-09-14).
 *
 * This file drives the handler itself, because the hint is wiring rather than projection: the two
 * assignments sit beside `hints.focusedElementSource`, and a pure-builder test cannot see them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { view, uiaFocus, cdpResult, fgTitle } = vi.hoisted(() => ({
  view: { value: null as unknown },
  uiaFocus: { value: null as unknown },
  cdpResult: { value: null as unknown },
  /** Chromium or not decides whether the CDP road is reachable at all. */
  fgTitle: { value: "Notepad" },
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [{
      hwnd: 4242n, title: fgTitle.value, isActive: true, zOrder: 0,
      isMinimized: false, isMaximized: false, className: "Notepad", ownerHwnd: null,
      region: { x: 0, y: 0, width: 800, height: 600 }, processName: "notepad.exe",
    }]),
    enumMonitors: vi.fn(() => [{ index: 0, isPrimary: true, region: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96 }]),
    getVirtualScreen: vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 })),
    getWindowProcessId: vi.fn(() => 1234),
    getProcessIdentityByPid: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
    getWindowIdentity: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
  };
});

vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return {
    ...actual,
    nativeViewFocus: { viewGetFocused: () => view.value },
    nativeWin32: undefined,
  };
});
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return { ...actual, getFocusedAndPointInfo: vi.fn(async () => ({ focused: uiaFocus.value, atPoint: null })) };
});
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  evaluateInTab: vi.fn(async () => cdpResult.value),
  DEFAULT_CDP_PORT: 9222,
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: async () => ({ x: 0, y: 0 }) },
}));

const { desktopStateHandler } = await import("../../src/tools/desktop-state.js");

function parse(result: { content: ReadonlyArray<{ type: string; text?: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("ADR-036: desktop_state names the road that left the value out", () => {
  beforeEach(() => { view.value = null; uiaFocus.value = null; cdpResult.value = null; fgTitle.value = "Notepad"; });

  it("says so when the perception view answered, because that road has no value field at all", async () => {
    view.value = { name: "Notes", automationId: null, controlType: "Edit", windowTitle: "Notepad" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("view");
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints.focusedElementValueAbsent).toBe("view_road_has_no_value");
  });

  it("says nothing when UIA answered with a value — the road that can carry one", async () => {
    uiaFocus.value = { name: "Notes", controlType: "Edit", value: "PROBE-ROAD" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("uia");
    expect(out.focusedElement.value).toBe("PROBE-ROAD");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });

  it("says so when CDP dropped a masked field, which otherwise looks exactly like an empty one", async () => {
    // The measured hole: on this road a `type=password` box and a paragraph carrying only a
    // `tabindex` produce identical output. The script substitutes an empty value for the first,
    // and the projection drops an empty one either way — so the row cannot say which it saw.
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "pw", name: "pw", value: "", masked: true, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("cdp");
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints.focusedElementValueAbsent).toBe("masked_on_this_road");
  });

  it("says nothing on the same road when the field was not masked — the pairing that makes the row above mean something", async () => {
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "user", name: "user", value: "PROBE-CDP", masked: false, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.hints.focusedElementSource).toBe("cdp");
    expect(out.focusedElement.value).toBe("PROBE-CDP");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });

  /**
   * THE ADVICE THAT SENDS A CALLER HERE HAS TO SAY WHAT AN EMPTY ANSWER MEANS. Two shipped
   * strings tell a caller whose background write was not confirmed to "read the field back before
   * relying on it". Measured in both directions (win2, `a23bda2`): a window whose title does not
   * change keeps matching its recorded focus row, so the read can be answered from the perception
   * view, which carries no value at all — the field comes back empty even though the write landed,
   * and a caller reads that as proof it did not. Renaming that same window from OUTSIDE, with no
   * keystroke and no focus move, puts the value back; renaming it to its old title takes it away.
   *
   * The condition is the application's, not the caller's, so the advice cannot be met by trying
   * harder — it can only be read correctly. And the advice keys on the HINT rather than on the
   * title, because a fixed title does not guarantee the view road either: the other filters can
   * reject a matching row and fall through to UIA or CDP, where a value may be there. Both copies
   * must name the hint that distinguishes "no value on this road" from "the field is empty".
   */
  it("sends no caller to a read-back without telling them what it cannot settle", () => {
    // FOUR AUDIENCES, NOT TWO. The same advice ships in the tool description, in the server
    // instructions, AND in both READMEs — and the READMEs carried the round-0 imperative ("read
    // the field back before relying on it", with no caveat) through seven rounds of correcting it
    // elsewhere, because this cell only read `src/` (gate 2 on `8937dfe`). A reader there got
    // exactly the inference the branch exists to prevent, in two languages.
    const shipped = [
      "src/tools/desktop-register.ts",
      "src/server-windows.ts",
      "README.md",
      "README.ja.md",
    ].map((rel) => ({
      rel,
      text: readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8"),
    }));

    // No copy may still tell a caller a read-back settles it. The bare imperative is the exact
    // wording every round was spent removing, so it is denied by name.
    for (const { rel, text } of shipped) {
      expect(text, `${rel} still carries the uncaveated round-0 sentence`)
        .not.toContain("Read the field back before relying on it.");
    }

    // The two English prose copies say what the read-back cannot settle, each claim with its own
    // SUBJECT — a fragment survives a rewrite that keeps every word and inverts the meaning, which
    // is how "missing with no hint at all" and "inserts at the caret" were pinned before this
    // round: "a value is never missing with no hint at all" and "a FOREGROUND type inserts at the
    // caret … a background type appends" both passed, and the second is the claim the caret
    // measurement refuted (gate 2).
    const detailed = shipped.filter(({ rel }) => rel.startsWith("src/"));
    for (const { rel, text } of detailed) {
      const sentences = text.split("\n").filter((line) => line.includes("A read-back reports what the field holds"));
      expect(sentences.length, `${rel} has no read-back advice at all`).toBeGreaterThan(0);
      for (const sentence of sentences) {
        expect(sentence).toContain("never establishes that your write put it there");
        expect(sentence).toContain("a BACKGROUND type inserts at the caret and replaces the selection");
        expect(sentence).toContain("a write of empty text sends nothing");
        expect(sentence).toContain("not to prove delivery");
        // The positive half: what the call IS for. Pinned on its own, so a rewrite cannot drop it
        // and stay green on the negatives alone.
        expect(sentence).toContain("reports what the field holds NOW");
        // `desktop_state` answers about the foreground, from a row matched BY TITLE — so another
        // window with the same title can supply the element. The sharpest fact in the sentence,
        // and nothing pinned it before this round.
        expect(sentence).toContain("hints.focusedElementValueAbsent");
        expect(sentence).toContain("another with the same title");
        // …and the one thing on this response that does have a baseline, with its asymmetry: a
        // `value_changed` is evidence, its absence is not.
        // …and the thing that looked like a baseline is not one: `computeDiff`'s PRE side is the
        // stored `desktop_discover` snapshot, not a reading taken across the write, so a change
        // anyone made in between is indistinguishable (gate 1 on `bec8552`). Naming it as evidence
        // was the eighth version of the same error in this sentence — pointing at something whose
        // limit had already been written down one round earlier.
        expect(sentence).toContain("`diff.value_changed` on the same response is not delivery either");
        expect(sentence).toContain("its baseline is your `desktop_discover` snapshot");
        // The honest end: nothing here answers the question, and the way to GET an answer is to
        // make the write confirmable rather than to inspect it afterwards.
        expect(sentence).toContain("NOTHING on this response establishes that the characters arrived");
        // AND THE RECOVERY HAS TWO TEETH OF ITS OWN, both found in one round (gate 1 on `e74dd76`).
        // Replaying a type that DID land appends a second copy — and the sentence has just said
        // the caller cannot know whether it landed, so "write again" was advice to corrupt a
        // successful result. And focus does not make every write confirmable: the rung confirms
        // only a field with a window of its own, so for the WPF case the README uses as its
        // EXAMPLE, a retry answers `landing` again however it is aimed.
        expect(sentence).toContain("AND NOTHING ELSE HERE DOES EITHER");
        expect(sentence).toContain("A retry appends rather than replaces");
        expect(sentence).toContain("a clear is a write of empty text");
        expect(sentence).toContain("`landing.why` does not reliably tell you");
        // AND NO ACTION AT ALL, which is where twelve rounds landed. The last version ended
        // "read the field and act on what it holds" — but the same paragraph had already said the
        // read may carry no value, may omit one the provider never served, and may name a field in
        // another window with the same title. The closing action inherited every caveat above it
        // and would have sent a caller to act on missing or unrelated state (gate 1, `518da7e`).
        expect(sentence).toContain("treat this landing as a REPORT");
        expect(sentence).toContain("not a state you can resolve here");
      }
    }

    // Both READMEs name the baseline too, so a reader who never sees a tool description is not
    // left with "read it back" and nothing else. The Japanese copy is checked by the same rule:
    // a fix applied in one language and not the other is the shape this repo keeps meeting.
    for (const { rel, text } of shipped.filter(({ rel: r }) => r.startsWith("README"))) {
      expect(text, `${rel} does not say what diff.value_changed is`).toContain("diff.value_changed");
      // The README carries the two teeth as well — shorter, but a reader there is the one most
      // likely to take "write again" literally.
      expect(text, `${rel} does not warn that a retry appends`).toMatch(/retry appends|\u518d\u8a66\u884c\u306f\u8ffd\u8a18/);
      expect(text, `${rel} still offers a recovery`).toMatch(/a report, not a state you can resolve|\u5831\u544a\u3067\u3042\u3063\u3066/);
      // …and says the same thing about it as the tool description: not delivery. A README that
      // named it without the limit would be the round-0 mistake with a newer noun.
      expect(text, `${rel} names diff.value_changed without its limit`)
        .toMatch(/diff\.value_changed`?\s*(is not delivery either|\u3082\u5c4a\u3044\u305f\u8a3c\u62e0\u306b\u306f\u306a\u3089\u306a\u3044)/);
    }
  });

  it("says nothing when a CDP field is simply empty, because nothing was withheld there", async () => {
    // The third shape on this road, and the reason the hint is not "there is no value": an empty
    // input is an empty input, and naming a reason there would read as "something was kept".
    fgTitle.value = "Sign in - Google Chrome";
    cdpResult.value = { tag: "INPUT", id: "empty", name: "empty", value: "", masked: false, text: "" };
    const out = parse(await desktopStateHandler({}) as never);
    expect(out.focusedElement).not.toHaveProperty("value");
    expect(out.hints).not.toHaveProperty("focusedElementValueAbsent");
  });
});
