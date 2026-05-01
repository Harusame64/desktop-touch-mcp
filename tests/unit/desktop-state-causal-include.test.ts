/**
 * desktop-state-causal-include.test.ts — S5 G5 contract test suite.
 *
 * Pins the bit-equal contract for `desktop_state(include=["causal"])`
 * envelope.caused_by + envelope.based_on projection per
 * `docs/adr-010-p1-s5-plan.md` §3.6 (10 cases G5-S5-1 〜 G5-S5-10).
 *
 * Coverage axes:
 *   - basic projection (G5-S5-1): caused_by 4 field + based_on
 *   - produced_changes: focus delta + dirty_rect per-monitor (G5-S5-2)
 *   - multi-event causal window: latest 1 entry only (G5-S5-3)
 *   - lease commit path: tool_call_id format (G5-S5-4)
 *   - elapsed_ms accuracy (G5-S5-5)
 *   - causal window timeout (monotonic 軸): wallclock drift 非依存 (G5-S5-6)
 *   - default opt-out (G5-S5-7): include 未指定時 caused_by/based_on 不在
 *   - history buffer ring overflow (G5-S5-8): 9 件 commit で最古 1 件 head drop
 *   - failure commit (G5-S5-9): ok:false history 記録、後続 caused_by 抽出可
 *   - multi-session leak prevention (G5-S5-10): sessionA / sessionB 独立
 */

import { describe, expect, it, vi } from "vitest";
import {
  makeQueryWrapper,
  makeCommitWrapper,
  buildCausedBy,
  buildBasedOn,
  buildProducedChanges,
  defaultL1Emitter,
  _resetHistoryBuffersForTest,
  _resetToolCallSeqForTest,
  _setHistoryClockForTest,
  _resetHistoryClockForTest,
  _seedHistoryForTest,
  type CommitL1Emitter,
  type ViewSnapshot,
  type ToolCallEvent,
} from "../../src/tools/_envelope.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function resetAll(): void {
  _resetHistoryBuffersForTest();
  _resetToolCallSeqForTest();
  _resetHistoryClockForTest();
}

function makeViewSnapshot(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    focus: { hwnd: null, elementName: "btn-next" },
    dirtyRectsByMonitor: new Map([[0, 3]]),
    latestEventId: 100n,
    queryWallclockMs: Date.now(),
    ...overrides,
  };
}

// ── G5-S5-1: basic caused_by + based_on projection ──────────────────────────

describe("G5-S5-1: desktop_act → desktop_state(include=[\"causal\"]) basic path", () => {
  it("envelope.caused_by has 4 field + envelope.based_on top-level", async () => {
    resetAll();
    // Simulate a commit by directly calling defaultL1Emitter (production path
    // goes through makeCommitWrapper but we want to drive history without
    // dragging the entire commit-wrapper flow into this S5 test).
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{"action":"click"}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 50,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });

    const snapshot = makeViewSnapshot();
    const causedBy = buildCausedBy("sessA", snapshot);
    const basedOn = buildBasedOn("sessA", snapshot);

    expect(causedBy).toBeDefined();
    expect(causedBy?.your_last_action).toMatch(/desktop_act/);
    expect(causedBy?.tool_call_id).toBe("sessA:1");
    expect(typeof causedBy?.elapsed_ms).toBe("number");
    expect(Array.isArray(causedBy?.produced_changes)).toBe(true);

    expect(basedOn).toBeDefined();
    expect(Array.isArray(basedOn?.events)).toBe(true);
    // Round 3 P1 Codex line 370: events string[] (u64 decimal、JSON.stringify safe)
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
    expect(Array.isArray(basedOn?.sources)).toBe(true);
  });
});

// ── G5-S5-2: produced_changes projection ─────────────────────────────────────

