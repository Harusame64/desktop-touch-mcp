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
  it("sends no caller to a read-back without telling them how an empty answer can lie", () => {
    const readBack = [
      readFileSync(fileURLToPath(new URL("../../src/tools/desktop-register.ts", import.meta.url)), "utf8"),
      readFileSync(fileURLToPath(new URL("../../src/server-windows.ts", import.meta.url)), "utf8"),
    ];
    for (const source of readBack) {
      const sentences = source
        .split("\n")
        .filter((line) => line.includes("read the field back before relying on it"));
      expect(sentences.length).toBeGreaterThan(0);
      for (const sentence of sentences) {
        expect(sentence).toContain("focusedElementValueAbsent");
        expect(sentence).toContain("view_road_has_no_value");
        // THE CLAIM WITH ITS SUBJECT, not a fragment of it — a rewrite can keep every word of a
        // trailing phrase and invert what it is about (gate 1 on `e4dc072`).
        expect(sentence).toContain("an empty answer is not evidence of failure");
        // AND THE HINT'S ABSENCE MUST NOT READ AS EVIDENCE. Naming the hint alone makes "no hint"
        // mean "the empty field is real", which is false on the UIA road: a provider that serves
        // no value omits it and sets no hint (the `desktop_state` caveat says so). An advice that
        // sends a caller to a check has to say what the check cannot settle (gate 1, `51bdcd5`).
        // THE WHOLE CLAUSE, SUBJECT INCLUDED. The trailing phrase alone survives a rewrite that
        // keeps every required substring and inverts the meaning — "absence never settles it
        // either way; without that hint absence proves failure" would pass (gate 1 on `e4dc072`).
        // A grep for a fragment pins the fragment, not the sentence.
        // AND WHERE TO READ IT. `desktop_state` has no window selector — only `include*` flags — so
        // it answers about the FOREGROUND, while a background write can land in a window that is
        // not it. Sending a caller to a read-back without that turns the advice into "inspect an
        // unrelated field, and read a coincidental match as confirmation" (gate 1 on `69b533b`).
        expect(sentence).toContain("FOREGROUND window only");
        // …and the two things the check cannot settle. A value can be missing with no hint at all
        // (a UIA provider that serves none), so the hint's SILENCE is not evidence; and a match is
        // not proof either, because a write that never landed leaves a field that already held
        // that text reading exactly the same.
        expect(sentence).toContain("missing with no hint at all");
        expect(sentence).toContain("did not already hold that text");
      }
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
