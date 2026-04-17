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
import { enumWindowsInZOrder } from "../win32.js";
import { refreshWin32Fluents, buildWindowIdentity } from "./sensors-win32.js";
import { findContainingWindow, getCachedWindowByTitle } from "../window-cache.js";
import { getOrCreateSlot, updateSlot } from "./hot-target-cache.js";

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
  | "needs_escalation";

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
// Guard selection per ActionKind
// (v3 §5 policy; stable.rect excluded from Phase A — no history in ephemeral store)
// ─────────────────────────────────────────────────────────────────────────────

function deriveGuards(actionKind: ActionKind): GuardKind[] {
  switch (actionKind) {
    case "keyboard":
      return ["safe.keyboardTarget", "target.identityStable", "modal.notBlocking" as GuardKind];
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

  if (candidates.length === 0) {
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  // Tie-break: foreground > lowest zOrder
  const foreground = candidates.find((w) => w.isActive);
  const best = foreground ?? [...candidates].sort((a, b) => a.zOrder - b.zOrder)[0]!;

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

  // Try window-cache first (sub-ms)
  const cached = findContainingWindow(x, y);
  if (!cached) {
    return { lens: null, localStore: null, identity: null, candidates: 0, warnings };
  }

  const hwnd = String(cached.hwnd);
  const normalizedCached = normalizeTitle(cached.title);

  // Validate against caller-supplied windowTitle if provided
  if (windowTitle) {
    const normalizedHint = normalizeTitle(windowTitle);
    if (!normalizedCached.includes(normalizedHint)) {
      warnings.push(
        `windowTitle "${windowTitle}" does not match containing window "${cached.title}"`
      );
    }
  }

  const titleForSpec = windowTitle ? normalizeTitle(windowTitle) : normalizedCached;
  return buildWindowLensResult(hwnd, cached.title, titleForSpec, actionKind, 1, warnings);
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
  let tabs: Array<{ id: string; title: string; url: string }> = [];
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

  updateSlot(slot.key, {
    identity,
    attention,
    useCount: slot.useCount + 1,
  }, nowMs);

  if (changed.length > 0) result.changed = changed;
}
