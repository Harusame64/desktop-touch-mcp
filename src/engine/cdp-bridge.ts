/**
 * cdp-bridge.ts — Chrome DevTools Protocol (CDP) integration
 *
 * Provides WebSocket-based communication with Chrome/Edge running with
 * --remote-debugging-port. Converts DOM element coordinates to physical
 * screen pixels compatible with the rest of desktop-touch-mcp.
 *
 * Usage:
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
 */

import WebSocket from "ws";
import { getCdpPort } from "../utils/desktop-config.js";
import { defaultPageTab } from "./cdp-default-tab.js";
import { jsLiteral } from "../utils/js-literal.js";
import { SCOPE_ROOTS_JS } from "../tools/_scope-roots-js.js";

export const DEFAULT_CDP_PORT = 9222;
// Exported so callers that surface a CDP-timeout-derived hint (e.g.
// browser_eval's BrowserEvalTimeout) can build the user-facing seconds value
// from this single source instead of hardcoding "15s" (ADR-023 Phase 0 review P2-2).
export const CMD_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Windows parks a minimized (or pathologically off-screen) top-level window's
 * origin at (-32000, -32000). When a CDP target Chrome/Edge is minimized,
 * `window.screenX` / `window.screenY` return that marker while the page layout
 * (innerWidth, getBoundingClientRect) stays valid — so a viewport→screen
 * conversion (getElementScreenCoords / browser-resolver physicalPoint) produces a
 * large negative screen point that the OS clamps to (0,0). An OS mouse click
 * there parks the cursor in the top-left failsafe zone and the dwell watchdog
 * kills the server (`src/utils/failsafe.ts`). Detect this from the window origin
 * BEFORE converting/clicking and stop with a typed error instead.
 *
 * The exact parking marker (-32000) is far beyond any real multi-monitor layout
 * (that would be a 32000px-negative origin), so a legitimately left/top-positioned
 * secondary monitor is never mis-flagged — only the click path guards on this; a
 * CDP-eval write (browser_fill) is unaffected by a minimized window.
 */
export const MINIMIZED_WINDOW_SCREEN_COORD = -32_000;

/** True when a window's CSS-px origin is at/below the Windows minimized-parking marker. */
export function isOffscreenMinimized(screenX: number, screenY: number): boolean {
  return screenX <= MINIMIZED_WINDOW_SCREEN_COORD || screenY <= MINIMIZED_WINDOW_SCREEN_COORD;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

export interface ElementCoords {
  /** Screen X of element center (physical pixels) */
  x: number;
  /** Screen Y of element center (physical pixels) */
  y: number;
  /** Screen X of element left edge (physical pixels) */
  left: number;
  /** Screen Y of element top edge (physical pixels) */
  top: number;
  /** Element width in physical pixels */
  width: number;
  /** Element height in physical pixels */
  height: number;
  /** Whether the element is fully within the viewport */
  inViewport: boolean;
  /** Window origin X (window.screenX, CSS px) — lets the click path detect a minimized/off-screen window before clicking (isOffscreenMinimized). */
  screenX: number;
  /** Window origin Y (window.screenY, CSS px). See screenX. */
  screenY: number;
  /**
   * ADR-023 Phase 2b: the click point's `elementFromPoint` hit is NOT the target
   * (nor a descendant) — something covers it. Generic occlusion (no modal rules);
   * the click handler runs a modal probe to decide if it is a modal blocker.
   */
  occluded: boolean;
  /**
   * ADR-040 — the element's position inside the viewport in physical px (rect × devicePixelRatio), and the
   * viewport's size (innerWidth/innerHeight × devicePixelRatio). With the page surface's origin they give
   * the screen point without `window.screenX` (`alignToPageSurface` in browser.ts). Absent from an older
   * evaluate.
   */
  viewport?: { left: number; top: number; width: number; height: number; innerWidth: number; innerHeight: number };
}

/**
 * Thrown by `getElementScreenCoords` when the first `querySelector` match has a
 * zero-size bounding box (hidden or not rendered). Distinct from a generic
 * "not found" error so the `browser_click` selector path can intercept JUST this
 * case and route to the actionability rescue (issue #441): a CSS selector that
 * matches a hidden/zero-size duplicate AND a visible actionable element should
 * click the visible one rather than fail. The message still contains "zero size"
 * so existing string-matching callers/tests (`/zero size|hidden/i`) stay green.
 */
export class ElementZeroSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementZeroSizeError";
  }
}

// ─── CDP Session ──────────────────────────────────────────────────────────────

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RuntimeEvaluateResult {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private _closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(
          typeof data === "string" ? data : data.toString()
        ) as CdpResponse;
        if (msg.id !== undefined) {
          const cmd = this.pending.get(msg.id);
          if (cmd) {
            clearTimeout(cmd.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              cmd.reject(new Error(`CDP: ${msg.error.message}`));
            } else {
              cmd.resolve(msg.result ?? null);
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      this._closed = true;
      for (const [, cmd] of this.pending) {
        clearTimeout(cmd.timer);
        cmd.reject(new Error("CDP connection closed unexpectedly"));
      }
      this.pending.clear();
    });

    ws.on("error", (err) => {
      // P1 fix: mark closed immediately on error so isOpen returns false
      this._closed = true;
      for (const [, cmd] of this.pending) {
        clearTimeout(cmd.timer);
        cmd.reject(err as Error);
      }
      this.pending.clear();
    });
  }

  get isOpen(): boolean {
    return !this._closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isOpen) {
      return Promise.reject(new Error("CDP session is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `CDP timeout: ${method} did not respond within ${CMD_TIMEOUT_MS}ms`
          )
        );
      }, CMD_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      this.ws.close();
    }
  }
}

// ─── Session cache ────────────────────────────────────────────────────────────

// key: `${port}:${tabId}`
const sessions = new Map<string, CdpSession>();
// Deduplicates concurrent connection attempts for the same tab
const connecting = new Map<string, Promise<CdpSession>>();

function sessionKey(port: number, tabId: string): string {
  return `${port}:${tabId}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function fetchTabs(port: number): Promise<CdpTab[]> {
  let res: Response;
  try {
    // P2 fix: add fetch timeout to avoid hanging indefinitely
    res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    // Declared code (internal #377 item 4): Node's fetch says only "TypeError: fetch failed" — the
    // ECONNREFUSED is in its cause, not its text — so the classifier's substring arm never fired
    // and every browser_* tool answered a bare ToolError with no next step. Not for a timeout: then
    // something holds the port and did not answer in time — a busy browser is still connected, and
    // "launch one" would start a second on the same port (gate 2 on #951).
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      (timedOut ? "" : "BrowserNotConnected: ") +
        `Cannot reach Chrome/Edge CDP at port ${port}. ` +
        `Make sure the browser is running with --remote-debugging-port=${port}. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new Error(`CDP /json returned HTTP ${res.status}`);
  }
  const tabs = (await res.json()) as CdpTab[];
  for (const t of tabs) {
    if (typeof t?.id === "string") rememberTabPort(t.id, port);
    if (typeof t?.title === "string") t.title = unescapeTargetTitle(t.title);
  }
  return tabs;
}

/**
 * internal #406 — Chrome's `/json` list HTML-escapes a target's title (`base::EscapeForHTML`: & < > " ' as `&amp;`
 * `&lt;` `&gt;` `&quot;` `&#39;`). The window's own title, `document.title` and `Target.getTargets` give it plain
 * (win2, dev/406-spike). So a page titled "… viewport & smooth …" was not matched to its window ("…&amp;…"), and its
 * scroll left CDP for the window road. Those five are turned back, in one pass, so a title that literally reads
 * "&amp;" (sent as "&amp;amp;") stays "&amp;". Exported for tests.
 */
export function unescapeTargetTitle(title: string): string {
  return title.replace(/&(amp|lt|gt|quot|#39);/g, (whole, e: string) => TITLE_ENTITIES[e] ?? whole);
}

const TITLE_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/**
 * llm22 drive F13 (win2, 2026-10-04): after `browser_open(port:9333)`, `desktop_discover` and
 * `desktop_act` on that tab went to 9222 (the port was hardcoded there) and failed
 * (`all_providers_failed`, "check --remote-debugging-port=9222"). A tab is remembered with the port
 * it was listed on, and those roads ask here. Bounded; the oldest goes first.
 */
const tabPorts = new Map<string, number>();
const TAB_PORTS_MAX = 512;

export function rememberTabPort(tabId: string, port: number): void {
  tabPorts.delete(tabId);
  tabPorts.set(tabId, port);
  while (tabPorts.size > TAB_PORTS_MAX) {
    const oldest = tabPorts.keys().next().value;
    if (oldest === undefined) break;
    tabPorts.delete(oldest);
  }
}

/**
 * The CDP port a tab was last listed on; otherwise the configured default (`cdpPort` in
 * desktop-touch-config.json, else 9222) — the same default the browser_* tools use.
 */
export function portForTab(tabId: string | null | undefined): number {
  return (typeof tabId === "string" ? tabPorts.get(tabId) : undefined) ?? getCdpPort();
}


async function resolveTab(
  tabId: string | null,
  port: number
): Promise<CdpTab> {
  const tabs = await fetchTabs(port);
  if (tabs.length === 0) {
    throw new Error(
      "No tabs found in Chrome/Edge CDP. Is the browser running with --remote-debugging-port?"
    );
  }
  if (tabId === null) {
    return defaultPageTab(tabs) ?? tabs[0];
  }
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) {
    throw new Error(
      `Tab "${tabId}" not found. Available tab IDs: ${tabs.map((t) => t.id).join(", ")}`
    );
  }
  return tab;
}

async function doConnect(tab: CdpTab, port: number, key: string): Promise<CdpSession> {
  if (!tab.webSocketDebuggerUrl) {
    throw new Error(
      `Tab "${tab.id}" (${tab.title}) has no webSocketDebuggerUrl. It may be a DevTools tab.`
    );
  }
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(tab.webSocketDebuggerUrl!);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(
        new Error(
          `CDP WebSocket connection timed out after ${CONNECT_TIMEOUT_MS}ms`
        )
      );
    }, CONNECT_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  ws.on("close", () => sessions.delete(key));

  const session = new CdpSession(ws);
  sessions.set(key, session);
  return session;
}

