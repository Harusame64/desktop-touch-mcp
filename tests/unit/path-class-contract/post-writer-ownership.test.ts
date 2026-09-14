/**
 * tests/unit/path-class-contract/post-writer-ownership.test.ts
 * — ADR-021 Phase 2 PR-P2-1 (Plan: desktop-touch-mcp-internal §3.3.2 PR-P2-1, OQ-2(a)).
 *
 * Machine-pins the FIELD-LEVEL writer ownership of the `post` block so the
 * PR-P2-3 `failWith` → presenter codemod cannot silently create a double-attach
 * or sever post-perception recovery (§5 R1). Complements (does not duplicate)
 * `tests/unit/post-failure-perception.test.ts`, which pins the perception-attach
 * BEHAVIOUR; this file pins the OWNERSHIP contract + the B′ presenter routing.
 *
 * Contract:
 *   - obj.post (container) + obj.post.{focusedWindow, focusedElement,
 *     windowChanged, elapsedMs}  → withPostState ONLY (wrapper before/after
 *     focus snapshot; a handler / failure presenter has no such snapshot).
 *   - obj.post.perception          → withPostState ONLY (moved from the root
 *     `_perceptionForPost` marker, then deleted — both success & failure).
 *   - obj.post.rich                → COORDINATED two writers (NOT single-writer):
 *     withPostState (from the `_richForPost` marker, success, takes precedence) +
 *     spliceRich (`_narration.ts` via withRichNarration, UIA diff, success-only,
 *     guarded by `post.rich !== undefined`). spliceRich coordination is pinned in
 *     rich-narration-edge / uia-diff tests; here we only pin the withPostState
 *     half. This file therefore does NOT claim single-writer for post.rich.
 *   - root temp markers (hoisted to ROOT via ROOT_HOISTED_KEYS, never `context`):
 *     `_perceptionForPost` consumed+deleted on both branches; `_richForPost`
 *     consumed+deleted on SUCCESS only (failure branch leaves it — latent,
 *     currently unreachable); `hints` hoisted but NOT consumed (stays at root).
 *
 * @see src/tools/_post.ts withPostState
 * @see src/tools/_errors.ts errorFromMessage / toToolFailure / failWith / ROOT_HOISTED_KEYS
 */

import { describe, it, expect, vi } from "vitest";

// Decouple the wrapper's focus snapshot from the real desktop so post.* snapshot
// fields are deterministic (focusedWindow=null, windowChanged=false) — same
// mocking the existing _post.ts unit test uses.
vi.mock("../../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  getWindowProcessId: vi.fn(() => null),
  getProcessIdentityByPid: vi.fn(() => null),
}));
vi.mock("../../../src/engine/uia-bridge.js", () => ({
  getFocusedAndPointInfo: vi.fn().mockResolvedValue(null),
}));

import { withPostState, getHistorySnapshot } from "../../../src/tools/_post.js";
import type { PostWindowArgKeys } from "../../../src/tools/_post.js";
import { ok, fail } from "../../../src/tools/_types.js";
import { errorFromMessage, toToolFailure, failWith } from "../../../src/tools/_errors.js";
import { getFocusedAndPointInfo } from "../../../src/engine/uia-bridge.js";
import { enumWindowsInZOrder, getWindowProcessId, getProcessIdentityByPid } from "../../../src/engine/win32.js";

/** One window's process, as `getProcessIdentityByPid` returns it: pid, name, and start time. */
const NOTEPAD = { pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 };

