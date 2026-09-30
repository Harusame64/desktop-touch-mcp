/**
 * internal #227 — asking the user, through the MCP client, whether a tool may take the foreground.
 *
 * A handler deep in the executor cannot reach the MCP server or the request it is answering, so the
 * server's outermost tool wrapper (`server-windows.ts`) puts a way to ask into an AsyncLocalStorage
 * scope around every call, and `askToTakeForeground` reads it. Nested calls (`run_macro` steps)
 * inherit the outer call's scope.
 *
 * What the client does was measured by win2 with the user answering (Claude Code 2.1.285,
 * 2026-09-30, internal #227):
 * - The form shows the server's name, the message on ONE line (the rest is cut with "…"), and the
 *   fields, with Accept and Decline buttons. Accept, Decline and Esc answer `accept`, `decline` and
 *   `cancel`.
 * - The client never times out: an unanswered form stays up and the agent's turn waits on it. So
 *   the question carries its own timeout.
 * - `claude -p` (no one there) declares the capability and answers `cancel` at once.
 *
 * Anything but an explicit Accept is a no, and every paste is asked about. There is no "Don't ask
 * again" and no switch that says yes without asking (user, 2026-09-30): the question is what brings
 * the client in front, and a terminal in front is refused — without it, a paste into the tab the
 * client itself runs in could not be told from any other (gate 2 on #764).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The subset of the SDK's `ElicitResult` this module reads. */
export interface AskAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface AskForm {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface AskContext {
  /** Sends one form to the client and resolves with its answer; rejects on timeout or failure. */
  ask(form: AskForm, timeoutMs: number): Promise<AskAnswer>;
  /** True once the client has cancelled the tool call this context belongs to. */
  cancelled?(): boolean;
}

/**
 * Has the tool call been cancelled since it asked? Read again just before acting on a yes: checks
 * that run after the answer (the virtual-desktop question can fall back to PowerShell) take time,
 * and a cancel in that time must still stop the act (PR codex P2 on #764).
 */
export function callWasCancelled(): boolean {
  return _askAls.getStore()?.cancelled?.() === true;
}

const _askAls = new AsyncLocalStorage<AskContext | null>();

/**
 * Run `fn` with `ctx` as the way to ask. `null` says this call cannot ask (a transport that cannot
 * carry a request to the client). `undefined` inherits the scope already active.
 */
export function runWithAskContext<T>(ctx: AskContext | null | undefined, fn: () => T): T {
  if (ctx === undefined) return fn();
  return _askAls.run(ctx, fn);
}

/** How long the question waits for an answer before it counts as a no. */
export const ASK_TIMEOUT_MS = 120_000;

/**
 * The longest text the question shows in full: win2 saw 600 characters wrap to six lines, uncut,
 * and nothing longer was measured. Longer text is refused rather than agreed to unseen.
 */
export const ASK_TEXT_SHOWN_MAX = 600;

/** The longest window title the description line carries with the text (both shown in full). */
export const ASK_TITLE_SHOWN_MAX = 200;

/** A cancel sooner than this was not a person reading the question. */
export const INSTANT_CANCEL_MS = 500;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The question's one line: what is typed, and into which window, when they are known. */
export function foregroundQuestion(what: { windowTitle?: string; text?: string; pressEnter?: boolean }): string {
  const text = what.text ? ` "${clip(what.text, 20)}"${what.pressEnter ? " + Enter" : ""}` : what.pressEnter ? " Enter" : "";
  const where = what.windowTitle ? ` (${clip(what.windowTitle, 16)})` : "";
  return `Type${text} into Windows Terminal${where}? Takes the foreground ~0.1 s.`;
}

/**
 * Why the answer was no, in words a caller can act on:
 * - `cannot_ask`: this client or transport cannot show the question (and `claude -p` answers at once).
 * - `declined`: the user chose Decline, or unticked "Type it" and accepted.
 * - `cancelled`: the user dismissed it (Esc), or the client cancelled it without showing it.
 * - `timed_out`: no answer within `ASK_TIMEOUT_MS`.
 */
export type ForegroundRefusal = "cannot_ask" | "declined" | "cancelled" | "timed_out";

export type ForegroundAnswer =
  | { allowed: true }
  | { allowed: false; why: ForegroundRefusal };

/**
 * May this call take the foreground for a moment to type into Windows Terminal? Asks the user when
 * it has to; never throws.
 */
export async function askToTakeForeground(
  what: { windowTitle?: string; text?: string; pressEnter?: boolean } = {},
): Promise<ForegroundAnswer> {
  const ctx = _askAls.getStore();
  if (!ctx) return { allowed: false, why: "cannot_ask" };
  let answer: AskAnswer;
  const askedAt = Date.now();
  try {
    answer = await ctx.ask(
      {
        // One line: the client cuts the rest (win2). It names what is typed and where, so the user
        // does not agree blind (gate 2 on #764), each cut short to keep the line.
        message: foregroundQuestion(what),
        requestedSchema: {
          type: "object",
          properties: {
            // One field, ticked: Accept types. It exists to carry the description line, which is the
            // only place the client shows long text in full (win2).
            typeIt: {
              type: "boolean",
              title: "Type it",
              // The whole text, so two commands that start alike do not look alike (PR codex on #764).
              // The client wraps a long description rather than cutting it (win2: 600 characters, 6 lines).
              // Enter is said too: "echo hi" and "echo hi" + Enter must not look alike (PR codex on #764).
              // And the whole window title: the one-line question cuts it, and two terminals whose
              // titles start alike must not look alike either (PR codex on #764).
              description: what.text !== undefined
                ? `${what.windowTitle !== undefined ? `Into: ${what.windowTitle} — ` : ""}` +
                  `Types: ${what.text}${what.pressEnter ? "  — then presses Enter" : ""}`
                : "Accept to type it; untick or Decline to refuse",
              default: true,
            },
          },
        },
      },
      ASK_TIMEOUT_MS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timed? ?out/i.test(message)) return { allowed: false, why: "timed_out" };
    if (/cancel|abort/i.test(message)) return { allowed: false, why: "cancelled" };
    return { allowed: false, why: "cannot_ask" };
  }
  if (answer.action === "decline") return { allowed: false, why: "declined" };
  if (answer.action !== "accept") {
    // `claude -p` declares the capability and cancels in 4 ms without showing anything; the
    // quickest a person dismissed it was 8 s (win2). A cancel too quick for anyone to have read the
    // question is a client that cannot ask, whose advice differs (gate 2 on #764).
    return { allowed: false, why: Date.now() - askedAt < INSTANT_CANCEL_MS ? "cannot_ask" : "cancelled" };
  }
  if (answer.content?.typeIt === false) return { allowed: false, why: "declined" };
  return { allowed: true };
}
