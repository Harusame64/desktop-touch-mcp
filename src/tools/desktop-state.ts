import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { mouse } from "../engine/nutjs.js";
import {
  enumWindowsInZOrder,
  enumMonitors,
  getVirtualScreen,
  getWindowProcessId,
  getProcessIdentityByPid,
  getWindowIdentity,
} from "../engine/win32.js";
import { getHistorySnapshot } from "./_post.js";
import { listRecentTargetKeys } from "../engine/perception/target-timeline.js";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import { nativeViewFocus, nativeWin32 } from "../engine/native-engine.js";
import type {
  NativeFocusedElement,
  NativeUiaFocusInfo,
} from "../engine/native-types.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import { getSlotSnapshot } from "../engine/perception/hot-target-cache.js";
import type { AttentionState } from "../engine/perception/types.js";
import { isUiaCacheStale } from "../engine/identity-tracker.js";
import {
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  genericQueryCausedByProjector,
  type CausedByShape,
  type BasedOnShape,
} from "./_envelope.js";
import {
  getMcpTransportSessionIdFromContext,
  isSingleSessionPrototype,
  _setSingleSessionPinForTest,
  _resetSingleSessionPinForTest,
} from "./_session-context.js";

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

/**
 * Window class names that REAL browsers (Chrome / Edge / Firefox / Brave /
 * etc.) AND Electron / CEF embedded apps (VS Code / Discord / Slack /
 * Cursor / Claude Desktop / Obsidian / …) share. Used together with
 * `isBrowserProcessName(processName)` below to gate the `hasModal`
 * heuristic — class match alone is NOT sufficient because most Electron
 * apps also report `Chrome_WidgetWin_1`. Exported so a unit test can pin
 * the contract.
 *
 * - `Chrome_WidgetWin_1` — Chromium's widget class (Chrome / Edge / Brave /
 *   Opera / Vivaldi / Arc / Thorium + every Electron / CEF app).
 * - `MozillaWindowClass` — Firefox-derived browsers (Firefox / Waterfox /
 *   LibreWolf / Tor Browser).
 */
const BROWSER_TOP_LEVEL_CLASSES = new Set<string>([
  "Chrome_WidgetWin_1",
  "MozillaWindowClass",
]);

export function isBrowserTopLevelClass(className: string | undefined): boolean {
  return className !== undefined && BROWSER_TOP_LEVEL_CLASSES.has(className);
}

/**
 * Process names of REAL browser executables (case-insensitive, no `.exe`).
 * Matches `getProcessIdentityByPid().processName` shape (which strips the
 * extension per its TSDoc, e.g. `chrome.exe` → `chrome`). Together with
 * `isBrowserTopLevelClass` this isolates the "browser tab title accidentally
 * matches MODAL_RE" false positive from genuine Electron / CEF app modals
 * (Codex P1 review on PR #324: VS Code etc. would otherwise be unable to
 * raise `hasModal:true`).
 *
 * Lowercase only; compare via `processName.toLowerCase()`.
 */
const BROWSER_PROCESS_NAMES = new Set<string>([
  "chrome",
  "msedge",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "arc",
  "thorium",
  "iexplore",
  "waterfox",
  "librewolf",
]);

export function isBrowserProcessName(processName: string | undefined): boolean {
  return processName !== undefined && BROWSER_PROCESS_NAMES.has(processName.toLowerCase());
}

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


// ─── ADR-017: sessionContext classifier + locked heuristic ───────────────────
//
// `desktop_state({ includeSessionContext: true })` (or the equivalent
// `include: ['sessionContext']` keyword route — translated at the registration
// site by `desktopStateRegistrationHandlerWithIncludeRoute` below) surfaces a
// 5-field block derived from three native bindings
// (`win32GetProcessSessionId` / `win32GetActiveConsoleSessionId` /
// `wtsEnumerateSessions`).
//
// ADR-017 §3.2 — the `'locked'` heuristic is **derived in the TS layer**, not
// in Win32: there is no admin-free, event-free way to read `LockWorkStation`
// state. We require all three:
//
//   1. Native `sessionState === 'active'`  (rules out disconnected etc.)
//   2. `GetForegroundWindow() === null`     (no input desktop is ours)
//   3. The previous `desktop_state` call within the last 60s observed a
//      non-null foreground — i.e. we transitioned NULL, we are not "always
//      NULL" (which would more likely indicate a session-start race than a
//      lock).
//
// Conservative-by-default: a false-negative (missing a lock) just yields
// `sessionState: 'active'` and the LLM keeps treating input as live; a
// false-positive would mislead it into deferring input. We err on
// false-negative.