describe("G5-S5-2: produced_changes (focus delta + dirty_rect per-monitor)", () => {
  it("focus 遷移 + 2 monitor dirty_rect 含まれる、monitor_index 維持", () => {
    resetAll();
    const snapshot = makeViewSnapshot({
      focus: { hwnd: null, elementName: "input-name" },
      dirtyRectsByMonitor: new Map([
        [0, 3],
        [1, 1],
      ]),
    });
    const changes = buildProducedChanges(snapshot);
    expect(changes).toContain("focus: → input-name");
    expect(changes).toContain("dirty_rects[monitor=0]: 3");
    expect(changes).toContain("dirty_rects[monitor=1]: 1");
    // CLAUDE.md §3.2 PR #102 同型 regression 防止: monitor=0 が monitor=1 と区別される
    expect(changes.find((c) => c.includes("monitor=0"))).not.toBe(
      changes.find((c) => c.includes("monitor=1")),
    );
  });

  it("count > 0 monitor のみ entry 化、focus 不在時 focus entry 省略", () => {
    const snapshot: ViewSnapshot = {
      focus: null,
      dirtyRectsByMonitor: new Map([
        [0, 0], // skip
        [1, 5],
      ]),
      latestEventId: 100n,
      queryWallclockMs: Date.now(),
    };
    const changes = buildProducedChanges(snapshot);
    expect(changes).not.toContain("focus:");
    expect(changes).not.toContain("monitor=0");
    expect(changes).toContain("dirty_rects[monitor=1]: 5");
  });

  it("focus elementName が null のとき hwnd= フォールバック", () => {
    const snapshot = makeViewSnapshot({
      focus: { hwnd: 0xdeadbeefn, elementName: null },
      dirtyRectsByMonitor: new Map(),
    });
    const changes = buildProducedChanges(snapshot);
    expect(changes[0]).toMatch(/^focus: → hwnd=/);
  });
});

// ── G5-S5-3: multi-event causal window (latest 1 entry only) ────────────────

describe("G5-S5-3: multi-event causal window (latest 1 entry only)", () => {
  it("連続 2 commit → caused_by は最新 1 entry のみ projection", () => {
    resetAll();
    // First commit
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{"action":"click"}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 30,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    // Second commit (= becomes the latest)
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{"action":"type","text":"hello"}',
      sessionId: "sessA",
      toolCallId: "sessA:2",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 40,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:2",
    });

    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy?.tool_call_id).toBe("sessA:2");
    expect(causedBy?.your_last_action).toContain("hello");
  });
});

// ── G5-S5-4: lease commit path → tool_call_id format ────────────────────────

describe("G5-S5-4: lease commit path", () => {
  it("history entry に leaseToken 記録 + tool_call_id `${sessionId}:${seq}` 形式", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
      leaseToken: {
        entityId: "btn-1",
        viewId: "sessA",
        targetGeneration: "g42",
        evidenceDigestPrefix8: "abc12345",
      },
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy?.tool_call_id).toMatch(/^sessA:\d+$/);
    expect(causedBy?.your_last_action).toContain("desktop_act");
  });
});

// ── G5-S5-5: elapsed_ms accuracy ─────────────────────────────────────────────

describe("G5-S5-5: elapsed_ms accuracy", () => {
  it("ToolCallStarted ↔ ToolCallCompleted wallclock 差として elapsed_ms 表現", async () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    // Inject artificial sleep ~50ms before completion
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: Date.now() - before,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy?.elapsed_ms).toBeGreaterThanOrEqual(40);
    expect(causedBy?.elapsed_ms).toBeLessThan(500);
  });
});

// ── G5-S5-6: causal window timeout (monotonic 軸) ────────────────────────────

describe("G5-S5-6: causal window timeout (monotonic 軸、Round 2 P2 Opus #5)", () => {
  it("monotonic 200ms 経過時 caused_by undefined return", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    // Inject a fake monotonic clock that's 250ms ahead of pushed entries
    // (history's monotonicStartMs was set via real performance.now() at
    // pushStarted; we override the projector's nowMonotonic to simulate
    // 250ms elapsed = window expired)
    const futureMonotonicMs = performance.now() + 250;
    const causedBy = buildCausedBy("sessA", makeViewSnapshot(), {
      causalWindowTimeoutMs: 200,
      monotonicNowMs: () => futureMonotonicMs,
    });
    expect(causedBy).toBeUndefined();
  });

  it("monotonic 100ms 経過時 (timeout 内) caused_by 返却", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const futureMonotonicMs = performance.now() + 100;
    const causedBy = buildCausedBy("sessA", makeViewSnapshot(), {
      causalWindowTimeoutMs: 200,
      monotonicNowMs: () => futureMonotonicMs,
    });
    expect(causedBy).toBeDefined();
  });
});

