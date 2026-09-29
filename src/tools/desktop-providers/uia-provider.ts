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

function uiaRoleFromControlType(ct: string): string {
  const map: Record<string, string> = {
    Button: "button", CheckBox: "button", RadioButton: "button",
    Edit: "textbox", ComboBox: "textbox",
    Hyperlink: "link", MenuItem: "menuitem",
    Text: "label", Document: "label",
  };
  return map[ct] ?? "unknown";
}

function uiaActionability(ct: string): Array<"click" | "invoke" | "type" | "read"> {
  if ((UIA_PRESS_ONLY_CONTROL_TYPES as readonly string[]).includes(ct)) return ["invoke", "click"];
  if (["Edit", "ComboBox"].includes(ct)) return ["type", "click"];
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
  // (2ゲート目の指摘).
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

    const candidates: UiEntityCandidate[] = result.elements
      .filter((el) => el.isEnabled && el.name)
      .map((el): UiEntityCandidate => ({
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
        label: el.name,
        value: el.value,
        rect: el.boundingRect ?? undefined,
        actionability: uiaActionability(el.controlType),
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
      ...(candidates.length === 0 ? ["uia_no_elements"] : []),
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
    // P2). The half is of all the roots together: DevTools docked beside the page splits the
    // content area, and either half alone can fall under it (PR codex P2). Of several, the one
    // the window's title names — a browser titles itself after the page — and otherwise the largest.
    const window = result.windowRect;
    const area = (el: UiElement) => el.boundingRect!.width * el.boundingRect!.height;
    const roots = result.elements
      .filter((el) => el.automationId === WEB_AREA_AUTOMATION_ID && el.boundingRect && el.boundingRect.width > 0 && el.boundingRect.height > 0)
      .sort((a, b) => area(b) - area(a));
    const isMostOfWindow = !!window && roots.reduce((sum, el) => sum + area(el), 0) >= 0.5 * window.width * window.height;
    const title = result.windowTitle ?? "";
    const webArea = isMostOfWindow ? (roots.find((el) => el.name && title.includes(el.name)) ?? roots[0])?.boundingRect ?? undefined : undefined;

    return probeLane("uia", "read", read, { candidates, warnings, ...(webArea && { webArea }) });
  } catch (err) {
    console.error(`[uia-provider] Error for target "${targetId}":`, err);
    // What was read, when the throw came after the read; what was asked, when it came before.
    return probeLane("uia", "failed", { ...(read ?? asked), why: "threw" }, { candidates: [], warnings: [...hwndWarnings, "uia_provider_failed"] });
  }
}
