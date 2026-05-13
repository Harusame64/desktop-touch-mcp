// ADR-017 — TS-layer classifier + locked heuristic for `desktop_state`'s
// optional `sessionContext` block. The native bindings are exercised by
// `native-win32-panic-fuzz.test.ts`; this suite drives the pure functions
// (`classifySessionContext`, `mapWtsStateToSessionState`) with synthetic
// inputs so every branch of the heuristic is covered without depending on
// the actual host's session state.

import { describe, expect, it, beforeEach } from "vitest";
import {
  classifySessionContext,
  mapWtsStateToSessionState,
  _resetSessionLockCacheForTest,
} from "../../src/tools/desktop-state.js";

describe("ADR-017: mapWtsStateToSessionState", () => {
  // Maps the 10 documented WTS_CONNECTSTATE_CLASS labels into the 4
  // happy-path sessionState values (`active` / `connected` /
  // `disconnected`) plus the catch-all `unknown` bucket. The locked
  // heuristic is layered on top by `classifySessionContext`; this helper
  // never emits `'locked'` directly.
  it("'active' label → 'active'", () => {
    expect(mapWtsStateToSessionState("active")).toBe("active");
  });

  it("'connected' label → 'connected'", () => {
    expect(mapWtsStateToSessionState("connected")).toBe("connected");
  });

  it("'disconnected' label → 'disconnected'", () => {
    expect(mapWtsStateToSessionState("disconnected")).toBe("disconnected");
  });

  it("'connect_query' label → 'unknown'", () => {
    // ConnectQuery is a transient state and has no useful LLM interpretation
    // — group with 'unknown' rather than misrepresent.
    expect(mapWtsStateToSessionState("connect_query")).toBe("unknown");
  });

  it.each([
    ["shadow"],
    ["idle"],
    ["listen"],
    ["reset"],
    ["down"],
    ["init"],
  ])("'%s' label → 'unknown'", (label) => {
    expect(mapWtsStateToSessionState(label)).toBe("unknown");
  });

  it("future Windows enum value (state_42) → 'unknown'", () => {
    // The native side surfaces unknown numerics as `state_<n>`; the
    // classifier must collapse all of these to 'unknown' rather than crash.
    expect(mapWtsStateToSessionState("state_42")).toBe("unknown");
  });
});

