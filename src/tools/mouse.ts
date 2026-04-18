import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow, getWindowIdentity } from "../engine/win32.js";
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
import { withRichNarration, narrateParam } from "./_narration.js";
import { detectFocusLoss } from "./_focus.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled } from "./_action-guard.js";
import { detectTabDragRisk } from "../engine/perception/tab-drag-heuristic.js";

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
  force?: boolean,
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
        const rf = restoreAndFocusWindow(target.hwnd, { force: !!force });
        if (force && rf.forceFocusOk === false) {
          notes.push(`ForceFocusRefused`);
        }
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

const forceFocusParam = z.boolean().optional().describe(
  "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
  "before focusing the target window. Required when a pinned window (e.g. Claude CLI) " +
  "keeps stealing focus. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false). " +
  "Set DESKTOP_TOUCH_FORCE_FOCUS=1 to make true the global default."
);

const trackFocusParam = z.boolean().default(true).describe(
  "When true (default), detect if focus was stolen from the target window after the action. " +
  "Reports focusLost:{afterMs,expected,stolenBy,stolenByProcessName} in the response. " +
  "Set false to skip the settle wait and focus check."
);

const settleMsParam = z.coerce.number().int().min(0).max(2000).default(300).describe(
  "Milliseconds to wait after the action before checking foreground window (default 300). " +
  "Only used when trackFocus=true."
);

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
  tripleClick: z.boolean().default(false).describe("Whether to triple-click (select a line of text). Takes precedence over doubleClick when both are true."),
  narrate: narrateParam,
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
  elementName: elementNameParam,
  elementId: elementIdParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID from perception_register. When provided, guards are evaluated " +
    "before clicking (safe.clickCoordinates, target.identityStable) and a perception envelope " +
    "is attached to post.perception in the response."
  ),
  fixId: z.string().optional().describe(
    "One-shot fix approval ID. If a previous mouse_click returned a suggestedFix, pass that fixId " +
    "here to approve it. The server revalidates the fix and executes with corrected args. " +
    "fixId expires in 15 seconds and can only be used once."
  ),
};

