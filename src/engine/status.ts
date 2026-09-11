/**
 * status.ts — SSOT for native engine availability.
 *
 * Any module that needs to report which engine is active MUST import from here.
 * Do not read nativeEngine / nativeUia directly in tool code.
 */

import {
  nativeEngine,
  nativeUia,
  nativeUiaState,
  nativeUiaEvidence,
  type NativeUiaState,
  type NativeUiaEvidence,
} from "./native-engine.js";

export type EngineImpl = "native" | "powershell" | "typescript" | "unavailable";

export interface EngineStatus {
  /** UIA operations: "native" = Rust addon, "powershell" = PS fallback */
  uia: EngineImpl;
  /**
   * Why `uia` says what it says: "native"; "disabled" — the addon has the engine and
   * `DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1` sends UIA through PowerShell; or "unavailable" — the addon
   * has no UIA engine, or did not load.
   */
  nativeUia: NativeUiaState;
  /**
   * ADR-036 H2 — whether the native UIA engine actually ran in this process. It is answered by the
   * engine and the OS, not by the switch that `nativeUia` reports:
   *   - the COM thread starts and the tasks sent to it, as the engine counts them;
   *   - whether UIAutomationCore.dll is loaded, as the OS says.
   * It is read on each call. `null` when the addon cannot say.
   *
   * Under the switch, a thread start or a task means native UIA ran anyway. A loaded UIAutomationCore
   * with no thread start means something else in the process loaded it.
   */
  nativeUiaEvidence: NativeUiaEvidence | null;
  /** Image diff operations: "native" = Rust SSE2, "typescript" = TS fallback */
  imageDiff: EngineImpl;
}

export function getEngineStatus(): EngineStatus {
  return {
    uia: nativeUia ? "native" : "powershell",
    nativeUia: nativeUiaState(),
    nativeUiaEvidence: nativeUiaEvidence(),
    imageDiff: nativeEngine ? "native" : "typescript",
  };
}
