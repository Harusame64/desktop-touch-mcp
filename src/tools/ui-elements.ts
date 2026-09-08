import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUiElements, clickElement, setElementValue, insertTextViaTextPattern2, getElementBounds, getElementChildren } from "../engine/uia-bridge.js";
import { keyboardTypeHandler } from "./keyboard.js";
import { captureScreen } from "../engine/image.js";
import { padCaptureRegion, resolveCaptureRegionAsync } from "../engine/reachable-bounds.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs, failCode } from "./_errors.js";
import { withRichNarration, narrateParam, UIA_WRITE_NARRATION } from "./_narration.js";
import { buildHintsForTitle } from "../engine/identity-tracker.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix, namesAWindow } from "./_action-guard.js";
import { WindowExcludedError } from "../engine/tool-exclusion.js";
import { resolveWindowTarget } from "./_resolve-window.js";
import { makeCommitWrapper, withEnvelopeIncludeSchema } from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getUiElementsSchema = {
  windowTitle: z.string().max(200).describe("Partial window title to find the target window. Use '@active' for the current foreground window."),
  hwnd: z.string().max(20).optional().describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
  maxDepth: z.coerce.number().int().min(1).max(8).default(4).describe("Maximum depth of the element tree to traverse (default 4)"),
  maxElements: z.coerce.number().int().min(1).max(200).default(80).describe("Maximum number of elements to return (default 80)"),
};

export const clickElementSchema = {
  windowTitle: z.string().max(200).describe("Partial window title of the target window. Use '@active' for the current foreground window."),
  hwnd: z.string().max(20).optional().describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
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
  windowTitle: z.string().max(200).describe("Partial window title. Use '@active' for the current foreground window."),
  hwnd: z.string().max(20).optional().describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
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
  windowTitle: z.string().max(200).describe("Partial window title of the target window. Use '@active' for the current foreground window."),
  hwnd: z.string().max(20).optional().describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
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
  windowTitle, hwnd: hwndParam, maxDepth, maxElements,
}: { windowTitle: string; hwnd?: string; maxDepth: number; maxElements: number }): Promise<ToolResult> => {
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const uiWarnings: string[] = [...(resolvedWin?.warnings ?? [])];
    // ADR-036 — NOT pinned, deliberately. `getUiElements` passes only the TITLE
    // to both its native and PowerShell paths; the handle it takes is used as a
    // cache key and nothing else. Pinning the hints here would report the named
    // window while the elements came from the first same-titled one, and would
    // then file that sibling's elements in the cache under the named window's
    // handle — a wrong answer stored under the right key, which is worse than
    // the uniformly title-based answer it replaces. The hints follow the read;
    // they do not lead it. Pin both together when the read takes a handle.
    const hintsBlock = buildHintsForTitle(effectiveTitle);
    const result = await getUiElements(effectiveTitle, maxDepth, maxElements, 10000, {
      hwnd: hintsBlock?.hwnd, cached: false,
    });
    const hints = {
      ...(hintsBlock ? { target: hintsBlock.target, caches: hintsBlock.caches } : {}),
      ...(uiWarnings.length > 0 ? { warnings: uiWarnings } : {}),
    };
    const enriched = Object.keys(hints).length > 0 ? { ...result, hints } : result;
    return ok(enriched, true);
  } catch (err) {
    return failWith(err, "get_ui_elements", { windowTitle });
  }
};