export const mouseDragSchema = {
  startX: z.coerce.number(),
  startY: z.coerce.number(),
  endX: z.coerce.number(),
  endY: z.coerce.number(),
  narrate: narrateParam,
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards and envelope same as mouse_click."
  ),
  allowCrossWindowDrag: z.boolean().optional().default(false).describe(
    "When true, allow dragging the endpoint into a different window or the desktop background. " +
    "Default false — cross-window drags (including desktop/wallpaper) are blocked to prevent accidents. " +
    "Pass true to confirm intent for deliberate cross-window or desktop-area drags."
  ),
  allowTabDrag: z.boolean().optional().default(false).describe(
    "When true, allow drags that start in the title-bar / tab-strip area of a tabbed app " +
    "(Notepad, Terminal, Edge, Chrome, etc.). Default false — such drags are blocked because " +
    "they detach the tab into a new window rather than moving the window. " +
    "Pass true only when you intentionally want to rearrange or detach a tab. " +
    "Note: active only when auto-guard is enabled (same scope as allowCrossWindowDrag)."
  ),
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
  x: xIn, y: yIn, origin, scale, button, doubleClick, tripleClick, speed, homing, windowTitle: windowTitleIn, elementName, elementId,
  forceFocus: forceFocusArg, trackFocus, settleMs, lensId, fixId,
}: {
  x: number; y: number;
  origin?: { x: number; y: number };
  scale?: number;
  button: "left" | "right" | "middle"; doubleClick: boolean; tripleClick: boolean;
  speed?: number; homing: boolean; windowTitle?: string; elementName?: string; elementId?: string;
  forceFocus?: boolean; trackFocus: boolean; settleMs: number; lensId?: string; fixId?: string;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");

  // fixId path: resolve the suggested fix and override args
  let x = xIn, y = yIn, windowTitle = windowTitleIn;
  if (fixId) {
    const { resolveFix, consumeFix } = await import("../engine/perception/suggested-fix-store.js");
    const fix = resolveFix(fixId);
    if (!fix) {
      return failWith(new Error(`fixId "${fixId}" not found, expired, or already used`), "mouse_click");
    }
    if (fix.tool !== "mouse_click") {
      return failWith(new Error(`fixId "${fixId}" is for tool "${fix.tool}", not mouse_click`), "mouse_click");
    }

    // targetFingerprint revalidation — prevent applying fix to wrong target (v3 §7)
    if (fix.targetFingerprint.hwnd && fix.targetFingerprint.processStartTimeMs !== undefined) {
      const { buildWindowIdentity } = await import("../engine/perception/sensors-win32.js");
      const currentId = buildWindowIdentity(fix.targetFingerprint.hwnd);
      if (!currentId || currentId.processStartTimeMs !== fix.targetFingerprint.processStartTimeMs) {
        return failWith(
          new Error(`fixId target fingerprint mismatch: window identity changed since fix was created`),
          "mouse_click"
        );
      }
    }

    // Apply fix args (override user-supplied x/y/windowTitle; fix args are already screen coords)
    x = fix.args.x as number;
    y = fix.args.y as number;
    if (typeof fix.args.windowTitle === "string") windowTitle = fix.args.windowTitle;
    // Consume immediately (one-shot) — after revalidation succeeds
    consumeFix(fixId);
    // Disable origin/scale — fix args are already screen coordinates
    origin = undefined;
  }

  try {
    // Step 1: Image-local → screen conversion.
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

    // Step 2: Homing correction.
    let tx = screenX, ty = screenY;
    const notes: string[] = [];
    if (homing) {
      const result = await applyHoming(screenX, screenY, windowTitle, elementName, elementId, force);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);
    }

    // Step 3: Guard evaluation on FINAL coordinates (after conversion + homing).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "mouse_click", { x: tx, y: ty, clickAt: { x: tx, y: ty } });
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "mouse_click", args: { x: tx, y: ty } });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "mouse_click",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "mouse_click", args: { x: tx, y: ty } }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "coordinate", x: tx, y: ty, windowTitle,
      };
      const ag = await runActionGuard({
        toolName: "mouse_click", actionKind: "mouseClick", descriptor, clickCoordinates: { x: tx, y: ty },
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "mouse_click",
          { _perceptionForPost: ag.summary }
        );
      }
      perceptionEnv = ag.summary;
    }

    // Step 4: Execute click.
    await moveTo(tx, ty, speed);
    const btn = toButton(button);
    let action: string;
    if (tripleClick) {
      await mouse.click(btn);
      await mouse.click(btn);
      await mouse.click(btn);
      action = "tripleClick";
    } else if (doubleClick) {
      await mouse.doubleClick(btn);
      action = "doubleClick";
    } else {
      await mouse.click(btn);
      action = "click";
    }

    // Detect focus loss after the click
    let focusLost = undefined;
    const warnings: string[] = [];

    // Promote ForceFocusRefused from homing notes to warnings
    const idx = notes.indexOf("ForceFocusRefused");
    if (idx >= 0) {
      warnings.push("ForceFocusRefused");
      notes.splice(idx, 1);
    }
    const filteredNotes = notes;

    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: windowTitle,
        homingNotes: filteredNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    return ok({
      ok: true, action, button, at: { x: tx, y: ty },
      ...(conversionNotes.length && { conversion: conversionNotes.join("; ") }),
      ...(filteredNotes.length && { homing: filteredNotes.join(", ") }),
      ...(focusLost && { focusLost }),
      ...(warnings.length > 0 && { hints: { warnings } }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "mouse_click");
  }
};

