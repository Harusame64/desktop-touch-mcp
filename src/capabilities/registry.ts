/**
 * CapabilityRegistry — capability rule SSOT for ADR-020 SR-1.
 *
 * Three consumers (`deriveEntityCapabilities` advisory wrapper,
 * `createDesktopExecutor` execution route order, `desktop-register.ts` tool
 * description) all derive capability semantics from this registry exclusively.
 * Rule table re-implementation or re-declaration in consumer modules is
 * forbidden — `deriveEntityCapabilities` is a thin wrapper around
 * `registry.lookup` for backward compatibility only.
 *
 * Pure lookup invariant (北極星 1 + sub-plan §4.2): the registry has no
 * internal state. The `defaultRegistry` module-level singleton is safe for
 * concurrent / parallel test execution (no race possible). Constant data is
 * held in module-level `const` declarations (string primitives benefit from
 * TypeScript's `const` guard; object caches, if added later, must be wrapped
 * with `Object.freeze({...})` — note that `Object.freeze` on a string
 * primitive is a no-op).
 */

import type { UiEntity } from "../engine/world-graph/types.js";
import type {
  EntityCapabilities,
  ViewConstraints,
} from "../tools/desktop-constraints.js";

/**
 * Advertised executor kinds — the narrow union of executors that the
 * capability registry surfaces to the LLM and that `createDesktopExecutor`
 * consumes for block entry eligibility. Aligned with `ExecutorKind` (in
 * `src/engine/world-graph/types.ts:36`).
 *
 * ADR-020 SR-5 promoted `"keyboard"` to an advertised executor (was
 * internal-only PR #330 fallback inside the UIA `setValue` ladder). With
 * the promotion, `entity.preferredExecutors` may now include `"keyboard"`
 * (e.g. `["uia", "keyboard"]` for ValuePattern text inputs), and the
 * executor exposes a dedicated `keyboard` block for entities that opt
 * out of UIA entirely (`preferredExecutors: ["keyboard"]`).
 */
export type AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse" | "keyboard";

/** Runtime defense-in-depth — every emitted `preferredExecutor` must belong
 *  to this set. Catches rule-table edits that accidentally introduce
 *  non-advertised values (e.g. typos like `"keybord"` or future executor
 *  kinds added to `ExecutorKind` but not yet promoted to the advertised
 *  set) that the TS narrow type would otherwise miss in dynamic / unsoundly
 *  cast contexts. */
const ALLOWED_EXECUTORS: ReadonlySet<AdvertisedExecutorKind> = new Set<AdvertisedExecutorKind>([
  "uia",
  "cdp",
  "terminal",
  "mouse",
  "keyboard",
]);

export interface CapabilityRegistry {
  /**
   * Pure derivation of `EntityCapabilities` from a `UiEntity` + optional
   * `ViewConstraints`. Returns `undefined` when the entity exposes no
   * actionable signal (e.g. UIA-only entity with no rect and no pattern).
   *
   * Invariant on a defined return value (北極星 7):
   *   (a) `preferredExecutors.length >= 1`
   *   (b) `preferredExecutors ∩ unsupportedExecutors = ∅`
   *   (c) `preferredExecutors ⊆ Array<AdvertisedExecutorKind>` (SR-5 promoted
   *       `"keyboard"` to first-class advertised — the narrow now accepts all
   *       5 executors; any value outside the union is a violation)
   *
   * Bit-equal output guarantee with the pre-SR-1 `deriveEntityCapabilities`
   * implementation — pinned by the existing
   * `tests/unit/desktop-capabilities.test.ts` 14 cases and the new
   * `tests/unit/capabilities-registry-invariant.test.ts` cases.
   */
  lookup(
    entity: UiEntity,
    viewConstraints?: ViewConstraints,
  ): EntityCapabilities | undefined;

