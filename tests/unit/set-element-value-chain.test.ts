/**
 * tests/unit/set-element-value-chain.test.ts
 *
 * Unit tests for the set_element_value channel chain (Phase B).
 * Mocks uia-bridge and keyboard handler; no real Win32 calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    expect(parsed.suggest.join(" ")).toMatch(/desktop_discover/);
    // The advice must carry the same uncertainty as the error text. The shared
    // `SUGGESTS.AimWindowGone` asserts the window is gone and the handle unusable,
    // and the advice is the half a model reads — so a live window whose provider
    // faulted mid-walk would be told to discard a still-valid lease and handle.
    // Two independent gates found that (codex P2, gate 2 Medium); this pins the
    // fix, because nothing else would notice it being reverted to the shared array.
    const advice = parsed.suggest.join(" ");
    expect(advice).not.toMatch(/no longer exists/);
    expect(advice).not.toMatch(/is not reusable/);
    expect(advice).toMatch(/was reported as gone/);
    // And it still says the thing that is actually load-bearing for recovery.
    expect(advice).toMatch(/Do NOT retry by coordinate/);
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
