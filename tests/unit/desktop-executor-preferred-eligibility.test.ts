/**
 * desktop-executor-preferred-eligibility.test.ts — ADR-020 SR-1 PR-SR1-2.
 *
 * Pins the `entity.preferredExecutors` block entry eligibility contract
 * introduced in PR-SR1-2 (sub-plan §5.4 acceptance). Each case targets one
 * facet of the responsibility boundary established by 北極星 9:
 *
 *   (1) `entity.preferredExecutors === undefined` → baseline と完全同一動作
 *   (2) `entity.preferredExecutors` set → 各 block の entry gate のみが変化
 *   (3) UIA → mouse downgrade marker は UIA block 内 hand-wired emit を維持
 *   (4) 内部 keyboard fallback は bare `"keyboard"` return を維持
 *   (5) generic outer loop / aggregator は導入されていない (baseline 4 block
 *       sequential throw 経路を継承)
 *
 * Cross-reference: existing `desktop-executor.test.ts` (PR #330/#332/#296
 * contract pin、本 PR で書換禁止)、Phase 2 C/E contract test
 * (`tests/unit/path-class-contract/*.test.ts`、Phase 2 closure)。本ファイル
 * は **block entry eligibility 限定** 軸の独立 pin として配置。
 */

import { describe, it, expect, vi } from "vitest";
import {
  createDesktopExecutor,
  type ExecutorDeps,
} from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function entity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "Start",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [],
    generation: "gen-1",
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...overrides,
  };
}

function mockDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick:       vi.fn(async () => {}),
    uiaSetValue:    vi.fn(async () => {}),
    cdpClick:       vi.fn(async () => {}),
    cdpFill:        vi.fn(async () => {}),
    terminalSend:   vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick:     vi.fn(async () => {}),
    ...overrides,
  };
}