  /**
   * LLM-facing tool description advisory text generated from the rule
   * table. PR-SR1-3 will derive this from the registry rule shape; in the
   * current PR-SR1-1 land it returns a hand-written `ADVISORY_TEXT` constant
   * that is bit-equal to the existing static string at
   * `src/tools/desktop-register.ts:800`.
   */
  toolDescriptionAdvisory(): string;
}

/** Construct the production registry (singleton-friendly, no internal state). */
export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  return {
    lookup: lookupDefault,
    toolDescriptionAdvisory: toolDescriptionAdvisoryDefault,
  };
}

// ── rule table (migrated bit-equal from desktop-capabilities.ts:64) ─────────

/**
 * UIA pattern names this rule table recognises. Strings are the wire-form
 * values emitted by both the Rust native path and the PowerShell fallback
 * (canonicalised upstream by `uia-provider.ts::normalizeUiaPatternNames`).
 */
const INVOKE_PATTERN = "InvokePattern";
const VALUE_PATTERN = "ValuePattern";
const TOGGLE_PATTERN = "TogglePattern";

/**
 * UIA control types that historically refuse `Invoke` even though the LLM
 * tends to treat them as clickable (Issue #296 user report). Selection
 * happens via `SelectionItemPattern`, not `Invoke`.
 */
const SELECTION_ONLY_CONTROLS = new Set(["ListItem", "TabItem", "TreeItem"]);

function lookupDefault(
  entity: UiEntity,
  viewConstraints?: ViewConstraints,
): EntityCapabilities | undefined {
  const isUiaSource = entity.sources.includes("uia");
  const hasRect = entity.rect !== undefined;
  const patterns = entity.patterns ?? [];
  const controlType = entity.controlType;

  const uiaProviderFailed = viewConstraints?.uia === "provider_failed";

  let cap: EntityCapabilities | undefined;

  if (!isUiaSource) {
    if (!hasRect) cap = undefined;
    else
      cap = {
        preferredExecutors: ["mouse"],
        unsupportedExecutors: ["uia"],
      };
  } else {
    const hasInvoke = patterns.includes(INVOKE_PATTERN);
    const hasToggle = patterns.includes(TOGGLE_PATTERN);
    const hasValue = patterns.includes(VALUE_PATTERN);
    const isSelectionOnly =
      controlType !== undefined && SELECTION_ONLY_CONTROLS.has(controlType);

    if (uiaProviderFailed) {
      if (!hasRect) cap = undefined;
      else
        cap = {
          preferredExecutors: ["mouse"],
          unsupportedExecutors: ["uia"],
          fallbackHint: "use mouse_click — UIA provider failed for this view",
        };
    } else if (hasInvoke) {
      cap = { preferredExecutors: ["uia", "mouse"] };
    } else if (isSelectionOnly && hasRect) {
      cap = {
        preferredExecutors: ["mouse"],
        unsupportedExecutors: ["uia"],
        fallbackHint: `use mouse_click — UIA InvokePattern not exposed on ${controlType ?? "this control"}`,
      };
    } else if (hasToggle && hasRect) {
      cap = {
        preferredExecutors: ["mouse"],
        unsupportedExecutors: ["uia"],
        fallbackHint:
          "use mouse_click — UIA executor does not yet implement TogglePattern",
      };
    } else if (hasValue) {
      // ADR-020 SR-5 PR-SR5-1: ValuePattern entity に "keyboard" を共起 advertise。
      // UIA setValue が optimistic 1st、失敗時の keyboard recovery 経路 (UIA route 内
      // keyboardTypeBg fallback、bare "keyboard" return = PR #330 contract) を LLM に
      // 明示する。`hasInvoke` ブランチ (line 144-145) は SR-5 で touch しない
      // (Phase 2 E contract test bit-equal 維持、sub-plan §1.4 P1-2 確定)。
      cap = { preferredExecutors: ["uia", "keyboard"] };
    } else if (hasRect) {
      cap = {
        preferredExecutors: ["mouse"],
        unsupportedExecutors: ["uia"],
      };
    } else {
      cap = undefined;
    }
  }

  if (cap !== undefined) assertCapabilitiesInvariant(cap);
  return cap;
}

