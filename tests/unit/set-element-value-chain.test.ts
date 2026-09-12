/**
 * tests/unit/set-element-value-chain.test.ts
 *
 * Unit tests for the set_element_value channel chain (Phase B).
 * Mocks uia-bridge and keyboard handler; no real Win32 calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Availability is asked of a real server double, not grepped out of the registration
// source — see the invariant cell below for why that distinction is the finding.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUiElementTools } from "../../src/tools/ui-elements.js";
// The shipped tool vocabulary, used for DETECTION only — see the invariant cell for
// why it is not the availability set (it excludes the V1 tools and includes a
// conditionally-registered one).
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

/**
 * The three tools the kill-switch branch registers. Declared at module scope because
 * the detection step below runs before the availability probe and both need it —
 * inline in the probe it was a temporal-dead-zone reference, not merely misplaced.
 * Anchored to win2's measured `tools/list` (`onlyInKillSwitch`), not to a reading of
 * the registration source.
 */
const V1_FALLBACKS = ["get_windows", "get_ui_elements", "set_element_value"];

// Mock uia-bridge
vi.mock("../../src/engine/uia-bridge.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/uia-bridge.js")>("../../src/engine/uia-bridge.js");
  return {
    ...actual,
    setElementValue: vi.fn(),
    insertTextViaTextPattern2: vi.fn(),
    getUiElements: vi.fn(),
    clickElement: vi.fn(),
    getElementBounds: vi.fn(),
    getElementChildren: vi.fn(),
    getTextViaTextPattern: vi.fn(),
  };
});

// Mock keyboard handler
vi.mock("../../src/tools/keyboard.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/keyboard.js")>("../../src/tools/keyboard.js");
  return {
    ...actual,
    keyboardTypeHandler: vi.fn(),
  };
});

// Mock perception/guard modules
vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../src/tools/_action-guard.js", () => ({
  isAutoGuardEnabled: vi.fn().mockReturnValue(false),
  runActionGuard: vi.fn(),
  validateAndPrepareFix: vi.fn(),
  consumeFix: vi.fn(),
}));
vi.mock("../../src/engine/identity-tracker.js", () => ({
  buildHintsForTitle: vi.fn().mockReturnValue(null),
  observeTarget: vi.fn(),
  toTargetHints: vi.fn().mockReturnValue({}),
  buildCacheStateHints: vi.fn().mockReturnValue({}),
}));

// ADR-036 — without this mock the title road is the only road this file can drive:
// `resolveWindowTarget` falls back to `null` here, because the native win32 binding is
// absent on a dev machine and the resolver swallows that. And the gone code is withheld
// from the title road on purpose. So a refusal cell written without it pins a state
// production cannot produce. Gate 2 caught exactly that: a mutant scoping the guard to
// `resolvedWin === null` — dead on every real call — left the cell green.
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) =>
      p.hwnd !== undefined
        // Deliberately NOT equal to the caller's `windowTitle`. While the two matched,
        // this file could not tell "the resolved title" from "what the caller asked
        // for", so a refusal reporting the raw caller title passed every cell here —
        // the sibling observation suite keeps them different for the same reason
        // (gate 2, L4 on `24bd47d`).
        ? { hwnd: BigInt(p.hwnd), title: "TestApp — resolved", warnings: [], className: "TestClass" }
        : null),
  };
});

import { setElementValueHandler } from "../../src/tools/ui-elements.js";
import { setElementValue, insertTextViaTextPattern2 } from "../../src/engine/uia-bridge.js";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
// Imported to pin PROVENANCE rather than prose: the previous cell asserted the
// advice lacked two phrases, which goes quiet the day the shared dictionary adopts
// the same hedged wording — the open design decision this refusal was filed under.
import { getSuggestsForCode } from "../../src/tools/_errors.js";

const BASE_ARGS = { windowTitle: "TestApp", value: "hello", name: "input" };
/** The refusal below exists only on the handle road, so the cell has to name a handle. */
const PINNED = 0x4444n;
const PINNED_ARGS = { ...BASE_ARGS, hwnd: String(PINNED) };

