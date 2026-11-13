/**
 * internal #403 item 2 — markScrollersAtPoint's CDP side (agy on #978: the dispatcher stubs it, and the page
 * expression is run on its own elsewhere). A real WebSocket server stands in for the tab; /json is stubbed to
 * point at it. The containers are held under an object group of the call and read through their object id,
 * so nothing is left in the page's globals, and the group is released on every road out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { markScrollersAtPoint, READ_SCROLLERS_FN, disconnectAll } from "../../src/engine/cdp-bridge.js";

type Msg = { id: number; method: string; params: Record<string, unknown> };
let server: WebSocketServer;
let port = 0;
const PORT = 39002;
let log: Msg[] = [];
/** How the fake page answers each method; a function of the message. */
let answer: (m: Msg) => unknown = () => ({});

beforeAll(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as { port: number }).port;
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      log.push(msg);
      const a = answer(msg);
      socket.send(JSON.stringify(a instanceof Error ? { id: msg.id, error: { message: a.message } } : { id: msg.id, result: a }));
    });
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => [{ id: "TAB", type: "page", title: "t", url: "https://x.test/", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/TAB` }],
  })));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  disconnectAll(PORT);
  for (const c of server.clients) c.terminate();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { log = []; });

const page = (positions: unknown, later: unknown = positions) => {
  let reads = 0;
  return (m: Msg) => {
    if (m.method === "Runtime.evaluate") return { result: { type: "object", objectId: "OBJ-1" } };
    if (m.method === "Runtime.callFunctionOn") return { result: { type: "object", value: reads++ === 0 ? positions : later } };
    if (m.method === "Runtime.releaseObjectGroup") return {};
    return new Error(`unexpected ${m.method}`);
  };
};
const methods = () => log.map((m) => m.method);

describe("markScrollersAtPoint", () => {
  it("evaluates the expression without returning by value, under its own group; reads through the object id; release drops the group", async () => {
    answer = page([{ top: 4, left: 0 }], [{ top: 90, left: 0 }]);
    const m = await markScrollersAtPoint(640, 400, "TAB", PORT);
    expect(m?.positions).toEqual([{ top: 4, left: 0 }]);
    expect(await m!.read()).toEqual([{ top: 90, left: 0 }]);
    await m!.release();
    const ev = log.find((x) => x.method === "Runtime.evaluate")!;
    expect(ev.params).toMatchObject({ returnByValue: false });
    expect(String(ev.params.expression)).toContain("})(640, 400)");
    const group = ev.params.objectGroup as string;
    expect(group).toMatch(/^dtm-scrollers-/);
    const calls = log.filter((x) => x.method === "Runtime.callFunctionOn");
    expect(calls.map((c) => c.params)).toEqual([
      { objectId: "OBJ-1", functionDeclaration: READ_SCROLLERS_FN, returnByValue: true },
      { objectId: "OBJ-1", functionDeclaration: READ_SCROLLERS_FN, returnByValue: true },
    ]);
    expect(log.at(-1)).toMatchObject({ method: "Runtime.releaseObjectGroup", params: { objectGroup: group } });
  });

  it("two calls use two groups", async () => {
    answer = page([]);
    await markScrollersAtPoint(1, 1, "TAB", PORT);
    await markScrollersAtPoint(1, 1, "TAB", PORT);
    const groups = log.filter((x) => x.method === "Runtime.evaluate").map((x) => x.params.objectGroup);
    expect(new Set(groups).size).toBe(2);
  });

  it("the page throws, gives no object, or its first read fails: null, and the group is released", async () => {
    const roads: Array<(m: Msg) => unknown> = [
      (m) => (m.method === "Runtime.evaluate" ? { result: { type: "object" }, exceptionDetails: { text: "boom" } } : {}),
      (m) => (m.method === "Runtime.evaluate" ? { result: { type: "undefined" } } : {}),
      (m) => (m.method === "Runtime.evaluate" ? { result: { type: "object", objectId: "O" } } : m.method === "Runtime.callFunctionOn" ? new Error("gone") : {}),
      (m) => (m.method === "Runtime.evaluate" ? new Error("Execution context was destroyed") : {}),
    ];
    for (const road of roads) {
      log = [];
      answer = road;
      expect(await markScrollersAtPoint(1, 1, "TAB", PORT)).toBeNull();
      expect(methods().at(-1)).toBe("Runtime.releaseObjectGroup");
    }
  });

  it("a read after the wheel that fails answers null; release never throws", async () => {
    answer = page([{ top: 0, left: 0 }]);
    const m = await markScrollersAtPoint(1, 1, "TAB", PORT);
    answer = (x) => (x.method === "Runtime.callFunctionOn" || x.method === "Runtime.releaseObjectGroup" ? new Error("gone") : {});
    expect(await m!.read()).toBeNull();
    await expect(m!.release()).resolves.toBeUndefined();
  });

  it("no tab to ask: null, and nothing sent", async () => {
    expect(await markScrollersAtPoint(1, 1, "NO-SUCH-TAB", PORT)).toBeNull();
    expect(log).toEqual([]);
  });
});
