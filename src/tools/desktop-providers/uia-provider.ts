/**
 * uia-provider.ts — UIA candidate provider for native Windows windows.
 *
 * Uses getUiElements() with hwnd option when available (precise, no title ambiguity).
 * Falls back to windowTitle when only a title is given.
 * Populates locator.uia for every candidate.
 *
 * Warnings:
 *   uia_provider_failed       — getUiElements threw or returned an error
 *   uia_no_elements           — window found but no actionable elements returned
 *   uia_read_while_busy       — (internal #240) the native read timed out (another act held UI
 *                               Automation) and this is the fallback's read, which may be missing
 *                               controls; said instead of uia_no_elements when it found none
 *   uia_blind_single_pane     — (H4) UIA tree is a single giant Pane (PWA/Electron/canvas)
 *   uia_blind_too_few_elements — (H4) UIA tree element count below threshold
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import { probeLane } from "../../engine/aim-probe.js";
import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import { UIA_PRESS_ONLY_CONTROL_TYPES } from "../../engine/world-graph/guarded-touch.js";
import { WEB_AREA_AUTOMATION_ID } from "../_advisory.js";
import type { UiElement } from "../../engine/uia-bridge.js";
import { isCollectionItemControlType } from "../../engine/collection-item.js";

/** How far a label may sit from its field: a WPF `Label` and its `TextBox` touch, a form's gap is a few pixels. */
const LABEL_GAP_PX = 24;

type Box = { x: number; y: number; width: number; height: number };
const isRect = (r: Box | null | undefined): r is Box => !!r && r.width > 0 && r.height > 0;
const vOverlap = (a: Box, b: Box): number => Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
/** `b` sits directly left of `a`, on its row: the gap, or null. */
const leftOf = (a: Box, b: Box): number | null => {
  const gap = a.x - (b.x + b.width);
  return gap >= -2 && gap <= LABEL_GAP_PX && vOverlap(a, b) >= Math.min(a.height, b.height) / 2 ? Math.max(0, gap) : null;
};
/** `b` sits directly above `a`, starting at its left edge (a label over its field, not over the next row): the gap, or null. */
const aboveOf = (a: Box, b: Box): number | null => {
  const gap = a.y - (b.y + b.height);
  return gap >= -2 && gap <= LABEL_GAP_PX && Math.abs(b.x - a.x) <= 8 ? Math.max(0, gap) : null;
};

/**
 * internal #293 — a label for a text box whose UIA Name is empty, from the visible text beside it.
 *
 * WPF's `Label.Target` sets no `LabeledBy` (win2, 2026-11-12: null on the TextBox), so the box reads with
 * Name "" and the lane dropped it. The only link left is the layout: a Text in the same parent, directly left
 * of the box on its row, or directly above it starting at its left edge. Left wins over above.
 *
 * Kept narrow, because the label is a guess (gate 2 on #964):
 * - only an `Edit` with ValuePattern, whose act roads are UIA and the keyboard (no blind mouse press), and
 *   with an AutomationId no other element in the read carries — with name "" the act roads find it by that
 *   id alone and take the first match, so a repeated template id would act on another row;
 * - the Text's own nearest such box must be this one, so a label is not lent to the box below or beside
 *   the one it names;
 * - a Text with a box directly left of it is a separator (`[w] x [h]`, `From [a] to [b]`), not a label.
 * The inferred text is a label to show and to match a query on, never the element's UIA Name. A leading
 * access-key underscore and a trailing colon are dropped.
 *
 * Returns index → label for the elements it names. Exported for tests.
 */