export const clickElementHandler = async ({
  windowTitle, hwnd: hwndParam, name, automationId, controlType, lensId, fixId,
}: { windowTitle: string; hwnd?: string; name?: string; automationId?: string; controlType?: string; lensId?: string; fixId?: string }): Promise<ToolResult> => {
  // Phase G: fixId approval prologue (declared outside try for catch block visibility)
  let effectiveWindowTitle = windowTitle;
  let effectiveName = name;
  let effectiveAutomationId = automationId;
  let winWarnings: string[] = [];
  // H3: lifted to outer scope so hwnd is available for clickElement call below
  let resolvedWin: import("./_resolve-window.js").ResolvedWindow | null = null;
  try {
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "click_element");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "click_element");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      if (typeof vr.fix.args.name === "string") effectiveName = vr.fix.args.name;
      if (typeof vr.fix.args.automationId === "string") effectiveAutomationId = vr.fix.args.automationId;
      consumeFix(fixId);  // consume before executing
    } else {
      resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
      if (resolvedWin) {
        effectiveWindowTitle = resolvedWin.title;
        winWarnings = resolvedWin.warnings;
      }
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
        descriptor: {
          kind: "window",
          titleIncludes: effectiveWindowTitle,
          // ADR-036 I-1 — the UIA write already routes through the resolved
          // handle (`FromHandle` below); without this the guard was the one
          // layer still counting same-titled windows and refusing the call.
          ...(hwndParam !== undefined && resolvedWin && { hwnd: resolvedWin.hwnd }),
        },
        fixCarryingArgs: { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId, controlType },
        // ADR-036 — a handle-pinned call gets no `fixId` hint: the stored args
        // carry only the title and the replay prologue skips resolution, so
        // following the hint returns to the guard with the handle gone. The
        // hint returns when the replay carries the handle (ADR-036 I-5).
        ...(hwndParam !== undefined && resolvedWin && { suppressSuggestedFix: true }),
      });
      if (ag.block) {
        // A refusal that carries its own `suggest` replaces the status
        // catalogue rather than travelling beside it: the catalogue's lines for
        // this status name recoveries the message has just ruled out, and the
        // structured field is the one the server instructions tell the model to
        // read. `failCode` is the shape that can carry it (`failWith` always
        // appends the catalogue).
        const { suggest, ...forPost } = ag.summary;
        return suggest
          ? failCode("AutoGuardBlocked", ag.summary.next, {
              suggest,
              rootExtras: { _perceptionForPost: forPost },
            })
          : failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "click_element", { _perceptionForPost: ag.summary });
      }
      perceptionEnv = ag.summary;
    }

    // ADR-036 — hints describe the window that was ACTED ON. Built from the
    // title they named the first same-titled window instead, so a pinned call
    // could operate on one window and hand the caller the other one's handle
    // and cache state to reuse.
    // The third argument is the PUBLIC `hwnd`, not `resolvedWin` being set —
    // `@active` and the dialog rescue resolve a handle for a caller who named a
    // title, and keying their observation by handle takes `process_restarted`
    // away from them. Same predicate the guard descriptor above uses.
    const hintsBlock = buildHintsForTitle(
      effectiveWindowTitle, resolvedWin?.hwnd, hwndParam !== undefined,
    );
    // H3: pass resolved hwnd so uia-bridge uses FromHandle() for common dialogs
    const result = await clickElement(
      effectiveWindowTitle, effectiveName, effectiveAutomationId, controlType,
      resolvedWin ? { hwnd: resolvedWin.hwnd } : undefined,
    );
    if (!result.ok) {
      return failWith(result.error ?? "Unknown error", "click_element", { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId });
    }
    const hints = {
      ...(hintsBlock ? { target: hintsBlock.target, caches: hintsBlock.caches } : {}),
      ...(winWarnings.length > 0 ? { warnings: winWarnings } : {}),
    };
    const enriched = Object.keys(hints).length > 0 ? { ...result, hints } : result;
    return ok({ ...enriched, ...(perceptionEnv && { _perceptionForPost: perceptionEnv }) });
  } catch (err) {
    return failWith(err, "click_element", { windowTitle: effectiveWindowTitle, name: effectiveName, automationId: effectiveAutomationId });
  }
};

/** true when DTM_SET_VALUE_CHAIN=1 — enables TextPattern2 and keyboard fallback channels */
function isSetValueChainEnabled(): boolean {
  return process.env["DTM_SET_VALUE_CHAIN"] === "1";
}

/**
 * ADR-036 — can `set_element_value` be pinned to the caller's handle?
 *
 * Only when EVERY channel the call can still take is addressed by that handle.
 * Channel 1 (ValuePattern) is. Channels 2 and 3 are not: the TextPattern2
 * insert resolves by title, and the keyboard fallback does a foreground
 * select-all-and-replace on a title-resolved window with the guard skipped. So
 * while the chain is armed the multi-match refusal has to stand — it is the
 * wrong answer, but overwriting the wrong window's field is a worse one.
 *
 * This function is the ONE place that has to change when those channels take a
 * handle (ADR-036 I-6): it becomes unconditionally true and then disappears,
 * along with the refusal it keeps alive. Named for the condition rather than
 * for the env flag so that is findable from the fix, not only from the ADR.
 */
function allSetValueChannelsAreHandleAddressed(): boolean {
  return !isSetValueChainEnabled();
}