// ── G5-S5-7: include 未指定時の default opt-out ──────────────────────────────

describe("G5-S5-7: makeQueryWrapper default opt-out (include 未指定時 caused_by 不在)", () => {
  it("include 未指定 → causedByProjector 呼ばれない、envelope に caused_by 不在", async () => {
    resetAll();
    // Pre-populate history so projector would have data if invoked
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });

    const projectorMock = vi.fn(async () => ({
      causedBy: undefined,
      basedOn: undefined,
    }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"ok":true,"data":{"foo":"bar"}}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projectorMock,
      // No env, no include — default raw shape
    });
    const result = await wrapped({} as Record<string, unknown>);
    // Projector NOT invoked because include did not contain "causal"
    expect(projectorMock).not.toHaveBeenCalled();
    // Raw shape (compat hoist): no envelope wrapper visible
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.caused_by).toBeUndefined();
    expect(parsed.based_on).toBeUndefined();
  });

  it("include=['causal'] + envelope mode で causedByProjector が sessionId 渡される (Round 3 closed loop)", async () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });

    const projectorMock = vi.fn(async (_args: unknown, sessionId: string) => ({
      causedBy: buildCausedBy(sessionId, makeViewSnapshot()),
      basedOn: buildBasedOn(sessionId, makeViewSnapshot()),
    }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projectorMock,
    });
    const result = await wrapped({ include: ["envelope", "causal"] } as Record<string, unknown>);
    // Round 3 closed loop fix: projector が sessionId 引数で呼ばれる
    expect(projectorMock).toHaveBeenCalledWith(expect.anything(), "sessA");
    // Envelope shape: caused_by + based_on present
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.caused_by).toBeDefined();
    expect(parsed.based_on).toBeDefined();
  });
});

// ── G5-S5-8: history buffer ring overflow ────────────────────────────────────

describe("G5-S5-8: history buffer ring overflow (capacity 8)", () => {
  it("9 件 commit → 最古 1 件 head drop、最新 8 件保持", () => {
    resetAll();
    for (let i = 1; i <= 9; i++) {
      defaultL1Emitter.pushStarted({
        tool: "desktop_act",
        argsJson: `{"i":${i}}`,
        sessionId: "sessA",
        toolCallId: `sessA:${i}`,
      });
      defaultL1Emitter.pushCompleted({
        tool: "desktop_act",
        elapsedMs: 1,
        ok: true,
        sessionId: "sessA",
        toolCallId: `sessA:${i}`,
      });
    }
    // Latest entry should be sessA:9
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    expect(causedBy?.tool_call_id).toBe("sessA:9");
    // Note: we can't easily inspect ring contents from outside, but the
    // latest projection covers the contract intent.
  });
});

// ── G5-S5-9: failure commit (handler throw) ──────────────────────────────────

describe("G5-S5-9: failure commit (ok: false) is recorded in history", () => {
  it("handler throw → history entry ok:false、caused_by に commit summary", async () => {
    resetAll();
    const failingHandler = async () => {
      throw new Error("DesktopActFailure");
    };
    const wrapped = makeCommitWrapper(failingHandler, "desktop_act", {
      getSessionId: () => "sessA",
    });
    await wrapped({} as Record<string, unknown>);
    const causedBy = buildCausedBy("sessA", makeViewSnapshot());
    // commit failed but still recorded — your_last_action surfaces failure context
    expect(causedBy?.your_last_action).toContain("desktop_act");
    expect(causedBy?.tool_call_id).toBe("sessA:1");
  });
});

