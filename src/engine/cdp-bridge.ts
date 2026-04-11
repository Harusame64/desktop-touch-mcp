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

/**
 * Navigate the browser tab to a URL.
 * Only http:// and https:// URLs are accepted; javascript: and file: are rejected.
 */
export async function navigateTo(
  url: string,
  tabId: string | null = null,
  port = DEFAULT_CDP_PORT
): Promise<void> {
  // P2 fix: reject non-http(s) URLs to prevent javascript: injection and file: access
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `browser_navigate only accepts http:// and https:// URLs. Got: ${url}`
    );
  }
  const tab = await resolveTab(tabId, port);
  const session = await openSession(tab, port);
  await session.send("Page.navigate", { url });
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