function parse(result: { content: ReadonlyArray<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

// ── obj.post container + snapshot fields: withPostState is the sole writer ─────

describe("PR-P2-1: obj.post container + snapshot fields owned by withPostState", () => {
  it("withPostState — not the handler — produces obj.post with exactly the 4 snapshot fields (success)", async () => {
    const handlerOut: Record<string, unknown> = { ok: true, action: "click" };
    expect("post" in handlerOut).toBe(false); // the handler never writes post

    const result = await withPostState("mouse_click", async () => ok(handlerOut))({});
    const post = parse(result).post as Record<string, unknown>;

    expect(post).toBeDefined();
    // Exactly the snapshot field set — no perception/rich because no marker present.
    expect(Object.keys(post).sort()).toEqual([
      "elapsedMs",
      "focusedElement",
      "focusedWindow",
      "windowChanged",
    ]);
    // Values come from the wrapper's (mocked) snapshot, not from handler data.
    expect(post.focusedWindow).toBeNull();
    expect(post.focusedElement).toBeNull();
    expect(post.windowChanged).toBe(false);
    expect(typeof post.elapsedMs).toBe("number");
  });

  it("failures stay pristine — no obj.post when no perception marker is present", async () => {
    const result = await withPostState(
      "mouse_click",
      async () => fail({ ok: false, code: "ToolError", error: "x" }),
    )({});
    const parsed = parse(result);
    expect(parsed.ok).toBe(false);
    expect("post" in parsed).toBe(false);
  });
});

// ── temp markers: moved into post.* and DELETED (no double-attach possible) ────

describe("PR-P2-1: root temp markers moved to post.* then deleted", () => {
  it("_perceptionForPost → post.perception + marker deleted (success)", async () => {
    const env = { kind: "auto", status: "ok", target: "win:notepad" };
    const parsed = parse(
      await withPostState("mouse_click", async () => ok({ ok: true, _perceptionForPost: env }))({}),
    );
    expect("_perceptionForPost" in parsed).toBe(false); // consumed → can't be moved twice
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });

  // withPostState owns the `_richForPost` marker → post.rich move (success). It is
  // NOT the only writer of post.rich — spliceRich (_narration.ts) is the other,
  // guarded writer; that coordination is pinned in rich-narration-edge/uia-diff
  // tests. Here we pin only the marker-move half.
  it("_richForPost → post.rich via withPostState + marker deleted (success)", async () => {
    const rich = { appeared: [{ name: "btn" }] };
    const parsed = parse(
      await withPostState("browser_click", async () => ok({ ok: true, _richForPost: rich }))({}),
    );
    expect("_richForPost" in parsed).toBe(false);
    expect((parsed.post as Record<string, unknown>).rich).toEqual(rich);
  });

  it("_perceptionForPost → post.perception + marker deleted (failure), no stray fields", async () => {
    const env = { kind: "auto", status: "unsafe_coordinates", next: "x" };
    const parsed = parse(
      await withPostState(
        "mouse_click",
        async () =>
          fail({ ok: false, code: "AutoGuardBlocked", error: "e", _perceptionForPost: env } as never),
      )({}),
    );
    expect("_perceptionForPost" in parsed).toBe(false);
    const post = parsed.post as Record<string, unknown>;
    expect(post.perception).toEqual(env);
    // Complement: exactly the 4 snapshot fields + perception, and NO rich leaked in.
    expect(Object.keys(post).sort()).toEqual([
      "elapsedMs",
      "focusedElement",
      "focusedWindow",
      "perception",
      "windowChanged",
    ]);
    expect("rich" in post).toBe(false);
  });
});

// ── ROOT_HOISTED_KEYS asymmetries (Round 1 Opus P2): hints + _richForPost ──────

describe("PR-P2-1: ROOT_HOISTED_KEYS asymmetries", () => {
  it("hints is hoisted to root but NOT consumed/moved into post (failure)", async () => {
    const handler = async () =>
      failWith(new Error("AutoGuardBlocked"), "keyboard", {
        hints: { verifyDelivery: true },
        _perceptionForPost: { kind: "auto", status: "ok", next: "x" },
      });
    const parsed = parse(await withPostState("keyboard", handler)({}));
    // hints stays at the response root (issue #181 symmetry), not folded into post.
    expect(parsed.hints).toEqual({ verifyDelivery: true });
    expect((parsed.post as Record<string, unknown>).hints).toBeUndefined();
  });

  it("failure carrying only _richForPost leaves the marker at root (failure branch does not consume it)", async () => {
    // Current-behavior pin: the failure branch is gated on _perceptionForPost, so a
    // failure with only _richForPost gets neither a post block nor marker cleanup.
    // Latent / currently unreachable — browser handlers attach _richForPost on ok:true only.
    const rich = { appeared: [{ name: "btn" }] };
    const handler = async () => fail({ ok: false, code: "ToolError", error: "e", _richForPost: rich } as never);
    const parsed = parse(await withPostState("browser_click", handler)({}));
    expect("post" in parsed).toBe(false);
    expect(parsed._richForPost).toEqual(rich); // not consumed on the failure branch
  });
});

// ── B′ presenter routing: the PR-P2-3 codemod safety contract (§5 R1) ──────────
//
// PR-P2-3 rewrites failWith callsites to go through `toToolFailure(errorFromMessage(...))`.
// That route MUST keep placing `_perceptionForPost` at the ROOT (via
// ROOT_HOISTED_KEYS), because withPostState only looks at the root. If a future
// change pushed it under `context`, post.perception would silently vanish.

// ── ADR-022 / #352: obj.advisory is a withPostState success-only writer ───────

describe("ADR-022: obj.advisory owned by withPostState (success only)", () => {
  const editFocus = { focused: { name: "Editor", controlType: "Edit", value: "old" } };

  it("sets root obj.advisory for keyboard(type) when the focused element is a UIA text input", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(editFocus as never);
    const parsed = parse(
      await withPostState("keyboard", async () => ok({ ok: true, method: "background" }))(
        { action: "type", windowTitle: "メモ帳", text: "hi" },
      ),
    );
    const advisory = parsed.advisory as Record<string, unknown> | undefined;
    expect(advisory).toBeDefined();
    expect(advisory!.preferredPath).toBe("desktop_act");
    expect(String(advisory!.example)).toContain("windowTitle:'メモ帳'");
    // advisory is a ROOT sibling of post — not nested inside post
    expect((parsed.post as Record<string, unknown>).advisory).toBeUndefined();
  });

  it("G4-survival (#352 follow-up): an UNNAMED Edit reaches post.focusedElement and fires advisory", async () => {
    // The bridge is mocked, so this pins the _post.ts G4 belt relax specifically:
    // a name-empty editable element (name:"") must survive snapshotFocusedElement
    // (was dropped by `if (!focused?.name) return null`) into post.focusedElement
    // with name:"", AND the name-agnostic advisory gate then fires.
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(
      { focused: { name: "", controlType: "Edit", value: "" } } as never,
    );
    const parsed = parse(
      await withPostState("keyboard", async () => ok({ ok: true, method: "background" }))(
        { action: "type", windowTitle: "App", text: "hi" },
      ),
    );
    const post = parsed.post as Record<string, unknown>;
    const fe = post.focusedElement as Record<string, unknown> | null;
    expect(fe).not.toBeNull();
    expect(fe!.name).toBe(""); // survived G4 relax with empty name (was → null before)
    expect(fe!.type).toBe("Edit");
    // An empty value still says a value is there; the value itself never leaves (ADR-036, option c).
    expect(fe!.hasValuePattern).toBe(true);
    expect(fe).not.toHaveProperty("value");
    const advisory = parsed.advisory as Record<string, unknown> | undefined;
    expect(advisory).toBeDefined();
    expect(advisory!.preferredPath).toBe("desktop_act");
  });

  it("carries whether the focused field has a value, never the value — and keeps none in the history (ADR-036, option c)", async () => {
    // Measured on a real machine: the focused field is whatever holds focus when the tool returns,
    // so a tool that never touched it carried its whole value (internal dev/post-focusedelement).
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(
      { focused: { name: "Notes", controlType: "Edit", value: "PROBE-SECRET-POST-1" } } as never,
    );
    const result = await withPostState("clipboard", async () => ok({ ok: true }))({ action: "read" });
    expect(JSON.stringify(result)).not.toContain("PROBE-SECRET-POST-1");
    expect((parse(result).post as Record<string, unknown>).focusedElement).toEqual({ name: "Notes", type: "Edit", hasValuePattern: true });
    expect(JSON.stringify(getHistorySnapshot(20))).not.toContain("PROBE-SECRET-POST-1");
    // …and an element with no value says so.
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({ focused: { name: "Canvas", controlType: "Pane" } } as never);
    const none = await withPostState("mouse_click", async () => ok({ ok: true }))({});
    expect((parse(none).post as Record<string, unknown>).focusedElement).toEqual({ name: "Canvas", type: "Pane", hasValuePattern: false });
  });

  it("gives the value back only for the window THIS call named — the arms, as they were measured", async () => {
    // OPTION (b), and every row here is one the Windows machine shot on `f2b7241` before the code
    // was written (the switch was on so the arms were observable). The four leaking tools name no
    // window and resolve none internally; `keyboard(type, windowTitle)` names the one it typed
    // into. So the predicate splits exactly where the exposure is, and this cell is that table.
    // The foreground window for the whole cell: "Notepad", handle 4242. `snapshotFocus` reads it
    // from `enumWindowsInZOrder`, mocked at the top of this file to `[]` — which would make every
    // row below WITHOUT for the wrong reason (no focused window at all), so the arm-A rows would
    // have passed as WITHOUT and the cell would have reported the predicate working while it was
    // only ever seeing null. Restored after the cell.
    const noWindows = vi.mocked(enumWindowsInZOrder).getMockImplementation();
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );
    vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    const focusedWith = (value: string) =>
      vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({ focused: { name: "Notes", controlType: "Edit", value } } as never);
    const elementOf = async (tool: string, args: Record<string, unknown>, keys?: PostWindowArgKeys) => {
      focusedWith("PROBE-TYPED-POST-2");
      const wrapped = keys
        ? withPostState(tool, async () => ok({ ok: true }), keys)
        : withPostState(tool, async () => ok({ ok: true }));
      return (parse(await wrapped(args)).post as Record<string, unknown>).focusedElement;
    };
    // CONTROL: the foreground really is what the rows below assume, or every WITHOUT is vacuous.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad" }))
      .toHaveProperty("value");
    const WITH = { name: "Notes", type: "Edit", hasValuePattern: true, value: "PROBE-TYPED-POST-2" };
    const WITHOUT = { name: "Notes", type: "Edit", hasValuePattern: true };

    // Arm A — the reason the value exists. `snapshotFocus` is mocked to this title below.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad" })).toEqual(WITH);
    // …and by handle, the only unambiguous naming there is.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "4242" })).toEqual(WITH);

    // Arm B — the four measured carrying a field they never touched.
    expect(await elementOf("clipboard", { action: "read" })).toEqual(WITHOUT);
    expect(await elementOf("clipboard", { action: "write", text: "x" })).toEqual(WITHOUT);
    expect(await elementOf("notification_show", { title: "t", message: "m" })).toEqual(WITHOUT);
    expect(await elementOf("mouse_click", { x: 900, y: 450 })).toEqual(WITHOUT);

    // `@active` names nothing: it is "whatever is in front", which is what every arm above was
    // pointed at by accident. Conservative on purpose — `desktop_state` is the explicit read.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "@active" })).toEqual(WITHOUT);
    // A named window that is NOT the one focus ended in.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "Calculator" })).toEqual(WITHOUT);
    // A handle that is not the focused one.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "9999" })).toEqual(WITHOUT);

    // ONE HANDLE, HOWEVER IT WAS SPELLED. `resolveWindowTarget` accepts the argument through
    // `BigInt`, so all four of these name window 4242 and the call succeeds; an exact string
    // compare against the decimal snapshot answered WITHOUT for three of them, which is the
    // value being withheld from the caller who named the window best.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "0x1092" })).toEqual(WITH);
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "004242" })).toEqual(WITH);
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "  4242  " })).toEqual(WITH);
    // …and the pairing that says the widening stops at SPELLING: a different number is still a
    // different window, however it is written.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "0x9999" })).toEqual(WITHOUT);
    // What neither side can parse is not a name. `resolveWindowTarget` throws on this argument.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "4242px" })).toEqual(WITHOUT);

    // THE TOOL'S OWN ARGUMENT NAME. `focus_window` names its destination `title`, and the two
    // rows are the same call — only the declared key differs, so nothing else can explain the
    // change. The second row is what shipped before this: the tool whose entire job is to name a
    // window, carrying no value because the predicate was reading an argument it does not have.
    const FOCUS_KEYS: PostWindowArgKeys = { windowTitleKey: "title", hwndKey: "hwnd" };
    expect(await elementOf("focus_window", { title: "Notepad" }, FOCUS_KEYS)).toEqual(WITH);
    expect(await elementOf("focus_window", { title: "Notepad" })).toEqual(WITHOUT);
    // Declaring the key does not loosen WHICH window: a title that is not the focused one is
    // still nothing, and `@active` is still "whatever is in front".
    expect(await elementOf("focus_window", { title: "Calculator" }, FOCUS_KEYS)).toEqual(WITHOUT);
    expect(await elementOf("focus_window", { title: "@active" }, FOCUS_KEYS)).toEqual(WITHOUT);
    // And the reason a fixed key list could not simply be widened to `title`: the row above sits
    // one line from `notification_show({title})`, where `title` is a message heading. It stays
    // WITHOUT because that tool declares no window key — the same `title`, read as nothing.
    expect(await elementOf("notification_show", { title: "Notepad", message: "m" })).toEqual(WITHOUT);

    // A SELECTOR THE HANDLER PREFERS MEANS THE TITLE NAMED NOTHING. `terminal(action:'send')`
    // branches on `paneId !== undefined` before it reads `windowTitle`, and a background send does
    // not move the foreground — so the title below is stale, matches whatever happens to be in
    // front, and was credited with that untouched window's field. The pair differs only in the
    // pane: without it the same call is an ordinary naming and keeps its value.
    const TERMINAL_KEYS: PostWindowArgKeys = { windowTitleKey: "windowTitle", supersedingKeys: ["paneId"] };
    expect(await elementOf("terminal", { action: "send", input: "x", windowTitle: "Notepad", paneId: "wt:31264:133" }, TERMINAL_KEYS)).toEqual(WITHOUT);
    expect(await elementOf("terminal", { action: "send", input: "x", windowTitle: "Notepad" }, TERMINAL_KEYS)).toEqual(WITH);
    // An empty pane is no pane: the schemas accept `""` and the handler's `!== undefined` branch
    // would take it, but `findTerminalWindowByPaneId("")` finds nothing and the call fails — a
    // failure carries no value either way. Pinned as WITHOUT so the two readings cannot diverge
    // silently later.
    expect(await elementOf("terminal", { action: "send", input: "x", windowTitle: "Notepad", paneId: "" }, TERMINAL_KEYS)).toEqual(WITH);

    // A HANDLE ARGUMENT KEEPS THE HANDLE ROAD, even when it is unusable. Whitespace-only is not a
    // handle (`BigInt("   ")` is `0n`, and `resolveWindowTarget` refuses the call), and it must not
    // fall through to the title beside it — that would let an unusable handle plus a stale title
    // attach a window the call never reached. Gate 2 caught exactly this, introduced by a `.trim()`
    // that nothing else needed.
    expect(await elementOf("keyboard", { action: "type", text: "x", hwnd: "   ", windowTitle: "Notepad" })).toEqual(WITHOUT);

    // `@active` NAMES NOTHING — against a foreground whose title actually contains it, so the
    // guard is what answers rather than the plain `includes` failing anyway. The first fixture's
    // title ("Notepad") made this row pass with the guard deleted (gate 2).
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "board @active — staging", isActive: true }] as never,
    );
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "@active" })).toEqual(WITHOUT);
    // …and the same fixture with an ordinary substring of that title DOES carry the value, so the
    // row above is the guard talking and not a fixture that stopped matching.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "staging" })).toEqual(WITH);
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );

    // `scroll` is the second superseding selector, and it is a CDP road rather than a pane: with a
    // `selector` the handler scrolls a TAB and never reads the title beside it. TWO argument names
    // for the one thing — `to_element` says `selector`, `smart` says `target` — and declaring only
    // the first left the second attaching a foreground field to a background tab scroll.
    const SCROLL_KEYS: PostWindowArgKeys = { windowTitleKey: "windowTitle", supersedingKeys: ["selector", "target"] };
    expect(await elementOf("scroll", { action: "to_element", selector: "#row-9", windowTitle: "Notepad" }, SCROLL_KEYS)).toEqual(WITHOUT);
    expect(await elementOf("scroll", { action: "smart", strategy: "cdp", target: "#row-9", windowTitle: "Notepad" }, SCROLL_KEYS)).toEqual(WITHOUT);
    expect(await elementOf("scroll", { action: "to_element", name: "row 9", windowTitle: "Notepad" }, SCROLL_KEYS)).toEqual(WITH);

    // A `fixId` that retargets: the handler acts on the stored fix's window, so these arguments
    // describe the call the caller wrote rather than the one that ran. Same default as the rich
    // path — assume it retargets unless the registration proves otherwise.
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad", fixId: "f1" })).toEqual(WITHOUT);
    expect(await elementOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad", fixId: "" })).toEqual(WITH);
    expect(await elementOf(
      "keyboard",
      { action: "press", keys: "ctrl+a", windowTitle: "Notepad", fixId: "f1" },
      { windowTitleKey: "windowTitle", hwndKey: "hwnd", fixRetargets: (a) => a.action !== "press" },
    )).toEqual(WITH);
    if (noWindows) vi.mocked(enumWindowsInZOrder).mockImplementation(noWindows);
  });

  it("names the road that withheld the value, once per road, and never when nothing was withheld", async () => {
    // AN ABSENCE CANNOT BE READ. `value` goes missing for reasons that have nothing to do with the
    // naming rule — no focused element, UIA silent, a field with no value at all — and a caller who
    // addressed the wrong window sees the same nothing as a caller whose field is empty. So each
    // road says its own name, in `hints`, where "how this answer was produced" already lives.
    const noWindows = vi.mocked(enumWindowsInZOrder).getMockImplementation();
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );
    vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    const hintsOf = async (tool: string, args: Record<string, unknown>, keys?: PostWindowArgKeys, value: string | null = "PROBE-WHY") => {
      vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({
        focused: { name: "Notes", controlType: "Edit", value },
      } as never);
      const wrapped = keys
        ? withPostState(tool, async () => ok({ ok: true }), keys)
        : withPostState(tool, async () => ok({ ok: true }));
      return parse(await wrapped(args)).hints as Record<string, unknown> | undefined;
    };

    // One road at a time, each with the call that takes it.
    expect(await hintsOf("clipboard", { action: "read" }))
      .toMatchObject({ postValueWithheld: "call_named_no_window" });
    expect(await hintsOf("keyboard", { action: "type", text: "x", windowTitle: "@active" }))
      .toMatchObject({ postValueWithheld: "call_named_no_window" });
    expect(await hintsOf("keyboard", { action: "type", text: "x", windowTitle: "Calculator" }))
      .toMatchObject({ postValueWithheld: "not_the_window_you_named" });
    expect(await hintsOf("keyboard", { action: "type", text: "x", hwnd: "9999" }))
      .toMatchObject({ postValueWithheld: "not_the_window_you_named" });
    expect(await hintsOf(
      "terminal",
      { action: "send", input: "x", windowTitle: "Notepad", paneId: "wt:31264:133" },
      { windowTitleKey: "windowTitle", supersedingKeys: ["paneId"] },
    )).toMatchObject({ postValueWithheld: "target_came_from_elsewhere" });
    expect(await hintsOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad", fixId: "f1" }))
      .toMatchObject({ postValueWithheld: "target_came_from_elsewhere" });

    // NOT AN ORACLE ABOUT THE CONTENT. An empty field is withheld by the same rule and says so;
    // if it did not, the reason's presence would mean "the field you cannot see is not empty" —
    // a bit about a window the caller never named, which `hasValuePattern` does not give.
    expect(await hintsOf("clipboard", { action: "read" }, undefined, ""))
      .toMatchObject({ postValueWithheld: "call_named_no_window" });

    // NOTHING WAS WITHHELD IF THERE WAS NOTHING TO GIVE: no value pattern, no reason. Otherwise a
    // paragraph that never had a value reads as a field something was kept from.
    expect(await hintsOf("clipboard", { action: "read" }, undefined, null)).toBeUndefined();

    // COULD NOT LOOK IS NOT DID NOT MATCH. With the enumeration answering nothing, the comparison
    // has nothing to compare — while UIA can still produce an element through its own road. Saying
    // `not_the_window_you_named` there tells the caller their aim was wrong about something the
    // server never saw, and a confident wrong diagnosis is worse for them than an admitted one.
    vi.mocked(enumWindowsInZOrder).mockImplementation(() => { throw new Error("EnumWindows failed"); });
    expect(await hintsOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad" }))
      .toMatchObject({ postValueWithheld: "could_not_verify_the_window" });
    expect(await hintsOf("keyboard", { action: "type", text: "x", hwnd: "4242" }))
      .toMatchObject({ postValueWithheld: "could_not_verify_the_window" });
    // …and a call that named no window still says so: the roads do not collapse into each other
    // just because the foreground is unreadable.
    expect(await hintsOf("clipboard", { action: "read" }))
      .toMatchObject({ postValueWithheld: "call_named_no_window" });
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );

    // …and none of the carrying calls says anything: the 8 arms that DO get their value.
    expect(await hintsOf("keyboard", { action: "type", text: "x", windowTitle: "Notepad" })).toBeUndefined();
    expect(await hintsOf("keyboard", { action: "type", text: "x", hwnd: "4242" })).toBeUndefined();
    expect(await hintsOf("keyboard", { action: "type", text: "x", hwnd: "0x1092" })).toBeUndefined();
    expect(await hintsOf("focus_window", { title: "Notepad" }, { windowTitleKey: "title" })).toBeUndefined();

    vi.mocked(getFocusedAndPointInfo).mockResolvedValue(null as never);
    if (noWindows) vi.mocked(enumWindowsInZOrder).mockImplementation(noWindows);
  });

  it("merges its hint into the handler's own, rather than replacing it", async () => {
    // `hints` is a root-hoisted key the handler may have written. This wrapper owns one field of
    // it — `verifyDelivery` and `focusedElementSource` are other writers', and both are columns
    // that caught a misreading on the measuring side this week.
    const noWindows = vi.mocked(enumWindowsInZOrder).getMockImplementation();
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );
    vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({
      focused: { name: "Notes", controlType: "Edit", value: "PROBE-WHY" },
    } as never);
    const handlerHints = { verifyDelivery: { channel: "postmessage" } };
    const out = parse(await withPostState("scroll", async () => ok({ ok: true, hints: handlerHints }))({ action: "raw", amount: 3 }));
    expect(out.hints).toEqual({ verifyDelivery: { channel: "postmessage" }, postValueWithheld: "call_named_no_window" });

    vi.mocked(getFocusedAndPointInfo).mockResolvedValue(null as never);
    if (noWindows) vi.mocked(enumWindowsInZOrder).mockImplementation(noWindows);
  });

  it("drops the value when the foreground moved while the UIA read was in flight", async () => {
    // The permission is decided against the foreground BEFORE the asynchronous element read, and
    // the element comes from whatever holds focus when UIA answers. Alt-tab in between and the
    // value published for the window the caller named would be the other window's field.
    // The sequence below is the wrapper's three reads: `before`, `after`, and the re-check.
    const noWindows = vi.mocked(enumWindowsInZOrder).getMockImplementation();
    vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    const win = (hwnd: bigint, title: string) => [{ hwnd, title, isActive: true }] as never;
    let seen: Record<string, unknown> | undefined;
    const lastHints = (): Record<string, unknown> | undefined => seen;
    const elementOfSequence = async (third: () => unknown) => {
      vi.mocked(enumWindowsInZOrder)
        .mockImplementationOnce(() => win(4242n, "Notepad"))
        .mockImplementationOnce(() => win(4242n, "Notepad"))
        .mockImplementationOnce(third as never);
      vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({
        focused: { name: "Notes", controlType: "Edit", value: "PROBE-RACE" },
      } as never);
      const out = parse(await withPostState("keyboard", async () => ok({ ok: true }))({
        action: "type", text: "x", windowTitle: "Notepad",
      }));
      seen = out.hints as Record<string, unknown> | undefined;
      return (out.post as Record<string, unknown>).focusedElement;
    };

    try {
      // CONTROL: nothing moved, so the value is carried — the row below is the movement talking.
      expect(await elementOfSequence(() => win(4242n, "Notepad"))).toHaveProperty("value", "PROBE-RACE");
      // The foreground moved between the permission and the element.
      expect(await elementOfSequence(() => win(9999n, "Password Manager"))).not.toHaveProperty("value");
      // …and a foreground that cannot be read at all counts as moved.
      expect(await elementOfSequence(() => [] as never)).not.toHaveProperty("value");
      // THE HANDLE CAN BE THE SAME WINDOW'S NUMBER AND A DIFFERENT WINDOW. The named window exits
      // during the lookup, Windows hands its number to whatever takes focus, and a check on the
      // number alone says nothing moved. Same hwnd, different process.
      // A DIFFERENT PROCESS behind the same handle — the named window exited, its number was
      // reused. Two rows, because the cheap readings of "same window" each pass one of them: the
      // handle alone passes both, and the process NAME passes the second, where the replacement is
      // another instance of the same executable (a second Notepad, which nobody would call a
      // corner case). Only pid + start time — what `identity-tracker.ts` compares — refuses both.
      vi.mocked(getProcessIdentityByPid)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce({ pid: 77, processName: "passwords.exe", processStartTimeMs: 900 } as never);
      expect(await elementOfSequence(() => win(4242n, "Notepad"))).not.toHaveProperty("value");
      vi.mocked(getProcessIdentityByPid)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce({ pid: 99, processName: "notepad.exe", processStartTimeMs: 900 } as never);
      expect(await elementOfSequence(() => win(4242n, "Notepad"))).not.toHaveProperty("value");
      // …and an identity that could not be read at all withholds too (the failure path's shape,
      // and what an elevated window answers to a server that is not). It withholds under a
      // DIFFERENT name: nothing moved, the server could not look. Reporting movement there would
      // be this PR's own defect — a reason that names something that did not happen.
      vi.mocked(getProcessIdentityByPid)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce({ pid: 0, processName: "", processStartTimeMs: 0 } as never);
      const unreadable = await elementOfSequence(() => win(4242n, "Notepad"));
      expect(unreadable).not.toHaveProperty("value");
      expect(lastHints()).toMatchObject({ postValueWithheld: "could_not_verify_the_window" });
      // A DIFFERENT HANDLE SETTLES IT, even when the identity behind the new one cannot be read —
      // which is exactly what happens when the window that took focus is elevated. Calling that
      // "could not verify" would take back an observation that was actually made.
      vi.mocked(getProcessIdentityByPid)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce({ pid: 0, processName: "", processStartTimeMs: 0 } as never);
      expect(await elementOfSequence(() => win(9999n, "Elevated thing"))).not.toHaveProperty("value");
      expect(lastHints()).toMatchObject({ postValueWithheld: "foreground_moved_during_read" });

      // The pairing: a real change of identity, both sides readable, still says movement.
      vi.mocked(getProcessIdentityByPid)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce(NOTEPAD as never)
        .mockReturnValueOnce({ pid: 99, processName: "notepad.exe", processStartTimeMs: 901 } as never);
      expect(await elementOfSequence(() => win(4242n, "Notepad"))).not.toHaveProperty("value");
      expect(lastHints()).toMatchObject({ postValueWithheld: "foreground_moved_during_read" });
      vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    } finally {
      // RESET IN A `finally`, and reset rather than restore: the sequences above are
      // `mockImplementationOnce` queues, so a regression that skips the third read leaves one
      // queued — and if the failure also skipped this cleanup, the NEXT test would consume it and
      // fail for a reason that has nothing to do with itself. Measured while mutating this very
      // guard: two cells went red, one of them innocent.
      vi.mocked(enumWindowsInZOrder).mockReset();
      vi.mocked(getFocusedAndPointInfo).mockResolvedValue(null as never);
      vi.mocked(enumWindowsInZOrder).mockImplementation(noWindows ?? (() => [] as never));
    }
  });

  it("does not keep, in the history ring, the value a refusal withheld from the response", async () => {
    // The response side was measured (`AutoGuardBlocked` carries no focused element) and the
    // docstring then claimed no snapshot was taken at all. It is: the snapshot runs before either
    // branch, so the ring held the value for a call the product had just refused — including a
    // handle naming the key locker's window, which `refuseIfExcludedTarget` exists to reject.
    const noWindows = vi.mocked(enumWindowsInZOrder).getMockImplementation();
    vi.mocked(enumWindowsInZOrder).mockImplementation(
      () => [{ hwnd: 4242n, title: "Notepad", isActive: true }] as never,
    );
    vi.mocked(getProcessIdentityByPid).mockReturnValue(NOTEPAD as never);
    vi.mocked(getFocusedAndPointInfo).mockResolvedValue({
      focused: { name: "Notes", controlType: "Edit", value: "PROBE-REFUSED-RING" },
    } as never);

    // CONTROL: the same call, succeeding, does put the value in the ring — so a clean ring below
    // is the refusal's doing and not an instrument that stopped recording.
    await withPostState("keyboard", async () => ok({ ok: true }))({ action: "type", text: "x", hwnd: "4242" });
    const okEntry = getHistorySnapshot(1)[0];
    expect(JSON.stringify(okEntry)).toContain("PROBE-REFUSED-RING");

    await withPostState("keyboard", async () => fail({ ok: false, code: "AutoGuardBlocked", error: "blocked" }))({ action: "type", text: "x", hwnd: "4242" });
    const refusedEntry = getHistorySnapshot(1)[0];
    expect(refusedEntry.ok).toBe(false);
    expect(JSON.stringify(refusedEntry)).not.toContain("PROBE-REFUSED-RING");
    expect((refusedEntry.post as Record<string, unknown>).focusedElement).toBeNull();

    vi.mocked(getFocusedAndPointInfo).mockResolvedValue(null as never);
    if (noWindows) vi.mocked(enumWindowsInZOrder).mockImplementation(noWindows);
  });

  it("does NOT set advisory when the focused element is not a text input", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({ focused: { name: "Canvas", controlType: "Pane" } } as never);
    const parsed = parse(
      await withPostState("keyboard", async () => ok({ ok: true }))({ action: "type", text: "hi" }),
    );
    expect("advisory" in parsed).toBe(false);
  });

  it("never sets advisory on the failure branch (even with a qualifying focused element)", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(editFocus as never);
    const parsed = parse(
      await withPostState("keyboard", async () => fail({ ok: false, code: "ToolError", error: "e" }))(
        { action: "type", text: "hi" },
      ),
    );
    expect(parsed.ok).toBe(false);
    expect("advisory" in parsed).toBe(false);
  });

  it("does NOT set advisory when the focused window is a browser (after.processName wiring)", async () => {
    // Pin the processName wiring (_post.ts → maybeAdvisory): an active browser
    // window suppresses the advisory even with a qualifying focused Edit. Without
    // the `after.processName` arg this would (wrongly) fire — guards the wiring.
    vi.mocked(enumWindowsInZOrder).mockReturnValue([{ hwnd: 1, title: "X", isActive: true } as never]);
    vi.mocked(getWindowProcessId).mockReturnValue(123 as never);
    vi.mocked(getProcessIdentityByPid).mockReturnValue({ processName: "chrome" } as never);
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(editFocus as never);
    try {
      const parsed = parse(
        await withPostState("keyboard", async () => ok({ ok: true }))({ action: "type", text: "hi" }),
      );
      expect("advisory" in parsed).toBe(false);
    } finally {
      vi.mocked(enumWindowsInZOrder).mockReturnValue([]);
      vi.mocked(getWindowProcessId).mockReturnValue(null as never);
      vi.mocked(getProcessIdentityByPid).mockReturnValue(null as never);
    }
  });
});

