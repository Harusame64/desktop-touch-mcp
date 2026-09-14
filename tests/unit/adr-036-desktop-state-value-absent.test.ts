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
  /**
   * THE WHOLE PARAGRAPH, PINNED, because "contains no instruction" cannot be checked by listing
   * the instructions one has already thought of. The previous form enumerated five phrases, and
   * gate 1 walked through it with `Retry the write now.` — every required substring present,
   * every forbidden one absent, green. The READMEs were not in that loop at all.
   *
   * So the four copies are fixed text. Any edit fails here and has to be made deliberately, which
   * is the point: this paragraph took fourteen rounds to stop claiming things the code cannot
   * support, and every round removed something — that the read tells you, that the hint's silence
   * means something, that a match settles it, that focusing first is enough, that the element can
   * be compared, that the value is predictable, that an empty field settles it, that `diff` has a
   * baseline, that a retry is free, that focus makes the next write confirmable, that a clear
   * resets, that a retry appends, that there is anything to do about it here, and finally the two
   * instructions that had framed it since before the first round.
   */
  it("keeps all four copies of the landing paragraph exactly as measurement left them", () => {
    const EXPECTED: Record<string, string> = {
      "src/tools/desktop-register.ts":
        "A type/setValue that answers ok=true with 'landing' {confirmed:false, why} took the background write route but was not confirmed to have reached the field named. THIS LANDING IS A REPORT, not a state that can be resolved here: nothing on this response establishes whether the characters arrived; reading the field back does not settle it (`desktop_state` answers about the FOREGROUND, from a sticky focus row that can name a field in another window with the same title, and it may carry no value at all — `hints.focusedElementValueAbsent`); `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write; and a retry is not a repeat, because a background write lands at the caret and replaces the selection exactly as typing does.",
      "src/server-windows.ts":
        "A type that answers ok:true with landing {confirmed:false, why} took the background write route but was not confirmed to have reached the field named. THIS LANDING IS A REPORT, not a state that can be resolved here: nothing on this response establishes whether the characters arrived; reading the field back does not settle it (`desktop_state` answers about the FOREGROUND, from a sticky focus row that can name a field in another window with the same title, and it may carry no value at all — `hints.focusedElementValueAbsent`); `diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather than the write; and a retry is not a repeat, because a background write lands at the caret and replaces the selection exactly as typing does;",
      "README.md":
        "A successful `type` can carry `landing: { confirmed: false, why }`. The write took the background route, but the server could not confirm that it reached the field you named — for example, in a WPF window, whose fields have no window of their own. **This is a report, not a state that can be resolved here**: nothing in the response establishes whether the characters arrived, reading the field back does not settle it (`desktop_state` answers about the foreground, and may come back with no value at all or name a field in another window with the same title), and a retry is not a repeat — a background write lands at the caret and replaces the selection, exactly as typing does.",
      "README.ja.md":
        "成功した `type` に `landing: { confirmed: false, why }` が付くことがある。書き込みは背景の経路を通ったが、指定した欄に届いたことをサーバが確かめられなかった（例: WPF のウィンドウは欄ごとのウィンドウを持たない）。**これは報告であり、ここで解消できる状態ではない**——応答の中に文字が届いたかを示すものは無く、欄を読み返しても決着しない（`desktop_state` は前面について答え、値を一切返さないことも、同じ題の別の窓の欄を名乗ることもある）。そして**再試行は反復ではない**——背景の書き込みは打鍵と同じくキャレット位置に入り、選択を置換する。",
    };
    for (const [rel, expected] of Object.entries(EXPECTED)) {
      const text = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
      // EXTRACT AND COMPARE, not `toContain`: a substring check passes when text is APPENDED, and
      // the first version of this cell did exactly that — gate 1's `Retry the write now.` walked
      // in behind the pinned paragraph and the suite stayed green. The paragraph runs from its
      // opening words to the end of the shipped string (a `",` in the sources) or the end of the
      // line (in the READMEs), and that whole slice has to match.
      const start = text.indexOf(expected.slice(0, 40));
      expect(start, `${rel} no longer opens the landing paragraph the same way`).toBeGreaterThan(-1);
      const end = rel.startsWith("src/") ? text.indexOf('",', start) : text.indexOf("\n", start);
      expect(text.slice(start, end), `${rel}'s landing paragraph changed`).toBe(expected);
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
