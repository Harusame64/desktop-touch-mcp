import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse } from "../engine/nutjs.js";
import { validateLaunchCommand, resolveWellKnownPath, spawnDetached } from "../utils/launch.js";
import { enumMonitors, getVirtualScreen, enumWindowsInZOrder, type WindowZInfo } from "../engine/win32.js";
import { captureScreen } from "../engine/image.js";
import { clearLayers } from "../engine/layer-buffer.js";
import { getUiElements, extractActionableElements, WINUI3_CLASS_RE } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import type { ToolResult } from "./_types.js";

/** Chromium-based browser windows — UIA traversal is prohibitively slow on these */
export const CHROMIUM_TITLE_RE = /- (?:Google Chrome|Microsoft Edge|Brave|Opera|Vivaldi|Arc|Chromium)$/;

interface WindowSnapshot {
  title: string;
  region: { x: number; y: number; width: number; height: number };
  isActive: boolean;
  thumbnail: string | null;
  thumbnailSize: { width: number; height: number } | null;
  uiSummary: {
    /** Interactive elements with pre-computed clickAt coordinates. */
    actionable: Array<{ action: string; name: string; type: string; clickAt: { x: number; y: number }; value?: string }>;
    /** Static text extracted from the window. */
    texts: Array<{ content: string; at: { x: number; y: number } }>;
    elementCount: number;
    hints?: { winui3: boolean };
  } | null;
}

async function buildWindowSnapshot(
  wz: WindowZInfo,
  thumbnailMaxDim: number,
  includeUiSummary: boolean
): Promise<WindowSnapshot | null> {
  try {
    const { title, region } = wz;

    let thumbnail: string | null = null;
    let thumbnailSize: { width: number; height: number } | null = null;
    try {
      const captured = await captureScreen(region, thumbnailMaxDim);
      thumbnail = captured.base64;
      thumbnailSize = { width: captured.width, height: captured.height };
    } catch { /* screen grab can fail for some windows */ }

    let uiSummary: WindowSnapshot["uiSummary"] = null;
    // Skip UIA for Chromium-based browsers — their accessibility trees are
    // extremely large and PowerShell UIA traversal routinely hits the 2s timeout,
    // adding up to 10s of latency when multiple Chrome windows are open.
    // Use screenshot(detail='text', windowTitle=...) for Chrome interaction instead.
    if (includeUiSummary && !CHROMIUM_TITLE_RE.test(title)) {
      try {
        const uia = await getUiElements(title, 3, 60, 2000);
        const extracted = extractActionableElements(uia);
        uiSummary = {
          actionable: extracted.actionable.slice(0, 20).map((a) => ({
            action: a.action,
            name: a.name,
            type: a.type,
            clickAt: a.clickAt,
            ...(a.value !== undefined ? { value: a.value } : {}),
          })),
          texts: extracted.texts.slice(0, 10),
          elementCount: uia.elementCount,
          hints: { winui3: WINUI3_CLASS_RE.test(uia.windowClassName ?? "") },
        };
      } catch { /* UIA not available for all windows */ }
    }

    return { title, region, isActive: wz.isActive, thumbnail, thumbnailSize, uiSummary };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceSnapshotSchema = {
  thumbnailMaxDimension: z.coerce.number().int().positive().default(400).describe("Max size of per-window thumbnail images (default 400px)"),
  includeUiSummary: z.boolean().default(true).describe("Whether to include UI element summaries for each window"),
};

export const workspaceLaunchSchema = {
  command: z.string().max(260).describe("Executable name or full path (e.g. 'notepad.exe', 'calc.exe'). Shell interpreters (cmd.exe, powershell.exe, etc.) are blocked."),
  args: z.array(z.string().max(1000)).max(20).default([]).describe("Command-line arguments (max 20). Shell metacharacters (; & | ` $() ${}) are not allowed."),
  waitMs: z.coerce.number().int().min(0).max(30000).default(2000).describe("Milliseconds to wait for the window to appear (default 2000)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceSnapshotHandler = async ({
  thumbnailMaxDimension,
  includeUiSummary,
}: { thumbnailMaxDimension: number; includeUiSummary: boolean }): Promise<ToolResult> => {
  try {
    // Reset layer buffer — workspace_snapshot acts as an I-frame baseline
    clearLayers();

    // enumWindowsInZOrder() is a single synchronous Win32 EnumWindows sweep that
    // collects title, region, z-order, active state in one pass — far faster than
    // nut-js getWindows() which requires a separate async call per window property.
    const [monitors, cursorPos] = await Promise.all([
      Promise.resolve(enumMonitors()),
      mouse.getPosition().catch(() => ({ x: 0, y: 0 })),
    ]);

    const allWindows = enumWindowsInZOrder();
    updateWindowCache(allWindows);
    // Compute virtualScreen from already-fetched monitors to avoid a second EnumDisplayMonitors sweep
    const mons = monitors.map(m => m.bounds);
    const virtualScreen = mons.length === 0
      ? getVirtualScreen()
      : {
          x: Math.min(...mons.map(b => b.x)),
          y: Math.min(...mons.map(b => b.y)),
          width: Math.max(...mons.map(b => b.x + b.width)) - Math.min(...mons.map(b => b.x)),
          height: Math.max(...mons.map(b => b.y + b.height)) - Math.min(...mons.map(b => b.y)),
        };

    const CONCURRENCY = 4;
    const MAX_WINDOWS = 20;
    const usableWindows = allWindows
      .filter(w => !w.isMinimized && w.region.width >= 100 && w.region.height >= 50)
      .slice(0, MAX_WINDOWS);
    const activeTitle = allWindows.find(w => w.isActive)?.title ?? "";

    const snapshots: WindowSnapshot[] = [];
    for (let i = 0; i < usableWindows.length; i += CONCURRENCY) {
      const batch = usableWindows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((wz) => buildWindowSnapshot(wz, thumbnailMaxDimension, includeUiSummary))
      );
      for (const snap of results) {
        if (snap) snapshots.push(snap);
      }
    }

    const result = {
      displays: monitors.map((m) => ({ id: m.id, primary: m.primary, bounds: m.bounds, dpi: m.dpi, scale: `${m.scale}%` })),
      virtualScreen,
      cursor: { x: cursorPos.x, y: cursorPos.y },
      activeWindow: activeTitle || null,
      windows: snapshots.map((s) => ({
        title: s.title,
        region: s.region,
        isActive: s.isActive,
        thumbnailSize: s.thumbnailSize,
        uiSummary: includeUiSummary ? s.uiSummary : undefined,
      })),
      windowCount: snapshots.length,
    };

    const content: ToolResult["content"] = [];
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    for (const snap of snapshots) {
      if (snap.thumbnail) {
        content.push({ type: "image", data: snap.thumbnail, mimeType: "image/png" });
        content.push({ type: "text", text: `↑ "${snap.title}" ${snap.region.width}x${snap.region.height} at (${snap.region.x},${snap.region.y})` });
      }
    }

    return { content };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `workspace_snapshot failed: ${String(err)}` }] };
  }
};

