/**
 * server-linux-stub.ts — catalog-complete MCP server for non-Windows hosts.
 *
 * desktop-touch-mcp is Windows-native. The real server imports Win32, UIA,
 * CDP, nut-js, and the desktop-touch-engine native addon — none of which run
 * on Linux/macOS. Directory
 * hosts such as Glama still need to inspect the real tool surface, so this
 * stub serves the generated catalog for tools/list and returns a structured
 * UnsupportedPlatform error for every tools/call.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { STUB_TOOL_CATALOG, STUB_TOOL_COUNT } from "./stub-tool-catalog.js";
import { SERVER_VERSION } from "./version.js";

const toolsByName = new Map(STUB_TOOL_CATALOG.map((tool) => [tool.name, tool]));

const server = new Server(
  { name: "desktop-touch", version: SERVER_VERSION },
  {
    capabilities: { tools: { listChanged: false } },
    instructions: [
      "desktop-touch-mcp is a Windows-native local stdio MCP server.",
      `This ${process.platform} process is an inspection stub: tools/list returns the real Windows tool catalog,`,
      "but every tools/call returns UnsupportedPlatform. Run on Windows 10/11 with Node.js >= 20 to operate the desktop.",
    ].join(" "),
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: STUB_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  if (!toolsByName.has(toolName)) {
    throw new McpError(ErrorCode.InvalidParams, `Tool ${toolName} not found`);
  }

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          code: "UnsupportedPlatform",
          tool: toolName,
          error: `${toolName}: desktop-touch-mcp requires Windows. Current platform: ${process.platform}.`,
          suggest: [
            "Run the MCP server on a Windows 10/11 host with Node.js >= 20.",
            "This non-Windows stub exists only so MCP directories can inspect the real tool catalog.",
            "See https://github.com/Harusame64/desktop-touch-mcp for installation instructions.",
          ],
        }),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[desktop-touch] non-Windows inspection stub running (stdio). Platform: ${process.platform}. ` +
  `${STUB_TOOL_COUNT} tools advertised, all calls return UnsupportedPlatform.`
);
