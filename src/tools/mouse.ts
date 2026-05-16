import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import {
  enumWindowsInZOrder,
  restoreAndFocusWindow,
  getWindowIdentity,
  readScrollInfo,
  getForegroundHwnd,
  getWindowRectByHwnd,
} from "../engine/win32.js";
import {
  updateWindowCache,
  findContainingWindow,
  getCachedWindowByTitle,
  computeWindowDelta,
} from "../engine/window-cache.js";
import { getElementBounds } from "../engine/uia-bridge.js";
import { captureWindowRawAndHash } from "../engine/layer-buffer.js";
import { hammingDistance } from "../engine/image.js";
import { coercedBoolean } from "./_coerce.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration, narrateParam } from "./_narration.js";
import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";
import { detectFocusLoss } from "./_focus.js";
import {
  snapshotForVerify,
  classifyDelivery,
  classifyDeliveryWithLocalRepaint,
  type VerifyDeliveryHint,
  type MouseVerifySnapshot,
} from "./_mouse-verify.js";
// ADR-019 Stage 4 — captureFrame for the pre-action reference frame.
// `getWindowRectByHwnd` + `findContainingWindow` are already imported above
// (lines 10, 14) so we only add the new ones here.
import { captureFrame, type RawFrame } from "../engine/layer-buffer.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled } from "./_action-guard.js";
import { detectTabDragRisk } from "../engine/perception/tab-drag-heuristic.js";
import { resolveWindowTarget, findPlainTopLevelWindowByTitle } from "./_resolve-window.js";
import {
  resolveInputDestination,
  dispatchScrollWheel,
  assertTier4Reachable,
  type VisualMotionObservation,
} from "./_input-pipeline.js";

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
        // Issue #202 P1-1 (Opus Round 1): default → 100ms wait → re-enum →
        // not-foreground → force escalate → re-enum ladder (mirror
        // window.ts:156-168 and keyboard.ts:367-380). Pre-fix the
        // `force=false` branch dropped restoreAndFocusWindow and immediately
        // continued without checking whether the focus actually transferred,
        // so a refused default attempt let the click land on the wrong
        // window with no signal at all. The new ladder catches both cases:
        //   - default succeeds → foreground reached, single push to notes
        //   - default refused → force escalate → re-enum
        //   - both refused → push "ForceFocusRefused" → caller's early
        //     return surfaces ForegroundRestricted ok:false
        //
        // Latency contract (Opus PR #206 Round 2 P3-2): single 100ms wait
        // between default and escalate; mouse_click is one-shot (one
        // SendInput per call) so a single retry is enough for fast
        // race-tolerance. Compare with terminal_send which uses 5×100ms
        // because keystrokes are streamed and a single missed retry
        // would silently drop characters mid-string.
        restoreAndFocusWindow(target.hwnd, { force: !!force });
        await new Promise<void>((r) => setTimeout(r, 100));
        let postWindows = enumWindowsInZOrder();
        let postActive = postWindows.find((w) => w.isActive);
        let reached = !!postActive && postActive.title.toLowerCase().includes(windowTitle.toLowerCase());

        if (!reached && !force) {
          // Auto-escalate to force=true (AttachThreadInput bypass) — caller
          // expressed intent by passing windowTitle, so we must try the
          // strongest path before giving up. Same escalate semantics as
          // focus_window / keyboard.
          restoreAndFocusWindow(target.hwnd, { force: true });
          await new Promise<void>((r) => setTimeout(r, 100));
          postWindows = enumWindowsInZOrder();
          postActive = postWindows.find((w) => w.isActive);
          reached = !!postActive && postActive.title.toLowerCase().includes(windowTitle.toLowerCase());
        }

        // Refresh cache after restore + escalation; the window may have
        // moved / unminimized in the process even when foreground transfer
        // ultimately failed, so the cache update is unconditional.
        updateWindowCache(postWindows);

        if (reached) {
          notes.push(`brought "${target.title}" to front`);
        } else {
          notes.push(`ForceFocusRefused`);
        }
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
  "Omit to use the configured default (DESKTOP_TOUCH_MOUSE_SPEED env var, default 3000)."
);

const homingParam = coercedBoolean().default(true).describe(
  "Enable homing correction (default true). " +
  "When enabled, the MCP server corrects stale coordinates if the target window moved " +
  "since the last screenshot. Set false to disable all correction (like traction control OFF)."
);

const windowTitleParam = z.string().optional().describe(
  "Hint: partial title of the window being clicked. " +
  "Enables window-delta correction and auto-focus if the window went behind another. " +
  "Use '@active' for the current foreground window. " +
  "Example: \"メモ帳\", \"Google Chrome\""
);

const hwndParam = z.string().optional().describe(
  "Direct window handle ID (takes precedence over windowTitle). " +
  "Obtain from desktop_discover response (windows[].hwnd). " +
  "String type to avoid 64-bit precision issues."
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
  hwnd: hwndParam,
};

const forceFocusParam = coercedBoolean().optional().describe(
  "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
  "before focusing the target window. Required when a pinned window (e.g. Claude CLI) " +
  "keeps stealing focus. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false). " +
  "Set DESKTOP_TOUCH_FORCE_FOCUS=1 to make true the global default."
);

const trackFocusParam = coercedBoolean().default(true).describe(
  "When true (default), detect if focus was stolen from the target window after the action. " +
  "Reports focusLost:{afterMs,expected,stolenBy,stolenByProcessName} in the response. " +
  "Set false to skip the settle wait and focus check."
);

const settleMsParam = z.coerce.number().int().min(0).max(2000).default(300).describe(
  "Milliseconds to wait after the action before checking foreground window (default 300). " +
  "Only used when trackFocus=true."
);

