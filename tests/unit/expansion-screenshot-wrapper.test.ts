/**
 * expansion-screenshot-wrapper.test.ts
 *
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper).
 * Pins the bit-equal contract for `screenshotRegistrationHandler` —
 * `screenshot` wrapped via `makeQueryWrapper` (S4 query-axis fast path,
 * no causedByProjector wired).
 *
 * Coverage:
 *   - module-scope export shape (schema injection + wrapped handler exist)
 *   - default (no include, env unset) → raw shape (compat hoist)
 *   - include=["envelope"] → envelope shape with `_version` / `data` /
 *     `as_of` / `confidence`
 *   - env DESKTOP_TOUCH_ENVELOPE=1 → envelope shape (server-wide default)
 *   - include=["raw"] overrides env=1 (per-call wins)
 *   - include peeked + stripped — wrapped handler does NOT see args.include
 *   - Zod schema preserves include through z.object(...).parse()
 *   - query-axis boundary: no L1 ToolCallStarted/Completed events emitted
 *     (commit-axis only — verified by spying on defaultL1Emitter)
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defaultL1Emitter,
  makeQueryWrapper,
  _resetHistoryBuffersForTest,
} from "../../src/tools/_envelope.js";
import {
  screenshotRegistrationHandler,
  screenshotRegistrationSchema,
} from "../../src/tools/screenshot.js";

interface ToolResultLike {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

function makeFakeResult(data: unknown): ToolResultLike {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function parseResult(r: ToolResultLike): unknown {
  const text = r.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  return JSON.parse(text);
}

const FAKE_META_DATA = {
  detail: "meta",
  windows: [
    { title: "Notepad", region: { x: 0, y: 0, width: 1024, height: 768 }, zOrder: 0, isActive: true },
  ],
};

const FRESH_WALLCLOCK = 1_738_156_823_412;

// ── 1. Module-scope export shape ─────────────────────────────────────────────

describe("screenshot expansion wrapper — module-scope exports", () => {
  it("exports `screenshotRegistrationHandler` as a function", () => {
    expect(typeof screenshotRegistrationHandler).toBe("function");
  });

  it("exports `screenshotRegistrationSchema` with `include` injected", () => {
    expect("include" in screenshotRegistrationSchema).toBe(true);
  });

  it("preserves include=['envelope'] through z.object(...).parse() (PR #112 pattern)", () => {
    const parsed = z.object(screenshotRegistrationSchema).parse({
      include: ["envelope"],
      windowTitle: "Notepad",
    });
    expect(parsed.include).toEqual(["envelope"]);
    expect(parsed.windowTitle).toBe("Notepad");
  });

  it("treats include as optional (undefined survives parse)", () => {
    const parsed = z.object(screenshotRegistrationSchema).parse({});
    expect(parsed.include).toBeUndefined();
  });
});

// ── 2. Wrapper envelope contract ─────────────────────────────────────────────

describe("makeQueryWrapper(screenshot) — envelope shape contracts", () => {
  function buildWrapped(opts: {
    envValue?: string;
    handlerImpl?: (args: Record<string, unknown>) => Promise<ToolResultLike>;
  } = {}) {
    const handler =
      opts.handlerImpl ??
      (async (_args: Record<string, unknown>) => makeFakeResult(FAKE_META_DATA));
    return makeQueryWrapper(handler, "screenshot", {
      fetchMeta: async () => ({
        viewPoisoned: false,
        asOfWallclockMs: FRESH_WALLCLOCK,
      }),
      getEnvValue: () => opts.envValue,
    });
  }

  it("default (no include, env unset) returns raw shape (compat hoist)", async () => {
    const wrapped = buildWrapped();
    const result = (await wrapped({})) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed.detail).toBe("meta");
    expect(parsed._version).toBeUndefined();
    expect(parsed.as_of).toBeUndefined();
  });

  it("include=['envelope'] returns envelope shape", async () => {
    const wrapped = buildWrapped();
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toEqual(FAKE_META_DATA);
    expect((parsed.as_of as { wallclock_ms: number }).wallclock_ms).toBe(FRESH_WALLCLOCK);
    expect(parsed.confidence).toBe("fresh");
  });

  it("env DESKTOP_TOUCH_ENVELOPE=1 returns envelope shape (server-wide default)", async () => {
    const wrapped = buildWrapped({ envValue: "1" });
    const result = (await wrapped({})) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toEqual(FAKE_META_DATA);
  });

  it("include=['raw'] overrides env=1 (per-call wins)", async () => {
    const wrapped = buildWrapped({ envValue: "1" });
    const result = (await wrapped({ include: ["raw"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBeUndefined();
    expect(parsed.detail).toBe("meta");
  });

  it("strips `include` from args before invoking the wrapped handler", async () => {
    const handlerSpy = vi.fn(async (args: Record<string, unknown>) =>
      makeFakeResult({ receivedArgs: args })
    );
    const wrapped = makeQueryWrapper(handlerSpy, "screenshot", {
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
      getEnvValue: () => undefined,
    });
    await wrapped({
      include: ["envelope"],
      windowTitle: "Notepad",
      detail: "meta",
    } as Record<string, unknown>);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const seen = handlerSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(seen.include).toBeUndefined();
    expect(seen.windowTitle).toBe("Notepad");
    expect(seen.detail).toBe("meta");
  });
});

// ── 3. Query-axis boundary: no L1 ToolCall events ───────────────────────────
//
// `makeQueryWrapper` is the read-only observation wrapper — it never
// emits L1 ToolCallStarted / ToolCallCompleted events (those are
// commit-axis only, owned by `makeCommitWrapper`). This test pins the
// boundary by spying on `defaultL1Emitter.pushStarted/pushCompleted`
// and asserting zero invocations across a query call. screenshot is a
// read-only capture, so query axis is the correct classification.

describe("makeQueryWrapper(screenshot) — query-axis boundary", () => {
  it("does NOT emit ToolCallStarted/Completed events (commit axis only)", async () => {
    _resetHistoryBuffersForTest();
    const startedSpy = vi.spyOn(defaultL1Emitter, "pushStarted");
    const completedSpy = vi.spyOn(defaultL1Emitter, "pushCompleted");
    try {
      const wrapped = makeQueryWrapper(
        async () => makeFakeResult(FAKE_META_DATA),
        "screenshot",
        {
          fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
          getEnvValue: () => undefined,
        }
      );
      await wrapped({ include: ["envelope"] });
      expect(startedSpy).not.toHaveBeenCalled();
      expect(completedSpy).not.toHaveBeenCalled();
    } finally {
      startedSpy.mockRestore();
      completedSpy.mockRestore();
    }
  });
});