export function inferLabelsFromLayout(elements: ReadonlyArray<UiElement>): Map<number, string> {
  const out = new Map<number, string>();
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const idCount = new Map<string, number>();
  for (const el of elements) if (el.automationId) idCount.set(el.automationId, (idCount.get(el.automationId) ?? 0) + 1);
  const isBox = (el: UiElement): boolean =>
    el.controlType === "Edit" && el.isEnabled && normalizeUiaPatternNames(el.patterns).includes("ValuePattern");
  // Siblings by parent, once (a 500-element read would otherwise rescan the whole read per box).
  const byParent = new Map<string, number[]>();
  elements.forEach((el, i) => {
    if (el.path === undefined || !isRect(el.boundingRect)) return;
    const k = parentOf(el.path);
    byParent.set(k, [...(byParent.get(k) ?? []), i]);
  });
  // Rank: left before above, then the smaller gap.
  const rank = (field: Box, text: Box): number | null => {
    const l = leftOf(field, text);
    if (l !== null) return l;
    const a = aboveOf(field, text);
    return a !== null ? 1000 + a : null;
  };
  for (const ids of byParent.values()) {
    const boxes = ids.filter((i) => isBox(elements[i]!));
    const texts = ids.filter((i) => elements[i]!.controlType === "Text" && elements[i]!.name)
      .filter((t) => !boxes.some((b) => leftOf(elements[t]!.boundingRect!, elements[b]!.boundingRect!) !== null));
    // Each text's nearest box, so the text is lent to that one only.
    const nearestBoxOf = new Map<number, number>();
    for (const t of texts) {
      let best: { i: number; r: number } | null = null;
      for (const b of boxes) {
        const r = rank(elements[b]!.boundingRect!, elements[t]!.boundingRect!);
        if (r !== null && (best === null || r < best.r)) best = { i: b, r };
      }
      if (best !== null) nearestBoxOf.set(t, best.i);
    }
    for (const b of boxes) {
      const el = elements[b]!;
      if (el.name || !el.automationId || idCount.get(el.automationId) !== 1) continue;
      let best: { t: number; r: number } | null = null;
      for (const t of texts) {
        if (nearestBoxOf.get(t) !== b) continue;
        const r = rank(el.boundingRect!, elements[t]!.boundingRect!);
        if (r !== null && (best === null || r < best.r)) best = { t, r };
      }
      if (best === null) continue;
      const label = elements[best.t]!.name.replace(/^_(?=\S)/u, "").replace(/[:：]\s*$/u, "").trim();
      if (label !== "") out.set(b, label);
    }
  }
  return out;
}

export function uiaRoleFromControlType(ct: string): string {
  const map: Record<string, string> = {
    Button: "button", CheckBox: "button", RadioButton: "button",
    Edit: "textbox", ComboBox: "textbox",
    Hyperlink: "link", MenuItem: "menuitem",
    Text: "label", Document: "label",
    // internal #233 PR2: list, tree and grid items (they read `unknown`, primaryAction `read`).
    ListItem: "listitem", DataItem: "listitem", TreeItem: "listitem",
  };
  return map[ct] ?? "unknown";
}

/**
 * internal #233 PR2 — a collection item offers what its patterns say: `select` with
 * SelectionItemPattern (first, so `auto` and `primaryAction` select it rather than open it),
 * `invoke` (open or run it) with InvokePattern, and `click`, which selects it (#819: Select, or a
 * real single click for an item with no SelectionItem, such as a DataGridView cell).
 */
export function uiaActionability(ct: string, patterns: readonly string[] = []): Array<"click" | "invoke" | "type" | "select" | "read"> {
  if ((UIA_PRESS_ONLY_CONTROL_TYPES as readonly string[]).includes(ct)) return ["invoke", "click"];
  if (["Edit", "ComboBox"].includes(ct)) return ["type", "click"];
  if (isCollectionItemControlType(ct)) {
    return [
      ...(patterns.includes("SelectionItemPattern") ? ["select" as const] : []),
      "click" as const,
      ...(patterns.includes("InvokePattern") ? ["invoke" as const] : []),
    ];
  }
  return ["read"];
}

