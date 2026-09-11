/**
 * status.ts — SSOT for native engine availability.
 *
 * Any module that needs to report which engine is active MUST import from here.
 * Do not read nativeEngine / nativeUia directly in tool code.
 */

import { nativeEngine, nativeUia, nativeUiaState, type NativeUiaState } from "./native-engine.js";

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
  /** Image diff operations: "native" = Rust SSE2, "typescript" = TS fallback */
  imageDiff: EngineImpl;
}

export function getEngineStatus(): EngineStatus {
  return {
    uia: nativeUia ? "native" : "powershell",
    nativeUia: nativeUiaState(),
    imageDiff: nativeEngine ? "native" : "typescript",
  };
}