describe("PR-P2-1: B′ presenter routes _perceptionForPost to ROOT (R1 codemod safety)", () => {
  const env = { kind: "auto", status: "needs_escalation", next: "re-focus and retry" };

  it("toToolFailure(errorFromMessage(...,{_perceptionForPost})) places the marker at root, not under context", () => {
    const failure = toToolFailure(
      errorFromMessage(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", {
        _perceptionForPost: env,
        lensId: "lens-1",
      }),
    );
    expect(failure._perceptionForPost).toEqual(env); // root placement (load-bearing)
    const ctx = failure.context as Record<string, unknown> | undefined;
    expect(ctx?._perceptionForPost).toBeUndefined(); // never nested
    expect(ctx?.lensId).toBe("lens-1"); // ordinary keys stay nested
  });

  it("a handler returning fail(toToolFailure(...)) gets post.perception attached by withPostState", async () => {
    const handler = async () =>
      fail(
        toToolFailure(
          errorFromMessage(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", {
            _perceptionForPost: env,
          }),
        ),
      );
    const parsed = parse(await withPostState("keyboard", handler)({}));
    expect(parsed.ok).toBe(false);
    expect("_perceptionForPost" in parsed).toBe(false); // consumed by the wrapper
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });

  it("legacy failWith routes identically — both keep the post.perception path intact", async () => {
    const handler = async () =>
      failWith(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", { _perceptionForPost: env });
    const parsed = parse(await withPostState("keyboard", handler)({}));
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });
});
