import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import {
  updateWindowCache,
  findContainingWindow,
  getCachedWindowByTitle,
  computeWindowDelta,
} from "../engine/window-cache.js";
import { getElementBounds } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";

/**
 * Move cursor to (x, y) at the given speed.
 * speed=0 → setPosition teleport (instant, no animation).
 * speed>0 → straightTo animation at that px/sec.
 * speed omitted → DEFAULT_MOUSE_SPEED.
 */
async function moveTo(x: number, y: number, speed?: number): Promise<void> {
  const s = speed ?? DEFAULT_MOUSE_SPEED;
  if (s === 0) {
    await mouse.setPosition(new Point(x, y));
  } else {
    const prev = mouse.config.mouseSpeed;
    mouse.config.mouseSpeed = s;
    try {
      await mouse.move(straightTo(new Point(x, y)));
    } finally {
      mouse.config.mouseSpeed = prev;
    }
  }
}

function toButton(b: string): Button {
  switch (b) {
    case "right": return Button.RIGHT;
    case "middle": return Button.MIDDLE;
    default: return Button.LEFT;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Homing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Threshold: if delta exceeds this many pixels, treat as "significant movement". */
const LARGE_DELTA_PX = 200;

interface HomingResult {
  x: number;
  y: number;
  notes: string[];
}

/**
 * Apply homing correction to a target coordinate.
 *
 * Tier 1: Look up the window containing (x,y) in the cache and compute how far
 *         it has moved since the last screenshot. Apply the (dx,dy) offset.
 * Tier 2: If windowTitle is provided, ensure that window is focused first.
 * Tier 3: If elementName/elementId are provided AND the window resized or moved
 *         significantly, re-query via UIA to get fresh coordinates.
 */
async function applyHoming(
  x: number,
  y: number,
  windowTitle?: string,
  elementName?: string,
  elementId?: string,
): Promise<HomingResult> {
  const notes: string[] = [];

  // ── Tier 2: focus the target window if it went behind another ─────────────
  if (windowTitle) {
    const windows = enumWindowsInZOrder();
    updateWindowCache(windows); // keep cache fresh before delta check below
    const active = windows.find((w) => w.isActive);
    if (!active || !active.title.toLowerCase().includes(windowTitle.toLowerCase())) {
      const target = windows.find((w) =>
        w.title.toLowerCase().includes(windowTitle.toLowerCase())
      );
      if (target) {
        restoreAndFocusWindow(target.hwnd);
        await new Promise<void>((r) => setTimeout(r, 100));
        // Refresh cache again after restore: window may have moved/unminimized
        updateWindowCache(enumWindowsInZOrder());
        notes.push(`brought "${target.title}" to front`);
      }
    }
  }

  // ── Tier 1: window-delta correction ──────────────────────────────────────
  const cached = windowTitle
    ? getCachedWindowByTitle(windowTitle)
    : findContainingWindow(x, y);

  if (!cached) {
    // No cache entry — nothing to correct
    return { x, y, notes };
  }

  const delta = computeWindowDelta(cached.hwnd);
  if (!delta) {
    // Window no longer exists — leave coords as-is
    return { x, y, notes };
  }

  // ── Tier 3: UIA re-query (window resized or moved dramatically) ──────────
  if (
    (elementName || elementId) &&
    windowTitle &&
    (delta.sizeChanged || Math.abs(delta.dx) > LARGE_DELTA_PX || Math.abs(delta.dy) > LARGE_DELTA_PX)
  ) {
    const bounds = await getElementBounds(windowTitle, elementName, elementId);
    if (bounds?.boundingRect) {
      const nx = Math.round(bounds.boundingRect.x + bounds.boundingRect.width / 2);
      const ny = Math.round(bounds.boundingRect.y + bounds.boundingRect.height / 2);
      notes.push(`re-queried "${elementName ?? elementId}" via UIA, window ${delta.sizeChanged ? "resized" : "moved far"}`);
      return { x: nx, y: ny, notes };
    }
  }

  // Simple offset correction
  if (delta.dx !== 0 || delta.dy !== 0) {
    notes.push(`window moved ${delta.dx > 0 ? "+" : ""}${delta.dx},${delta.dy > 0 ? "+" : ""}${delta.dy}`);
  }
  return { x: x + delta.dx, y: y + delta.dy, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const speedParam = z.coerce.number().int().min(0).optional().describe(
  "Cursor movement speed in px/sec. 0 = instant (teleport, no animation). " +
  "Omit to use the configured default (DESKTOP_TOUCH_MOUSE_SPEED env var, default 1500)."
);

const homingParam = z.boolean().default(true).describe(
  "Enable homing correction (default true). " +
  "When enabled, the MCP server corrects stale coordinates if the target window moved " +
  "since the last screenshot. Set false to disable all correction (like traction control OFF)."
);

const windowTitleParam = z.string().optional().describe(
  "Hint: partial title of the window being clicked. " +
  "Enables window-delta correction and auto-focus if the window went behind another. " +
  "Example: \"メモ帳\", \"Google Chrome\""
);

const elementNameParam = z.string().optional().describe(
  "Hint: name/label of the UI element (from actionable[].name in screenshot(detail='text')). " +
  "Requires windowTitle. Triggers UIA re-query to get fresh coordinates when the window resized or moved far."
);

const elementIdParam = z.string().optional().describe(
  "Hint: automationId of the UI element (from actionable[].id). " +
  "Requires windowTitle. Used with elementName for more precise UIA re-query."
);

export const mouseMoveSchema = {
  x: z.coerce.number().describe("X coordinate in virtual screen pixels"),
  y: z.coerce.number().describe("Y coordinate in virtual screen pixels"),
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
};

export const mouseClickSchema = {
  x: z.coerce.number().describe("X coordinate"),
  y: z.coerce.number().describe("Y coordinate"),
  button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button to click"),
  doubleClick: z.boolean().default(false).describe("Whether to double-click"),
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
  elementName: elementNameParam,
  elementId: elementIdParam,
};

export const mouseDragSchema = {
  startX: z.coerce.number(),
  startY: z.coerce.number(),
  endX: z.coerce.number(),
  endY: z.coerce.number(),
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
};

export const scrollSchema = {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.coerce.number().int().positive().default(3).describe("Number of scroll steps (default 3)"),
  x: z.coerce.number().optional().describe("X coordinate to scroll at (moves cursor there first)"),
  y: z.coerce.number().optional().describe("Y coordinate to scroll at"),
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
};

export const getCursorPositionSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const mouseMoveHandler = async ({
  x, y, speed, homing, windowTitle,
}: {
  x: number; y: number; speed?: number; homing: boolean; windowTitle?: string;
}): Promise<ToolResult> => {
  try {
    let tx = x, ty = y;
    const notes: string[] = [];
    if (homing) {
      const result = await applyHoming(x, y, windowTitle);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);
    }
    await moveTo(tx, ty, speed);
    const homingStr = !homing ? " [homing: off]" : notes.length ? ` [homing: ${notes.join(", ")}]` : "";
    return { content: [{ type: "text" as const, text: `Mouse moved to (${tx}, ${ty})${homingStr}` }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_move failed: ${String(err)}` }] };
  }
};

export const mouseClickHandler = async ({
  x, y, button, doubleClick, speed, homing, windowTitle, elementName, elementId,
}: {
  x: number; y: number; button: "left" | "right" | "middle"; doubleClick: boolean;
  speed?: number; homing: boolean; windowTitle?: string; elementName?: string; elementId?: string;
}): Promise<ToolResult> => {
  try {
    let tx = x, ty = y;
    const notes: string[] = [];
    if (homing) {
      const result = await applyHoming(x, y, windowTitle, elementName, elementId);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);
    }
    await moveTo(tx, ty, speed);
    const btn = toButton(button);
    if (doubleClick) {
      await mouse.doubleClick(btn);
    } else {
      await mouse.click(btn);
    }
    const action = doubleClick ? "Double-clicked" : "Clicked";
    const homingStr = !homing ? " [homing: off]" : notes.length ? ` [homing: ${notes.join(", ")}]` : "";
    return { content: [{ type: "text" as const, text: `${action} ${button} at (${tx}, ${ty})${homingStr}` }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_click failed: ${String(err)}` }] };
  }
};

export const mouseDragHandler = async ({
  startX, startY, endX, endY, speed, homing, windowTitle,
}: {
  startX: number; startY: number; endX: number; endY: number;
  speed?: number; homing: boolean; windowTitle?: string;
}): Promise<ToolResult> => {
  try {
    let tsx = startX, tsy = startY;
    let tex = endX, tey = endY;
    const notes: string[] = [];
    if (homing) {
      // Homing result gives us (correctedX, correctedY) and the underlying delta.
      // Apply the same (dx, dy) to the end point so the drag vector is preserved.
      const result = await applyHoming(startX, startY, windowTitle);
      const dx = result.x - startX;
      const dy = result.y - startY;
      tsx = result.x; tsy = result.y;
      tex = endX + dx; tey = endY + dy;
      notes.push(...result.notes);
    }
    await moveTo(tsx, tsy, speed);
    const s = speed ?? DEFAULT_MOUSE_SPEED;
    if (s === 0) {
      await mouse.pressButton(Button.LEFT);
      await mouse.setPosition(new Point(tex, tey));
      await mouse.releaseButton(Button.LEFT);
    } else {
      const prev = mouse.config.mouseSpeed;
      mouse.config.mouseSpeed = s;
      try {
        await mouse.drag(straightTo(new Point(tex, tey)));
      } finally {
        mouse.config.mouseSpeed = prev;
      }
    }
    const homingStr = !homing ? " [homing: off]" : notes.length ? ` [homing: ${notes.join(", ")}]` : "";
    return {
      content: [{ type: "text" as const, text: `Dragged from (${tsx}, ${tsy}) to (${tex}, ${tey})${homingStr}` }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `mouse_drag failed: ${String(err)}` }] };
  }
};

export const scrollHandler = async ({
  direction, amount, x, y, speed, homing, windowTitle,
}: {
  direction: "up" | "down" | "left" | "right"; amount: number;
  x?: number; y?: number; speed?: number; homing: boolean; windowTitle?: string;
}): Promise<ToolResult> => {
  try {
    let tx = x, ty = y;
    const notes: string[] = [];
    if (homing && x !== undefined && y !== undefined) {
      const result = await applyHoming(x, y, windowTitle);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);
    }
    if (tx !== undefined && ty !== undefined) {
      await moveTo(tx, ty, speed);
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
    const homingStr = !homing ? " [homing: off]" : notes.length ? ` [homing: ${notes.join(", ")}]` : "";
    return { content: [{ type: "text" as const, text: `Scrolled ${direction} by ${amount} steps${homingStr}` }] };
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
  server.tool(
    "mouse_click",
    [
      "Click the mouse at the specified coordinates.",
      "Pass windowTitle (and optionally elementName/elementId) as hints to enable homing correction:",
      "  - Tier 1: auto-corrects (dx,dy) if the window moved since the last screenshot (<1ms overhead)",
      "  - Tier 2: auto-focuses the window if it went behind another (~100ms overhead)",
      "  - Tier 3: re-queries UIA for fresh coords if the window resized (1-3s, only when elementName/Id given)",
      "Set homing=false to disable all correction (like traction control OFF).",
    ].join("\n"),
    mouseClickSchema,
    mouseClickHandler
  );
  server.tool("mouse_drag", "Click and drag from one position to another (left button hold).", mouseDragSchema, mouseDragHandler);
  server.tool("scroll", "Scroll at the current position or at specified coordinates.", scrollSchema, scrollHandler);
  server.tool("get_cursor_position", "Get the current mouse cursor position in virtual screen coordinates.", getCursorPositionSchema, getCursorPositionHandler);
}
