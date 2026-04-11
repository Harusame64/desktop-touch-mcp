import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo } from "../engine/nutjs.js";
import type { ToolResult } from "./_types.js";

function toButton(b: string): Button {
  switch (b) {
    case "right": return Button.RIGHT;
    case "middle": return Button.MIDDLE;
    default: return Button.LEFT;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const mouseMoveSchema = {
  x: z.coerce.number().describe("X coordinate in virtual screen pixels"),
  y: z.coerce.number().describe("Y coordinate in virtual screen pixels"),
};

export const mouseClickSchema = {
  x: z.coerce.number().describe("X coordinate"),
  y: z.coerce.number().describe("Y coordinate"),
  button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button to click"),
  doubleClick: z.boolean().default(false).describe("Whether to double-click"),
};

export const mouseDragSchema = {
  startX: z.coerce.number(),
  startY: z.coerce.number(),
  endX: z.coerce.number(),
  endY: z.coerce.number(),
};

export const scrollSchema = {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.coerce.number().int().positive().default(3).describe("Number of scroll steps (default 3)"),
  x: z.coerce.number().optional().describe("X coordinate to scroll at (moves cursor there first)"),
  y: z.coerce.number().optional().describe("Y coordinate to scroll at"),
};

export const getCursorPositionSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const mouseMoveHandler = async ({ x, y }: { x: number; y: number }): Promise<ToolResult> => {
  try {
    await mouse.move(straightTo(new Point(x, y)));
    return { content: [{ type: "text" as const, text: `Mouse moved to (${x}, ${y})` }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_move failed: ${String(err)}` }] };
  }
};

export const mouseClickHandler = async ({
  x, y, button, doubleClick,
}: { x: number; y: number; button: "left" | "right" | "middle"; doubleClick: boolean }): Promise<ToolResult> => {
  try {
    await mouse.move(straightTo(new Point(x, y)));
    const btn = toButton(button);
    if (doubleClick) {
      await mouse.doubleClick(btn);
    } else {
      await mouse.click(btn);
    }
    const action = doubleClick ? "Double-clicked" : "Clicked";
    return { content: [{ type: "text" as const, text: `${action} ${button} at (${x}, ${y})` }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_click failed: ${String(err)}` }] };
  }
};

export const mouseDragHandler = async ({
  startX, startY, endX, endY,
}: { startX: number; startY: number; endX: number; endY: number }): Promise<ToolResult> => {
  try {
    await mouse.move(straightTo(new Point(startX, startY)));
    await mouse.drag(straightTo(new Point(endX, endY)));
    return {
      content: [{ type: "text" as const, text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})` }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_drag failed: ${String(err)}` }] };
  }
};

export const scrollHandler = async ({
  direction, amount, x, y,
}: { direction: "up" | "down" | "left" | "right"; amount: number; x?: number; y?: number }): Promise<ToolResult> => {
  try {
    if (x !== undefined && y !== undefined) {
      await mouse.move(straightTo(new Point(x, y)));
    }
    const SCROLL_MULTIPLIER = 3;
    switch (direction) {
      case "down":  await mouse.scrollDown(amount * SCROLL_MULTIPLIER); break;
      case "up":    await mouse.scrollUp(amount * SCROLL_MULTIPLIER); break;
      case "right":
        for (let i = 0; i < amount; i++) await mouse.scrollRight(SCROLL_MULTIPLIER);
        break;
      case "left":
        for (let i = 0; i < amount; i++) await mouse.scrollLeft(SCROLL_MULTIPLIER);
        break;
    }
    return { content: [{ type: "text" as const, text: `Scrolled ${direction} by ${amount} steps` }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `scroll failed: ${String(err)}` }] };
  }
};

export const getCursorPositionHandler = async (): Promise<ToolResult> => {
  try {
    const pos = await mouse.getPosition();
    return { content: [{ type: "text" as const, text: JSON.stringify({ x: pos.x, y: pos.y }) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `get_cursor_position failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerMouseTools(server: McpServer): void {
  server.tool("mouse_move", "Move the mouse cursor to the specified screen coordinates.", mouseMoveSchema, mouseMoveHandler);
  server.tool("mouse_click", "Click the mouse at the specified coordinates.", mouseClickSchema, mouseClickHandler);
  server.tool("mouse_drag", "Click and drag from one position to another (left button hold).", mouseDragSchema, mouseDragHandler);
  server.tool("scroll", "Scroll at the current position or at specified coordinates.", scrollSchema, scrollHandler);
  server.tool("get_cursor_position", "Get the current mouse cursor position in virtual screen coordinates.", getCursorPositionSchema, getCursorPositionHandler);
}
