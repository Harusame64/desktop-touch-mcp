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

import { setElementValueHandler } from "../../src/tools/ui-elements.js";
import { setElementValue, insertTextViaTextPattern2 } from "../../src/engine/uia-bridge.js";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";

const BASE_ARGS = { windowTitle: "TestApp", value: "hello", name: "input" };

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