/**
 * Issue #296 (Opus R1 P1) — canonicalise the UIA pattern-name wire form.
 *
 * The Rust native path (`src/uia/tree.rs`) emits the short form
 * (`"Invoke"` / `"Value"` / `"Toggle"` / `"SelectionItem"` /
 * `"ExpandCollapse"` / `"Scroll"`) while the PowerShell fallback
 * (`makeGetElementsScript` in `uia-bridge.ts`) emits the suffixed form
 * (`"InvokePattern"` / `"ValuePattern"` / …). Without this normalisation,
 * `CapabilityRegistry.lookup` would silently inverse-classify every Rust-path
 * entity (matching `"InvokePattern"` against `"Invoke"` always misses).
 *
 * Canonicalisation target: the `*Pattern`-suffixed form, which matches the
 * documented Microsoft UI Automation pattern names ("Invoke Pattern" →
 * `InvokePattern`). Pre-suffixed strings pass through unchanged.
 *
 * Exported for unit testing.
 */
export function normalizeUiaPatternNames(patterns: string[] | undefined): string[] {
  if (patterns === undefined) return [];
  return patterns.map((p) => (p.endsWith("Pattern") ? p : `${p}Pattern`));
}

/**
 * internal #211 — how far discover's UIA read goes: capped by element count, not by depth.
 *
 * It was depth 4 / 80 elements. win2 measured (2026-09-29, 17 app types): web content in Chrome,
 * Edge and VS Code sits at depth 7–12 — so those windows read as `uia_blind_single_pane` and went
 * to OCR although plain UIA exposes every control — and Explorer's and Settings' value labels sit
 * at depth 5–7. Walked breadth-first to depth 64 with a 500-element cap, every type stayed at or
 * under 128 elements and 80–406 ms; none reached the cap. (The element-count cap, rather than a
 * depth cap, is CursorTouch/Windows-MCP's approach; the idea only, not code.)
 */
export const UIA_DISCOVER_MAX_DEPTH = 64;
export const UIA_DISCOVER_MAX_ELEMENTS = 500;
/** The PowerShell road's read, unchanged: a deep walk there runs into its deadline. */
export const UIA_DISCOVER_FALLBACK_DEPTH = 4;
export const UIA_DISCOVER_FALLBACK_ELEMENTS = 80;

