import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { mouse } from "../engine/nutjs.js";
import {
  enumWindowsInZOrder,
  enumMonitors,
  getVirtualScreen,
  getWindowProcessId,
  getProcessIdentityByPid,
} from "../engine/win32.js";
import { getHistorySnapshot } from "./_post.js";
import { listRecentTargetKeys } from "../engine/perception/target-timeline.js";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import { nativeViewFocus, nativeL1 } from "../engine/native-engine.js";
import type {
  NativeFocusedElement,
  NativeUiaFocusInfo,
} from "../engine/native-types.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import { getSlotSnapshot } from "../engine/perception/hot-target-cache.js";
import type { AttentionState } from "../engine/perception/types.js";
import {
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  buildCausedBy,
  buildBasedOn,
  type CausedByShape,
  type BasedOnShape,
  type ViewSnapshot,
} from "./_envelope.js";

const _defaultPort = getCdpPort();

/**
 * Heuristic regex used by desktop_state.hasModal to flag windows whose titles
 * look like modal dialogs.
 *
 * English keywords use \b word boundaries so that substring noise does not
 * trigger false positives — e.g. "errors" must NOT match /error/, "Prompt
 * Engineering" must NOT match /prompt/, "Confirmation" must NOT match
 * /confirm/, "Alerting" must NOT match /alert/, "Dialogue" must NOT match
 * /dialog/. The bare "prompt" keyword is intentionally absent because it is
 * almost always a non-modal noun in real-world window titles.
 *
 * Japanese keywords are matched as bare substrings since \b does not recognise
 * Japanese word boundaries; substring false positives for these terms are rare
 * in practice (window titles like "通知センター" exist but are infrequent).
 *
 * Exported so unit tests can pin both the true-positive and false-positive
 * contracts down — see tests/unit/modal-detection.test.ts.
 */
export const MODAL_RE = /\b(?:dialog|confirm|alert|error|warning|save as)\b|警告|エラー|確認|通知|ダイアログ|名前を付けて/i;

// ─── Focused-element builders (D2-B-2) ───────────────────────────────────────
// Three pure functions that project the engine's three focus sources
// (perception view / UIA / CDP) into the same `ElementInfo` shape so
// the bit-equal contract is mechanically pinned by
// `tests/unit/desktop-state-focus-builder.test.ts`. The runtime
// fallback chain (view → UIA → CDP for Chromium, view → UIA for
// non-Chromium) lives in `desktopStateHandler` below.

/**
 * `ElementInfo` shape returned in `desktop_state.focusedElement` /
 * `desktop_state.cursorOverElement`. Optional fields are omitted
 * (not `undefined`-valued) so `JSON.stringify` produces the same
 * keys regardless of which source produced the row.
 */
export interface ElementInfo {
  name: string;
  type: string;
  value?: string;
  automationId?: string;
}

/**
 * Project an engine-perception `latest_focus` view row into
 * `ElementInfo`. `controlType` arrives pre-stringified from
 * `crate::uia::control_type_name`, so the output is bit-equal with
 * `buildElementInfoFromUia`'s output for the same logical element.
 *
 * The view's `automationId` is `null` (not `undefined`) when absent,
 * because napi-rs serialises `Option::None` as `null`. We collapse
 * that into "field omitted" to match the UIA / CDP paths' shape.
 *
 * The view doesn't currently carry the UIA `ValuePattern` value
 * (the engine-perception `UiElementRef` doesn't include it), so
 * the `value` field is never set on the view-derived shape. UIA
 * fallback is responsible for filling it when the agent needs the
 * editable contents of an Edit control.
 */
export function buildElementInfoFromView(focused: NativeFocusedElement): ElementInfo {
  return {
    name: focused.name,
    type: focused.controlType,
    ...(focused.automationId ? { automationId: focused.automationId } : {}),
  };
}

/**
 * Project a UIA `getFocusedAndPointInfo` row into `ElementInfo`.
 * Identical shape to `buildElementInfoFromView`; the only structural
 * difference is the optional `value` (UIA exposes `ValuePattern`
 * via napi).
 */
export function buildElementInfoFromUia(focused: NativeUiaFocusInfo): ElementInfo {
  return {
    name: focused.name,
    type: focused.controlType,
    ...(focused.automationId ? { automationId: focused.automationId } : {}),
    ...(focused.value != null ? { value: focused.value } : {}),
  };
}

/**
 * Project a CDP `document.activeElement` snapshot into `ElementInfo`.
 * The CDP path doesn't expose UIA `automationId`; `type` is the
 * tag name (e.g. "INPUT") rather than a UIA control-type name.
 */