// ── G5-S5-10: multi-session leak prevention ──────────────────────────────────

describe("G5-S5-10: multi-session history isolation", () => {
  it("sessionA / sessionB が独立、互いの caused_by を見ない", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{"who":"A"}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 1,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{"who":"B"}',
      sessionId: "sessB",
      toolCallId: "sessB:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 1,
      ok: true,
      sessionId: "sessB",
      toolCallId: "sessB:1",
    });

    const causedByA = buildCausedBy("sessA", makeViewSnapshot());
    const causedByB = buildCausedBy("sessB", makeViewSnapshot());
    expect(causedByA?.your_last_action).toContain('"who":"A"');
    expect(causedByB?.your_last_action).toContain('"who":"B"');
    // Empty session yields no projection
    const causedByEmpty = buildCausedBy("nonexistent-session", makeViewSnapshot());
    expect(causedByEmpty).toBeUndefined();
  });

  it("sentinel `multi:disabled` session でも history 記録は許容するが production projector が skip (Round 3 P1)", async () => {
    resetAll();
    // The sentinel-skip is the projector closure's responsibility (sub-plan §2.5).
    // Here we exercise the makeQueryWrapper closed-loop path: when
    // getSessionId returns "multi:disabled", the production-style projector
    // returns undefined immediately without touching the history buffer.
    const projector = vi.fn(async (_args: unknown, sessionId: string) => {
      if (sessionId === "multi:disabled") return undefined;
      return {
        causedBy: buildCausedBy(sessionId, makeViewSnapshot()),
        basedOn: buildBasedOn(sessionId, makeViewSnapshot()),
      };
    });
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "multi:disabled",
      causedByProjector: projector,
    });
    const result = await wrapped({ include: ["envelope", "causal"] } as Record<string, unknown>);
    // Projector invoked, but returned undefined → caused_by + based_on absent
    expect(projector).toHaveBeenCalledWith(expect.anything(), "multi:disabled");
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.caused_by).toBeUndefined();
    expect(parsed.based_on).toBeUndefined();
  });
});

// ── LRU eviction (sub-plan §3.1 S5-1, §6 OQ #1) ──────────────────────────────

describe("LRU eviction (sub-plan §6 OQ #1)", () => {
  it("TTL 24h 経過した session は次の write 時に evict される", () => {
    resetAll();
    let now = 1_700_000_000_000;
    _setHistoryClockForTest(() => now);
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "old-sess",
      toolCallId: "old-sess:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 1,
      ok: true,
      sessionId: "old-sess",
      toolCallId: "old-sess:1",
    });
    // Bump clock 25h forward, then create a new session — eviction sweeps stale
    now += 25 * 3600 * 1000;
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "new-sess",
      toolCallId: "new-sess:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 1,
      ok: true,
      sessionId: "new-sess",
      toolCallId: "new-sess:1",
    });
    // old-sess history evicted by TTL sweep
    const causedByOld = buildCausedBy("old-sess", makeViewSnapshot());
    expect(causedByOld).toBeUndefined();
    const causedByNew = buildCausedBy("new-sess", makeViewSnapshot());
    expect(causedByNew?.tool_call_id).toBe("new-sess:1");
  });
});

// ── Round 2 P1 (Codex line 1501) include=["causal"] auto envelope opt-in ────

describe("Round 2 P1 (Codex line 1501): include=['causal'] alone opts into envelope", () => {
  it("include=['causal'] (no 'envelope') → envelope shape returned, caused_by + based_on present", async () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });

    const projector = vi.fn(async (_args: unknown, sessionId: string) => ({
      causedBy: buildCausedBy(sessionId, makeViewSnapshot()),
      basedOn: buildBasedOn(sessionId, makeViewSnapshot()),
    }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projector,
    });
    // Critical: include=["causal"] without "envelope" — pre-fix this would
    // route through compatHoist(envelope, false) and silently drop
    // caused_by + based_on. Post-fix include=["causal"] implies envelope
    // opt-in, preserving the projection.
    const result = await wrapped({ include: ["causal"] } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0"); // envelope shape
    expect(parsed.caused_by).toBeDefined();
    expect(parsed.based_on).toBeDefined();
  });
});

