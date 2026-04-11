import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { getWindows, getActiveWindow, mouse } from "../engine/nutjs.js";
import { isExecutableAllowlisted } from "../utils/launch-config.js";
import { enumMonitors, getVirtualScreen, getWindowTitleW } from "../engine/win32.js";
import { captureScreen } from "../engine/image.js";
import { clearLayers } from "../engine/layer-buffer.js";
import { getUiElements, extractActionableElements } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";

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
  } | null;
}

async function buildWindowSnapshot(
  win: Awaited<ReturnType<typeof getWindows>>[number],
  activeTitle: string,
  thumbnailMaxDim: number,
  includeUiSummary: boolean
): Promise<WindowSnapshot | null> {
  try {
    const nutTitle = await win.title;
    if (!nutTitle) return null;

    const reg = await win.region;
    const region = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
    const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
    const title = hwnd ? (getWindowTitleW(hwnd) || nutTitle) : nutTitle;

    let thumbnail: string | null = null;
    let thumbnailSize: { width: number; height: number } | null = null;
    if (region.width >= 100 && region.height >= 50) {
      try {
        const captured = await captureScreen(region, thumbnailMaxDim);
        thumbnail = captured.base64;
        thumbnailSize = { width: captured.width, height: captured.height };
      } catch { /* screen grab can fail for some windows */ }
    }

    let uiSummary: WindowSnapshot["uiSummary"] = null;
    if (includeUiSummary) {
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
        };
      } catch { /* UIA not available for all windows */ }
    }

    return { title, region, isActive: title === activeTitle, thumbnail, thumbnailSize, uiSummary };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceSnapshotSchema = {
  thumbnailMaxDimension: z.number().int().positive().default(400).describe("Max size of per-window thumbnail images (default 400px)"),
  includeUiSummary: z.boolean().default(true).describe("Whether to include UI element summaries for each window"),
};

export const workspaceLaunchSchema = {
  command: z.string().max(260).describe("Executable name or full path (e.g. 'notepad.exe', 'calc.exe'). Shell interpreters (cmd.exe, powershell.exe, etc.) are blocked."),
  args: z.array(z.string().max(1000)).max(20).default([]).describe("Command-line arguments (max 20). Shell metacharacters (; & | ` $() ${}) are not allowed."),
  waitMs: z.number().int().min(0).max(30000).default(2000).describe("Milliseconds to wait for the window to appear (default 2000)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Launch security validation
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_EXECUTABLES = new Set([
  "cmd", "cmd.exe",
  "powershell", "powershell.exe",
  "pwsh", "pwsh.exe",
  "wscript", "wscript.exe",
  "cscript", "cscript.exe",
  "mshta", "mshta.exe",
  "regsvr32", "regsvr32.exe",
  "rundll32", "rundll32.exe",
  "msiexec", "msiexec.exe",
  "bash", "bash.exe",
  "sh", "sh.exe",
  "wsl", "wsl.exe",
]);

const BLOCKED_EXTENSIONS = new Set([".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh"]);
const SHELL_METACHAR_RE = /[;&|`]|\$\(|\$\{/;

function validateLaunchCommand(command: string, args: string[]): void {
  // User allowlist takes priority over all blocklist checks
  if (isExecutableAllowlisted(command)) return;

  const ext = path.extname(command).toLowerCase();
  if (ext && ext !== ".exe" && ext !== ".com") {
    throw new Error(`Blocked: "${command}" has disallowed extension "${ext}". Only .exe files are permitted.`);
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Blocked: script files (${ext}) cannot be launched directly.`);
  }
  const basename = path.basename(command).toLowerCase();
  const basenameNoExt = basename.replace(/\.(exe|com)$/i, "");
  if (BLOCKED_EXECUTABLES.has(basename) || BLOCKED_EXECUTABLES.has(basenameNoExt)) {
    throw new Error(
      `Blocked: "${basename}" is a shell interpreter and cannot be launched for security reasons. ` +
      `To allow it, add it to desktop-touch-allowlist.json (see README for details).`
    );
  }
  for (const arg of args) {
    if (SHELL_METACHAR_RE.test(arg)) {
      throw new Error(`Blocked: argument contains shell metacharacters (;, &, |, \`, \$( or \${). Remove them and try again.`);
    }
  }
}

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

    const [windows, activeWin, monitors, cursorPos] = await Promise.all([
      getWindows(),
      getActiveWindow().catch(() => null),
      Promise.resolve(enumMonitors()),
      mouse.getPosition().catch(() => ({ x: 0, y: 0 })),
    ]);

    const activeHwnd = activeWin ? (activeWin as unknown as { windowHandle: unknown }).windowHandle : null;
    const activeTitle = activeHwnd
      ? getWindowTitleW(activeHwnd)
      : (activeWin ? await activeWin.title.catch(() => "") : "");
    const virtualScreen = getVirtualScreen();

    const CONCURRENCY = 4;
    const MAX_WINDOWS = 20;
    const usableWindows: typeof windows = [];
    for (const win of windows) {
      if (usableWindows.length >= MAX_WINDOWS) break;
      try {
        const reg = await win.region;
        if (reg.width >= 100 && reg.height >= 50) usableWindows.push(win);
      } catch { /* skip */ }
    }

    const snapshots: WindowSnapshot[] = [];
    for (let i = 0; i < usableWindows.length; i += CONCURRENCY) {
      const batch = usableWindows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((win) => buildWindowSnapshot(win, activeTitle, thumbnailMaxDimension, includeUiSummary))
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
    // Snapshot window titles before launch to detect new windows by diff
    const beforeWindows = await getWindows();
    const beforeTitles = new Set<string>();
    for (const win of beforeWindows) {
      try {
        const wh = (win as unknown as { windowHandle: unknown }).windowHandle;
        const t = wh ? getWindowTitleW(wh) : await win.title;
        if (t) beforeTitles.add(t);
      } catch { /* skip */ }
    }

    validateLaunchCommand(command, args);
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const afterWindows = await getWindows();
    let foundTitle = "";
    let foundRegion: { x: number; y: number; width: number; height: number } | null = null;

    for (const win of afterWindows) {
      try {
        const wh = (win as unknown as { windowHandle: unknown }).windowHandle;
        const t = wh ? getWindowTitleW(wh) : await win.title;
        if (!t || beforeTitles.has(t)) continue;
        const reg = await win.region;
        if (reg.width < 50 || reg.height < 50) continue;
        foundTitle = t;
        foundRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
        break;
      } catch { /* skip */ }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ launched: command, args, foundWindow: foundTitle || null, region: foundRegion }),
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
