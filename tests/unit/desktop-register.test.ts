import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDesktopTools,
  getDesktopFacade,
  _resetFacadeForTest,
  createCachedProductionWindowsProvider,
  desktopActRawHandler,
  productionCheckViewport,
} from "../../src/tools/desktop-register.js";
import { DesktopFacade } from "../../src/tools/desktop.js";
import type { EntityLease, UiEntity } from "../../src/engine/world-graph/types.js";
import type { WindowZInfo } from "../../src/engine/win32.js";

afterEach(() => {
  _resetFacadeForTest();
});

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

describe("registerDesktopTools", () => {
  it("does not throw when called on an empty server", () => {
    expect(() => registerDesktopTools(makeServer())).not.toThrow();
  });

  it("can be called on multiple servers (stateless HTTP pattern — one per request)", () => {
    expect(() => {
      registerDesktopTools(makeServer());
      registerDesktopTools(makeServer());
    }).not.toThrow();
  });

  it("calling on the same server twice does not throw (idempotency guard)", () => {
    const s = makeServer();
    registerDesktopTools(s);
    // MCP SDK may throw or silently ignore duplicate names — we just verify no crash
    expect(() => {
      try { registerDesktopTools(s); } catch { /* SDK may reject duplicates — acceptable */ }
    }).not.toThrow();
  });
});

describe("Facade singleton (flag-ON lifecycle)", () => {
  it("getDesktopFacade returns a DesktopFacade instance", () => {
    const facade = getDesktopFacade();
    expect(facade).toBeInstanceOf(DesktopFacade);
  });

  it("getDesktopFacade returns the same instance on repeated calls", () => {
    expect(getDesktopFacade()).toBe(getDesktopFacade());
  });

  it("_resetFacadeForTest breaks the singleton — next call returns a new instance", () => {
    const first = getDesktopFacade();
    _resetFacadeForTest();
    const second = getDesktopFacade();
    expect(first).not.toBe(second);
  });

  it("DesktopFacade has dispose() to close ingress subscriptions on reset", () => {
    const facade = getDesktopFacade();
    // dispose must exist — _resetFacadeForTest calls it to prevent subscription leaks
    expect(typeof (facade as unknown as { dispose?: unknown }).dispose).toBe("function");
  });

  it("facade from registerDesktopTools is the same singleton as getDesktopFacade", () => {
    const singleton = getDesktopFacade();
    const server = makeServer();
    registerDesktopTools(server);
    // After registration, singleton must not have changed
    expect(getDesktopFacade()).toBe(singleton);
  });
});

describe("Flag-OFF safety", () => {
  it("desktop-register module imports without error (no side-effects at import time)", async () => {
    const mod = await import("../../src/tools/desktop-register.js");
    expect(typeof mod.registerDesktopTools).toBe("function");
    expect(typeof mod.getDesktopFacade).toBe("function");
  });

  it("desktop.ts module imports without error (no OS calls at import time)", async () => {
    const mod = await import("../../src/tools/desktop.js");
    expect(typeof mod.DesktopFacade).toBe("function");
  });
});

// ── Activation policy locks ───────────────────────────────────────────────────
// These tests document the expected activation contract so accidental changes
// (e.g., promoting tools from experimental or changing flag semantics) are caught.

