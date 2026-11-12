/**
 * ADR-040 PR ③ — getWindowsForTargets: `Browser.getWindowForTarget` on the browser endpoint, its window id and
 * bounds for each target (agy on #971: the bounds read had no test). A real WebSocket server stands in for
 * the browser; /json/version is stubbed to point at it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer } from "ws";
import { getWindowsForTargets, getWindowIdsForTargets } from "../../src/engine/cdp-bridge.js";

const ANSWERS: Record<string, unknown> = {
  WITH: { windowId: 7, bounds: { left: 100, top: 50, width: 1200, height: 800, windowState: "normal" } },
  NOBOUNDS: { windowId: 8 },
  PARTIAL: { windowId: 9, bounds: { left: 0, top: 0, width: 640 } },
  NOID: { bounds: { left: 0, top: 0, width: 10, height: 10 } },
};

let server: WebSocketServer;
let port = 0;
const asked: string[] = [];

beforeAll(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as { port: number }).port;
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string; params: { targetId: string } };
      asked.push(`${msg.method}:${msg.params.targetId}`);
      const answer = ANSWERS[msg.params.targetId];
      socket.send(JSON.stringify(answer === undefined
        ? { id: msg.id, error: { message: "No target with given id found" } }
        : { id: msg.id, result: answer }));
    });
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }),
  })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

describe("getWindowsForTargets (ADR-040 PR ③)", () => {
  it("gives each target's window id and, when all four numbers came, its bounds; leaves out a target the call failed for or that named no window", async () => {
    const w = await getWindowsForTargets(["WITH", "NOBOUNDS", "PARTIAL", "NOID", "GONE"], 39001);
    expect(w).toEqual(new Map<string, unknown>([
      ["WITH", { windowId: 7, bounds: { left: 100, top: 50, width: 1200, height: 800 } }],
      ["NOBOUNDS", { windowId: 8 }],
      ["PARTIAL", { windowId: 9 }],
    ]));
    expect(asked).toContain("Browser.getWindowForTarget:WITH");
  });
  it("getWindowIdsForTargets is the window ids of the same answer", async () => {
    expect(await getWindowIdsForTargets(["WITH", "NOBOUNDS", "GONE"], 39001)).toEqual(new Map([["WITH", 7], ["NOBOUNDS", 8]]));
  });
});
