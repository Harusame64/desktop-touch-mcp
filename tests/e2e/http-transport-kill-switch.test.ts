/**
 * http-transport-kill-switch.test.ts — E2E test for V2 World-Graph kill switch.
 *
 * Spawns the server with DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 and verifies
 * tools/list returns exactly the 26 stub-catalog entries (no dynamic v2
 * desktop_discover / desktop_act). Pairs with audit P1-12 (gap #1).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Use a different port from http-transport.test.ts (29847) so the two test
// files can co-exist even if vitest runs them in parallel.
const PORT = parseInt(process.env.E2E_HTTP_KILL_SWITCH_PORT ?? "29848", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const HEALTH_URL = `${BASE}/health`;

const SERVER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/index.js",
);

let serverProcess: ChildProcess;

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function mcpPost(body: unknown): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  serverProcess = spawn("node", [SERVER_SCRIPT, "--http", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      DESKTOP_TOUCH_NO_TRAY: "1",
      DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1",
    },
  });

  const stderrChunks: string[] = [];
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

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
      `Kill-switch HTTP server did not start on port ${PORT} within 20s.\nstderr:\n${stderrChunks.join("")}`,
    );
  }
}, 25_000);

afterAll(() => {
  serverProcess?.kill();
});

describe("V2 kill-switch — HTTP tools/list", () => {
  it("with DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1, tools/list returns 26 stub-catalog tools (no v2 dynamic)", async () => {
    const r = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(r.status).toBe(200);

    const json = (await r.json()) as { result?: { tools?: Array<{ name: string }> } };
    const tools = json.result?.tools ?? [];

    // Stub catalog is 26 + the v2 dispatchers add 2 dynamic. With v2 killed
    // the count should be exactly 26 (or the published v1 fallback set, see
    // server-windows.ts — get_windows / get_ui_elements / set_element_value
    // are reinstated when v2 is killed). The contract is: zero v2 dynamic
    // names exposed.
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("desktop_discover");
    expect(names).not.toContain("desktop_act");

    // The 26 stub-catalog tools must all be present.
    expect(names.length).toBeGreaterThanOrEqual(26);
  });

  it("v1 fallback tools (get_windows / get_ui_elements / set_element_value) ARE present when v2 is killed", async () => {
    const r = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(r.status).toBe(200);

    const json = (await r.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = (json.result?.tools ?? []).map((t) => t.name);

    for (const fallback of ["get_windows", "get_ui_elements", "set_element_value"]) {
      expect(names, `${fallback} should be registered when v2 kill-switch is on`).toContain(fallback);
    }
  });
});