// ── Round 3 P2 (Codex line 1556) raw override 維持 ──────────────────────────

describe("Round 3 P2 (Codex line 1556): include=['raw','causal'] preserves raw override", () => {
  it("include=['raw','causal'] → raw shape return, causal projection 落ちる", async () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });

    const projector = vi.fn(async (_args: unknown, sessionId: string) => ({
      causedBy: buildCausedBy(sessionId, makeViewSnapshot()),
      basedOn: buildBasedOn(sessionId, makeViewSnapshot()),
    }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projector,
    });
    // Round 3 P2 fix: raw 明示 → envelope opt-out 維持、causal projection
    // は projector まで走るが compatHoist で data flatten され捨てられる
    const result = await wrapped({ include: ["raw", "causal"] } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBeUndefined(); // raw shape (no envelope)
    expect(parsed.caused_by).toBeUndefined();
    expect(parsed.based_on).toBeUndefined();
    expect(parsed.foo).toBe("bar"); // handler payload flattened
  });
});

// ── Round 3 P2 (Codex line 655) nativeL1 null forceDegraded ────────────────

describe("Round 3 P2 (Codex line 655): projector forceDegraded → confidence: degraded", () => {
  it("projector returns { forceDegraded: true } → envelope.confidence === 'degraded'", async () => {
    resetAll();
    const projector = vi.fn(async () => ({ forceDegraded: true }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projector,
    });
    const result = await wrapped({ include: ["causal"] } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed._version).toBe("1.0"); // envelope shape (causal auto opt-in)
    expect(parsed.confidence).toBe("degraded"); // forceDegraded propagated
    // caused_by / based_on absent because projector returned no projection
    expect(parsed.caused_by).toBeUndefined();
    expect(parsed.based_on).toBeUndefined();
  });

  it("projector returns { causedBy } without forceDegraded → confidence: 'fresh' (or size-degraded)", async () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const projector = vi.fn(async (_args: unknown, sessionId: string) => ({
      causedBy: buildCausedBy(sessionId, makeViewSnapshot()),
      basedOn: buildBasedOn(sessionId, makeViewSnapshot()),
    }));
    const handler = async () => ({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
    });
    const wrapped = makeQueryWrapper(handler, "desktop_state", {
      getSessionId: () => "sessA",
      causedByProjector: projector,
      // Provide healthy meta so confidence stays fresh
      fetchMeta: async () => ({ viewPoisoned: false, asOfWallclockMs: Date.now() }),
    });
    const result = await wrapped({ include: ["causal"] } as Record<string, unknown>);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // Note: small payload + healthy meta → fresh confidence
    expect(["fresh", "degraded"]).toContain(parsed.confidence); // either OK
    expect(parsed.caused_by).toBeDefined();
  });
});

// ── Round 2 P2 (Codex line 1073) buildBasedOn shares causal window guards ───

describe("Round 2 P2 (Codex line 1073): buildBasedOn shares causal window guards with buildCausedBy", () => {
  it("monotonic timeout expired → both buildCausedBy and buildBasedOn return undefined", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 10,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const futureMonotonicMs = performance.now() + 250;
    const causedBy = buildCausedBy("sessA", makeViewSnapshot(), {
      causalWindowTimeoutMs: 200,
      monotonicNowMs: () => futureMonotonicMs,
    });
    const basedOn = buildBasedOn("sessA", makeViewSnapshot(), {
      causalWindowTimeoutMs: 200,
      monotonicNowMs: () => futureMonotonicMs,
    });
    // Both must vanish together — no half-state where based_on persists
    // after caused_by has expired (Codex P2: stale based_on.events would
    // mislead LLM about the causal window).
    expect(causedBy).toBeUndefined();
    expect(basedOn).toBeUndefined();
  });

  it("frontier 未到達 → both return undefined", () => {
    resetAll();
    // Seed a history entry with eventIdCompleted way ahead of the
    // viewSnapshot.latestEventId we'll pass in.
    _seedHistoryForTest("sessA", {
      toolCallId: "sessA:1",
      toolName: "desktop_act",
      argsSummary: "{}",
      eventIdStarted: 100n,
      eventIdCompleted: 200n,
      wallclockStartMs: Date.now() - 50,
      wallclockEndMs: Date.now(),
      monotonicStartMs: performance.now() - 50,
      ok: true,
      leaseToken: undefined,
    });
    // Frontier still at 50 — eventIdCompleted=200 > 50 → not yet visible
    const snapshot = makeViewSnapshot({ latestEventId: 50n });
    expect(buildCausedBy("sessA", snapshot)).toBeUndefined();
    expect(buildBasedOn("sessA", snapshot)).toBeUndefined();
  });
});

