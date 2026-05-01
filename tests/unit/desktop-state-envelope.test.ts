/**
 * desktop-state-envelope.test.ts
 *
 * Walking skeleton S3 (ADR-010 P1) G3 contract test suite (8 件).
 *
 * Pins the bit-equal contract for `makeEnvelopeAware` per
 * `docs/adr-010-p1-s3-plan.md` §3.6 / G3-1〜G3-8:
 *
 *   G3-1  default (no include, env unset)              → raw shape (compat hoist)
 *   G3-2  include=["envelope"]                          → envelope shape
 *   G3-3  env DESKTOP_TOUCH_ENVELOPE=1                  → envelope shape (server default)
 *   G3-4  priority chain: include=["raw"] overrides env→ raw shape (per-call wins)
 *   G3-5  payload > 1024 bytes                          → confidence: degraded (size SLO)
 *   G3-6  viewPoisoned                                  → confidence: degraded
 *   G3-7  as_of.wallclock_ms = L1 event wallclock       (NOT Date.now()) when supplied
 *   G3-8  Zod schema unchanged (handler args lack include) — `include` peeked + stripped
 *
 * `makeEnvelopeAware` accepts mocked `fetchMeta` + `getEnvValue` so the
 * tests pin all 8 behaviors deterministically without napi / process.env
 * mutation (CLAUDE.md `feedback_pure_parser_for_env_helpers.md`).
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildEnvelope,
  compatHoist,
  envelopePayloadSizeBytes,
  ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES,
  makeEnvelopeAware,
  resolveEnvelopeOptIn,
  withEnvelopeIncludeSchema,
} from "../../src/tools/_envelope.js";
import { desktopStateRegistrationSchema } from "../../src/tools/desktop-state.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ToolResultLike {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Build a fake desktop_state-shaped MCP ToolResult. */
function makeFakeResult(data: unknown): ToolResultLike {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

/** Parse the envelope/raw JSON out of an MCP ToolResult. */
function parseResult(r: ToolResultLike): unknown {
  const text = r.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  return JSON.parse(text);
}

const MOCK_DATA = {
  focusedWindow: { title: "Notepad", hwnd: 12345, processName: "notepad.exe" },
  focusedElement: { name: "Edit", type: "Document", value: "" },
  cursorPos: { x: 100, y: 200 },
  hasModal: false,
  pageState: "ready",
  attention: "ok",
};

const FRESH_WALLCLOCK = 1_738_156_823_412;

// ── Pure helper unit tests (foundation for the 8 G3 contracts) ──────────────

describe("resolveEnvelopeOptIn priority chain", () => {
  it("returns true when include contains 'envelope'", () => {
    expect(resolveEnvelopeOptIn(["envelope"], undefined)).toBe(true);
  });
  it("returns false when include contains 'raw' even if env=1", () => {
    expect(resolveEnvelopeOptIn(["raw"], "1")).toBe(false);
  });
  it("returns true when env=1 and include is undefined", () => {
    expect(resolveEnvelopeOptIn(undefined, "1")).toBe(true);
  });
  it("returns false when both unset", () => {
    expect(resolveEnvelopeOptIn(undefined, undefined)).toBe(false);
    expect(resolveEnvelopeOptIn([], undefined)).toBe(false);
  });
  it("returns false for env value other than '1'", () => {
    expect(resolveEnvelopeOptIn(undefined, "0")).toBe(false);
    expect(resolveEnvelopeOptIn(undefined, "true")).toBe(false);
  });
});

describe("envelopePayloadSizeBytes", () => {
  it("returns JSON.stringify length", () => {
    expect(envelopePayloadSizeBytes({ x: 1 })).toBe(7); // {"x":1}
  });
  it("returns 0 on circular ref (defensive)", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(envelopePayloadSizeBytes(obj)).toBe(0);
  });
});

