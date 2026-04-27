/**
 * tests/unit/keyboard-leash-guard.test.ts
 *
 * Unit tests for Focus Leash Phase B (per-chunk foreground guard for
 * non-terminal apps).
 *
 * Two layers:
 *   1. getLeashChunkSize — env parsing and clamping.
 *   2. Chunked send behavior — mock nutjs.keyboard.type and checkForegroundOnce
 *      to verify (a) leash disabled paths still single-shot, (b) leash-enabled
 *      paths chunk + check between chunks, (c) focus theft mid-stream returns
 *      failWith with typed/remaining/focusLost.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — set up before importing keyboard.ts so the handler picks them up.
// ─────────────────────────────────────────────────────────────────────────────

const mockTypeFn = vi.fn();
vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: (...args: unknown[]) => mockTypeFn(...args),
    pressKey: vi.fn(),
    releaseKey: vi.fn(),
  },
}));

vi.mock("../../src/tools/_focus.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_focus.js")
  >("../../src/tools/_focus.js");
  return {
    ...actual,
    detectFocusLoss: vi.fn().mockResolvedValue(null),
    checkForegroundOnce: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../../src/tools/_action-guard.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_action-guard.js")
  >("../../src/tools/_action-guard.js");
  return {
    ...actual,
    runActionGuard: vi.fn().mockResolvedValue({
      block: false,
      summary: { kind: "ag-summary" },
    }),
    isAutoGuardEnabled: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../../src/engine/perception/registry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/engine/perception/registry.js")
  >("../../src/engine/perception/registry.js");
  return {
    ...actual,
    evaluatePreToolGuards: vi.fn().mockResolvedValue({ ok: true }),
    buildEnvelopeFor: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock("../../src/engine/bg-input.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/engine/bg-input.js")
  >("../../src/engine/bg-input.js");
  return {
    ...actual,
    isBgAutoEnabled: vi.fn().mockReturnValue(false),
    canInjectViaPostMessage: vi.fn().mockReturnValue({ supported: false }),
  };
});

vi.mock("../../src/engine/win32.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/engine/win32.js")
  >("../../src/engine/win32.js");
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn().mockReturnValue([
      {
        hwnd: 0x100n,
        title: "Notepad",
        region: { x: 0, y: 0, width: 100, height: 100 },
        zOrder: 0,
        isMinimized: false,
        isMaximized: false,
        isActive: true,
      },
    ]),
    getWindowClassName: vi.fn().mockReturnValue("Notepad"),
    restoreAndFocusWindow: vi.fn(),
  };
});

vi.mock("../../src/tools/_resolve-window.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/tools/_resolve-window.js")
  >("../../src/tools/_resolve-window.js");
  return {
    ...actual,
    resolveWindowTarget: vi
      .fn()
      .mockImplementation(async (opts: { hwnd?: string; windowTitle?: string }) => {
        // Match production semantics: null when no target hint provided.
        if (!opts.hwnd && !opts.windowTitle) return null;
        return { title: opts.windowTitle ?? "Notepad", warnings: [] };
      }),
  };
});

import {
  keyboardTypeHandler,
  getLeashChunkSize,
  keyboardSchema,
} from "../../src/tools/keyboard.js";
import { checkForegroundOnce } from "../../src/tools/_focus.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public dispatcher schema accepts abortOnFocusLoss (PR #65 Codex P1 regression)
// — the registered tool validates against `keyboardSchema`, NOT
// `keyboardTypeSchema`. They previously diverged silently; this test pins the
// new field's presence in the dispatcher schema so future additions to
// keyboardTypeSchema can't drift again.
// ─────────────────────────────────────────────────────────────────────────────

describe("keyboardSchema (public dispatcher) — abortOnFocusLoss reachable", () => {
  it("accepts abortOnFocusLoss:false on action:'type'", () => {
    const parsed = keyboardSchema.safeParse({
      action: "type",
      text: "hello",
      windowTitle: "Notepad",
      abortOnFocusLoss: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.action === "type") {
      expect(parsed.data.abortOnFocusLoss).toBe(false);
    }
  });

  it("accepts abortOnFocusLoss:true on action:'type'", () => {
    const parsed = keyboardSchema.safeParse({
      action: "type",
      text: "hello",
      windowTitle: "Notepad",
      abortOnFocusLoss: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.action === "type") {
      expect(parsed.data.abortOnFocusLoss).toBe(true);
    }
  });

  it("does not require abortOnFocusLoss (optional)", () => {
    const parsed = keyboardSchema.safeParse({
      action: "type",
      text: "hello",
    });
    expect(parsed.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLeashChunkSize — env parsing
// ─────────────────────────────────────────────────────────────────────────────

describe("getLeashChunkSize", () => {
  const originalEnv = process.env.DTM_LEASH_CHUNK_SIZE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DTM_LEASH_CHUNK_SIZE;
    else process.env.DTM_LEASH_CHUNK_SIZE = originalEnv;
  });

  it("returns default 8 when env unset", () => {
    delete process.env.DTM_LEASH_CHUNK_SIZE;
    expect(getLeashChunkSize()).toBe(8);
  });

  it("parses valid integer in [1, 1024]", () => {
    process.env.DTM_LEASH_CHUNK_SIZE = "4";
    expect(getLeashChunkSize()).toBe(4);
    process.env.DTM_LEASH_CHUNK_SIZE = "1024";
    expect(getLeashChunkSize()).toBe(1024);
    process.env.DTM_LEASH_CHUNK_SIZE = "1";
    expect(getLeashChunkSize()).toBe(1);
  });

  it("falls back to 8 on out-of-range or invalid values", () => {
    process.env.DTM_LEASH_CHUNK_SIZE = "0";
    expect(getLeashChunkSize()).toBe(8);
    process.env.DTM_LEASH_CHUNK_SIZE = "1025";
    expect(getLeashChunkSize()).toBe(8);
    process.env.DTM_LEASH_CHUNK_SIZE = "-1";
    expect(getLeashChunkSize()).toBe(8);
    process.env.DTM_LEASH_CHUNK_SIZE = "abc";
    expect(getLeashChunkSize()).toBe(8);
    process.env.DTM_LEASH_CHUNK_SIZE = "";
    expect(getLeashChunkSize()).toBe(8);
  });

  it("parseInt accepts leading numeric prefix (matches existing JS semantics)", () => {
    process.env.DTM_LEASH_CHUNK_SIZE = "16abc";
    expect(getLeashChunkSize()).toBe(16);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chunked send — leash-enabled / -disabled paths and focus-theft handling
// ─────────────────────────────────────────────────────────────────────────────

describe("keyboardTypeHandler — Phase B leash-enabled foreground send", () => {
  const baseArgs = {
    text: "abcdefgh", // 8 chars
    method: "foreground" as const,
    use_clipboard: false,
    replaceAll: false,
    forceKeystrokes: false,
    windowTitle: "Notepad",
    trackFocus: false,
    settleMs: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DTM_LEASH_CHUNK_SIZE = "4"; // 8 chars -> 2 chunks
    vi.mocked(checkForegroundOnce).mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.DTM_LEASH_CHUNK_SIZE;
  });

  it("default (windowTitle set, abortOnFocusLoss undefined) → chunks the send", async () => {
    await keyboardTypeHandler(baseArgs);
    // 8 chars / 4 chunkSize = 2 chunks
    expect(mockTypeFn).toHaveBeenCalledTimes(2);
    expect(mockTypeFn).toHaveBeenNthCalledWith(1, "abcd");
    expect(mockTypeFn).toHaveBeenNthCalledWith(2, "efgh");
    // Foreground checked once per chunk (before the send)
    expect(checkForegroundOnce).toHaveBeenCalledTimes(2);
  });

  it("abortOnFocusLoss=false → single-shot send, no per-chunk checks", async () => {
    await keyboardTypeHandler({ ...baseArgs, abortOnFocusLoss: false });
    expect(mockTypeFn).toHaveBeenCalledTimes(1);
    expect(mockTypeFn).toHaveBeenCalledWith("abcdefgh");
    expect(checkForegroundOnce).not.toHaveBeenCalled();
  });

  it("no windowTitle → leash disabled, single-shot send", async () => {
    const { windowTitle: _w, ...rest } = baseArgs;
    void _w;
    await keyboardTypeHandler({ ...rest, abortOnFocusLoss: true });
    expect(mockTypeFn).toHaveBeenCalledTimes(1);
    expect(mockTypeFn).toHaveBeenCalledWith("abcdefgh");
    expect(checkForegroundOnce).not.toHaveBeenCalled();
  });

  it("focus theft on first check → returns failWith, typed=0, remaining=full text, no keystrokes", async () => {
    vi.mocked(checkForegroundOnce).mockResolvedValueOnce({
      afterMs: 0,
      expected: "Notepad",
      stolenBy: "Chrome",
      stolenByProcessName: "chrome",
    });
    const result = await keyboardTypeHandler(baseArgs);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("FocusLostDuringType");
    expect(parsed.context.context.typed).toBe(0);
    expect(parsed.context.context.remaining).toBe("abcdefgh");
    expect(parsed.context.context.focusLost.stolenBy).toBe("Chrome");
    expect(mockTypeFn).not.toHaveBeenCalled();
  });

  it("focus theft on second check → returns failWith, typed=4, remaining='efgh', first chunk delivered", async () => {
    vi.mocked(checkForegroundOnce)
      .mockResolvedValueOnce(null) // chunk 0 OK
      .mockResolvedValueOnce({
        afterMs: 0,
        expected: "Notepad",
        stolenBy: "Chrome",
        stolenByProcessName: "chrome",
      });
    const result = await keyboardTypeHandler(baseArgs);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("FocusLostDuringType");
    expect(parsed.context.context.typed).toBe(4);
    expect(parsed.context.context.remaining).toBe("efgh");
    // First chunk was sent before theft
    expect(mockTypeFn).toHaveBeenCalledTimes(1);
    expect(mockTypeFn).toHaveBeenCalledWith("abcd");
  });

  it("partial response includes total and chunkSize for caller diagnostics", async () => {
    vi.mocked(checkForegroundOnce).mockResolvedValueOnce({
      afterMs: 0,
      expected: "Notepad",
      stolenBy: "Chrome",
      stolenByProcessName: "chrome",
    });
    const result = await keyboardTypeHandler(baseArgs);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.context.context.total).toBe(8);
    expect(parsed.context.context.chunkSize).toBe(4);
  });

  it("text length not a multiple of chunkSize is handled (5 chars / 4 = 2 chunks: 4 + 1)", async () => {
    await keyboardTypeHandler({ ...baseArgs, text: "abcde" });
    expect(mockTypeFn).toHaveBeenCalledTimes(2);
    expect(mockTypeFn).toHaveBeenNthCalledWith(1, "abcd");
    expect(mockTypeFn).toHaveBeenNthCalledWith(2, "e");
  });

  it("clipboard path is unaffected by the leash (single-shot Ctrl+V is atomic)", async () => {
    // Force clipboard via use_clipboard:true
    await keyboardTypeHandler({ ...baseArgs, use_clipboard: true });
    // keyboard.type (nutjs) should not be called; clipboard path doesn't use it.
    expect(mockTypeFn).not.toHaveBeenCalled();
    // checkForegroundOnce also not invoked (leash is per-chunk for keystroke path only)
    expect(checkForegroundOnce).not.toHaveBeenCalled();
  });
});
