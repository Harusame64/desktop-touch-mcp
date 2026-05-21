import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDesc } from "./_types.js";
import type { ToolHandler, ToolResult } from "./_types.js";
import { failCode } from "./_errors.js";
import { checkFailsafe } from "../utils/failsafe.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import {
  makeCommitWrapper,
  withEnvelopeIncludeSchema,
  defaultQuerySessionId,
} from "./_envelope.js";
import { isToolDestructive } from "./_tool-flags.js";
import { macroOutcomeStore } from "../store/macro-outcome-store.js";
import { coercedBoolean } from "./_coerce.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: TOOL_REGISTRY mirrors the v1.0.0 public surface — privatized tools
// (events_*, perception_*, mouse_move, get_history, get_*) are intentionally
// absent. Family dispatchers (keyboard / clipboard / window_dock / scroll /
// terminal / browser_eval) replace their pre-Phase-2 sub-tool entries.
// ─────────────────────────────────────────────────────────────────────────────

// Screenshot
import {
  screenshotHandler,
  screenshotRegistrationHandler,
  screenshotRegistrationSchema,
} from "./screenshot.js";
// Mouse
import {
  mouseClickHandler, mouseClickRegistrationSchema, mouseClickRegistrationHandler,
  mouseDragHandler, mouseDragRegistrationSchema, mouseDragRegistrationHandler,
} from "./mouse.js";
// Keyboard dispatcher (Phase 2)
import { keyboardHandler, keyboardRegistrationSchema, keyboardRegistrationHandler } from "./keyboard.js";
// Clipboard dispatcher (Phase 2)
import { clipboardHandler, clipboardRegistrationSchema, clipboardRegistrationHandler } from "./clipboard.js";
// Window
import {
  focusWindowHandler,
  focusWindowRegistrationSchema,
  focusWindowRegistrationHandler,
  // V1 fallback (only reachable when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1).
  getWindowsHandler, getWindowsSchema,
} from "./window.js";
// Window dock dispatcher (Phase 2)
import {
  windowDockHandler,
  windowDockRegistrationSchema,
  windowDockRegistrationHandler,
} from "./window-dock.js";
// UI elements (click_element always public after Phase 4; the next two are
// V1 fallbacks only reachable when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1).
import {
  clickElementHandler, clickElementRegistrationSchema, clickElementRegistrationHandler,
  getUiElementsHandler, getUiElementsSchema,
  setElementValueHandler, setElementValueSchema,
} from "./ui-elements.js";
// Workspace
import {
  workspaceSnapshotHandler,
  workspaceSnapshotRegistrationSchema,
  workspaceSnapshotRegistrationHandler,
  workspaceLaunchHandler,
  workspaceLaunchRegistrationSchema,
  workspaceLaunchRegistrationHandler,
} from "./workspace.js";
// Scroll dispatcher (Phase 2)
import {
  scrollDispatchHandler,
  scrollRegistrationSchema,
  scrollRegistrationHandler,
} from "./scroll.js";
// Wait until
import {
  waitUntilHandler,
  waitUntilRegistrationSchema,
  waitUntilRegistrationHandler,
} from "./wait-until.js";
// Desktop state
import {
  desktopStateRegistrationHandlerWithIncludeRoute,
  desktopStateRegistrationSchema,
} from "./desktop-state.js";
// Terminal dispatcher (Phase 2)
import {
  terminalDispatchHandler,
  terminalRegistrationSchema,
  terminalRegistrationHandler,
} from "./terminal.js";
// Browser tools (Phase 3)
import {
  browserOpenHandler,
  browserOpenRegistrationSchema,
  browserOpenRegistrationHandler,
  browserEvalHandler,
  browserEvalRegistrationSchema,
  browserEvalRegistrationHandler,
  browserSearchHandler,
  browserSearchRegistrationSchema,
  browserSearchRegistrationHandler,
  browserGetInteractiveHandler,
  browserOverviewRegistrationSchema,
  browserOverviewRegistrationHandler,
  browserFindElementHandler,
  browserLocateRegistrationSchema,
  browserLocateRegistrationHandler,
  browserClickElementHandler,
  browserClickRegistrationSchema,
  browserClickRegistrationHandler,
  browserNavigateHandler,
  browserNavigateRegistrationSchema,
  browserNavigateRegistrationHandler,
  browserFillInputHandler,
  browserFillRegistrationSchema,
  browserFillRegistrationHandler,
  browserGetFormHandler,
  browserFormRegistrationSchema,
  browserFormRegistrationHandler,
} from "./browser.js";
// Notification (server_status not callable from macros — diagnostic)
import {
  notificationShowHandler,
  notificationShowRegistrationSchema,
  notificationShowRegistrationHandler,
} from "./notification.js";
// v2 World-Graph dispatchers (Phase 4 / Codex PR #41 P1): the public surface
// for discovery and lease-based action; macros need access to use the
// action='setValue' / 'click' / 'type' flow advertised in the schema.
import {
  desktopDiscoverRegistrationSchema,
  desktopDiscoverRegistrationHandler,
  desktopActRegistrationSchema,
  desktopActRegistrationHandler,
} from "./desktop-register.js";
import { resolveV2Activation } from "./desktop-activation.js";