export const workspaceLaunchHandler = async ({
  command, args, waitMs,
}: { command: string; args: string[]; waitMs: number }): Promise<ToolResult> => {
  try {
    // ── 1. Security validation (unchanged) ──────────────────────────────
    validateLaunchCommand(command, args);

    // ── 2. Resolve well-known paths (chrome.exe → full path) ────────────
    const { resolved, wasResolved } = resolveWellKnownPath(command);
    // If we resolved to a full path, re-validate with that path
    // (validateLaunchCommand checks basename, so the resolved path is safe)
    const actualCommand = resolved;

    // ── 3. Pre-launch window snapshot ───────────────────────────────────
    const beforeWindows = enumWindowsInZOrder();
    const beforeTitles = new Set(beforeWindows.map(w => w.title));
    const beforeHwnds = new Set(beforeWindows.map(w => w.hwnd));

    // ── 4. Spawn with deterministic error handling ──────────────────────
    // spawnDetached uses the 'spawn' and 'error' events (not setTimeout)
    // to reliably detect ENOENT/EACCES before proceeding.
    await spawnDetached(actualCommand, args);

    // ── 5. Poll for new window (instead of single sleep + check) ────────
    // Polling is better than a single waitMs sleep because:
    // - If the window appears in 200ms, we return in ~200ms not 2000ms.
    // - For Chrome single-instance, the title change may happen at any time.
    // - For slow apps, we keep checking up to the full waitMs budget.
    let foundTitle = "";
    let foundRegion: { x: number; y: number; width: number; height: number } | null = null;

    if (waitMs > 0) {
      const POLL_INTERVAL = 200;
      const deadline = Date.now() + waitMs;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

        try {
          const afterWindows = enumWindowsInZOrder();
          for (const w of afterWindows) {
            if (!w.title) continue;
            if (w.isMinimized || w.region.width < 50 || w.region.height < 50) continue;
            const isNewWindow = !beforeHwnds.has(w.hwnd);
            const isTitleChange = beforeHwnds.has(w.hwnd) && !beforeTitles.has(w.title);
            if (!isNewWindow && !isTitleChange) continue;
            foundTitle = w.title;
            foundRegion = w.region;
            break;
          }
          if (foundTitle) break; // Window found — stop polling early
        } catch {
          // enumWindowsInZOrder FFI failure — non-fatal, retry on next poll
        }
      }
    }

    const result: Record<string, unknown> = {
      launched: actualCommand,
      args,
      foundWindow: foundTitle || null,
      region: foundRegion,
    };
    if (wasResolved) {
      result.note = `Resolved "${command}" → "${actualCommand}"`;
    }
    if (!foundTitle && waitMs > 0) {
      result.hint =
        "No new window detected. The app may reuse an existing window (e.g. Chrome single-instance), " +
        "or it may need more time. Use workspace_snapshot to check current windows.";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `workspace_launch failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWorkspaceTools(server: McpServer): void {
  server.tool(
    "workspace_snapshot",
    [
      "Get a complete snapshot of the current desktop workspace in a single call.",
      "Returns: display layouts, all visible windows with thumbnails (WebP), cursor position,",
      "and per-window UI summaries listing actionable elements with pre-computed clickAt coordinates.",
      "",
      "uiSummary.actionable — interactive elements (buttons, inputs, menus) with:",
      "  action: 'click' | 'type' | 'expand' | 'select'",
      "  clickAt: {x, y} — pass directly to mouse_click, no coordinate math needed",
      "  value: current text content for editable fields",
      "",
      "Also resets the layer diff buffer, so subsequent screenshot(diffMode=true) calls",
      "will send only changed windows (P-frame) instead of the full desktop.",
      "",
      "Use this at the start of a session or when you need full desktop orientation.",
    ].join("\n"),
    workspaceSnapshotSchema,
    workspaceSnapshotHandler
  );

  server.tool(
    "workspace_launch",
    [
      "Launch an application and wait for it to appear, then return its window info.",
      "Detects the new window by comparing window list before/after launch —",
      "works for apps with localized (non-English) window titles (e.g. '電卓' for calc.exe).",
    ].join(" "),
    workspaceLaunchSchema,
    workspaceLaunchHandler
  );
}
