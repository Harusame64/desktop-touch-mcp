import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { mouse } from "../engine/nutjs.js";
import { isExecutableAllowlisted } from "../utils/launch-config.js";
import { enumMonitors, getVirtualScreen, enumWindowsInZOrder, type WindowZInfo } from "../engine/win32.js";
import { captureScreen } from "../engine/image.js";
import { clearLayers } from "../engine/layer-buffer.js";
import { getUiElements, extractActionableElements } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";

/** Chromium-based browser windows — UIA traversal is prohibitively slow on these */
const CHROMIUM_TITLE_RE = /- (?:Google Chrome|Microsoft Edge|Brave|Opera|Vivaldi|Arc|Chromium)$/;

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
// Well-known browser path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Map of bare executable names to candidate full paths (checked in order). */
const WELL_KNOWN_PATHS: Record<string, string[]> = {
  "chrome.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ],
  "msedge.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
  ],
  "brave.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(process.env["LOCALAPPDATA"] ?? "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  ],
  "code.exe": [
    path.join(process.env["LOCALAPPDATA"] ?? "", "Programs\\Microsoft VS Code\\Code.exe"),
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft VS Code\\Code.exe"),
  ],
};

/**
 * If `command` is a bare executable name (no path separator) and matches a
 * well-known browser/tool, return the first existing full path.
 * Otherwise return the original command unchanged.
 */
function resolveWellKnownPath(command: string): { resolved: string; wasResolved: boolean } {
  // Only resolve bare names — if user supplied a full path, trust it
  if (command.includes("\\") || command.includes("/")) {
    return { resolved: command, wasResolved: false };
  }
  const key = command.toLowerCase();
  const candidates = WELL_KNOWN_PATHS[key];
  if (!candidates) return { resolved: command, wasResolved: false };

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { resolved: candidate, wasResolved: true };
      }
    } catch { /* ignore */ }
  }
  return { resolved: command, wasResolved: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn with reliable error detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a detached process and wait until we know it has started successfully
 * or failed. Uses a Promise that resolves on first `spawn` event (success)
 * or rejects on `error` event (ENOENT, EACCES, etc.).
 *
 * This is strictly better than the setTimeout(50ms) pattern because:
 * - The `spawn` event fires synchronously when the OS succeeds — no race.
 * - The `error` event fires on the next tick for ENOENT — caught deterministically.
 * - No arbitrary delay that could be too short or too long.
 */
function spawnDetached(
  command: string,
  args: string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });

    const cleanup = () => {
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
    };

    child.on("spawn", () => {
      cleanup();
      child.unref();
      resolve();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      // Build a helpful error message based on the error code
      let hint = "";
      if (err.code === "ENOENT") {
        hint = `Command "${command}" not found. Provide the full path (e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").`;
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        hint = `Permission denied for "${command}". Check that the file is executable and not blocked by policy.`;
      } else {
        hint = `spawn failed for "${command}": ${err.message}`;
      }
      reject(new Error(hint));
    });
  });
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

    // enumWindowsInZOrder() is a single synchronous Win32 EnumWindows sweep that
    // collects title, region, z-order, active state in one pass — far faster than
    // nut-js getWindows() which requires a separate async call per window property.
    const [monitors, cursorPos] = await Promise.all([
      Promise.resolve(enumMonitors()),
      mouse.getPosition().catch(() => ({ x: 0, y: 0 })),
    ]);

    const allWindows = enumWindowsInZOrder();
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