/** ADR-017 §2.1.2 on-wire shape. Discriminated-union. */
export type SessionContextOrigin = { kind: "local"; sessionId: number };

export interface SessionContext {
  origin: SessionContextOrigin;
  /** Active console session id, or null when `WTSGetActiveConsoleSessionId`
   *  returned `0xFFFFFFFF` (no user signed in at the physical console). */
  consoleSessionId: number | null;
  sessionLabel: "console" | "rdp" | "other";
  sessionState:
    | "active"
    | "connected"
    | "disconnected"
    | "locked"
    | "unknown";
  /** Win-station name reported by `WTSEnumerateSessions` for the calling
   *  session — e.g. `"Console"` / `"RDP-Tcp#0"`. Empty when WTS enumeration
   *  failed (locked-down corporate token, low-resource). */
  ownWinStation: string;
}

/** Module-scoped cache that the locked heuristic uses to detect the
 *  NULL-foreground transition. Reset before every call so consumers see a
 *  consistent value, and updated AFTER reading so the *previous* sample is
 *  what feeds the heuristic. */
interface SessionLockCache {
  wallclockMs: number;
  foregroundHwnd: bigint | null;
}
let _sessionLockCache: SessionLockCache | null = null;

/** @internal Test seam — clears the locked-heuristic cache so unit tests
 *  can pin the "first call, no prior sample" branch deterministically. */
export function _resetSessionLockCacheForTest(): void {
  _sessionLockCache = null;
}

/** @internal Test seam — primes the locked-heuristic cache to simulate a
 *  prior `desktop_state` call N ms ago that saw a non-null foreground. */
export function _setSessionLockCacheForTest(
  wallclockMs: number,
  foregroundHwnd: bigint | null,
): void {
  _sessionLockCache = { wallclockMs, foregroundHwnd };
}

/** Map a `wtsEnumerateSessions` row's `stateLabel` to the public
 *  `SessionContext.sessionState` discrete union. Maps `'connect_query'` and
 *  the more exotic states (shadow / idle / listen / reset / down / init /
 *  unknown `state_<n>`) to `'unknown'` because they have no useful
 *  interpretation in an LLM input-pause decision. The mapping is pinned by
 *  the unit test rather than hard-coded comments because the WTS enum
 *  could in principle gain new values. */
export function mapWtsStateToSessionState(
  stateLabel: string,
): Exclude<SessionContext["sessionState"], "locked"> {
  switch (stateLabel) {
    case "active":
      return "active";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    default:
      return "unknown";
  }
}

/** Pure classifier — given the three native readings plus the foreground
 *  HWND, return the full `SessionContext` shape with the locked heuristic
 *  applied. Splits cleanly from `buildSessionContext` so the unit test can
 *  drive every branch without spying on `nativeWin32` calls. The
 *  `previousSample` arg lets the test pin the locked heuristic's third
 *  condition independently of process state. */
export function classifySessionContext(input: {
  ownSessionId: number;
  consoleSessionIdRaw: number;
  ownWtsRow: { winStation: string; stateLabel: string } | null;
  foregroundHwnd: bigint | null;
  nowMs: number;
  previousSample: SessionLockCache | null;
}): SessionContext {
  const { ownSessionId, consoleSessionIdRaw, ownWtsRow, foregroundHwnd, nowMs, previousSample } =
    input;

  // 0xFFFFFFFF (`u32::MAX`) — Win32 sentinel for "no user at the console".
  // We surface it as `null` so it can never satisfy an equality test against
  // `ownSessionId`.
  const consoleSessionId =
    consoleSessionIdRaw === 0xffff_ffff ? null : consoleSessionIdRaw;

  // `sessionLabel` — three buckets per ADR-017 §2.1.2:
  let sessionLabel: SessionContext["sessionLabel"];
  if (consoleSessionId !== null && ownSessionId === consoleSessionId) {
    sessionLabel = "console";
  } else if (ownWtsRow && /^RDP-Tcp/.test(ownWtsRow.winStation)) {
    sessionLabel = "rdp";
  } else {
    sessionLabel = "other";
  }

  // `sessionState` from native, then maybe override to `'locked'`.
  const baseState: Exclude<SessionContext["sessionState"], "locked"> = ownWtsRow
    ? mapWtsStateToSessionState(ownWtsRow.stateLabel)
    : "unknown";

  // ADR-017 §3.2 — locked heuristic (3-of-3):
  //   1. native state is 'active'
  //   2. current foreground is null
  //   3. the previous sample within 60s observed a non-null foreground
  // The 60s window is generous so an idle LLM that calls `desktop_state` only
  // every ~30s still sees the transition.
  let sessionState: SessionContext["sessionState"] = baseState;
  if (
    baseState === "active" &&
    foregroundHwnd === null &&
    previousSample !== null &&
    previousSample.foregroundHwnd !== null &&
    nowMs - previousSample.wallclockMs <= 60_000
  ) {
    sessionState = "locked";
  }

  return {
    origin: { kind: "local", sessionId: ownSessionId },
    consoleSessionId,
    sessionLabel,
    sessionState,
    ownWinStation: ownWtsRow?.winStation ?? "",
  };
}

