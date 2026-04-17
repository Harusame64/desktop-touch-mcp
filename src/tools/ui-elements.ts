import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUiElements, clickElement, setElementValue, getElementBounds, getElementChildren } from "../engine/uia-bridge.js";
import { captureScreen } from "../engine/image.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";
import { withRichNarration, narrateParam } from "./_narration.js";
import { buildHintsForTitle } from "../engine/identity-tracker.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getUiElementsSchema = {
  windowTitle: z.string().max(200).describe("Partial window title to find the target window"),
  maxDepth: z.coerce.number().int().min(1).max(8).default(4).describe("Maximum depth of the element tree to traverse (default 4)"),
  maxElements: z.coerce.number().int().min(1).max(200).default(80).describe("Maximum number of elements to return (default 80)"),
};

export const clickElementSchema = {
  windowTitle: z.string().max(200).describe("Partial window title of the target window"),
  name: z.string().max(200).optional().describe("Element name/label (partial match, case-insensitive)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
  controlType: z.string().max(100).optional().describe("Control type filter, e.g. 'Button', 'MenuItem'"),
  narrate: narrateParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget, target.identityStable) are evaluated before clicking, " +
    "and a perception envelope is attached to post.perception on success."
  ),
  fixId: z.string().optional().describe("Approve a pending suggestedFix (one-shot, 15s TTL)."),
};

export const setElementValueSchema = {
  windowTitle: z.string().max(200).describe("Partial window title"),
  value: z.string().max(10000).describe("The value to set"),
  name: z.string().max(200).optional().describe("Element name/label (partial match)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
  narrate: narrateParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget, target.identityStable) are evaluated before setting, " +
    "and a perception envelope is attached to post.perception on success."
  ),
};

export const scopeElementSchema = {
  windowTitle: z.string().max(200).describe("Partial window title of the target window"),
  name: z.string().max(200).optional().describe("Element name/label (partial match, case-insensitive)"),
  automationId: z.string().max(200).optional().describe("Exact AutomationId of the element"),
  controlType: z.string().max(100).optional().describe("Control type filter, e.g. 'Edit', 'Button', 'List'"),
  maxDepth: z.coerce.number().int().min(1).max(6).default(2).describe("Child element tree depth (default 2)"),
  maxElements: z.coerce.number().int().min(1).max(100).default(30).describe("Max child elements (default 30)"),
  padding: z.coerce.number().int().min(0).max(100).default(10).describe("Padding in pixels around the element in the screenshot (default 10)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const getUiElementsHandler = async ({
  windowTitle, maxDepth, maxElements,
}: { windowTitle: string; maxDepth: number; maxElements: number }): Promise<ToolResult> => {
  try {
    const hintsBlock = buildHintsForTitle(windowTitle);
    const result = await getUiElements(windowTitle, maxDepth, maxElements, 10000, {
      hwnd: hintsBlock?.hwnd, cached: false,
    });
    const enriched = hintsBlock
      ? { ...result, hints: { target: hintsBlock.target, caches: hintsBlock.caches } }
      : result;
    return ok(enriched, true);
  } catch (err) {
    return failWith(err, "get_ui_elements", { windowTitle });
  }
};

export const clickElementHandler = async ({
  windowTitle, name, automationId, controlType, lensId, fixId,
}: { windowTitle: string; name?: string; automationId?: string; controlType?: string; lensId?: string; fixId?: string }): Promise<ToolResult> => {
  // Phase G: fixId approval prologue (declared outside try for catch block visibility)
  let effectiveWindowTitle = windowTitle;
  let effectiveName = name;
  let effectiveAutomationId = automationId;
  try {
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "click_element");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "click_element");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      if (typeof vr.fix.args.name === "string") effectiveName = vr.fix.args.name;
      if (typeof vr.fix.args.automationId === "string") effectiveAutomationId = vr.fix.args.automationId;
      consumeFix(fixId);  // consume before executing
    }

    if (!effectiveName && !effectiveAutomationId) {
      return failArgs("Provide at least one of: name, automationId", "click_element", { windowTitle: effectiveWindowTitle });
    }

    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "click_element", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "click_element" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "click_element",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "click_element" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const ag = await runActionGuard({
        toolName: "click_element", actionKind: "uiaInvoke",
        descriptor: { kind: "window", titleIncludes: effectiveWindowTitle },
        fixCarryingArgs: { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId, controlType },
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "click_element", { _perceptionForPost: ag.summary });
      }
      perceptionEnv = ag.summary;
    }

    const hintsBlock = buildHintsForTitle(effectiveWindowTitle);
    const result = await clickElement(effectiveWindowTitle, effectiveName, effectiveAutomationId, controlType);
    if (!result.ok) {
      return failWith(result.error ?? "Unknown error", "click_element", { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId });
    }
    const enriched = hintsBlock
      ? { ...result, hints: { target: hintsBlock.target, caches: hintsBlock.caches } }
      : result;
    return ok({ ...enriched, ...(perceptionEnv && { _perceptionForPost: perceptionEnv }) });
  } catch (err) {
    return failWith(err, "click_element", { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId });
  }
};