// ── invariant guard (北極星 7 defense-in-depth) ─────────────────────────────

/**
 * Defensive check enforcing the three registry invariants (北極星 7) at
 * runtime. Wired into `lookupDefault` so any rule-table edit that violates
 * the invariants throws at production runtime rather than silently emitting
 * a broken capability shape. The check is cheap (O(n) over a 1-4 element
 * array) and runs on every `see()` call.
 */
export function assertCapabilitiesInvariant(cap: EntityCapabilities): void {
  const preferred = cap.preferredExecutors ?? [];
  const unsupported = cap.unsupportedExecutors ?? [];

  if (preferred.length === 0) {
    throw new Error(
      "CapabilityRegistry invariant violation: preferredExecutors.length === 0",
    );
  }

  for (const e of preferred) {
    if (!ALLOWED_EXECUTORS.has(e as AdvertisedExecutorKind)) {
      throw new Error(
        `CapabilityRegistry invariant violation: "${e}" ∉ ALLOWED_EXECUTORS (narrow type breach, e.g. typo like "keybord" or an unknown executor kind smuggled past the AdvertisedExecutorKind compile-time guard)`,
      );
    }
    if (unsupported.includes(e)) {
      throw new Error(
        `CapabilityRegistry invariant violation: overlap "${e}" in preferred ∩ unsupported`,
      );
    }
  }
}

// ── entity bake helper (北極星 8) ────────────────────────────────────────────

/**
 * Bake the registry-derived `EntityCapabilities` onto a `UiEntity` so the
 * executor can consume `preferredExecutors / unsupportedExecutors /
 * fallbackHint` without invoking the registry itself (case β, sub-plan
 * §1.5). Writes all three fields in a single batch — partial bakes would
 * re-introduce the `provider_failed` view bias loss bug that the SR-1
 * design specifically eliminates.
 *
 * Safe to call with `cap === undefined` (no-op).
 */
export function bakeEntityCapabilities(
  entity: UiEntity,
  cap: EntityCapabilities | undefined,
): void {
  if (cap === undefined) return;
  if (cap.preferredExecutors && cap.preferredExecutors.length > 0) {
    entity.preferredExecutors = [...cap.preferredExecutors];
  }
  if (cap.unsupportedExecutors && cap.unsupportedExecutors.length > 0) {
    entity.unsupportedExecutors = [...cap.unsupportedExecutors];
  }
  if (cap.fallbackHint !== undefined) {
    entity.fallbackHint = cap.fallbackHint;
  }
}

// ── tool description (PR-SR1-1 stub, PR-SR1-3 will derive from rule shape) ──

/**
 * PR-SR1-3 will replace this hand-written constant with text generated from
 * the rule table shape. The current value is bit-equal to the existing
 * static string at `src/tools/desktop-register.ts:800` so the PR-SR1-3
 * switch-over is a snapshot-safe drop-in.
 *
 * Note: `Object.freeze` on a string primitive is a no-op, so the `const`
 * keyword is the relevant mutation guard here.
 */
const ADVISORY_TEXT =
  "Issue #296: entities[].capabilities (when present) advises executor selection. " +
  "preferredExecutors[0] is the executor most likely to succeed; " +
  "if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element " +
  "(saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls). " +
  "When preferredExecutors contains 'keyboard' (e.g. ['uia','keyboard'] on text inputs), " +
  "the 'keyboard' executor injects WM_CHAR directly to the focused control without focus-steal, " +
  "useful when UIA setValue fails on RichEdit/Document controls with unstable locators.";

function toolDescriptionAdvisoryDefault(): string {
  return ADVISORY_TEXT;
}
