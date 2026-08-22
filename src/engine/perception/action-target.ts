/**
 * Auto-perception action target resolution.
 * Infers window/tab identity from tool arguments (windowTitle, tabId, coordinates)
 * and compiles an ephemeral PerceptionLens for guard evaluation.
 *
 * Deliberately avoids registerLens() to prevent LRU eviction / sensor-loop churn
 * on the global lens registry. Uses primitive path instead:
 *   enumWindowsInZOrder → compileLens(idSeed) → fresh FluentStore → refreshWin32Fluents
 */

import { randomUUID } from "node:crypto";
import type {
  BrowserTabIdentity,
  GuardKind,
  LensSpec,
  PerceptionLens,
  WindowIdentity,
} from "./types.js";
import type { WindowSnapshot } from "./lens.js";
import {
  compileLens,
  resolveBrowserTabBindingFromTabs,
} from "./lens.js";
import { FluentStore } from "./fluent-store.js";
import { enumWindowsInZOrder, type WindowZInfo } from "../win32.js";
// Namespace import for the OPTIONAL pid probe in `classifyTitleHint` — accessed
// with `?.` so an environment (or test double) that provides only the
// enumerator degrades to the fail-closed branch instead of failing at the call.
import * as win32 from "../win32.js";
import { refreshWin32Fluents, buildWindowIdentity } from "./sensors-win32.js";
import { findContainingWindowFresh } from "../window-cache.js";
import { getOrCreateSlot, updateSlot } from "./hot-target-cache.js";
import { logResolve } from "../../tools/_resolve-log.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ActionKind =
  | "keyboard"
  | "mouseClick"
  | "mouseDrag"
  | "uiaInvoke"
  | "uiaSetValue"
  | "browserCdp";

export type ActionTargetDescriptor =
  | { kind: "window"; titleIncludes: string }
  | {
      kind: "browserTab";
      tabId?: string;
      port: number;
      urlIncludes?: string;
      titleIncludes?: string;
    }
  | { kind: "coordinate"; x: number; y: number; windowTitle?: string };

export type AutoGuardStatus =
  | "ok"
  | "unguarded"
  | "ambiguous_target"
  | "target_not_found"
  | "identity_changed"
  | "blocked_by_modal"
  | "unsafe_coordinates"
  | "browser_not_ready"
  | "needs_escalation"
  // ADR-038: a keyboard write arrived with neither `windowTitle` nor `hwnd`,
  // so there is no destination to guard — refused before any key is sent.
  | "destination_required";

export interface AutoGuardEnvelope {
  kind: "auto";
  status: AutoGuardStatus;
  canContinue: boolean;
  target?: string;    // "window:Notepad" / "browserTab:<url>"
  next: string;       // LLM-facing 1-sentence next step
  changed?: Array<"title" | "rect" | "foreground" | "identity" | "navigation" | "modal">;
}

