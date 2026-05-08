/**
 * skip-classifications.ts — issue #182 (Phase 3 follow-up)
 *
 * Encodes the two skip categories used across `tests/e2e/`:
 *
 *   - **envOnly**         The premise of the test is unmet by the environment
 *                         (file/app/UI fixture not present, OS protection fired,
 *                         locale-dependent label missing). Skipping is the
 *                         correct response: the product invariant the test
 *                         would have checked is not exercised, but no
 *                         contract violation is implied.
 *
 *   - **productBugCandidate** The test premise IS met but the product behaved
 *                         in a way that violates `docs/operation-verification-matrix.md`
 *                         §3.1 (Strict / Indirect contract for the relevant tool).
 *                         These must NOT be silently skipped — they should fail
 *                         the test, or at minimum carry a `// FIXME` with a
 *                         tracking issue so the regression is not silently
 *                         absorbed (this is exactly the failure mode that
 *                         issue #173 §S-1 caught for `terminal({action:'send'})`).
 *
 * Usage pattern (envOnly):
 *
 *   import { skipIfNoPowerShell, skipIfNoVsCode } from "./helpers/skip-classifications.js";
 *
 *   it("X", async ({ skip }) => {
 *     if (await skipIfNoPowerShell(skip)) return;
 *     // … real assertions …
 *   });
 *
 * Usage pattern (productBugCandidate, no helper):
 *
 *   // After a wait_until(window_appears) success, focus_window MUST NOT
 *   // return WindowNotFound. Per docs/operation-verification-matrix.md §3.1
 *   // (focus_window: Indirect verification, post enum isActive). Failing
 *   // hard here is the point — silently skipping would resurrect the
 *   // silent-success failure mode the matrix doc was written to prevent.
 *   expect(p.code).not.toBe("WindowNotFound");
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `vitest` `skip` parameter is exposed via the test context callback as
// `({ skip }) => …`. The helper is parameterised with that callback so we
// stay decoupled from how the suite imports skip.
export type SkipFn = (reason?: string) => void;

/**
 * envOnly: powershell.exe not on PATH (non-Windows host or stripped image).
 * Used by clipboard-readback / any test that shells out to PS.
 */
export async function skipIfNoPowerShell(skip: SkipFn): Promise<boolean> {
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      { timeout: 4000 }
    );
    return false;
  } catch {
    skip("envOnly: powershell.exe unavailable on this host (Windows-only fixture)");
    return true;
  }
}

/**
 * envOnly: VS Code window not currently open. Required by F2
 * (screenshot detail:'text' on Electron) suite.
 *
 * @returns the resolved VS Code window title if open, otherwise null after
 *   calling skip(). Caller is expected to early-return on null.
 */
export async function findVsCodeWindow(skip: SkipFn): Promise<string | null> {
  const { enumWindowsInZOrder } = await import("../../../src/engine/win32.js");
  const vsc = enumWindowsInZOrder().find((w) =>
    w.title.includes("Visual Studio Code")
  );
  if (!vsc) {
    skip("envOnly: VS Code not open (Electron sparse-UIA fixture missing)");
    return null;
  }
  return vsc.title;
}

/**
 * envOnly: VS Code accessibility mode is active so UIA returns a rich
 * actionable tree, breaking F2's premise (actionable=[]). When the user
 * sets `editor.accessibilitySupport: 'on'` or runs a screen reader, the
 * default-auto / never-OCR paths cannot be exercised.
 */
export function skipIfAccessibilityActive(
  skip: SkipFn,
  active: boolean,
  reasonSuffix = ""
): boolean {
  if (active) {
    skip(
      `envOnly: VS Code accessibility mode active — actionable=[] premise not met${
        reasonSuffix ? ` (${reasonSuffix})` : ""
      }`
    );
    return true;
  }
  return false;
}
