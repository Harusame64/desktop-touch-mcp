/**
 * adr-036-set-value-observation.test.ts — one observation per call, on every path.
 *
 * `buildHintsForTitle` does two things: it builds the response hints AND it
 * observes the window, which is what keeps drift detection current. Round 3
 * moved the call out of the top of the handler and into the branch of the
 * channel that succeeded — correct for the hints, and it silently took the
 * observation away from the paths that report no hints (channel 3, and every
 * failure). This file pins both halves: never twice (a second call would record
 * one window under two handles and invent a drift), and never zero.
 *
 * Round 5 found the half no branch can reach: a channel that REJECTS — the
 * PowerShell runner timing out, or handing back malformed JSON — leaves through
 * the handler's outer catch, past every branch. `ok:false` was covered; a
 * thrown failure still walked off with the observation. The second describe
 * below is that path, and the two ordering tests in it are what stop the debt
 * and the observation from drifting apart again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TITLE = "pictkura — Chrome";
// What the resolver hands back. Deliberately NOT equal to `TITLE`: while the two
// matched, observing under the caller's raw partial title instead of the
// resolved one passed every test in this file, and that files one window under
// two keys (`observeTarget` keys on the string it is handed).
const RESOLVED = "pictkura — Profile 1 — Chrome";
const LIVE = 0x2222n;

const { mockBuildHints, mockSetValue, mockInsertText, mockKeyboardType, mockEvalGuards } = vi.hoisted(() => ({
  mockBuildHints: vi.fn(() => null),
  mockEvalGuards: vi.fn(async () => ({ ok: true })),
  mockSetValue: vi.fn(async () => ({ ok: true })),
  mockInsertText: vi.fn(async () => ({ ok: false, code: "TextPattern2NotSupported" })),
  mockKeyboardType: vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] })),
}));

vi.mock("../../src/engine/identity-tracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/identity-tracker.js")>();
  return { ...actual, buildHintsForTitle: mockBuildHints };
});

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return {
    ...actual,
    setElementValue: (...a: unknown[]) => mockSetValue(...(a as [])),
    insertTextViaTextPattern2: (...a: unknown[]) => mockInsertText(...(a as [])),
    // `click_element` shares the predicate under test and is checked here too:
    // a mutation to ITS call site survived while only `set_element_value` drove
    // it, which is the "covered by reading" gap this test closes.
    clickElement: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../../src/tools/keyboard.js", () => ({
  keyboardTypeHandler: (...a: unknown[]) => mockKeyboardType(...(a as [])),
}));

vi.mock("../../src/engine/perception/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/registry.js")>();
  return { ...actual, evaluatePreToolGuards: (...a: unknown[]) => mockEvalGuards(...(a as [])) };
});

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) => {
      if (p.hwnd !== undefined) {
        return { hwnd: BigInt(p.hwnd), title: RESOLVED, warnings: [], className: "Chrome_WidgetWin_1" };
      }
      // `@active` resolves a HANDLE for a caller who named a title — the case
      // that separates "we resolved one" from "they named one", and the reason
      // a fixture where only `hwnd` resolves cannot tell the two predicates
      // apart.
      if (p.windowTitle === "@active") {
        return { hwnd: LIVE, title: RESOLVED, warnings: [], className: "Chrome_WidgetWin_1" };
      }
      return null;
    }),
  };
});

const { setElementValueHandler, clickElementHandler } = await import("../../src/tools/ui-elements.js");
const { resolveWindowTarget } = await import("../../src/tools/_resolve-window.js");

const call = () => setElementValueHandler({
  windowTitle: TITLE, hwnd: String(LIVE), value: "x", name: "Field",
} as never);

beforeEach(() => {
  mockBuildHints.mockClear();
  mockEvalGuards.mockClear();
  mockSetValue.mockResolvedValue({ ok: true } as never);
  mockInsertText.mockResolvedValue({ ok: false, code: "TextPattern2NotSupported" } as never);
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";   // the channels, not the guard, are the subject
  delete process.env.DTM_SET_VALUE_CHAIN;
});

describe("ADR-036 — set_element_value observes its window exactly once, whichever channel runs", () => {
  it("channel 1 success", async () => {
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Pinned: the write went through the handle. Under the resolved title, not
    // the caller's partial one.
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBe(LIVE);
  });

  it("channel 2 success", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockInsertText.mockResolvedValue({ ok: true } as never);
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // NOT pinned: channel 2 found its window by title. Under the resolved
    // title all the same — that is the string the channel searched with.
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBeUndefined();
  });

  it("channel 3 success — reports no hints, still owes the observation", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    await call();
    expect(mockKeyboardType).toHaveBeenCalled();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
  });

  it("all channels failed", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockKeyboardType.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "KeyboardFailed" }) }],
    } as never);
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Unpinned: channels 2 and 3 both ran, and both went by title.
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBeUndefined();
  });

  it("chain disabled and channel 1 failed", async () => {
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    const r = await call();
    expect(JSON.parse(r.content![0]!.text).ok).toBe(false);
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Channel 1 is the only channel that ran, and it ran through the handle.
    // Which window gets observed must not depend on whether the failure came
    // back as `ok:false` or as a rejection.
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBe(LIVE);
  });

  // The write only. What the response says is pinned by the test above.
  it("channel 1 writes to the resolved window, through the handle", async () => {
    await call();
    expect(mockSetValue.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockSetValue.mock.calls[0]![4]).toEqual({ hwnd: LIVE });
  });
});

describe("ADR-036 — a channel that REJECTS still leaves exactly one observation behind", () => {
  const failed = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.content![0]!.text) as { ok: boolean; error?: string };

  it("channel 1 rejects, chain disabled", async () => {
    mockSetValue.mockRejectedValue(new Error("PowerShellTimeout") as never);
    const r = await call();
    expect(failed(r).ok).toBe(false);
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Pinned. Nothing reads the block this returns, so the only question is
    // which window's baseline gets refreshed, and channel 1 was addressed to
    // this handle. Observing by title would refresh the FIRST same-titled
    // window — leaving the named one exactly as stale as the bug left it, in
    // the one case this PR is about.
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBe(LIVE);
  });

  it("channel 1 rejects with the chain armed — the later channels never run, the observation still happens", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockRejectedValue(new Error("PowerShellTimeout") as never);
    mockInsertText.mockClear();   // the earlier cases in this file left calls on it
    const r = await call();
    expect(failed(r).ok).toBe(false);
    expect(mockInsertText).not.toHaveBeenCalled();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("channel 2 rejects", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockInsertText.mockRejectedValue(new Error("MalformedRunnerJson") as never);
    const r = await call();
    expect(failed(r).ok).toBe(false);
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  // `keyboardTypeHandler` wraps its whole body, so this cannot happen today.
  // The test pins the contract for the day that changes.
  it("channel 3 rejects", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockKeyboardType.mockRejectedValueOnce(new Error("KeyboardThrew") as never);
    const r = await call();
    expect(failed(r).ok).toBe(false);
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("tells the tracker WHO named the handle, not merely that one was resolved", async () => {
    // The key `buildHintsForTitle` files the observation under follows the
    // caller, not the resolution: `@active` and the dialog rescue hand back a
    // handle for someone who named a TITLE, and keying those by handle took
    // `process_restarted` away from them. The predicate is the PUBLIC argument,
    // the same one the guard descriptor uses — and the wiring between the two is
    // what a direct test of the tracker cannot see.
    await call();                                   // passes `hwnd`
    expect(mockBuildHints.mock.calls[0]![2]).toBe(true);

    mockBuildHints.mockClear();
    await setElementValueHandler({
      windowTitle: TITLE, value: "x", name: "Field",
    } as never);                                    // no `hwnd`, nothing resolved
    expect(mockBuildHints.mock.calls[0]![2]).toBe(false);

    // The discriminator: a handle IS resolved and the caller named none.
    mockBuildHints.mockClear();
    await setElementValueHandler({
      windowTitle: "@active", value: "x", name: "Field",
    } as never);
    expect(mockBuildHints.mock.calls[0]![1]).toBe(LIVE);     // resolved by us…
    expect(mockBuildHints.mock.calls[0]![2]).toBe(false);    // …named by title

    // …and `click_element`, which has its own call to the same helper.
    mockBuildHints.mockClear();
    await clickElementHandler({ windowTitle: "@active", name: "Field" } as never);
    expect(mockBuildHints.mock.calls[0]![2]).toBe(false);
    mockBuildHints.mockClear();
    await clickElementHandler({ windowTitle: TITLE, hwnd: String(LIVE), name: "Field" } as never);
    expect(mockBuildHints.mock.calls[0]![2]).toBe(true);
  });

  it("an observation that throws does not turn a write that happened into a failure", async () => {
    // Channel 1 returned `ok:true` — the field HAS the value — and then the
    // description of what happened threw. Letting that out reported
    // `set_element_value` as failed for a write it had just made, which is a
    // worse lie than missing hints. The result is the channel's; the hints are
    // replaced by a warning saying why they are not there.
    //
    // This test asserted `ok:false` for four rounds. It was pinning the defect.
    mockBuildHints.mockImplementationOnce(() => { throw new Error("HintsThrew"); });
    const r = await call();
    const said = JSON.parse(r.content![0]!.text) as {
      ok?: boolean; channel?: string; hints?: { warnings?: string[] };
    };
    expect(said.ok).toBe(true);
    expect(said.channel).toBe("value");
    expect(JSON.stringify(said.hints?.warnings ?? [])).toMatch(/identity hints unavailable.*HintsThrew/);
    // And the debt is still settled by the act of observing, not by its
    // success: observing twice files one window under two handles and reports a
    // drift that never happened.
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("a REFUSAL is said differently and still does not un-report a write that landed", async () => {
    // The previous round re-threw this, and that put back the defect the commit
    // before it is titled after: the channel had already returned `ok:true`, so
    // the response said `ok:false` for a field that HAD been written. Refusing
    // after the fact does not un-write anything, and the refusal that matters
    // runs in `resolveWindowTarget` before any channel. It is a warning — worded
    // so it cannot be read as an ordinary hints failure.
    const { WindowExcludedError } = await import("../../src/engine/tool-exclusion.js");
    mockBuildHints.mockImplementationOnce(() => {
      throw new WindowExcludedError("WindowExcluded: the key locker is not addressable");
    });
    const r = await call();
    const said = JSON.parse(r.content![0]!.text) as {
      ok?: boolean; channel?: string; hints?: { warnings?: string[] };
    };
    expect(said.ok).toBe(true);
    expect(said.channel).toBe("value");
    const warns = JSON.stringify(said.hints?.warnings ?? []);
    expect(warns).toMatch(/identity hints refused.*WindowExcluded/);
    expect(warns).not.toMatch(/identity hints unavailable/);
  });

  it("an observation that throws does not replace the channel's own error either", async () => {
    // The mirror. All channels failed, and the observation on the way out
    // threw: the caller needs `SetValueAllChannelsFailed`, which is what
    // decides their next call, not an error about the bookkeeping.
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockInsertText.mockResolvedValue({ ok: false, code: "TextPattern2NotSupported" } as never);
    // `…Once` throughout: this file's outer `beforeEach` re-seeds `setValue`
    // and `insertText` but not `keyboardType`, so a persistent stub here leaks
    // into the describe below and makes ITS channel-3 case fail — which is how
    // this test announced itself.
    mockKeyboardType.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "KeyboardFailed" }) }],
    } as never);
    mockBuildHints.mockImplementationOnce(() => { throw new Error("HintsThrew"); });
    const r = await call();
    expect(r.content![0]!.text).toContain("SetValueAllChannelsFailed");
    expect(r.content![0]!.text).not.toContain("HintsThrew");
    delete process.env.DTM_SET_VALUE_CHAIN;
  });

  it("an observation that cannot be taken does not become the reported error", async () => {
    mockSetValue.mockRejectedValue(new Error("PowerShellTimeout") as never);
    mockBuildHints.mockImplementationOnce(() => { throw new Error("EnumWindowsThrew"); });
    const r = await call();
    expect(failed(r).error).toContain("PowerShellTimeout");
    expect(failed(r).error).not.toContain("EnumWindowsThrew");
  });

  it("a failure BEFORE any channel runs owes nothing — the pre-Round-3 code did not observe there either", async () => {
    vi.mocked(resolveWindowTarget).mockRejectedValueOnce(new Error("EnumFailed") as never);
    const r = await call();
    expect(failed(r).ok).toBe(false);
    expect(mockBuildHints).not.toHaveBeenCalled();
  });
});

describe("ADR-036 — the keyboard channel's parse catch does not swallow the observation (Codex R6)", () => {
  const body = (r: Awaited<ReturnType<typeof call>>) => r.content![0]!.text;

  beforeEach(() => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
  });

  it("channel 3 wrote, and its observation threw: the write still stands", async () => {
    mockBuildHints.mockImplementationOnce(() => { throw new Error("HintsThrew"); });
    const r = await call();
    // The debt was settled by the act of observing, so nothing observes again
    // on the way out.
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    // Not a parse error — that catch belongs to `JSON.parse` alone…
    expect(body(r)).not.toContain("KeyboardResponseParseError");
    // …and not a failure at all: the keys went to the window. Narrowing the
    // parse catch moved this failure to the outer one instead of removing it,
    // and this test asserted the moved version.
    expect(body(r)).not.toContain("SetValueAllChannelsFailed");
    const said = JSON.parse(body(r)) as { ok?: boolean; channel?: string; hints?: { warnings?: string[] } };
    expect(said.ok).toBe(true);
    expect(said.channel).toBe("keyboard");
    // Channel 3 reports no identity hints on purpose, but a warning is not a
    // hint: it says why they are missing, and it was being dropped here.
    expect(JSON.stringify(said.hints?.warnings ?? [])).toMatch(/identity hints unavailable.*HintsThrew/);
  });

  it("a real parse failure is still a parse failure, observed once", async () => {
    mockKeyboardType.mockResolvedValueOnce({ content: [{ type: "text", text: "not json" }] } as never);
    const r = await call();
    expect(body(r)).toContain("KeyboardResponseParseError");
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("a null body is a parse failure too — it was one when it was a null dereference", async () => {
    mockKeyboardType.mockResolvedValueOnce({ content: [{ type: "text", text: "null" }] } as never);
    const r = await call();
    expect(body(r)).toContain("KeyboardResponseParseError");
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });

  it("a primitive body is not a parse failure — it was not one before either", async () => {
    mockKeyboardType.mockResolvedValueOnce({ content: [{ type: "text", text: "5" }] } as never);
    const r = await call();
    expect(body(r)).toContain("KeyboardFailed");
    expect(body(r)).not.toContain("KeyboardResponseParseError");
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
  });
});

describe("ADR-036 — the owed observation follows the channel that was about to run", () => {
  it("channel 2 rejects — unpinned, because channels 2 and 3 find their window by title", async () => {
    process.env.DTM_SET_VALUE_CHAIN = "1";
    mockSetValue.mockResolvedValue({ ok: false, error: "ValuePatternFailed" } as never);
    mockInsertText.mockRejectedValue(new Error("MalformedRunnerJson") as never);
    await call();
    expect(mockBuildHints).toHaveBeenCalledTimes(1);
    expect(mockBuildHints.mock.calls[0]![0]).toBe(RESOLVED);
    expect(mockBuildHints.mock.calls[0]![1]).toBeUndefined();
  });

  it("the failure the catch reports names the resolved window, like the ones inside the try", async () => {
    mockSetValue.mockRejectedValue(new Error("PowerShellTimeout") as never);
    const r = await call();
    expect(r.content![0]!.text).toContain(RESOLVED);
  });

  it("nothing is owed, and nothing is named, when resolution itself fails", async () => {
    vi.mocked(resolveWindowTarget).mockRejectedValueOnce(new Error("EnumFailed") as never);
    const r = await call();
    expect(mockBuildHints).not.toHaveBeenCalled();
    expect(r.content![0]!.text).toContain(TITLE);      // the caller's own words
    expect(r.content![0]!.text).not.toContain(RESOLVED);
  });
});

describe("ADR-036 — the debt is taken on at the channel, not at the top of the handler", () => {
  it("a guard that throws owes nothing", async () => {
    // The only failure that can happen between the resolved title and channel 1.
    // Without it, moving the debt up to the top of the try passes every other
    // test in this file: they all fail earlier, in window resolution.
    mockEvalGuards.mockRejectedValueOnce(new Error("GuardThrew") as never);
    const r = await setElementValueHandler({
      windowTitle: TITLE, hwnd: String(LIVE), value: "x", name: "Field", lensId: "lens-1",
    } as never);
    expect(JSON.parse(r.content![0]!.text).ok).toBe(false);
    expect(mockBuildHints).not.toHaveBeenCalled();
  });
});
