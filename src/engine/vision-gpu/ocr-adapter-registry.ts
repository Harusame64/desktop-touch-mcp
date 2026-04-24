/**
 * ocr-adapter-registry.ts — Process-global registry of OcrVisualAdapter instances.
 *
 * Extracted from desktop-register.ts to break the circular import:
 *   desktop-register → compose-providers → ocr-provider → desktop-register
 *
 * Both desktop-register.ts (lifecycle reset) and ocr-provider.ts (per-see hook)
 * import from here; neither imports the other.
 */

import type { TargetSpec } from "../world-graph/session-registry.js";
import { OcrVisualAdapter, targetKeyFromSpec } from "./ocr-adapter.js";

let _ocrAdapters: Map<string, OcrVisualAdapter> | undefined;

/**
 * Return (lazily creating) the OcrVisualAdapter for a target.
 * Called from ocr-provider after a successful SoM run.
 */
export function getOcrVisualAdapter(target: TargetSpec): OcrVisualAdapter {
  if (!_ocrAdapters) _ocrAdapters = new Map();
  const key = targetKeyFromSpec(target);
  let adapter = _ocrAdapters.get(key);
  if (!adapter) {
    adapter = new OcrVisualAdapter(target);
    _ocrAdapters.set(key, adapter);
  }
  return adapter;
}

/** Dispose all adapters and clear the registry (test isolation). */
export function _resetOcrAdaptersForTest(): void {
  _ocrAdapters?.forEach((a) => a.dispose());
  _ocrAdapters = undefined;
}