describe("preferredExecutors block entry eligibility (ADR-020 SR-1 PR-SR1-2)", () => {
  describe("(1) undefined → baseline と完全同一 (北極星 9 (1))", () => {
    it("preferredExecutors undefined + UIA source → UIA block entry, bare 'uia' return", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(entity({ sources: ["uia"] }), "click");
      expect(result).toBe("uia");
      expect(deps.uiaClick).toHaveBeenCalledOnce();
      expect(deps.mouseClick).not.toHaveBeenCalled();
    });

    it("preferredExecutors undefined + CDP source → CDP block entry, bare 'cdp' return", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ tabId: "t" }, deps);
      const result = await exec(
        entity({ sources: ["cdp"], sourceId: "#btn" }),
        "click",
      );
      expect(result).toBe("cdp");
      expect(deps.cdpClick).toHaveBeenCalledOnce();
    });
  });

  describe("(2) set → 各 block の entry gate のみ変化 (北極星 9 (2))", () => {
    it("preferredExecutors=['uia','mouse'] + UIA source + UIA succeeds → bare 'uia' (baseline と同)", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({ sources: ["uia"], preferredExecutors: ["uia", "mouse"] }),
        "click",
      );
      expect(result).toBe("uia");
    });

    it("preferredExecutors=['mouse'] + UIA source → UIA block skip, mouse direct, bare 'mouse'", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({ sources: ["uia"], preferredExecutors: ["mouse"] }),
        "click",
      );
      expect(result).toBe("mouse");
      expect(deps.uiaClick).not.toHaveBeenCalled();
      expect(deps.mouseClick).toHaveBeenCalledOnce();
    });

    it("preferredExecutors=['cdp'] + UIA-and-CDP multi-source → UIA block skip, CDP block entry", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ tabId: "t" }, deps);
      const result = await exec(
        entity({
          sources: ["uia", "cdp"],
          sourceId: "#btn",
          locator: { cdp: { selector: "#btn", tabId: "t" } },
          preferredExecutors: ["cdp"],
        }),
        "click",
      );
      expect(result).toBe("cdp");
      expect(deps.uiaClick).not.toHaveBeenCalled();
      expect(deps.cdpClick).toHaveBeenCalledOnce();
    });

    it("preferredExecutors excludes the entity's only viable source → throws (no eligible block)", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ tabId: "t" }, deps);
      await expect(
        exec(
          entity({ sources: ["cdp"], sourceId: "#btn", preferredExecutors: ["uia"] }),
          "click",
        ),
      ).rejects.toThrow(/mouse fallback also blocked by unsupportedExecutors|no rect for mouse fallback/);
    });
  });

  describe("(3) UIA → mouse downgrade marker は UIA block 内 hand-wired を維持 (北極星 9 (5))", () => {
    it("preferredExecutors=['uia','mouse'] + UIA throws + rect available → {kind:'mouse', downgrade:{from:'uia'}}", async () => {
      const deps = mockDeps({
        uiaClick: vi.fn(async () => {
          throw new Error("UIA InvokePatternNotSupported");
        }),
      });
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({ sources: ["uia"], preferredExecutors: ["uia", "mouse"] }),
        "click",
      );
      expect(typeof result).toBe("object");
      if (typeof result === "string") {
        throw new Error(`silent-drift: result was "${result}", expected ExecutorOutcome`);
      }
      expect(result.kind).toBe("mouse");
      expect(result.downgrade?.from).toBe("uia");
      expect(result.downgrade?.reason).toContain("InvokePatternNotSupported");
    });

    it("preferredExecutors=['uia'] (no mouse) + UIA throws → throws (no rescue, mouse not allowed)", async () => {
      const deps = mockDeps({
        uiaClick: vi.fn(async () => {
          throw new Error("UIA failed");
        }),
      });
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      // UIA block 内の mouse rescue は entity.locator?.visual?.rect ?? entity.rect
      // を使うため、preferredAllows("mouse") false の影響を受けるかは UIA block 内
      // の hand-wired logic に依存。本 SR-1 では UIA block 内 rescue は baseline と
      // bit-equal 維持 (preferredAllows check は block entry のみ) — UIA block 内
      // catch 節は preferredAllows("mouse") を見ない (baseline と完全同一)。
      // ただし entity.rect なし + preferredAllows("mouse") false の場合は UIA block
      // 内 mouse fallback が rect なしで throw、CDP/terminal eligibility なし、mouse
      // block 入口で preferredAllows("mouse") false で throw → 結果として常に throw。
      await expect(
        exec(
          entity({
            sources: ["uia"],
            preferredExecutors: ["uia"],
            rect: undefined,
            locator: undefined,
          }),
          "click",
        ),
      ).rejects.toThrow();
    });
  });

  describe("(4) 内部 keyboard fallback は bare 'keyboard' return を維持 (北極星 9 (4))", () => {
    it("preferredExecutors=['uia','mouse'] + UIA setValue throws + keyboardTypeBg succeeds → bare 'keyboard'", async () => {
      const deps = mockDeps({
        uiaSetValue: vi.fn(async () => {
          throw new Error("UIA setValue failed");
        }),
        keyboardTypeBg: vi.fn(async () => {}),
      });
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({ sources: ["uia"], preferredExecutors: ["uia", "mouse"] }),
        "setValue",
        "hello",
      );
      // PR #330 contract: bare "keyboard" return, no downgrade marker emit
      expect(result).toBe("keyboard");
      expect(deps.keyboardTypeBg).toHaveBeenCalledOnce();
    });
  });

  describe("(5) generic outer loop / aggregator は導入されていない (北極星 9 (3))", () => {
    it("preferredExecutors=['cdp','mouse'] + CDP throws → CDP error propagates directly (no mouse rescue)", async () => {
      // baseline の "non-UIA errors are propagated directly" pattern 維持確認:
      // CDP block の throw は mouse fallback で rescue されず、そのまま伝播する。
      // 北極星 9 (3): skipped block の failure 集約禁止、CDP block の throw は
      // outer aggregator で次 eligible 試行に流れない (= UIA only mouse rescue
      // は UIA block 内 hand-wired のみ、CDP/terminal block には適用されない)。
      const cdpError = new Error("CDP failed");
      const deps = mockDeps({
        cdpClick: vi.fn(async () => {
          throw cdpError;
        }),
      });
      const exec = createDesktopExecutor({ tabId: "t" }, deps);
      await expect(
        exec(
          entity({
            sources: ["cdp"],
            sourceId: "#btn",
            preferredExecutors: ["cdp", "mouse"],
          }),
          "click",
        ),
      ).rejects.toThrow(/CDP failed/);
      expect(deps.mouseClick).not.toHaveBeenCalled();
    });
  });
});