async function openSession(tab: CdpTab, port: number): Promise<CdpSession> {
  const key = sessionKey(port, tab.id);
  const existing = sessions.get(key);
  if (existing?.isOpen) {
    return existing;
  }
  // P1 fix: deduplicate concurrent connection attempts for the same tab
  const inflight = connecting.get(key);
  if (inflight) {
    return inflight;
  }
  const promise = doConnect(tab, port, key);
  connecting.set(key, promise);
  try {
    return await promise;
  } finally {
    connecting.delete(key);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List all tabs open in Chrome/Edge at the given CDP port.
 */
export async function listTabs(port = DEFAULT_CDP_PORT): Promise<CdpTab[]> {
  return fetchTabs(port);
}

/**
 * Lightweight tab listing — returns only the three fields needed for lens binding.
 * Does NOT open any WebSocket connections. Throws if CDP is unreachable.
 */
export async function listTabsLight(
  port = DEFAULT_CDP_PORT
): Promise<Array<{ id: string; title: string; url: string; type: string }>> {
  const tabs = await fetchTabs(port);
  // `type` is kept so a caller without a tabId can pick with defaultPageTab (internal #308).
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, type: t.type }));
}

/**
 * Evaluate a JavaScript expression in a browser tab.
 *
 * @param expression  JS expression string (may use `await`)
 * @param tabId       Target tab ID (null = the tab defaultPageTab picks)
 * @param port        CDP port (default 9222)
 * @returns           The serializable return value of the expression
 */
export async function evaluateInTab(
  expression: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<unknown> {
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  const raw = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as RuntimeEvaluateResult;

  if (raw.exceptionDetails) {
    const msg =
      raw.exceptionDetails.exception?.description ??
      raw.exceptionDetails.text;
    throw new Error(`JS exception in tab: ${msg}`);
  }
  return raw.result.value;
}

/**
 * The browser window a tab is in, in screen DIPs (internal #305).
 *
 * `Browser.getWindowForTarget` sent on the tab's own session answers for that tab (win2, Chrome 155
 * and Edge 155: identical to the browser endpoint with `targetId`, 1–4 ms). win2 measured the bounds
 * times the monitor's scale equal to the frame's GetWindowRect, which is the enumeration's region:
 * exactly for a normal window, within 2 px for a maximized one at 150 %. The page's own
 * screenX/outerWidth do not match a maximized window. The scale is the monitor's, not the tab's
 * devicePixelRatio, which includes the page zoom (codex on #837).
 *
 * Throws when the call fails; the caller falls back to finding the window by title.
 */
export async function getTabWindowBounds(
  tabId: string | null,
  port = DEFAULT_CDP_PORT
): Promise<{ left: number; top: number; width: number; height: number }> {
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  const win = (await session.send("Browser.getWindowForTarget", {})) as {
    bounds?: { left?: number; top?: number; width?: number; height?: number };
  };
  const b = win.bounds ?? {};
  if (typeof b.left !== "number" || typeof b.top !== "number" || typeof b.width !== "number" ||
      typeof b.height !== "number") {
    throw new Error("Browser.getWindowForTarget gave no usable bounds");
  }
  return { left: b.left, top: b.top, width: b.width, height: b.height };
}

/**
 * The CDP browser's own process id (internal #305): `SystemInfo.getProcessInfo` on the browser
 * endpoint (`/json/version`), the one entry of type "browser". win2 measured it equal to
 * GetWindowThreadProcessId of every frame of that browser, and different from another browser's
 * frames (Chrome 155 and Edge 155 open together). A tab's own session refuses the call ("only
 * supported on the browser target"). Throws when either step fails.
 */
export async function getBrowserProcessId(port = DEFAULT_CDP_PORT): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP /json/version returned HTTP ${res.status}`);
  const version = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("CDP /json/version gave no webSocketDebuggerUrl");
  const session = await openSession(
    { id: "__browser__", title: "", url: "", type: "browser", webSocketDebuggerUrl: version.webSocketDebuggerUrl },
    port,
  );
  const info = (await session.send("SystemInfo.getProcessInfo", {})) as { processInfo?: Array<{ type?: string; id?: number }> };
  const browser = (info.processInfo ?? []).filter((p) => p.type === "browser");
  if (browser.length !== 1 || typeof browser[0]!.id !== "number") {
    throw new Error("SystemInfo.getProcessInfo named no single browser process");
  }
  return browser[0]!.id;
}

/**
 * internal #318 — the browser window each target is in, as `Browser.getWindowForTarget({targetId})` on
 * the browser endpoint answers it: one session for all of them, without opening one on every tab. A
 * target the call fails for is left out. Throws when the browser endpoint cannot be reached.
 */
export async function getWindowIdsForTargets(
  targetIds: readonly string[],
  port = DEFAULT_CDP_PORT,
): Promise<Map<string, number>> {
  const windows = await getWindowsForTargets(targetIds, port);
  return new Map([...windows].map(([id, w]) => [id, w.windowId]));
}

/**
 * ADR-040 PR ③ — as getWindowIdsForTargets, with the window's bounds (screen DIPs) when the answer
 * carries them: the call returns both, so a wheel aimed at a frame finds that frame's tabs with no
 * session on any tab.
 */
export async function getWindowsForTargets(
  targetIds: readonly string[],
  port = DEFAULT_CDP_PORT,
): Promise<Map<string, { windowId: number; bounds?: { left: number; top: number; width: number; height: number } }>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP /json/version returned HTTP ${res.status}`);
  const version = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("CDP /json/version gave no webSocketDebuggerUrl");
  const session = await openSession(
    { id: "__browser__", title: "", url: "", type: "browser", webSocketDebuggerUrl: version.webSocketDebuggerUrl },
    port,
  );
  const windows = new Map<string, { windowId: number; bounds?: { left: number; top: number; width: number; height: number } }>();
  await Promise.all(targetIds.map(async (targetId) => {
    try {
      const win = (await session.send("Browser.getWindowForTarget", { targetId })) as {
        windowId?: unknown;
        bounds?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown };
      };
      if (typeof win.windowId !== "number") return;
      const b = win.bounds ?? {};
      const bounds = typeof b.left === "number" && typeof b.top === "number" && typeof b.width === "number" &&
        typeof b.height === "number"
        ? { left: b.left, top: b.top, width: b.width, height: b.height }
        : undefined;
      windows.set(targetId, bounds === undefined ? { windowId: win.windowId } : { windowId: win.windowId, bounds });
    } catch {
      // left out
    }
  }));
  return windows;
}

/**
 * Bring a tab and its window to the front with CDP `Page.bringToFront` (internal #305). win2
 * measured it raising the tab's window to the foreground, called from a background process, over the
 * same browser's other window and over a terminal (Chrome and Edge, maximized and overlapping), and a
 * Chrome window over Edge, within 40 ms of the reply. It did NOT raise an Edge window over a Chrome
 * window in front (2/2); the reply is the same either way, so callers check the foreground.
 */
export async function bringTabToFront(tabId: string, port = DEFAULT_CDP_PORT): Promise<void> {
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  await session.send("Page.bringToFront", {});
}

// ─── ADR-018 Phase 3 — Tier 2 wheel dispatch + observation ────────────────────

/**
 * ADR-018 §2.1 D1 — Tier 2 dispatch. Synthesize a `mouseWheel` event in the
 * target tab via CDP `Input.dispatchMouseEvent`. Coordinates are viewport-
 * relative CSS px; viewport center is a reasonable default for tab-routed
 * wheels because the *tab* is the destination — per-element coords matter
 * only for nested scrollers, which Phase 3 does NOT yet target (ADR §7 OQ6
 * carry-over).
 *
 * `deltaX` / `deltaY` follow the CSS/UIA positive-down convention (down/right
 * positive) — matching `WheelParams.notch` in `_input-pipeline.ts`. The Win32
 * `WM_MOUSEWHEEL` sign convention is the opposite; only Phase 4 PostMessage
 * has to flip.
 */
