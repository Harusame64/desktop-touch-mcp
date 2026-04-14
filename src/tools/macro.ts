import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolHandler, ToolResult } from "./_types.js";
import { checkFailsafe } from "../utils/failsafe.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";

// Screenshot tools
import { screenshotHandler, screenshotSchema, screenshotBgHandler, screenshotBgSchema, getScreenInfoHandler, getScreenInfoSchema } from "./screenshot.js";
// Mouse tools
import { mouseMoveHandler, mouseMoveSchema, mouseClickHandler, mouseClickSchema, mouseDragHandler, mouseDragSchema, scrollHandler, scrollSchema, getCursorPositionHandler, getCursorPositionSchema } from "./mouse.js";
// Keyboard tools
import { keyboardTypeHandler, keyboardTypeSchema, keyboardPressHandler, keyboardPressSchema } from "./keyboard.js";
// Window tools
import { getWindowsHandler, getWindowsSchema, getActiveWindowHandler, getActiveWindowSchema, focusWindowHandler, focusWindowSchema } from "./window.js";
// UI Element tools
import { getUiElementsHandler, getUiElementsSchema, clickElementHandler, clickElementSchema, setElementValueHandler, setElementValueSchema, scopeElementHandler, scopeElementSchema } from "./ui-elements.js";
// Workspace tools
import { workspaceSnapshotHandler, workspaceSnapshotSchema, workspaceLaunchHandler, workspaceLaunchSchema } from "./workspace.js";
// Pin tools
import { pinWindowHandler, pinWindowSchema, unpinWindowHandler, unpinWindowSchema } from "./pin.js";
// Scroll capture
import { scrollCaptureHandler, scrollCaptureSchema } from "./scroll-capture.js";
// Wait until
import { waitUntilHandler, waitUntilSchema } from "./wait-until.js";
// Context
import { getContextHandler, getContextSchema, getHistoryHandler, getHistorySchema, getDocumentStateHandler, getDocumentStateSchema } from "./context.js";
// Terminal
import { terminalReadHandler, terminalReadSchema, terminalSendHandler, terminalSendSchema } from "./terminal.js";
// Browser search
import { browserSearchHandler, browserSearchSchema } from "./browser.js";
// Events
import { eventsSubscribeHandler, eventsSubscribeSchema, eventsPollHandler, eventsPollSchema, eventsUnsubscribeHandler, eventsUnsubscribeSchema } from "./events.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────────────────────────────────────

interface ToolEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: ToolHandler<any>;
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  screenshot:             { schema: z.object(screenshotSchema),          handler: screenshotHandler },
  screenshot_background:  { schema: z.object(screenshotBgSchema),         handler: screenshotBgHandler },
  get_screen_info:        { schema: z.object(getScreenInfoSchema),        handler: getScreenInfoHandler },
  mouse_move:             { schema: z.object(mouseMoveSchema),            handler: mouseMoveHandler },
  mouse_click:            { schema: z.object(mouseClickSchema),           handler: mouseClickHandler },
  mouse_drag:             { schema: z.object(mouseDragSchema),            handler: mouseDragHandler },
  scroll:                 { schema: z.object(scrollSchema),               handler: scrollHandler },
  get_cursor_position:    { schema: z.object(getCursorPositionSchema),    handler: getCursorPositionHandler },
  keyboard_type:          { schema: z.object(keyboardTypeSchema),         handler: keyboardTypeHandler },
  keyboard_press:         { schema: z.object(keyboardPressSchema),        handler: keyboardPressHandler },
  get_windows:            { schema: z.object(getWindowsSchema),           handler: getWindowsHandler },
  get_active_window:      { schema: z.object(getActiveWindowSchema),      handler: getActiveWindowHandler },
  focus_window:           { schema: z.object(focusWindowSchema),          handler: focusWindowHandler },
  get_ui_elements:        { schema: z.object(getUiElementsSchema),        handler: getUiElementsHandler },
  click_element:          { schema: z.object(clickElementSchema),         handler: clickElementHandler },
  set_element_value:      { schema: z.object(setElementValueSchema),      handler: setElementValueHandler },
  scope_element:          { schema: z.object(scopeElementSchema),         handler: scopeElementHandler },
  workspace_snapshot:     { schema: z.object(workspaceSnapshotSchema),    handler: workspaceSnapshotHandler },
  workspace_launch:       { schema: z.object(workspaceLaunchSchema),      handler: workspaceLaunchHandler },
  pin_window:             { schema: z.object(pinWindowSchema),            handler: pinWindowHandler },
  unpin_window:           { schema: z.object(unpinWindowSchema),          handler: unpinWindowHandler },
  scroll_capture:         { schema: z.object(scrollCaptureSchema),        handler: scrollCaptureHandler },
  wait_until:             { schema: z.object(waitUntilSchema),             handler: waitUntilHandler },
  get_context:            { schema: z.object(getContextSchema),            handler: getContextHandler },
  get_history:            { schema: z.object(getHistorySchema),            handler: getHistoryHandler },
  get_document_state:     { schema: z.object(getDocumentStateSchema),      handler: getDocumentStateHandler },
  terminal_read:          { schema: z.object(terminalReadSchema),          handler: terminalReadHandler },
  terminal_send:          { schema: z.object(terminalSendSchema),          handler: terminalSendHandler },
  browser_search:         { schema: z.object(browserSearchSchema),         handler: browserSearchHandler },
  events_subscribe:       { schema: z.object(eventsSubscribeSchema),       handler: eventsSubscribeHandler },
  events_poll:            { schema: z.object(eventsPollSchema),            handler: eventsPollHandler },
  events_unsubscribe:     { schema: z.object(eventsUnsubscribeSchema),     handler: eventsUnsubscribeHandler },
  // run_macro is intentionally excluded → prevents recursion
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema & Handler
// ─────────────────────────────────────────────────────────────────────────────

