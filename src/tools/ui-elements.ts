import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUiElements, clickElement, setElementValue, getElementBounds, getElementChildren } from "../engine/uia-bridge.js";
import { captureScreen } from "../engine/image.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getUiElementsSchema = {
  windowTitle: z.string().max(200).describe("Partial window title to find the target window"),
  maxDepth: z.coerce.number().int().min(1).max(8).default(4).describe("Maximum depth of the element tree to traverse (default 4)"),
  maxElements: z.coerce.number().int().min(1).max(200).default(80).describe("Maximum number of elements to return (default 80)"),
};

export const clickElementSchema = {
  windowTitle: z.string().max(200).describe("Partial window title of the target window"),
  name: z.string().max(200).optional().describe("Element name/label (partial match, case-insensitive)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
  controlType: z.string().max(100).optional().describe("Control type filter, e.g. 'Button', 'MenuItem'"),
};

export const setElementValueSchema = {
  windowTitle: z.string().max(200).describe("Partial window title"),
  value: z.string().max(10000).describe("The value to set"),
  name: z.string().max(200).optional().describe("Element name/label (partial match)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
};

export const scopeElementSchema = {
  windowTitle: z.string().max(200).describe("Partial window title of the target window"),
  name: z.string().max(200).optional().describe("Element name/label (partial match, case-insensitive)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
  controlType: z.string().max(100).optional().describe("Control type filter, e.g. 'Edit', 'Button', 'List'"),
  maxDepth: z.coerce.number().int().min(1).max(6).default(2).describe("Child element tree depth (default 2)"),
  maxElements: z.coerce.number().int().min(1).max(100).default(30).describe("Max child elements (default 30)"),
  padding: z.coerce.number().int().min(0).max(100).default(10).describe("Padding in pixels around the element in the screenshot (default 10)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const getUiElementsHandler = async ({
  windowTitle, maxDepth, maxElements,
}: { windowTitle: string; maxDepth: number; maxElements: number }): Promise<ToolResult> => {
  try {
    const result = await getUiElements(windowTitle, maxDepth, maxElements);
    return ok(result, true);
  } catch (err) {
    return failWith(err, "get_ui_elements", { windowTitle });
  }
};

export const clickElementHandler = async ({
  windowTitle, name, automationId, controlType,
}: { windowTitle: string; name?: string; automationId?: string; controlType?: string }): Promise<ToolResult> => {
  try {
    if (!name && !automationId) {
      return failArgs("Provide at least one of: name, automationId", "click_element", { windowTitle });
    }
    const result = await clickElement(windowTitle, name, automationId, controlType);
    return ok(result);
  } catch (err) {
    return failWith(err, "click_element", { windowTitle, name, automationId });
  }
};

export const setElementValueHandler = async ({
  windowTitle, value, name, automationId,
}: { windowTitle: string; value: string; name?: string; automationId?: string }): Promise<ToolResult> => {
  try {
    if (!name && !automationId) {
      return failArgs("Provide at least one of: name, automationId", "set_element_value", { windowTitle });
    }
    const result = await setElementValue(windowTitle, value, name, automationId);
    return ok(result);
  } catch (err) {
    return failWith(err, "set_element_value", { windowTitle, name, automationId });
  }
};

export const scopeElementHandler = async ({
  windowTitle, name, automationId, controlType, maxDepth, maxElements, padding,
}: {
  windowTitle: string;
  name?: string;
  automationId?: string;
  controlType?: string;
  maxDepth: number;
  maxElements: number;
  padding: number;
}): Promise<ToolResult> => {
  try {
    if (!name && !automationId && !controlType) {
      return failArgs("Provide at least one of: name, automationId, controlType", "scope_element", { windowTitle });
    }

    const bounds = await getElementBounds(windowTitle, name, automationId, controlType);
    if (!bounds) {
      return failWith("Element not found", "scope_element", { windowTitle, name, automationId, controlType });
    }

    const content: ToolResult["content"] = [];

    if (bounds.boundingRect) {
      const r = bounds.boundingRect;
      const region = {
        x: Math.max(0, r.x - padding),
        y: Math.max(0, r.y - padding),
        width: r.width + padding * 2,
        height: r.height + padding * 2,
      };
      try {
        const captured = await captureScreen(region, 1280);
        content.push({ type: "image" as const, data: captured.base64, mimeType: captured.mimeType });
        content.push({
          type: "text" as const,
          text: `[scope: ${bounds.name || controlType || automationId} @ ${r.x},${r.y} ${r.width}x${r.height}]`,
        });
      } catch {
        // Screenshot failed — continue with text only
      }
    }

    let children = null;
    try {
      children = await getElementChildren(windowTitle, name, automationId, controlType, maxDepth, maxElements, 5000);
    } catch {
      // UIA may fail; return element info without children
    }

    content.push({ type: "text" as const, text: JSON.stringify({ element: bounds, children }, null, 2) });
    return { content };
  } catch (err) {
    return failWith(err, "scope_element", { windowTitle, name, automationId });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerUiElementTools(server: McpServer): void {
  server.tool(
    "get_ui_elements",
    [
      "Inspect the UI element tree of a window using Windows UI Automation.",
      "Returns element names, control types, automation IDs, bounding rectangles (screen coords), and interaction patterns.",
      "",
      "TIP: For interactive automation, prefer screenshot(detail='text') which returns the same data",
      "pre-filtered to actionable elements with pre-computed clickAt coordinates.",
      "Use get_ui_elements when you need the full raw tree (e.g., to find automationIds for click_element).",
    ].join("\n"),
    getUiElementsSchema,
    getUiElementsHandler
  );

  server.tool(
    "click_element",
    [
      "Click (invoke) a UI element by name or automation ID — no screen coordinates needed.",
      "Uses Windows UI Automation InvokePattern.",
      "Ideal for buttons, menu items, and links.",
    ].join(" "),
    clickElementSchema,
    clickElementHandler
  );

  server.tool(
    "set_element_value",
    [
      "Directly set the value of a text field or combo box using Windows UI Automation ValuePattern.",
      "More reliable than keyboard_type for programmatic input into form fields.",
    ].join(" "),
    setElementValueSchema,
    setElementValueHandler
  );

  server.tool(
    "scope_element",
    [
      "Zoom into a specific UI element: returns a high-resolution screenshot of just that element's region",
      "plus its child element tree.",
      "",
      "Works with any app that exposes Windows UI Automation (native apps, Chrome/Edge, VS Code, etc.).",
      "Use get_ui_elements first to discover element names / automationIds.",
      "",
      "At least one of: name, automationId, controlType must be provided.",
    ].join("\n"),
    scopeElementSchema,
    scopeElementHandler
  );
}