export async function dispatchWheelInTab(
  deltaX: number,
  deltaY: number,
  x: number,
  y: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<void> {
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

/**
 * internal #415 — a left click sent to the tab itself by CDP `Input.dispatchMouseEvent`, at viewport CSS px.
 * Nothing goes through the OS cursor: the browser window is not raised, the tab is not activated, and a window in
 * front of the point cannot take it (win2's spike: delivered in front, behind another window, in a background tab
 * and minimized, at 150 % zoom; the user's typing was not taken).
 *
 * Two calls, so a caller can install its click probe between them and not count hover effects as the click (the
 * order browser_click keeps with the OS cursor): `dispatchMouseMoveInTab` moves the pointer to the point,
 * `dispatchClickInTab` presses and releases there.
 *
 * A failure is thrown as `CdpClickDispatchError` with `pressSent`: false means no press reached the browser (a
 * fallback may press), true means the press was written to an open session and its answer or the release did not
 * come back — the click may have happened, so no fallback presses again.
 */
export class CdpClickDispatchError extends Error {
  constructor(message: string, readonly pressSent: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CdpClickDispatchError";
  }
}

/**
 * internal #421 — what the browser itself says about the element at a page point, for telling a widget's skin from
 * a cover: the accessibility node of the hit (role, name, ignored). Measured on real libraries (spike 3): skins are
 * unnamed with no role of their own (iCheck's `ins.iCheck-helper`: insertion ""); every cover a person has to deal
 * with has a name and a role (dialog, banner, a calendar day). Uses an object id, so no DOM or Accessibility domain
 * is enabled on the shared session. Answers null when the page cannot be read.
 */
export async function inspectHitAtPoint(
  x: number,
  y: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<{ role: string; name: string; ignored: boolean } | null> {
  const group = "dtm-inspect-hit";
  let session: CdpSession | null = null;
  try {
    const tab = await resolveTab(tabId, port);
    session = await openSession(tab, port);
    const hit = (await session.send("Runtime.evaluate", {
      expression: `document.elementFromPoint(${x}, ${y})`,
      returnByValue: false,
      objectGroup: group,
    })) as { result?: { objectId?: string } };
    const id = hit.result?.objectId;
    if (!id) return null;
    const ax = (await session.send("Accessibility.getPartialAXTree", { objectId: id, fetchRelatives: false })) as {
      nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }>;
    };
    const a = ax.nodes[0];
    return { role: a?.role?.value ?? "", name: (a?.name?.value ?? "").trim(), ignored: a?.ignored === true };
  } catch {
    return null;
  } finally {
    try { await session?.send("Runtime.releaseObjectGroup", { objectGroup: group }); } catch { /* ignore */ }
  }
}

/** internal #420 — the attribute the by-axis resolver marks the accessibility tree's matches with. */
export const AX_MARK_ATTR = "data-dtm-ax";

/** Roles a person acts on: an accessibility-tree match with one of these is pressable as it is, with no climb. */
const AX_CONTROL_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "combobox", "option", "textbox", "searchbox", "spinbutton",
  "slider", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);

/**
 * A role the tree gives that a person presses as it is. A listbox is a list of options, pressed on an option, except
 * one that says it opens a popup: Choices' select (role listbox, aria-haspopup) is pressed to open it (win2 on #1008).
 */
function axIsControl(role: string, n: { properties?: Array<{ name?: string; value?: { value?: unknown } }> }): boolean {
  if (AX_CONTROL_ROLES.has(role)) return true;
  if (role !== "listbox") return false;
  const p = (n.properties ?? []).find((q) => q.name === "hasPopup");
  const v = p?.value?.value;
  return v !== undefined && v !== null && v !== false && v !== "false";
}

/** desktop_discover's controls mode leaves these to the page-side list (or out: a slider it cannot press). */
const AX_LISTED_BY_TAG = new Set(["link", "button", "textbox", "searchbox", "slider", "spinbutton"]);
/** Roles a widget draws its own way (a skin, a replacement): marked first in controls mode. */
const AX_DRAWN_ROLES = new Set(["checkbox", "radio", "switch", "combobox", "listbox"]);

/** Marks never made: text runs of a name, not elements a person acts on. */
const AX_TEXT_ROLES = new Set(["StaticText", "InlineTextBox", "LineBreak", "RootWebArea", "none"]);

/**
 * internal #420 — the by-axis resolver's role and name questions answered by the browser's own accessibility tree
 * (spike on internal #420: real Select2, Choices and iCheck, sr-only and opacity: 0 inputs, aria-labelledby, input
 * types and explicit roles all come out right; 0.1-0.4 s on a 12,500-element page).
 *
 * The tree under the page, or under `scope` when given, is asked: by:'role' for that role; by:'ariaLabel' for every
 * node, matched on its accessible name — equal names (0.95) and names containing the pattern (0.7). Each match
 * that is an element of the top document (not in a shadow root or a frame, which the page-side gather cannot see),
 * not ignored and not a text run, is marked `data-dtm-ax="<nonce>:<score>:<c when a control>:<role>"`,
 * the best 200 first, so the page-side gather takes them as its candidates. A native multi-row select (role
 * listbox) is left out: a press on it picks the option under the centre. Answers how many were marked, or null when
 * the tree (or the scope) could not be read; with none marked, the caller keeps the DOM reading. `by: "controls"`
 * marks the controls desktop_discover's list needs the tree for (PR-C2b): not links, buttons, text fields, sliders
 * or spinbuttons.
 */
/** How many tree matches a by-axis question marks by default (its best ones): a list that reaches it may hold more. */
export const AX_MARK_CAP = 200;

/**
 * The most DOM nodes (elements and text, open shadow roots' included) a hidden tab's read may have under the scope's
 * roots (internal #423). Every node a getChildAXNodes reply holds stands for one of them, or for a list marker or
 * generated content beside one, so this bounds every reply before anything is asked (at most about 0.45 KB a node
 * measured, so 45 MB for the nodes); past it the caller keeps the DOM reading at once. Real pages, whole document:
 * MDN's input page 48,500 (read in 1.7-2.4 s on win2's Chrome), the Python docs' stdtypes 41,500, Wikipedia "Tokyo"
 * 29,900, Stack Overflow 19,200, GitHub 3,800.
 */
export const AX_HIDDEN_READ_MAX_DOM_NODES = 100_000;

/**
 * The most characters of text under the scope's roots a hidden tab's read may have: a text run's name is its text, and
 * a link's, button's, heading's or row's name repeats the text inside it.
 */
const AX_HIDDEN_READ_MAX_TEXT = 4_000_000;

/**
 * The most tree nodes the read walks, a backstop over the DOM count for what that count cannot see: list markers and
 * generated content, nodes aria-owns brings in from elsewhere, closed shadow roots.
 */
const AX_PIECEWISE_MAX_NODES = 3 * AX_HIDDEN_READ_MAX_DOM_NODES;

/**
 * How long a hidden tab's read may take, from before the Accessibility domain is enabled, before it gives up the same
 * way (each level of depth is one round trip; win2 read MDN's input page in 1.9-2.4 s).
 */
const AX_PIECEWISE_MAX_MS = 5_000;

/** How many getChildAXNodes calls a hidden tab's read keeps in flight at once (spike on internal #423). */
const AX_PIECEWISE_IN_FLIGHT = 128;

/** Page script: whether the page is hidden, by Document.prototype's getter (not a property the page gives the document itself). */
const PAGE_HIDDEN_JS = `(function() {
  var d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  return (d && d.get ? d.get.call(document) : document.visibilityState) === 'hidden';
})()`;

/**
 * Called on the scope's roots (an array): how many elements and text nodes are under them, open shadow roots'
 * included, and how many characters of text, counted until past either limit. Read through the prototypes, so a form
 * control named nodeType or data does not stand in for them.
 */
const COUNT_UNDER_ROOTS_FN = `function(maxNodes, maxText) {
  var ntGet = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  var dataGet = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data').get;
  var srGet = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get;
  var n = 0, t = 0, stack = Array.prototype.slice.call(this);
  while (stack.length > 0 && n <= maxNodes && t <= maxText) {
    var r = stack.pop();
    var w = Document.prototype.createTreeWalker.call(document, r, 5);
    for (var c = r; c && n <= maxNodes && t <= maxText; c = w.nextNode()) {
      var k = ntGet.call(c);
      if (k === 3) { n++; t += dataGet.call(c).length; }
      else if (k === 1) { n++; var sr = srGet.call(c); if (sr) stack.push(sr); }
    }
  }
  return { nodes: n, text: t };
}`;

/**
 * The Accessibility domain is enabled on a session only while a hidden tab's read walks it (getChildAXNodes needs it),
 * counted, so one read finishing does not disable it under another.
 */
const axEnabled = new WeakMap<CdpSession, { reads: number; ready: Promise<unknown> }>();
async function withAxEnabled<T>(s: CdpSession, fn: () => Promise<T>): Promise<T> {
  // Every read waits for the one enable call, so a second read does not go ahead of a first read's enable that fails
  // (/code-review on #1038).
  let st = axEnabled.get(s);
  if (!st) { st = { reads: 0, ready: s.send("Accessibility.enable", {}) }; axEnabled.set(s, st); }
  st.reads++;
  try {
    await st.ready;
    return await fn();
  } finally {
    st.reads--;
    if (st.reads === 0) {
      axEnabled.delete(s);
      await s.send("Accessibility.disable", {}).catch(() => { /* the session may be gone */ });
    }
  }
}

export async function markAxMatches(
  opts: { by: "role" | "ariaLabel" | "controls"; pattern: string; caseSensitive: boolean; nonce: string; scope?: string; cap?: number; onFound?: (found: number, triedAll: boolean) => void;
    /** browser_search lists a native multi-row select (role listbox); an action leaves it out (a press picks an option). */
    keepNativeListbox?: boolean },
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<number | null> {
  const group = "dtm-ax-mark";
  let session: CdpSession | null = null;
  try {
    const tab = await resolveTab(tabId, port);
    session = await openSession(tab, port);
    const s = session;
    type AxNode = {
      nodeId: string; childIds?: string[]; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number;
      properties?: Array<{ name?: string; value?: { value?: unknown } }>;
    };
    // The root (or each element the scope matches, internal #420) by an object id, so no DOM domain is enabled on
    // the shared session (/code-review on #1008), as inspectHitAtPoint does.
    const rootsObj = (await s.send("Runtime.evaluate", {
      expression: `(function() {${SCOPE_ROOTS_JS} return __scopeRoots(${opts.scope ? jsLiteral(opts.scope) : "null"}); })()`,
      returnByValue: false,
      objectGroup: group,
    })) as { result?: { objectId?: string } };
    if (!rootsObj.result?.objectId) return null;
    const props = (await s.send("Runtime.getProperties", { objectId: rootsObj.result.objectId, ownProperties: true })) as {
      result?: Array<{ name: string; value?: { objectId?: string } }>;
    };
    const roots = (props.result ?? [])
      .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((p) => p.value!.objectId!);
    if (roots.length === 0) return null;
    // The tree under each root. In a tab that is shown, asked per root (queryAXTree), together (a class scope can match
    // hundreds). In a tab that is not shown, queryAXTree waits for a frame that does not come, so each call ran into the
    // 15 s command timeout and the caller fell back to the DOM reading (win2; mac headless: queryAXTree and a
    // requestAnimationFrame never answer there; the tree's other calls do, and read changes made while it is hidden).
    // There the tree is read in pieces: each root's node (getPartialAXTree), then the children of every node met
    // (getChildAXNodes, many in flight), and walked depth first by the tree's own children. That walk gives
    // queryAXTree's nodes in queryAXTree's order, under scopes, aria-owns, shadow roots, slots and display: contents,
    // and nothing for a root with no node of its own in the tree (display: none, aria-hidden) (spikes on internal #420
    // and #423). A text run's children (its line boxes, never an element) are not asked for.
    //
    // How big a reply is cannot be known from the tree before asking: a reply holds all of one node's children
    // (150,000 list items: 67.5 MiB) and, through every ignored child, that child's own children (html > body > div >
    // div, all ignored, over 5,000 rows came back whole for a node listing one child) (/code-review on #1038). And one
    // message over the socket's 100 MiB closes the tab's session. So the DOM under the roots is counted first: past
    // AX_HIDDEN_READ_MAX_DOM_NODES nodes or AX_HIDDEN_READ_MAX_TEXT characters the read is not begun. #1037 read the whole
    // tree in one message and counted elements, which a <pre> of 200,000 lines passed with 5 elements and a 117 MiB
    // tree (each line is a node of the whole tree; a text run's line boxes are not asked for here). An ignored node
    // that came in a reply is not asked again when the reply holds its children. Past AX_PIECEWISE_MAX_NODES nodes or
    // AX_PIECEWISE_MAX_MS the read gives up too.
    //
    // The pieces are read at different moments: a subtree the page moves during the read can be seen under both
    // parents (kept once) or under neither, and a container that replaces its children after it was read loses them;
    // a node removed after its parent listed it answers "Invalid ID" and is passed over. Not in a shown tab too: there
    // queryAXTree under a narrow scope takes a few ms. A root the tree (or the DOM) cannot answer for is left out, not
    // the others (/code-review on #1029); with none answered, the tree could not be read. A node aria-owns places under
    // two roots is kept once. Whether the tab is shown is read by Document.prototype's getter, so a page that gives the
    // document its own visibilityState is still seen hidden; one that replaces the prototype's getter is taken as shown,
    // and waits as on main. When that read fails, the tab is taken as shown (/code-review on #1037).
    const queryTree = async (role?: string): Promise<AxNode[]> => {
      let hidden = false;
      try {
        const st = (await s.send("Runtime.evaluate", { expression: PAGE_HIDDEN_JS, returnByValue: true })) as { result?: { value?: unknown } };
        hidden = st.result?.value === true;
      } catch { /* taken as shown */ }
      let per: Array<AxNode[] | null>;
      if (!hidden) {
        per = await Promise.all(roots.map((objectId) =>
          (s.send("Accessibility.queryAXTree", role === undefined ? { objectId } : { objectId, role }) as Promise<{ nodes: AxNode[] }>)
            .then((r) => r.nodes, () => null)));
      } else {
        const size = (await s.send("Runtime.callFunctionOn", {
          objectId: rootsObj.result!.objectId!,
          functionDeclaration: COUNT_UNDER_ROOTS_FN,
          arguments: [{ value: AX_HIDDEN_READ_MAX_DOM_NODES }, { value: AX_HIDDEN_READ_MAX_TEXT }],
          returnByValue: true,
        })) as { result?: { value?: { nodes?: number; text?: number } } };
        const count = size.result?.value;
        if (typeof count?.nodes !== "number" || typeof count.text !== "number") throw new Error("the DOM under the scope could not be counted");
        if (count.nodes > AX_HIDDEN_READ_MAX_DOM_NODES || count.text > AX_HIDDEN_READ_MAX_TEXT) throw new Error("a hidden page too large to read under this scope");
        // One timer for the whole read, from before the enable (which builds the page's tree); every wait is cut there.
        let timedOut = false;
        let wake: (() => void) | null = null;
        const signal = (): void => { const w = wake; wake = null; w?.(); };
        let rejectAtLimit: (e: Error) => void = () => {};
        const atLimit = new Promise<never>((_, rej) => { rejectAtLimit = rej; });
        atLimit.catch(() => { /* raced below */ });
        const tooSlow = (): Error => new Error("a hidden page's tree too slow to read under this scope");
        const limitTimer = setTimeout(() => { timedOut = true; signal(); rejectAtLimit(tooSlow()); }, AX_PIECEWISE_MAX_MS);
        const inTime = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, atLimit]);
        try {
        per = await inTime(withAxEnabled(s, async () => {
          // Each root's own node: the one for that element (a root with none, display: none or aria-hidden, has none).
          // AX_PIECEWISE_IN_FLIGHT roots at a time: a class scope can match thousands (/code-review on #1038).
          const tops: Array<AxNode | null | undefined> = [];
          for (let i = 0; i < roots.length; i += AX_PIECEWISE_IN_FLIGHT) {
            tops.push(...await inTime(Promise.all(roots.slice(i, i + AX_PIECEWISE_IN_FLIGHT).map(async (objectId) => {
              const backendNodeId = await (s.send("DOM.describeNode", { objectId }) as Promise<{ node?: { backendNodeId?: number } }>)
                .then((r) => r.node?.backendNodeId, () => undefined);
              if (backendNodeId === undefined) return null;
              return (s.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }) as Promise<{ nodes?: AxNode[] }>)
                .then((r) => (r.nodes ?? []).find((x) => x.backendDOMNodeId === backendNodeId) ?? undefined, () => null);
            }))));
          }
          const byId = new Map<string, AxNode>();
          const queue: string[] = [];
          const asked = new Set<string>();
          const ask = (x: AxNode): void => {
            if (x.childIds?.length && x.role?.value !== "StaticText" && !asked.has(x.nodeId)) { asked.add(x.nodeId); queue.push(x.nodeId); }
          };
          for (const t of tops) if (t) { byId.set(t.nodeId, t); ask(t); }
          let failed: unknown = null;
          const inFlight = new Set<Promise<void>>();
          while (queue.length > 0 || inFlight.size > 0) {
            if (failed !== null) throw failed;
            if (timedOut) throw tooSlow();
            if (byId.size > AX_PIECEWISE_MAX_NODES) throw new Error("a hidden page's tree too large to read under this scope");
            while (queue.length > 0 && inFlight.size < AX_PIECEWISE_IN_FLIGHT) {
              const id = queue.shift()!;
              const p: Promise<void> = (s.send("Accessibility.getChildAXNodes", { id }) as Promise<{ nodes?: AxNode[] }>)
                .then((r) => {
                  const got = r.nodes ?? [];
                  for (const x of got) if (!byId.has(x.nodeId)) byId.set(x.nodeId, x);
                  // An ignored node's children come in the same reply (measured, Chrome 157); one whose children did
                  // not is asked like any other (/code-review round 3 on #1038).
                  for (const x of got) {
                    if (x.ignored && (x.childIds ?? []).every((c) => byId.has(c))) asked.add(x.nodeId);
                    else ask(x);
                  }
                }, (e: unknown) => {
                  // A node the page removed after its parent listed it answers "Invalid ID": its subtree is gone, and
                  // the walk goes on without it (measured, Chrome 157). Anything else fails the read.
                  if (!/Invalid ID/.test(String((e as Error)?.message ?? e))) failed = e;
                })
                .finally(() => { inFlight.delete(p); signal(); });
              inFlight.add(p);
            }
            if (inFlight.size > 0) await new Promise<void>((res) => { wake = res; });
          }
          if (failed !== null) throw failed;
          if (byId.size > AX_PIECEWISE_MAX_NODES) throw new Error("a hidden page's tree too large to read under this scope");
          return tops.map((top) => {
            if (top === null) return null;
            // Depth first by an explicit stack, children in their order: a deep page does not run out of call stack.
            const nodes: AxNode[] = [];
            const stack: AxNode[] = [];
            if (top) stack.push(top);
            const met = new Set<string>();
            while (stack.length > 0) {
              const n = stack.pop()!;
              if (met.has(n.nodeId)) continue;
              met.add(n.nodeId);
              if (role === undefined || n.role?.value === role) nodes.push(n);
              const kids = n.childIds ?? [];
              for (let i = kids.length - 1; i >= 0; i--) {
                const c = byId.get(kids[i]);
                if (c) stack.push(c);
              }
            }
            return nodes;
          });
        }));
        } finally {
          clearTimeout(limitTimer);
        }
      }
      if (per.every((n) => n === null)) throw new Error("the tree could not be read under any root of the scope");
      const seen = new Set<number>();
      const out: AxNode[] = [];
      for (const nodes of per) {
        for (const n of nodes ?? []) {
          if (n.backendDOMNodeId !== undefined) {
            if (seen.has(n.backendDOMNodeId)) continue;
            seen.add(n.backendDOMNodeId);
          }
          out.push(n);
        }
      }
      return out;
    };
    const scored: Array<{ backend: number; score: number; control: boolean; role: string }> = [];
    if (opts.by === "controls") {
      // desktop_discover (internal #420, PR-C2b): every control the tree shows that is not a link or a button (the
      // page-side list finds those by their tags and roles) — a checkbox drawn by a skin, Select2's combobox, Choices'
      // popup listbox, a role=checkbox div — named or not.
      const nodes = await queryTree();
      for (const n of nodes) {
        const r = n.role?.value ?? "";
        // Links, buttons and native fields are left to the page-side list, which finds them by their tags; a div the
        // tree calls a textbox (the CDP fill cannot write to it), a slider or a spinbutton is not listed. The roles a
        // widget draws in its own way come first (/code-review on #1009).
        if (n.ignored || !n.backendDOMNodeId || !axIsControl(r, n) || AX_LISTED_BY_TAG.has(r)) continue;
        scored.push({ backend: n.backendDOMNodeId, score: AX_DRAWN_ROLES.has(r) ? 0.9 : 0.85, control: true, role: r });
      }
    } else if (opts.by === "role") {
      const role = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
      const nodes = await queryTree(role);
      for (const n of nodes) {
        const r = n.role?.value ?? "";
        if (n.ignored || !n.backendDOMNodeId || AX_TEXT_ROLES.has(r)) continue;
        scored.push({ backend: n.backendDOMNodeId, score: 0.85, control: axIsControl(r, n), role: r });
      }
    } else {
      const nodes = await queryTree();
      const needle = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
      const exact: typeof scored = [];
      const partial: typeof scored = [];
      for (const n of nodes) {
        const r = n.role?.value ?? "";
        const name = String(n.name?.value ?? "").trim();
        if (n.ignored || !n.backendDOMNodeId || !name || AX_TEXT_ROLES.has(r)) continue;
        const cmp = opts.caseSensitive ? name : name.toLowerCase();
        const hit = { backend: n.backendDOMNodeId, control: axIsControl(r, n), role: r };
        if (cmp === needle) exact.push({ ...hit, score: 0.95 });
        else if (cmp.includes(needle)) partial.push({ ...hit, score: 0.7 });
      }
      // Both are marked, equal names first: the gather prefers a control with an equal name among the matches it can
      // see and the role allows ("Email" is the field named Email, not also a button reading "Email me updates"), and
      // keeps containing names beside an equal one that is hidden or not a control (/code-review on #1008).
      scored.push(...exact, ...partial);
    }
    scored.sort((a, b) => b.score - a.score);
    // desktop_discover's list takes its first 60 in document order, so a control early in the page must not be
    // crowded out of a score-sorted 200 by ones later; a by-axis question keeps its best 200, unless the caller asks
    // for more (browser_search pages through up to 1000).
    const cap = opts.cap ?? (opts.by === "controls" ? 1000 : AX_MARK_CAP);
    const markOne = async (m: (typeof scored)[number]): Promise<number> => {
      try {
        const { object } = (await s.send("DOM.resolveNode", { backendNodeId: m.backend, objectGroup: group })) as { object: { objectId?: string } };
        if (!object.objectId) return 0;
        const r = (await s.send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          returnByValue: true,
          arguments: [{ value: `${opts.nonce}:${m.score}:${m.control ? "c" : ""}:${m.role}` }, { value: m.role }, { value: opts.keepNativeListbox === true }],
          functionDeclaration: `function(v, role, keepNativeListbox) {
            // Not in a shadow root, and not in a frame: the gather reads the top document only, and only there are
            // marks cleared. The top frame's tree holds no frame's nodes (nor did queryAXTree's when measured, Chrome
            // 157); the frame test stays for one that does (/code-review on #1008).
            if (this.nodeType !== 1 || this.getRootNode() !== document || window !== window.top) return 0;
            if (role === 'listbox' && this.tagName === 'SELECT' && !keepNativeListbox) return 0;
            // One token per call, beside other calls' tokens: a discover and a click on the same tab do not overwrite
            // each other's marks (/code-review on #1009).
            var mine = v.split(':')[0] + ':';
            var keep = (this.getAttribute('${AX_MARK_ATTR}') || '').split(' ').filter(function(t) { return t && t.indexOf(mine) !== 0; });
            keep.push(v);
            this.setAttribute('${AX_MARK_ATTR}', keep.join(' '));
            return 1;
          }`,
        })) as { result?: { value?: number } };
        return r.result?.value === 1 ? 1 : 0;
      } catch {
        return 0;
      }
    };
    // Up to `cap` marked: a node that cannot be marked (in a shadow root or a frame) does not use up the cap, so the
    // next ones are tried in further rounds (/code-review on #1011: 999 shadow checkboxes hid 20 in the document).
    let count = 0;
    let tried = 0;
    while (tried < scored.length && count < cap) {
      const batch = scored.slice(tried, tried + (cap - count));
      tried += batch.length;
      count += (await Promise.all(batch.map(markOne))).reduce<number>((a, b) => a + b, 0);
    }
    opts.onFound?.(scored.length, tried >= scored.length);
    if (opts.by === "ariaLabel") {
      // The tree leaves out a select a widget hides (Select2, Choices), so its <label> names nothing a person can
      // press; the widget drawn for it is marked under that name (win2 on #1008, W12). Which widget stands for which
      // select is read close to how desktop_discover reads it (__standsFor in _element-name-js.ts; this copy also asks that the select be hidden). A failure here keeps the tree's
      // marks, which the caller clears (/code-review on #1010).
      try {
        const r = (await s.send("Runtime.evaluate", {
          expression: widgetsForLabelledSelectsJs(opts.nonce, opts.pattern, opts.caseSensitive, opts.scope ?? null),
          returnByValue: true,
        })) as { result?: { value?: number } };
        count += typeof r.result?.value === "number" ? r.result.value : 0;
      } catch { /* keep the tree's answer */ }
    }
    return count;
  } catch {
    return null;
  } finally {
    try { await session?.send("Runtime.releaseObjectGroup", { objectGroup: group }); } catch { /* ignore */ }
  }
}

