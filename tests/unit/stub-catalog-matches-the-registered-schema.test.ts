/**
 * internal #252, gate 2 on #792 — the stub catalog checked against what the Windows server's
 * `tools/list` actually answers, not against the generator's own account of itself.
 *
 * The generator reads source text. Where it could not read something it used to substitute — an
 * open `{}` for a union of named variants (excel, key_locker), a placeholder sentence for a field
 * given by name (mouse `verifyDelivery`), nothing for `.max(CONST)` (terminal `paneId`), nothing
 * for a `...spread` (terminal read/send) — and `check:stub-catalog` compared the catalog only with
 * its own regeneration, so every substitution was committed green. These cells register the real
 * tools on a real `McpServer` and read `tools/list` through the SDK's client, which is what a
 * client sees; the generator has no part in the expected side.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";
import { registerScreenshotTools } from "../../src/tools/screenshot.js";
import { registerMouseTools } from "../../src/tools/mouse.js";
import { registerKeyboardTools } from "../../src/tools/keyboard.js";
import { registerWindowTools } from "../../src/tools/window.js";
import { registerUiElementTools } from "../../src/tools/ui-elements.js";
import { registerWorkspaceTools } from "../../src/tools/workspace.js";
import { registerMacroTools } from "../../src/tools/macro.js";
import { registerScrollTools } from "../../src/tools/scroll.js";
import { registerBrowserTools } from "../../src/tools/browser.js";
import { registerWindowDockTools } from "../../src/tools/window-dock.js";
import { registerWaitUntilTool } from "../../src/tools/wait-until.js";
import { registerDesktopStateTools } from "../../src/tools/desktop-state.js";
import { registerTerminalTools } from "../../src/tools/terminal.js";
import { registerClipboardTools } from "../../src/tools/clipboard.js";
import { registerNotificationTools } from "../../src/tools/notification.js";
import { registerExcelTools } from "../../src/tools/excel.js";
import { registerServerStatusTool } from "../../src/tools/server-status.js";
import { registerScreenshotQueryTool } from "../../src/tools/screenshot-query.js";
import { registerScreenshotGcTool } from "../../src/tools/screenshot-gc.js";
import { registerKeyLockerTools } from "../../src/tools/key-locker-tool.js";

type JsonProp = Record<string, unknown>;
type JsonObject = { properties?: Record<string, JsonProp>; oneOf?: JsonObject[]; required?: string[] };

const REGISTER = [
  registerScreenshotTools, registerMouseTools, registerKeyboardTools, registerWindowTools,
  registerUiElementTools, registerWorkspaceTools, registerMacroTools, registerScrollTools,
  registerBrowserTools, registerWindowDockTools, registerWaitUntilTool, registerDesktopStateTools,
  registerTerminalTools, registerClipboardTools, registerNotificationTools, registerExcelTools,
  registerServerStatusTool, registerScreenshotQueryTool, registerScreenshotGcTool, registerKeyLockerTools,
];

const live = new Map<string, { description?: string; inputSchema: JsonObject }>();

beforeAll(async () => {
  const server = new McpServer({ name: "stub-catalog-parity", version: "0" });
  for (const register of REGISTER) register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stub-catalog-parity", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  for (const t of (await client.listTools()).tools) {
    live.set(t.name, { description: t.description, inputSchema: t.inputSchema as JsonObject });
  }
});

// A stub entry with `oneOf` (a dispatcher's variants) is compared by the union of its variants'
// properties: the live schema lists them flat.
function stubProperties(schema: JsonObject): Record<string, JsonProp> {
  if (schema.properties) return schema.properties;
  const out: Record<string, JsonProp> = {};
  for (const v of schema.oneOf ?? []) for (const [k, p] of Object.entries(v.properties ?? {})) out[k] ??= p;
  return out;
}

const FIELDS = ["type", "enum", "const", "maxLength", "minLength", "maximum", "minimum", "maxItems", "minItems", "default", "description"] as const;

describe("the stub catalog, against the live tools/list", () => {
  it("lists every tool the stub lists (control: the live side really was read)", () => {
    expect(live.size).toBeGreaterThanOrEqual(STUB_TOOL_CATALOG.length);
    for (const t of STUB_TOOL_CATALOG) expect(live.has(t.name), t.name).toBe(true);
  });

  for (const entry of STUB_TOOL_CATALOG) {
    it(`${entry.name}: same description, same properties, and each property's ${FIELDS.join("/")}`, () => {
      const real = live.get(entry.name)!;
      expect(entry.description, `${entry.name} description`).toBe(real.description);
      const realProps = real.inputSchema.properties ?? {};
      const mine = stubProperties(entry.inputSchema as JsonObject);
      expect(Object.keys(mine).sort(), `${entry.name} properties`).toEqual(Object.keys(realProps).sort());
      for (const [key, rp] of Object.entries(realProps)) {
        for (const field of FIELDS) {
          if (rp[field] === undefined) continue;
          // `.int()` is rendered with the safe-integer range; that is zod's encoding of an
          // integer, not a bound the source wrote.
          if (field === "maximum" && rp[field] === Number.MAX_SAFE_INTEGER) continue;
          if (field === "minimum" && rp[field] === Number.MIN_SAFE_INTEGER) continue;
          expect(mine[key]?.[field], `${entry.name}.${key}.${field}`).toEqual(rp[field]);
        }
      }
    });
  }

  it("no property is described by the generator's placeholder", () => {
    expect(JSON.stringify(STUB_TOOL_CATALOG)).not.toContain("from the Windows server schema.");
  });
});