export const runMacroSchema = {
  steps: z
    .array(
      z.object({
        tool: z.string().describe(
          `Tool name to call. One of: ${Object.keys(TOOL_REGISTRY).join(", ")}, or the special pseudo-command "sleep".`
        ),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Parameters for the tool (same as calling it directly). Omit for tools with no params."),
      })
    )
    .min(1)
    .max(50)
    .describe("Ordered list of tool calls to execute sequentially (max 50 steps)."),
  stop_on_error: z
    .boolean()
    .default(true)
    .describe("Stop execution on the first error (default true). Set false to collect all results."),
};

export const runMacroHandler = async ({
  steps,
  stop_on_error,
}: {
  steps: Array<{ tool: string; params: Record<string, unknown> }>;
  stop_on_error: boolean;
}): Promise<ToolResult> => {
  type StepResult = {
    step: number;
    tool: string;
    ok: boolean;
    text?: string[];
    error?: string;
    _images?: Array<{ data: string; mimeType: string }>;
  };

  const results: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const { tool, params } = steps[i]!;

    // Prevent recursion
    if (tool === "run_macro") {
      results.push({ step: i, tool, ok: false, error: "run_macro cannot be called inside run_macro" });
      if (stop_on_error) break;
      continue;
    }

    // Handle sleep pseudo-command
    if (tool === "sleep") {
      const ms = Math.min(Math.max(Number(params["ms"]) || 0, 0), 10000);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      results.push({ step: i, tool, ok: true, text: [`slept ${ms}ms`] });
      continue;
    }

    const entry = TOOL_REGISTRY[tool];
    if (!entry) {
      results.push({ step: i, tool, ok: false, error: `Unknown tool: "${tool}"` });
      if (stop_on_error) break;
      continue;
    }

    try {
      // Failsafe pre-check before each step
      await checkFailsafe();

      // Block dangerous key combos inside macros
      if (tool === "keyboard_press" && typeof params["keys"] === "string") {
        assertKeyComboSafe(params["keys"]);
      }

      const validated = entry.schema.parse(params);
      const result = await entry.handler(validated);

      const textLines: string[] = [];
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const block of result.content) {
        if (block.type === "text") textLines.push(block.text);
        else if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
      }

      results.push({
        step: i,
        tool,
        ok: true,
        text: textLines,
        ...(images.length > 0 ? { _images: images } : {}),
      });
    } catch (err) {
      results.push({ step: i, tool, ok: false, error: String(err) });
      if (stop_on_error) break;
    }
  }

  // Build final content
  const content: ToolResult["content"] = [];

  // Summary JSON (no base64 blobs in the text block)
  const summary = {
    steps_total: steps.length,
    steps_completed: results.length,
    results: results.map(({ _images: _img, ...r }) => r),
  };
  content.push({ type: "text", text: JSON.stringify(summary, null, 2) });

  // Append image blocks from screenshot steps
  for (const r of results) {
    if (r._images) {
      for (const img of r._images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        content.push({ type: "text", text: `[step ${r.step}: ${r.tool}]` });
      }
    }
  }

  return { content };
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerMacroTools(server: McpServer): void {
  server.tool(
    "run_macro",
    [
      "Execute multiple tools in sequence with a single MCP call — eliminates round-trip latency for multi-step workflows.",
      "",
      `Available tools: ${Object.keys(TOOL_REGISTRY).join(", ")}.`,
      'Special pseudo-command: "sleep" with params { "ms": N } — wait N milliseconds (max 10000).',
      "",
      "Steps execute sequentially. stop_on_error (default true) halts on first failure.",
      "Maximum 50 steps per call.",
      "",
      "Example: focus window → sleep 300ms → type text → screenshot.",
    ].join("\n"),
    runMacroSchema,
    runMacroHandler
  );
}
