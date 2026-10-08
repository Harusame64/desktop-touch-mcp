import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse } from "../engine/nutjs.js";
import { validateLaunchCommand, resolveLaunchExecutable, spawnDetached } from "../utils/launch.js";
import { enumMonitors, getVirtualScreen, enumWindowsInZOrder, getWindowProcessId, type WindowZInfo } from "../engine/win32.js";
import { captureScreen } from "../engine/image.js";
import { buildImageBlocks } from "./screenshot-response.js";
import { clearLayers } from "../engine/layer-buffer.js";
import { noteInvalidation } from "../engine/identity-tracker.js";
import { getUiElements, extractActionableElements, WINUI3_CLASS_RE } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBooleanWithDefault } from "./_coerce.js";
import { pollUntil } from "../engine/poll.js";
import { withRichNarration } from "./_narration.js";
import { makeCommitWrapper, makeQueryWrapper, withEnvelopeIncludeSchema, genericQueryCausedByProjector, defaultQuerySessionId } from "./_envelope.js";

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
      // "overlap": `region` is the window's own screen rect as Windows reports
      // it, which for a maximised window extends a few pixels beyond the
      // monitor (the invisible resize border) and for a window pushed off the
      // desktop edge extends further still. A thumbnail with a black strip is
      // the truthful picture of where that window is; refusing it would drop
      // the thumbnail of every maximised window instead.
      const captured = await captureScreen(region, thumbnailMaxDim, "overlap");
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
  includeUiSummary: coercedBooleanWithDefault(true).describe("Whether to include UI element summaries for each window"),
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
    noteInvalidation("workspace_snapshot");

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

    // ADR-026 §3: persist each thumbnail + return a by-ref link (ref-only —
    // workspace_snapshot is an orientation call; N inline thumbnails are the
    // heaviest token accumulator). windows[].thumbnailSize + the per-thumb label
    // stay bit-equal. R6 degrades to inline per thumbnail independently.
    const content: ToolResult["content"] = [];
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    for (const snap of snapshots) {
      // thumbnail and thumbnailSize are set/cleared together in buildWindowSnapshot
      // (same try block), so a truthy thumbnail always has a non-null size.
      if (snap.thumbnail && snap.thumbnailSize) {
        const { blocks, warning } = buildImageBlocks({
          base64: snap.thumbnail,
          mimeType: "image/png",
          width: snap.thumbnailSize.width,
          height: snap.thumbnailSize.height,
          wantInline: false,
          meta: { tag: snap.title },
          describe: (i) =>
            `Thumbnail of "${snap.title}" ${i.width}×${i.height} (${i.bytes} bytes). ` +
            `Open only if you need the pixels — the window's title/region/thumbnailSize are in the JSON above.`,
        });
        content.push(...blocks);
        content.push({ type: "text", text: `↑ "${snap.title}" ${snap.region.width}x${snap.region.height} at (${snap.region.x},${snap.region.y})` });
        if (warning) content.push({ type: "text", text: JSON.stringify({ hints: { warnings: [warning] } }) });
      }
    }

    return { content };
  } catch (err) {
    return failWith(err, "workspace_snapshot");
  }
};

/** The window workspace_launch found, as the poll saw it. */
export interface LaunchedWindow {
  title: string;
  hwnd: bigint;
  region: { x: number; y: number; width: number; height: number };
}

/**
 * The reply of workspace_launch. The description promised `{windowTitle, hwnd, pid}` while the
 * reply carried only `foundWindow` (internal #211 item 6); both are here now. `foundWindow` is the
 * same value as `windowTitle`, kept for callers that read it. Every window field is null when no
 * window was found, and `pid` is null when the owning process could not be read (0 from Win32).
 */
export function buildLaunchResult(
  launched: string,
  args: string[],
  found: LaunchedWindow | null,
  processIdOf: (hwnd: bigint) => number = getWindowProcessId,
): Record<string, unknown> {
  const pid = found ? processIdOf(found.hwnd) : 0;
  return {
    launched,
    args,
    windowTitle: found ? found.title : null,
    hwnd: found ? String(found.hwnd) : null,
    pid: pid > 0 ? pid : null,
    region: found ? found.region : null,
    foundWindow: found ? found.title : null,
  };
}

/**
 * The candidates a launch produced in one listing of the windows. Only windows with a title, not
 * minimized, and at least 50×50 count. `created` is the first (in Z-order) whose HWND was not
 * listed before the launch; `retitled` is the first already-open window whose title changed (a
 * single-instance app that retitles its existing window).
 */