// Issue #178 — `hints.verifyDelivery` opt-out for callers that have their own
// post-state observation (run_macro chains, workflows that immediately
// screenshot, etc.). Default true: matrix doc §3.1 expects the strengthened
// pre/post snapshot on every commit-axis click. Pass false to skip the two
// extra UIA round-trips (~50-150 ms via the Rust native path on a healthy
// host, up to 2× UIA timeout on a hung target).
const verifyDeliveryParam = coercedBoolean().default(true).describe(
  "When true (default), capture pre/post snapshots of element-under-cursor + " +
  "focusedElement + foregroundWindow + scrollPos to populate hints.verifyDelivery " +
  "with status='delivered' | 'focus_only' | 'unverifiable' (issue #178). " +
  "Set false to skip the extra UIA work when the caller will read post state itself."
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
  doubleClick: coercedBoolean().default(false).describe("Whether to double-click"),
  tripleClick: coercedBoolean().default(false).describe("Whether to triple-click (select a line of text). Takes precedence over doubleClick when both are true."),
  narrate: narrateParam,
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
  elementName: elementNameParam,
  elementId: elementIdParam,
  hwnd: hwndParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  verifyDelivery: verifyDeliveryParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID for advanced pinned-target workflows. " +
    "When provided, guards are evaluated before clicking (safe.clickCoordinates, target.identityStable) " +
    "and a perception envelope is attached to post.perception in the response. " +
    "For normal use, omit lensId and pass windowTitle directly — Auto Perception handles tracking."
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
  hwnd: hwndParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards and envelope same as mouse_click."
  ),
  allowCrossWindowDrag: coercedBoolean().optional().default(false).describe(
    "When true, allow dragging the endpoint into a different window or the desktop background. " +
    "Default false — cross-window drags (including desktop/wallpaper) are blocked to prevent accidents. " +
    "Pass true to confirm intent for deliberate cross-window or desktop-area drags."
  ),
  allowTabDrag: coercedBoolean().optional().default(false).describe(
    "When true, allow drags that start in the title-bar / tab-strip area of a tabbed app " +
    "(Notepad, Terminal, Edge, Chrome, etc.). Default false — such drags are blocked because " +
    "they detach the tab into a new window rather than moving the window. " +
    "Pass true only when you intentionally want to rearrange or detach a tab. " +
    "Note: active only when auto-guard is enabled (same scope as allowCrossWindowDrag)."
  ),
  verifyDelivery: verifyDeliveryParam,
};

export const scrollSchema = {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.coerce.number().int().positive().default(3).describe("Number of scroll steps (default 3)"),
  x: z.coerce.number().optional().describe("X coordinate to scroll at (moves cursor there first)"),
  y: z.coerce.number().optional().describe("Y coordinate to scroll at"),
  speed: speedParam,
  homing: homingParam,
  windowTitle: windowTitleParam,
  hwnd: hwndParam,
};

export const getCursorPositionSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const mouseMoveHandler = async ({
  x, y, speed, homing, windowTitle, hwnd,
}: {
  x: number; y: number; speed?: number; homing: boolean; windowTitle?: string; hwnd?: string;
}): Promise<ToolResult> => {
  try {
    let tx = x, ty = y;
    const homingNotes: string[] = [];
    const resolved = await resolveWindowTarget({ hwnd, windowTitle });
    const effectiveTitle = resolved?.title ?? windowTitle;
    const warnings: string[] = [...(resolved?.warnings ?? [])];
    if (homing) {
      const result = await applyHoming(x, y, effectiveTitle);
      tx = result.x; ty = result.y;
      homingNotes.push(...result.notes);
    }
    await moveTo(tx, ty, speed);
    const homingStr = !homing ? " [homing: off]" : homingNotes.length ? ` [homing: ${homingNotes.join(", ")}]` : "";
    return ok({
      ok: true, movedTo: { x: tx, y: ty }, homing: homingStr || undefined,
      ...(warnings.length > 0 && { hints: { warnings } }),
    });
  } catch (err) {
    return failWith(err, "mouse_move");
  }
};