/**
 * Phase 4 (Codex PR #41 round 3 P1): the v2 World-Graph dispatchers
 * registered above must honour the same DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1
 * kill switch that gates the top-level registerDesktopTools registration.
 * Without this gate, run_macro provides an alternate execution path that
 * silently re-enables v2 even when the operator has opted out.
 */
function v2KillSwitchActive(): boolean {
  return !resolveV2Activation(process.env).enabled;
}

function v2DisabledError(): ToolResult {
  return failCode(
    "FukuwaraiV2Disabled",
    "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 is set; v2 World-Graph tools (desktop_discover / desktop_act) are disabled and may not be invoked through run_macro either.",
    {
      suggest: [
        "Unset DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2 (or set it to 0) and restart the MCP server to use desktop_discover / desktop_act.",
      ],
    }
  );
}

/**
 * Phase 4 (Codex PR #41 round 6 P1×2): the v1 fallback tools registered
 * publicly only when v2 is killed. Macros mirror that surface — these
 * entries are ONLY callable when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 is
 * set; otherwise they return a v2-mode replacement hint.
 */
function v1FallbackOnlyError(tool: string, replacement: string): ToolResult {
  return failCode(
    "V1FallbackUnavailable",
    `${tool} is a V1 fallback only available when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 is set. In v2 mode use ${replacement}.`,
    { suggest: [`Use the v2 tool instead: ${replacement}`] }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────────────────────────────────────

interface ToolEntry {
  // Phase 4: widened from z.ZodObject to z.ZodTypeAny so dispatchers backed by
  // z.discriminatedUnion (keyboard / clipboard / window_dock / scroll /
  // terminal / browser_eval) can be parsed via .parse() the same way.
  schema: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: ToolHandler<any>;
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  // Observation
  // PR #112 Round 1 P1 (Opus P1-1): use module-scope schema + handler
  // from desktop-state.ts so `include` survives this dispatcher's
  // `z.object(schema).parse(args)` call. Without this, `run_macro({tool:
  // "desktop_state", args:{include:["envelope"]}})` would silently strip
  // include — same-pattern bug as the server.tool registration path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desktop_state:        { schema: z.object(desktopStateRegistrationSchema), handler: desktopStateRegistrationHandlerWithIncludeRoute as any },
  // Walking skeleton expansion swimlane 2 (L5 query wrapper): use the
  // module-scope schema + handler from screenshot.ts so `include` survives
  // this dispatcher's `z.object(schema).parse(args)` call. Without this,
  // `run_macro({tool:"screenshot", args:{include:["envelope"]}})` would
  // silently strip include — same-pattern bug as PR #112 desktop_state path.
  screenshot:           { schema: z.object(screenshotRegistrationSchema), handler: screenshotRegistrationHandler as typeof screenshotHandler },
  // Action — native
  mouse_click:          { schema: z.object(mouseClickRegistrationSchema), handler: mouseClickRegistrationHandler as typeof mouseClickHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from mouse.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  mouse_drag:           { schema: z.object(mouseDragRegistrationSchema), handler: mouseDragRegistrationHandler as typeof mouseDragHandler },
  click_element:        { schema: z.object(clickElementRegistrationSchema), handler: clickElementRegistrationHandler as typeof clickElementHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from window.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  focus_window:         { schema: z.object(focusWindowRegistrationSchema), handler: focusWindowRegistrationHandler as typeof focusWindowHandler },
  // Action — text/clipboard dispatchers (Phase 2)
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from keyboard.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  keyboard:             { schema: keyboardRegistrationSchema,          handler: keyboardRegistrationHandler as typeof keyboardHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from clipboard.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  clipboard:            { schema: clipboardRegistrationSchema,         handler: clipboardRegistrationHandler as typeof clipboardHandler },
  // Action — window/scroll/terminal dispatchers (Phase 2)
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from window-dock.ts so run_macro 経路は
  // server.registerTool 経路と同 instance を共有 (PR #112 shared registration
  // handler pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  window_dock:          { schema: windowDockRegistrationSchema,         handler: windowDockRegistrationHandler as typeof windowDockHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from scroll.ts so run_macro 経路は
  // server.registerTool 経路と同 instance を共有 (PR #112 shared registration
  // handler pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  scroll:               { schema: scrollRegistrationSchema,             handler: scrollRegistrationHandler as typeof scrollDispatchHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from terminal.ts so run_macro 経路は
  // server.registerTool 経路と同 instance を共有 (PR #112 shared registration
  // handler pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  terminal:             { schema: terminalRegistrationSchema,           handler: terminalRegistrationHandler as typeof terminalDispatchHandler },
  // Action — browser (Phase 3)
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_open:         { schema: z.object(browserOpenRegistrationSchema), handler: browserOpenRegistrationHandler as typeof browserOpenHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper、discriminatedUnion):
  // use the module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.registerTool 経路と同 instance を共有 (PR #112 shared registration
  // handler pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_eval:         { schema: browserEvalRegistrationSchema,         handler: browserEvalRegistrationHandler as typeof browserEvalHandler },
  // Walking skeleton expansion swimlane 2 (L5 query wrapper): use the
  // module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_search:       { schema: z.object(browserSearchRegistrationSchema), handler: browserSearchRegistrationHandler as typeof browserSearchHandler },
  browser_overview:     { schema: z.object(browserOverviewRegistrationSchema), handler: browserOverviewRegistrationHandler as typeof browserGetInteractiveHandler },
  browser_locate:       { schema: z.object(browserLocateRegistrationSchema), handler: browserLocateRegistrationHandler as typeof browserFindElementHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_click:        { schema: z.object(browserClickRegistrationSchema), handler: browserClickRegistrationHandler as typeof browserClickElementHandler },
  browser_navigate:     { schema: z.object(browserNavigateRegistrationSchema), handler: browserNavigateRegistrationHandler as typeof browserNavigateHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_fill:         { schema: z.object(browserFillRegistrationSchema), handler: browserFillRegistrationHandler as typeof browserFillInputHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from browser.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  browser_form:         { schema: z.object(browserFormRegistrationSchema), handler: browserFormRegistrationHandler as typeof browserGetFormHandler },
  // Workspace / wait / notification
  // Walking skeleton expansion swimlane 2 (L5 query wrapper): use the
  // module-scope wrapped handler from workspace.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  workspace_snapshot:   { schema: z.object(workspaceSnapshotRegistrationSchema), handler: workspaceSnapshotRegistrationHandler as typeof workspaceSnapshotHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from workspace.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  workspace_launch:     { schema: z.object(workspaceLaunchRegistrationSchema), handler: workspaceLaunchRegistrationHandler as typeof workspaceLaunchHandler },
  // Walking skeleton expansion swimlane 2 (L5 query wrapper): use the
  // module-scope wrapped handler from wait-until.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  wait_until:           { schema: z.object(waitUntilRegistrationSchema), handler: waitUntilRegistrationHandler as typeof waitUntilHandler },
  // Walking skeleton expansion swimlane 1 (L5 commit wrapper): use the
  // module-scope wrapped handler from notification.ts so run_macro 経路は
  // server.tool 経路と同 instance を共有 (PR #112 shared registration handler
  // pattern, strip risk 防止)。`include` per-call envelope opt-in も自動波及。
  notification_show:    { schema: z.object(notificationShowRegistrationSchema), handler: notificationShowRegistrationHandler as typeof notificationShowHandler },
  // v2 World-Graph (default-on; kill switch DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1).
  // Both handlers re-check the kill switch on every call so run_macro cannot
  // bypass the operator's opt-out. (Codex PR #41 round 3 P1.)
  //
  // ADR-010 P1 S4 (sub-plan §2.5 + §3.3): use the module-scope wrapped
  // handlers + injected schemas from `desktop-register.ts` so this
  // dispatcher honours the same envelope / commit-wrapper contract as
  // the direct `server.tool` registration path. Without this, run_macro
  // 経路は `args.include` を strip してしまい per-call envelope opt-in が
  // 機能不能 (PR #112 P1-1 / PR #97 同型 risk pattern). Kill-switch
  // gating runs BEFORE the wrapper invocation so the wrapper never
  // emits ToolCall events for blocked calls.
  desktop_discover:     {
    schema: z.object(desktopDiscoverRegistrationSchema),
    handler: (async (input: Record<string, unknown>): Promise<ToolResult> => {
      if (v2KillSwitchActive()) {
        return v2DisabledError();
      }
      // The wrapped handler returns the looser `McpToolResult` shape
      // (`_envelope.ts`); the runtime content blocks are bit-equal with
      // the strict `ToolResult` discriminated union, so the cast is
      // safe — only the structural narrowing differs.
      return (await desktopDiscoverRegistrationHandler(input)) as ToolResult;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  },
  desktop_act:          {
    schema: z.object(desktopActRegistrationSchema),
    handler: (async (input: Record<string, unknown>): Promise<ToolResult> => {
      if (v2KillSwitchActive()) {
        return v2DisabledError();
      }
      return (await desktopActRegistrationHandler(input)) as ToolResult;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  },
  // V1 fallback macros — only callable when v2 is killed (mirrors the
  // server-windows.ts kill-switch fallback). In v2 mode these short-circuit
  // with a v2 replacement hint. (Codex PR #41 round 6 P1×2.)
  get_windows: {
    schema: z.object(getWindowsSchema),
    handler: async (): Promise<ToolResult> => {
      if (!v2KillSwitchActive()) {
        return v1FallbackOnlyError("get_windows", "desktop_discover.windows[]");
      }
      return getWindowsHandler();
    },
  },
  get_ui_elements: {
    schema: z.object(getUiElementsSchema),
    handler: async (input: unknown): Promise<ToolResult> => {
      if (!v2KillSwitchActive()) {
        return v1FallbackOnlyError("get_ui_elements", "desktop_discover.entities[]");
      }
      return getUiElementsHandler(input as Parameters<typeof getUiElementsHandler>[0]);
    },
  },
  set_element_value: {
    schema: z.object(setElementValueSchema),
    handler: async (input: unknown): Promise<ToolResult> => {
      if (!v2KillSwitchActive()) {
        return v1FallbackOnlyError("set_element_value", "desktop_act({action:'setValue', lease, text})");
      }
      return setElementValueHandler(input as Parameters<typeof setElementValueHandler>[0]);
    },
  },
  // run_macro is intentionally excluded → prevents recursion
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema & Handler
// ─────────────────────────────────────────────────────────────────────────────

export const runMacroSchema = {
  steps: z
    .array(
      z.object({
        tool: z.string().describe(
          `Tool name to call. One of: ${Object.keys(TOOL_REGISTRY).join(", ")}, or the special pseudo-command "sleep".`
        ),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Parameters for the tool (same as calling it directly). Omit for tools with no params."),
      })
    )
    .min(1)
    .max(50)
    .describe("Ordered list of tool calls to execute sequentially (max 50 steps)."),
  stop_on_error: coercedBoolean()
    .default(true)
    .describe("Stop execution on the first error (default true). Set false to collect all results."),
};

export const runMacroHandler = async ({
  steps,
  stop_on_error,
}: {
  steps: Array<{ tool: string; params: Record<string, unknown> }>;
  stop_on_error: boolean;
}): Promise<ToolResult> => {
  type StepResult = {
    step: number;
    tool: string;
    ok: boolean;
    text?: string[];
    error?: string;
    code?: string;
    _images?: Array<{ data: string; mimeType: string }>;
  };

  const results: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const { tool, params } = steps[i]!;

    // Prevent recursion
    if (tool === "run_macro") {
      results.push({ step: i, tool, ok: false, error: "run_macro cannot be called inside run_macro" });
      if (stop_on_error) break;
      continue;
    }

    // Handle sleep pseudo-command
    if (tool === "sleep") {
      const ms = Math.min(Math.max(Number(params["ms"]) || 0, 0), 10000);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      results.push({ step: i, tool, ok: true, text: [`slept ${ms}ms`] });
      continue;
    }

    const entry = TOOL_REGISTRY[tool];
    if (!entry) {
      results.push({ step: i, tool, ok: false, error: `Unknown tool: "${tool}"` });
      if (stop_on_error) break;
      continue;
    }

    try {
      // Failsafe pre-check before each step
      await checkFailsafe();

      // Block dangerous key combos inside macros (Phase 4: keyboard dispatcher
      // with action='press'; pre-Phase-2 keyboard_press is no longer registered).
      if (
        tool === "keyboard" &&
        params["action"] === "press" &&
        typeof params["keys"] === "string"
      ) {
        assertKeyComboSafe(params["keys"]);
      }
      // Issue #257: keyboard(action='sequence') stores keys inside
      // params.steps[].keys — extend the macro-level safety scan so blocked
      // combos cannot slip in via the sequence schema. Iterate defensively
      // (the Zod parse one line below will reject malformed shapes, but the
      // assertKeyComboSafe SUGGESTS recovery hint is more actionable than
      // a raw Zod error when the LLM tried to wedge a `win+r` into a step).
      if (
        tool === "keyboard" &&
        params["action"] === "sequence" &&
        Array.isArray(params["steps"])
      ) {
        for (const rawStep of params["steps"] as Array<unknown>) {
          const keys = (rawStep as { keys?: unknown } | null)?.keys;
          if (typeof keys === "string") {
            assertKeyComboSafe(keys);
          }
        }
      }

      const validated = entry.schema.parse(params);
      const result = await entry.handler(validated);

      const textLines: string[] = [];
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const block of result.content) {
        if (block.type === "text") textLines.push(block.text);
        else if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
      }

      // Phase 7 F1 fix (matrix §3.1 line 157 規範整合): parse the first text
      // block (= the immediately preceding `entry.handler` call's first
      // content block) to detect inner failure envelopes. Tools normalize
      // their response to JSON `{ok: boolean, ...}` (see `_types.ts`
      // ToolFailure / ToolSuccess shapes). When a step's handler returns an
      // ok:false envelope without throwing, the macro must surface that
      // failure at the step level so `stop_on_error: true` can halt as
      // documented. Without this, `run_macro({stop_on_error:true})` would
      // silently continue past a failed tool — silent-success regression
      // caught by Phase 6 dogfood (`docs/llm-audit/phase6-dogfood-findings.md`
      // F1, `dogfood-scenarios/launcher-macro.md` §2.1).
      let stepOk = true;
      let innerCode: string | undefined;
      let innerError: string | undefined;
      if (textLines.length > 0) {
        try {
          const parsed = JSON.parse(textLines[0]!);
          if (parsed && typeof parsed === "object" && parsed.ok === false) {
            stepOk = false;
            innerCode = typeof parsed.code === "string" ? parsed.code : undefined;
            innerError = typeof parsed.error === "string" ? parsed.error : undefined;
          }
        } catch {
          // Non-JSON text block (e.g. screenshot detail='text' raw output) —
          // treat as success. Failure paths always emit JSON envelopes per
          // _types.ts contract.
        }
      }

      // Round 1 P2-2 fix: when inner envelope lacks both `error` and `code`
      // string fields (regulation-violating tool, defensive only), point the
      // caller at `text[0]` so they can recover useful info rather than
      // surfacing a hollow `"inner ok:false"`.
      const fallbackError = (() => {
        if (innerError) return innerError;
        if (innerCode) return innerCode;
        return "inner ok:false (no error/code fields, see step.text[0])";
      })();

      results.push({
        step: i,
        tool,
        ok: stepOk,
        text: textLines,
        ...(stepOk
          ? {}
          : {
              error: fallbackError,
              ...(innerCode ? { code: innerCode } : {}),
            }),
        ...(images.length > 0 ? { _images: images } : {}),
      });

      if (!stepOk && stop_on_error) break;
    } catch (err) {
      results.push({ step: i, tool, ok: false, error: String(err) });
      if (stop_on_error) break;
    }
  }

  // ADR-011 Phase B B-4: record macro outcome (Phase B plan §10 OQ #8 (a)
  // tool registry flag 採用、`isToolDestructive` で軽量走査、suggest filter
  // (success>=3 + failure==0 + no destructive) で安全候補のみ後続 query で
  // expose)。inner step が 1 つでも destructive なら `containsDestructive=true`
  // で記録、`projectProceduralMemory` 経路で expose 対象から構造的に skip。
  // sleep 等の pseudo-command は destructive 扱い (registry に entry 無い
  // → `isToolDestructive` 戻り値 true、fail-safe inversion)。
  //
  // **Round 2 P2-1 fix (sentinel session guard)**: A-4 hotfix と同型 regression
  // 防止。multi-session deploy で `multi:disabled` sentinel が active な場合は
  // store 汚染 (cross-session leak via global LRU) を避けるため recordOutcome
  // skip。store は Plan §10 OQ #3 Resolved per design = global cross-session
  // shared だが、sentinel session の operator action は LLM expose 経路で
  // sentinel skip 対象なので、record する意味も無い。
  const sessionIdForRecord = defaultQuerySessionId(undefined);
  if (sessionIdForRecord !== "multi:disabled") {
    const stepTools = steps.map((s) => s.tool);
    const allOk =
      results.length === steps.length && results.every((r) => r.ok);
    const containsDestructive = stepTools.some((t) => isToolDestructive(t));
    macroOutcomeStore.recordOutcome({
      tools: stepTools,
      success: allOk,
      containsDestructive,
    });
  }

  // Build final content
  const content: ToolResult["content"] = [];

  // Phase 7 F2 fix (`docs/llm-audit/phase6-dogfood-findings.md`): surface
  // nested step failures at the macro top level so callers using
  // `stop_on_error: false` can detect partial failures without parsing each
  // `text[0]` block. `warnings[]` aggregates {step, tool, code?, error?}
  // for every step where ok:false.
  //
  // Shape contract (Round 1 P2-3 明文化): `error` is always present (catch
  // path emits `String(err)`; inner path uses `parsed.error ?? parsed.code
  // ?? fallback`). `code` is only present when the inner envelope carried
  // a `code: string` field — recursion / unknown-tool / Zod-throw / catch
  // paths produce `code`-less warning entries. Callers should treat
  // `warning.code` as optional and rely on `warning.error` (always
  // present) for messaging.
  const warnings = results
    .filter((r) => !r.ok)
    .map((r) => ({
      step: r.step,
      tool: r.tool,
      ...(r.code ? { code: r.code } : {}),
      ...(r.error ? { error: r.error } : {}),
    }));

  // Summary JSON (no base64 blobs in the text block)
  const summary = {
    steps_total: steps.length,
    steps_completed: results.length,
    results: results.map(({ _images: _img, ...r }) => r),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  content.push({ type: "text", text: JSON.stringify(summary, null, 2) });

  // Append image blocks from screenshot steps
  for (const r of results) {
    if (r._images) {
      for (const img of r._images) {
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        content.push({ type: "text", text: `[step ${r.step}: ${r.tool}]` });
      }
    }
  }

  return { content };
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `run_macro` is wrapped via `makeCommitWrapper` (lease-less commit variant)。
 * Macro orchestration 自体を一つの commit event として L1 に記録 — 結果として
 * N step macro 1 回で **N+1 個** の L1 event が発行される (outer = run_macro
 * orchestration boundary marker、inner = 各 step の wrapped handler が発行)。
 * outer event は「run_macro が呼ばれて完了した」事実 + summary を保持し、
 * step 単位の詳細は inner event 群に委ねる重畳構造。
 *
 * ADR-011 A-3 (compound commit boundary): `isCompoundBoundary: true` で
 * 配線済 — outer run_macro event は history ring の `evictOldestNonBoundary`
 * で FIFO eviction 対象外、長 macro でも orchestration boundary が ring 内
 * preserved され、`desktop_state(include=causal).caused_by.your_last_action`
 * は outer run_macro event を anchor として返す (最終 step に collapse
 * しない)。`buildBasedOn.events` も同型で outer event_id を anchor とする
 * (helper `selectLastEventForCausalProjection` 共有、`_envelope.ts`)。
 *
 * 注意: `HISTORY_BUFFER_CAPACITY = 8` 維持下で boundary 1 件保護分の
 * effective capacity = 7 (= 9-step macro で outer 1 + step 7 = 8 ring 充填、
 * 後続 step が乗り切らない場合は **古い step が FIFO evict**、boundary は
 * skip)。複数同時 outer (本 plan non-goal、現行 `TOOL_REGISTRY` から
 * run_macro 除外で発生不可、line 「run_macro is intentionally excluded」+
 * runtime guard 参照) では `evictOldestNonBoundary` の degraded fallback
 * (旧 FIFO) で動作。
 *
 * windowTitleKey 省略 (run_macro は steps[].params.windowTitle を見ないため
 * orchestration level では window target なし)。
 *
 * Module-scope export — run_macro 自体は `TOOL_REGISTRY` から除外
 * (recursion 防止、macro.ts 内 line 「run_macro is intentionally excluded →
 * prevents recursion」参照) のため、shared instance 共有は不要。
 */
export const runMacroRegistrationSchema = withEnvelopeIncludeSchema(runMacroSchema);

export const runMacroRegistrationHandler = makeCommitWrapper(
  runMacroHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "run_macro",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
    // ADR-011 A-3: outer orchestration event を boundary preserved にする
    isCompoundBoundary: true,
  },
);

export function registerMacroTools(server: McpServer): void {
  server.tool(
    "run_macro",
    buildDesc({
      purpose: "Execute multiple tools sequentially in one MCP call — eliminates round-trip latency for predictable multi-step workflows.",
      details: "steps[] is an array of {tool, params} objects. Accepts all desktop-touch tools plus a special sleep pseudo-step: {tool:\"sleep\", params:{ms:N}} (max 10000ms per step). stop_on_error=true (default) halts on first failure. Max 50 steps. The LLM cannot inspect intermediate results during execution — all steps run to completion (or first error) before any output is returned.",
      prefer: "Use for predictable fixed sequences (focus → sleep → type → screenshot). Do not use for conditional logic — return to the LLM between branches so it can inspect intermediate state.",
      caveats: "If any step may fail conditionally (e.g. a dialog that may or may not appear), split the macro at that point. Each screenshot step within a macro incurs the same token cost as a standalone call.",
      examples: [
        "[{tool:'focus_window',params:{windowTitle:'Notepad'}},{tool:'sleep',params:{ms:300}},{tool:'keyboard',params:{action:'type',text:'Hello'}},{tool:'screenshot',params:{detail:'text',windowTitle:'Notepad'}}]",
        "[{tool:'browser_navigate',params:{url:'https://example.com'}},{tool:'wait_until',params:{condition:'element_matches',target:{by:'text',pattern:'Example Domain'}}}]",
      ],
    }),
    runMacroRegistrationSchema,
    runMacroRegistrationHandler as typeof runMacroHandler
  );
}
