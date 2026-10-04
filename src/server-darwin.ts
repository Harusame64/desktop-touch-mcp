/**
 * server-darwin.ts — the macOS server (Mac port M2, internal docs/mac-port-design.md).
 *
 * Registers only the tools that have a Mac road; a tool without one is not
 * listed (not stubbed as failing). Built on the `mac*` exports of the native
 * addon (src/macos/). When the darwin addon is not there (a package built
 * before the Mac port), the inspection stub runs instead, as before.
 *
 * M2-1: desktop_state. desktop_discover / desktop_act and screenshot follow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { nativeMac } from "./engine/native-engine.js";
import { SERVER_VERSION } from "./version.js";
import { macDesktopStateDescription, macDesktopStateHandler } from "./tools/mac/desktop-state.js";

if (!nativeMac) {
  console.error("[desktop-touch] macOS: the darwin native addon is not loaded; running the inspection stub.");
  await import("./server-linux-stub.js");
} else {
  const mac = nativeMac;
  const server = new McpServer(
    { name: "desktop-touch", version: SERVER_VERSION },
    {
      instructions: [
        "# desktop-touch-mcp on macOS (preview)",
        "",
        "Only the tools listed are available on macOS; the rest of the Windows catalog is not.",
        "It needs Accessibility permission (and Screen Recording for window titles and screenshots) for the app that runs this server.",
        "1. desktop_state — orient: frontmost app, focused window/element, attention",
      ].join("\n"),
    }
  );

  server.tool("desktop_state", macDesktopStateDescription, {}, async () =>
    macDesktopStateHandler({
      permissions: () => mac.macPermissions(),
      listWindows: (onScreenOnly) => mac.macListWindows(onScreenOnly),
      getFocus: () => mac.macGetFocus(),
      displayAsleep: () => mac.macDisplayAsleep(),
    })
  );

  await server.connect(new StdioServerTransport());
  let perms = "unknown";
  try {
    const p = mac.macPermissions();
    perms = `accessibility=${p.accessibility} screenCapture=${p.screenCapture}`;
  } catch {
    // Only feeds this log line; desktop_state asks again and reports it.
  }
  console.error(`[desktop-touch] macOS server running (stdio). ${perms}`);
}
