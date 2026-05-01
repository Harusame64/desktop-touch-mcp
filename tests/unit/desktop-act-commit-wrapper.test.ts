/**
 * desktop-act-commit-wrapper.test.ts
 *
 * Walking skeleton S4 (ADR-010 P1) G3 contract test suite (8 件 +
 * residual lease-reason mapping pins).
 *
 * Pins the bit-equal contract for `makeCommitWrapper` per
 * `docs/adr-010-p1-s4-plan.md` §3.6 / G3-S4-1〜G3-S4-8:
 *
 *   G3-S4-1  commit wrapper happy path → handler called, both ToolCall events emitted, envelope shape returned
 *   G3-S4-2  lease validation `expired` → most_likely_cause: "LeaseExpired" + try_next: [desktop_discover], handler not called
 *   G3-S4-3  lease ok → handler called, ToolCallStarted carries lease_token, ToolCallCompleted carries elapsed_ms + ok=true
 *   G3-S4-4  handler throws → ToolCallCompleted ok=false + error_code, failure envelope (data:null, confidence:"stale")
 *   G3-S4-5  args_summary truncates JSON.stringify(args) to ≤ 512 bytes (UTF-8)
 *   G3-S4-6  tool_call_id seq is per-session monotone (sessionA:1, sessionA:2, sessionB:1, sessionA:3)
 *   G3-S4-7  query wrapper happy path → no ToolCall events emitted (query-axis), envelope shape returned
 *   G3-S4-8  query wrapper passes lease_token in `data.lease` through to envelope (handler-side issuance, wrapper untouched)
 *
 * Plus residual-reason mapping pins (sub-plan §2.2 + §7 R4): the
 * other 3 LeaseStore reasons map to typed-code-name `Unknown` at
 * runtime (contract pin in `LEASE_REASON_TO_TYPED_CODE` for expansion
 * mechanical-copy).
 *
 * The wrapper accepts an injected `l1Emitter` so tests assert push
 * call shape deterministically without driving the real napi
 * binding (`feedback_pure_parser_for_env_helpers.md` pattern).
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeCommitWrapper,
  makeQueryWrapper,
  mapLeaseValidationToTypedReason,
  truncateJson,
  buildFailureEnvelope,
  nextToolCallId,
  _resetToolCallSeqForTest,
  LEASE_REASON_TO_TYPED_CODE,
  type CommitL1Emitter,
  type L1ToolCallStartedArgs,
  type L1ToolCallCompletedArgs,
} from "../../src/tools/_envelope.js";
import type { LeaseValidationResult } from "../../src/engine/world-graph/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ToolResultLike {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

function makeFakeOk(data: unknown): ToolResultLike {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...(data as Record<string, unknown>) }) }] };
}

function makeFakeFail(error: string, code?: string): ToolResultLike {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ ok: false, error, ...(code ? { code } : {}) }),
    }],
  };
}

function parseResult(r: ToolResultLike): unknown {
  const text = r.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text content");
  return JSON.parse(text);
}

class FakeL1Emitter implements CommitL1Emitter {
  startedCalls: L1ToolCallStartedArgs[] = [];
  completedCalls: L1ToolCallCompletedArgs[] = [];
  pushStarted(args: L1ToolCallStartedArgs): void { this.startedCalls.push(args); }
  pushCompleted(args: L1ToolCallCompletedArgs): void { this.completedCalls.push(args); }
}

const FRESH_WALLCLOCK = 1_738_156_823_412;

// ── Pure helper unit tests ──────────────────────────────────────────────────

describe("LEASE_REASON_TO_TYPED_CODE — contract pin (sub-plan §2.2)", () => {
  it("maps all 4 LeaseStore reasons to PascalCase typed codes", () => {
    expect(LEASE_REASON_TO_TYPED_CODE.expired).toBe("LeaseExpired");
    expect(LEASE_REASON_TO_TYPED_CODE.generation_mismatch).toBe("LeaseGenerationMismatch");
    expect(LEASE_REASON_TO_TYPED_CODE.entity_not_found).toBe("EntityNotFound");
    expect(LEASE_REASON_TO_TYPED_CODE.digest_mismatch).toBe("LeaseDigestMismatch");
  });
});

describe("mapLeaseValidationToTypedReason — runtime path (sub-plan §7 R4)", () => {
  it("expired → LeaseExpired with try_next desktop_discover (S4 trunk full path)", () => {
    const m = mapLeaseValidationToTypedReason("expired");
    expect(m.code).toBe("LeaseExpired");
    expect(m.tryNext).toHaveLength(1);
    expect(m.tryNext[0]).toMatchObject({ action: "desktop_discover", confidence: "high" });
  });
  it("generation_mismatch → Unknown with empty try_next (S4 trunk Unknown fallback)", () => {
    const m = mapLeaseValidationToTypedReason("generation_mismatch");
    expect(m.code).toBe("Unknown");
    expect(m.tryNext).toEqual([]);
  });
  it("entity_not_found → Unknown with empty try_next (S4 trunk)", () => {
    const m = mapLeaseValidationToTypedReason("entity_not_found");
    expect(m.code).toBe("Unknown");
    expect(m.tryNext).toEqual([]);
  });
  it("digest_mismatch → Unknown with empty try_next (S4 trunk)", () => {
    const m = mapLeaseValidationToTypedReason("digest_mismatch");
    expect(m.code).toBe("Unknown");
    expect(m.tryNext).toEqual([]);
  });
});

describe("truncateJson (sub-plan §2.6)", () => {
  it("returns full JSON when within budget", () => {
    const out = truncateJson({ x: 1 }, 512);
    expect(out).toBe('{"x":1}');
  });
  it("truncates with ellipsis when over budget", () => {
    const big = { blob: "x".repeat(2000) };
    const out = truncateJson(big, 512);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(512);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles UTF-8 safely (Japanese 3-byte chars)", () => {
    // 200 hiragana = 600 UTF-8 bytes; budget 100 must safely truncate
    const ja = "あ".repeat(200);
    const out = truncateJson({ s: ja }, 100);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns '{}…' fallback on circular ref", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const out = truncateJson(obj, 512);
    // JSON.stringify on circular throws → fallback "{}" then byte budget OK
    expect(out).toBe("{}");
  });
});

describe("buildFailureEnvelope (sub-plan §2.4)", () => {
  it("emits stale + if_unexpected with most_likely_cause + try_next", () => {
    const e = buildFailureEnvelope(
      "LeaseExpired",
      [{ action: "desktop_discover", args: {}, confidence: "high" }],
      { asOfWallclockMs: FRESH_WALLCLOCK },
    );
    expect(e._version).toBe("1.0");
    expect(e.data).toBeNull();
    expect(e.confidence).toBe("stale");
    expect(e.as_of.wallclock_ms).toBe(FRESH_WALLCLOCK);
    expect(e.if_unexpected?.most_likely_cause).toBe("LeaseExpired");
    expect(e.if_unexpected?.try_next).toHaveLength(1);
  });
  it("falls back to Date.now() when no L1 wallclock (still stale, NOT degraded)", () => {
    const before = Date.now();
    const e = buildFailureEnvelope("Unknown", []);
    const after = Date.now();
    expect(e.confidence).toBe("stale");
    expect(e.as_of.wallclock_ms).toBeGreaterThanOrEqual(before);
    expect(e.as_of.wallclock_ms).toBeLessThanOrEqual(after);
  });
});

describe("nextToolCallId (sub-plan §2.1 + §3.5)", () => {
  it("emits ${sessionId}:${seq} format with monotone seq", () => {
    _resetToolCallSeqForTest();
    expect(nextToolCallId("sess_a")).toBe("sess_a:1");
    expect(nextToolCallId("sess_a")).toBe("sess_a:2");
  });
  it("counters are independent per session", () => {
    _resetToolCallSeqForTest();
    expect(nextToolCallId("sess_a")).toBe("sess_a:1");
    expect(nextToolCallId("sess_b")).toBe("sess_b:1");
    expect(nextToolCallId("sess_a")).toBe("sess_a:2");
    expect(nextToolCallId("sess_b")).toBe("sess_b:2");
  });
});

// ── G3 contract suite (sub-plan §3.6) ──────────────────────────────────────

interface BuildOptions {
  envValue?: string;
  viewPoisoned?: boolean;
  asOfWallclockMs?: number | null;
  validation?: LeaseValidationResult;
  handlerImpl?: (args: Record<string, unknown>) => Promise<ToolResultLike>;
  extractLeaseToken?: boolean;
  sessionId?: string;
  clock?: () => number;
}

function buildCommitWrapped(opts: BuildOptions = {}) {
  const emitter = new FakeL1Emitter();
  const handler =
    opts.handlerImpl ??
    (async () => makeFakeOk({ touched: true }));
  const validator = opts.validation
    ? async () => opts.validation as LeaseValidationResult
    : undefined;
  const wrapped = makeCommitWrapper(handler, "desktop_act", {
    fetchMeta: async () => ({
      viewPoisoned: opts.viewPoisoned ?? false,
      asOfWallclockMs:
        opts.asOfWallclockMs === undefined ? FRESH_WALLCLOCK : opts.asOfWallclockMs,
    }),
    getEnvValue: () => opts.envValue,
    leaseValidator: validator,
    extractLeaseToken: opts.extractLeaseToken
      ? () => ({
          entityId: "ent_1",
          viewId: "view_1",
          targetGeneration: "gen_1",
          evidenceDigestPrefix8: "deadbeef",
        })
      : undefined,
    getSessionId: () => opts.sessionId ?? "sess_test",
    l1Emitter: emitter,
    clock: opts.clock,
  });
  return { wrapped, emitter };
}

describe("makeCommitWrapper — G3 contract test suite (S4 trunk)", () => {
  it("G3-S4-1: happy path emits ToolCallStarted+Completed and returns raw shape (compat default)", async () => {
    _resetToolCallSeqForTest();
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      sessionId: "sess_g3s4_1",
    });
    const result = (await wrapped({ lease: { entityId: "ent_1" } } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed._version).toBeUndefined(); // raw shape (compat hoist)
    expect(emitter.startedCalls).toHaveLength(1);
    expect(emitter.completedCalls).toHaveLength(1);
    expect(emitter.startedCalls[0]?.tool).toBe("desktop_act");
    expect(emitter.startedCalls[0]?.toolCallId).toBe("sess_g3s4_1:1");
    expect(emitter.completedCalls[0]?.ok).toBe(true);
  });

  it("G3-S4-2: lease 'expired' → LeaseExpired + try_next desktop_discover, handler not called", async () => {
    _resetToolCallSeqForTest();
    const handlerSpy = vi.fn(async () => makeFakeOk({}));
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: false, reason: "expired" },
      handlerImpl: handlerSpy,
    });
    const result = (await wrapped({
      include: ["envelope"],
      lease: { entityId: "ent_1" },
    } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeNull();
    expect(parsed.confidence).toBe("stale");
    const ifUnexp = parsed.if_unexpected as { most_likely_cause: string; try_next: unknown[] };
    expect(ifUnexp.most_likely_cause).toBe("LeaseExpired");
    expect(ifUnexp.try_next).toHaveLength(1);
    expect((ifUnexp.try_next[0] as { action: string }).action).toBe("desktop_discover");
    expect(handlerSpy).not.toHaveBeenCalled();
    // Sub-plan §2.1 step 2: handler skipped → no ToolCall events emitted
    expect(emitter.startedCalls).toHaveLength(0);
    expect(emitter.completedCalls).toHaveLength(0);
  });

  it("G3-S4-2b: residual lease reasons → Unknown typed code (sub-plan §7 R4)", async () => {
    for (const reason of ["generation_mismatch", "entity_not_found", "digest_mismatch"] as const) {
      _resetToolCallSeqForTest();
      const { wrapped } = buildCommitWrapped({
        validation: { ok: false, reason },
      });
      const result = (await wrapped({
        include: ["envelope"],
        lease: { entityId: "ent_1" },
      } as never)) as ToolResultLike;
      const parsed = parseResult(result) as Record<string, unknown>;
      const ifUnexp = parsed.if_unexpected as { most_likely_cause: string; try_next: unknown[] };
      expect(ifUnexp.most_likely_cause).toBe("Unknown");
      expect(ifUnexp.try_next).toEqual([]);
    }
  });

  it("G3-S4-3: lease ok → ToolCallStarted carries lease_token, ToolCallCompleted carries elapsed_ms", async () => {
    _resetToolCallSeqForTest();
    let now = 1_000_000;
    const clock = () => {
      const v = now;
      now += 50; // each call advances 50ms — first read pre-handler, second post-handler
      return v;
    };
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      extractLeaseToken: true,
      sessionId: "sess_g3s4_3",
      clock,
    });
    await wrapped({ lease: { entityId: "ent_1" } } as never);
    const started = emitter.startedCalls[0]!;
    expect(started.leaseToken).toEqual({
      entityId: "ent_1",
      viewId: "view_1",
      targetGeneration: "gen_1",
      evidenceDigestPrefix8: "deadbeef",
    });
    expect(started.toolCallId).toBe("sess_g3s4_3:1");
    const completed = emitter.completedCalls[0]!;
    expect(completed.toolCallId).toBe("sess_g3s4_3:1");
    expect(completed.elapsedMs).toBe(50);
    expect(completed.ok).toBe(true);
    expect(completed.errorCode).toBeUndefined();
  });

  it("G3-S4-4: handler throw → ToolCallCompleted ok:false + error_code, failure envelope (stale)", async () => {
    _resetToolCallSeqForTest();
    class MyError extends Error {
      constructor(msg: string) { super(msg); this.name = "ZodError"; }
    }
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      handlerImpl: async () => { throw new MyError("boom"); },
    });
    const result = (await wrapped({
      include: ["envelope"],
      lease: { entityId: "ent_1" },
    } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeNull();
    expect(parsed.confidence).toBe("stale");
    const ifUnexp = parsed.if_unexpected as { most_likely_cause: string };
    expect(ifUnexp.most_likely_cause).toBe("Unknown");
    // ToolCallStarted DID fire (step 4 ran before handler), ToolCallCompleted ok:false
    expect(emitter.startedCalls).toHaveLength(1);
    expect(emitter.completedCalls).toHaveLength(1);
    expect(emitter.completedCalls[0]?.ok).toBe(false);
    expect(emitter.completedCalls[0]?.errorCode).toBe("ZodError");
  });

  it("G3-S4-4b: handler returns {ok:false, code} → ToolCallCompleted ok:false + propagated code", async () => {
    _resetToolCallSeqForTest();
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      handlerImpl: async () => makeFakeFail("element disappeared", "EntityNotFound"),
    });
    await wrapped({ lease: { entityId: "ent_1" } } as never);
    expect(emitter.completedCalls[0]?.ok).toBe(false);
    expect(emitter.completedCalls[0]?.errorCode).toBe("EntityNotFound");
  });

  it("G3-S4-5: args_summary truncates JSON over 512-byte budget", async () => {
    _resetToolCallSeqForTest();
    const big = { blob: "x".repeat(2000), lease: { entityId: "ent_1" } };
    const { wrapped, emitter } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      handlerImpl: async () => makeFakeOk({}),
    });
    await wrapped(big as never);
    const summary = emitter.startedCalls[0]!.argsJson;
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(512);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("G3-S4-6: tool_call_id is per-session monotone across multiple calls", async () => {
    _resetToolCallSeqForTest();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const { wrapped: wrappedA, emitter: emitterA } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
      sessionId: "sess_a",
    });
    const { wrapped: wrappedB, emitter: emitterB } = buildCommitWrapped({
      validation: { ok: true, entity: { entityId: "ent_2" } as never },
      sessionId: "sess_b",
    });
    await wrappedA({ lease: {} } as never); callsA.push(emitterA.startedCalls[0]!.toolCallId);
    await wrappedA({ lease: {} } as never); callsA.push(emitterA.startedCalls[1]!.toolCallId);
    await wrappedB({ lease: {} } as never); callsB.push(emitterB.startedCalls[0]!.toolCallId);
    await wrappedA({ lease: {} } as never); callsA.push(emitterA.startedCalls[2]!.toolCallId);
    expect(callsA).toEqual(["sess_a:1", "sess_a:2", "sess_a:3"]);
    expect(callsB).toEqual(["sess_b:1"]);
  });

  it("env=1 still routes through commit wrapper and returns envelope shape", async () => {
    _resetToolCallSeqForTest();
    const { wrapped } = buildCommitWrapped({
      envValue: "1",
      validation: { ok: true, entity: { entityId: "ent_1" } as never },
    });
    const result = (await wrapped({ lease: { entityId: "ent_1" } } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.data).toBeDefined();
    expect(parsed.confidence).toBe("fresh");
  });

  it("include=['raw'] overrides env=1 even on commit wrapper failure path", async () => {
    _resetToolCallSeqForTest();
    const { wrapped } = buildCommitWrapped({
      envValue: "1",
      validation: { ok: false, reason: "expired" },
    });
    const result = (await wrapped({
      include: ["raw"],
      lease: { entityId: "ent_1" },
    } as never)) as ToolResultLike;
    const parsed = parseResult(result);
    // raw shape: failure envelope flattened to data (= null) at top level —
    // sub-plan §2.5 compat hoist: envelope.data is hoisted, so a failure
    // envelope (data: null) becomes literal `null` in raw mode. Existing
    // LLM clients that expect raw shape see the same null they would have
    // gotten from a failure result before envelope rollout, while
    // include=['envelope'] callers see the typed `if_unexpected` shape.
    expect(parsed).toBeNull();
  });

  it("lease validator omitted (lease-less commit) → no validation, handler called directly", async () => {
    _resetToolCallSeqForTest();
    const handlerSpy = vi.fn(async () => makeFakeOk({}));
    const emitter = new FakeL1Emitter();
    const wrapped = makeCommitWrapper(handlerSpy, "click_element", {
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
      getEnvValue: () => undefined,
      // no leaseValidator — sub-plan §1.2 lease-less commit variant
      l1Emitter: emitter,
    });
    await wrapped({ name: "Save" } as never);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(emitter.startedCalls).toHaveLength(1);
    expect(emitter.startedCalls[0]?.leaseToken).toBeUndefined();
    expect(emitter.completedCalls).toHaveLength(1);
  });
});

describe("makeQueryWrapper — G3 contract test suite (S4 trunk)", () => {
  it("G3-S4-7: query wrapper happy path emits envelope without ToolCall events", async () => {
    _resetToolCallSeqForTest();
    // The query wrapper delegates to makeEnvelopeAware (no ToolCall
    // events). We assert envelope shape AND that the wrapper didn't
    // emit anything to L1 — there is no l1Emitter option on the
    // query wrapper, so the assertion is structural: the result is
    // simply an envelope.
    const handler = async () => makeFakeOk({ entities: ["a", "b"] });
    const wrapped = makeQueryWrapper(handler, "desktop_discover", {
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
      getEnvValue: () => undefined,
    });
    const result = (await wrapped({ include: ["envelope"] } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed._version).toBe("1.0");
    expect(parsed.confidence).toBe("fresh");
    expect((parsed.data as { ok: boolean }).ok).toBe(true);
  });

  it("G3-S4-8: query wrapper passes lease_token in handler-emitted data through to envelope", async () => {
    _resetToolCallSeqForTest();
    // Handler-side issuance is unchanged from before S4: the query
    // wrapper does NOT emit lease_token on its own; whatever the
    // handler returns flows through `data` after envelope wrap.
    const handler = async () => makeFakeOk({
      lease_token: { entityId: "ent_1", viewId: "view_1" },
      entities: [{ entityId: "ent_1" }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_discover", {
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK }),
      getEnvValue: () => undefined,
    });
    const result = (await wrapped({ include: ["envelope"] } as never)) as ToolResultLike;
    const parsed = parseResult(result) as Record<string, unknown>;
    const data = parsed.data as { lease_token: { entityId: string } };
    expect(data.lease_token).toEqual({ entityId: "ent_1", viewId: "view_1" });
  });
});
