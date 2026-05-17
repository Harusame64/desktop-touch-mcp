/**
 * desktop-executor-keyboard-block.test.ts — ADR-020 SR-5 PR-SR5-2.
 *
 * Pins the new 5th `keyboard` block in `createDesktopExecutor` (sub-plan §5.2 +
 * §5.4 acceptance). 5 軸 cover:
 *
 *   (1) `preferredExecutors === undefined` → 新 block 不 entry (baseline 完全同一、北極星 9 (1))
 *   (2) `preferredExecutors=["keyboard"]` 単独 set + text + setValue → 新 block entry、bare "keyboard"
 *   (3) `preferredExecutors=["uia","keyboard"]` + UIA succeeds → UIA block entry、bare "uia" (新 block 到達せず)
 *   (4) `preferredExecutors=["uia","keyboard"]` + UIA setValue throws → UIA route 内 keyboardTypeBg recovery で bare "keyboard" (新 block 到達せず、PR #330 contract 維持)
 *   (5) `preferredExecutors=["keyboard"]` + click action → 新 block skip (text + setValue/type gate)、mouse 直行
 *
 * 北極星 (sub-plan §2):
 *   2 = PR #330 bare "keyboard" return contract 維持
 *   3 = 5 block sequential で baseline 4 block + UIA route 内 keyboardTypeBg recovery bit-equal
 *   9 (1) = preferredExecutors undefined → baseline 完全同一動作
 *   9 (3) = 新 block throw 直伝播、mouse rescue しない (CDP/terminal と同 pattern)
 *
 * @see docs/adr-020-phase-3-sr-5-keyboard-promotion-plan.md §5.2 / §5.4
 * @see src/tools/desktop-executor.ts ── Keyboard route ── block
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
    role: "textbox",
    label: "TextInput",
    confidence: 0.9,
    sources: ["uia"],
    affordances: [],
    generation: "gen-1",
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 200, height: 30 },
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

describe("5th keyboard block (ADR-020 SR-5 PR-SR5-2)", () => {
  describe("(1) preferredExecutors undefined → 新 block 不 entry (北極星 9 (1) baseline 完全同一)", () => {
    it("UIA-blocked entity + setValue + text + preferredExecutors undefined → throws (text drop 防止、新 block skip)", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      // sources=["uia"] + unsupportedExecutors=["uia"] + setValue + text + preferredExecutors undefined
      // → UIA block skip (blocked) + CDP/terminal eligibility なし + 新 keyboard block skip
      //   (preferredExecutors undefined のため) → text drop 防止 throw
      await expect(
        exec(
          entity({ sources: ["uia"], unsupportedExecutors: ["uia"] }),
          "setValue",
          "hello",
        ),
      ).rejects.toThrow(/no text-capable executor available/i);
      expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
    });
  });

  describe("(2) preferredExecutors=['keyboard'] 単独 set → 新 block entry", () => {
    it("UIA-blocked entity + preferredExecutors=['keyboard'] + setValue + text → keyboardTypeBg direct, bare 'keyboard'", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({
          sources: ["uia"],
          unsupportedExecutors: ["uia"],
          preferredExecutors: ["keyboard"],
        }),
        "setValue",
        "hello",
      );
      expect(result).toBe("keyboard"); // bare ExecutorKind (PR #330 contract、OQ-SR5-1 (1))
      expect(deps.keyboardTypeBg).toHaveBeenCalledOnce();
      expect(deps.keyboardTypeBg).toHaveBeenCalledWith("h", "hello");
      expect(deps.uiaSetValue).not.toHaveBeenCalled();
      expect(deps.mouseClick).not.toHaveBeenCalled();
    });

    it("preferredExecutors=['keyboard'] + click action → 新 block skip (text + setValue/type gate)、mouse 直行 (北極星 9 (5))", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({
          sources: ["uia"],
          unsupportedExecutors: ["uia"],
          preferredExecutors: ["keyboard", "mouse"],
        }),
        "click",
      );
      // click action は keyboard で意味なし → 新 keyboard block skip (text + setValue/type gate)
      // → mouse block entry (preferredAllows("mouse") true) → bare "mouse"
      expect(result).toBe("mouse");
      expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
      expect(deps.mouseClick).toHaveBeenCalledOnce();
    });
  });

  describe("(3) preferredExecutors=['uia','keyboard'] + UIA succeeds → UIA block 先 entry (北極星 2 維持)", () => {
    it("preferredExecutors=['uia','keyboard'] + UIA setValue succeeds → bare 'uia' (新 block 到達せず)", async () => {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({
          sources: ["uia"],
          patterns: ["ValuePattern"],
          preferredExecutors: ["uia", "keyboard"],
        }),
        "setValue",
        "hello",
      );
      expect(result).toBe("uia");
      expect(deps.uiaSetValue).toHaveBeenCalledOnce();
      expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
    });
  });

  describe("(4) preferredExecutors=['uia','keyboard'] + UIA setValue throws → UIA route 内 keyboardTypeBg recovery (PR #330 contract 維持、新 block 到達せず)", () => {
    it("UIA setValue throws + keyboardTypeBg succeeds → bare 'keyboard' (UIA route 内 fallback、北極星 2)", async () => {
      const deps = mockDeps({
        uiaSetValue: vi.fn(async () => {
          throw new Error("UIA setValue failed");
        }),
      });
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      const result = await exec(
        entity({
          sources: ["uia"],
          patterns: ["ValuePattern"],
          preferredExecutors: ["uia", "keyboard"],
        }),
        "setValue",
        "hello",
      );
      // PR #330 contract: UIA route 内 keyboardTypeBg recovery で bare "keyboard"
      // 新 block (top-level) は到達せず、UIA block 内 fallback で完結
      expect(result).toBe("keyboard");
      expect(deps.uiaSetValue).toHaveBeenCalledOnce();
      expect(deps.keyboardTypeBg).toHaveBeenCalledOnce();
    });
  });

  describe("(5) keyboardTypeBg failure 時 throw 直伝播 → guarded-touch 経由 executor_failed (北極星 9 (3)、R-SR5-2-c)", () => {
    it("preferredExecutors=['keyboard'] + keyboardTypeBg throws → throws directly (no mouse rescue)", async () => {
      const kbErr = new Error("Background keyboard type not supported for WT-XAML host");
      const deps = mockDeps({
        keyboardTypeBg: vi.fn(async () => {
          throw kbErr;
        }),
      });
      const exec = createDesktopExecutor({ hwnd: "h" }, deps);
      await expect(
        exec(
          entity({
            sources: ["uia"],
            unsupportedExecutors: ["uia"],
            preferredExecutors: ["keyboard"],
          }),
          "type",
          "hello",
        ),
      ).rejects.toThrow(/Background keyboard type not supported/);
      // mouse rescue しない (CDP/terminal と同 pattern、北極星 9 (3) 整合)
      expect(deps.mouseClick).not.toHaveBeenCalled();
    });
  });
});