export function pickLaunchedWindows(
  afterWindows: readonly WindowZInfo[],
  beforeHwnds: ReadonlySet<bigint>,
  beforeTitles: ReadonlySet<string>,
): { created: LaunchedWindow | null; retitled: LaunchedWindow | null } {
  let created: LaunchedWindow | null = null;
  let retitled: LaunchedWindow | null = null;
  for (const w of afterWindows) {
    if (!w.title) continue;
    if (w.isMinimized || w.region.width < 50 || w.region.height < 50) continue;
    const window = { title: w.title, hwnd: w.hwnd, region: w.region };
    if (!beforeHwnds.has(w.hwnd)) {
      if (created === null) created = window;
    } else if (retitled === null && !beforeTitles.has(w.title)) {
      retitled = window;
    }
  }
  return { created, retitled };
}

/**
 * Wait for the window a launch produced. A new window wins, whenever it appears within the wait;
 * an already-open window whose title changed is reported only when no new window appeared by the
 * end of it. That order matters now that the reply carries the window's hwnd and pid: a window
 * that was already open and merely retitled itself during the wait (a browser tab's timer, a
 * player) must not beat the new window the launch made, even when the retitle comes first. The
 * price is that an app which only retitles its existing window answers after the whole wait.
 */
export async function waitForLaunchedWindow(
  listWindows: () => readonly WindowZInfo[],
  beforeHwnds: ReadonlySet<bigint>,
  beforeTitles: ReadonlySet<string>,
  waitMs: number,
  intervalMs = 200,
): Promise<LaunchedWindow | null> {
  let retitled: LaunchedWindow | null = null;
  const r = await pollUntil(
    async () => {
      try {
        const picked = pickLaunchedWindows(listWindows(), beforeHwnds, beforeTitles);
        // The latest listing's answer, including none: a retitled window that has since closed or
        // taken its old title back is not reported from an earlier listing.
        retitled = picked.retitled;
        return picked.created;
      } catch {
        // enumWindowsInZOrder FFI failure — non-fatal, retry on next poll
        return null;
      }
    },
    { intervalMs, timeoutMs: waitMs }
  );
  return r.ok ? r.value : retitled;
}

