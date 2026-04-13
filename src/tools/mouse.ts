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
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withPostState } from "./_post.js";

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
  x: z.coerce.number().describe(
    "X coordinate. Screen-absolute by default. When 'origin' is provided, treated as image-local " +
    "(pixel position within the screenshot)."
  ),
  y: z.coerce.number().describe(
    "Y coordinate. Screen-absolute by default. When 'origin' is provided, treated as image-local."
  ),
  origin: z
    .object({
      x: z.coerce.number().describe("Screen x of image top-left (copy from screenshot response)"),
      y: z.coerce.number().describe("Screen y of image top-left (copy from screenshot response)"),
    })
    .optional()
    .describe(
      "When set, (x,y) are image-local coords from a screenshot. Server converts to screen coords: " +
      "screen_x = origin.x + x / (scale ?? 1), screen_y = origin.y + y / (scale ?? 1). " +
      "Copy origin values directly from the screenshot response text. " +
      "This eliminates manual coord math and prevents out-of-window clicks."
    ),
  scale: z
    .coerce.number()
    .positive()
    .optional()
    .describe(
      "Scale factor from screenshot response (only when dotByDotMaxDimension caused a resize). " +
      "Omit if the screenshot was 1:1. Only used when 'origin' is also provided."
    ),
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
    return ok({ ok: true, movedTo: { x: tx, y: ty }, homing: homingStr || undefined });
  } catch (err) {
    return failWith(err, "mouse_move");
  }
};

export const mouseClickHandler = async ({
  x, y, origin, scale, button, doubleClick, speed, homing, windowTitle, elementName, elementId,
}: {
  x: number; y: number;
  origin?: { x: number; y: number };
  scale?: number;
  button: "left" | "right" | "middle"; doubleClick: boolean;
  speed?: number; homing: boolean; windowTitle?: string; elementName?: string; elementId?: string;
}): Promise<ToolResult> => {
  try {
    // Image-local → screen conversion (before homing).
    // When origin is given, (x,y) are image-local; convert using scale factor.
    let screenX = x, screenY = y;
    const conversionNotes: string[] = [];
    if (origin !== undefined) {
      const s = scale ?? 1;
      if (s <= 0) {
        return failWith(`scale must be positive (got ${s})`, "mouse_click");
      }
      screenX = Math.round(origin.x + x / s);
      screenY = Math.round(origin.y + y / s);
      const scalePart = scale !== undefined ? ` / ${scale}` : "";
      conversionNotes.push(
        `image (${x}, ${y}) + origin (${origin.x}, ${origin.y})${scalePart} → screen (${screenX}, ${screenY})`
      );
    }

    let tx = screenX, ty = screenY;
    const notes: string[] = [];
    if (homing) {
      const result = await applyHoming(screenX, screenY, windowTitle, elementName, elementId);
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
    const action = doubleClick ? "doubleClick" : "click";
    return ok({
      ok: true, action, button, at: { x: tx, y: ty },
      ...(conversionNotes.length && { conversion: conversionNotes.join("; ") }),
      ...(notes.length && { homing: notes.join(", ") }),
    });
  } catch (err) {
    return failWith(err, "mouse_click");
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
    return ok({
      ok: true, action: "drag",
      from: { x: tsx, y: tsy }, to: { x: tex, y: tey },
      ...(notes.length && { homing: notes.join(", ") }),
    });
  } catch (err) {
    return failWith(err, "mouse_drag");
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
    return ok({ ok: true, scrolled: direction, steps: amount, ...(notes.length && { homing: notes.join(", ") }) });
  } catch (err) {
    return failWith(err, "scroll");
  }
};

export const getCursorPositionHandler = async (): Promise<ToolResult> => {
  try {
    const pos = await mouse.getPosition();
    return ok({ x: pos.x, y: pos.y });
  } catch (err) {
    return failWith(err, "get_cursor_position");
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
      "",
      "COORDINATE MODES:",
      "  1. Screen-absolute (default): x,y are virtual screen pixels.",
      "  2. Image-local: pass origin (and scale when present) from the screenshot response.",
      "     Server converts: screen = origin + (x,y) / (scale ?? 1). No manual math needed.",
    ].join("\n"),
    mouseClickSchema,
    withPostState("mouse_click", mouseClickHandler)
  );
  server.tool("mouse_drag", "Click and drag from one position to another (left button hold).", mouseDragSchema, withPostState("mouse_drag", mouseDragHandler));
  server.tool("scroll", "Scroll at the current position or at specified coordinates.", scrollSchema, scrollHandler);
  server.tool("get_cursor_position", "Get the current mouse cursor position in virtual screen coordinates.", getCursorPositionSchema, getCursorPositionHandler);
}

