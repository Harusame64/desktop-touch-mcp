/**
 * _coerce.ts — Zod schema helpers that accept the obvious LLM-friendly
 * string spellings of boolean / object inputs.
 *
 * Why: MCP clients sometimes serialize args by spelling everything as a
 * string ("true" / "{}"). The bare `z.boolean()` then rejects the call
 * with `expected boolean, received string`, and the LLM has to re-read
 * the tool description to recover. These helpers absorb the safe coercions
 * silently — only ambiguous inputs (e.g. boolean from arbitrary string)
 * still fail.
 *
 * Scope:
 *   - boolean  : "true"/"false" (case-insensitive), and the literal 0/1
 *   - object   : a JSON-parseable string is parsed; anything else passes through
 *
 * Numbers are deliberately NOT coerced here — `z.coerce.number()` already
 * exists in Zod and is preferred at the call site so precision-loss intent
 * is explicit.
 */

import { z } from "zod";

/**
 * `z.boolean()` that also accepts the strings "true" / "false" (any case)
 * and the literal numbers 0 / 1.
 *
 * Rejects every other value (including arbitrary strings like "yes") so a
 * typo can't silently flip the flag.
 */
export function coercedBoolean() {
  return z.preprocess((v) => {
    if (typeof v === "string") {
      const lower = v.toLowerCase().trim();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    if (v === 1) return true;
    if (v === 0) return false;
    return v;
  }, z.boolean());
}

/**
 * Wrap a `z.object({...}).shape`-compatible argument so that a JSON string
 * input (e.g. `"{}"` or `'{"windowTitle":"Notepad"}'`) is parsed before
 * being validated.
 *
 * Non-string input is passed through unchanged.
 */
export function coercedJsonObject<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess((v) => {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed === "") return {};
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Fall through; the inner z.object will raise its own structured error.
      }
    }
    return v;
  }, z.object(shape));
}