/** Read the three native session APIs + foreground HWND, fold into
 *  `SessionContext`, and update the locked-heuristic cache. Returns
 *  `null` when the native session bindings are unavailable (older `.node`
 *  build / non-Windows host) — caller surfaces a hint to that effect. */
export function buildSessionContext(): SessionContext | null {
  if (
    !nativeWin32 ||
    typeof nativeWin32.win32GetProcessSessionId !== "function" ||
    typeof nativeWin32.win32GetActiveConsoleSessionId !== "function" ||
    typeof nativeWin32.wtsEnumerateSessions !== "function" ||
    typeof nativeWin32.win32GetForegroundWindow !== "function"
  ) {
    return null;
  }
  const ownSessionIdRaw = nativeWin32.win32GetProcessSessionId(process.pid);
  if (ownSessionIdRaw == null) {
    return null;
  }
  const consoleSessionIdRaw = nativeWin32.win32GetActiveConsoleSessionId();
  const wtsRows = nativeWin32.wtsEnumerateSessions();
  const ownRow =
    wtsRows.find((r) => r.sessionId === ownSessionIdRaw) ?? null;
  const ownWtsRow = ownRow
    ? { winStation: ownRow.winStation, stateLabel: ownRow.stateLabel }
    : null;
  const foregroundHwnd = nativeWin32.win32GetForegroundWindow();
  const nowMs = Date.now();
  const previousSample = _sessionLockCache;

  const sessionContext = classifySessionContext({
    ownSessionId: ownSessionIdRaw,
    consoleSessionIdRaw,
    ownWtsRow,
    foregroundHwnd,
    nowMs,
    previousSample,
  });

  // Update the cache AFTER classification so the next call sees this sample
  // as its `previousSample`.
  _sessionLockCache = { wallclockMs: nowMs, foregroundHwnd };

  return sessionContext;
}


// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const desktopStateSchema = {
  // Phase 4: optional response-field expansion absorbing get_cursor_position /
  // get_screen_info / get_document_state. Default off — keeps the cheap
  // baseline observation cost at ~1 UIA + 1 EnumWindows. Enable on demand.
  includeCursor: coercedBoolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a richer `cursor` field with monitor index alongside the lightweight `cursorPos`. " +
      "Phase 4: absorbs former get_cursor_position. Default false."
    ),
  includeScreen: coercedBoolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a `screen` field with all connected display info (resolution, position, DPI, scale). " +
      "Phase 4: absorbs former get_screen_info. Default false. Use the displayId values returned here in screenshot / window_dock(action='dock')."
    ),
  includeDocument: coercedBoolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a `document` field with the focused Chrome tab's url, title, readyState, selection, and scroll position via CDP. " +
      "Phase 4: absorbs former get_document_state. Default false. Requires browser_open (CDP active); silently omitted on non-Chromium foreground."
    ),
  // ADR-017 — the boolean form. The equivalent `include: ['sessionContext']`
  // keyword route is translated into this flag by a thin registration shim,
  // so both forms surface the same `sessionContext` block.
  includeSessionContext: coercedBoolean()
    .optional()
    .default(false)
    .describe(
      "When true, add a `sessionContext` field with the Terminal Services session classification " +
      "(origin, consoleSessionId, sessionLabel: 'console'|'rdp'|'other', " +
      "sessionState: 'active'|'connected'|'disconnected'|'locked'|'unknown', ownWinStation). " +
      "Default false. Equivalent to `include: ['sessionContext']`. " +
      "Per ADR-017: observability-only — does not gate input. " +
      "`sessionState: 'locked'` is a heuristic (active + foreground=null + previous sample within 60s saw a non-null foreground); " +
      "treat it as a generic input-pause signal — it can also fire on secure-desktop transitions (UAC prompt, Credential UI), " +
      "where the user-visible state is not strictly 'locked' but input is equally unavailable to this session."
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
  includeSessionContext?: boolean;
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

      // Issue #295 — UIA cache stale upgrade. When the cached UIA snapshot for
      // this HWND has fully expired (`expiresInMs === 0`), the focused-element
      // / actionable[] views built from it can be out of date. Upgrade
      // `attention` to `'stale'` so the LLM does not act on the snapshot
      // without re-fetching. We only upgrade FROM `'ok'` — other attention
      // values already signal degradation and must not be downgraded.
      if (attention === "ok") {
        try {
          if (isUiaCacheStale(fg.hwnd)) {
            attention = "stale";
          }
        } catch { /* best effort — never block desktop_state on cache lookup */ }
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

    // Modal heuristic — title-substring detection with browser-tab exclusion.
    //
    // Title is checked first (cheap regex); the process-identity lookup runs
    // only for the rare windows that BOTH match `MODAL_RE` AND carry a
    // Chromium widget class. The exclusion fires only when the owning process
    // is a real browser executable (chrome / msedge / firefox / …) — Electron
    // / CEF apps (VS Code / Discord / Slack / …) share `Chrome_WidgetWin_1`
    // but their MODAL_RE-matching titles ARE modals and must keep raising
    // `hasModal: true` (Codex P1 review on PR #324).
    //
    // The false-positive being suppressed: a browser tab whose page title
    // happens to contain "通知" / "Save As" / "Error" / "警告" etc. is page
    // content, not a modal. Browsers render their own alert/confirm modals
    // inside the tab via CDP, never as a separate top-level window.
    //
    // Tested by `tests/unit/modal-detection-browser-exclusion.test.ts`.
    let hasModal = false;
    for (const w of wins) {
      if (!MODAL_RE.test(w.title)) continue;
      if (isBrowserTopLevelClass(w.className)) {
        // `getWindowIdentity` is an OpenProcess + QueryFullProcessImageName
        // pair (≈ tens of µs per call). The double gate above keeps this
        // out of the hot path — only runs for windows that BOTH match
        // MODAL_RE AND carry the Chromium widget class, typically 0-1
        // per desktop_state call.
        const identity = getWindowIdentity(w.hwnd);
        if (isBrowserProcessName(identity.processName)) continue;
      }
      hasModal = true;
      break;
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

    // Issue #245 系統②a: surface IME open-status on the focused window so
    // LLMs can detect "IME ON" before `keyboard(action='type')` and avoid
    // the silent-romaji-conversion failure. The IMM bridge returns `false`
    // when the target has no associated IME (ASCII layout / non-IME thread),
    // which matches the user-visible "no IME composition" state, so callers
    // can treat the boolean as a clean ON/OFF signal. The hint is omitted
    // (rather than set to `false`) when the addon predates the IMM bridge
    // — pairs cleanly with `nativeWin32`'s optional surface.
    if (fg && typeof nativeWin32?.win32GetImeOpenStatus === "function") {
      try {
        hints.imeOpen = nativeWin32.win32GetImeOpenStatus(BigInt(fg.hwnd));
      } catch {
        // IMM call failed (rare — e.g. window torn down mid-call). Leave
        // imeOpen unset rather than synthesising a false reading.
      }
    }

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

    // ADR-017 — session-aware desktop_state. The native session bindings
    // are #[cfg(windows)]-gated; on a non-Windows host (or an older `.node`
    // build without the ADR-017 surface) `buildSessionContext` returns null
    // and we surface a hint per ADR-017 R3 so the LLM knows the field is
    // absent for a structural reason, not a transient failure.
    if (args.includeSessionContext) {
      const ctx = buildSessionContext();
      if (ctx) {
        extra.sessionContext = ctx;
      } else {
        extra.sessionContext = null;
        hints.sessionContextUnavailable =
          process.platform === "win32"
            ? "addon-out-of-date"
            : "non-windows-host";
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
/**
 * `desktop_state` causedByProjector — delegating fn to
 * `genericQueryCausedByProjector` (ADR-011 A-1 land 後の backward compat
 * 維持、`_envelope.ts` extract に伴い 4-axis ViewSnapshot 構築ロジック
 * を共通 projector に集約)。
 *
 * Tool-specific enrichment (e.g. desktop_state 固有の focus/cursor 詳細
 * を causal projection に追加する case) が将来必要になったら、本 fn
 * 内で `genericQueryCausedByProjector` の結果を post-process する形で
 * 拡張可能 (ADR-011 plan §8 OQ #4 carry-over)。現時点では generic と
 * 完全同一挙動 (bit-equal sync sweep、plan §4.1.5)。
 */
const desktopStateCausedByProjector = async (
  args: unknown,
  sessionId: string,
): Promise<{ causedBy?: CausedByShape; basedOn?: BasedOnShape; forceDegraded?: boolean } | undefined> => {
  return await genericQueryCausedByProjector(args, sessionId);
};

/**
 * S5 sessionId resolver for `desktop_state` (sub-plan §1.1 E-2 + §2.5).
 *
 * **ADR-011 A-2 finalize**: A-1 で導入した stub
 * (`getMcpTransportSessionId` / `_isSingleSessionPrototype`) を
 * `_session-context.ts` の AsyncLocalStorage 経路に delegate 統合 (plan
 * §4.2.4 unification)。stub 置換が透過のため `desktopStateGetSessionId`
 * の name + 戻り値 contract は不変、A-1 で配線済の 9 query tool は
 * regression なし。
 *
 * 挙動 (ADR-011 plan §3.2 識別子フロー):
 *   - SDK の `RequestHandlerExtra.sessionId` (ALS 注入) 定義あり →
 *     transportSessionId として返す (multi-session transport の
 *     per-request 識別子、HTTP StreamableHTTP 等)
 *   - prototype gate (env mode + ALS 検出) で multi-session detect →
 *     `"multi:disabled"` sentinel (cross-session causal trail leak 防止)
 *   - default → `"default"` (single-LLM-client prototype、stdio default)
 *
 * Test seam `_setSingleSessionPrototypeForTest` /
 * `_resetSingleSessionPrototypeForTest` は backward compat alias として
 * 保持 — 内部で共有 `_setSingleSessionPinForTest` に forward する
 * (plan §4.2.4 unification + 既存 21 unit test の rewrites 不要)。
 */
export const desktopStateGetSessionId = (_args: unknown): string => {
  const transportSessionId = getMcpTransportSessionIdFromContext();
  if (transportSessionId !== undefined) return transportSessionId;
  if (!isSingleSessionPrototype()) {
    return "multi:disabled";
  }
  return "default";
};

/** @internal Test-only — backward-compat alias for A-1 callers. Forwards
 *  to the shared `_session-context.ts` test seam (plan §4.2.4 unification).
 *  Existing 21 unit tests using this exact name continue to work without rewrites. */
export function _setSingleSessionPrototypeForTest(value: boolean): void {
  _setSingleSessionPinForTest(value);
}

/** @internal Test-only — same forwarding pattern. */
export function _resetSingleSessionPrototypeForTest(): void {
  _resetSingleSessionPinForTest();
}

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

/**
 * ADR-017 — `include: ['sessionContext']` ↔ `includeSessionContext: true`
 * translation shim. The envelope wrapper (`makeEnvelopeAware`) strips
 * `include` before it reaches `desktopStateHandler`, which is the correct
 * behaviour for the envelope/raw/causal/memory keywords it owns. But
 * ADR-017 specifies the `sessionContext` keyword on the same array as the
 * advertised API surface, so we peek `args.include` BEFORE the envelope
 * wrapper sees it and translate the keyword into the boolean schema field
 * the handler already understands. Both forms remain valid and produce the
 * same `sessionContext` block.
 *
 * The shim leaves `args.include` itself untouched so the envelope wrapper
 * can still resolve envelope opt-in / raw override against it.
 */
export const desktopStateRegistrationHandlerWithIncludeRoute = (
  rawArgs: Record<string, unknown>,
): ReturnType<typeof desktopStateRegistrationHandler> => {
  const include = rawArgs.include;
  const wantsSessionContext =
    rawArgs.includeSessionContext === true ||
    (Array.isArray(include) && include.includes("sessionContext"));
  return desktopStateRegistrationHandler({
    ...rawArgs,
    includeSessionContext: wantsSessionContext,
  });
};

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
        "includeSessionContext:true (or include:['sessionContext']) → sessionContext {origin, consoleSessionId, sessionLabel, sessionState, ownWinStation} for Terminal Services session classification (ADR-017, observability-only). " +
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
    desktopStateRegistrationHandlerWithIncludeRoute as typeof desktopStateHandler
  );

  // Phase 4: get_history / get_document_state privatized — handlers retained
  // as internal exports. get_history is debug-only; get_document_state is now
  // reachable via desktop_state({includeDocument:true}).
  // (memory: feedback_disable_via_entry_block.md)
}