export async function fetchUiaCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (!target || (!target.hwnd && !target.windowTitle)) {
    return probeLane("uia", "skipped", { why: "no_target" }, { candidates: [], warnings: [] });
  }

  // ADR-036 — the handle is not a title. It used to stand in for one here, so a session known
  // only by handle asked UIA for a window whose *name* contains the handle's digits; and when
  // both were present the title won, which is how the read half could enumerate one window
  // while the write half addressed another.
  const windowTitle = target.windowTitle ?? "@active";
  const targetId    = target.hwnd ?? target.windowTitle ?? "@active";
  // ADR-036 — the same parse the write half uses, so one malformed handle cannot make the two
  // halves aim at different windows. `BigInt(target.hwnd)` here used to throw straight out of
  // the provider.
  const pinned = parseTargetHwnd(target);
  // …and the OCR lane says so when a handle cannot be read, while this lane went quiet about the
  // same value in the same discover. With the handle unread there is no scoping, so this reads
  // `windowTitle` — the caller's title if it passed one, the FOREGROUND window if it did not —
  // while every candidate still carries the caller's raw handle string as its target id
  // (2ゲート目の指摘). From the tool, the no-title case is refused before this runs
  // (desktop-register.ts `unusableHandleRefusal`, internal #295).
  const hwndWarnings = pinned === undefined && target.hwnd ? ["target_hwnd_unparseable"] : [];
  // ADR-036 item 14a — what this lane asks for, known before the read, so a read that throws still
  // says it. `read` is filled once the bridge answers; the row is written where the lane returns.
  const asked = {
    windowTitle,
    targetId: String(targetId),
    scoped: pinned !== undefined,
    pinnedHwnd: pinned !== undefined ? pinned.toString() : null,
  };
  let read: Record<string, unknown> | undefined;

  try {
    const { getUiElements, detectUiaBlind } = await import("../../engine/uia-bridge.js");

    // `pinnedHwnd` asks the bridge to SCOPE the read to this window, through `FromHandle`
    // (ADR-036). It keys the cache too, but only because a scoped read is the one thing that can
    // vouch for which window it describes — the bridge will not file a title-derived tree under
    // a handle nobody scoped to. Passing `hwnd` as well was a way to prime the cache back when
    // the read could still go by title; now it would say nothing the scoped read does not.
    const options = pinned !== undefined ? { pinnedHwnd: pinned } : undefined;
    // The deep read is the native walk's; the PowerShell road keeps the old caps, where a deep walk
    // would run into its deadline — including when the native call fails and the bridge falls back.
    const raw     = await getUiElements(windowTitle, UIA_DISCOVER_MAX_DEPTH, UIA_DISCOVER_MAX_ELEMENTS, 8000, {
      ...options,
      fallbackLimits: { maxDepth: UIA_DISCOVER_FALLBACK_DEPTH, maxElements: UIA_DISCOVER_FALLBACK_ELEMENTS },
      // internal #217 part 2 — a Word page body's visible text, for `query` to match (desktop.ts).
      readBodyText: true,
    });
    // A read that filled its cap may have stopped early; it is published as a prefix, not judged
    // for blindness as the window.
    // Against the native cap only: the PowerShell road stops at its 80 without saying so, as it
    // always did, and a blind canvas app read there must still be judged blind and get OCR (gate 2
    // on A2). A PowerShell read never reaches 500.
    const result  = !raw.truncated && raw.elementCount >= UIA_DISCOVER_MAX_ELEMENTS ? { ...raw, truncated: true } : raw;

    // ADR-036 probe — what this lane actually asked for, and what it stamps on every candidate.
    // `scoped:false` with a `targetId` that looks like a handle is the read describing one window
    // while claiming another. Written where the lane returns (item 14a), so the row also says what
    // came back — and a throw between here and there still writes it, as `failed`.
    read = {
      ...asked,
      elementCount: result.elementCount,
      truncated: result.truncated ?? null,
      clientProviders: result.clientProviders ?? null,
      // ADR-036 item 15 — recorded because "the ladder did not run" and "the read could not say
      // which window" look identical downstream, and only this row separates them.
      windowHwnd: result.windowHwnd ?? null,
    };

    // internal #293: a nameless field named by the text beside it is kept, with that text as its label only.
    const inferred = inferLabelsFromLayout(result.elements);
    const candidates: UiEntityCandidate[] = result.elements
      .map((el, i) => ({ el, inferredLabel: inferred.get(i) }))
      .filter(({ el, inferredLabel }) => el.isEnabled && (el.name || inferredLabel !== undefined))
      .map(({ el, inferredLabel }): UiEntityCandidate => ({
        source: "uia",
        target: { kind: "window", id: targetId },
        // `via` — which client read it, so a click's "not found" can be weighed (ADR-036 item 16).
        // `nativeWindowHandle` — the element's own window, when it is one, so the keyboard rung can
        // tell whether its receiver is this element (ADR-036 family 2).
        locator: {
          uia: {
            automationId: el.automationId || undefined,
            name: el.name,
            // ADR-036 `internal#118` — WHY `nativeWindowHandle` is absent, carried with the entity
            // because the rule that refuses `other_control` is decided from that absence alone, and
            // "the element is not a window" (correct) and "the read failed" (a defect) were arriving
            // as one thing. Observation only; nothing branches on it.
            ...(el.nativeWindowHandleRead !== undefined && { nativeWindowHandleRead: el.nativeWindowHandleRead }),
            ...(result.via !== undefined && { via: result.via }),
            ...(el.nativeWindowHandle !== undefined && { nativeWindowHandle: el.nativeWindowHandle }),
            ...(el.isModal !== undefined && { isModal: el.isModal }),
            // internal #321 — its place in the read's tree, so a modal is not counted against its own fields.
            ...(el.path !== undefined && { path: el.path }),
            // internal #224 — the window it is drawn in, for the keyboard rung when its thread has no
            // focus (Word's body lives in the `_WwG` child window).
            ...(el.hostWindowHandle !== undefined && { hostWindowHandle: el.hostWindowHandle }),
            ...(el.hostWindowClass !== undefined && { hostWindowClass: el.hostWindowClass }),
            ...(el.visibleText !== undefined && { visibleText: el.visibleText }),
          },
        },
        role: uiaRoleFromControlType(el.controlType),
        // ADR-036 item 15 — the window this element was READ from, carried so the coordinate
        // ladder has a handle on this road at all. Before this line a UIA entity recorded no
        // origin handle, `coordHwnd` was undefined, and `resolvePressPoint` returned before its
        // first rung: a UIA entity whose window had CLOSED was pressed blind at the remembered
        // coordinates and the caller was told `ok:true` (win2, 2026-09-10).
        //
        // The read's own answer, not a second lookup. A title resolved twice can name two windows,
        // and stamping a handle the tree did not come from would make every rung below it precise
        // about the wrong window — worse than having none.
        //
        // Absent stays absent: a build whose read cannot report a handle keeps exactly the
        // behaviour it had, which is the ladder declining to run rather than running on a guess.
        ...(result.windowHwnd !== undefined && result.windowHwnd !== null && { originHwnd: result.windowHwnd }),
        label: el.name || inferredLabel,
        ...(inferredLabel !== undefined && { labelInferred: true }),
        value: el.value,
        rect: el.boundingRect ?? undefined,
        actionability: uiaActionability(el.controlType, normalizeUiaPatternNames(el.patterns)),
        // Issue #296: carry the UIA-side `controlType` and `patterns` through
        // so `CapabilityRegistry.lookup` can advertise executor preferences
        // at discover time (no extra UIA round-trip — `getUiElements` already
        // collected both via `GetSupportedPatterns()`). Patterns are normalised
        // here because the Rust native path (`src/uia/tree.rs`) emits the
        // short form (`"Invoke"`, `"Value"`, `"Toggle"`, …) while the
        // PowerShell fallback (`makeGetElementsScript`) emits the suffixed
        // form (`"InvokePattern"`, …). Downstream consumers (most importantly
        // `CapabilityRegistry.lookup`) see a single canonical shape.
        controlType: el.controlType,
        patterns: normalizeUiaPatternNames(el.patterns),
        confidence: 1.0,
        observedAtMs: Date.now(),
        provisional: false,
      }));

    const warnings: string[] = [
      ...hwndWarnings,
      // ADR-036 — a pinned read is the PowerShell walk, and that walk stops when the caller's
      // deadline runs out. Publishing the prefix is right (a partial view is still a view), but
      // publishing it as though it were the window is not: whatever was still on the stack is
      // missing, and the caller cannot tell that from a window that simply has fewer elements
      // (2ゲート目の指摘). `_narration` refuses a truncated tree outright because it DIFFS two of
      // them; discover only has to say so.
      ...(result.truncated ? ["uia_tree_truncated"] : []),
      // ADR-036 — this tree's frame elements were synthesised from MSAA by the clientside
      // providers, so they carry MSAA's vocabulary: `Close` where the COM road says `閉じる`,
      // `MenuBar:Application` where it says `MenuBar:アプリケーション`, `Document` where it says
      // `Edit`. Twenty of Notepad's twenty-six elements differ that way (measured 2026-09-09).
      // Self-consistent within this road — the act that follows speaks the same vocabulary — but
      // a caller comparing against a title-derived read, or against a name a human read off the
      // screen, is looking at two vocabularies for one window.
      ...(result.clientProviders === "registered" ? ["uia_frame_names_synthesized"] : []),
      // internal #240: a read made while UI Automation was busy may be missing what is there, so an
      // empty one is not called an empty window.
      ...(result.nativeTimedOut ? ["uia_read_while_busy"] : []),
      ...(candidates.length === 0 && !result.nativeTimedOut ? ["uia_no_elements"] : []),
    ];

    // H4: detect UIA-blind conditions (single-giant-pane / too-few-elements)
    // so that compose-providers can escalate visual lane explainability.
    const blind = detectUiaBlind(result);
    if (blind.blind) {
      if (blind.reason === "single-giant-pane")  warnings.push("uia_blind_single_pane");
      else if (blind.reason === "too-few-elements") warnings.push("uia_blind_too_few_elements");
    }

    // internal #211 — the page, from the whole read and not the named candidates: a page with no
    // <title> has a nameless root, which the filter above drops. Only web content that is most of
    // the window counts — a small WebView2 pane in a native app is not what the window is (gate 2
    // on A2) — and without the window's bounds that cannot be told, so there is no page (PR codex
    // P2). The half is of the area the roots cover together, inside the window: either root alone
    // can fall under it beside a docked DevTools, and two overlapping roots must not count their
    // shared part twice (PR codex P2 ×2). DevTools' root is never the page while another root is
    // there: it spans the whole content area wherever it is docked, so it would win "the largest"
    // for a page with no <title>, and "the one the title names" for a page titled about DevTools
    // (win2 measured the root's name "DevTools", Chrome, 2026-09-29; PR codex P2 ×2). Of the rest,
    // the one the window's title names — a browser titles itself after the page — and otherwise
    // the largest. DevTools undocked into its own window is the only root there, and counts.
    const window = result.windowRect;
    const area = (el: UiElement) => el.boundingRect!.width * el.boundingRect!.height;
    const roots = result.elements
      .filter((el) => el.automationId === WEB_AREA_AUTOMATION_ID && el.boundingRect && el.boundingRect.width > 0 && el.boundingRect.height > 0)
      .sort((a, b) => area(b) - area(a));
    const pages = roots.some((el) => el.name !== DEVTOOLS_ROOT_NAME) ? roots.filter((el) => el.name !== DEVTOOLS_ROOT_NAME) : roots;
    const isMostOfWindow = !!window && window.width > 0 && window.height > 0 && coveredArea(roots.map((el) => el.boundingRect!), window) >= 0.5 * window.width * window.height;
    const title = result.windowTitle ?? "";
    const webArea = isMostOfWindow
      ? (pages.find((el) => el.name && title.includes(el.name)) ?? pages[0])?.boundingRect ?? undefined
      : undefined;

    return probeLane("uia", "read", read, { candidates, warnings, ...(webArea && { webArea }) });
  } catch (err) {
    console.error(`[uia-provider] Error for target "${targetId}":`, err);
    // What was read, when the throw came after the read; what was asked, when it came before.
    return probeLane("uia", "failed", { ...(read ?? asked), why: "threw" }, { candidates: [], warnings: [...hwndWarnings, "uia_provider_failed"] });
  }
}

/** The name Chrome and Edge give DevTools' own RootWebArea (measured, win2, 2026-09-29). */
const DEVTOOLS_ROOT_NAME = "DevTools";

type Rect = { x: number; y: number; width: number; height: number };

/** The area the rectangles cover together inside `clip`, each point counted once. */
export function coveredArea(rects: Rect[], clip: Rect): number {
  const clipped = rects
    .map((r) => ({
      x0: Math.max(r.x, clip.x), y0: Math.max(r.y, clip.y),
      x1: Math.min(r.x + r.width, clip.x + clip.width), y1: Math.min(r.y + r.height, clip.y + clip.height),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  const xs = [...new Set(clipped.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const [a, b] = [xs[i], xs[i + 1]];
    const spans = clipped.filter((r) => r.x0 <= a && r.x1 >= b).map((r) => [r.y0, r.y1]).sort((p, q) => p[0] - q[0]);
    let covered = 0, top = -Infinity;
    for (const [y0, y1] of spans) {
      if (y1 <= top) continue;
      covered += y1 - Math.max(y0, top);
      top = y1;
    }
    total += covered * (b - a);
  }
  return total;
}