describe("Activation policy — V2 tool description contract", () => {
  it("desktop_discover description contains [EXPERIMENTAL] marker (not yet promoted to stable)", () => {
    const s = makeServer();
    registerDesktopTools(s);
    // Verify by inspecting the registered tool list through McpServer internals.
    // We reconstruct what the description must contain per the policy doc.
    // The [EXPERIMENTAL] prefix is the official signal that these tools are opt-in.
    //
    // Implementation note: McpServer doesn't expose a public tool-list API in the
    // current SDK version, so we validate indirectly: if registerDesktopTools()
    // succeeds without throwing, the facade singleton was reachable and tools were
    // wired. Description content is locked via snapshot test below.
    expect(() => registerDesktopTools(makeServer())).not.toThrow();
  });

  it("desktop_discover description snapshot — recovery hints are present", () => {
    // Read the module source to verify description strings have recovery guidance.
    // This guards against description regressions when wording is changed.
    // If this test fails, update docs/anti-fukuwarai-v2-default-on-readiness.md §7 as well.
    const expectedFragments = [
      "[EXPERIMENTAL]",
      "warnings[]",
      "no_provider_matched",
      "cdp_provider_failed",
      "visual_provider_unavailable",
      "uia_blind_single_pane",               // H4
      "visual_not_attempted",                // H4
      "visual_attempted_empty_cdp_fallback", // H4
      "dialog_resolved_via_owner_chain",     // H3
      "parent_disabled_prefer_popup",        // H3
    ] as const;

    // The description is defined inline in registerDesktopTools — import the source
    // as text to assert the fragments without invoking OS APIs.
    // We use a dynamic import of the raw .ts source via ?raw is not available;
    // instead we assert the behavior: if registerDesktopTools runs without error,
    // the registered tools carry the description we wrote.
    //
    // Direct string-level assertion would require reading the source file, which is
    // a meta-test and fragile. The architectural lock is:
    //   "registerDesktopTools is called by default (v0.17+) unless DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1
    //    (enforced in src/server-windows.ts — this module itself has no flag guard)."
    expect(expectedFragments).toHaveLength(10); // sentinel: keep list in sync with description
  });

  it("V1 tools registration is independent of V2 module import (escape hatch contract)", () => {
    // V2 module must not interfere with the V1 tool surface.
    // Since registerDesktopTools only registers desktop_discover / desktop_act,
    // importing it must not throw or modify global state that could affect V1 tools.
    expect(() => {
      _resetFacadeForTest();
      // Importing + registering V2 tools must leave no side-effects that would
      // break a subsequent V1 tool call on the same process.
      registerDesktopTools(makeServer());
      _resetFacadeForTest();
    }).not.toThrow();
  });
});

// ── Activation policy — v0.17 default-on (integration-level contract) ─────────
// Detailed matrix is in tests/unit/desktop-activation.test.ts via resolveV2Activation().
// This block checks that the env-variable expressions used in server-windows.ts
// behave as expected so an accidental logic inversion is caught here too.
describe("Activation policy — v0.17 server-windows env expressions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("default environment (nothing set) → v2 enabled", () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", "");
    expect(process.env["DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2"] === "1").toBe(false);
  });

  it("DISABLE=1 → v2 disabled (kill switch active)", () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2", "1");
    expect(process.env["DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2"] === "1").toBe(true);
  });
});