export const setElementValueHandler = async ({
  windowTitle, value, name, automationId, lensId,
}: { windowTitle: string; value: string; name?: string; automationId?: string; lensId?: string }): Promise<ToolResult> => {
  try {
    if (!name && !automationId) {
      return failArgs("Provide at least one of: name, automationId", "set_element_value", { windowTitle });
    }

    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "set_element_value", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "set_element_value" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "set_element_value",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "set_element_value" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const ag = await runActionGuard({
        toolName: "set_element_value", actionKind: "uiaSetValue",
        descriptor: { kind: "window", titleIncludes: windowTitle },
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "set_element_value", { _perceptionForPost: ag.summary });
      }
      perceptionEnv = ag.summary;
    }

    const hintsBlock = buildHintsForTitle(windowTitle);
    const result = await setElementValue(windowTitle, value, name, automationId);
    if (!result.ok) {
      return failWith(result.error ?? "Unknown error", "set_element_value", { windowTitle, name, automationId });
    }
    const enriched = hintsBlock
      ? { ...result, hints: { target: hintsBlock.target, caches: hintsBlock.caches } }
      : result;
    return ok({ ...enriched, ...(perceptionEnv && { _perceptionForPost: perceptionEnv }) });
  } catch (err) {
    return failWith(err, "set_element_value", { windowTitle, name, automationId });
  }
};

export const scopeElementHandler = async ({
  windowTitle, name, automationId, controlType, maxDepth, maxElements, padding,
}: {
  windowTitle: string;
  name?: string;
  automationId?: string;
  controlType?: string;
  maxDepth: number;
  maxElements: number;
  padding: number;
}): Promise<ToolResult> => {
  try {
    if (!name && !automationId && !controlType) {
      return failArgs("Provide at least one of: name, automationId, controlType", "scope_element", { windowTitle });
    }

    const hintsBlock = buildHintsForTitle(windowTitle);
    const bounds = await getElementBounds(windowTitle, name, automationId, controlType);
    if (!bounds) {
      return failWith("Element not found", "scope_element", { windowTitle, name, automationId, controlType });
    }

    const content: ToolResult["content"] = [];

    if (bounds.boundingRect) {
      const r = bounds.boundingRect;
      const region = {
        x: Math.max(0, r.x - padding),
        y: Math.max(0, r.y - padding),
        width: r.width + padding * 2,
        height: r.height + padding * 2,
      };
      try {
        const captured = await captureScreen(region, 1280);
        content.push({ type: "image" as const, data: captured.base64, mimeType: captured.mimeType });
        content.push({
          type: "text" as const,
          text: `[scope: ${bounds.name || controlType || automationId} @ ${r.x},${r.y} ${r.width}x${r.height}]`,
        });
      } catch {
        // Screenshot failed — continue with text only
      }
    }

    let children = null;
    try {
      children = await getElementChildren(windowTitle, name, automationId, controlType, maxDepth, maxElements, 5000);
    } catch {
      // UIA may fail; return element info without children
    }

    const payload = hintsBlock
      ? { element: bounds, children, hints: { target: hintsBlock.target, caches: hintsBlock.caches } }
      : { element: bounds, children };
    content.push({ type: "text" as const, text: JSON.stringify(payload, null, 2) });
    return { content };
  } catch (err) {
    return failWith(err, "scope_element", { windowTitle, name, automationId });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerUiElementTools(server: McpServer): void {
  server.tool(
    "get_ui_elements",
    "Inspect the raw UIA element tree of a window — returns names, control types, automationIds, bounding rects, and interaction patterns. Each element includes viewportPosition ('in-view'|'above'|'below'|'left'|'right') relative to the window client region — use it to decide whether scroll_to_element is needed before clicking. Prefer screenshot(detail='text') for interactive automation (returns pre-filtered actionable[] with clickAt coords). Use get_ui_elements when you need the unfiltered tree or specific automationIds for click_element. Caveats: Large windows may return hundreds of elements — scope with windowTitle. Results are capped at maxElements (default 80, max 200) — increase if the target element is missing.",
    getUiElementsSchema,
    getUiElementsHandler
  );

  server.tool(
    "click_element",
    "Invoke a UI element by name or automationId via UIA InvokePattern — no screen coordinates needed. The server auto-guards using windowTitle (verifies identity, foreground, modal) and returns post.perception.status. Prefer over mouse_click for buttons, menu items, and links in native Windows apps. Use get_ui_elements first to discover automationIds. lensId is optional for advanced pinned-lens use. Caveats: Requires InvokePattern — some custom controls do not expose it; fall back to mouse_click in that case.",
    clickElementSchema,
    withRichNarration("click_element", clickElementHandler, { windowTitleKey: "windowTitle" })
  );

  server.tool(
    "set_element_value",
    "Set the value of a text field or combo box via UIA ValuePattern. The server auto-guards using windowTitle and returns post.perception.status. More reliable than keyboard_type for programmatic form input. Use narrate:'rich' to confirm the value was applied. lensId is optional for advanced pinned-lens use. Caveats: Only works for elements that expose ValuePattern; does not work on contenteditable HTML or custom rich-text editors — use keyboard_type for those. If guard blocks with a suggestedFix, the fix.tool will be 'click_element' (v3 §7.1); approve via click_element({fixId}) then re-set.",
    setElementValueSchema,
    withRichNarration("set_element_value", setElementValueHandler, { windowTitleKey: "windowTitle" })
  );

  server.tool(
    "scope_element",
    "Return a high-resolution screenshot of a specific element's region plus its child element tree. Requires UIA — works with native apps, Chrome/Edge, VS Code. Use get_ui_elements first to discover element names or automationIds. At least one of name, automationId, or controlType must be provided.",
    scopeElementSchema,
    scopeElementHandler
  );
}
