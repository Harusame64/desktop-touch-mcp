/**
 * desktop-capabilities.ts — backward-compatible thin wrapper.
 *
 * ADR-020 SR-1 PR-SR1-1: the rule table previously hosted here has moved to
 * `src/capabilities/registry.ts` as the single source of truth for capability
 * derivation. This module is retained as a thin re-export wrapper so the
 * existing `desktop.ts:466` callsite and the existing
 * `tests/unit/desktop-capabilities.test.ts` 14 cases continue to operate
 * without modification.
 *
 * New callsites should import `createDefaultCapabilityRegistry().lookup`
 * directly from `src/capabilities/registry.ts`. Final removal of this
 * wrapper is tracked as `L9-a` carry-over in the parent ADR §11 (deferred
 * until all ADR-020 SRs land).
 */

import type { UiEntity } from "../engine/world-graph/types.js";
import type { EntityCapabilities, ViewConstraints } from "./desktop-constraints.js";
import { createDefaultCapabilityRegistry } from "../capabilities/registry.js";

const defaultRegistry = createDefaultCapabilityRegistry();

/** @deprecated SR-1 PR-SR1-1 — use `createDefaultCapabilityRegistry().lookup`
 *  directly. Retained as thin wrapper for the existing `desktop.ts:466`
 *  callsite and existing unit tests. */
export function deriveEntityCapabilities(
  entity: UiEntity,
  viewConstraints?: ViewConstraints,
): EntityCapabilities | undefined {
  return defaultRegistry.lookup(entity, viewConstraints);
}