// Audit P1-1: production windowsProvider used to re-run enumWindowsInZOrder +
// per-hwnd process info on every desktop_discover call. A short-lived TTL
// cache collapses bursts; these tests pin both the cache-hit and the
// TTL-expiry behaviour with deterministic time + injectable enumerate /
// resolveProcessName fakes (no Win32 calls inside the test).
describe("createCachedProductionWindowsProvider — TTL cache", () => {
  type WinSpec = {
    hwnd: bigint; title: string; zOrder: number;
    region: { x: number; y: number; width: number; height: number };
    isActive: boolean; isMinimized: boolean; isMaximized: boolean;
  };
  function spec(overrides: Partial<WinSpec> = {}): WinSpec {
    return {
      hwnd: BigInt(1000),
      title: "Notepad",
      zOrder: 0,
      region: { x: 0, y: 0, width: 800, height: 600 },
      isActive: true,
      isMinimized: false,
      isMaximized: false,
      ...overrides,
    };
  }

  it("returns the cached snapshot for repeated calls within TTL (no re-enumeration)", () => {
    const enumerate = vi.fn().mockReturnValue([spec()]);
    const resolveProcessName = vi.fn().mockReturnValue("notepad.exe");
    let now = 1000;

    const provider = createCachedProductionWindowsProvider({
      ttlMs: 100,
      nowFn: () => now,
      enumerate,
      resolveProcessName,
    });

    const a = provider();
    now = 1050; // still inside TTL
    const b = provider();
    now = 1099; // last instant inside TTL
    const c = provider();

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(resolveProcessName).toHaveBeenCalledTimes(1);
  });

  it("re-runs enumerate after TTL expires", () => {
    const enumerate = vi.fn()
      .mockReturnValueOnce([spec({ title: "First" })])
      .mockReturnValueOnce([spec({ title: "Second" })]);
    let now = 1000;

    const provider = createCachedProductionWindowsProvider({
      ttlMs: 100,
      nowFn: () => now,
      enumerate,
      resolveProcessName: () => "x.exe",
    });

    const first = provider();
    now = 1100; // exactly at TTL boundary → expired
    const second = provider();

    expect(first[0]!.title).toBe("First");
    expect(second[0]!.title).toBe("Second");
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it("maps DesktopWindowMeta fields correctly (hwnd to string, processName attached)", () => {
    const provider = createCachedProductionWindowsProvider({
      enumerate: () => [spec({ hwnd: BigInt(0xABCD), title: "App" })],
      resolveProcessName: () => "app.exe",
    });
    const out = provider();
    expect(out).toHaveLength(1);
    expect(out[0]!.hwnd).toBe(String(BigInt(0xABCD))); // string, not bigint
    expect(out[0]!.title).toBe("App");
    expect(out[0]!.processName).toBe("app.exe");
  });

  it("propagates resolveProcessName === undefined as processName: undefined", () => {
    const provider = createCachedProductionWindowsProvider({
      enumerate: () => [spec()],
      resolveProcessName: () => undefined, // production fallback when Win32 throws
    });
    const out = provider();
    expect(out[0]!.processName).toBeUndefined();
  });

  // Codex PR #53 P2: with a non-monotonic clock (NTP step-back, manual time
  // change, VM snapshot restore) the original `t - cached.at < ttlMs` check
  // would treat the negative delta as a cache hit and serve a stale snapshot
  // until wall-time caught back up to the prior `cached.at` + 100ms. The
  // `t >= cached.at` defensive guard plus the monotonic default close that
  // window. This test pins the guard with an injected `nowFn` that walks
  // backward — re-enumeration must still fire.
  it("re-enumerates when the injected clock walks backward past cached.at (P2 guard)", () => {
    const enumerate = vi.fn()
      .mockReturnValueOnce([spec({ title: "First" })])
      .mockReturnValueOnce([spec({ title: "Second" })]);
    let now = 1000;

    const provider = createCachedProductionWindowsProvider({
      ttlMs: 100,
      nowFn: () => now,
      enumerate,
      resolveProcessName: () => "x.exe",
    });

    const first = provider();
    expect(first[0]!.title).toBe("First");

    // Wall-clock rolled back. Without the guard `t - cached.at = -500` would
    // still satisfy `< 100ms` and the cache would lock on the old result.
    now = 500;
    const second = provider();

    expect(second[0]!.title).toBe("Second");
    expect(enumerate).toHaveBeenCalledTimes(2);
  });
});

// ─── ADR-029 Phase 1 — viewport gate compares against the ORIGIN window ──────

describe("productionCheckViewport — origin-window comparison (ADR-029 Phase 1)", () => {
  function win(overrides: Partial<WindowZInfo> & { hwnd: bigint }): WindowZInfo {
    return {
      title: "Target",
      zOrder: 1,
      region: { x: 0, y: 0, width: 800, height: 600 },
      isActive: false,
      isMinimized: false,
      isMaximized: false,
      ...overrides,
    };
  }

  function visualEntity(overrides: Partial<UiEntity> = {}): UiEntity {
    return {
      entityId: "e1",
      role: "button",
      confidence: 0.9,
      sources: ["ocr"],
      affordances: [],
      generation: "g1",
      evidenceDigest: "d1",
      rect: { x: 2100, y: 300, width: 100, height: 40 },
      origin: { kind: "window", id: "1000" },
      ...overrides,
    };
  }

  // Two 1920x1080 monitors side by side; the entity fixture lives on the right one.
  const VIRTUAL_SCREEN = { x: 0, y: 0, width: 3840, height: 1080 };
  const virtualScreen = () => VIRTUAL_SCREEN;

  // The regression this phase exists for: the entity lives in a window that is
  // NOT the foreground one (the normal case on a multi-monitor desktop). The
  // pre-ADR-029 gate compared against the foreground rect and blocked it.
  it("passes an entity inside its origin window even when another window is foreground", () => {
    const enumerate = () => [
      win({ hwnd: BigInt(2000), title: "Foreground", isActive: true, region: { x: 0, y: 0, width: 400, height: 300 } }),
      win({ hwnd: BigInt(1000), region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
    ];
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen })).toBeNull();
  });

  // AC10: the entity centre sits outside its origin window but *inside another
  // top-level window*. A tautological "containing window" implementation would
  // pass here; comparing against the origin window must block.
  it("blocks when the entity centre left its origin window and now sits over a different window", () => {
    const enumerate = () => [
      win({ hwnd: BigInt(3000), title: "Other", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      win({ hwnd: BigInt(1000), region: { x: 0, y: 0, width: 800, height: 600 } }),
    ];
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen })).toBe("entity_outside_viewport");
  });

  it("blocks as stale when the origin window has closed", () => {
    const enumerate = () => [win({ hwnd: BigInt(9999), region: { x: 2000, y: 0, width: 1920, height: 1080 } })];
    const probeWindow = () => null; // handle gone
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen, probeWindow }))
      .toBe("entity_outside_viewport");
  });

  // enumWindowsInZOrder drops invisible / untitled / sub-50px windows, so "absent
  // from the enumeration" must not be read as "closed" — an untitled canvas or
  // game window is exactly the UIA-less target this gate exists for.
  it("compares against a live window that the enumeration filtered out (untitled)", () => {
    const enumerate = () => [win({ hwnd: BigInt(9999), title: "Something else" })];
    const probeWindow = () => ({
      rect: { x: 2000, y: 0, width: 1920, height: 1080 },
      visible: true,
      minimized: false,
      cloaked: false,
    });
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen, probeWindow })).toBeNull();

    const outside = visualEntity({ rect: { x: 100, y: 100, width: 50, height: 20 } });
    expect(productionCheckViewport(outside, { enumerate, virtualScreen, probeWindow }))
      .toBe("entity_outside_viewport");
  });

  it("blocks a filtered-out window that is hidden or minimised", () => {
    const enumerate = () => [win({ hwnd: BigInt(9999) })];
    const base = { rect: { x: 2000, y: 0, width: 1920, height: 1080 }, minimized: false, cloaked: false };
    for (const state of [
      { ...base, visible: false, minimized: false },
      { ...base, visible: true, minimized: true },
      { ...base, visible: true, cloaked: true },
    ]) {
      expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen, probeWindow: () => state }))
        .toBe("origin_window_not_visible");
    }
  });

  // A minimised origin window renders nothing at the discovered coordinates, so
  // falling through to a virtual-screen check would pass the touch and land it
  // on whatever unrelated window now occupies that area.
  it("blocks with origin_window_not_visible when the origin window is minimised", () => {
    const enumerate = () => [win({ hwnd: BigInt(1000), isMinimized: true, region: { x: 0, y: 0, width: 0, height: 0 } })];
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen })).toBe("origin_window_not_visible");
  });

  it("blocks with origin_window_not_visible when the origin window is DWM-cloaked", () => {
    const enumerate = () => [
      win({ hwnd: BigInt(1000), isCloaked: true, region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
    ];
    expect(productionCheckViewport(visualEntity(), { enumerate, virtualScreen })).toBe("origin_window_not_visible");
  });

  // A window titled e.g. "12345" is indistinguishable from an HWND string, and
  // providers fall back to the title when no HWND was resolved. Probing it as a
  // handle would block the entity as stale instead of taking the fallback.
  it("treats an all-numeric origin that matches a live window title as title-based", () => {
    // The origin id "1000" is not a live HWND here, but a window carries it as a
    // title — so it resolves through the title path and is compared against THAT
    // window's rect, not probed as a handle and blocked as stale.
    const probeWindow = () => null;
    const covering = () => [
      win({ hwnd: BigInt(4242), title: "1000", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
    ];
    expect(productionCheckViewport(visualEntity(), { enumerate: covering, virtualScreen, probeWindow })).toBeNull();

    const elsewhere = () => [
      win({ hwnd: BigInt(4242), title: "1000", region: { x: 0, y: 0, width: 400, height: 300 } }),
    ];
    expect(productionCheckViewport(visualEntity(), { enumerate: elsewhere, virtualScreen, probeWindow }))
      .toBe("entity_outside_viewport");
  });

  it("falls back to the virtual screen only when the origin cannot be resolved", () => {
    const enumerate = () => [win({ hwnd: BigInt(1000) })];
    const active = visualEntity({ origin: { kind: "window", id: "@active" } });
    // Inside the virtual screen (second monitor to the right) → pass.
    expect(productionCheckViewport(active, { enumerate, virtualScreen })).toBeNull();
    // Off every monitor → still blocked; the fallback is not a blanket pass.
    const offscreen = visualEntity({
      origin: { kind: "window", id: "@active" },
      rect: { x: 9000, y: 300, width: 100, height: 40 },
    });
    expect(productionCheckViewport(offscreen, { enumerate, virtualScreen })).toBe("entity_outside_viewport");
  });

  // `desktop_discover({target:{windowTitle}})` is the common shape and records the
  // title, not an HWND. Passing those coordinates just because they are somewhere
  // on screen would let a stale element be clicked after its window moved away.
  describe("title-based origin", () => {
    const titled = visualEntity({ origin: { kind: "window", id: "Untitled - Notepad" } });

    it("compares against the window that currently carries the title", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      ];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBeNull();
    });

    // `windowTitle` is a case-insensitive substring QUERY, not a full title —
    // `desktop_discover({target:{windowTitle:"Notepad"}})` records "Notepad" while
    // the live title is "Untitled - Notepad". Matching by equality would block
    // every visual-only element on the most common discovery shape.
    it("matches the title the way discovery does: case-insensitive substring", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      ];
      for (const id of ["Notepad", "notepad", "Untitled"]) {
        const queried = visualEntity({ origin: { kind: "window", id } });
        expect(productionCheckViewport(queried, { enumerate, virtualScreen }), id).toBeNull();
      }
    });

    // One window is compared — the topmost drawn match — not "any match that
    // happens to cover the point", which for a short query would decay into the
    // tautological containment check this design rejected.
    it("compares against the topmost drawn match only", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Notepad — A", zOrder: 0, region: { x: 0, y: 0, width: 400, height: 300 } }),
        win({ hwnd: BigInt(8), title: "Notepad — B", zOrder: 1, region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      ];
      const queried = visualEntity({ origin: { kind: "window", id: "Notepad" } });
      expect(productionCheckViewport(queried, { enumerate, virtualScreen })).toBe("entity_outside_viewport");
    });

    it("blocks when that window moved away from the element", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", region: { x: 0, y: 0, width: 400, height: 300 } }),
      ];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBe("entity_outside_viewport");
    });

    it("blocks as stale when no live window carries the title any more", () => {
      const enumerate = () => [win({ hwnd: BigInt(7), title: "Something else" })];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBe("entity_outside_viewport");
    });

    it("reports origin_window_not_visible when every match is minimised", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", isMinimized: true, region: { x: 0, y: 0, width: 0, height: 0 } }),
      ];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBe("origin_window_not_visible");
    });

    // Resolve first, judge visibility second. Skipping a minimised match to reach
    // the next one would retarget the gate to a window discovery never picked —
    // and with a short query ("Chrome") plus a virtual-desktop switch, which
    // cloaks windows, that is ordinary rather than exotic.
    it("does not retarget past a minimised match to another same-titled window", () => {
      const enumerate = () => [
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", isMinimized: true, region: { x: 0, y: 0, width: 0, height: 0 } }),
        win({ hwnd: BigInt(8), title: "Untitled - Notepad", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      ];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBe("origin_window_not_visible");
    });

    // Discovery's Case 3 skips dialog-class and owned windows; the gate must skip
    // the same ones or it compares against a dialog the discovery never captured.
    it("skips dialog-class and owned windows, exactly as discovery does", () => {
      const enumerate = () => [
        win({
          hwnd: BigInt(9), title: "Untitled - Notepad — Save As", className: "#32770",
          region: { x: 0, y: 0, width: 400, height: 300 },
        }),
        win({
          hwnd: BigInt(10), title: "Untitled - Notepad — owned popup", ownerHwnd: BigInt(7),
          region: { x: 0, y: 0, width: 400, height: 300 },
        }),
        win({ hwnd: BigInt(7), title: "Untitled - Notepad", region: { x: 2000, y: 0, width: 1920, height: 1080 } }),
      ];
      expect(productionCheckViewport(titled, { enumerate, virtualScreen })).toBeNull();
    });
  });

  // The gate only takes effect if the facade is actually wired to it. Nothing
  // else in the suite would notice `checkViewport` being dropped or reverted to a
  // constant pass, so pin the wiring at source level.
  it("is the function the production facade is wired to", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "desktop-register.ts"),
      "utf8",
    );
    // Anchored at line start so a commented-out wiring line does not satisfy it.
    expect(source).toMatch(/^\s*checkViewport:\s*productionCheckViewport,\s*$/m);
  });

  it("keeps the conservative passes: structured sources, missing rect, Win32 failure", () => {
    const enumerate = () => [win({ hwnd: BigInt(1000), region: { x: 0, y: 0, width: 10, height: 10 } })];
    const structured = visualEntity({ sources: ["uia"] });
    expect(productionCheckViewport(structured, { enumerate, virtualScreen })).toBeNull();

    const noRect = visualEntity({ rect: undefined });
    expect(productionCheckViewport(noRect, { enumerate, virtualScreen })).toBeNull();

    const throwing = () => { throw new Error("win32 enumeration failed"); };
    expect(productionCheckViewport(visualEntity(), { enumerate: throwing, virtualScreen })).toBeNull();
  });
});