export interface ResolveActionTargetResult {
  lens: PerceptionLens | null;
  localStore: FluentStore | null;
  identity: WindowIdentity | BrowserTabIdentity | null;
  candidates: number;
  warnings: string[];
  changed?: Array<"title" | "rect" | "foreground" | "identity" | "navigation" | "modal">;
  /** True when this is the first time this descriptor resolved to a live target (slot useCount was 0). */
  isNewTarget?: boolean;
  /**
   * The caller named a window, and the point they clicked turned out to be
   * inside a DIFFERENT one.
   *
   * This used to be a warning only, and the warning only reached stderr — so
   * the lens was built for the window that happens to occupy that spot now, the
   * guard checked THAT window, and a click naming one window was delivered to
   * another with a successful response. Harmless while a stale rectangle was
   * still catching the point and failing the guard; not harmless once expired
   * entries are re-verified against the live desktop, which is exactly what
   * makes the point resolve to the new occupant instead.
   *
   * `kind` says how the mismatch was established, because the two forms need
   * different recovery:
   *   - `"different_window"` — the hint names a live window of ANOTHER process
   *     (or the mismatch could not be verified because enumeration failed);
   *     the coordinates are wrong for the window the caller asked for.
   *   - `"not_found"` — the hint matches no open window at all: the named
   *     window is gone (or the name is stale), which is the reported symptom
   *     itself — a click naming a closed window must not be delivered to
   *     whatever now occupies the point.
   * A mismatch is NOT reported when the hint resolves to the containing window
   * itself (by hwnd, under its live title) or to a window of the same process —
   * those were the Round 2 false refusals. The same-process allowance is pid
   * equality and therefore wider than "an owned dialog": see the note on that
   * branch in `classifyTitleHint`.
   */
  titleMismatch?: { requested: string; resolved: string; kind?: "different_window" | "not_found" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chromium / Firefox suffix strip
// (KeePass/BluePrism research: suffix pollution is a well-known false-match source)
// ─────────────────────────────────────────────────────────────────────────────

const BROWSER_SUFFIXES: RegExp[] = [
  / - Google Chrome \(Incognito\)$/i,
  / - Google Chrome \(Guest\)$/i,
  / - Google Chrome$/i,
  / \u2013 Google Chrome \(Incognito\)$/i,    // en-dash variant
  / \u2013 Google Chrome$/i,
  / - Microsoft Edge \(InPrivate\)$/i,
  /\u00A0- Microsoft Edge \(InPrivate\)$/i,   // NBSP variant (title ends with NBSP-hyphen)
  / - Microsoft Edge$/i,
  /\u00A0- Microsoft Edge$/i,
  / \u2014 Mozilla Firefox \(Private Browsing\)$/i,  // em-dash
  / \u2014 Mozilla Firefox$/i,
  / - Mozilla Firefox \(Private Browsing\)$/i,
  / - Mozilla Firefox$/i,
];

/**
 * Normalize a window title for matching.
 * (1) NFC normalization (Windows recommended; NFKC loses round-trip info)
 * (2) Chromium/Firefox suffix strip
 * (3) trim + toLowerCase
 */
export function normalizeTitle(raw: string): string {
  let s = raw.normalize("NFC");
  for (const re of BROWSER_SUFFIXES) {
    s = s.replace(re, "");
  }
  return s.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Target key derivation (shared with hot-target-cache and target-timeline)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a stable string key for a descriptor.
 * Coordinate-only descriptors (no windowTitle) return null — they are not cached.
 */
export function deriveTargetKey(descriptor: ActionTargetDescriptor): string | null {
  if (descriptor.kind === "window") {
    return `window:${normalizeTitle(descriptor.titleIncludes)}`;
  }
  if (descriptor.kind === "browserTab") {
    if (descriptor.tabId) return `browserTab:${descriptor.tabId}`;
    if (descriptor.urlIncludes) return `browserTab:url:${descriptor.urlIncludes.toLowerCase()}`;
    if (descriptor.titleIncludes) return `browserTab:title:${normalizeTitle(descriptor.titleIncludes)}`;
    return null;
  }
  // coordinate
  if (descriptor.windowTitle) return `window:${normalizeTitle(descriptor.windowTitle)}`;
  return null;  // coordinate-only — not cached
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard selection per ActionKind
// (v3 §5 policy; stable.rect excluded from Phase A — no history in ephemeral store)
// ─────────────────────────────────────────────────────────────────────────────

function deriveGuards(actionKind: ActionKind): GuardKind[] {
  switch (actionKind) {
    case "keyboard":
      // safe.keyboardTarget is excluded from the ephemeral auto-guard path.
      // Rationale: when the MCP server is a child of an MSIX/AppContainer-packaged
      // host (e.g. Claude Desktop), SetForegroundWindow / AttachThreadInput are
      // rejected by Windows foreground-stealing protection, so the foreground
      // fluent reads false even after a verified focus attempt. That made
      // safe.keyboardTarget return needs_escalation and rendered keyboard_type
      // unusable end-to-end. The server still delegates foreground best-effort
      // to focusWindowForKeyboard (which now returns ok:false code:"ForegroundRestricted"
      // when refused — issue #202 unified shape), and target.identityStable
      // keeps us from typing into the wrong process.
      return ["target.identityStable", "modal.notBlocking" as GuardKind];
    case "mouseClick":
    case "mouseDrag":
      return ["target.identityStable", "safe.clickCoordinates"];
    case "uiaInvoke":
    case "uiaSetValue":
      return ["target.identityStable", "modal.notBlocking" as GuardKind];
    case "browserCdp":
      return ["browser.ready", "target.identityStable"];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeral lens builder (does NOT touch global registry or nextLensId counter)
// ─────────────────────────────────────────────────────────────────────────────

function buildEphemeralSpec(
  titleIncludes: string,
  actionKind: ActionKind
): LensSpec {
  const allGuards = deriveGuards(actionKind);
  // Filter to only the guard kinds actually defined in GUARD_KINDS.
  // stable.rect intentionally excluded in Phase A (no history samples in ephemeral store).
  // Phase B will add rect drift detection via HotTargetCache.lastRect comparison instead.
  const knownGuards: GuardKind[] = allGuards.filter(
    (g): g is GuardKind =>
      g === "target.identityStable" ||
      g === "safe.keyboardTarget" ||
      g === "safe.clickCoordinates" ||
      g === "browser.ready"
  );
  return {
    name: "__auto__",
    target: { kind: "window", match: { titleIncludes } },
    maintain: [
      "target.exists",
      "target.identity",
      "target.title",
      "target.rect",
      "target.foreground",
      "modal.above",
    ],
    guards: knownGuards,
    guardPolicy: "block",
    maxEnvelopeTokens: 0,
    salience: "background",
  };
}

function buildBrowserTabSpec(
  urlIncludes: string | undefined,
  titleIncludes: string | undefined,
  actionKind: ActionKind
): LensSpec {
  const allGuards = deriveGuards(actionKind);
  // stable.rect excluded in Phase A — see buildEphemeralSpec above.
  const knownGuards: GuardKind[] = allGuards.filter(
    (g): g is GuardKind =>
      g === "target.identityStable" ||
      g === "safe.keyboardTarget" ||
      g === "safe.clickCoordinates" ||
      g === "browser.ready"
  );
  return {
    name: "__auto__",
    target: {
      kind: "browserTab",
      match: { urlIncludes, titleIncludes },
    },
    maintain: [
      "target.exists",
      "target.identity",
      "target.title",
      "target.rect",
      "target.foreground",
      "modal.above",
    ],
    guards: knownGuards,
    guardPolicy: "block",
    maxEnvelopeTokens: 0,
    salience: "background",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an ActionTargetDescriptor to an ephemeral lens + fresh FluentStore.
 * Designed to be called immediately before guard evaluation — does NOT register
 * the lens globally, does NOT extend any TTL, does NOT bump the global lens counter.
 */
export async function resolveActionTarget(
  descriptor: ActionTargetDescriptor,
  options: { actionKind: ActionKind; coordinate?: { x: number; y: number } }
): Promise<ResolveActionTargetResult> {
  const { actionKind } = options;

  if (descriptor.kind === "window") {
    return resolveWindowTarget(descriptor.titleIncludes, actionKind);
  }

  if (descriptor.kind === "coordinate") {
    return resolveCoordinateTarget(descriptor, actionKind);
  }

  if (descriptor.kind === "browserTab") {
    return resolveBrowserTabTarget(descriptor, actionKind);
  }

  return { lens: null, localStore: null, identity: null, candidates: 0, warnings: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Window resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveWindowTarget(
  titleIncludes: string,
  actionKind: ActionKind
): Promise<ResolveActionTargetResult> {
  const normalized = normalizeTitle(titleIncludes);
  const warnings: string[] = [];

  // Enumerate all windows in z-order
  const rawWindows = enumWindowsInZOrder();
  const snapshots: WindowSnapshot[] = rawWindows.map((w) => ({
    hwnd: String(w.hwnd),
    title: w.title,
    zOrder: w.zOrder,
    isActive: w.isActive,
  }));

  // Filter by normalized title substring
  const candidates = snapshots.filter((w) =>
    normalizeTitle(w.title).includes(normalized)
  );

  // ADR-035 §2 #2 — logged alongside the existing warning, in the same format
  // every other resolver uses, so the one site that already tells the caller
  // about a tie is comparable with the ones that stay silent. Emitted before
  // the zero-match early return so a miss is recorded too (that is the H2 case).
  //
  // Built lazily: `WindowSnapshot.hwnd` is a string here, so the conversion
  // back to a handle is real work that a disabled log must not pay for
  // (Opus Round 2 P3).
  const logMatches = (): Array<{ hwnd: bigint; title: string; zOrder: number; isActive: boolean }> =>
    candidates.map((w) => ({ hwnd: BigInt(w.hwnd), title: w.title, zOrder: w.zOrder, isActive: w.isActive }));

  if (candidates.length === 0) {
    logResolve({ resolver: "actionTarget", query: titleIncludes, matches: [] });
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  // Tie-break: foreground > lowest zOrder
  const foreground = candidates.find((w) => w.isActive);
  const best = foreground ?? [...candidates].sort((a, b) => a.zOrder - b.zOrder)[0]!;

  logResolve({
    resolver: "actionTarget",
    query: titleIncludes,
    matches: logMatches,
    chosen: { hwnd: BigInt(best.hwnd), title: best.title, zOrder: best.zOrder, isActive: best.isActive },
  });

  if (candidates.length > 1) {
    warnings.push(
      `${candidates.length} windows match "${titleIncludes}"; using "${best.title}" (${foreground ? "foreground" : "frontmost"})`
    );
  }

  const result = buildWindowLensResult(best.hwnd, best.title, normalized, actionKind, candidates.length, warnings);
  applyHotCacheWindow({ kind: "window", titleIncludes: titleIncludes }, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveCoordinateTarget(
  descriptor: Extract<ActionTargetDescriptor, { kind: "coordinate" }>,
  actionKind: ActionKind
): Promise<ResolveActionTargetResult> {
  const { x, y, windowTitle } = descriptor;
  const warnings: string[] = [];

  // Window-cache first (sub-ms); a miss re-enumerates once rather than
  // reporting "target not found" for a window that is simply not in the cache
  // right now. Without that, expiring an entry would make a live, unmoved
  // window unclickable until some unrelated tool happened to list windows.
  const cached = findContainingWindowFresh(x, y);
  if (!cached) {
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  const hwnd = String(cached.hwnd);
  const normalizedCached = normalizeTitle(cached.title);

  // Validate against caller-supplied windowTitle if provided.
  //
  // NOT a string comparison against the cached title. The first cut of this
  // refusal compared `normalizeTitle(hint)` against `normalizeTitle(cached
  // title)` and refused on non-containment, which false-refused three common
  // workflows (Round 2 review): a bare browser name like "Google Chrome" (the
  // tool's own documented example — normalizeTitle strips the suffix from the
  // window title but not from the bare hint, so containment was structurally
  // false); an owned dialog ("Save As") clicked under the parent application's
  // title; and hwnd / "@active" callers, whose hint is the LIVE title while the
  // cache may still hold the previous title of the very same window. So the
  // hint is resolved against the live desktop and the verdict is based on
  // window identity — hwnd, then process — not on title text.
  if (windowTitle) {
    const verdict = classifyTitleHint(windowTitle, cached);
    if (verdict === "same_process") {
      // An owned dialog / popup of the named application. The old behaviour
      // (deliver, with a warning) was correct here — clicking a "Save As"
      // dialog under the app's title is routine, not an aiming error.
      warnings.push(
        `windowTitle "${windowTitle}" does not match containing window "${cached.title}", ` +
        `but both belong to the same process — proceeding (owned dialog / popup)`
      );
    } else if (verdict !== "match") {
      warnings.push(
        `windowTitle "${windowTitle}" does not match containing window "${cached.title}"`
      );
      return {
        lens: null,
        localStore: null,
        identity: null,
        candidates: 1,
        warnings,
        titleMismatch: { requested: windowTitle, resolved: cached.title, kind: verdict },
      };
    }
  }

  const titleForSpec = windowTitle ? normalizeTitle(windowTitle) : normalizedCached;
  return buildWindowLensResult(hwnd, cached.title, titleForSpec, actionKind, 1, warnings);
}

/**
 * Does the caller's `windowTitle` hint name the window that contains the point?
 *
 * Verdicts:
 *   - `"match"`            — yes: the containing title contains the hint in
 *                            either its raw or its normalized form (a bare
 *                            browser name matches the raw one, which still
 *                            carries the suffix the normalized one strips), or
 *                            the hint resolves to the containing window's hwnd
 *                            under its live title.
 *   - `"same_process"`     — the hint names a different window of the SAME
 *                            process. That is the owned-dialog case it was
 *                            added for, but pid equality is wider than
 *                            ownership — see the note at the branch itself.
 *                            Deliver with a warning.
 *   - `"different_window"` — the hint names a live window of another process,
 *                            or the desktop could not be enumerated to check.
 *                            The coordinates are wrong for the named window.
 *   - `"not_found"`        — the hint matches no open window at all.
 *
 * On `"not_found"` the refusal is deliberate rather than the pre-existing
 * warn-and-deliver: the window that is named but not open is the reported
 * symptom itself (close, rebuild, click), and delivering that click to
 * whatever now occupies the point is the failure this fix exists to stop. The
 * cost is a refusal when the hint is merely stale (a window whose title
 * changed, e.g. a terminal), and that refusal names the actual containing
 * window, so the caller can retry with a title that exists. Enumeration
 * failure also refuses (`"different_window"`): the mismatch was already
 * observed against the cache, and an unverifiable mismatch delivered anyway
 * would be the silent misdirect again.
 */
function classifyTitleHint(
  windowTitle: string,
  containing: { hwnd: bigint; title: string }
): "match" | "same_process" | "different_window" | "not_found" {
  const rawHint = windowTitle.trim().toLowerCase();
  if (rawHint === "") return "match"; // vacuous hint names nothing — nothing to validate
  const normalizedHint = normalizeTitle(windowTitle);

  const containsHint = (title: string): boolean => {
    const raw = title.toLowerCase();
    if (raw.includes(rawHint)) return true;
    return normalizedHint !== "" && normalizeTitle(title).includes(normalizedHint);
  };

  // Fast accept on the containing window's cached title — no enumeration.
  if (containsHint(containing.title)) return "match";

  // The cached title does not contain the hint. Resolve the hint against the
  // live desktop before deciding anything — the cache is not the authority on
  // what the hint names.
  let matches: WindowZInfo[];
  try {
    matches = enumWindowsInZOrder().filter((w) => containsHint(w.title));
  } catch {
    return "different_window"; // cannot verify → fail closed
  }

  // The containing window itself may match under its LIVE title — the cache
  // can hold the previous title of the same window (terminals retitle on
  // every command; hwnd / "@active" hints are the live title by construction).
  const containingKey = String(containing.hwnd);
  if (matches.some((w) => String(w.hwnd) === containingKey)) return "match";

  if (matches.length === 0) return "not_found";

  // The hint names some OTHER live window. Different process → the click is
  // aimed at the wrong application; same process → deliver.
  //
  // Read that allowance for what it is: **pid equality, not ownership.** It
  // covers the case it was added for — an owned dialog clicked under its
  // parent application's title — but it covers more, because one process
  // routinely owns several unrelated top-level windows: every Chrome window,
  // every File Explorer window, and (measured on this project) two Windows
  // Terminal windows sharing pid 16372. So a click naming one of those whose
  // point lands in a SIBLING is still delivered.
  //
  // Left that way on purpose. It is not a regression — that click was
  // delivered before this change too — and tightening it to an owner-chain /
  // dialog-class test (`WindowZInfo` already carries `ownerHwnd` and
  // `className`) would add refusals to a release whose last two rounds were
  // spent removing refusals that fired on ordinary work. Recorded as a
  // residual, to be closed with the destination-pin work that removes the need
  // to infer any of this from titles.
  //
  // The pid probe is best-effort: when it cannot answer, the allowance simply
  // does not apply (fail closed).
  const containingPid = win32.getWindowProcessId?.(containing.hwnd) ?? 0;
  if (
    containingPid !== 0 &&
    matches.some((w) => win32.getWindowProcessId?.(w.hwnd) === containingPid)
  ) {
    return "same_process";
  }
  return "different_window";
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser tab resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveBrowserTabTarget(
  descriptor: Extract<ActionTargetDescriptor, { kind: "browserTab" }>,
  actionKind: ActionKind
): Promise<ResolveActionTargetResult> {
  const warnings: string[] = [];

  // Dynamic import to avoid loading CDP module in non-browser contexts
  let tabs: Array<{ id: string; title: string; url: string }>;
  try {
    const cdpBridge = await import("../cdp-bridge.js");
    tabs = await cdpBridge.listTabsLight(descriptor.port);
  } catch {
    warnings.push(`CDP not available on port ${descriptor.port}`);
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  if (tabs.length === 0) {
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  // Filter by tabId if provided
  if (descriptor.tabId) {
    const found = tabs.find((t) => t.id === descriptor.tabId);
    if (!found) {
      warnings.push(`tabId ${descriptor.tabId} not found`);
      return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
    }
    tabs = [found];
  }

  const spec = buildBrowserTabSpec(descriptor.urlIncludes, descriptor.titleIncludes, actionKind);
  const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
  if (!binding) {
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  const tabEntry = tabs.find((t) => t.id === binding.hwnd);
  const identity: BrowserTabIdentity = {
    tabId: binding.hwnd,
    title: tabEntry?.title ?? binding.windowTitle,
    url: tabEntry?.url ?? "",
    port: descriptor.port,
  };

  const lens = compileLens(spec, binding, identity, 0, () => `auto-${randomUUID()}`);
  const localStore = new FluentStore();

  // Refresh CDP fluents
  try {
    const { refreshCdpFluents } = await import("./sensors-cdp.js");
    const obs = await refreshCdpFluents(binding.hwnd, descriptor.port);
    localStore.apply(obs);
  } catch {
    warnings.push("CDP fluent refresh failed");
  }

  const result: ResolveActionTargetResult = { lens, localStore, identity, candidates: tabs.length, warnings };
  applyHotCacheBrowserTab(descriptor, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: build window lens + refresh fluents
// ─────────────────────────────────────────────────────────────────────────────

function buildWindowLensResult(
  hwnd: string,
  resolvedTitle: string,
  specTitle: string,
  actionKind: ActionKind,
  candidates: number,
  warnings: string[]
): ResolveActionTargetResult {
  const spec = buildEphemeralSpec(specTitle, actionKind);
  const binding = { hwnd, windowTitle: resolvedTitle };
  const identity = buildWindowIdentity(hwnd);

  const lens = compileLens(spec, binding, identity ?? ({} as WindowIdentity), 0, () => `auto-${randomUUID()}`);
  const localStore = new FluentStore();

  // Refresh Win32 fluents into local (ephemeral) store only
  const obs = refreshWin32Fluents(hwnd, specTitle);
  localStore.apply(obs);

  return { lens, localStore, identity, candidates, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// HotTargetCache integration helpers (Phase B)
// ─────────────────────────────────────────────────────────────────────────────

type RectLike = { x: number; y: number; width: number; height: number };

function rectsDiffer(a: RectLike, b: RectLike): boolean {
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

/**
 * Update HotTargetCache slot after resolving a window target.
 * Only call from action paths — this extends the slot's TTL.
 * Mutates result.changed in-place.
 */
function applyHotCacheWindow(
  descriptor: Extract<ActionTargetDescriptor, { kind: "window" }>,
  result: ResolveActionTargetResult
): void {
  if (!result.lens || !result.localStore) return;

  const nowMs = Date.now();
  const slot = getOrCreateSlot(descriptor, nowMs);
  if (!slot) return;

  const hwnd = result.lens.binding.hwnd;
  const changed: ResolveActionTargetResult["changed"] = [];

  // Read current rect from ephemeral store
  const rectFluent = result.localStore.read(`window:${hwnd}.target.rect`);
  const currentRect = rectFluent?.value as RectLike | null | undefined;

  // Identity change detection
  if (slot.identity && result.identity) {
    const cached = slot.identity as WindowIdentity;
    const current = result.identity as WindowIdentity;
    if (cached.hwnd !== current.hwnd || cached.processStartTimeMs !== current.processStartTimeMs) {
      changed.push("identity");
    }
  }

  // Rect change detection (only when we have both cached and current rect)
  if (slot.lastRect && currentRect && !changed.includes("identity")) {
    if (rectsDiffer(slot.lastRect, currentRect)) {
      changed.push("rect");
    }
  }

  // Title change detection
  const titleFluent = result.localStore.read(`window:${hwnd}.target.title`);
  const currentTitle = titleFluent?.value as string | null | undefined;
  if (slot.lastTitle && currentTitle && slot.lastTitle !== currentTitle) {
    if (!changed.includes("identity")) changed.push("title");
  }

  const attention = changed.includes("identity") ? "identity_changed"
                  : changed.includes("rect") ? "changed"
                  : changed.includes("title") ? "changed"
                  : "ok";

  if (slot.useCount === 0) result.isNewTarget = true;

  updateSlot(slot.key, {
    identity: result.identity,
    ...(currentRect ? { lastRect: currentRect } : {}),
    ...(currentTitle ? { lastTitle: currentTitle } : {}),
    attention,
    useCount: slot.useCount + 1,
  }, nowMs);

  if (changed.length > 0) result.changed = changed;
}

/**
 * Update HotTargetCache slot after resolving a browser tab target.
 * Detects URL navigation and title changes.
 * Mutates result.changed in-place.
 */
function applyHotCacheBrowserTab(
  descriptor: Extract<ActionTargetDescriptor, { kind: "browserTab" }>,
  result: ResolveActionTargetResult
): void {
  if (!result.identity) return;

  const nowMs = Date.now();
  const slot = getOrCreateSlot(descriptor, nowMs);
  if (!slot) return;

  const identity = result.identity as BrowserTabIdentity;
  const changed: ResolveActionTargetResult["changed"] = [];

  if (slot.identity) {
    const cached = slot.identity as BrowserTabIdentity;
    if (cached.url !== identity.url) changed.push("navigation");
    if (cached.title !== identity.title && !changed.includes("navigation")) changed.push("title");
  }

  const attention = changed.includes("navigation") ? "changed" : "ok";

  if (slot.useCount === 0) result.isNewTarget = true;

  updateSlot(slot.key, {
    identity,
    attention,
    useCount: slot.useCount + 1,
  }, nowMs);

  if (changed.length > 0) result.changed = changed;
}
