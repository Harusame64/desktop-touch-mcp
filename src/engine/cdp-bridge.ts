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

export const DEFAULT_CDP_PORT = 9222;
const CMD_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;

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
    throw new Error(
      `Cannot reach Chrome/Edge CDP at port ${port}. ` +
        `Make sure the browser is running with --remote-debugging-port=${port}. ` +
        `Original error: ${String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`CDP /json returned HTTP ${res.status}`);
  }
  return (await res.json()) as CdpTab[];
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
    const pageTab = tabs.find((t) => t.type === "page") ?? tabs[0];
    return pageTab;
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
): Promise<Array<{ id: string; title: string; url: string }>> {
  const tabs = await fetchTabs(port);
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url }));
}

/**
 * Evaluate a JavaScript expression in a browser tab.
 *
 * @param expression  JS expression string (may use `await`)
 * @param tabId       Target tab ID (null = first page tab)
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
 * Get screen coordinates of a DOM element identified by a CSS selector.
 * Coordinates are in physical pixels, compatible with mouse_click.
 *
 * Coordinate formula:
 *   chromeH = outerHeight - innerHeight  (browser tab strip + address bar, in CSS px)
 *   physX   = (window.screenX + chromeW/2 + rect.left) * devicePixelRatio
 *   physY   = (window.screenY + chromeH   + rect.top)  * devicePixelRatio
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
  port = DEFAULT_CDP_PORT
): Promise<ElementCoords> {
  const expression = `
(function() {
  var sel = ${JSON.stringify(selector)};
  var el = document.querySelector(sel);
  if (!el) return JSON.stringify({ error: "Element not found: " + sel });
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return JSON.stringify({ error: "Element has zero size (hidden or not rendered): " + sel });
  }
  var dpr     = window.devicePixelRatio || 1;
  var sx      = window.screenX;
  var sy      = window.screenY;
  // Browser chrome offsets: outerHeight-innerHeight = tab strip + address bar height in CSS px.
  // outerWidth-innerWidth = left+right frame (usually 0 on Chrome; scrollbar is inside innerWidth).
  var chromeH = window.outerHeight - window.innerHeight;
  var chromeW = Math.round((window.outerWidth - window.innerWidth) / 2);
  var physLeft   = Math.round((sx + chromeW + rect.left)            * dpr);
  var physTop    = Math.round((sy + chromeH + rect.top)             * dpr);
  var physRight  = Math.round((sx + chromeW + rect.right)           * dpr);
  var physBottom = Math.round((sy + chromeH + rect.bottom)          * dpr);
  return JSON.stringify({
    left:   physLeft,
    top:    physTop,
    width:  Math.round(rect.width  * dpr),
    height: Math.round(rect.height * dpr),
    x:      Math.round((physLeft + physRight)  / 2),
    y:      Math.round((physTop  + physBottom) / 2),
    inViewport: (function() {
      var cx = rect.left + rect.width / 2;
      var cy = rect.top  + rect.height / 2;
      return cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight;
    })(),
  });
})()`;

  const raw = (await evaluateInTab(expression, tabId, port)) as string;
  let parsed: ({ error: string } | (ElementCoords & { error?: undefined }));
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`Unexpected response from CDP: ${String(raw)}`);
  }
  if (parsed.error) {
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
  let cur = el.parentNode;

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

  while (cur && depth < MAXDEPTH) {
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
      cur = cur.parentNode;
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

    cur = cur.parentNode;
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
  if (!header || el.contains(header) || header.contains(el)) return { occluded: false };
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
