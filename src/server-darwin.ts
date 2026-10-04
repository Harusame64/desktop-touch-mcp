/**
 * server-darwin.ts — the macOS server (Mac port M2, internal docs/mac-port-design.md).
 *
 * Registers only the tools that have a Mac road; a tool without one is not
 * listed (not stubbed as failing). Built on the `mac*` exports of the native
 * addon (src/macos/). When the darwin addon is not there (a package built
 * before the Mac port), the inspection stub runs instead, as before.
 *
 * M2-1: desktop_state. M2-2: desktop_discover / desktop_act. M2-3: screenshot.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { nativeMac } from "./engine/native-engine.js";
import { SERVER_VERSION } from "./version.js";
import { macDesktopStateDescription, macDesktopStateHandler } from "./tools/mac/desktop-state.js";
import {
  createMacFacade,
  macActDescription,
  macActHandler,
  macActSchema,
  macDiscoverDescription,
  macDiscoverHandler,
  macDiscoverSchema,
  type MacFacadeState,
} from "./tools/mac/desktop-discover-act.js";
import { macScreenshotDescription, macScreenshotHandler, macScreenshotSchema, sharpEncodePng } from "./tools/mac/screenshot.js";


// ─── CLI flags (before anything starts, so a one-shot --help exits) ──────────
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  // CLI usage on stdout — the process exits, so MCP JSON-RPC never starts.
  // eslint-disable-next-line no-console
  console.log(`desktop-touch-mcp v${SERVER_VERSION} (macOS preview)

Usage: desktop-touch-mcp [options]

Options:
  -h, --help      Show this help message

macOS: stdio transport only. Tools: desktop_state, desktop_discover, desktop_act, screenshot.
Grant Accessibility (and Screen Recording for titles and screenshots) to the app that runs this server.${
    nativeMac ? "" : "\n\nThe macOS native addon did not load here, so a normal start runs the inspection stub (no tools work)."
  }`);
  process.exit(0);
}
if (args.includes("--http")) {
  // Not silently stdio: a client configured for HTTP would wait for a port that never opens.
  console.error("[desktop-touch] --http is not available on macOS yet; run without it (stdio).");
  process.exit(2);
}

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
        "2. desktop_discover — find actionable entities (returns a lease each)",
        "3. desktop_act(lease, action) — press, or replace a text field's value; the foreground is not taken",
        "4. desktop_state / desktop_discover — confirm",
        "screenshot(windowTitle?) — one window as PNG, when pixels are needed (Screen Recording permission)",
        "Discover right before each act. entity_not_found from desktop_act means the window or the element at that place changed since the discover: nothing was done; discover again.",
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

  const state: MacFacadeState = { phase: "discover" };
  const facade = createMacFacade(mac, state);
  server.tool("desktop_discover", macDiscoverDescription, macDiscoverSchema, async (input) =>
    macDiscoverHandler(mac, facade, state, input)
  );
  server.tool("desktop_act", macActDescription, macActSchema, async (input) =>
    macActHandler(mac, facade, state, input)
  );

  server.tool("screenshot", macScreenshotDescription, macScreenshotSchema, async (input) =>
    macScreenshotHandler(
      {
        permissions: () => mac.macPermissions(),
        listWindows: (onScreenOnly) => mac.macListWindows(onScreenOnly),
        getFocus: () => mac.macGetFocus(),
        capture: (opts) => mac.macCaptureWindow(opts),
        encodePng: sharpEncodePng,
      },
      input
    )
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