/**
 * internal #420 (W12) — page script: for each select whose name (aria-labelledby, aria-label, its labels' own
 * words) equals (0.95) or contains (0.7) the pattern, mark the widget drawn for it with this call's token and the
 * widget's own role. The widget is the combobox/listbox a hidden select sits inside (Choices), or, for a select kept
 * from people (aria-hidden, tabindex -1: Select2), one just after it within four levels. A listbox is a control only
 * with a popup. Answers how many elements it newly marked.
 */
function widgetsForLabelledSelectsJs(nonce: string, pattern: string, caseSensitive: boolean, scope: string | null): string {
  return `(function() {
${SCOPE_ROOTS_JS}
  var roots = __scopeRoots(${scope === null ? "null" : jsLiteral(scope)});
  if (roots.length === 0) return 0;
  var cs = ${JSON.stringify(caseSensitive)}, needle = cs ? ${JSON.stringify(pattern)} : ${JSON.stringify(pattern.toLowerCase())};
  var nonce = ${JSON.stringify(nonce)}, n = 0;
  // Kept from people as Select2 keeps its select: out of the tab order and the tree. A select merely hidden lends its
  // name only to a widget it sits inside (Choices); one after it may be another field (/code-review on #1010).
  function keptFromPeople(sel) { return sel.getAttribute('aria-hidden') === 'true' && sel.getAttribute('tabindex') === '-1'; }
  function widgetFor(sel) {
    var w = sel.parentElement && Element.prototype.closest.call(sel.parentElement, '[role=combobox],[role=listbox]');
    if (w && w.querySelector('select') === sel && (sel.hidden || keptFromPeople(sel))) return w;
    if (!keptFromPeople(sel)) return null;
    var next = sel.nextElementSibling;
    if (!next) return null;
    var c = Element.prototype.matches.call(next, '[role=combobox],[role=listbox]') ? next : next.querySelector('[role=combobox],[role=listbox]');
    if (!c) return null;
    for (var a = c, d = 0; a && d < 4; a = a.parentElement, d++) if (a.previousElementSibling === sel) return c;
    return null;
  }
  // A label's own words: not the options of a select it wraps, a widget's text, or a part the page masks.
  function words(n) {
    var out = '';
    for (var c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1) {
        if (/^(SELECT|INPUT|TEXTAREA)$/.test(c.tagName) || Element.prototype.matches.call(c, '[role=combobox],[role=listbox]')) continue;
        var sec = getComputedStyle(c).webkitTextSecurity;
        if (sec && sec !== 'none') continue;
        out += ' ' + words(c);
      }
    }
    return out;
  }
  // The select's name as the tree would give it if it were shown: aria-labelledby, aria-label, then its labels.
  function nameOf(sel) {
    var ids = (sel.getAttribute('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean);
    var t = ids.map(function(id) { var x = document.getElementById(id); return x ? words(x) : ''; }).join(' ');
    if (!t.trim()) t = sel.getAttribute('aria-label') || '';
    if (!t.trim() && sel.labels) t = Array.prototype.map.call(sel.labels, words).join(' ');
    return t.trim().replace(/\\s+/g, ' ');
  }
  var sels = __qsaIn(roots, 'select');
  for (var i = 0; i < sels.length; i++) {
    var sel = sels[i];
    var name = nameOf(sel);
    if (!name) continue;
    var cmp = cs ? name : name.toLowerCase();
    var score = cmp === needle ? 0.95 : cmp.indexOf(needle) >= 0 ? 0.7 : 0;
    if (!score) continue;
    var w = widgetFor(sel);
    if (!w || w.getRootNode() !== document) continue;
    // A listbox is pressed as it is only when it opens a popup, as the tree's reading has it (axIsControl).
    var role = (w.getAttribute('role') || '').toLowerCase();
    var hp = w.getAttribute('aria-haspopup');
    var ctl = role === 'combobox' || (role === 'listbox' && hp !== null && hp !== 'false');
    var toks = (w.getAttribute('${AX_MARK_ATTR}') || '').split(' ').filter(Boolean);
    var mine = toks.filter(function(t) { return t.indexOf(nonce + ':') === 0; })[0];
    // The tree's own mark on the widget stays when it is as good (its name, its role); it is counted once.
    if (mine && parseFloat(mine.split(':')[1]) >= score) continue;
    var others = toks.filter(function(t) { return t.indexOf(nonce + ':') !== 0; });
    others.push(nonce + ':' + score + ':' + (ctl ? 'c' : '') + ':' + role);
    w.setAttribute('${AX_MARK_ATTR}', others.join(' '));
    if (!mine) n++;
  }
  return n;
})()`;
}