describe("ADR-017: classifySessionContext — sessionLabel", () => {
  const NO_PREV = null;
  const NOW = 1_700_000_000_000;
  const ACTIVE_ROW = { winStation: "Console", stateLabel: "active" };

  it("ownSessionId === consoleSessionId → 'console'", () => {
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: ACTIVE_ROW,
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.sessionLabel).toBe("console");
  });

  it("RDP-Tcp winStation → 'rdp' (consoleSessionId differs)", () => {
    const ctx = classifySessionContext({
      ownSessionId: 5,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "RDP-Tcp#0", stateLabel: "active" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.sessionLabel).toBe("rdp");
  });

  it("RDP-Tcp winStation matches even with #N suffix", () => {
    // The matrix in §3 of the RDP behaviour doc records win-station names
    // like "RDP-Tcp#42". The regex must accept the suffix.
    const ctx = classifySessionContext({
      ownSessionId: 7,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "RDP-Tcp#42", stateLabel: "active" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.sessionLabel).toBe("rdp");
  });

  it("non-console + non-RDP winStation → 'other'", () => {
    const ctx = classifySessionContext({
      ownSessionId: 3,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Services", stateLabel: "disconnected" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.sessionLabel).toBe("other");
  });

  it("consoleSessionIdRaw=0xFFFFFFFF → consoleSessionId null AND label not 'console'", () => {
    // Win32 sentinel: no user signed in at the physical console. Even
    // when ownSessionId happens to equal 0xFFFFFFFF (vanishingly unlikely
    // but possible on a corrupted runner), the classifier must NOT call
    // that session "console". Surface via `null` instead.
    const ctx = classifySessionContext({
      ownSessionId: 8,
      consoleSessionIdRaw: 0xffff_ffff,
      ownWtsRow: ACTIVE_ROW,
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.consoleSessionId).toBeNull();
    expect(ctx.sessionLabel).not.toBe("console");
  });

  it("ownWtsRow=null → 'other' AND state='unknown'", () => {
    // WTSEnumerateSessions failed (locked-down corporate token). The
    // classifier must surface 'unknown' rather than fabricate a label.
    const ctx = classifySessionContext({
      ownSessionId: 5,
      consoleSessionIdRaw: 1,
      ownWtsRow: null,
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: NO_PREV,
    });
    expect(ctx.sessionLabel).toBe("other");
    expect(ctx.sessionState).toBe("unknown");
    expect(ctx.ownWinStation).toBe("");
  });
});

describe("ADR-017: classifySessionContext — sessionState + locked heuristic", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    _resetSessionLockCacheForTest();
  });

  it("active + foreground present → 'active' (no heuristic trigger)", () => {
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 1000, foregroundHwnd: 12345n },
    });
    expect(ctx.sessionState).toBe("active");
  });

  it("disconnected → 'disconnected' (heuristic does not override non-active)", () => {
    const ctx = classifySessionContext({
      ownSessionId: 3,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "RDP-Tcp#1", stateLabel: "disconnected" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 1000, foregroundHwnd: 12345n },
    });
    expect(ctx.sessionState).toBe("disconnected");
  });

  it("active + foreground null + no prior sample → 'active' (heuristic conservative)", () => {
    // First call in a session: even if foreground is null, we have no
    // prior sample to confirm a NULL transition. Conservative: stay active.
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: null,
    });
    expect(ctx.sessionState).toBe("active");
  });

  it("active + foreground null + prior sample also null → 'active' (always-NULL is not lock)", () => {
    // Locked detection only fires on TRANSITION. A session that has been
    // continuously NULL is likely a session-start race or an LLM that
    // somehow lost foreground tracking, not a lock event.
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 1000, foregroundHwnd: null },
    });
    expect(ctx.sessionState).toBe("active");
  });

  it("active + foreground null + prior non-null within 60s → 'locked'", () => {
    // The 3-of-3 condition for the locked heuristic. Two seconds since the
    // last sample is well inside the 60s freshness window.
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 2_000, foregroundHwnd: 12345n },
    });
    expect(ctx.sessionState).toBe("locked");
  });

  it("active + foreground null + prior non-null but >60s old → 'active' (stale prior, do not infer lock)", () => {
    // Stale prior sample: the LLM hasn't called `desktop_state` for over a
    // minute. We can't safely call this a "lock event" because so much
    // could have happened. Fall back to 'active'.
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 90_000, foregroundHwnd: 12345n },
    });
    expect(ctx.sessionState).toBe("active");
  });

  it("active + foreground null + prior non-null at exactly 60s → 'locked' (inclusive edge)", () => {
    // The 60s boundary is inclusive per the implementation (`<= 60_000`).
    // Pin the edge so future refactors don't drift it.
    const ctx = classifySessionContext({
      ownSessionId: 1,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "Console", stateLabel: "active" },
      foregroundHwnd: null,
      nowMs: NOW,
      previousSample: { wallclockMs: NOW - 60_000, foregroundHwnd: 12345n },
    });
    expect(ctx.sessionState).toBe("locked");
  });

  it("origin is always { kind: 'local', sessionId: own }", () => {
    // ADR-017 §3.3 forward-compat with ADR-016 Phase 3 Origin variants:
    // current local case must emit the discriminated-union shape so the
    // future RDP variant can be added without breaking consumers.
    const ctx = classifySessionContext({
      ownSessionId: 42,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "RDP-Tcp#0", stateLabel: "active" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: null,
    });
    expect(ctx.origin).toEqual({ kind: "local", sessionId: 42 });
  });

  it("ownWinStation echoes the WTS row's winStation field", () => {
    const ctx = classifySessionContext({
      ownSessionId: 5,
      consoleSessionIdRaw: 1,
      ownWtsRow: { winStation: "RDP-Tcp#0", stateLabel: "active" },
      foregroundHwnd: 12345n,
      nowMs: NOW,
      previousSample: null,
    });
    expect(ctx.ownWinStation).toBe("RDP-Tcp#0");
  });
});