export function buildElementInfoFromCdp(cdp: {
  tag?: string;
  id?: string;
  name?: string;
  value?: string;
  text?: string;
}): ElementInfo {
  return {
    name: cdp.name || cdp.id || cdp.text || cdp.tag || "",
    type: cdp.tag ?? "Element",
    ...(cdp.value ? { value: cdp.value } : {}),
  };
}

/**
 * Read the engine-perception `latest_focus` view. Returns `null`
 * (so the caller falls back to UIA / CDP) when:
 *   - the addon doesn't expose `nativeViewFocus` (older builds),
 *   - the pipeline isn't initialised yet,
 *   - the slot is poisoned (Codex v9 P2-17 — failed shutdown),
 *   - or the view's `snapshot()` has nothing live yet.
 *
 * The `napi_safe_call` wrap on the Rust side (ADR-007 §3.4) means a
 * panic in the engine surfaces as a thrown napi error here; we
 * swallow it and fall through so the existing UIA / CDP path
 * stays the runtime safety net.
 */
function tryViewFocus(): NativeFocusedElement | null {
  try {
    return nativeViewFocus?.viewGetFocused?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a view-derived focused element should populate
 * `desktop_state.focusedElement`, or whether the caller should
 * fall through to the UIA / CDP path. Combines three filters that
 * together pin parity with the existing UIA branch's accept rules:
 *
 * 1. **Empty `name`** → reject (Codex review v17 P2). Both the
 *    Chromium and non-Chromium UIA branches gate on
 *    `focused?.name`, so a UIA-source row with an empty name
 *    falls through to CDP / `null` rather than publishing. Without
 *    this check, the view-first path would surface `name: ""`
 *    rows that the old path would have skipped — bit-equal
 *    violation. (Note: empty-name rows are not common in practice
 *    — the focus_pump's `payload.after?.name?` filter already
 *    drops most of them — but they're still possible for some
 *    UIA providers, so the parity guard is required.)
 *
 * 2. **Chromium foreground + `controlType === "Pane"`** → reject
 *    (Codex review v3 P1-3 / Opus phase-boundary review 2026-04-30
 *    P1-A). When Chrome / Edge is the foreground app, UIA's focus
 *    query returns the top-level Chrome `Pane` element rather
 *    than the actual focused DOM node, and the existing UIA branch
 *    filters it out so the fallback can read
 *    `document.activeElement` via CDP. The view sees the same UIA
 *    event stream and can surface the same Pane — without this
 *    filter the view-first path would publish the Pane while the
 *    old path would have skipped to CDP. Non-Chromium foreground
 *    accepts Pane (Word document area is a legitimate Pane to
 *    focus, and the UIA branch there also accepts it).
 *
 * 3. **`focused.windowTitle` must match the current `fgTitle`**
 *    (Codex review v17 P1). The Rust `view_get_focused` returns
 *    the latest GLOBALLY focused element from `latest_focus`. If
 *    a foreground switch has just happened the view may still
 *    hold the previous window's row before `focus_pump` has
 *    delivered the new event — accepting that stale row would
 *    publish state for the wrong window while UIA / CDP would
 *    have queried the new foreground. Strict equality with the
 *    enumerated foreground title rejects the stale row and lets
 *    the cascade fall through; the next call (after focus_pump
 *    catches up) will see them match. An empty `fgTitle` rejects
 *    too (no foreground enumerated → unsafe to publish view-side
 *    state).
 */
export function shouldAcceptViewFocus(
  focused: NativeFocusedElement,
  isChromium: boolean,
  fgTitle: string,
): boolean {
  if (!focused.name) return false;
  if (isChromium && focused.controlType === "Pane") return false;
  if (!fgTitle || focused.windowTitle !== fgTitle) return false;
  return true;
}



// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const desktopStateSchema = {
  // Phase 4: optional response-field expansion absorbing get_cursor_position /
  // get_screen_info / get_document_state. Default off — keeps the cheap
  // baseline observation cost at ~1 UIA + 1 EnumWindows. Enable on demand.
  includeCursor: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a richer `cursor` field with monitor index alongside the lightweight `cursorPos`. " +
      "Phase 4: absorbs former get_cursor_position. Default false."
    ),
  includeScreen: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a `screen` field with all connected display info (resolution, position, DPI, scale). " +
      "Phase 4: absorbs former get_screen_info. Default false. Use the displayId values returned here in screenshot / window_dock(action='dock')."
    ),
  includeDocument: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a `document` field with the focused Chrome tab's url, title, readyState, selection, and scroll position via CDP. " +
      "Phase 4: absorbs former get_document_state. Default false. Requires browser_open (CDP active); silently omitted on non-Chromium foreground."
    ),
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(`CDP port for includeDocument (default ${_defaultPort}).`),
  tabId: z.string().optional().describe("Optional CDP tab id for includeDocument; omit for the focused tab."),
};