export const mouseDragHandler = async ({
  startX, startY, endX, endY, speed, homing, windowTitle, lensId, allowCrossWindowDrag, allowTabDrag,
}: {
  startX: number; startY: number; endX: number; endY: number;
  speed?: number; homing: boolean; windowTitle?: string; lensId?: string;
  allowCrossWindowDrag?: boolean; allowTabDrag?: boolean;
}): Promise<ToolResult> => {
  try {
    // Step 1: Homing correction on start point.
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

    // Step 2: Guard evaluation on FINAL start coordinates (after homing).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "mouse_drag", { x: tsx, y: tsy });
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "mouse_drag" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "mouse_drag",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "mouse_drag" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "coordinate", x: tsx, y: tsy, windowTitle,
      };
      const ag = await runActionGuard({
        toolName: "mouse_drag", actionKind: "mouseDrag", descriptor, clickCoordinates: { x: tsx, y: tsy },
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "mouse_drag",
          { _perceptionForPost: ag.summary }
        );
      }
      perceptionEnv = ag.summary;

      // Phase I: endpoint guard (v3 §5.2)
      const descEnd: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "coordinate", x: tex, y: tey, windowTitle,
      };
      const agEnd = await runActionGuard({
        toolName: "mouse_drag", actionKind: "mouseDrag", descriptor: descEnd, clickCoordinates: { x: tex, y: tey },
      });
      if (agEnd.block) {
        return failWith(
          new Error(`AutoGuardBlocked[endpoint]: ${agEnd.summary.next}`),
          "mouse_drag",
          { _perceptionForPost: agEnd.summary }
        );
      }

      // Phase I-a: tab-strip drag detection (checked before cross-window to give better error)
      if (!allowTabDrag) {
        const startWinForTab = findContainingWindow(tsx, tsy);
        if (startWinForTab) {
          const identity = getWindowIdentity(startWinForTab.hwnd);
          const tabRisk = detectTabDragRisk(
            tsx, tsy, tex, tey,
            startWinForTab.region.y,
            identity.processName
          );
          if (tabRisk.risk) {
            return failWith(
              new Error("TabDragBlocked: drag starts in the tab-strip area of a tabbed application"),
              "mouse_drag",
              { suggest: [
                "To move the window, drag from the window border or use Win+Arrow keys instead",
                "Pass allowTabDrag:true if you intend to rearrange or detach a tab",
              ] }
            );
          }
        }
      }

      // Phase I-b: cross-window / desktop drag check
      // start point is safety-critical; endpoint is also guarded (v3 §5.2)
      if (!allowCrossWindowDrag) {
        const startWin = findContainingWindow(tsx, tsy);
        const endWin   = findContainingWindow(tex, tey);
        const startHwnd = startWin ? String(startWin.hwnd) : null;
        const endHwnd   = endWin   ? String(endWin.hwnd)   : null;
        if (startHwnd !== endHwnd) {
          return failWith(
            new Error(
              `CrossWindowDragBlocked: start hwnd=${startHwnd ?? "desktop"} → end hwnd=${endHwnd ?? "desktop"}. ` +
              `Pass allowCrossWindowDrag:true to confirm intent (e.g. for desktop range selection).`
            ),
            "mouse_drag",
            { suggest: ["Pass allowCrossWindowDrag:true to confirm cross-window or desktop drag intent"] }
          );
        }
      }
    }

    // Step 3: Execute drag.
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
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
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
  server.tool("mouse_move", "Move the cursor to coordinates without clicking — for hover-only effects such as revealing tooltips or triggering hover states. Use mouse_click for click targets (it moves and clicks in one call).", mouseMoveSchema, mouseMoveHandler);
  server.tool(
    "mouse_click",
    "Click at screen coordinates. Normally pass windowTitle so the server auto-guards the click (verifies target identity, foreground, coordinate is inside the target rect) and returns post.perception without a confirmation screenshot. origin+scale from dotByDot=true screenshots are converted to screen coords before guarding. doubleClick:true for double-click; tripleClick:true for triple-click (selects a full line of text). Prefer click_element (UIA) for native apps, prefer browser_click_element for Chrome. Examples: mouse_click({windowTitle:'Notepad', x:200, y:150}) // guarded — post.perception.status='ok'. mouse_click({x:100, y:100}) // unguarded — post.perception.status='unguarded'. If a guard failure returns a suggestedFix, pass its fixId to approve the fix: mouse_click({fixId:'fix-...'}) // one-shot, expires in 15s. lensId is optional and only for advanced pinned-target workflows after perception_register; omit it for normal use. Caveats: origin+scale are meaningful ONLY with dotByDot=true screenshot responses.",
    mouseClickSchema,
    withRichNarration("mouse_click", mouseClickHandler, { windowTitleKey: "windowTitle" })
  );
  server.tool("mouse_drag", "Click and drag from (startX, startY) to (endX, endY) holding the left mouse button — for sliders, drag-and-drop, canvas drawing, and window resizing. Pass windowTitle so the server auto-guards the start coordinate and returns post.perception. Examples: mouse_drag({windowTitle:'Notepad', startX:50, startY:50, endX:200, endY:200}). lensId is optional and only for advanced pinned-target workflows. Caveats: Left button only. Both start and endpoint are guarded. Cross-window and desktop drags are blocked by default — pass allowCrossWindowDrag:true to confirm intent.", mouseDragSchema, withRichNarration("mouse_drag", mouseDragHandler, { windowTitleKey: "windowTitle" }));
  server.tool("scroll", "Send raw mouse-wheel notches at (x,y) or current cursor. amount = notches (1 ≈ 3 lines, default 3). direction: 'up'|'down'|'left'|'right'. Pass windowTitle to auto-focus + enable homing. Prefer scroll_to_element / smart_scroll / scroll_capture / browser-side scroll for their specific cases. Example: scroll({windowTitle:'Chrome', direction:'down', amount:5}).", scrollSchema, scrollHandler);
  server.tool("get_cursor_position", "Return the current mouse cursor position in virtual screen coordinates.", getCursorPositionSchema, getCursorPositionHandler);
}