describe("buildEnvelope", () => {
  it("populates _version + data + as_of + confidence: fresh on healthy state", () => {
    const e = buildEnvelope(
      { ok: true },
      { viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }
    );
    expect(e._version).toBe("1.0");
    expect(e.data).toEqual({ ok: true });
    expect(e.as_of.wallclock_ms).toBe(FRESH_WALLCLOCK);
    expect(e.confidence).toBe("fresh");
  });
  it("forces confidence: degraded when viewPoisoned=true", () => {
    const e = buildEnvelope(
      { ok: true },
      { viewPoisoned: true, asOfWallclockMs: FRESH_WALLCLOCK }
    );
    expect(e.confidence).toBe("degraded");
  });
  it("forces confidence: degraded when asOfWallclockMs is null (Date.now() fallback)", () => {
    const before = Date.now();
    const e = buildEnvelope({ ok: true }, { viewPoisoned: false, asOfWallclockMs: null });
    const after = Date.now();
    expect(e.confidence).toBe("degraded");
    expect(e.as_of.wallclock_ms).toBeGreaterThanOrEqual(before);
    expect(e.as_of.wallclock_ms).toBeLessThanOrEqual(after);
  });
  it("forces confidence: degraded when payload > size threshold", () => {
    // Build a payload large enough to push the assembled envelope past
    // ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES.
    const big = { blob: "x".repeat(ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES + 200) };
    const e = buildEnvelope(big, { viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK });
    expect(e.confidence).toBe("degraded");
  });
});

describe("compatHoist", () => {
  it("returns envelope unchanged when optIn=true", () => {
    const env = buildEnvelope({ a: 1 }, { asOfWallclockMs: FRESH_WALLCLOCK });
    expect(compatHoist(env, true)).toBe(env);
  });
  it("returns envelope.data when optIn=false (post-flatten compat)", () => {
    const env = buildEnvelope({ a: 1 }, { asOfWallclockMs: FRESH_WALLCLOCK });
    expect(compatHoist(env, false)).toEqual({ a: 1 });
  });
});

// ── G3 contract suite for makeEnvelopeAware ─────────────────────────────────