export const mouseClickHandler = async ({
  x: xIn, y: yIn, origin, scale, button, doubleClick, tripleClick, speed, homing, windowTitle: windowTitleIn, elementName, elementId,
  forceFocus: forceFocusArg, trackFocus, settleMs, verifyDelivery: verifyDeliveryArg, lensId, fixId, hwnd: hwndIn,
}: {
  x: number; y: number;
  origin?: { x: number; y: number };
  scale?: number;
  button: "left" | "right" | "middle"; doubleClick: boolean; tripleClick: boolean;
  speed?: number; homing: boolean; windowTitle?: string; elementName?: string; elementId?: string;
  forceFocus?: boolean; trackFocus: boolean; settleMs: number; verifyDelivery?: boolean; lensId?: string; fixId?: string;
  hwnd?: string;
}): Promise<ToolResult> => {
  // Issue #178: verifyDelivery defaults to true (matrix doc §3.1).
  // Param is `?: boolean` so undefined falls back to the default — keep call
  // sites that omit it (older internal callers) on the new default.
  const verifyDelivery = verifyDeliveryArg ?? true;
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");

  // fixId path: resolve the suggested fix and override args
  let x = xIn, y = yIn, windowTitle = windowTitleIn;
  const hwnd = hwndIn;
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
    // Resolve hwnd / @active to an effective window title (only when not using a fixId)
    const resolvedWin = !fixId ? await resolveWindowTarget({ hwnd, windowTitle }) : null;
    const effectiveTitle = resolvedWin?.title ?? windowTitle;

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
      const result = await applyHoming(screenX, screenY, effectiveTitle, elementName, elementId, force);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);

      // Issue #202: applyHoming pushes "ForceFocusRefused" into notes ONLY
      // after the post-wait foreground re-enumeration confirms refusal
      // (Codex PR #206 Round 1 P1 — pre-Round-2 path used the synchronous
      // forceFocusOk return value, which could false-positive when
      // SetForegroundWindow completes asynchronously and the window
      // becomes foreground during the 100ms settle). With the new ladder
      // (applyHoming:108-148) the note appears only when both default
      // and AttachThreadInput escalation failed.
      //
      // Pre-#202 path promoted that note to a warning AFTER the click had
      // already executed — so the click landed on whichever window happened
      // to hold focus, and the caller only saw a soft warning. Returning a
      // typed ForegroundRestricted ok:false BEFORE the click fires gives
      // callers the same machine-readable contract as focus_window /
      // keyboard (mirror window.ts:170-185 / keyboard.ts:874-887).
      // Recovery: call focus_window first (auto-escalate ladder lands on
      // ForegroundRestricted on its own when refusal is genuine).
      if (notes.indexOf("ForceFocusRefused") >= 0) {
        // P2-1 (Opus PR #206 Round 1): inject perception envelope on
        // lensId-tagged calls so run_macro chains can branch on
        // post.perception.status the same way the Step 3 guard fail path
        // (line 507-513) does. Pre-fix this early-return dropped the
        // envelope, which left run_macro readers without a signal.
        const earlyEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "mouse_click" }) : null;
        // P2-1 (Opus PR #206 Round 2): hint文言は force=true / force=false
        // で正確に分岐。force=true caller は applyHoming 内 default ladder
        // を skip するため、"default + escalation 両方 refused" は誤り。
        // terminal.ts:729-731 と同型分岐。
        const hint = force
          ? "Win11 refused the AttachThreadInput escalation; click suppressed to avoid landing on the wrong target"
          : "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation; click suppressed to avoid landing on the wrong target";
        return failWith(
          new Error("ForegroundRestricted"),
          "mouse_click",
          {
            ...(effectiveTitle && { windowTitle: effectiveTitle }),
            hint,
            attemptedForce: !!force,
            // P3-1 (Opus PR #206 Round 2): autoEscalated は applyHoming が
            // default → force escalate ladder を実行したか否か。force=false
            // 経路では実行 (true)、force=true 経路では caller が初手 force
            // 指定済 → ladder skip (false)。focus_window の semantic と整合。
            autoEscalated: !force,
            ...(earlyEnv && { _perceptionForPost: earlyEnv }),
          }
        );
      }
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
        kind: "coordinate", x: tx, y: ty, windowTitle: effectiveTitle,
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

    // Move cursor to (tx, ty) BEFORE the pre-click snapshot so that
    // `pre.elementAtPoint` reflects the actual click target — without this,
    // ElementFromPoint would read whatever sits under the *current* cursor
    // (could be a stale location from the previous tool call).
    await moveTo(tx, ty, speed);

    // Issue #178 — Phase 1: pre-click snapshot for delivery verification.
    // Mirrors `terminal({action:'send'})` BG path (`src/tools/terminal.ts`
    // §369-375 baseline marker): we capture the observable state *before*
    // the side effect so that the post snapshot can produce a meaningful
    // diff. Skipping the snapshot when `verifyDelivery` is off keeps the
    // ~50-150 ms UIA cost off the hot path for callers that opt out.
    let preSnapshot: MouseVerifySnapshot | null = null;
    // ADR-019 Stage 4 — pre-action reference frame for the SSIM cascade.
    // Captured only when verifyDelivery is on AND the Stage 4 mouse gate is
    // not opted out (sub-plan §2.4.1 gate 3 — `DESKTOP_TOUCH_STAGE4_SSIM=0`
    // skips even the capture cost). Containing window comes from the click
    // coordinate when `hwnd` is unresolved, matching the snapshot helper's
    // pattern (`_mouse-verify.ts:115`).
    let stage4PreFrame: RawFrame | null = null;
    let stage4Hwnd: bigint | null = null;
    let stage4WindowRect:
      | { x: number; y: number; width: number; height: number }
      | null = null;
    const stage4Enabled =
      verifyDelivery && process.env.DESKTOP_TOUCH_STAGE4_SSIM !== "0";
    if (stage4Enabled) {
      const containing = findContainingWindow(tx, ty);
      stage4Hwnd = containing?.hwnd ?? null;
      if (stage4Hwnd !== null) {
        stage4WindowRect = getWindowRectByHwnd(stage4Hwnd);
        if (stage4WindowRect !== null) {
          stage4PreFrame = await captureFrame(stage4Hwnd, stage4WindowRect);
        }
      }
    }
    if (verifyDelivery) {
      preSnapshot = await snapshotForVerify(tx, ty);
    }

    // Step 4: Execute click.
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
    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];

    // Issue #202: ForceFocusRefused early-return moved up to the homing block
    // (above) so the click never fires when foreground transfer was refused.
    // No notes splice here anymore — applyHoming's notes pass through to the
    // homing-notes field for diagnostic narration.
    const filteredNotes = notes;

    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: effectiveTitle,
        homingNotes: filteredNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    // Issue #178 — Phase 4: post-click read-back for delivery verification.
    // detectFocusLoss already waits `settleMs` when trackFocus is on; we add
    // a small extra settle when trackFocus is off so the receiver has time
    // to update its UIA tree before we read it. Same magnitude as the
    // terminal BG path (`terminal.ts` §432 conhost render budget); both
    // bounded by the L5 commit p99 SLO.
    let verifyDeliveryHint: VerifyDeliveryHint | undefined;
    if (verifyDelivery && preSnapshot) {
      if (!trackFocus) {
        await new Promise<void>((r) => setTimeout(r, 150));
      }
      const postSnapshot = await snapshotForVerify(tx, ty);
      // ADR-019 Stage 4 wiring — when Stage 4 prerequisites are met
      // (`stage4Enabled` AND hwnd + windowRect resolved) call the wrapper
      // that runs `classifyDelivery` first and then layers SSIM on top of
      // `focus_only` / `unverifiable` outcomes (sub-plan §2.4.1). When
      // prerequisites are not met we call the plain `classifyDelivery`
      // (matches pre-Stage-4 behaviour exactly — G4-3 regression gate).
      if (stage4Enabled && stage4Hwnd !== null && stage4WindowRect !== null) {
        verifyDeliveryHint = await classifyDeliveryWithLocalRepaint(
          preSnapshot,
          postSnapshot,
          "send_input",
          {
            hwnd: stage4Hwnd,
            hint: {
              point: { x: tx, y: ty },
              windowRect: stage4WindowRect,
            },
            preFrame: stage4PreFrame,
          },
        );
      } else {
        verifyDeliveryHint = classifyDelivery(preSnapshot, postSnapshot, "send_input");
      }
    }

    return ok({
      ok: true, action, button, at: { x: tx, y: ty },
      ...(conversionNotes.length && { conversion: conversionNotes.join("; ") }),
      ...(filteredNotes.length && { homing: filteredNotes.join(", ") }),
      ...(focusLost && { focusLost }),
      ...((warnings.length > 0 || verifyDeliveryHint) && {
        hints: {
          ...(warnings.length > 0 && { warnings }),
          ...(verifyDeliveryHint && { verifyDelivery: verifyDeliveryHint }),
        },
      }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "mouse_click");
  }
};

