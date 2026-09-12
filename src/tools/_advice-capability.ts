/**
 * ADR-036 — advice names a CAPABILITY; this module resolves it to the tool that
 * provides it in the configuration currently running.
 *
 * WHY. A switch hides a tool, and nothing hides the advice that recommends it.
 * `paneIdMissSuggest` is a pure function of `paneId`, so its output is
 * byte-identical at all four corners of the two kill switches and keeps naming
 * `key_locker` in the two corners where the locker is gone (measured on Windows).
 * None of the four advice builders takes the configuration as an input, so fixing
 * wordings cannot hold: the next pure function written the same way reintroduces
 * it. The fix has to be at the layer that knows the configuration.
 *
 * THE TWO SWITCHES ARE NOT THE SAME KIND, which is the whole reason this is a
 * capability table and not a list of forbidden names (measured, all four corners):
 *
 *   DISABLE_FUKUWARAI_V2  removes 2 names, adds 3   → the SURFACE is swapped
 *   DISABLE_KEY_LOCKER    removes 1 name, adds 0    → the CAPABILITY is gone
 *
 * The original design already says this. `tool-surface-phase4-privatize-absorb-design.md`
 * has an absorption table — `get_windows` / `get_ui_elements` absorbed into
 * `desktop_discover`, `set_element_value` into `desktop_act` — and the kill-switch
 * fallback re-publishes exactly those three, with the comment "re-publish the V1
 * tools whose capability is ONLY available through the dispatcher path so the
 * operator does not lose function coverage". The vocabulary below is taken from
 * that table; nothing here is newly invented.
 *
 * Only 3 of the 20 absorptions split by configuration. The other 17 land on
 * `screenshot` / `desktop_state`, present at all four corners, so advice naming
 * those is safe everywhere and needs no capability.
 *
 * THE PREDICATES ARE THE ONES REGISTRATION READS. That coupling is deliberate: if
 * resolution read a different source of truth than registration, the two would
 * drift silently the moment one changed. `resolveV2Activation` takes `env` as a
 * parameter, which is what makes all four corners reproducible in a unit test
 * without a Windows machine.
 */

import { resolveV2Activation } from "./desktop-activation.js";
import { keyLockerDisabled } from "../engine/key-locker/key-locker-manager.js";

/**
 * The capabilities whose PROVIDER depends on configuration. Deliberately not an
 * inventory of everything the product can do — a capability belongs here only if
 * naming its provider directly could hand a caller a tool it cannot call.
 */
export type Capability =
  | "enumerate_windows"
  | "read_ui_tree"
  | "set_value"
  | "credential_store";

/** Where the advice text carries the resolved name. */
export const TOOL_PLACEHOLDER = "{tool}";

/**
 * The provider of `cap` in the configuration described by `env`, or `null` when
 * that configuration has no provider at all — the `credential_store` case, and
 * the only one where a line must be dropped rather than rewritten.
 *
 * Verified against measured `tools/list` at all four corners, in both directions
 * (each provider present in its family's corners AND the other family's provider
 * absent there), with no mismatch.
 */
export function providerFor(
  cap: Capability,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v2 = resolveV2Activation(env).enabled;
  switch (cap) {
    case "enumerate_windows":
      return v2 ? "desktop_discover" : "get_windows";
    case "read_ui_tree":
      return v2 ? "desktop_discover" : "get_ui_elements";
    case "set_value":
      return v2 ? "desktop_act" : "set_element_value";
    case "credential_store":
      // The locker predicate reads the process env directly (it owns the live
      // kill switch), so an `env` argument cannot override it here. Passing a
      // synthetic env for the other three corners still works, which is what the
      // four-corner unit reproduction needs.
      return keyLockerDisabled() ? null : "key_locker";
  }
}

/** An advice line: plain text, or text whose `{tool}` the presenter resolves. */
export type AdviceLine = string | { cap: Capability; text: string };

/**
 * Render advice for the configuration in `env`.
 *
 * A plain string passes through UNCHANGED — byte for byte, including any tool
 * name already written into it. That is what lets this ship with zero lines
 * converted: the machinery goes in, every existing line keeps its exact bytes,
 * and the whole suite must stay green. Converting lines is a separate change,
 * so a green suite here means the mechanism broke nothing rather than that the
 * advice is correct.
 *
 * A `{cap, text}` line resolves `{tool}`, or is DROPPED when the configuration
 * has no provider. Dropping is confined to `credential_store`: the surface-swap
 * switch always has a provider, so no line disappears merely because a switch
 * was flipped — that was the defect in the earlier `requires: [toolName]` draft,
 * which would have removed advice while the capability was still there.
 */
export function renderAdvice(
  lines: readonly AdviceLine[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (typeof line === "string") {
      out.push(line);
      continue;
    }
    const tool = providerFor(line.cap, env);
    if (tool === null) continue;
    out.push(line.text.split(TOOL_PLACEHOLDER).join(tool));
  }
  return out;
}
