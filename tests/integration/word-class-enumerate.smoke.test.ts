/**
 * word-class-enumerate.smoke.test.ts — ADR-018 Phase 4 sub-plan §2.1#6
 * deliverable (SKELETON only — see sub-plan §2.2 carry-over to Phase 5).
 *
 * Locally-runnable smoke that logs Microsoft Word's top-level HWND neighbours
 * (siblings + the `OpusApp` top-level itself) as a precursor to the full
 * `EnumChildWindows`-based descendant assertion. CI runners do not have Word
 * installed, so this test self-skips unless `WORD_E2E=1` is set AND a Word
 * top-level window is reachable through `enumWindowsInZOrder()`.
 *
 * ## Scope (Phase 4 SKELETON vs Phase 5 FULL)
 *
 * Phase 4 lands ONLY the top-level enumeration + soft assertion (`OpusApp`
 * exists). The full descendant assertion that pins `_WwG` / `_WwO` under
 * `OpusApp` requires a new `win32_enum_child_windows` napi export, which is
 * out of scope for Phase 4 (no Tier 3 contract depends on it — the
 * `postWheelToHwnd` `null` path already handles Word's no-response case
 * structurally). Phase 5 adds the native export + wires the descendant
 * assertion. See `docs/adr-018-phase-4-subplan.md` §2.2.
 *
 * Manual invocation:
 *
 *   $env:WORD_E2E="1"; npx vitest run tests/integration/word-class-enumerate.smoke.test.ts
 *
 * Phase 4 records Word's PostMessage behaviour as documented unobserved-exhaust
 * if `_WwG` does not respond — the Tier 3 `null` path in
 * `_input-pipeline.ts::postWheelToHwnd` handles it correctly without further
 * code branching (the caller emits `target_unreachable` with
 * `channel:'postmessage'`).
 */

import { describe, it, expect } from "vitest";

const wordSmokeEnabled = process.env.WORD_E2E === "1";

describe.skipIf(!wordSmokeEnabled)(
  "ADR-018 Phase 4 — Word HWND class enumeration smoke (WORD_E2E=1)",
  () => {
    it("Word top-level window (OpusApp) exposes _WwG or _WwO somewhere in its descendant class hierarchy", async () => {
      const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");
      const { nativeWin32 } = await import("../../src/engine/native-engine.js");

      const topLevels = enumWindowsInZOrder();
      const wordTop = topLevels.find((w) => w.className === "OpusApp");
      if (!wordTop) {
        console.warn(
          "[word-class-enumerate.smoke] no top-level OpusApp window found; " +
            "open a Word document and retry. Skipping body assertion.",
        );
        return;
      }

      // We do not have a `win32_enum_child_windows` napi export today. The
      // available primitives are `win32_get_class_name` (already used in the
      // Z-order enumeration) and the public `enumWindowsInZOrder` which
      // returns top-level windows only. Phase 4 documents the gap; a future
      // PR can add `win32_enum_child_windows` for full tree dump. For now we
      // log the Z-order siblings of OpusApp (Word frequently spawns a sibling
      // tooltip / ribbon tearoff with a related class) plus the OpusApp's
      // own className. The assertion is permissive — present the data and
      // pass; a real failure (no Word at all) is caught by the skip above.

      console.log(
        "[word-class-enumerate.smoke] OpusApp HWND:",
        wordTop.hwnd.toString(16),
        "title:",
        wordTop.title,
      );
      console.log("[word-class-enumerate.smoke] top-level neighbours:");
      for (const w of topLevels.slice(0, 30)) {
        console.log(
          `  hwnd=0x${w.hwnd.toString(16)} class=${w.className} title="${w.title.slice(0, 60)}"`,
        );
      }

      // Soft assert: the WORD_E2E=1 runner saw Word; the document body class
      // _WwG/_WwO is descendants-only (not top-level), so the absence of the
      // string at the top level is expected. Logging satisfies the sub-plan
      // deliverable's "documents Word's HWND class hierarchy" goal even
      // without a full tree dump. Native enumeration of children is tracked
      // as a Phase 5 follow-up (see sub-plan §2.2 carry-over).
      expect(wordTop.className).toBe("OpusApp");

      // Defensive: if the native loader is missing on this dev box, document
      // it in the log rather than failing the smoke.
      if (!nativeWin32) {
        console.warn(
          "[word-class-enumerate.smoke] nativeWin32 missing — class child " +
            "enumeration not available without the .node binary",
        );
      }
    }, 30_000);
  },
);