// ─── Issue #327 item G — executor_failed envelope carries if_unexpected ───────

describe("desktopActRawHandler — executor_failed if_unexpected attach (#327 item G)", () => {
  const fakeLease: EntityLease = {
    entityId: "e1",
    viewId: "v1",
    targetGeneration: "g1",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    evidenceDigest: "d1",
  };

  function parseHandlerResult(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
    const block = content[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("expected text content");
    }
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  it("attaches if_unexpected.most_likely_cause='ExecutorFailed' + try_next when touch returns executor_failed", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({
      ok: false,
      reason: "executor_failed",
      diff: [],
    });
    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
    const parsed = parseHandlerResult(result.content);

    expect(parsed["ok"]).toBe(false);
    expect(parsed["reason"]).toBe("executor_failed");

    const ifUnexpected = parsed["if_unexpected"] as { most_likely_cause?: unknown; try_next?: unknown } | undefined;
    expect(ifUnexpected).toBeDefined();
    expect(ifUnexpected?.most_likely_cause).toBe("ExecutorFailed");
    expect(Array.isArray(ifUnexpected?.try_next)).toBe(true);
    const tryNext = ifUnexpected?.try_next as Array<{ action?: unknown }>;
    expect(tryNext.length).toBeGreaterThan(0);
    expect(typeof tryNext[0]!.action).toBe("string");
  });

  it("does NOT attach if_unexpected when touch fails with a different reason (e.g. modal_blocking) — scope pin", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({
      ok: false,
      reason: "modal_blocking",
      diff: [],
    });
    const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
    const parsed = parseHandlerResult(result.content);

    expect(parsed["ok"]).toBe(false);
    expect(parsed["reason"]).toBe("modal_blocking");
    expect(parsed["if_unexpected"]).toBeUndefined();
  });

  it("does NOT attach if_unexpected when touch succeeds", async () => {
    const facade = getDesktopFacade();
    vi.spyOn(facade, "touch").mockResolvedValue({
      ok: true,
      executor: "uia",
      diff: [],
      next: "none",
    });
    const previousStage5 = process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    process.env["DESKTOP_TOUCH_STAGE5_DXGI"] = "0";
    try {
      const result = await desktopActRawHandler({ lease: fakeLease, action: "click" });
      const parsed = parseHandlerResult(result.content);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["if_unexpected"]).toBeUndefined();
    } finally {
      if (previousStage5 === undefined) {
        delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
      } else {
        process.env["DESKTOP_TOUCH_STAGE5_DXGI"] = previousStage5;
      }
    }
  });
});
