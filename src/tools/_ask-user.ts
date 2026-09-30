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
 * Anything but an explicit Accept is a no. "Don't ask again" lasts for this server process, and
 * `DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND=1` says yes without asking.
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
export const ASK_TIMEOUT_MS = 60_000;

export const ALLOW_TERMINAL_FOREGROUND_ENV = "DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND";

/** Set by an Accept with "Don't ask again"; lives as long as this server process. */
let allowedForProcess = false;

/** Test seam: forget a remembered "Don't ask again". */
export function resetRememberedTerminalForeground(): void {
  allowedForProcess = false;
}

/**
 * Why the answer was no, in words a caller can act on:
 * - `cannot_ask`: this client or transport cannot show the question (and `claude -p` answers at once).
 * - `declined`: the user chose Decline.
 * - `cancelled`: the user dismissed it (Esc), or the client cancelled it without showing it.
 * - `timed_out`: no answer within `ASK_TIMEOUT_MS`.
 */
export type ForegroundRefusal = "cannot_ask" | "declined" | "cancelled" | "timed_out";

export type ForegroundAnswer =
  | { allowed: true; how: "env" | "remembered" | "asked" }
  | { allowed: false; why: ForegroundRefusal };

/**
 * May this call take the foreground for a moment to type into Windows Terminal? Asks the user when
 * it has to; never throws.
 */
export async function askToTakeForeground(): Promise<ForegroundAnswer> {
  if (process.env[ALLOW_TERMINAL_FOREGROUND_ENV] === "1") return { allowed: true, how: "env" };
  if (allowedForProcess) return { allowed: true, how: "remembered" };
  const ctx = _askAls.getStore();
  if (!ctx) return { allowed: false, why: "cannot_ask" };
  let answer: AskAnswer;
  try {
    answer = await ctx.ask(
      {
        // One line: the client cuts the rest (win2).
        message: "Type into Windows Terminal? It takes the foreground for about 0.1 s.",
        requestedSchema: {
          type: "object",
          properties: {
            dontAskAgain: {
              type: "boolean",
              title: "Don't ask again",
              description: "Allow this until the server restarts",
              default: false,
            },
          },
        },
      },
      ASK_TIMEOUT_MS,
    );
  } catch (err) {
    const timedOut = /timed? ?out/i.test(err instanceof Error ? err.message : String(err));
    return { allowed: false, why: timedOut ? "timed_out" : "cannot_ask" };
  }
  if (answer.action === "decline") return { allowed: false, why: "declined" };
  if (answer.action !== "accept") return { allowed: false, why: "cancelled" };
  if (answer.content?.dontAskAgain === true) allowedForProcess = true;
  return { allowed: true, how: "asked" };
}