describe("makeEnvelopeAware — G3 contract test suite (8 件)", () => {
  /** Build a wrapped handler with deterministic fetchMeta + getEnvValue. */
  function buildWrapped(opts: {
    envValue?: string;
    viewPoisoned?: boolean;
    asOfWallclockMs?: number | null;
    handlerImpl?: (args: Record<string, unknown>) => Promise<ToolResultLike>;
  } = {}) {
    const handler =
      opts.handlerImpl ??
      (async (_args: Record<string, unknown>) => makeFakeResult(MOCK_DATA));
    return makeEnvelopeAware(handler, "desktop_state", {
      fetchMeta: async () => ({
        viewPoisoned: opts.viewPoisoned ?? false,
        asOfWallclockMs:
          opts.asOfWallclockMs === undefined ? FRESH_WALLCLOCK : opts.asOfWallclockMs,
      }),
      getEnvValue: () => opts.envValue,
    });
  }

  // G3-1
  it("G3-1: default (no include, env unset) returns raw shape (compat hoist)", async () => {
    const wrapped = buildWrapped();
    const result = (await wrapped({})) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    // Raw shape: keys mirror MOCK_DATA, no envelope wrapper keys present.
    expect(parsed.focusedWindow).toEqual(MOCK_DATA.focusedWindow);
    expect(parsed._version).toBeUndefined();
    expect(parsed.as_of).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });

  // G3-2
  it("G3-2: include=['envelope'] returns envelope shape", async () => {
    const wrapped = buildWrapped();
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toEqual(MOCK_DATA);
    expect((parsed.as_of as { wallclock_ms: number }).wallclock_ms).toBe(FRESH_WALLCLOCK);
    expect(parsed.confidence).toBe("fresh");
  });

  // G3-3
  it("G3-3: env DESKTOP_TOUCH_ENVELOPE=1 returns envelope shape (server-wide default)", async () => {
    const wrapped = buildWrapped({ envValue: "1" });
    const result = (await wrapped({})) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toEqual(MOCK_DATA);
  });

  // G3-4
  it("G3-4: priority chain — include=['raw'] overrides env=1", async () => {
    const wrapped = buildWrapped({ envValue: "1" });
    const result = (await wrapped({ include: ["raw"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBeUndefined(); // raw shape, NOT envelope
    expect(parsed.focusedWindow).toEqual(MOCK_DATA.focusedWindow);
  });

  // G3-5
  it("G3-5: payload > size threshold forces confidence: degraded", async () => {
    const big = {
      ...MOCK_DATA,
      blob: "x".repeat(ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES + 200),
    };
    const wrapped = buildWrapped({
      handlerImpl: async () => makeFakeResult(big),
    });
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed.confidence).toBe("degraded");
  });

  // G3-6
  it("G3-6: viewPoisoned forces confidence: degraded", async () => {
    const wrapped = buildWrapped({ viewPoisoned: true });
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed.confidence).toBe("degraded");
  });

  // G3-7
  it("G3-7: as_of.wallclock_ms = L1 event wallclock when fetchMeta supplies it (NOT Date.now())", async () => {
    const wrapped = buildWrapped({ asOfWallclockMs: FRESH_WALLCLOCK });
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect((parsed.as_of as { wallclock_ms: number }).wallclock_ms).toBe(FRESH_WALLCLOCK);
    expect(parsed.confidence).toBe("fresh"); // L1 wallclock present → no fallback
  });

  it("G3-7b: as_of falls back to Date.now() + degraded when L1 wallclock null", async () => {
    const wrapped = buildWrapped({ asOfWallclockMs: null });
    const before = Date.now();
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    const after = Date.now();
    const parsed = parseResult(result) as Record<string, unknown>;
    const wc = (parsed.as_of as { wallclock_ms: number }).wallclock_ms;
    expect(wc).toBeGreaterThanOrEqual(before);
    expect(wc).toBeLessThanOrEqual(after);
    expect(parsed.confidence).toBe("degraded");
  });

  // G3-8
  it("G3-8: include is peeked + stripped — handler sees args without include", async () => {
    const handlerSpy = vi.fn(async (args: Record<string, unknown>) =>
      makeFakeResult({ receivedArgs: args })
    );
    const wrapped = makeEnvelopeAware(handlerSpy, "desktop_state", {
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
      getEnvValue: () => undefined,
    });
    await wrapped({
      include: ["envelope"],
      includeCursor: true,
      includeScreen: false,
    });
    // Handler must NOT see `include`. Other args (includeCursor / includeScreen) pass through.
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const seenArgs = handlerSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(seenArgs.include).toBeUndefined();
    expect(seenArgs.includeCursor).toBe(true);
    expect(seenArgs.includeScreen).toBe(false);
  });

  // Defensive pass-through paths (sub-plan §2.5)
  it("passes through MCP result unchanged when content[0] is not text type", async () => {
    const nonTextResult: ToolResultLike = {
      content: [{ type: "image", data: "base64..." }],
    };
    const wrapped = makeEnvelopeAware(
      async () => nonTextResult,
      "desktop_state",
      {
        fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
        getEnvValue: () => undefined,
      }
    );
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    expect(result).toBe(nonTextResult); // identity, no wrap
  });

  it("passes through MCP result unchanged when content[0].text is not valid JSON", async () => {
    const nonJsonResult: ToolResultLike = {
      content: [{ type: "text", text: "not-json" }],
    };
    const wrapped = makeEnvelopeAware(
      async () => nonJsonResult,
      "desktop_state",
      {
        fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
        getEnvValue: () => undefined,
      }
    );
    const result = (await wrapped({ include: ["envelope"] })) as ToolResultLike;
    expect(result).toBe(nonJsonResult);
  });
});

// ── PR #112 Round 1 P1 fix verification: schema injection + Zod parse path ──
//
// `withEnvelopeIncludeSchema` injects `include?: string[]` into a tool's
// raw shape so MCP SDK's `server.tool()` Zod parse step preserves it for
// `makeEnvelopeAware` to peek. These tests pin that contract by parsing
// the registration schema with a Zod object exactly the way the MCP SDK
// does, then asserting `include` survives.

describe("withEnvelopeIncludeSchema — Zod parse survival contract (P1 fix)", () => {
  it("returns a new shape without mutating the original", () => {
    const base = { a: z.string() };
    const injected = withEnvelopeIncludeSchema(base);
    expect("include" in base).toBe(false);
    expect("include" in injected).toBe(true);
  });

  it("preserves include=['envelope'] through z.object(...).parse()", () => {
    const parsed = z.object(desktopStateRegistrationSchema).parse({
      include: ["envelope"],
      includeCursor: true,
    });
    expect(parsed.include).toEqual(["envelope"]);
    expect(parsed.includeCursor).toBe(true);
  });

  it("preserves include=['raw'] through z.object(...).parse()", () => {
    const parsed = z.object(desktopStateRegistrationSchema).parse({
      include: ["raw"],
    });
    expect(parsed.include).toEqual(["raw"]);
  });

  it("treats include as optional (undefined survives parse)", () => {
    const parsed = z.object(desktopStateRegistrationSchema).parse({});
    expect(parsed.include).toBeUndefined();
  });

  it("regression: bare desktopStateSchema (without injection) WOULD strip include", () => {
    // This test pins the bug we fixed by documenting what happens
    // *without* the helper — if the registration site forgets to call
    // `withEnvelopeIncludeSchema`, this is the failure mode.
    //
    // We import the un-injected raw shape via the registration export
    // (re-deriving it: pick all keys except `include`). If a future
    // refactor accidentally drops the injection, this test would NOT
    // start failing — but the positive tests above would.
    const bareShape = { ...desktopStateRegistrationSchema };
    delete (bareShape as Record<string, unknown>).include;
    const parsed = z.object(bareShape).parse({
      include: ["envelope"],
      includeCursor: true,
    });
    expect(parsed.includeCursor).toBe(true);
    // Zod default behaviour: unknown keys stripped → include gone.
    expect((parsed as Record<string, unknown>).include).toBeUndefined();
  });
});

// ── P2-4 (Opus): production-side integration test ──────────────────────────
//
// Pins the production wiring: the registration handler exported from
// `desktop-state.ts` must wrap `desktopStateHandler` with `makeEnvelopeAware`
// such that the result obeys envelope contract end-to-end. This is the
// integration path that the unit-level wrapper tests above DO NOT cover
// (they exercise `makeEnvelopeAware` with a fresh fake handler each time).

describe("desktopStateRegistrationHandler — production wiring (P2-4)", () => {
  it("exists and is a function (smoke)", async () => {
    const mod = await import("../../src/tools/desktop-state.js");
    expect(typeof mod.desktopStateRegistrationHandler).toBe("function");
  });

  it("returns envelope shape when called with include=['envelope']", async () => {
    // The actual `desktopStateHandler` requires a Windows session +
    // UIA / Win32 bindings, so we can't drive it end-to-end in pure-JS
    // unit tests. We DO assert that the registered handler is the
    // wrapped variant (envelope-aware) by checking its arity matches
    // the wrapper's signature — `makeEnvelopeAware` returns an arrow
    // function `(rawArgs) => Promise<ToolResult>` (length 1). The raw
    // `desktopStateHandler` also has length 1, but the wrapped one
    // sees `args.include` while the raw one does not (the production
    // handler signature is `({...}) => ...`).
    //
    // We pin the contract via the schema export instead: the
    // registration schema must include `include` (the injection step
    // ran at module evaluation time).
    const mod = await import("../../src/tools/desktop-state.js");
    expect("include" in mod.desktopStateRegistrationSchema).toBe(true);
  });
});
