#!/usr/bin/env node
// Mac port M3-1: the macOS server answers over MCP. Runs in CI on a macOS runner, where this
// process has no Accessibility or Screen Recording grant — so it also checks that the tools say so
// (PermissionRequired) instead of failing some other way. Exits non-zero on any surprise.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = ["desktop_act", "desktop_discover", "desktop_state", "screenshot"];
const fail = (msg) => {
  console.error(`[smoke-macos] FAIL — ${msg}`);
  process.exit(1);
};

const client = new Client({ name: "smoke-macos", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "inherit" }));

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
if (tools.join(",") !== EXPECTED_TOOLS.join(",")) {
  fail(`tools/list is ${JSON.stringify(tools)}, expected ${JSON.stringify(EXPECTED_TOOLS)} (the stub answers when the darwin addon did not load)`);
}

const r = await client.callTool({ name: "desktop_state", arguments: {} });
const text = r.content.find((b) => b.type === "text")?.text ?? "";
let body;
try {
  body = JSON.parse(text);
} catch {
  fail(`desktop_state did not answer JSON: ${text.slice(0, 200)}`);
}
const granted = body.permissions?.accessibility === true;
if (!granted && body.code !== "PermissionRequired") {
  fail(`without Accessibility, desktop_state answered ${text.slice(0, 300)} instead of PermissionRequired`);
}
await client.close();
console.error(
  `[smoke-macos] OK — tools: ${tools.join(", ")}; desktop_state: ${granted ? `attention=${body.attention}` : "PermissionRequired (no grant on this machine)"}`
);
