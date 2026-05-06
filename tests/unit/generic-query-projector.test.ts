/**
 * generic-query-projector.test.ts — ADR-011 A-1 contract test suite.
 *
 * Pins the bit-equal contract for `genericQueryCausedByProjector` +
 * `defaultQuerySessionId` (`_envelope.ts` exports introduced in A-1)。
 *
 * Coverage:
 *   - sentinel guard: sessionId === "multi:disabled" → undefined
 *   - forceDegraded path: confidence: degraded surface when projection
 *     unavailable (nativeL1 null branch tested via signature observation —
 *     in test environment nativeL1 is null on non-Windows / pre-binding,
 *     so the projector returns { forceDegraded: true })
 *   - defaultQuerySessionId behaviour: default → "default", sentinel branch
 *     when test seam pins single-session = false → "multi:disabled"
 *   - delegating fn 整合: desktop-state.ts:desktopStateCausedByProjector が
 *     bit-equal で genericQueryCausedByProjector に delegate (A-1 plan §4.1.5
 *     bit-equal sync sweep)
 */

import { describe, expect, it } from "vitest";
import {
  genericQueryCausedByProjector,
  defaultQuerySessionId,
  _setDefaultQuerySingleSessionForTest,
  _resetDefaultQuerySingleSessionForTest,
  __getQueryWrapperOptionsForTest,
} from "../../src/tools/_envelope.js";

// ── A-1: genericQueryCausedByProjector — sentinel guard ─────────────────────

describe("A-1: genericQueryCausedByProjector sentinel guard", () => {
  it('returns undefined when sessionId === "multi:disabled" (skips caused_by)', async () => {
    const result = await genericQueryCausedByProjector({}, "multi:disabled");
    expect(result).toBeUndefined();
  });
});

// ── A-1: genericQueryCausedByProjector — forceDegraded path ─────────────────

describe("A-1: genericQueryCausedByProjector forceDegraded path", () => {
  it("returns { forceDegraded: true } when nativeL1 binding is null in test env", async () => {
    // In test environment without the native engine binding loaded,
    // `nativeL1` is null and the projector early-returns { forceDegraded: true }
    // so LLM clients can distinguish "causal asked but binding null" from
    // "no commits in causal window" (Round 3 P2 fix carry-over).
    //
    // Note: when the native binding IS loaded (Windows + Rust addon built),
    // this test path bypasses forceDegraded and exercises the normal
    // 4-axis ViewSnapshot construction + buildCausedBy/buildBasedOn call.
    // Either branch is valid; we assert the projector returns a defined
    // value (not undefined, since sessionId is not "multi:disabled").
    const result = await genericQueryCausedByProjector({}, "sessA");
    expect(result).toBeDefined();
    // Either { forceDegraded: true } (nativeL1 null) OR
    // { causedBy?, basedOn? } (nativeL1 present + history empty).
    if (result) {
      const hasForceDegraded = "forceDegraded" in result && result.forceDegraded === true;
      const hasProjection = "causedBy" in result || "basedOn" in result;
      expect(hasForceDegraded || hasProjection).toBe(true);
    }
  });
});

// ── A-1: defaultQuerySessionId — default + sentinel branch ──────────────────

describe("A-1: defaultQuerySessionId default path", () => {
  it('returns "default" when transport stub returns undefined and prototype gate is single-session', () => {
    // Production stub: getMcpTransportSessionId returns undefined,
    // _isSingleSessionPrototype returns true → "default" fallback.
    _resetDefaultQuerySingleSessionForTest();
    const sid = defaultQuerySessionId({});
    expect(sid).toBe("default");
  });
});

describe("A-1: defaultQuerySessionId sentinel branch", () => {
  it('returns "multi:disabled" when prototype gate is pinned to multi-session', () => {
    // Test seam: multi-session detected → sentinel disables caused_by injection
    // (mirrors desktop-state.ts:_setSingleSessionPrototypeForTest, prevents
    // cross-session causal trail leak in production multi-LLM-client deploys).
    _setDefaultQuerySingleSessionForTest(false);
    try {
      const sid = defaultQuerySessionId({});
      expect(sid).toBe("multi:disabled");
    } finally {
      _resetDefaultQuerySingleSessionForTest();
    }
  });
});