export const getHistorySchema = {
  n: z.coerce.number().int().min(1).max(20).default(5).describe("Number of recent action records to return (max 20)."),
};

export const getDocumentStateSchema = {
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(`CDP port (default ${_defaultPort}).`),
  tabId: z.string().optional().describe("CDP tab id (omit for first page)."),
};

// ─────────────────────────────────────────────────────────────────────────────
// desktop_state — OS + App level (lightweight)
// ─────────────────────────────────────────────────────────────────────────────

export const desktopStateHandler = async (args: {
  includeCursor?: boolean;
  includeScreen?: boolean;
  includeDocument?: boolean;
  port?: number;
  tabId?: string;
} = {}): Promise<ToolResult> => {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive) ?? null;
    const cursor = await mouse.getPosition().catch(() => ({ x: 0, y: 0 }));

    let focusedWindow: { title: string; processName: string; hwnd: string } | null = null;
    let cursorOverWindow: { title: string; hwnd: string } | null = null;

    if (fg) {
      const pid = getWindowProcessId(fg.hwnd);
      const ident = getProcessIdentityByPid(pid);
      focusedWindow = { title: fg.title, processName: ident.processName, hwnd: String(fg.hwnd) };
    }

    // ── Attention signal from Hot Target Cache ─────────────────────────────
    // Look up the focused window in the hot-target-cache. If a slot exists,
    // surface its attention value. Fallback to "ok" when no slot is found
    // (lens not registered / Auto Perception OFF) — this is the safe baseline
    // per design §3.1.
    let attention: AttentionState = "ok";
    if (fg) {
      const fgHwnd = String(fg.hwnd);
      const slots = getSlotSnapshot();
      const matchingSlot = slots.find(
        (s) => s.kind === "window" && s.identity && "hwnd" in s.identity && s.identity.hwnd === fgHwnd
      );
      if (matchingSlot) {
        // Map SlotAttention → AttentionState (7 enum values in design §3.1)
        const sa = matchingSlot.attention;
        if (sa === "ok" || sa === "changed" || sa === "dirty" || sa === "stale" || sa === "identity_changed") {
          attention = sa;
        } else if (sa === "not_found") {
          attention = "guard_failed";
        } else {
          // "ambiguous" → ok (conservative safe baseline)
          attention = "ok";
        }
      }
    }

    // Cursor-over-window: Z-order hit test (cheap, always available)
    for (const w of wins) {
      const r = w.region;
      if (
        cursor.x >= r.x && cursor.x < r.x + r.width &&
        cursor.y >= r.y && cursor.y < r.y + r.height
      ) {
        cursorOverWindow = { title: w.title, hwnd: String(w.hwnd) };
        break;
      }
    }

    // Modal heuristic — title-substring detection.
    let hasModal = false;
    for (const w of wins) {
      if (MODAL_RE.test(w.title)) { hasModal = true; break; }
    }

    // ── Semantic level: focusedElement + cursorOverElement ─────────────────
    const fgTitle = fg?.title ?? "";
    const isChromium = CHROMIUM_TITLE_RE.test(fgTitle);

    // `ElementInfo` is hoisted to the top of the file (line 64) so
    // `buildElementInfo*` helpers and the unit test can share the
    // type. The local declaration that used to live here was
    // identical and has been removed.

    let focusedElement: ElementInfo | null = null;
    let cursorOverElement: ElementInfo | null = null;
    const hints: Record<string, unknown> = {};

    // D2-B-2: try the engine-perception `latest_focus` view first
    // (`view_get_focused` napi binding from PR #96). The view returns
    // null when the slot is poisoned (Codex v9 P2-17), uninitialised,
    // or empty; in any of those cases we fall through to the existing
    // UIA / CDP fallback paths so production behaviour is identical
    // to before whenever the view path is unavailable. The
    // `controlType` field comes pre-stringified from
    // `crate::uia::control_type_name`, so `buildElementInfoFromView`
    // produces an `ElementInfo` shape that's bit-equal to the UIA
    // path's output (verified by the `desktop-state-focus-builder`
    // unit test).
    //
    // `shouldAcceptViewFocus` mirrors the Chromium-foreground Pane
    // filter the UIA branch applies — see the helper's docs and
    // Opus phase-boundary review 2026-04-30 P1-A. Without it, the
    // view-first path would surface the Chrome top-level Pane while
    // the old path would have skipped to CDP `document.activeElement`,
    // breaking bit-equal.
    const viewFocused = tryViewFocus();
    if (viewFocused && shouldAcceptViewFocus(viewFocused, isChromium, fgTitle)) {
      focusedElement = buildElementInfoFromView(viewFocused);
      hints.focusedElementSource = "view";
    }

    if (isChromium) {
      hints.chromiumGuard = true;
      // cursorOverElement is always null for Chromium (no cheap UIA hit-test).
      // focusedElement: view (above) → UIA → CDP document.activeElement.
      let uiaFocusOk = focusedElement !== null;
      if (!uiaFocusOk) {
        try {
          const { focused } = await getFocusedAndPointInfo(cursor.x, cursor.y, false, 1500);
          if (focused?.name && focused.controlType !== "Pane") {
            focusedElement = buildElementInfoFromUia(focused);
            hints.focusedElementSource = "uia";
            uiaFocusOk = true;
          }
        } catch {
          // UIA unavailable — proceed to CDP fallback below
        }
      }
      if (!uiaFocusOk) {
        // CDP fallback
        try {
          const cdpInfo = await evaluateInTab(
            `(function(){
              var el=document.activeElement;
              if(!el||el===document.body)return null;
              return {tag:el.tagName,id:el.id,name:el.name||el.getAttribute('name')||'',
                      value:(el.value!==undefined?String(el.value).slice(0,60):''),
                      text:(el.innerText||el.textContent||'').slice(0,60)};
            })()`,
            null,
            _defaultPort
          ) as { tag?: string; id?: string; name?: string; value?: string; text?: string } | null;
          if (cdpInfo) {
            focusedElement = buildElementInfoFromCdp(cdpInfo);
            hints.focusedElementSource = "cdp";
          }
        } catch {
          hints.cdpUnavailable = true;
        }
      }
    } else {
      // Non-Chromium: view (above) → UIA. `cursorOverElement` always
      // comes from UIA — the view doesn't carry an at-point read.
      const needUiaFocus = focusedElement === null;
      try {
        const { focused, atPoint } = await getFocusedAndPointInfo(cursor.x, cursor.y, true, 2000);
        if (needUiaFocus && focused?.name) {
          focusedElement = buildElementInfoFromUia(focused);
          hints.focusedElementSource = "uia";
        }
        if (atPoint?.name) {
          cursorOverElement = {
            name: atPoint.name,
            type: atPoint.controlType,
            ...(atPoint.automationId ? { automationId: atPoint.automationId } : {}),
          };
        }
      } catch {
        hints.uiaStale = true;
      }
    }

    // pageState
    let pageState: "ready" | "loading" | "dialog" = hasModal ? "dialog" : "ready";
    if (isChromium && !hasModal) {
      try {
        const state = await evaluateInTab("document.readyState", null, _defaultPort);
        if (state !== "complete") pageState = "loading";
      } catch {
        // CDP not connected — leave as "ready"
      }
    }

    // ── Phase 4 optional response-field expansion ─────────────────────────
    // Only the requested fields are computed — keeps the cheap baseline cost
    // for unflagged callers.
    const extra: Record<string, unknown> = {};

    if (args.includeCursor) {
      // Look up which monitor contains the cursor for richer context than the
      // bare cursorPos {x,y} that's always returned.
      const monitors = enumMonitors();
      const containing = monitors.find(
        (m) =>
          cursor.x >= m.bounds.x &&
          cursor.x < m.bounds.x + m.bounds.width &&
          cursor.y >= m.bounds.y &&
          cursor.y < m.bounds.y + m.bounds.height,
      );
      extra.cursor = {
        x: cursor.x,
        y: cursor.y,
        monitorId: containing?.id,
      };
    }

    if (args.includeScreen) {
      const monitors = enumMonitors();
      extra.screen = {
        virtualScreen: getVirtualScreen(),
        displays: monitors.map((m) => ({
          id: m.id,
          primary: m.primary,
          bounds: m.bounds,
          workArea: m.workArea,
          dpi: m.dpi,
          scale: `${m.scale}%`,
        })),
        displayCount: monitors.length,
        primaryIndex: monitors.findIndex((m) => m.primary),
      };
    }

    // Phase 4: includeDocument honours an explicit tabId even when the
    // foreground window is not Chromium — the legacy get_document_state took
    // (port, tabId) and never consulted foreground state, so privatizing it
    // without preserving that capability would regress workflows that inspect
    // a background tab. Only fall back to the foreground/CDP path when no
    // tabId was provided. (Codex PR #41 P1.)
    if (args.includeDocument) {
      const tabExplicit = args.tabId !== undefined && args.tabId !== "";
      if (tabExplicit || isChromium) {
        try {
          const expression = `(function(){return{url:location.href,title:document.title,readyState:document.readyState,selection:(window.getSelection&&String(window.getSelection()))||"",scroll:{x:window.scrollX,y:window.scrollY,maxY:Math.max(0,document.documentElement.scrollHeight-window.innerHeight)},viewport:{w:window.innerWidth,h:window.innerHeight}};})()`;
          extra.document = await evaluateInTab(expression, args.tabId ?? null, args.port ?? _defaultPort);
        } catch (err) {
          // Silently omit on CDP failure (no port / tab not found) — caller can
          // diagnose via browser_open or fall through to screenshot/desktop_discover.
          hints.documentUnavailable = err instanceof Error ? err.message.slice(0, 120) : "cdp_error";
        }
      } else {
        // includeDocument requested but foreground is non-Chromium and no
        // tabId was supplied — surface the precondition so the caller can
        // either open a tab or pass tabId explicitly.
        hints.documentUnavailable = "non-chromium foreground; pass tabId to inspect a specific tab";
      }
    }

    return ok({
      focusedWindow,
      cursorPos: { x: cursor.x, y: cursor.y },
      cursorOverWindow,
      focusedElement,
      cursorOverElement,
      hasModal,
      pageState,
      attention,
      visibleWindows: wins.length,
      ...extra,
      ...(Object.keys(hints).length > 0 ? { hints } : {}),
    });
  } catch (err) {
    return failWith(err, "desktop_state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_history — recent action posts ring buffer
// ─────────────────────────────────────────────────────────────────────────────

export const getHistoryHandler = async ({ n }: { n: number }): Promise<ToolResult> => {
  try {
    const items = getHistorySnapshot(n);
    // D-5a: include 3 most recent target keys (not bloating with full events — v3 §10.6)
    const recentTargetKeys = listRecentTargetKeys(3);
    return ok({ count: items.length, actions: items, ...(recentTargetKeys.length > 0 && { recentTargetKeys }) });
  } catch (err) {
    return failWith(err, "get_history");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_document_state — Chrome via CDP
// ─────────────────────────────────────────────────────────────────────────────

export const getDocumentStateHandler = async ({ port, tabId }: { port: number; tabId?: string }): Promise<ToolResult> => {
  try {
    const expression = `
(function() {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    selection: (window.getSelection && String(window.getSelection())) || "",
    scroll: { x: window.scrollX, y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
})()
`;
    const r = await evaluateInTab(expression, tabId ?? null, port);
    return ok(r);
  } catch (err) {
    return failWith(err, "get_document_state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

// PR #112 Round 1 P1 fix (Codex + Opus): wrap once at module scope so
// `server.tool` registration AND `run_macro` dispatcher (`./macro.ts`)
// share the SAME wrapped handler + schema. Without this, macro 経路は
// `desktopStateSchema` を直接 z.object(...) で parse して include を
// strip するので per-call `include:["envelope"]` は機能不能 (Opus P1-1)。
//
// `fetchMeta` reads L1 event wallclock + view-poisoned signal via the
// `viewGetFocusedWithWallclock()` napi binding (S3-2). Defensive paths:
// - napi surface missing (non-Windows / native build absent): return
//   `(false, null)` → `buildEnvelope` falls back to `Date.now()` +
//   `confidence: degraded` so LLM clients detect approximation.
// - napi call throws: same fallback path (try/catch).
const fetchEnvelopeMeta = async () => {
  if (
    nativeViewFocus &&
    typeof nativeViewFocus.viewGetFocusedWithWallclock === "function"
  ) {
    try {
      const meta = nativeViewFocus.viewGetFocusedWithWallclock();
      // `latestEventWallclockMs` is napi-rs `Option<u64>` and may be
      // **omitted** (key absent) when no event observed yet — NOT just
      // `=== null`. `meta.latestEventWallclockMs != null` covers both
      // `undefined` (omission) and a hypothetical future explicit `null`
      // (PR #108 same-pattern guard, memory `feedback_napi_default_export.md`).
      return {
        viewPoisoned: meta.viewPoisoned,
        asOfWallclockMs:
          meta.latestEventWallclockMs != null
            ? Number(meta.latestEventWallclockMs)
            : null,
      };
    } catch {
      // Napi call failed at runtime: degrade to Date.now() fallback
      // + confidence: degraded so LLM clients can detect.
      return { viewPoisoned: true, asOfWallclockMs: null };
    }
  }
  return { viewPoisoned: false, asOfWallclockMs: null };
};

/**
 * `desktop_state` registration schema with `include?: string[]` injected
 * (PR #112 Round 1 P1 fix). Tool source files don't declare `include`
 * themselves (ADR-010 §1.5 spirit) — the L5 wrapper helper owns both
 * schema injection and runtime peek+strip.
 *
 * Used by:
 * - `registerDesktopStateTools` (this file)
 * - `./macro.ts` `TOOL_REGISTRY.desktop_state` (so `run_macro` dispatcher
 *   sees the same schema and `include` survives its `z.object(...).parse()`)
 */
export const desktopStateRegistrationSchema = withEnvelopeIncludeSchema(desktopStateSchema);

/**
 * S5 caused_by + based_on projector for `desktop_state` (sub-plan §2.5
 * production wiring). Triggered only when `include=["causal"]` opt-in.
 *
 * Sentinel guard runtime path (Round 3 P1 Opus + Codex 重複 fix): when
 * `getSessionId` returns `"multi:disabled"` (multi-LLM-client detected),
 * immediately return `undefined` — cross-session caused_by leak prevented
 * before history buffer lookup.
 *
 * ViewSnapshot build:
 *   - focus = `viewGetFocused()` (S3-2 既存) → name + hwnd
 *   - dirtyRectsByMonitor = `viewGetDirtyRects(monitor_index)` per known
 *     monitor (S2 既存); single-monitor-only fallback when monitor enum
 *     unavailable (best-effort)
 *   - latestEventId = `l1GetCaptureStats().eventIdHighWater` (既存 OQ #5
 *     resolve、新 binding 不要)
 *   - queryWallclockMs = `Date.now()` at projector invocation
 */
const desktopStateCausedByProjector = async (
  _args: unknown,
  sessionId: string,
): Promise<{ causedBy?: CausedByShape; basedOn?: BasedOnShape; forceDegraded?: boolean } | undefined> => {
  // Round 3 P1 (Opus + Codex 重複) sentinel guard: multi-session detect → skip
  if (sessionId === "multi:disabled") return undefined;
  // Round 2 P2 (Opus #2) fix: when `nativeL1` is unavailable (non-Windows
  // dev / pre-P5a binary), `latestEventId` would be `undefined` and the
  // causal window's frontier check (a) would silently skip — falling
  // back to the monotonic timeout (b) alone.
  //
  // Round 3 P2 fix (Codex line 655): also surface this via
  // `confidence: degraded` so LLM clients can distinguish "causal
  // requested but unavailable" from "causal not requested". Without
  // forceDegraded, an `include=["causal"]` request when nativeL1 is
  // null would return a fresh-confidence envelope with neither
  // caused_by nor based_on, indistinguishable from a healthy
  // raw-shape response that just happens to have no commits in the
  // causal window — masking the missing telemetry binding from the
  // LLM.
  if (!nativeL1 || typeof nativeL1.l1GetCaptureStats !== "function") {
    return { forceDegraded: true };
  }

  // L3 latest_focus view → focus delta projection input
  let focus: { hwnd: bigint | null; elementName: string | null } | null = null;
  try {
    if (nativeViewFocus && typeof nativeViewFocus.viewGetFocused === "function") {
      const f = nativeViewFocus.viewGetFocused();
      if (f) {
        focus = { hwnd: null, elementName: f.name ?? null };
      }
    }
  } catch {
    // view unavailable — caused_by reflects "no focus observed" via produced_changes
  }

  // L3 dirty_rects_aggregate per-monitor count, monitor_index 維持 (PR #102 同型)
  const dirtyRectsByMonitor = new Map<number, number>();
  try {
    if (nativeViewFocus && typeof nativeViewFocus.viewGetDirtyRects === "function") {
      // Best-effort: enumerate primary + secondary monitors via enumMonitors,
      // fall back to single primary (monitor_index=0) when enumeration fails.
      let monitorIndices: number[] = [0];
      try {
        const monitors = enumMonitors();
        if (monitors && monitors.length > 0) {
          monitorIndices = monitors.map((_, i) => i);
        }
      } catch {
        // enumMonitors failed — keep [0] fallback
      }
      for (const monitorIdx of monitorIndices) {
        try {
          const rects = nativeViewFocus.viewGetDirtyRects(monitorIdx);
          if (rects && rects.latest && rects.latest.count !== undefined) {
            dirtyRectsByMonitor.set(monitorIdx, Number(rects.latest.count));
          }
        } catch {
          // per-monitor lookup failed — skip this monitor
        }
      }
    }
  } catch {
    // dirty rect view unavailable — caused_by produced_changes will lack dirty_rects entries
  }

  // L1 ring 末尾 event_id (OQ #5 既存 binding reuse、新規不要)
  let latestEventId: bigint | undefined;
  try {
    if (nativeL1 && typeof nativeL1.l1GetCaptureStats === "function") {
      const stats = nativeL1.l1GetCaptureStats();
      latestEventId = stats.eventIdHighWater;
    }
  } catch {
    // L1 stats unavailable — frontier check skipped, history buffer wallclock
    // alone determines window (degraded mode)
  }

  const snapshot: ViewSnapshot = {
    focus,
    dirtyRectsByMonitor,
    latestEventId,
    queryWallclockMs: Date.now(),
  };
  return {
    causedBy: buildCausedBy(sessionId, snapshot),
    basedOn: buildBasedOn(sessionId, snapshot),
  };
};

/**
 * S5 sessionId resolver for `desktop_state` (sub-plan §1.1 E-2 + §2.5).
 *
 * Stub helpers `getMcpTransportSessionId()` returns `undefined` and
 * `isSingleSessionPrototype()` returns `true` — these are pin-points for
 * ADR-011 to finalize. Current S5 trunk skeleton ships single-LLM-client
 * prototype only; multi-LLM-client deploy requires ADR-011 transport
 * context wiring before the `getMcpTransportSessionId()` stub is replaced.
 *
 * Round 2 P3 (Opus #2) test seam: `_setSingleSessionPrototypeForTest`
 * lets unit tests pin the `multi:disabled` sentinel branch without
 * patching module internals. CodeQL line 725 dead-code alert
 * (`if (!isSingleSessionPrototype())` always false in current stub
 * impl) is **intentional** — the stub returns `true` to gate the
 * sentinel branch off until ADR-011 wires real multi-session
 * detection. The test seam exposes the branch for runtime coverage.
 */
let _isSingleSessionPrototype: () => boolean = () => true;

const getMcpTransportSessionId = (): string | undefined => undefined;

/** @internal Test-only — pin the single-session prototype gate for the
 *  `multi:disabled` sentinel branch (sub-plan §1.1 E-2). Round 3 P3 fix
 *  (CodeQL line 745): unused `isSingleSessionPrototype` wrapper removed,
 *  callers go directly through the module-private `_isSingleSessionPrototype`
 *  closure (used by `desktopStateGetSessionId` below). */
export function _setSingleSessionPrototypeForTest(value: boolean): void {
  _isSingleSessionPrototype = () => value;
}
/** @internal Test-only — restore the production stub. */
export function _resetSingleSessionPrototypeForTest(): void {
  _isSingleSessionPrototype = () => true;
}

const desktopStateGetSessionId = (_args: unknown): string => {
  // CodeQL alert #109 (`js/unneeded-defensive-code`) flags the
  // `transportSessionId !== undefined` guard below as dead at runtime
  // because the `getMcpTransportSessionId` stub on line 747 returns
  // `undefined` unconditionally. The alert is **dismissed** as
  // "Won't fix" via GitHub Code Scanning API (PR #120). Inline
  // suppress comments (e.g. `// codeql[...]`) are NOT recognised by
  // GitHub's CodeQL action — that syntax was a legacy LGTM platform
  // feature, sunset in 2022-12. The runtime guard is preserved as
  // an **ADR-011-scope-protected** future-ready stub: ADR-011
  // (cognitive memory taxonomy + multi-session session_id source
  // finalize) will replace the stub with a real resolver that
  // returns the MCP transport's session id, at which point this
  // branch becomes live. Removing the guard now would require
  // re-introducing it in ADR-011 and re-validating the closed-loop
  // sentinel runtime path pinned by PR #115 across 3 review rounds
  // (see `docs/adr-010-p1-s5-plan.md` §1.1 E-2 for the sentinel
  // contract definition).
  const transportSessionId = getMcpTransportSessionId();
  if (transportSessionId !== undefined) return transportSessionId;
  if (!_isSingleSessionPrototype()) {
    // Multi-session detected → sentinel disables caused_by injection
    return "multi:disabled";
  }
  return "default"; // single-LLM-client prototype (S5 trunk scope)
};

/**
 * Envelope-aware `desktop_state` handler. Wraps `desktopStateHandler`
 * with `makeQueryWrapper` (S4 query-axis wrapper extended for S5 with
 * `include=["causal"]` opt-in causedByProjector). Used by both
 * `server.tool` and `run_macro` registration sites (PR #112 Opus P1-1).
 *
 * S5 wiring (sub-plan §2.5):
 *   - `getSessionId` resolves transport session → `"default"` fallback or
 *     `"multi:disabled"` sentinel (sub-plan §1.1 E-2)
 *   - `causedByProjector` builds ViewSnapshot from existing napi bindings
 *     (no new binding per OQ #5 resolve), invokes `buildCausedBy` +
 *     `buildBasedOn` in parallel, returns `{ causedBy, basedOn }` (or
 *     `undefined` on sentinel guard)
 *   - When `include` does NOT contain `"causal"`, the projector is not
 *     invoked — existing raw client compat default opt-out (sub-plan §3.6
 *     G5-S5-7)
 */
export const desktopStateRegistrationHandler = makeQueryWrapper(
  desktopStateHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "desktop_state",
  {
    fetchMeta: fetchEnvelopeMeta,
    getSessionId: desktopStateGetSessionId,
    causedByProjector: desktopStateCausedByProjector,
  }
);

export function registerDesktopStateTools(server: McpServer): void {
  // PR #112 Round 1 P1 (Codex + Opus + user review): pass the module-scope
  // `desktopStateRegistrationSchema` (`include` injected via
  // `withEnvelopeIncludeSchema`) and `desktopStateRegistrationHandler`
  // (envelope-aware wrapper) so `run_macro` dispatcher reuses the SAME
  // wrapped instances (Opus P1-1 同型 strip risk for macro path).
  // Comments live OUTSIDE the call so the stub-catalog generator's
  // bare-identifier regex sees clean args[2] / args[3].
  server.tool(
    "desktop_state",
    buildDesc({
      purpose:
        "Read-only observation of the current desktop state. Returns focused window/element, modal flag, attention signal from Auto Perception. " +
        "Phase 4 absorbs former get_active_window / get_cursor_position / get_screen_info / get_document_state via include* flags.",
      details:
        "Always returns: focusedWindow (title, hwnd, processName), focusedElement (name, type, value, automationId), cursorPos {x,y}, cursorOverElement (name, type), cursorOverWindow, hasModal (boolean), pageState ('ready'|'loading'|'dialog'), attention, visibleWindows count. " +
        "Optional fields (default off): " +
        "includeCursor:true → cursor {x,y,monitorId} (richer than cursorPos). " +
        "includeScreen:true → screen {virtualScreen, displays[], displayCount, primaryIndex}. " +
        "includeDocument:true → document {url, title, readyState, selection, scroll, viewport} via CDP (silently omitted on non-Chromium foreground). " +
        "Chromium: cursorOverElement is null (UIA sparse); focusedElement may fall back to CDP document.activeElement; hints.focusedElementSource reports which path produced the row ('view' = engine-perception latest_focus, 'uia' = direct UIA query, 'cdp' = document.activeElement). " +
        "Does NOT enumerate descendants — use desktop_discover for actionable entity list and window list.",
      prefer:
        "Use after each action to confirm state. Cheapest observation tool — cheaper than any screenshot. " +
        "attention='ok' means safe to proceed; other values require recovery (see suggest[]). " +
        "Set include* flags only when you need the extra data (each adds one syscall or CDP round-trip).",
      caveats:
        "Cannot detect non-UIA elements (custom-drawn UIs, game overlays). hasModal only detects modal dialogs exposed via UIA — browser alert/confirm dialogs may not appear here. " +
        "includeDocument requires browser_open (CDP active); silently omitted otherwise with hints.documentUnavailable.",
    }),
    desktopStateRegistrationSchema,
    desktopStateRegistrationHandler as typeof desktopStateHandler
  );

  // Phase 4: get_history / get_document_state privatized — handlers retained
  // as internal exports. get_history is debug-only; get_document_state is now
  // reachable via desktop_state({includeDocument:true}).
  // (memory: feedback_disable_via_entry_block.md)
}