export const workspaceLaunchHandler = async ({
  command, args, waitMs,
}: { command: string; args: string[]; waitMs: number }): Promise<ToolResult> => {
  try {
    // ── 1. Security validation (basename / extension / shell metachar) ──
    validateLaunchCommand(command, args);

    // ── 2. Resolve well-known + App Paths registry (chrome.exe / excel.exe /
    //      winword.exe → full path; issue #258) ─────────────────────────
    const { resolved, source } = resolveLaunchExecutable(command);
    const actualCommand = resolved;
    // Re-validate the resolved path: App Paths is user-writable, so a
    // tampered entry could otherwise smuggle a blocked shell interpreter
    // (cmd.exe, powershell.exe, ...) past the basename guard in step 1.
    // Re-running validateLaunchCommand on the resolved path catches that.
    if (source !== "identity") {
      validateLaunchCommand(actualCommand, args);
    }

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
    const found: LaunchedWindow | null =
      waitMs > 0 ? await waitForLaunchedWindow(enumWindowsInZOrder, beforeHwnds, beforeTitles, waitMs) : null;

    const result = buildLaunchResult(actualCommand, args, found);
    if (source !== "identity") {
      const via = source === "app-paths" ? " via App Paths registry" : "";
      result.note = `Resolved "${command}" → "${actualCommand}"${via}`;
    }
    if (!found && waitMs > 0) {
      result.hint =
        "No new window detected. The app may reuse an existing window (e.g. Chrome single-instance), " +
        "or it may need more time. Use workspace_snapshot to check current windows.";
    }

    return ok(result);
  } catch (err) {
    return failWith(err, "workspace_launch");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `workspace_launch` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — `leaseValidator` omitted; spawns a process without a lease
 * 4-tuple, mirroring PR #126 clipboard / PR #130 notification_show pattern
 * for OS-level commits).
 *
 * `windowTitleKey` is omitted because workspace_launch has no pre-existing
 * window-scoped target (the new window appears after the spawn).
 * `withRichNarration` falls through to `withPostState` only since `narrate`
 * isn't in the schema.
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.workspace_launch` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
export const workspaceLaunchRegistrationSchema = withEnvelopeIncludeSchema(workspaceLaunchSchema);

export const workspaceLaunchRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "workspace_launch",
    workspaceLaunchHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "workspace_launch",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `workspace_snapshot` is wrapped via `makeQueryWrapper`. PR #122 screenshot
 * 同型 pattern (read-only orientation snapshot、L1 events 不発、
 * causedByProjector 省略 fast path)。
 *
 * **A-4 retrospective caveat (Codex P2 #3、PR #144 follow-up)**:
 * `workspace_snapshot` は query 分類だが、handler 内で `clearLayers()` /
 * `noteInvalidation("workspace_snapshot")` を呼んで **screenshot diff baseline
 * (I-frame) と identity tracker を update する副作用** を持つ。読み取り専用に
 * 見えるが causal/working memory 観点では「baseline reset した操作」が
 * **不可視** で、後続の `screenshot(diffMode=true)` の挙動が `workspace_snapshot`
 * 直前と直後で変わる事実が causal trail に記録されない。
 *
 * 既知制約として **ADR-010 §11 OQ に carry-over** (本 hotfix では caveat
 * 強化のみ、本格 fix の選択肢は将来別 PR で議論):
 *   - (a) `makeCommitWrapper` 化 — Tool Surface 不変原則 (read-only orientation)
 *     を破る、scope creep
 *   - (b) `clearLayers` / `noteInvalidation` を別 explicit reset tool に分離 →
 *     workspace_snapshot は純 read-only 化
 *   - (c) Phase B Working memory に「side effect: baseline_reset」field を追加 →
 *     causal trail に副作用が visible 化
 *
 * caveat docstring (line 317 参照) も同 fact を caller (LLM) に明示済。
 */
export const workspaceSnapshotRegistrationSchema = withEnvelopeIncludeSchema(workspaceSnapshotSchema);

export const workspaceSnapshotRegistrationHandler = makeQueryWrapper(
  workspaceSnapshotHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "workspace_snapshot",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export function registerWorkspaceTools(server: McpServer): void {
  server.tool(
    "workspace_snapshot",
    buildDesc({
      purpose: "Orient fully in one call — returns display layouts, all window thumbnails (WebP), and per-window actionable element lists with clickAt coords.",
      details: "uiSummary.actionable[] per window includes: action ('click'|'type'|'expand'|'select'), clickAt {x,y} (pass directly to mouse_click), value (current text for editable fields). Runs parallel internally; latency ≈ max(single screenshot), not N×screenshots. Also resets the diffMode buffer so subsequent screenshot(diffMode=true) returns only changes (P-frame).",
      prefer: "Use at session start or after major workspace changes. Use screenshot(detail='meta') for cheap re-orientation within a session. Use screenshot(detail='text', windowTitle=X) for a single-window update.",
      caveats: "Thumbnails are scaled, not 1:1 — use screenshot(dotByDot=true, windowTitle=X) for pixel-accurate coords on a specific window after snapshot. Also: this call resets the screenshot diff baseline (I-frame) and identity tracker as a side effect, so subsequent screenshot(diffMode=true) starts fresh from this snapshot. The reset is not currently exposed in causal/working memory — record an explicit 'workspace_snapshot' step if you need to track the reset point in your causal trail (ADR-010 §11 OQ carry-over for full visibility).",
    }),
    workspaceSnapshotRegistrationSchema,
    workspaceSnapshotRegistrationHandler as typeof workspaceSnapshotHandler
  );

  server.tool(
    "workspace_launch",
    buildDesc({
      purpose: "Launch an application and wait for its window to appear, returning the window's title, HWND, and PID.",
      details: "Starts the executable (well-known names and App Paths entries resolve to a full path), lists the top-level windows before the launch, then checks every 200 ms, for up to waitMs, for a window whose HWND was not there before or whose title changed. Returns {launched, args, windowTitle, hwnd, pid, region, foundWindow}; the window fields are null when no window appeared in time, and a hint says why. foundWindow is the same as windowTitle, kept for older callers. Works for localized window titles (e.g. '電卓' for calc.exe) because detection is HWND-based. waitMs default 2000, max 30000; waitMs:0 returns right after the launch with the window fields null.",
      prefer: "Use instead of run_macro({exec, sleep, desktop_discover}) combos. Follow with desktop_discover({target:{hwnd}}) using the returned hwnd, which names this window even when another has a similar title (or focus_window(windowTitle)).",
      caveats: "Single-instance apps that reuse an existing window will not register as a new HWND — call desktop_discover first to check if the window is already open. Minimized windows and windows smaller than 50×50 are not reported. When no new window appears within waitMs, an already-open window whose title changed during the wait is reported instead, which may not be the launched app; such an app (one that only retitles its existing window) answers after the whole waitMs. pid is the process that owns the window, which can differ from the one launched (an app that hands off to another process).",
      examples: [
        "workspace_launch({command:'notepad.exe'}) → {windowTitle:'<localized title>', hwnd:'...', pid:...}",
        "workspace_launch({command:'calc.exe', waitMs:15000})",
      ],
    }),
    workspaceLaunchRegistrationSchema,
    workspaceLaunchRegistrationHandler as typeof workspaceLaunchHandler
  );
}
