/**
 * internal #415 — `dispatchMouseMoveInTab` moves the pointer and `dispatchClickInTab` presses and releases, in the
 * tab, and when they fail they say whether the press was sent. `desktop_act` falls back to an OS click only when
 * it was not: a fallback after a sent press would click twice (a check box toggled back, a button pressed twice).
 *
 * A fake browser on a local port: `/json` lists one tab, and its WebSocket answers each command until the method
 * and type the case names, where it closes the socket instead of answering.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import { CdpClickDispatchError, disconnectAll, dispatchClickInTab, dispatchMouseMoveInTab } from "../../src/engine/cdp-bridge.js";

type Sent = { method: string; type?: string; button?: string; x?: number; y?: number };

let server: Server | undefined;
let port = 0;

async function fakeBrowser(closeAtType: string | null): Promise<Sent[]> {
  const sent: Sent[] = [];
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([
      { id: "T1", type: "page", title: "fixture", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1` },
    ]));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> };
      const type = msg.params?.type as string | undefined;
      sent.push({ method: msg.method, type, button: msg.params?.button as string | undefined, x: msg.params?.x as number, y: msg.params?.y as number });
      if (type === closeAtType) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return sent;
}

afterEach(async () => {
  disconnectAll(port);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("dispatchMouseMoveInTab / dispatchClickInTab (internal #415)", () => {
  it("sends move, then press and release, to the tab at the point", async () => {
    const sent = await fakeBrowser(null);
    await dispatchMouseMoveInTab(12.5, 40, "T1", port);
    await dispatchClickInTab(12.5, 40, "T1", port);
    expect(sent).toEqual([
      { method: "Input.dispatchMouseEvent", type: "mouseMoved", button: "none", x: 12.5, y: 40 },
      { method: "Input.dispatchMouseEvent", type: "mousePressed", button: "left", x: 12.5, y: 40 },
      { method: "Input.dispatchMouseEvent", type: "mouseReleased", button: "left", x: 12.5, y: 40 },
    ]);
  });

  it("says the press was not sent when the browser fails on the move", async () => {
    await fakeBrowser("mouseMoved");
    const err = await dispatchMouseMoveInTab(1, 1, "T1", port).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CdpClickDispatchError);
    expect((err as CdpClickDispatchError).pressSent).toBe(false);
  });

  it("says the press may have been sent when the browser fails on the press", async () => {
    await fakeBrowser("mousePressed");
    const err = await dispatchClickInTab(1, 1, "T1", port).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CdpClickDispatchError);
    expect((err as CdpClickDispatchError).pressSent).toBe(true);
  });

  it("says the press was sent when the browser fails on the release", async () => {
    await fakeBrowser("mouseReleased");
    const err = await dispatchClickInTab(1, 1, "T1", port).then(() => null, (e: unknown) => e);
    expect((err as CdpClickDispatchError).pressSent).toBe(true);
  });

  it("says the press was not sent when the tab is not there", async () => {
    await fakeBrowser(null);
    const err = await dispatchClickInTab(1, 1, "T9", port).then(() => null, (e: unknown) => e);
    expect((err as CdpClickDispatchError).pressSent).toBe(false);
  });
});
