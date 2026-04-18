/**
 * status.ts — SSOT for native engine availability.
 *
 * Any module that needs to report which engine is active MUST import from here.
 * Do not read nativeEngine / nativeUia directly in tool code.
 */

import { nativeEngine, nativeUia } from "./native-engine.js";

export type EngineImpl = "native" | "powershell" | "typescript" | "unavailable";

export interface EngineStatus {
  /** UIA operations: "native" = Rust addon, "powershell" = PS fallback */
  uia: EngineImpl;
  /** Image diff operations: "native" = Rust SSE2, "typescript" = TS fallback */
  imageDiff: EngineImpl;
}

export function getEngineStatus(): EngineStatus {
  return {
    uia: nativeUia ? "native" : "powershell",
    imageDiff: nativeEngine ? "native" : "typescript",
  };
}