export const setElementValueHandler = async ({
  windowTitle, hwnd: hwndParam, value, name, automationId, lensId,
}: { windowTitle: string; hwnd?: string; value: string; name?: string; automationId?: string; lensId?: string }): Promise<ToolResult> => {
  // ADR-036 — the observation this call still owes, and the window it owes it
  // ON, held outside the try so the catch can see it (the `click_element`
  // prologue above hoists for the same reason). Null until a channel is about
  // to run, and null again the moment one of the branches below takes it. The
  // handle rides along because the observation is not a report: nothing reads
  // the block it returns on this path, so the only question left is WHICH
  // window gets its baseline refreshed — and refreshing the first same-titled
  // one leaves the named window exactly as stale as it was, in the one case
  // this whole change is about.
  let observationOwedFor: { title: string; hwnd?: bigint } | null = null;
  // What a failure reported from the catch calls the window. Separate from the
  // debt on purpose: the debt is settled by whichever branch observes, and a
  // throw after that point would otherwise send the report back to the caller's
  // raw partial title — worse than what it replaced, on the one path where the
  // resolved title is certainly known.
  let reportTitle = windowTitle;
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    reportTitle = effectiveTitle;
    const uiWarnings: string[] = [...(resolvedWin?.warnings ?? [])];
    if (!name && !automationId) {
      return failArgs("Provide at least one of: name, automationId", "set_element_value", { windowTitle: effectiveTitle });
    }

    // Hoisted above the guard: whether the fallback chain is armed decides
    // whether this call may be handle-pinned at all (see the descriptor below).
    const chainEnabled = isSetValueChainEnabled();
    const mayPinHandle = allSetValueChannelsAreHandleAddressed();

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
        descriptor: {
          kind: "window",
          titleIncludes: effectiveTitle,
          // ADR-036 I-1 — see click_element above, plus the condition in
          // `allSetValueChannelsAreHandleAddressed`: the pin follows the write
          // channels, it does not lead them.
          ...(hwndParam !== undefined && resolvedWin && mayPinHandle && { hwnd: resolvedWin.hwnd }),
        },
        ...(hwndParam !== undefined && resolvedWin && mayPinHandle && { suppressSuggestedFix: true }),
      });
      if (ag.block) {
        // ADR-036 — the generic `ambiguous_target` advice is "pass hwnd", and
        // while the chain is armed this handler CANNOT honour it: the descriptor
        // above withholds the handle on purpose, so the suggested retry returns
        // to the same refusal. Naming a recovery that does not work is the exact
        // defect this PR started from — one tool over. Say what does work here.
        // The titleless target joins this branch whatever the chain is doing.
        // With the chain OFF — the DEFAULT — the handle IS accepted, so the
        // generic catalogue answers "pass hwnd (desktop_discover returns it)",
        // and both halves are dead for this caller: `enumWindowsInZOrder` drops
        // a window on `!title`, so `desktop_discover` cannot list it and the
        // by-handle guard comes back `target_not_found`. Measured: the caller
        // gets "pass hwnd", passes it, gets "run desktop_discover", and the two
        // steps close a loop. That is the shape this PR exists to remove, and it
        // was sitting on the path nobody has to configure — the tailoring was
        // reachable only with a flag set.
        //
        // `resolvedWin !== null` is load-bearing and was missing. `effectiveTitle`
        // is `resolvedWin?.title ?? windowTitle`, so an empty string arrives two
        // ways: a window we RESOLVED that has no title (`@active` on an untitled
        // foreground, or a handle), and a caller who simply passed
        // `windowTitle: ""` — the schema has no `.min(1)`, and an empty query
        // matches every window, so that caller is `ambiguous_target` too. They
        // are different populations with opposite recoveries. Measured on a
        // desktop of two TITLED windows: `windowTitle: ""` was told "this window
        // has no title", that passing hwnd returns `target_not_found` and that
        // `desktop_discover` cannot list the window — four false statements, and
        // the generic advice it replaced was correct for that caller. Naming as
        // broken the two recoveries that work is this PR's subject with the sign
        // flipped, which is the fourth time this branch has produced one.
        const titlelessTarget = resolvedWin !== null && effectiveTitle === "";
        if (ag.summary.status === "ambiguous_target" && (!mayPinHandle || titlelessTarget)) {
          // Does not name this tool: it is privatised, and the naming audit
          // keeps its name out of anything the model reads. "This tool" is
          // unambiguous where this text is delivered — attached to the call
          // that was refused.
          // Ordered by what the reader can do on the next call. The two tools
          // come first because a model can call them; unsetting the variable is
          // an operator's job and a restart. The title advice is LAST and
          // carries its own limit, because here it is load-bearing — this is the
          // one refusal that cannot offer the handle instead.
          //
          // The limit has been stated wrongly twice. It is not "identical
          // titles", and it is not "the titles differ ahead of the browser
          // suffix" either. `resolveActionTarget` normalizes BOTH sides —
          // lowercase, trim, NFC, and a Chrome/Edge/Firefox suffix removed
          // (`action-target.ts` BROWSER_SUFFIXES) — and then keeps every
          // candidate whose normalized title CONTAINS the normalized query. So
          // the predicate is: this window's normalized title must not be
          // contained in any other window's. Three ways it is, all reachable:
          //
          //   "Report" beside "Report archive" — the SHORTER one cannot be
          //   named: every query matching it matches the longer one too. The
          //   longer one still can ("archive" reaches it alone), so the pair is
          //   separable from one side and not the other. Saying "this pair
          //   cannot be separated" takes a working recovery away from the
          //   caller who wanted "Report archive" — the same defect as offering
          //   one that does not work, with the sign flipped.
          //
          //   "Report" beside "REPORT" — the raw titles differ; the normalized
          //   ones are the same string.
          //
          //   one page open in Chrome and in Edge — the suffix is deleted from
          //   the titles AND from the query, so naming the browser is gone
          //   before the comparison.
          //
          // The last is the case this PR starts from (a browser window), which
          // is why the text keeps its examples after stating the rule.
          //
          // And the title advice has to say WHO it is for. Sentence 1 addresses
          // the caller who passed `hwnd` — and for that caller `windowTitle` is
          // inert: `effectiveTitle` above is the RESOLVED window's full title,
          // so the guard already counted with it and narrowing the argument
          // changes nothing. Unscoped, the longest half of this message sent
          // exactly the reader it had just addressed back to the same refusal:
          // the defect this PR exists to remove, one axis over.
          //
          // The generic advice in `_action-guard.ts` keeps the flat form on
          // purpose: there `hwnd` is offered first and works, so the title line
          // is a second option rather than the only one left.
          // A titleless target is refused for a different reason and has a
          // different recovery. `@active` on an untitled foreground window
          // resolves to an empty `effectiveTitle`, which matches every window,
          // so the count is ambiguous — and unsetting the variable does NOT
          // rescue it: `enumWindowsInZOrder` drops untitled windows
          // (`win32.ts`, on `!title` — UNTRIMMED, which is why the test here is
          // `=== ""` and not `.trim()`: a whitespace title survives the
          // enumeration and IS reachable by handle, and telling that caller
          // otherwise was the mirror defect). `click_element` resolves the same
          // way.
          //
          // `keyboard` does not. `keyboardDestinationMiss` (`_action-guard.ts`)
          // passes a titleless resolved handle when `isForeground()` is true —
          // "the legitimate `@active` case" in its own words — the focus step is
          // skipped, the descriptor is null, and SendInput lands on the
          // foreground. Measured by the second gate, both directions. Omitting
          // it would be this PR's defect with the sign flipped: denying a
          // recovery that works. It is named with its limit, because it types
          // into whatever holds focus inside the window rather than into a
          // named element.
          // `namesAWindow` TRIMS, so a whitespace-only title reaches
          // `keyboard`'s destination check as "no window named"
          // and carries the same foreground-only limit the titleless branch
          // spells out — measured both directions by the second gate
          // (`titleless_hwnd_not_foreground` when it is not in front,
          // `titleless_foreground` when it is). `click_element` is unaffected:
          // it passes the handle itself. So naming the two channels flatly was
          // true for one and a promise the other refuses — this branch's third
          // sign-flipped mirror, moved from `""` to `"   "` by the predicate
          // fix that made `"   "` take the ordinary message.
          //
          // The predicate is IMPORTED rather than re-derived: this sentence is
          // only true while it matches the one the destination check runs, and
          // a local `.trim()` one file away from the rule it mirrors is how the
          // last two mirrors got in.
          //
          // `resolvedWin === null ||` is the same half `titlelessTarget` was
          // missing, and this predicate is 85 lines below the fix for that one.
          // `effectiveTitle` is the caller's QUERY when nothing resolved, and
          // `keyboard` never sees that string: its prologue adopts the resolved
          // title (`keyboard.ts`, `if (resolvedWin) effectiveWindowTitle =
          // resolvedWin.title`). Measured — `keyboardDestinationMiss` on a
          // TITLED window retried with `{hwnd, windowTitle:""}` returns
          // `{miss:null}`, no foreground limit — so a caller who passed a blank
          // query on a desktop of titled windows was told `keyboard` was
          // foreground-only here, in the same sentence as `click_element`, and
          // both channels take the handle outright. Fifth statement this branch
          // has got wrong, and the second from reading a query as if it were a
          // window. Safe because `ambiguous_target` means the enumeration
          // matched two or more windows, and it drops untitled ones — so when
          // nothing resolved, the candidates are named.
          const keyboardTakesHwndHere = resolvedWin === null || namesAWindow(effectiveTitle);
          const handleRecovery = keyboardTakesHwndHere
            ? "click_element and keyboard take hwnd here. "
            : "click_element takes hwnd here. keyboard reaches this window by " +
              "handle only while it is in the foreground (windowTitle:\"@active\"), " +
              "because its destination check trims the title and a blank one " +
              "names no window. ";
          ag.summary.next = titlelessTarget
            ? "This window has no title, so it cannot be addressed by title, and the " +
              "enumeration that resolves handles drops untitled windows — " +
              (chainEnabled
                ? "unsetting DTM_SET_VALUE_CHAIN returns target_not_found rather than reaching it, "
                : "passing hwnd to this tool returns target_not_found rather than reaching it, ") +
              "and click_element resolves the same way. keyboard does reach it while " +
              "it stays in the foreground (windowTitle:\"@active\"), typing into " +
              "whatever holds focus inside it, which is not the same as writing to a " +
              "named element. Otherwise give the window a title."
            :
            "This tool cannot be narrowed by hwnd while DTM_SET_VALUE_CHAIN=1: " +
            "its fallback channels still find the window by title. " + handleRecovery +
            "If you passed hwnd, windowTitle was ignored: " +
            "this refusal already used the named window's own full title, so narrowing " +
            "it changes nothing. Calling by title alone, a more specific windowTitle " +
            "works only if this " +
            "window's normalized title is not contained in any other open window's: " +
            "matching lowercases, trims and strips a Chrome, Edge or Firefox suffix " +
            "from both sides, then asks which titles contain your query. So the " +
            "shorter of \"Report\" and \"Report archive\" can never be named this way " +
            "(the longer one still can be named), and \"Report\" beside \"REPORT\", or one page " +
            "open in Chrome and in Edge, can never be told apart at all. Unsetting " +
            "DTM_SET_VALUE_CHAIN lets this tool take hwnd too, but that is a server " +
            "setting, not a call argument.";
          // The `suggest` catalogue answers by guard STATUS, and its
          // `ambiguous_target` line offers the two recoveries the sentence above
          // has just ruled out: pass hwnd, and narrow the title. The response
          // carried both halves of a contradiction, and the dead half is the one
          // the server instructions tell the model to read. So this one refusal
          // answers with its own list; every other block status here keeps the
          // catalogue, which is right for them.
          return failCode("AutoGuardBlocked", ag.summary.next, {
            suggest: [
              "Read the error message — for this refusal it is the whole recovery.",
              // Answers for the branch that actually fired. Flat, this line
              // offered a titleless caller a listing that drops their window
              // (`enumWindowsInZOrder` skips `!title`) and two channels of
              // which one cannot reach it — the catalogue's contradiction one
              // level down, inside the list written to replace it.
              titlelessTarget
                ? "desktop_discover cannot list this window — the enumeration drops untitled ones. keyboard does accept its hwnd, but only while this window is in the foreground; click_element resolves handles through that same enumeration and cannot reach it."
                : keyboardTakesHwndHere
                  ? "desktop_discover returns each open window's hwnd; click_element and keyboard accept it on this window."
                  : "desktop_discover returns each open window's hwnd; click_element accepts it on this window, and keyboard only while this window is in the foreground.",
            ],
            rootExtras: { _perceptionForPost: ag.summary },
          });
        }
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "set_element_value", { _perceptionForPost: ag.summary });
      }
      perceptionEnv = ag.summary;
    }

    // ADR-036 — the hints are built INSIDE the branch of the channel that
    // succeeded, because this is the one handler that can change channel
    // mid-call. `buildHintsForTitle` also OBSERVES the window it resolves, and
    // that observation is what keeps drift detection current — so the branches
    // that report no hints call it anyway, for the observation alone. The
    // single call this replaced took it for every path, failures included, and
    // dropping it there would have been an unannounced change. Channel 1 goes through the handle, so its report may name it;
    // channels 2 and 3 still find their window by title (R-36-5), so a pinned
    // label there would name the requested window for a write that may have
    // landed on its same-titled sibling — the defect Round 2 removed from
    // `get_ui_elements`, reappearing one layer down. The guard's own gate
    // (`mayPinHandle`) does not cover this: the `lensId` branch above and
    // `DESKTOP_TOUCH_AUTO_GUARD=0` both skip `runActionGuard` entirely, so the
    // chain stays reachable with the refusal never consulted.
    //
    // Built once per call and never twice: `buildHintsForTitle` OBSERVES the
    // window it resolves, so calling it for both forms would record the same
    // window under two handles and report a drift that never happened.
    //
    // `observe` is the only place this handler observes from, so a branch
    // taking the observation is the same act as clearing the debt — they
    // cannot drift apart the way a separate flag would.
    //
    // And it cannot throw. Every call site here has ALREADY decided what
    // happened to the write: the channel returned, the value is in the field or
    // it is not, and the only thing left is to describe it. Letting the
    // description's failure out took that decision back — a `buildHintsForTitle`
    // that threw after channel 1 succeeded reached the outer catch and reported
    // `set_element_value` as failed for a field it had changed, and on the
    // failure paths it replaced `SetValueAllChannelsFailed` with an error about
    // the observation. The previous round narrowed the keyboard channel's parse
    // catch and moved that same failure here rather than removing it. The debt
    // is cleared either way: the observation was attempted, and repeating a call
    // that just threw would only produce the same throw from a worse place. The
    // caller is told on the success paths, where the hints are what they would
    // have read; the failure paths report the channel's error alone, which is
    // the thing that decides their next call.
    const observe = (title: string, pinnedHwnd?: bigint) => {
      try {
        // `hwndParam !== undefined`, not `pinnedHwnd !== undefined`: see the
        // note at `click_element`'s call above. A `@active` caller named a
        // title and keeps the title's drift question.
        return buildHintsForTitle(title, pinnedHwnd, hwndParam !== undefined);
      } catch (e) {
        // A refusal is SAID differently and still does not travel as a
        // failure. Re-throwing it — which is what the previous round did — put
        // back the exact defect the commit before it is titled after: the
        // channel had already returned, the value was in the field, and the
        // response came back `ok:false` for a write that landed. Measured, all
        // three shapes: channel 1 succeeded and was reported failed; the
        // all-channels-failed path lost `SetValueAllChannelsFailed` and its
        // `attempts`; channel 3 typed the text and reported failure. Refusing
        // after the fact does not un-write anything, and the refusal that
        // MATTERS runs in `resolveWindowTarget` before any channel.
        //
        // So it is a warning like the others, worded so the two cannot be
        // mistaken for each other. `buildHintsForTitle` cannot raise one today
        // in any case — it reaches win32 through `observeTarget` only, never
        // through `resolveWindowTarget`, `isExcludedTitle` or
        // `refuseIfExcludedTarget` — which is why this is about what the next
        // caller would get, not about a live path.
        uiWarnings.push(
          e instanceof WindowExcludedError
            ? `identity hints refused: ${e.message}`
            : `identity hints unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      } finally {
        // In `finally`, not first: the debt is settled by the ATTEMPT, and
        // writing that as a statement before the call left the ordering as a
        // fact about line numbers. Every `observe` here is the last thing before
        // a `return`, so the two orderings cannot be told apart from outside
        // today — which is exactly why it should not be spelled as an order.
        observationOwedFor = null;
      }
    };

    const attempts: Array<{ channel: string; error: string }> = [];

    // Channel 1: ValuePattern (always tried first)
    // H3: pass resolved hwnd so uia-bridge uses FromHandle() for common dialogs
    // Owed from here: from this line on, some window has been written to (or an
    // attempt was made on it) and the drift baseline is stale until observed.
    // Channel 1 goes through the handle, so the debt names the handle.
    observationOwedFor = { title: effectiveTitle, ...(resolvedWin && { hwnd: resolvedWin.hwnd }) };
    const r1 = await setElementValue(
      effectiveTitle, value, name, automationId,
      resolvedWin ? { hwnd: resolvedWin.hwnd } : undefined,
    );
    if (r1.ok) {
      // Channel 1 is handle-addressed (the `hwnd` passed above), so the report
      // may name that handle.
      const hintsBlock = observe(effectiveTitle, resolvedWin?.hwnd);
      const hints = {
        ...(hintsBlock ? { target: hintsBlock.target, caches: hintsBlock.caches } : {}),
        ...(uiWarnings.length > 0 ? { warnings: uiWarnings } : {}),
      };
      const enriched = Object.keys(hints).length > 0 ? { ...r1, hints } : r1;
      return ok({ ...enriched, channel: "value", ...(perceptionEnv && { _perceptionForPost: perceptionEnv }) });
    }
    attempts.push({ channel: "value", error: r1.error ?? "ValuePatternFailed" });

    if (chainEnabled) {
      // The debt follows the channel about to run: from here on the write is
      // addressed by title (R-36-5), so a failure owes the title's window and
      // not the handle's — the same rule the success branches report under.
      observationOwedFor = { title: effectiveTitle };

      // Channel 2: TextPattern2.InsertTextAtSelection (foreground-free)
      const r2 = await insertTextViaTextPattern2(effectiveTitle, value, name, automationId);
      if (r2.ok) {
        // Channel 2 resolved by title, so its report does too — the hints
        // follow the write, they do not lead it.
        const hintsBlock = observe(effectiveTitle);
        const hints = {
          ...(hintsBlock ? { target: hintsBlock.target, caches: hintsBlock.caches } : {}),
          ...(uiWarnings.length > 0 ? { warnings: uiWarnings } : {}),
        };
        const enriched = Object.keys(hints).length > 0 ? { hints } : {};
        return ok({ ok: true, channel: "text2", ...enriched, ...(perceptionEnv && { _perceptionForPost: perceptionEnv }) });
      }
      if (r2.code !== "TextPattern2NotSupported") {
        attempts.push({ channel: "text2", error: r2.code ?? "TextPattern2Error" });
      } else {
        attempts.push({ channel: "text2", error: "TextPattern2NotSupported" });
      }

      // Channel 3: keyboard_type fallback (foreground required)
      const r3 = await keyboardTypeHandler({
        text: value,
        method: "foreground",
        use_clipboard: false,
        replaceAll: true,
        forceKeystrokes: false,
        windowTitle: effectiveTitle,
        trackFocus: false,
        settleMs: 0,
        _skipAutoGuard: true,
      });
      if (r3.content?.[0]?.type === "text") {
        let parsed: { ok?: boolean; error?: string } | undefined;
        try {
          // The parse, and nothing else — see the catch.
          const raw = JSON.parse(r3.content[0].text) as { ok?: boolean; error?: string } | null;
          // `raw.ok` on a null body threw where this stands and was reported as
          // a parse error, so it still is one. A primitive body did not throw
          // there (`(5).ok` is undefined) and does not throw here either.
          if (raw === null) throw new TypeError("NullKeyboardResponse");
          parsed = raw;
        } catch {
          // ADR-036 — this catch belongs to the PARSE alone. It used to wrap the
          // success branch as well, so an observation that threw was filed as a
          // parse error, the keyboard write that had actually succeeded was
          // reported as a failure, and the all-channels-failed path below
          // observed a second time — the debt already settled, the drift never
          // real. The narrower catch leaves an observation failure to the outer
          // one, where channels 1 and 2 already send theirs.
          attempts.push({ channel: "keyboard", error: "KeyboardResponseParseError" });
        }
        if (parsed !== undefined) {
          if (parsed.ok) {
            // Channel 3 reports no identity hints — it resolves by title and a
            // pinned label here would name the requested window for a write
            // that may have landed on its sibling. Warnings are a different
            // thing and do carry: this is where the resolver's own
            // (`dialog_resolved_via_owner_chain`) and a failed observation say
            // so, and dropping them made "the caller is told" false for exactly
            // one of the three success paths.
            observe(effectiveTitle);   // observation only — see above
            return ok({
              ok: true, channel: "keyboard",
              ...(uiWarnings.length > 0 ? { hints: { warnings: uiWarnings } } : {}),
              ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
            });
          }
          attempts.push({ channel: "keyboard", error: parsed.error ?? "KeyboardFailed" });
        }
      } else {
        attempts.push({ channel: "keyboard", error: "KeyboardFailed" });
      }

      // All channels failed — suggest comes from _errors.ts SUGGESTS.SetValueAllChannelsFailed
      // Unpinned on purpose: channels 2 and 3 both ran, and both found their
      // window by title. Pinning here would name a handle for writes that were
      // never addressed to it.
      observe(effectiveTitle);   // observation only — see above
      return failWith(
        new Error("SetValueAllChannelsFailed"),
        "set_element_value",
        { windowTitle: effectiveTitle, name, automationId, attempts }
      );
    }

    // Chain disabled: report ValuePattern failure. Channel 1 is the only channel
    // that ran and it went through the handle, so the observation follows it —
    // the same rule the rejection path obeys one screen down. Observing by
    // title here refreshed the FIRST same-titled window and left the named one
    // stale, which made the window that got observed depend on the SHAPE of the
    // failure rather than on where the write went.
    observe(effectiveTitle, resolvedWin?.hwnd);   // observation only — see above
    return failWith(r1.error ?? "Unknown error", "set_element_value", { windowTitle: effectiveTitle, name, automationId });
  } catch (err) {
    // ADR-036 — a channel that REJECTS instead of returning `ok:false` (the
    // PowerShell runner times out, or hands back malformed JSON) leaves through
    // here, past every branch that would have observed. Round 3 opened that
    // hole by moving the one top-of-handler observation down into the branches;
    // before it the observation was taken ahead of the channels and no failure
    // could lose it. Paid here exactly when no branch paid it — observing twice
    // files one window under two handles and reports a drift that never
    // happened.
    const owed = observationOwedFor;
    if (owed !== null) {
      try {
        buildHintsForTitle(owed.title, owed.hwnd, hwndParam !== undefined);
      } catch {
        // The channel's failure is what the caller needs; an observation that
        // cannot be taken must not take its place as the reported error.
      }
    }
    // The resolved title, when there is one — the two failure reports inside
    // the try already use it, and a call that named a handle knows it here.
    return failWith(err, "set_element_value", { windowTitle: reportTitle, name, automationId });
  }
};

export const scopeElementHandler = async ({
  windowTitle, hwnd: hwndParam, name, automationId, controlType, maxDepth, maxElements, padding,
}: {
  windowTitle: string;
  hwnd?: string;
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

    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const uiWarnings: string[] = [...(resolvedWin?.warnings ?? [])];
    // ADR-036 — NOT pinned, for the reason given in get_ui_elements:
    // `getElementBounds` and `getElementChildren` below both resolve by title,
    // so pinned hints would label the response with one window while the
    // element metadata and the screenshot came from another. Being uniformly
    // wrong is recoverable; being inconsistent with yourself is not.
    const hintsBlock = buildHintsForTitle(effectiveTitle);
    const bounds = await getElementBounds(effectiveTitle, name, automationId, controlType);
    if (!bounds) {
      return failWith("Element not found", "scope_element", { windowTitle, name, automationId, controlType });
    }

    const content: ToolResult["content"] = [];

    if (bounds.boundingRect) {
      const r = bounds.boundingRect;
      // ADR-031 §2(d) — the padding may overhang the screen; the element must
      // not be moved. Clamping x/y to 0 assumed the screen starts at the
      // origin, so on a monitor placed left of the primary one it pulled the
      // capture onto a different monitor and returned that picture as if it
      // were the element. `padCaptureRegion` trims the overhang only when the
      // element itself is inside the capturable area, and otherwise hands the
      // region through untouched for the choke point to refuse — the catch
      // below then continues text-only, which is an honest degradation.
      const region = padCaptureRegion(r, padding, await resolveCaptureRegionAsync());
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
      children = await getElementChildren(effectiveTitle, name, automationId, controlType, maxDepth, maxElements, 5000);
    } catch {
      // UIA may fail; return element info without children
    }

    const hints = {
      ...(hintsBlock ? { target: hintsBlock.target, caches: hintsBlock.caches } : {}),
      ...(uiWarnings.length > 0 ? { warnings: uiWarnings } : {}),
    };
    const payload = Object.keys(hints).length > 0
      ? { element: bounds, children, hints }
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

/**
 * S6 trunk completion PoC (sub-plan §2.3 + §3.1 G6-S6-1):
 * `click_element` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — `leaseValidator` omitted since `click_element` is a name/
 * automationId match without lease 4-tuple validation, sub-plan §1.1 G).
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer) composition:
 *   - withRichNarration enriches the handler's ToolResult (`hints.diff` 等)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.click_element` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 *
 * G6 contract: this PoC demonstrates the trunk-completion claim that
 * "expansion tool addition is L5-wrapper-only" — no engine-perception
 * layer change required, just a wrap at the registration site.
 */
export const clickElementRegistrationHandler = makeCommitWrapper(
  withRichNarration("click_element", clickElementHandler, UIA_WRITE_NARRATION) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "click_element",
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
 * Without injection, Zod's default object parse strips unknown keys and
 * `include` is removed before `makeCommitWrapper` can peek it
 * (PR #112 P1-1 / Codex PR #121 P2 同型 risk pattern). PR #117 で land
 * された click_element wrap が schema injection を欠いていたため、
 * `run_macro({tool:"click_element", args:{include:["causal"]}})` が
 * silently raw fallback する production bug を内包していた。本 PR で
 * mouse_click 同梱 fix として解消 (Opus PR #121 Round 1 P1-2 反映)。
 */
export const clickElementRegistrationSchema = withEnvelopeIncludeSchema(clickElementSchema);

export function registerUiElementTools(server: McpServer): void {
  // Phase 4: get_ui_elements privatized — handler retained as internal export.
  // desktop_discover returns the actionable[] entity list (with name / role /
  // value / automationId / region) and emits leases for desktop_act.
  // (memory: feedback_disable_via_entry_block.md)

  server.tool(
    "click_element",
    "Invoke a UI element by name or automationId via UIA InvokePattern — no screen coordinates needed. The server auto-guards using windowTitle (verifies identity, foreground, modal) and returns post.perception.status. Prefer over mouse_click for buttons, menu items, and links in native Windows apps. Use desktop_discover first to discover automationIds. Pass fixId from a suggestedFix to re-target after window identity drift. lensId is optional for advanced pinned-lens use. Caveats: Typed errors: code:'InvokePatternNotSupported' — the control does not expose InvokePattern, fall back to mouse_click; code:'ElementDisabled' — the element is in a disabled state, re-check preconditions before retry; code:'GuardFailed' — read the perception envelope (attention / guard fields) and choose recovery (re-focus, wait, or pass the suggestedFix.fixId on the next call). Some custom controls do not expose InvokePattern at all; fall back to mouse_click for those.",
    clickElementRegistrationSchema,
    clickElementRegistrationHandler as typeof clickElementHandler
  );

  // Phase 4: set_element_value absorbed into desktop_act({action:'setValue'}).
  // setElementValueHandler / setElementValueSchema retained as internal
  // exports — desktop-executor calls the equivalent uia-bridge.setElementValue
  // for any UIA entity when action='setValue' (or 'type'). For non-lease /
  // legacy code paths the handler can still be invoked directly.
  //
  // scope_element privatized — entry-point removed, handler retained
  // as internal export. Discover element bounds via desktop_discover, then pass
  // region={x,y,width,height} to screenshot for the equivalent zoom.
  // (memory: feedback_disable_via_entry_block.md)
}