describe("setElementValueHandler — chain disabled (DTM_SET_VALUE_CHAIN=0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["DTM_SET_VALUE_CHAIN"];
  });

  it("succeeds via ValuePattern (channel 1)", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: true });
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.channel).toBe("value");
    expect(insertTextViaTextPattern2).not.toHaveBeenCalled();
  });

  it("returns failure when ValuePattern fails and chain is disabled", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(insertTextViaTextPattern2).not.toHaveBeenCalled();
    expect(keyboardTypeHandler).not.toHaveBeenCalled();
  });
});

describe("setElementValueHandler — chain enabled (DTM_SET_VALUE_CHAIN=1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["DTM_SET_VALUE_CHAIN"] = "1";
  });
  afterEach(() => {
    delete process.env["DTM_SET_VALUE_CHAIN"];
  });

  it("succeeds via ValuePattern without trying TextPattern2", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: true });
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.channel).toBe("value");
    expect(insertTextViaTextPattern2).not.toHaveBeenCalled();
  });

  it("falls through to TextPattern2 when ValuePattern fails", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: true });
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.channel).toBe("text2");
    expect(keyboardTypeHandler).not.toHaveBeenCalled();
  });

  it("falls through to keyboard when ValuePattern + TextPattern2 both fail", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "TextPattern2NotSupported" });
    vi.mocked(keyboardTypeHandler).mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true,"typed":5}' }],
    } as any);
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.channel).toBe("keyboard");
  });

  it("does not refuse a title-road call, because the title road never says gone", async () => {
    // Pins `&& resolvedWin !== null` on the guard. Removing it SURVIVED the whole
    // suite, because every other cell reaching this refusal names a handle — and
    // this PR widened the blast radius: the refusal now dereferences
    // `resolvedWin.hwnd`, so a widened guard throws into the outer catch and the
    // caller gets a generic `ToolError` with no advice at all (gate 2, LOW).
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "aim_window_gone" });
    vi.mocked(keyboardTypeHandler).mockResolvedValue({
      content: [{ type: "text", text: '{"ok":true,"typed":5}' }],
    } as never);
    // BASE_ARGS names no handle, so the resolver mock answers null.
    const parsed = JSON.parse((await setElementValueHandler(BASE_ARGS)).content[0].text);
    // A title search finding nothing is not a window that left: the title road
    // answers `WindowNotFound`, never the gone code, so this refusal must not fire.
    expect(parsed.code).not.toBe("AimWindowGone");
    expect(keyboardTypeHandler).toHaveBeenCalled();
  });

  it("names no tool the caller lacks — among the names it can recognize", async () => {
    // The advice used to name `desktop_discover`. That tool is registered by the v2
    // branch, and `set_element_value` — the only road this refusal reaches a caller
    // from — is registered in the kill-switch `else`. The two are MUTUALLY EXCLUSIVE
    // (`if (_desktopV2) { registerDesktopTools(s) } else { …v1 tools… }`), so the
    // advice was naming a tool the caller provably does not have. It was introduced
    // while fixing a DIFFERENT false promise, and neither the wording pins nor the
    // provenance pin noticed — the advice reads perfectly either way, and only the
    // caller finds out. win2 predicted this shape for ADR-036 I-6; it was live already.
    //
    // So pin the INVARIANT, not the strings: every tool the advice names must be
    // registered in the same branch as the tool producing the advice. Deliberately
    // coupled to the registration source, so it goes red when registration moves —
    // which is precisely when the advice would otherwise start lying in silence.
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "aim_window_gone" });
    const parsed = JSON.parse((await setElementValueHandler(PINNED_ARGS)).content[0].text);
    const adv = parsed.suggest.join(" ");
    // DETECTION was a five-prefix regex, and gate 2 killed it by mutation: advice
    // saying "Use keyboard and perception_read and screenshot_ocr" left this cell
    // GREEN. NOTE, because an earlier version of this comment took credit it had
    // not earned: drawing the vocabulary from the catalog did NOT kill that
    // mutant. It is still green HERE. `perception_read` and `screenshot_ocr` are
    // privatized, so they are absent from `STUB_TOOL_CATALOG`, never enter this
    // vocabulary, and die only in `tool-naming-phase4` because they sit on
    // `OLD_NAMES` — a different suite, for a different reason (gate 2 on
    // `b2ac009`). What the rewrite actually fixed was the five-prefix blindness,
    // not that mutant. The original failure was that `keyboard`, `screenshot`,
    // `terminal`, `clipboard`, `focus_window`, `mouse_click`, `wait_until` and
    // `key_locker` all match no prefix. So the cell pinned "every name matching
    // five prefixes", not "every tool name" — and it therefore over-PERMITTED as
    // well as over-rejecting, which contradicts what mac had filed about its
    // failure direction. Half-credit, stated exactly: of those eight, the rewrite
    // made FOUR detectable. `keyboard`, `screenshot`, `terminal` and `clipboard`
    // are in the catalog but carry no underscore, so the filter below still drops
    // them and they remain undetected (gate 2 on `db9461d`, LOW). That is
    // deliberate — see the bare-word argument further down — but "fixed the
    // five-prefix blindness" would read as all eight if the count were left out.
    //
    // `key_locker` is the one with teeth: `registerKeyLockerTools` returns early
    // when `keyLockerDisabled()`, so it is genuinely conditional and advice naming
    // it can be un-callable while a prefix regex sees nothing.
    //
    // Detection now draws its vocabulary from the shipped catalog. Note this is NOT
    // the availability set and must not be mistaken for one: the catalog holds 30
    // v2-surface names, EXCLUDES all three V1 tools, and INCLUDES `key_locker`.
    // Using it as availability would license exactly the un-callable advice above.
    // Vocabulary and availability are separate concerns; the regex conflated them.
    // Detection is limited to UNDERSCORED names, and the line is principled rather
    // than convenient. Matching bare tool names against prose cannot distinguish a
    // reference from a description: this cell first failed on `\bkeyboard\b` hitting
    // the advice's own English — "the keyboard fallback types into whichever window"
    // — which names a channel, not a tool. Gate 2's mutation used explicit tool
    // references, so it never surfaced that.
    //
    // What makes the restriction safe rather than a hole: `key_locker` is the ONLY
    // tool whose REGISTRATION self-gates (`key-locker-tool.ts:414`, verified with a
    // positive control after a broken grep first reported none), and it contains an
    // underscore. Every bare-word tool — keyboard, terminal, screenshot, clipboard,
    // scroll, excel — is registered unconditionally, so failing to detect one cannot
    // produce un-callable advice. The names that CAN be absent are all underscored.
    //
    // THE LIMIT OF THAT ARGUMENT, because it is easy to read as more than it says
    // (gate 2 on `db9461d`, MEDIUM). It is about REGISTRATION CONDITIONALITY — which
    // real tools might not be installed — and says nothing about EXISTENCE. A name
    // that is not a tool at all is invisible here: gate 2 put `window_list`
    // (invented), `desktop_discovery` (typo) and `Desktop_Discover` (wrong case)
    // into the shipped advice and this cell stayed GREEN, as did
    // `tool-naming-phase4`. So this cell cannot answer "is this a real tool"; it
    // answers "among the names I recognize, is any one of them absent here". The
    // test name says exactly that much and no more. Closing the existence gap needs
    // token-shape detection, which is a separate change with its own hazard (below).
    //
    // Availability below remains narrower than reality (see the filed row): it is
    // computed from one registrar plus the V1 trio, not the 25 `register*(s)` calls
    // the server makes — "25" counts registrars RECEIVING THE SERVER at
    // `server-windows.ts:235-277`; the kill-switch branch runs 24 of them, and
    // `registerKeyLockerWiring()` at 262 takes no server and installs nothing. The
    // rule is stated because four different rules give four defensible counts, and
    // the number was already wrong once (gate 2 on `db9461d`, LOW). Widening
    // detection to the full catalog while availability stayed at four turned a
    // known-narrow set into an active false rejection, against a source whose scope
    // is written down. win2's measured `tools/list` carries a SCOPE_WARNING
    // precisely because `inBoth` meant "both fukuwarai configs, this machine's other
    // switches as-is" and would have licensed `key_locker` — the same
    // false-acceptance direction, moved from the regex into the data.
    const vocabulary = [...STUB_TOOL_CATALOG.map((e) => e.name), ...V1_FALLBACKS, "desktop_discover", "desktop_act"]
      .filter((t) => t.includes("_"));
    const named = [...new Set(vocabulary.filter((t) => new RegExp(`\\b${t}\\b`).test(adv)))];

    // AVAILABILITY, not textual co-location. The previous version of this cell
    // grepped the kill-switch `else` block of `server-windows.ts` — which would have
    // REJECTED advice naming `click_element`, even though `registerUiElementTools`
    // runs at line 239, unconditionally, before the `if (_desktopV2)` at 276. So the
    // cell verified where a name sits in a file rather than whether the caller has
    // the tool (PR 側 codex P3). Worse, win2 had already MEASURED the answer via
    // `tools/list` on a server started both ways — `click_element` and `keyboard`
    // present in both configurations — and this cell was built against source text
    // with that measurement in hand.
    //
    // What this probe ACTUALLY computes: one registrar plus the three V1 fallbacks
    // — four names. An earlier sentence here claimed it was "everything the
    // unconditional registrars install", directly above code installing one, and
    // it stood alongside the correct description twenty lines up. That is the
    // splice-without-deleting defect this very PR diagnoses in `ui-elements.ts`,
    // committed in the comment that explains the fix (gate 2, LOW-MEDIUM).
    // The trio is listed explicitly because `createMcpServer` is not exported, so
    // the kill-switch branch cannot be invoked from a test; it is anchored to
    // win2's `tools/list` observation rather than to a reading of the branch.
    // This set is known-narrow and filed: it false-rejects 22 genuinely available
    // tools, and the rejection is ARMED, not theoretical — gate 2 took the positive
    // control, adding the correct advice "Bring it forward with `focus_window`
    // first" and turning this cell RED with a message that says `focus_window` is
    // unavailable. It is installed by `registerWindowTools(s)` at
    // `server-windows.ts:238`, unconditionally. The next person to write correct
    // recovery advice gets a red suite that lies to them about why.
    //
    // The fix is availability = (registrar with no self-gate) INTERSECT (present in
    // that config's `tools/list`), which excludes `key_locker`. An earlier version
    // of this comment said it must land WITH token-shape detection because widening
    // detection alone amplifies this gap. THAT REASON IS WRONG and gate 2 measured
    // it: every catalog name is ALREADY detected, so token-shape adds zero
    // rejections among the 22. The two halves are not symmetric. Widening
    // availability is the safe half and DISARMS the trap above, so it goes first,
    // alone. Token-shape is the risky half for a different reason, never stated
    // before: it cannot tell a tool name from an error code or a parameter, so
    // `aim_window_gone` and `_skipAutoGuard` would read as tools. It needs its own
    // guard against non-tool tokens, and it follows separately.
    const probe = new McpServer({ name: "probe", version: "0" });
    registerUiElementTools(probe);
    const availableUnconditionally = new Set(
      Object.keys((probe as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {}),
    );
    const available = new Set([...availableUnconditionally, ...V1_FALLBACKS]);
    expect(available.has("click_element"), "probe should see the unconditional registration").toBe(true);
    for (const tool of named) {
      expect(available.has(tool), `advice names ${tool}, which is not available where this refusal fires`).toBe(true);
    }

    // TWO GATES FORBID OPPOSITE THINGS HERE, and between them every tool name is
    // blocked. `tool-naming-phase4` bans the V1 names from LLM-facing prose — and
    // `set_element_value`, the tool producing this very advice, is itself on that
    // list, whose stated migration is `→ desktop_discover`. But registration is
    // `if (_desktopV2) {…} else {…v1 tools…}`, mutually exclusive, and this refusal
    // reaches a caller ONLY from the kill-switch branch, where `desktop_discover`
    // is not registered. Sanctioned name absent; present names forbidden.
    //
    // The sibling refusal above names `desktop_discover` and is a defect — though
    // not for the reason first written here. That the naming gate is indifferent to
    // registration explains why the name is present; it does not show the tool is
    // absent where the advice fires, and reachability is the load-bearing claim.
    // Measured rather than inferred: `tools/list` from a server started both ways
    // shows `desktop_discover` missing under the kill switch, so that advice is
    // un-callable, not just unhelpful. Describing the ACTION is true either way.
    for (const forbidden of ["get_ui_elements", "get_windows", "set_element_value", "scope_element"]) {
      expect(adv, `advice must not name the V1 tool ${forbidden} (tool-naming-phase4)`).not.toContain(forbidden);
    }
    // Naming nothing must not become a licence to say nothing: the recovery has to
    // stay concrete, or this cell would pass on advice that dropped it entirely.
    // Re-pointed with the advice, for the third time today: this asked for "by its
    // handle", which the wording dropped when the handle stopped being described as
    // identity-preserving. The property being guarded is unchanged — naming no tool
    // must not become licence to say nothing — so it now pins the weaker, true claim.
    expect(adv).toMatch(/what owns it now/i);
    expect(adv).toMatch(/context\.hwnd/);

  });

  it("stops the chain when channel 2 says the window is gone, rather than typing into whatever is in front", async () => {
    // ADR-036 — channel 3 is a foreground select-all-and-replace resolved by
    // TITLE, with the auto-guard skipped. Continuing past `aim_window_gone`
    // sends Ctrl+A and the whole value to the window that inherited the
    // foreground, and a same-titled sibling passes the leash's substring check.
    //
    // Driven through the HANDLE road, which is the only road that can produce
    // the code: the bridge withholds it from a title search, because a window
    // that stops matching a title is not a window that left.
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "aim_window_gone" });
    const result = await setElementValueHandler(PINNED_ARGS);
    // The channel that produced the refusal was itself aimed at the handle — if
    // it were not, the code could not have arrived and this cell would be
    // pinning a state the product never reaches.
    expect(vi.mocked(insertTextViaTextPattern2).mock.calls[0]?.[4]).toEqual({ hwnd: PINNED });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("AimWindowGone");
    // The sentence reports what was ANSWERED, not the state of the world: the
    // PowerShell road reaches this code through a blanket catch over the whole
    // descendant walk, and a provider or RPC fault there is not proof the window
    // left. Pinned because reverting it to "no longer exists" passed all 6096
    // cells — the claim had no check (gate 2, L3 on `24bd47d`).
    expect(parsed.error).toMatch(/was reported as gone/);
    expect(parsed.error).not.toMatch(/no longer exists/);
    // And the refusal names the window the write was actually aimed at — the
    // RESOLVED title, not the partial string the caller typed.
    expect(parsed.context?.windowTitle).toBe("TestApp — resolved");
    // The refusal must say its name AND what to do. An empty `suggest` is dropped
    // from the envelope by `toToolFailure`, so a missing dictionary lookup is a
    // silent loss of advice rather than a visibly empty field.
    expect(parsed.suggest?.length ?? 0).toBeGreaterThan(0);
    // A refusal must leave a CONCRETE next step, and this cell used to accept the
    // mere mention of desktop_discover. Gate 2 showed that was the wrong step here:
    // a title-shaped listing cannot answer "is THIS window still there", because a
    // title can name more than one. So pin the by-handle read, which can — and which
    // is a real parameter on this tool family, not an invented one.
    // Re-pointed from the tool NAME to the ACTION. This used to assert
    // `/get_ui_elements/`, which `tool-naming-phase4` forbids in LLM-facing prose —
    // and the sanctioned replacement, `desktop_discover`, is not registered in the
    // branch this refusal fires from. Every tool name is blocked, so the advice
    // describes what to do instead. Deleting the assertion was not an option: it
    // was guarding that the refusal leaves a concrete next step at all.
    // Re-pointed a second time, and for a sharper reason than the first. This asked
    // for "read it again by its handle", which the advice no longer says — because a
    // handle does NOT preserve identity. Windows recycles handle numbers and
    // `resolveWindowTarget` resolves one by asking whether something is there, never
    // comparing process identity, so a reread can answer for an unrelated
    // replacement (PR 側 codex P2). The concrete step survives; what it promises
    // shrank to what is true. Deleting these was not an option — they guard that the
    // refusal leaves a next step at all.
    expect(parsed.suggest.join(" ")).toMatch(/context\.hwnd/);
    expect(parsed.suggest.join(" ")).toMatch(/what owns it now/i);
    // A by-handle read needs the title too: `get_ui_elements`' `windowTitle` is
    // required (`z.string()`, no `.optional()`) while `hwnd` merely takes
    // precedence, so a caller sending `{hwnd}` alone gets a zod error instead of a
    // read (PR 側 codex gate 2, LOW 6). Pinned because dropping the clause left all
    // 165 cells green — the third claim today that was argued in the code and
    // checked nowhere.
    expect(parsed.suggest.join(" ")).toMatch(/context\.windowTitle/);
    expect(parsed.suggest.join(" ")).toMatch(/needs both/i);
    // And it must NOT claim the reread establishes the original window survived.
    expect(parsed.suggest.join(" ")).toMatch(/recycled/i);
    expect(parsed.suggest.join(" ")).not.toMatch(/stays specific to the window/i);
    // The advice must carry the same uncertainty as the error text. The shared
    // `SUGGESTS.AimWindowGone` asserts the window is gone and the handle unusable,
    // and the advice is the half a model reads — so a live window whose provider
    // faulted mid-walk would be told to discard a still-valid lease and handle.
    // Two independent gates found that (codex P2, gate 2 Medium); this pins the
    // fix, because nothing else would notice it being reverted to the shared array.
    const advice = parsed.suggest.join(" ");
    // PROVENANCE, not prose. Asserting only that two phrases are absent passes the
    // moment the shared dictionary adopts this same hedged wording — which is the
    // open design decision this refusal was filed under, so the silence is not
    // hypothetical (gate 2, Medium on `f960513`, proven by mutation).
    expect(parsed.suggest).not.toEqual(getSuggestsForCode("AimWindowGone"));
    expect(advice).not.toMatch(/no longer exists/);
    expect(advice).not.toMatch(/is not reusable/);
    // Case-insensitive alternations, not exact prose: the sibling suite was already
    // burned by pinning wording that a semantically identical rewrite would break.
    expect(advice).toMatch(/reported .{0,12}gone/i);
    // The load-bearing half — it must close BOTH roads back into the hazard.
    expect(advice).toMatch(/do not.{0,40}coordinate/i);
    expect(advice).toMatch(/do not.{0,40}title/i);
    // And it must name the window it refused, or the caller cannot act precisely.
    expect(advice).toMatch(/context\.hwnd/);
    expect(parsed.context?.hwnd).toBe(String(PINNED));
    // Lease vocabulary belongs to desktop_act; this handler has no lease.
    expect(advice).not.toMatch(/lease/i);
    // The whole point of the row: channel 3 never runs.
    expect(keyboardTypeHandler).not.toHaveBeenCalled();
    expect(parsed.context?.attempts).toHaveLength(2);
  });

  it("returns SetValueAllChannelsFailed when all channels fail", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "ValuePatternNotSupported" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "TextPattern2NotSupported" });
    vi.mocked(keyboardTypeHandler).mockResolvedValue({
      content: [{ type: "text", text: '{"ok":false,"error":"KeyboardFailed"}' }],
    } as any);
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code ?? parsed.error).toMatch(/SetValueAllChannelsFailed/);
    expect(parsed.context?.attempts).toHaveLength(3);
  });

  it("context.attempts records per-channel errors", async () => {
    vi.mocked(setElementValue).mockResolvedValue({ ok: false, error: "VPError" });
    vi.mocked(insertTextViaTextPattern2).mockResolvedValue({ ok: false, code: "TP2Error" });
    vi.mocked(keyboardTypeHandler).mockResolvedValue({
      content: [{ type: "text", text: '{"ok":false}' }],
    } as any);
    const result = await setElementValueHandler(BASE_ARGS);
    const parsed = JSON.parse(result.content[0].text);
    const attempts = parsed.context?.attempts ?? [];
    expect(attempts[0]).toMatchObject({ channel: "value" });
    expect(attempts[1]).toMatchObject({ channel: "text2" });
    expect(attempts[2]).toMatchObject({ channel: "keyboard" });
  });
});
