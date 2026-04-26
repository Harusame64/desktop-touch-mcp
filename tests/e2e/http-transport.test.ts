/**
 * http-transport.test.ts — E2E tests for the HTTP transport mode
 *
 * Starts the server with --http --port, runs MCP protocol requests,
 * and verifies that the stateless HTTP transport behaves correctly.
 *
 * Tests:
 *  - H1: /health returns { status: "ok" }
 *  - H2: POST /mcp initialize → 200, serverInfo present, no session ID (stateless)
 *  - H3: POST /mcp tools/list → 200, non-empty tools array (≥ 50 tools)
 *  - H4: Multiple parallel initialize requests all succeed (stateless isolation)
 *  - H5: OPTIONS /mcp returns CORS headers
 *  - H6: DNS rebinding protection — Host: evil.attacker.com → 403
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = parseInt(process.env.E2E_HTTP_PORT ?? "29847", 10); // override via E2E_HTTP_PORT to avoid port conflicts
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const HEALTH_URL = `${BASE}/health`;

const SERVER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/index.js"
);

let serverProcess: ChildProcess;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function mcpPost(
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  return fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function initializeBody(clientName = "e2e-test") {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0.0.1" },
    },
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  serverProcess = spawn("node", [SERVER_SCRIPT, "--http", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, DESKTOP_TOUCH_NO_TRAY: "1" },
  });

  // Collect stderr for diagnostics
  const stderrChunks: string[] = [];
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });
  serverProcess.on("error", (err) => {
    stderrChunks.push(`spawn error: ${err.message}`);
  });
  serverProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[http-transport.test] Server exited early (code ${code}):\n${stderrChunks.join("")}`);
    }
  });

  // Wait until /health responds (max 20s)
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const r = await fetch(HEALTH_URL);
      if (r.ok) break;
    } catch {
      // still starting
    }
  }

  // Final check — throw with diagnostics if server never came up
  let healthy = false;
  try {
    const r = await fetch(HEALTH_URL);
    healthy = r.ok;
  } catch {
    // not up
  }
  if (!healthy) {
    serverProcess.kill();
    throw new Error(
      `HTTP server did not start on port ${PORT} within 20s.\nServer stderr:\n${stderrChunks.join("")}`
    );
  }
}, 25_000);

afterAll(() => {
  serverProcess?.kill();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("H1: Health endpoint", () => {
  it("GET /health returns status=ok and name", async () => {
    const r = await fetch(HEALTH_URL);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { status: string; name: string; version: string };
    expect(json.status).toBe("ok");
    expect(json.name).toBe("desktop-touch-mcp");
    expect(typeof json.version).toBe("string");
  });
});

describe("H2: MCP initialize (stateless)", () => {
  it("returns 200 with serverInfo", async () => {
    const r = await mcpPost(initializeBody());
    expect(r.status).toBe(200);

    const json = (await r.json()) as {
      result?: { serverInfo?: { name: string }; protocolVersion?: string };
    };
    expect(json.result?.serverInfo?.name).toBe("desktop-touch");
    expect(typeof json.result?.protocolVersion).toBe("string");
  });

  it("does NOT return a mcp-session-id header (stateless mode)", async () => {
    const r = await mcpPost(initializeBody());
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
  });
});

describe("H3: tools/list", () => {
  // Phase 4: stub catalog 26 + 2 dynamic v2 (desktop_discover / desktop_act) = 28.
  it("returns 200 with ≥ 28 tools", async () => {
    const r = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(r.status).toBe(200);

    const json = (await r.json()) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(json.result?.tools)).toBe(true);
    expect((json.result!.tools as unknown[]).length).toBeGreaterThanOrEqual(28);
  });
});

describe("H4: Parallel stateless isolation", () => {
  it("3 concurrent initialize requests all succeed independently", async () => {
    const results = await Promise.all(
      ["client-a", "client-b", "client-c"].map((name) => mcpPost(initializeBody(name)))
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      const json = (await r.json()) as { result?: { serverInfo?: { name: string } } };
      expect(json.result?.serverInfo?.name).toBe("desktop-touch");
    }
  });
});

describe("H5: CORS preflight", () => {
  it("OPTIONS /mcp from a localhost origin echoes that origin back", async () => {
    const r = await fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(r.headers.get("Vary")).toMatch(/Origin/);
    expect(r.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
  });

  it("OPTIONS /mcp from a non-localhost origin omits Allow-Origin (CORS denies the response)", async () => {
    const r = await fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("H6: DNS rebinding protection", () => {
  it("request with non-localhost Host header returns 403", async () => {
    // Node's fetch doesn't allow overriding the Host header directly,
    // so we send directly via a raw HTTP request using net.Socket.
    const { connect } = await import("node:net");
    const response = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify(initializeBody());
      const req = [
        `POST /mcp HTTP/1.1`,
        `Host: evil.attacker.com`,
        `Content-Type: application/json`,
        `Accept: application/json`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        `Connection: close`,
        ``,
        body,
      ].join("\r\n");

      const socket = connect(PORT, "127.0.0.1", () => {
        socket.write(req);
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5000);
    });
    // First line of HTTP response: "HTTP/1.1 403 ..."
    expect(response).toMatch(/^HTTP\/1\.1 403/);
  });
});