export const mouseDragHandler = async ({
  startX, startY, endX, endY, speed, homing, windowTitle, hwnd, lensId, allowCrossWindowDrag, allowTabDrag,
  verifyDelivery: verifyDeliveryArg,
}: {
  startX: number; startY: number; endX: number; endY: number;
  speed?: number; homing: boolean; windowTitle?: string; hwnd?: string; lensId?: string;
  allowCrossWindowDrag?: boolean; allowTabDrag?: boolean;
  verifyDelivery?: boolean;
}): Promise<ToolResult> => {
  // Issue #178: matrix doc §3.1 row mouse_drag — same default-on contract
  // as mouse_click. The drag pre-snapshot is captured at the START point
  // (where the down-event lands) and the post-snapshot at the END point
  // (where the up-event releases) — drag-induced scroll / drop side effects
  // typically register at the destination, not the source.
  const verifyDelivery = verifyDeliveryArg ?? true;
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const dragWarnings: string[] = [...(resolvedWin?.warnings ?? [])];

    // Step 1: Homing correction on start point.
    let tsx = startX, tsy = startY;
    let tex = endX, tey = endY;
    const notes: string[] = [];
    if (homing) {
      // Homing result gives us (correctedX, correctedY) and the underlying delta.
      // Apply the same (dx, dy) to the end point so the drag vector is preserved.
      const result = await applyHoming(startX, startY, effectiveTitle);
      const dx = result.x - startX;
      const dy = result.y - startY;
      tsx = result.x; tsy = result.y;
      tex = endX + dx; tey = endY + dy;
      notes.push(...result.notes);

      // Issue #202 / Phase 5 E3 (epic #211): mouse_drag was missing the
      // ForegroundRestricted early-return that mouse_click got via PR #206.
      // applyHoming pushes "ForceFocusRefused" into notes when both default
      // SetForegroundWindow and the AttachThreadInput escalation are refused
      // (applyHoming:108-154). Without the early return below the drag
      // executed on whichever window held foreground — the same silent-fail
      // pattern PR #202 fixed for mouse_click. The handler now mirrors
      // mouseClickHandler:502-531 — drag suppressed before nutjs.mouse.drag
      // fires when foreground transfer was refused.
      if (notes.indexOf("ForceFocusRefused") >= 0) {
        const earlyEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "mouse_drag" }) : null;
        return failWith(
          new Error("ForegroundRestricted"),
          "mouse_drag",
          {
            ...(effectiveTitle && { windowTitle: effectiveTitle }),
            hint: "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation; drag suppressed to avoid landing on the wrong target",
            attemptedForce: false,
            autoEscalated: true,
            ...(earlyEnv && { _perceptionForPost: earlyEnv }),
          }
        );
      }
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
        kind: "coordinate", x: tsx, y: tsy, windowTitle: effectiveTitle,
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
        kind: "coordinate", x: tex, y: tey, windowTitle: effectiveTitle,
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
    // Move to start before pre-snapshot so `pre.elementAtPoint` reflects the
    // actual drag origin (not stale cursor position). Same rationale as the
    // mouse_click pre-snapshot (matrix doc §3.1).
    await moveTo(tsx, tsy, speed);

    // Issue #178 / Codex P1: capture BOTH pre and post snapshots at the
    // SAME destination coordinate. Snapshotting pre at start and post at
    // end made `elementAtPoint` always differ (start vs end usually land
    // on different UIA elements even when the drag was silently dropped)
    // and classifyDelivery() would mark every drag as `delivered`.
    // Sharing the same `dragVerifyCoord` for both samples makes the diff
    // isolate drag side-effects (drop highlights, target scroll,
    // selection-rect repaint) from the unrelated source/destination
    // geometry difference — and makes the coord identity textually obvious
    // for future review (no implicit start-vs-end ambiguity).
    //
    // ElementFromPoint takes pixel coords, not the cursor's current
    // position, so the cursor can still sit at (tsx, tsy) when we sample
    // the destination element here.
    const dragVerifyCoord: readonly [number, number] = [tex, tey];
    let preSnapshot: MouseVerifySnapshot | null = null;
    if (verifyDelivery) {
      preSnapshot = await snapshotForVerify(dragVerifyCoord[0], dragVerifyCoord[1]);
    }

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

    // Issue #178 — Phase 4: post-drag snapshot at the SAME destination
    // coord as pre (see `dragVerifyCoord` declared above for rationale).
    // 150ms settle matches mouse_click for matrix doc §2.3 consistency.
    let verifyDeliveryHint: VerifyDeliveryHint | undefined;
    if (verifyDelivery && preSnapshot) {
      await new Promise<void>((r) => setTimeout(r, 150));
      const postSnapshot = await snapshotForVerify(dragVerifyCoord[0], dragVerifyCoord[1]);
      verifyDeliveryHint = classifyDelivery(preSnapshot, postSnapshot, "send_input");
    }

    return ok({
      ok: true, action: "drag",
      from: { x: tsx, y: tsy }, to: { x: tex, y: tey },
      ...(notes.length && { homing: notes.join(", ") }),
      ...((dragWarnings.length > 0 || verifyDeliveryHint) && {
        hints: {
          ...(dragWarnings.length > 0 && { warnings: dragWarnings }),
          ...(verifyDeliveryHint && { verifyDelivery: verifyDeliveryHint }),
        },
      }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "mouse_drag");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// scroll(action:'raw') — wheel SendInput delivery verification
// (issue #179, matrix doc §3.1: pre/post Win32 GetScrollInfo + page-end
//  disambiguation; image-hash fallback when scrollbar is unavailable.)
// ─────────────────────────────────────────────────────────────────────────────

/** ms to wait after wheel SendInput for the target to render the new scroll position. */
const SCROLL_VERIFY_SETTLE_MS = 150;

/**
 * Hamming distance threshold for "did the viewport change" via dHash.
 * Mirrors HASH_MOVE_THRESHOLD in smart-scroll.ts (kept independent so a tweak
 * there does not silently change raw-scroll verification semantics).
 */
const RAW_SCROLL_HASH_MOVE_THRESHOLD = 5;

/**
 * Floating-point tolerance for "scroll percent unchanged". GetScrollInfo
 * exposes integer steps but pageRatio is a derived float, so we allow a tiny
 * epsilon to avoid reading rounding noise as movement.
 *
 * Codex P1: 0.001 (= 0.1%) was too coarse — long scroll ranges (e.g. lists
 * with thousands of items) take real per-step deltas of pageRatio < 0.001,
 * so legitimately-delivered raw scrolls were being misclassified as
 * `ScrollNotDelivered`. 1e-6 is well below FP rounding noise (typical
 * (curr - min) / (max - min) integer-derived floats have ~7-digit
 * precision) yet small enough to catch single-step scrolls in scroll
 * ranges up to ~1M positions.
 */
const SCROLL_PERCENT_EPSILON = 1e-6;

/** Boundary tolerance for page-end detection (0% / 100%). */
const SCROLL_PERCENT_BOUNDARY_TOL = 0.005;

/**
 * @internal Exported for unit testing of the pure verification math
 * (tests/unit/scroll-raw-verify.test.ts). Not part of the public tool surface.
 */
export interface ScrollSnapshot {
  /** 0..1 from Win32 GetScrollInfo, or null when no Win32 scrollbar / unavailable. */
  vertical: number | null;
  horizontal: number | null;
  /** Image hash captured for the window (fallback when both Win32 axes are null). */
  dHash: bigint | null;
}

async function captureScrollSnapshot(
  hwnd: bigint | null,
  region: { x: number; y: number; width: number; height: number } | null,
): Promise<ScrollSnapshot> {
  if (hwnd === null) return { vertical: null, horizontal: null, dHash: null };
  const v = readScrollInfo(hwnd, "vertical");
  const h = readScrollInfo(hwnd, "horizontal");
  let dHash: bigint | null = null;
  // Only spend time on dHash when at least one Win32 axis is missing — otherwise
  // the percent diff alone is authoritative and dHash adds only image-capture cost.
  if ((v === null || h === null) && region !== null) {
    try {
      const cap = await captureWindowRawAndHash(hwnd, region);
      dHash = cap?.dHash ?? null;
    } catch {
      dHash = null;
    }
  }
  return {
    vertical: v?.pageRatio ?? null,
    horizontal: h?.pageRatio ?? null,
    dHash,
  };
}

/**
 * @internal Exported for unit testing — see `evaluateScrollDelivery` below.
 */
export interface ScrollVerifyOutcome {
  status: "delivered" | "unverifiable" | "not_delivered";
  /** Observed scroll-percent delta when measurable (Win32 path). */
  delta: { x: number | null; y: number | null } | "unverifiable";
  /**
   * Typed reason context. The union mixes two generations:
   *
   * The 4-value "matrix doc §4" enum (current emitters in `evaluateScrollDelivery`
   * boundary-fallback paths and `scrollHandler` post-snapshot block):
   *   - `read_back_unsupported`, `page_end_inferred`, `scrollbar_unavailable`,
   *     `no_target_window`. These are emitted today and pinned by
   *     `tests/unit/scroll-raw-verify.test.ts`. They are **scheduled for removal**
   *     by ADR-018 Phase 1b once the tier dispatcher lands.
   *
   * The 5-value ADR-018 §2.6.2 enum (no current emitters):
   *   - `delivered_via_uia` / `delivered_via_cdp` / `delivered_via_postmessage`:
   *     emitted under `status='delivered'` once Tier 1/2/3 dispatchers ship
   *     (Phase 1b / 3 / 4).
   *   - `wheel_overlay_intercepted`: emitted under `status='unverifiable'` when
   *     a transparent layered overlay is detected and observation fails (Phase 4).
   *   - `target_unreachable`: emitted under `status='not_delivered'` when either
   *     destination resolution failed (path-a) or every applicable tier was
   *     exhausted without observable delta (path-b, e.g. Word _WwG).
   *
   * See `docs/adr-018-input-pipeline-3tier.md` §2.6.3 for the full migration
   * table; CLAUDE.md §3.1 multi-table fact sweep across `_errors.ts` /
   * `scroll.ts` description / this union / `scroll-raw-verify.test.ts`.
   */
  reason?:
    // 4-value "matrix doc §4" enum (Phase 1b removes after dispatcher lands)
    | "read_back_unsupported"
    | "page_end_inferred"
    | "scrollbar_unavailable"
    | "no_target_window"
    // 5-value ADR-018 §2.6.2 enum (added Phase 1a as contract lock)
    | "delivered_via_uia"
    | "delivered_via_cdp"
    | "delivered_via_postmessage"
    | "wheel_overlay_intercepted"
    | "target_unreachable";
  /** Axis on which silent drop / unverifiable was detected (for context). */
  axis?: "vertical" | "horizontal";
  /**
   * ADR-019 MVP-1 (Stage 1) — additive TMOL observation telemetry. Forwarded
   * from `DispatchOutcome.observation` (set by Stage 1+ TMOL primitives such
   * as UIA `ScrollPercent` reading). Existing callers that ignore the field
   * are unaffected (CLAUDE.md §3.2 carry-over scope shrink). The canonical
   * shape lives in `src/tools/_input-pipeline.ts::VisualMotionObservation`
   * and is referenced by ADR-019 §2.1 / ADR-018 §2.6 envelope hint.
   */
  observation?: VisualMotionObservation;
}

/**
 * Page-end disambiguation per matrix doc §3.1:
 *   - pre.percent at boundary AND post.percent equal     → page-end success (no fail)
 *   - pre.percent NOT at boundary AND post.percent equal → silent drop (ScrollNotDelivered)
 *
 * Returns:
 *   - status:"delivered" — at least one axis moved, OR the requested axis was at
 *     its directional page-end boundary (pre at 0% scrolling up, etc.)
 *   - status:"not_delivered" — pre off-boundary AND post equal → silent drop
 *   - status:"unverifiable" — no Win32 axis on the requested direction AND no
 *     conclusive image-hash diff (matrix doc §3.1: page-end rule requires a
 *     boundary signal; without it we cannot distinguish page-end from drop)
 *
 * @internal Exported for unit testing — see `ScrollVerifyOutcome` above.
 */
export function evaluateScrollDelivery(
  pre: ScrollSnapshot,
  post: ScrollSnapshot,
  direction: "up" | "down" | "left" | "right",
): ScrollVerifyOutcome {
  const dx = pre.horizontal !== null && post.horizontal !== null
    ? post.horizontal - pre.horizontal
    : null;
  const dy = pre.vertical !== null && post.vertical !== null
    ? post.vertical - pre.vertical
    : null;

  const axisOfInterest: "vertical" | "horizontal" =
    direction === "up" || direction === "down" ? "vertical" : "horizontal";
  const preOnAxis = axisOfInterest === "vertical" ? pre.vertical : pre.horizontal;
  const postOnAxis = axisOfInterest === "vertical" ? post.vertical : post.horizontal;
  const deltaOnAxis = axisOfInterest === "vertical" ? dy : dx;

  // No Win32 scrollbar on the axis of interest — fall back to image hash.
  if (preOnAxis === null || postOnAxis === null) {
    if (pre.dHash !== null && post.dHash !== null) {
      const dist = hammingDistance(pre.dHash, post.dHash);
      if (dist >= RAW_SCROLL_HASH_MOVE_THRESHOLD) {
        return { status: "delivered", delta: { x: dx, y: dy } };
      }
      // Image hash unchanged — could be page-end OR silent drop. Without a
      // boundary signal we cannot disambiguate, so degrade to unverifiable
      // rather than risk a false positive (matrix doc §3.1 page-end rule
      // explicitly requires pre.percent boundary detection).
      return {
        status: "unverifiable",
        delta: { x: dx, y: dy },
        reason: "page_end_inferred",
        axis: axisOfInterest,
      };
    }
    // No observation channel at all (e.g. resolved hwnd but capture failed).
    return {
      status: "unverifiable",
      delta: "unverifiable",
      reason: "scrollbar_unavailable",
      axis: axisOfInterest,
    };
  }

  // Win32 axis available — apply page-end disambiguation.
  const moved = Math.abs(deltaOnAxis ?? 0) > SCROLL_PERCENT_EPSILON;
  if (moved) {
    return { status: "delivered", delta: { x: dx, y: dy } };
  }

  // No movement detected. Check if pre was at the boundary appropriate to the
  // scroll direction. Scrolling up at 0% or scrolling down at 100% (etc.) is a
  // legitimate no-op and must not surface as fail.
  const atUpperBoundary = preOnAxis >= 1 - SCROLL_PERCENT_BOUNDARY_TOL;
  const atLowerBoundary = preOnAxis <= SCROLL_PERCENT_BOUNDARY_TOL;
  const atDirectionalBoundary =
    (direction === "up" && atLowerBoundary) ||
    (direction === "down" && atUpperBoundary) ||
    (direction === "left" && atLowerBoundary) ||
    (direction === "right" && atUpperBoundary);
  if (atDirectionalBoundary) {
    return { status: "delivered", delta: { x: dx, y: dy } };
  }

  // pre off-boundary AND post equal → silent drop confirmed.
  return {
    status: "not_delivered",
    delta: { x: dx, y: dy },
    axis: axisOfInterest,
  };
}

/**
 * @internal Exported for unit testing of the Phase 3 issue-#294 envelope
 * normalisation. Collapses the internal `ScrollVerifyOutcome.delta` into the
 * shape advertised at `hints.scrollObserved.delta` on the public scroll
 * response.
 *
 * Collapse rules:
 *   - `'unverifiable'` string → unchanged
 *   - both axes null         → `'unverifiable'` (issue #294 — silent-drop
 *     ambiguity: the old shape `{x:null, y:null}` read as "observation
 *     exhausted" indistinguishably from the dedicated string, doubling the
 *     LLM-facing signal)
 *   - any other shape        → preserved as-is
 *
 * Single-axis-null (e.g. `{x:null, y:0.15}` from a vertical-only window) is
 * intentionally preserved: that null carries real signal ("this axis has no
 * scrollbar / no observation channel"), not the silent-drop ambiguity #294
 * reports.
 */
export function collapseScrollObserved(
  outcome: Pick<ScrollVerifyOutcome, "delta">,
): { delta: { x: number | null; y: number | null } | "unverifiable" } {
  if (outcome.delta === "unverifiable") {
    return { delta: "unverifiable" };
  }
  if (outcome.delta.x === null && outcome.delta.y === null) {
    return { delta: "unverifiable" };
  }
  return { delta: { x: outcome.delta.x, y: outcome.delta.y } };
}

export const scrollHandler = async ({
  direction, amount, x, y, speed, homing, windowTitle, hwnd,
}: {
  direction: "up" | "down" | "left" | "right"; amount: number;
  x?: number; y?: number; speed?: number; homing: boolean; windowTitle?: string; hwnd?: string;
}): Promise<ToolResult> => {
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const scrollWarnings: string[] = [...(resolvedWin?.warnings ?? [])];

    let tx = x, ty = y;
    const notes: string[] = [];
    if (homing && x !== undefined && y !== undefined) {
      const result = await applyHoming(x, y, effectiveTitle);
      tx = result.x; ty = result.y;
      notes.push(...result.notes);
    }
    if (tx !== undefined && ty !== undefined) {
      await moveTo(tx, ty, speed);
    }

    // ADR-018 Phase 1b — destination-explicit dispatch. The dispatcher
    // destination (`dest`) is resolved through resolveWindowTarget ONLY
    // (single SSOT per ADR §2.3 D3); cursor-pixel routing is confined to
    // Tier 4 (legacy nutjs path below) so the ADR-018 §1.2 root-cause
    // (cursor coordinates as the destination) cannot re-enter the dispatcher.
    const dest = await resolveInputDestination({ hwnd, windowTitle });

    // Observation HWND for snapshot verification. ADR §2.2 invariant:
    // observation must use the SAME destination the dispatcher acted on. When
    // `dest.kind === 'hwnd'` (Tier 1 candidate) seed it from `dest.hwnd`
    // directly so a successful UIA scroll on window A can never report a delta
    // measured on window B. The enum / cursor / foreground ladder below only
    // fills in for an `'unresolved'` destination (Tier 4 nutjs path), where
    // observation is read-only and may legitimately use any HWND at the
    // scroll point. The cursor/foreground fallback never routes dispatch.
    let observedHwnd: bigint | null =
      dest.kind === "hwnd" ? dest.hwnd : (resolvedWin?.hwnd ?? null);
    if (observedHwnd === null && windowTitle && windowTitle !== "@active") {
      // ADR-018 Phase 5: delegated to the shared `findPlainTopLevelWindowByTitle`
      // helper. Observation ladder uses `excludeDialogsAndOwned: false` because
      // observation tolerates dialog matches (it is read-only and never routes
      // dispatch). Phase 1b/4 §2.2 carry-over closed.
      const win = findPlainTopLevelWindowByTitle(windowTitle, {
        excludeMinimized: true,
        excludeDialogsAndOwned: false,
      });
      if (win) observedHwnd = win.hwnd;
    }
    if (observedHwnd === null && tx !== undefined && ty !== undefined) {
      const containing = findContainingWindow(tx, ty);
      if (containing) observedHwnd = containing.hwnd;
    }
    if (observedHwnd === null) {
      observedHwnd = getForegroundHwnd();
    }
    const observedRect = observedHwnd !== null ? getWindowRectByHwnd(observedHwnd) : null;

    // Phase 1: pre-scroll snapshot (matrix doc §3.1 + terminal regimen §2.1 phase 1).
    const pre = await captureScrollSnapshot(observedHwnd, observedRect);

    // Phase 2: side-effect injection. Try Tier 1 (UIA) first; if dispatcher returns
    // null, fall through to the legacy nutjs SendInput path (Phase 1b lenient guard).
    const tier1 = await dispatchScrollWheel(dest, { direction, notch: amount });

    if (tier1 === null) {
      // ADR-018 Phase 3 — when destination resolved to a CDP tab but Tier 2
      // dispatch / observation failed, emit `target_unreachable` per §2.6.2
      // path-(b) instead of falling through to Tier 4 SendInput.
      // `assertTier4Reachable(dest)` would throw for `kind:'cdp'` anyway —
      // we surface the typed envelope explicitly so callers see the proper
      // status / channel / reason rather than catching a thrown guard.
      if (dest.kind === "cdp") {
        return failWith(
          new Error("ScrollNotDelivered"),
          "scroll",
          {
            context: {
              hint: "CDP wheel dispatch or scroll observation returned no delta — Tier 4 SendInput suppressed for resolved CDP destinations",
              direction,
              verifyDelivery: {
                status: "not_delivered" as const,
                channel: "cdp" as const,
                reason: "target_unreachable" as const,
              },
            },
          },
        );
      }
      // ADR-018 Phase 4 — when destination resolved to an HWND but every
      // applicable tier (Tier 1 UIA + Tier 3 PostMessage) was exhausted
      // without observable delta (Word `_WwG` MFC custom-paint case, etc.),
      // emit `target_unreachable` per §2.6.2 path-(b). The `assertTier4Reachable`
      // strict guard below would throw for `kind:'hwnd' | 'uia'` anyway — this
      // branch surfaces the typed envelope explicitly with `channel:'postmessage'`
      // (the last attempted tier) so callers see the proper transport identifier.
      if (dest.kind === "hwnd" || dest.kind === "uia") {
        return failWith(
          new Error("ScrollNotDelivered"),
          "scroll",
          {
            context: {
              hint: "Tier 1 UIA + Tier 3 PostMessage both exhausted on the resolved destination (no ScrollPattern AND no observable scrollbar diff after WM_MOUSEWHEEL) — Tier 4 SendInput suppressed per ADR-018 §2.6.2 path-(b)",
              direction,
              verifyDelivery: {
                status: "not_delivered" as const,
                channel: "postmessage" as const,
                reason: "target_unreachable" as const,
              },
            },
          },
        );
      }
      assertTier4Reachable(dest);
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
    }

    // ADR-019 Stage 2b TMOL gate-fail (`docs/adr-019-stage-2b-plan.md` §2.2 /
    // §5 R3 Option I, locked Round 1 P2-2): when the dispatcher returns a
    // non-null `DispatchOutcome` with `scrolled: false` AND
    // `reason: "target_unreachable"`, Stage 2a's ring observed zero pixel
    // motion despite the PostMessage being queued (silent drop on the
    // chain-trust path). Route directly to the `not_delivered` envelope with
    // the observation propagated; do NOT run `evaluateScrollDelivery` below
    // because Win32 GetScrollInfo cannot observe custom-paint scrollbars on
    // chain-trust leaves (Excel `NUIScrollbar`, Word MFC) and would silently
    // override the TMOL signal. The Tier 1 UIA / Tier 2 CDP success paths
    // (`tier1.scrolled === true`) are unaffected — they retain the existing
    // `evaluateScrollDelivery`-driven `outcome.status` flow below.
    if (
      tier1 !== null &&
      tier1.scrolled === false &&
      tier1.reason === "target_unreachable"
    ) {
      const tmolObservation: VisualMotionObservation | undefined =
        tier1.observation;
      return failWith(
        new Error("ScrollNotDelivered"),
        "scroll",
        {
          context: {
            hint: "Stage 2b TMOL gate observed motion='no_change' on the chain-trust path (PostMessage queued but pixels did not change) — emitting target_unreachable per ADR-018 §2.6.2 path-(b) Stage 2b row",
            direction,
            verifyDelivery: {
              status: "not_delivered" as const,
              channel: "postmessage" as const,
              reason: "target_unreachable" as const,
              ...(tmolObservation ? { observation: tmolObservation } : {}),
            },
          },
        },
      );
    }

    // Phase 3: settle render.
    await new Promise<void>((r) => setTimeout(r, SCROLL_VERIFY_SETTLE_MS));

    // Phase 4: post-scroll snapshot + delivery evaluation.
    const post = await captureScrollSnapshot(observedHwnd, observedRect);

    // When Tier 1 UIA succeeded (`tier1 !== null && tier1.scrolled`), the dispatcher
    // already established delivery. We still capture a Win32 snapshot diff so
    // `scrollObserved.delta` carries a numeric value for callers that inspect it,
    // but we trust the dispatcher's success signal for `status`/`channel`/`reason`.
    const outcome: ScrollVerifyOutcome = tier1 !== null && tier1.scrolled
      ? { status: "delivered", delta: evaluateScrollDelivery(pre, post, direction).delta }
      : observedHwnd === null
        ? { status: "unverifiable", delta: "unverifiable", reason: "no_target_window" }
        : evaluateScrollDelivery(pre, post, direction);

    // hints.scrollObserved (issue #179 body shape) carries the raw delta values
    // for caller introspection; hints.verifyDelivery (matrix doc §4 shape) carries
    // the typed status/reason envelope. The two are kept side-by-side: scrollObserved
    // is scroll-specific (delta on each axis), verifyDelivery is the cross-tool SSOT
    // shape that other operation tools (#177-#181) also produce. Callers reading
    // either key see consistent answers; integration tests pin both.
    //
    // Issue #294 fix: collapse the public delta envelope via the
    // `collapseScrollObserved` helper — see that helper's docstring for the
    // rules and the rationale (silent-drop ambiguity reported in #294 when
    // both axes are null).
    const scrollObserved = collapseScrollObserved(outcome);

    // ADR-018 §2.6.1 — channel is the transport identifier (always populated,
    // including for `status:'not_delivered'`). Phase 1b emits 'uia' when Tier 1
    // succeeded; Phase 3 adds 'cdp' for the Tier 2 CDP dispatch; Phase 4 adds
    // 'postmessage' for Tier 3. The legacy SendInput path retains
    // 'wheel_send_input' for back-compat — the ADR §2.6.3 rename to 'send_input'
    // is deferred to a future cleanup PR (the Tier 4 `kind:'unresolved'` path
    // is the only remaining emitter once Phase 4 lands).
    //
    // **Explicit narrowing**, not an `as` cast: `tier1.channel` carries the
    // broad `Channel` union ("uia" | "cdp" | "postmessage" | "send_input"),
    // and casting to the narrow union would silently leak the wrong channel
    // into `verifyDelivery` if a future tier is added without updating this
    // branch. (Opus Round 1 P2.)
    let effectiveChannel:
      | "uia"
      | "cdp"
      | "postmessage"
      | "wheel_send_input" = "wheel_send_input";
    if (tier1 !== null && tier1.scrolled) {
      if (
        tier1.channel === "uia" ||
        tier1.channel === "cdp" ||
        tier1.channel === "postmessage"
      ) {
        effectiveChannel = tier1.channel;
      }
      // else: a future tier. Extend the local union and add the case when a
      // new channel is added here.
    }

    if (outcome.status === "not_delivered") {
      // Silent drop: pre off-boundary, post unchanged. ScrollNotDelivered with
      // suggestions sourced from the SSOT _errors.ts dictionary. ADR §2.6.1
      // requires channel to survive in the failure envelope — thread it
      // through context.verifyDelivery so callers reading the error envelope
      // (issue #179) see the consistent shape with success envelopes.
      return failWith(
        new Error("ScrollNotDelivered"),
        "scroll",
        {
          context: {
            hint: "post-state observation found no scroll movement on the requested axis (pre was off-boundary)",
            axis: outcome.axis,
            preVerticalPercent: pre.vertical,
            preHorizontalPercent: pre.horizontal,
            postVerticalPercent: post.vertical,
            postHorizontalPercent: post.horizontal,
            direction,
            verifyDelivery: {
              status: "not_delivered" as const,
              channel: effectiveChannel,
              ...(outcome.axis ? { axis: outcome.axis } : {}),
            },
          },
        },
      );
    }

    // ADR-019 MVP-1 (Stage 1) — propagate `observation` from dispatcher
    // outcome into the verifyDelivery envelope additively. Existing callers
    // that ignore the field are unaffected (CLAUDE.md §3.2 carry-over scope
    // shrink). The field is only attached when the dispatcher emitted one
    // (today: chain-trust branch of `postWheelToHwnd` for Stage 1).
    const dispatcherObservation: VisualMotionObservation | undefined =
      tier1 !== null ? tier1.observation : undefined;

    const verifyDelivery = outcome.status === "delivered"
      ? {
          status: "delivered" as const,
          channel: effectiveChannel,
          ...(tier1 !== null && tier1.reason !== null ? { reason: tier1.reason } : {}),
          ...(dispatcherObservation ? { observation: dispatcherObservation } : {}),
        }
      : {
          status: "unverifiable" as const,
          channel: "wheel_send_input" as const,
          reason: outcome.reason ?? "read_back_unsupported",
          ...(outcome.axis ? { axis: outcome.axis } : {}),
          ...(dispatcherObservation ? { observation: dispatcherObservation } : {}),
        };

    const hints: Record<string, unknown> = {
      scrollObserved,
      verifyDelivery,
    };
    if (scrollWarnings.length > 0) hints.warnings = scrollWarnings;

    return ok({
      ok: true,
      scrolled: direction,
      steps: amount,
      ...(notes.length && { homing: notes.join(", ") }),
      hints,
    });
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

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `mouse_click` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — no lease 4-tuple validation, fixed-coordinate click).
 * Mechanical copy of PR #117 `clickElementRegistrationHandler` pattern
 * (`docs/walking-skeleton-expansion-plan.md` §3 30-minute time-attack
 * template, sub-plan §1.1 G).
 *
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer):
 *   - withRichNarration enriches the handler's ToolResult (`hints.diff` 等)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.mouse_click` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
export const mouseClickRegistrationHandler = makeCommitWrapper(
  withRichNarration("mouse_click", mouseClickHandler, { windowTitleKey: "windowTitle" }) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "mouse_click",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Registration-time schema with `include?: string[]` injected via
 * `withEnvelopeIncludeSchema` so per-call envelope opt-in
 * (`include:["envelope"]` / `include:["causal"]` / `include:["raw"]`)
 * survives the MCP SDK's `z.object(schema).parse(args)` step.
 *
 * Both registration paths must use this injected schema:
 *   1. `server.tool("mouse_click", desc, mouseClickRegistrationSchema, ...)`
 *   2. `TOOL_REGISTRY.mouse_click = { schema: z.object(mouseClickRegistrationSchema), ... }`
 *
 * Without injection, Zod's default object parse strips unknown keys and
 * `include` is removed before `makeCommitWrapper` can peek it
 * (Codex PR #121 P2 + PR #112 / PR #117 同型 risk pattern).
 */
export const mouseClickRegistrationSchema = withEnvelopeIncludeSchema(mouseClickSchema);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `mouse_drag` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — no lease 4-tuple validation, fixed-coordinate drag).
 * Mechanical copy of PR #121 `mouseClickRegistrationHandler` pattern
 * (`docs/walking-skeleton-expansion-plan.md` §3 30-minute time-attack
 * template, raw shape 3a family).
 *
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer):
 *   - withRichNarration enriches the handler's ToolResult with post.* state
 *     (this composition was already in use prior to this PR — preserved)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.mouse_drag` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
export const mouseDragRegistrationSchema = withEnvelopeIncludeSchema(mouseDragSchema);

export const mouseDragRegistrationHandler = makeCommitWrapper(
  withRichNarration("mouse_drag", mouseDragHandler, { windowTitleKey: "windowTitle" }) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "mouse_drag",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerMouseTools(server: McpServer): void {
  // Phase 4: mouse_move privatized — hover-trigger UIs are rare in practice.
  // mouseMoveHandler retained as internal export for tests / future facade.
  // (memory: feedback_disable_via_entry_block.md)
  server.tool(
    "mouse_click",
    "Click at screen coordinates. Normally pass windowTitle so the server auto-guards the click (verifies target identity, foreground, coordinate is inside the target rect) and returns post.perception without a confirmation screenshot. origin+scale from dotByDot=true screenshots are converted to screen coords before guarding. doubleClick:true for double-click; tripleClick:true for triple-click (selects a full line of text). Prefer click_element (UIA) for native apps, prefer browser_click for Chrome. Examples: mouse_click({windowTitle:'Notepad', x:200, y:150}) // guarded — post.perception.status='ok'. mouse_click({x:100, y:100}) // unguarded — post.perception.status='unguarded'. If a guard failure returns a suggestedFix, pass its fixId to approve the fix: mouse_click({fixId:'fix-...'}) // one-shot, expires in 15s. lensId is optional and only for advanced pinned-target workflows; omit it for normal use. Caveats: origin+scale are meaningful ONLY with dotByDot=true screenshot responses. hints.verifyDelivery:{status:'delivered'|'focus_only'|'unverifiable', reason} reports the post-click observation in 3 values (focused-element shift, window-foreground change, or no signal). Win11 foreground refusal during the homing path (UIPI cross-elevation / admin-only target / call from a background process or service) returns code:'ForegroundRestricted' ok:false rather than landing the click on the wrong window — recover by switching to a tool that accepts windowTitle directly (click_element / desktop_act) — browser_* tools target by tabId/selector, not windowTitle. MouseClickNotDelivered is reserved-only (false-positive risk is too high to emit a typed code), so degradation is expressed via the 'unverifiable' status, not a separate error.",
    mouseClickRegistrationSchema,
    mouseClickRegistrationHandler as typeof mouseClickHandler
  );
  server.tool(
    "mouse_drag",
    "Click and drag from (startX, startY) to (endX, endY) holding the left mouse button — for sliders, drag-and-drop, canvas drawing, and window resizing. Pass windowTitle so the server auto-guards the start coordinate and returns post.perception. Examples: mouse_drag({windowTitle:'Notepad', startX:50, startY:50, endX:200, endY:200}). lensId is optional and only for advanced pinned-target workflows. Caveats: Left button only. Both start and endpoint are guarded. Cross-window and desktop drags are blocked by default — pass allowCrossWindowDrag:true to confirm intent. hints.verifyDelivery:{status:'delivered'|'focus_only'|'unverifiable', reason} reports the post-drop observation in the same 3-value shape as mouse_click. MouseDragNotDelivered is SUGGESTS-registered but reserved-only (not emitted) — degradation is expressed via the 'unverifiable' status rather than a typed code. Win11 foreground refusal (UIPI cross-elevation / admin-only target / call from a background process or service) returns code:'ForegroundRestricted' ok:false from the homing path.",
    mouseDragRegistrationSchema,
    mouseDragRegistrationHandler as typeof mouseDragHandler
  );
  // scroll tool removed in Phase 2b (family merge) — registered via scroll(action='raw') in scroll.ts
  // Phase 4: get_cursor_position privatized — handler retained as internal export.
  // Use desktop_state for cursorPos (always present) or desktop_state({includeCursor:true})
  // for the richer {x, y, monitorId} shape.
  // (memory: feedback_disable_via_entry_block.md)
}