/** Remove one call's accessibility-tree marks ({@link markAxMatches}); another call's marks on the tab stay. */
export async function clearAxMarks(nonce: string, tabId: string | null = null, port = DEFAULT_CDP_PORT): Promise<void> {
  await evaluateInTab(
    `(function(){var mine=${jsLiteral(nonce + ":")};document.querySelectorAll('[${AX_MARK_ATTR}*=' + JSON.stringify(mine) + ']').forEach(function(n){var keep=(n.getAttribute('${AX_MARK_ATTR}')||'').split(' ').filter(function(t){return t&&t.indexOf(mine)!==0;});if(keep.length)n.setAttribute('${AX_MARK_ATTR}',keep.join(' '));else n.removeAttribute('${AX_MARK_ATTR}');});return true})()`,
    tabId, port,
  ).catch(() => null);
}

export async function dispatchMouseMoveInTab(
  x: number,
  y: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<void> {
  try {
    const tab = await resolveTab(tabId, port);
    const session = await openSession(tab, port);
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  } catch (e) {
    throw new CdpClickDispatchError(e instanceof Error ? e.message : String(e), false, { cause: e });
  }
}

export async function dispatchClickInTab(
  x: number,
  y: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<void> {
  let pressSent = false;
  try {
    const tab = await resolveTab(tabId, port);
    const session = await openSession(tab, port);
    // A closed session rejects without writing anything: then the press was not sent.
    pressSent = session.isOpen;
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  } catch (e) {
    throw new CdpClickDispatchError(e instanceof Error ? e.message : String(e), pressSent, { cause: e });
  }
}

/**
 * ADR-018 §2.2 — Tier 2 observation. Reads the document scrolling element's
 * scroll position. Uses the `document.scrollingElement || document.documentElement`
 * two-step query to avoid the `<body>` quirk that Phase 3 also fixes in
 * `smart-scroll.ts` (ADR §5 R3).
 *
 * Returns `null` on any failure (no tab, no session, JS exception, evaluation
 * timeout) so callers can downgrade to `target_unreachable` cleanly.
 */
export async function readScrollPositionInTab(
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<{
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  /** The viewport in CSS px (window.innerWidth/innerHeight, scrollbars included): maps a screen point onto it. */
  innerWidth?: number;
  innerHeight?: number;
  /** window.devicePixelRatio (monitor scale × page zoom) and visualViewport.scale (pinch zoom). */
  devicePixelRatio?: number;
  pinchScale?: number;
} | null> {
  const expr = `
(function() {
  const el = document.scrollingElement || document.documentElement;
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    pinchScale: window.visualViewport ? window.visualViewport.scale : 1,
  };
})()`;
  try {
    const result = (await evaluateInTab(expr, tabId, port)) as {
      scrollTop: number;
      scrollLeft: number;
      scrollHeight: number;
      scrollWidth: number;
      clientHeight: number;
      clientWidth: number;
      innerWidth?: number;
      innerHeight?: number;
      devicePixelRatio?: number;
      pinchScale?: number;
    } | null;
    return result;
  } catch {
    return null;
  }
}

/**
 * internal #403 — the page-side observer for one CDP wheel, run in an isolated world. A one-shot capture
 * listener for `wheel` on window reads `composedPath()`: the elements the browser itself hit-tested, through
 * open shadow roots and slots (measured: internal dev/403-cdp-wheel-spike M4), and each one's scroll position
 * on the wheel's axis before the wheel moves anything (M5). `window`/`document` on the path stand for the
 * document's scrolling element. Exported so the expression itself is run in tests.
 */
export function wheelObserverExpr(vertical: boolean): string {
  return `
(function(vertical) {
  var o = { seen: false, seenAt: 0, ended: false, path: [], pre: [], ev: null };
  var root = function() { return document.scrollingElement || document.documentElement; };
  o.listener = function(e) {
    o.seen = true; o.seenAt = performance.now(); o.ev = e;
    var p = e.composedPath();
    for (var i = 0; i < p.length; i++) {
      var n = p[i];
      var el = (n === window || n === document) ? root() : (n && n.nodeType === 1 ? n : null);
      if (!el || o.path.indexOf(el) >= 0) continue;
      o.path.push(el);
      o.pre.push(vertical ? el.scrollTop : el.scrollLeft);
    }
  };
  // A scroll that ended on this wheel's path (not a carousel elsewhere, gate 2 on #980).
  o.onEnd = function(e) {
    var t = (e.target === document || e.target === window) ? root() : e.target;
    if (o.path.indexOf(t) >= 0) o.ended = true;
  };
  o.cleanup = function() {
    window.removeEventListener('wheel', o.listener, true);
    document.removeEventListener('scrollend', o.onEnd, true);
  };
  window.addEventListener('wheel', o.listener, { capture: true, once: true, passive: false });
  document.addEventListener('scrollend', o.onEnd, true);
  o.vertical = vertical;
  return o;
})(${vertical ? "true" : "false"})`;
}

/**
 * internal #403 — called on the observer (`this`) after the wheel (`sign`: +1 down/right, −1 up/left). Waits
 * while the wheel has not arrived (up to `seenMs` from this call), then until an element on the hit path has moved
 * by ≥ 1 px the way the wheel turns AND that scroll has ended (a `scrollend` on the path, or `settleMs` after the
 * first move), or nothing moved within `maxMs` of the wheel being seen. Waiting for the end keeps a smooth scroll from running into the next call, where it would be
 * credited to that call's wheel (gate 2 on #980). Then it takes its listeners off and answers what it saw.
 *
 * When nothing moved, `under` is the first element on the path (nearest the point) that scrolls on the axis:
 * "room" (it could move that way), "end" (it stands at its end that way), or absent when nothing on the path
 * scrolls. Only that one is judged: the browser's scroll chain past it (overscroll-behavior, fixed and absolute
 * containing blocks) is not modelled. The document counts as scrolling unless the viewport's overflow (html's,
 * or body's propagated) hides that axis; a body whose overflow went to the viewport is not a scroller itself.
 * Right-to-left boxes sideways, and reversed flex boxes on their main axis, run from −max to 0. Exported for tests.
 */
export const WHEEL_VERDICT_FN = `function(sign, seenMs, settleMs, maxMs) {
  var o = this, t0 = performance.now(), v = o.vertical;
  var root = document.scrollingElement || document.documentElement;
  var html = document.documentElement, body = document.body;
  function ov(el) { var cs = getComputedStyle(el); return v ? cs.overflowY : cs.overflowX; }
  function pos(el) { return v ? el.scrollTop : el.scrollLeft; }
  function movedAt() {
    for (var i = 0; i < o.path.length; i++) if ((pos(o.path[i]) - o.pre[i]) * sign >= 1) return i;
    return -1;
  }
  function viewportOverflow() {
    var h = ov(html);
    return (h === 'visible' && body) ? ov(body) : h;
  }
  function judge(el) {
    if (el.isConnected === false) return 'none';
    if (el === root) {
      if (/^(hidden|clip)$/.test(viewportOverflow())) return 'none';
    } else {
      if (el === body && ov(html) === 'visible') return 'none';
      if (!/^(auto|scroll|overlay)$/.test(ov(el))) return 'none';
    }
    var max = v ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (max <= 0) return 'none';
    // The scroll origin is at the far end (scroll position runs from -max to 0) for a right-to-left box sideways,
    // a reversed flex box on its main axis (column-reverse chat panes, codex on #980), or any box already
    // reading a negative position.
    var cs2 = getComputedStyle(el), flex = /flex/.test(cs2.display);
    var reversed = v
      ? (flex && cs2.flexDirection === 'column-reverse')
      : ((cs2.direction === 'rtl') !== (flex && cs2.flexDirection === 'row-reverse'));
    var at = pos(el);
    var lo = 0, hi = max;
    if (reversed || at < 0) { lo = -max; hi = 0; }
    return (sign > 0 ? at < hi - 1 : at > lo + 1) ? 'room' : 'end';
  }
  function label(el) {
    if (el === root) return 'document';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  }
  return new Promise(function(resolve) {
    var firstMove = -1;
    function done() {
      o.cleanup();
      var r = { seen: o.seen, defaultPrevented: !!(o.ev && o.ev.defaultPrevented) };
      var i = movedAt();
      if (i >= 0) { r.moved = label(o.path[i]); resolve(r); return; }
      for (var j = 0; j < o.path.length; j++) {
        var k = judge(o.path[j]);
        if (k !== 'none') { r.under = k; r.underLabel = label(o.path[j]); break; }
      }
      resolve(r);
    }
    (function tick() {
      var now = performance.now();
      if (!o.seen) { if (now - t0 > seenMs) return done(); }
      else if (firstMove < 0 && movedAt() >= 0) firstMove = now;
      if (o.seen) {
        // Each wait runs from its own start (gate 2 on #981): the move from when the wheel was seen, the settle
        // from the first move, so a wheel seen late still gets the whole move wait, and a move found late the
        // whole settle.
        if (firstMove >= 0) { if (o.ended || now - firstMove > settleMs) return done(); }
        else if (o.ended || now - o.seenAt > maxMs) return done();
      }
      setTimeout(tick, 16);
    })();
  });
}`;

/** internal #403 — takes the observer's listeners off, called on it (`this`) when no verdict was read. */
export const WHEEL_OBSERVER_CLEANUP_FN = `function() { this.cleanup(); }`;

/** What the observer saw (see WHEEL_VERDICT_FN). */
export interface WheelVerdict {
  seen: boolean;
  defaultPrevented: boolean;
  /** The element that moved the way the wheel turns ("document", or tag#id). */
  moved?: string;
  /** Nothing moved: the nearest element on the path that scrolls on the axis could move that way ("room") or stood at its end ("end"); absent when none scrolls. */
  under?: "room" | "end";
  underLabel?: string;
}

let wheelObserverSeq = 0;

/**
 * internal #403 — arms the observer for one CDP wheel on the tab's main frame, in an isolated world (nothing
 * in the page's own globals; the page's scripts cannot see or change it) under an object group of this call.
 * `verdict` waits for the answer after the wheel was sent; `release` drops the group (call it in a finally;
 * it never throws). Null when the tab cannot be asked: the caller judges as before.
 */
export async function armWheelObserver(
  vertical: boolean,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
): Promise<{ verdict(sign: 1 | -1, seenMs: number, settleMs: number, maxMs: number): Promise<WheelVerdict | null>; release(): Promise<void> } | null> {
  const objectGroup = `dtm-wheel-${process.pid}-${++wheelObserverSeq}`;
  let session: CdpSession;
  try {
    session = await openSession(await resolveTab(tabId, port), port);
  } catch {
    return null;
  }
  let objectId: string | undefined;
  let answered = false;
  // Takes the listeners off when no verdict did (the wheel threw, the verdict call failed), then drops the group:
  // a non-passive wheel listener left on window would make every later wheel on the page wait for the main
  // thread (gate 2 on #980).
  const release = async () => {
    if (objectId !== undefined && !answered) {
      try { await session.send("Runtime.callFunctionOn", { objectId, functionDeclaration: WHEEL_OBSERVER_CLEANUP_FN }); } catch { /* gone */ }
    }
    try { await session.send("Runtime.releaseObjectGroup", { objectGroup }); } catch { /* the page went away */ }
  };
  try {
    const tree = (await session.send("Page.getFrameTree", {})) as { frameTree?: { frame?: { id?: string } } };
    const frameId = tree.frameTree?.frame?.id;
    if (frameId === undefined) return null;
    const world = (await session.send("Page.createIsolatedWorld", { frameId, worldName: "desktop-touch-wheel" })) as { executionContextId?: number };
    if (world.executionContextId === undefined) return null;
    const made = (await session.send("Runtime.evaluate", {
      expression: wheelObserverExpr(vertical), contextId: world.executionContextId, returnByValue: false, objectGroup,
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    objectId = made.result?.objectId;
    if (made.exceptionDetails || objectId === undefined) { await release(); return null; }
    const id = objectId;
    return {
      verdict: async (sign, seenMs, settleMs, maxMs) => {
        try {
          const r = (await session.send("Runtime.callFunctionOn", {
            objectId: id, functionDeclaration: WHEEL_VERDICT_FN,
            arguments: [{ value: sign }, { value: seenMs }, { value: settleMs }, { value: maxMs }],
            awaitPromise: true, returnByValue: true,
          })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          const v = r.result?.value as WheelVerdict | undefined;
          if (!r.exceptionDetails && v !== undefined) answered = true;
          return !r.exceptionDetails && v !== undefined && typeof v.seen === "boolean" ? v : null;
        } catch {
          return null;
        }
      },
      release,
    };
  } catch {
    await release();
    return null;
  }
}

/**
 * Page-side JS that declares `zoom`, `monitorScale`, `chromeW` and `chromeH`: the viewport's offset
 * from the window origin (window.screenX / screenY), in DIPs, and the scales to convert with. Shared
 * by getElementScreenCoords and browser-resolver's gather so the two conversions cannot drift apart.
 *
 * win2 measured (internal #311, Chrome 155, zoom 90/100/125 % at display 100/150 %): screenX/screenY
 * and outerWidth/outerHeight are DIPs, unchanged by the page zoom; innerWidth/innerHeight are zoomed
 * css px; devicePixelRatio is the monitor's scale times the zoom. So the window origin and the insets
 * convert at the monitor's scale, and only css px inside the viewport at devicePixelRatio. Converting
 * all of it at devicePixelRatio, and subtracting zoomed inner sizes from DIP outer sizes, put a click
 * +150/+209 px off at 125 %. `zoom` comes from CDP (`getPageZoom`); at 1 this is the formula as before.
 *
 * On Windows the outer window carries an invisible resize border on the left,
 * right and bottom (8 px on Chrome/Edge), so outerWidth - innerWidth is both
 * side borders and outerHeight - innerHeight is the tab strip + address bar
 * PLUS the bottom border. The bottom border is taken to equal a side border
 * (internal #304: counting it put every click ~8 px below the centre). On macOS
 * there is no side border, so chromeW is 0 and nothing is taken off.
 *
 * A side panel (DevTools docked left/right, Chrome's side panel, Edge's
 * sidebar) also widens outerWidth - innerWidth, and then chromeW is not a
 * border: taking it off would aim hundreds of px up, into the tab strip. When
 * the gap is wider than two borders can be (32 px), the bottom border is left
 * in, as before #304. chromeW itself is then off by half the panel; that was so
 * before #304 too.
 */
export function viewportOriginJs(zoom: number): string {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return `  var zoom = ${z};
  var monitorScale = (window.devicePixelRatio || 1) / zoom;
  var innerWidthDip = window.innerWidth * zoom;
  var innerHeightDip = window.innerHeight * zoom;
  var chromeW = Math.round((window.outerWidth - innerWidthDip) / 2);
  var chromeH = window.outerHeight - innerHeightDip - (window.outerWidth - innerWidthDip <= 32 ? chromeW : 0);`;
}

/**
 * The id of the tab a null `tabId` stands for — the one defaultPageTab picks — so that two calls about "the
 * tab" ask the same one. `/json/list` order is not stable between calls (win2, 2026-10-24), and the
 * zoom read for one tab with the coordinates read for another put the click off (codex on #839).
 */
export async function resolveTabId(tabId: string | null, port = DEFAULT_CDP_PORT): Promise<string> {
  return (await resolveTab(tabId, port)).id;
}

/**
 * The tab's page zoom (internal #311), from CDP `Page.getLayoutMetrics` — `cssVisualViewport.zoom`,
 * 1.25 at 125 %. The page cannot tell its zoom from its monitor's scale: devicePixelRatio is their
 * product. 1 when CDP does not say, which keeps the conversion as it was before the zoom was known.
 */
export async function getPageZoom(tabId: string | null, port = DEFAULT_CDP_PORT): Promise<number> {
  try {
    const tab = await resolveTab(tabId, port);
    const session = await openSession(tab, port);
    const m = (await session.send("Page.getLayoutMetrics", {})) as { cssVisualViewport?: { zoom?: number } };
    const z = m.cssVisualViewport?.zoom;
    return typeof z === "number" && Number.isFinite(z) && z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

/**
 * Get screen coordinates of a DOM element identified by a CSS selector.
 * Coordinates are in physical pixels, compatible with mouse_click.
 *
 * Coordinate formula (zoom / monitorScale / chromeW / chromeH from viewportOriginJs):
 *   physX   = (window.screenX + chromeW) * monitorScale + rect.left * devicePixelRatio
 *   physY   = (window.screenY + chromeH) * monitorScale + rect.top  * devicePixelRatio
 *
 * window.screenX/Y in Chrome on Windows is the outer window position in CSS pixels.
 * getBoundingClientRect() is relative to the viewport (inner content area).
 * The difference (the browser chrome height) must be added explicitly.
 * Multiplying by devicePixelRatio converts CSS pixels to physical pixels,
 * which matches Win32 DPI-aware coordinates used by nut-js mouse.
 */
export async function getElementScreenCoords(
  selector: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
  opts: { allowZeroSize?: boolean } = {},
): Promise<ElementCoords> {
  // One tab for both reads: the zoom and the coordinates (codex on #839).
  const tab = await resolveTabId(tabId, port);
  const zoom = await getPageZoom(tab, port);
  const expression = `
(function() {
  var sel = ${JSON.stringify(selector)};
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ error: "Element not found: " + sel });
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && !${JSON.stringify(opts.allowZeroSize === true)}) {
    // zeroSize discriminant (issue #441): lets getElementScreenCoords throw a
    // typed ElementZeroSizeError so the click handler can route to the rescue.
    return JSON.stringify({ error: "Element has zero size (hidden or not rendered): " + sel, zeroSize: true });
  }
  var dpr     = window.devicePixelRatio || 1;
  var sx      = window.screenX;
  var sy      = window.screenY;
${viewportOriginJs(zoom)}
  var physLeft   = Math.round((sx + chromeW) * monitorScale + rect.left   * dpr);
  var physTop    = Math.round((sy + chromeH) * monitorScale + rect.top    * dpr);
  var physRight  = Math.round((sx + chromeW) * monitorScale + rect.right  * dpr);
  var physBottom = Math.round((sy + chromeH) * monitorScale + rect.bottom * dpr);
  return JSON.stringify({
    left:   physLeft,
    top:    physTop,
    width:  Math.round(rect.width  * dpr),
    height: Math.round(rect.height * dpr),
    x:      Math.round((physLeft + physRight)  / 2),
    y:      Math.round((physTop  + physBottom) / 2),
    // Raw window origin (CSS px) so the click caller can detect a minimized /
    // off-screen-parked window (window.screenX/Y === -32000) before issuing an
    // OS click that the OS would clamp to (0,0). See isOffscreenMinimized.
    screenX: sx,
    screenY: sy,
    viewport: {
      left: rect.left * dpr, top: rect.top * dpr, width: rect.width * dpr, height: rect.height * dpr,
      innerWidth: Math.round(window.innerWidth * dpr), innerHeight: Math.round(window.innerHeight * dpr),
    },
    inViewport: (function() {
      var cx = rect.left + rect.width / 2;
      var cy = rect.top  + rect.height / 2;
      return cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight;
    })(),
    // Generic occlusion hit-test (ADR-023 Phase 2b): is the click point actually
    // the target (or a descendant), or does something cover it? Modal-RULE
    // classification stays out of this engine eval — when occluded, the click
    // handler runs a separate modal probe (detectModal, pure TS). null when the
    // center is off-screen (the inViewport gate handles that case).
    occluded: (function() {
      var cx = rect.left + rect.width / 2;
      var cy = rect.top  + rect.height / 2;
      if (cx < 0 || cx >= window.innerWidth || cy < 0 || cy >= window.innerHeight) return false;
      var hit = document.elementFromPoint(cx, cy);
      return !!(hit && hit !== el && !Node.prototype.contains.call(el, hit));
    })(),
  });
})()`;

  const raw = (await evaluateInTab(expression, tab, port)) as string;
  let parsed: ({ error: string; zeroSize?: boolean } | (ElementCoords & { error?: undefined }));
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`Unexpected response from CDP: ${String(raw)}`);
  }
  if (parsed.error) {
    // Typed zero-size error (issue #441) so the click handler can intercept just
    // this case for the actionability rescue; "not found" stays a generic Error.
    if (parsed.zeroSize) throw new ElementZeroSizeError(parsed.error);
    throw new Error(parsed.error);
  }
  return parsed as ElementCoords;
}

// ─── TabContext helper ────────────────────────────────────────────────────────

export interface TabContext {
  /** Tab ID from CDP. null when the tab could not be identified (fallback/error path). */
  id: string | null;
  title: string;
  url: string;
  readyState: "loading" | "interactive" | "complete";
}

/**
 * Get the current tab context (id, title, url, readyState).
 * Best-effort: never throws; returns partial info on failure.
 */
export async function getTabContext(
  tabId: string | null,
  port = DEFAULT_CDP_PORT
): Promise<TabContext> {
  try {
    const tab = await resolveTab(tabId, port);
    const raw = await evaluateInTab(
      "JSON.stringify([document.title, location.href, document.readyState])",
      tab.id,
      port
    );
    const parsed = JSON.parse(raw as string) as [string, string, string];
    const rs = parsed[2];
    return {
      id: tab.id,
      title: parsed[0] ?? "",
      url: parsed[1] ?? "",
      readyState: (rs === "loading" || rs === "interactive" || rs === "complete")
        ? rs
        : "loading",
    };
  } catch {
    // null id signals "tab could not be identified" — callers should handle this
    return { id: null, title: "", url: "", readyState: "loading" };
  }
}

/**
 * Navigate the browser tab to a URL.
 * Only http:// and https:// URLs are accepted; javascript: and file: are rejected.
 * Returns { frameId, errorText } from Page.navigate response.
 */
export async function navigateTo(
  url: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<{ frameId?: string; errorText?: string }> {
  // P2 fix: reject non-http(s) URLs to prevent javascript: injection and file: access
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `browser_navigate only accepts http:// and https:// URLs. Got: ${url}`
    );
  }
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  const result = (await session.send("Page.navigate", { url })) as {
    frameId?: string;
    errorText?: string;
  } | null;
  return result ?? {};
}

/**
 * Get the DOM of an element (or document.body) as an HTML string.
 * Truncated to maxLength characters to avoid token overload.
 * Throws if the selector is provided but the element is not found.
 */
export async function getDomHtml(
  selector: string | null = null,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
  maxLength = 10_000
): Promise<string> {
  let expr: string;
  if (selector) {
    // P2 fix: return structured error so caller can distinguish not-found from HTML content
    expr = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.outerHTML : JSON.stringify({__cdpError: "Element not found: " + ${JSON.stringify(selector)}});
    })()`;
  } else {
    expr = `document.body.outerHTML`;
  }

  const result = (await evaluateInTab(expr, tabId, port)) as string;
  const str = String(result);

  // Check for structured error response
  if (str.startsWith('{"__cdpError"')) {
    try {
      const errObj = JSON.parse(str) as { __cdpError: string };
      throw new Error(errObj.__cdpError);
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Not a structured error, treat as HTML
      } else {
        throw e;
      }
    }
  }

  return str.length > maxLength
    ? str.substring(0, maxLength) + `\n... [truncated at ${maxLength} chars, use a more specific selector]`
    : str;
}

/**
 * Activate (bring to foreground) a specific tab by its CDP tab ID.
 * Uses the CDP HTTP /json/activate endpoint — does not require a WebSocket session.
 */
export async function activateTab(tabId: string, port = DEFAULT_CDP_PORT): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/json/activate/${tabId}`, {
    method: "GET",
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`CDP activate failed: HTTP ${res.status}`);
  }
}

/**
 * Close all cached CDP sessions for a given port.
 */
export function disconnectAll(port = DEFAULT_CDP_PORT): void {
  const prefix = `${port}:`;
  // P1 fix: collect entries before iterating to avoid mutation-during-iteration
  // and prevent the ws "close" handler from double-deleting Map entries.
  const toClose = [...sessions.entries()].filter(([k]) => k.startsWith(prefix));
  for (const [key, session] of toClose) {
    sessions.delete(key); // delete first so "close" handler finds nothing to delete
    session.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SmartScroll — CDP ancestor walk, scroll control, sticky-header, virtual lists
// ─────────────────────────────────────────────────────────────────────────────

export interface CdpScrollAncestor {
  cssSelectorPath: string;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  overflowX: string;
  overflowY: string;
  /** true when overflow is "hidden" (scrolls silently swallowed). */
  isHidden: boolean;
  /** true when the container looks like a virtualised list. */
  isVirtualized: boolean;
}

/**
 * Walk the DOM ancestor chain of the given CSS selector and return all scrollable
 * ancestors (outer → inner). Pierces shadow roots; skips cross-origin iframes
 * (warning is added to the returned warnings array).
 */
export async function getScrollAncestorsCdp(
  selector: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT,
  maxDepth = 3,
  markHidden = false
): Promise<{ ancestors: CdpScrollAncestor[]; warnings: string[] }> {
  const expr = `
(function() {
  const MAXDEPTH = ${maxDepth};
  const MARK_HIDDEN = ${markHidden};
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ancestors: [], warnings: ['Element not found: ' + ${JSON.stringify(selector)}] };

  const ancestors = [];
  const warnings = [];
  let depth = 0;
  // parentNode from Node's own getter, and the walk capped: a form whose control is named parentNode made the input
  // the form's parent and the form the input's, and the walk ran to the CDP timeout (/code-review on #1020).
  const __pnGet = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get;
  const pn = function(n) { return __pnGet.call(n); };
  let steps = 0;
  let cur = pn(el);

  function getHost(node) {
    try {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) return root.host;
    } catch (_) { /* ignore */ }
    return null;
  }

  function selectorPath(node) {
    if (!node || node === document.documentElement) return 'html';
    const tag = node.tagName ? node.tagName.toLowerCase() : '?';
    const id = node.id ? '#' + node.id : '';
    if (id) return tag + id;
    const classes = node.classList ? '.' + [...node.classList].slice(0, 2).join('.') : '';
    return tag + (classes || '');
  }

  while (cur && depth < MAXDEPTH && steps++ < 10000) {
    // Shadow DOM: skip to host
    const host = getHost(cur);
    if (host) { cur = host; continue; }

    // iframe descent (same-origin only)
    if (cur.tagName === 'IFRAME') {
      try {
        const doc = cur.contentDocument;
        if (doc) { cur = doc.body; continue; }
      } catch (_) {
        warnings.push('cross-origin-iframe-skipped');
        break;
      }
    }

    if (cur === document.documentElement || cur === document.body || !cur.tagName) {
      cur = pn(cur);
      continue;
    }

    const style = getComputedStyle(cur);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollable = overflowY === 'scroll' || overflowY === 'auto' || overflowY === 'overlay'
                    || overflowX === 'scroll' || overflowX === 'auto' || overflowX === 'overlay';
    const hidden = overflowY === 'hidden' || overflowX === 'hidden';

    if (scrollable || hidden) {
      const isVirtualized = ('__tanstackVirtualInstance' in cur)
        || !!cur.querySelector('[data-index]');
      const isHidden = hidden && !scrollable;
      if (isHidden && MARK_HIDDEN) {
        // Mark element so callers can unlock via querySelectorAll without embedding selector strings.
        // Only marked when the caller opts in (expandHidden=true) so early-return paths leave no stale markers.
        cur.setAttribute('data-dt-hidden-ancestor', '');
      }
      ancestors.push({
        cssSelectorPath: selectorPath(cur),
        scrollTop: cur.scrollTop,
        scrollLeft: cur.scrollLeft,
        scrollHeight: cur.scrollHeight,
        clientHeight: cur.clientHeight,
        scrollWidth: cur.scrollWidth,
        clientWidth: cur.clientWidth,
        overflowX,
        overflowY,
        isHidden,
        isVirtualized,
      });
      depth++;
    }

    cur = pn(cur);
  }

  return { ancestors, warnings };
})()`;

  try {
    const result = await evaluateInTab(expr, tabId, port) as {
      ancestors: CdpScrollAncestor[];
      warnings: string[];
    };
    return result ?? { ancestors: [], warnings: [] };
  } catch (err) {
    return { ancestors: [], warnings: [String(err)] };
  }
}

/**
 * Set the scrollTop / scrollLeft of the element matching the selector.
 */
export async function setScrollPositionCdp(
  selector: string,
  top: number,
  left: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<{ ok: boolean; newTop: number; newLeft: number }> {
  const expr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, newTop: 0, newLeft: 0 };
  el.scrollTop = ${top};
  el.scrollLeft = ${left};
  return { ok: true, newTop: el.scrollTop, newLeft: el.scrollLeft };
})()`;
  try {
    const result = await evaluateInTab(expr, tabId, port) as { ok: boolean; newTop: number; newLeft: number };
    return result;
  } catch {
    return { ok: false, newTop: 0, newLeft: 0 };
  }
}

/**
 * Detect whether the element matching selector is occluded by a sticky or fixed header
 * after scrolling. Returns occluded=true only when position is sticky/fixed, z-index ≥ 1,
 * and the x-range overlaps the target element.
 */
export async function detectStickyHeaderCdp(
  selector: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<{ occluded: boolean; headerRect?: { top: number; left: number; width: number; height: number } }> {
  const expr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { occluded: false };
  const rect = el.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const probeY = 4;
  const header = document.elementFromPoint(midX, probeY);
  if (!header || Node.prototype.contains.call(el, header) || Node.prototype.contains.call(header, el)) return { occluded: false };
  const hs = getComputedStyle(header);
  const position = hs.position;
  if (position !== 'sticky' && position !== 'fixed') return { occluded: false };
  const zi = parseInt(hs.zIndex, 10);
  if (isNaN(zi) || zi < 1) return { occluded: false };
  const hr = header.getBoundingClientRect();
  // Check x-range overlap
  if (hr.right < rect.left || hr.left > rect.right) return { occluded: false };
  return { occluded: true, headerRect: { top: hr.top, left: hr.left, width: hr.width, height: hr.height } };
})()`;
  try {
    const result = await evaluateInTab(expr, tabId, port) as {
      occluded: boolean;
      headerRect?: { top: number; left: number; width: number; height: number };
    };
    return result;
  } catch {
    return { occluded: false };
  }
}

/**
 * Scroll a virtualised list container to bring `virtualIndex` into view.
 * Tries TanStack API first, then data-index DOM query, then binary bisect (≤ 6 iterations).
 */
export async function scrollVirtualListCdp(
  selector: string,
  virtualIndex: number,
  virtualTotal: number,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<{ ok: boolean; scrolled: boolean; method: string; warnings: string[] }> {
  const expr = `
(function() {
  const container = document.querySelector(${JSON.stringify(selector)});
  if (!container) return { ok: false, scrolled: false, method: 'none', warnings: ['Container not found'] };
  const idx = ${virtualIndex};
  const total = ${virtualTotal};

  // 1. TanStack Virtual API
  if ('__tanstackVirtualInstance' in container) {
    try {
      container.__tanstackVirtualInstance.scrollToIndex(idx, { align: 'center' });
      return { ok: true, scrolled: true, method: 'tanstack', warnings: [] };
    } catch (_) { /* fall through */ }
  }

  // 2. data-index DOM element
  const item = container.querySelector('[data-index="' + idx + '"]');
  if (item) {
    item.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { ok: true, scrolled: true, method: 'data-index', warnings: [] };
  }

  // 3. Proportional bisect (≤ 6 iterations)
  const LIMIT = 6;
  let lo = 0, hi = 1, bestDist = Infinity;
  for (let i = 0; i < LIMIT; i++) {
    const ratio = (lo + hi) / 2;
    container.scrollTop = Math.round(ratio * container.scrollHeight);
    // Find closest visible data-index
    const items = container.querySelectorAll('[data-index]');
    let closest = null, closestDist = Infinity;
    for (const it of items) {
      const di = parseInt(it.getAttribute('data-index'), 10);
      const d = Math.abs(di - idx);
      if (d < closestDist) { closestDist = d; closest = di; }
    }
    if (closest === null) break;
    bestDist = closestDist;
    if (closest < idx) lo = ratio;
    else if (closest > idx) hi = ratio;
    else break; // found
  }

  return {
    ok: true,
    scrolled: true,
    method: 'bisect',
    warnings: bestDist > 5 ? ['Bisect ended ' + bestDist + ' items from target'] : [],
  };
})()`;
  try {
    const result = await evaluateInTab(expr, tabId, port) as {
      ok: boolean; scrolled: boolean; method: string; warnings: string[];
    };
    return result;
  } catch (err) {
    return { ok: false, scrolled: false, method: 'error', warnings: [String(err)] };
  }
}
