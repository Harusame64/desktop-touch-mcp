#!/usr/bin/env node
// Mac port M3-1: the macOS server answers over MCP. Runs in CI on a macOS runner. GitHub's macOS
// runners turned out to have Accessibility granted (run 37196868028), so CI walks the granted road:
// desktop_state must then read without errors. Without a grant it must answer PermissionRequired —
// never some other failure. Every request has a timeout. Exits non-zero on any surprise.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = ["desktop_act", "desktop_discover", "desktop_state", "screenshot"];
const fail = (msg) => {
  console.error(`[smoke-macos] FAIL — ${msg}`);
  process.exit(1);
};

const client = new Client({ name: "smoke-macos", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "inherit" }));

const REQUEST = { timeout: 30_000 };
const tools = (await client.listTools(undefined, REQUEST)).tools.map((t) => t.name).sort();
if (tools.join(",") !== EXPECTED_TOOLS.join(",")) {
  fail(`tools/list is ${JSON.stringify(tools)}, expected ${JSON.stringify(EXPECTED_TOOLS)} (the stub answers when the darwin addon did not load)`);
}

const r = await client.callTool({ name: "desktop_state", arguments: {} }, undefined, REQUEST);
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
// Granted: the reads themselves must work — desktop_state fails open, so a body that only says
// "accessibility: true" could still be every read failing (gate 2, #783).
if (granted && (body.hints?.readErrors !== undefined || typeof body.visibleWindows !== "number")) {
  fail(`with Accessibility, desktop_state did not read the desktop: ${text.slice(0, 300)}`);
}
await client.close();
console.error(
  `[smoke-macos] OK — tools: ${tools.join(", ")}; desktop_state: ${granted ? `attention=${body.attention}, visibleWindows=${body.visibleWindows}` : "PermissionRequired (no Accessibility grant)"}`
);