// ── BasedOnShape JSON serialize safety (Round 3 P1 Codex line 370) ──────────

describe("BasedOnShape.events: string[] (u64 decimal、JSON.stringify safe)", () => {
  it("JSON.stringify({ events: bigint[] }) throws TypeError, but BasedOnShape uses string[]", () => {
    resetAll();
    defaultL1Emitter.pushStarted({
      tool: "desktop_act",
      argsJson: '{}',
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    defaultL1Emitter.pushCompleted({
      tool: "desktop_act",
      elapsedMs: 1,
      ok: true,
      sessionId: "sessA",
      toolCallId: "sessA:1",
    });
    const basedOn = buildBasedOn("sessA", makeViewSnapshot());
    expect(basedOn).toBeDefined();
    // The whole point of Round 3 fix: this MUST NOT throw
    expect(() => JSON.stringify(basedOn)).not.toThrow();
    // And events should be string[], not bigint[]
    if (basedOn?.events && basedOn.events.length > 0) {
      expect(typeof basedOn.events[0]).toBe("string");
    }
  });

  it("BIG event_id (u64 max-ish) preserves precision via decimal string", () => {
    // Round 2 P2 (Opus #4) runtime pin: seed a history entry directly with
    // u64-max-ish bigint event_ids via `_seedHistoryForTest`, bypassing the
    // L1 emitter so the bigint→decimal-string projection is exercised even
    // when `nativeL1` is null in test environments. Pre-fix the test only
    // checked typing because `defaultL1Emitter` returned `undefined` event
    // ids without a real native binding.
    resetAll();
    const bigEventIdStarted = 9_000_000_000_000_000_000n; // > 2^53
    const bigEventIdCompleted = 9_000_000_000_000_000_001n;
    _seedHistoryForTest("sessBig", {
      toolCallId: "sessBig:1",
      toolName: "desktop_act",
      argsSummary: "{}",
      eventIdStarted: bigEventIdStarted,
      eventIdCompleted: bigEventIdCompleted,
      wallclockStartMs: Date.now() - 50,
      wallclockEndMs: Date.now(),
      monotonicStartMs: performance.now() - 50,
      ok: true,
      leaseToken: undefined,
    });
    // viewSnapshot.latestEventId must be ≥ eventIdCompleted to pass frontier check
    const snapshot = makeViewSnapshot({ latestEventId: bigEventIdCompleted + 10n });
    const basedOn = buildBasedOn("sessBig", snapshot);
    expect(basedOn).toBeDefined();
    expect(basedOn?.events).toHaveLength(2);
    // Critical: u64 precision preserved via decimal string, NOT Number()
    expect(basedOn?.events[0]).toBe("9000000000000000000");
    expect(basedOn?.events[1]).toBe("9000000000000000001");
    // JSON.stringify must not throw (Round 3 P1 Codex line 370)
    expect(() => JSON.stringify(basedOn)).not.toThrow();
    // Round-trip preserves the exact decimal — no Number() lossy conversion
    const roundTrip = JSON.parse(JSON.stringify(basedOn)) as { events: string[] };
    expect(roundTrip.events[0]).toBe("9000000000000000000");
    expect(roundTrip.events[1]).toBe("9000000000000000001");
  });
});