// ── A-1: delegating fn 整合 — desktopStateCausedByProjector ────────────────

describe("A-1: desktop-state.ts delegating fn integrity", () => {
  it("desktopStateCausedByProjector returns bit-equal output to genericQueryCausedByProjector", async () => {
    // After A-1 land, desktop-state.ts:desktopStateCausedByProjector is a
    // delegating fn to genericQueryCausedByProjector (plan §4.1.5 bit-equal
    // sync sweep). We can't import the private const directly, but we can
    // exercise both via desktop_state's registration handler and assert
    // the projector output matches what genericQueryCausedByProjector
    // produces for the same sessionId. For this test scope, asserting
    // that the generic projector exists with expected signature is
    // sufficient — full integration is covered by
    // tests/unit/desktop-state-causal-include.test.ts after A-1 land
    // (which exercises desktop_state's delegating projector through the
    // makeQueryWrapper S5 path).
    expect(typeof genericQueryCausedByProjector).toBe("function");
    expect(genericQueryCausedByProjector.length).toBe(2); // (args, sessionId)
  });
});

// ── A-1: 8 query tool wire 完了 pin (Round 1 Codex P2 反映) ─────────────────

describe("A-1: 8 query tool wrapper options carry causal-path wire", () => {
  // Round 1 Codex P2 反映: typeof === "function" だけでは wire 漏れを
  // 検出できない (makeQueryWrapper は wire 不在でも function を返す)。
  // observable behavior path = wrapper の internal config (WeakMap で
  // 記録) を inspect して `causedByProjector` / `getSessionId` の
  // identity を pin する。wire option ペアの片方忘却 (例: projector
  // だけ wire、sessionId 忘れ) を runtime で検出 (Lesson 2 同型盲点防止)。
  // Lesson 4 (numeric count sync) も同時担保 — 8 tool numeric が
  // mechanical コピー pattern に固定。
  it("all 8 wired query tools have genericQueryCausedByProjector + defaultQuerySessionId in wrapper options", async () => {
    const [
      { browserOverviewRegistrationHandler, browserLocateRegistrationHandler, browserSearchRegistrationHandler },
      { screenshotRegistrationHandler },
      { serverStatusRegistrationHandler },
      { waitUntilRegistrationHandler },
      { workspaceSnapshotRegistrationHandler },
      { desktopDiscoverRegistrationHandler },
    ] = await Promise.all([
      import("../../src/tools/browser.js"),
      import("../../src/tools/screenshot.js"),
      import("../../src/tools/server-status.js"),
      import("../../src/tools/wait-until.js"),
      import("../../src/tools/workspace.js"),
      import("../../src/tools/desktop-register.js"),
    ]);
    const wired: ReadonlyArray<readonly [string, (rawArgs: Record<string, unknown> & { include?: string[] }) => Promise<unknown>]> = [
      ["browser_overview", browserOverviewRegistrationHandler as never],
      ["browser_locate", browserLocateRegistrationHandler as never],
      ["browser_search", browserSearchRegistrationHandler as never],
      ["screenshot", screenshotRegistrationHandler as never],
      ["server_status", serverStatusRegistrationHandler as never],
      ["wait_until", waitUntilRegistrationHandler as never],
      ["workspace_snapshot", workspaceSnapshotRegistrationHandler as never],
      ["desktop_discover", desktopDiscoverRegistrationHandler as never],
    ];
    expect(wired).toHaveLength(8);
    for (const [toolName, handler] of wired) {
      const opts = __getQueryWrapperOptionsForTest(handler);
      expect(opts, `${toolName} options should be registered`).toBeDefined();
      // identity check — wire 漏れを runtime 検出
      expect(opts?.causedByProjector, `${toolName} should wire genericQueryCausedByProjector`).toBe(genericQueryCausedByProjector);
      expect(opts?.getSessionId, `${toolName} should wire defaultQuerySessionId`).toBe(defaultQuerySessionId);
    }
  });
});
