import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDesc } from "./_types.js";
import type { ToolHandler, ToolResult } from "./_types.js";
import { checkFailsafe } from "../utils/failsafe.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: TOOL_REGISTRY mirrors the v1.0.0 public surface — privatized tools
// (events_*, perception_*, mouse_move, get_history, get_*) are intentionally
// absent. Family dispatchers (keyboard / clipboard / window_dock / scroll /
// terminal / browser_eval) replace their pre-Phase-2 sub-tool entries.
// ─────────────────────────────────────────────────────────────────────────────

// Screenshot
import { screenshotHandler, screenshotSchema } from "./screenshot.js";
// Mouse
import { mouseClickHandler, mouseClickSchema, mouseDragHandler, mouseDragSchema } from "./mouse.js";
// Keyboard dispatcher (Phase 2)
import { keyboardHandler, keyboardSchema } from "./keyboard.js";
// Clipboard dispatcher (Phase 2)
import { clipboardHandler, clipboardSchema } from "./clipboard.js";
// Window
import { focusWindowHandler, focusWindowSchema } from "./window.js";
// Window dock dispatcher (Phase 2)
import { windowDockHandler, windowDockSchema } from "./window-dock.js";
// UI elements (only click_element remains public after Phase 4)
import { clickElementHandler, clickElementSchema } from "./ui-elements.js";
// Workspace
import { workspaceSnapshotHandler, workspaceSnapshotSchema, workspaceLaunchHandler, workspaceLaunchSchema } from "./workspace.js";
// Scroll dispatcher (Phase 2)
import { scrollDispatchHandler, scrollSchema } from "./scroll.js";
// Wait until
import { waitUntilHandler, waitUntilSchema } from "./wait-until.js";
// Desktop state
import { desktopStateHandler, desktopStateSchema } from "./desktop-state.js";
// Terminal dispatcher (Phase 2)
import { terminalDispatchHandler, terminalSchema } from "./terminal.js";
// Browser tools (Phase 3)
import {
  browserOpenHandler, browserOpenSchema,
  browserEvalHandler, browserEvalSchema,
  browserSearchHandler, browserSearchSchema,
  browserGetInteractiveHandler, browserGetInteractiveSchema,
  browserFindElementHandler, browserFindElementSchema,
  browserClickElementHandler, browserClickElementSchema,
  browserNavigateHandler, browserNavigateSchema,
  browserFillInputHandler, browserFillInputSchema,
  browserGetFormHandler, browserGetFormSchema,
} from "./browser.js";
// Notification (server_status not callable from macros — diagnostic)
import { notificationShowHandler, notificationShowSchema } from "./notification.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────────────────────────────────────

interface ToolEntry {
  // Phase 4: widened from z.ZodObject to z.ZodTypeAny so dispatchers backed by
  // z.discriminatedUnion (keyboard / clipboard / window_dock / scroll /
  // terminal / browser_eval) can be parsed via .parse() the same way.
  schema: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: ToolHandler<any>;
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  // Observation
  desktop_state:        { schema: z.object(desktopStateSchema),        handler: desktopStateHandler },
  screenshot:           { schema: z.object(screenshotSchema),          handler: screenshotHandler },
  // Action — native
  mouse_click:          { schema: z.object(mouseClickSchema),          handler: mouseClickHandler },
  mouse_drag:           { schema: z.object(mouseDragSchema),           handler: mouseDragHandler },
  click_element:        { schema: z.object(clickElementSchema),        handler: clickElementHandler },
  focus_window:         { schema: z.object(focusWindowSchema),         handler: focusWindowHandler },
  // Action — text/clipboard dispatchers (Phase 2)
  keyboard:             { schema: keyboardSchema,                      handler: keyboardHandler },
  clipboard:            { schema: clipboardSchema,                     handler: clipboardHandler },
  // Action — window/scroll/terminal dispatchers (Phase 2)
  window_dock:          { schema: windowDockSchema,                    handler: windowDockHandler },
  scroll:               { schema: scrollSchema,                        handler: scrollDispatchHandler },
  terminal:             { schema: terminalSchema,                      handler: terminalDispatchHandler },
  // Action — browser (Phase 3)
  browser_open:         { schema: z.object(browserOpenSchema),         handler: browserOpenHandler },
  browser_eval:         { schema: browserEvalSchema,                   handler: browserEvalHandler },
  browser_search:       { schema: z.object(browserSearchSchema),       handler: browserSearchHandler },
  browser_overview:     { schema: z.object(browserGetInteractiveSchema), handler: browserGetInteractiveHandler },
  browser_locate:       { schema: z.object(browserFindElementSchema),  handler: browserFindElementHandler },
  browser_click:        { schema: z.object(browserClickElementSchema), handler: browserClickElementHandler },
  browser_navigate:     { schema: z.object(browserNavigateSchema),     handler: browserNavigateHandler },
  browser_fill:         { schema: z.object(browserFillInputSchema),    handler: browserFillInputHandler },
  browser_form:         { schema: z.object(browserGetFormSchema),      handler: browserGetFormHandler },
  // Workspace / wait / notification
  workspace_snapshot:   { schema: z.object(workspaceSnapshotSchema),   handler: workspaceSnapshotHandler },
  workspace_launch:     { schema: z.object(workspaceLaunchSchema),     handler: workspaceLaunchHandler },
  wait_until:           { schema: z.object(waitUntilSchema),           handler: waitUntilHandler },
  notification_show:    { schema: z.object(notificationShowSchema),    handler: notificationShowHandler },
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

      // Block dangerous key combos inside macros (Phase 4: keyboard dispatcher
      // with action='press'; pre-Phase-2 keyboard_press is no longer registered).
      if (
        tool === "keyboard" &&
        params["action"] === "press" &&
        typeof params["keys"] === "string"
      ) {
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
    buildDesc({
      purpose: "Execute multiple tools sequentially in one MCP call — eliminates round-trip latency for predictable multi-step workflows.",
      details: "steps[] is an array of {tool, params} objects. Accepts all desktop-touch tools plus a special sleep pseudo-step: {tool:\"sleep\", params:{ms:N}} (max 10000ms per step). stop_on_error=true (default) halts on first failure. Max 50 steps. The LLM cannot inspect intermediate results during execution — all steps run to completion (or first error) before any output is returned.",
      prefer: "Use for predictable fixed sequences (focus → sleep → type → screenshot). Do not use for conditional logic — return to the LLM between branches so it can inspect intermediate state.",
      caveats: "If any step may fail conditionally (e.g. a dialog that may or may not appear), split the macro at that point. Each screenshot step within a macro incurs the same token cost as a standalone call.",
      examples: [
        "[{tool:'focus_window',params:{windowTitle:'Notepad'}},{tool:'sleep',params:{ms:300}},{tool:'keyboard',params:{action:'type',text:'Hello'}},{tool:'screenshot',params:{detail:'text',windowTitle:'Notepad'}}]",
        "[{tool:'browser_navigate',params:{url:'https://example.com'}},{tool:'wait_until',params:{condition:'element_matches',target:{by:'text',pattern:'Example Domain'}}}]",
      ],
    }),
    runMacroSchema,
    runMacroHandler
  );
}
