/**
 * internal #227 — whether a tool may take the foreground to type into Windows Terminal: asked of the
 * user through the MCP client, and anything but an explicit Accept is a no.
 *
 * The answers modelled here are the ones win2 measured with the user answering (Claude Code
 * 2.1.285): Accept → `accept` with the box's value filled in, Decline → `decline`, Esc → `cancel`,
 * `claude -p` → `cancel` at once, and no client-side timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  askToTakeForeground, runWithAskContext, resetRememberedTerminalForeground, ASK_TIMEOUT_MS,
  type AskContext, type AskForm,
} from "../../src/tools/_ask-user.js";

const answering = (answer: Awaited<ReturnType<AskContext["ask"]>> | Error) => {
  const asked: Array<{ form: AskForm; timeoutMs: number }> = [];
  const ctx: AskContext = {
    ask: vi.fn(async (form, timeoutMs) => {
      asked.push({ form, timeoutMs });
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  return { ctx, asked };
};

beforeEach(() => {
  resetRememberedTerminalForeground();
  delete process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND;
});
afterEach(() => { delete process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND; });

describe("askToTakeForeground", () => {
  it("allows on Accept, and asks one line with one 'Don't ask again' box and its own timeout", async () => {
    const { ctx, asked } = answering({ action: "accept", content: { dontAskAgain: false } });
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: true, how: "asked" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.form.message).not.toMatch(/\n/);
    expect(Object.keys(asked[0]!.form.requestedSchema.properties)).toEqual(["dontAskAgain"]);
    expect(asked[0]!.form.requestedSchema.properties.dontAskAgain).toMatchObject({ type: "boolean", default: false });
    expect(asked[0]!.timeoutMs).toBe(ASK_TIMEOUT_MS);
  });

  it("asks again next time when the box was left unticked", async () => {
    const { ctx, asked } = answering({ action: "accept", content: { dontAskAgain: false } });
    await runWithAskContext(ctx, askToTakeForeground);
    await runWithAskContext(ctx, askToTakeForeground);
    expect(asked).toHaveLength(2);
  });

  it("remembers 'Don't ask again' and does not ask the next time", async () => {
    const first = answering({ action: "accept", content: { dontAskAgain: true } });
    await runWithAskContext(first.ctx, askToTakeForeground);
    const second = answering({ action: "decline" });
    expect(await runWithAskContext(second.ctx, askToTakeForeground)).toEqual({ allowed: true, how: "remembered" });
    expect(second.asked).toHaveLength(0);
  });

  it.each([
    [{ action: "decline" as const }, "declined"],
    [{ action: "cancel" as const }, "cancelled"],
    [new Error("MCP error -32001: Request timed out"), "timed_out"],
    [new Error("Client does not support form elicitation."), "cannot_ask"],
  ])("says no, and why, for %o", async (answer, why) => {
    const { ctx } = answering(answer);
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: false, why });
  });

  it("does not remember a box ticked on a Decline", async () => {
    const { ctx } = answering({ action: "decline", content: { dontAskAgain: true } });
    await runWithAskContext(ctx, askToTakeForeground);
    const next = answering({ action: "decline" });
    expect((await runWithAskContext(next.ctx, askToTakeForeground)).allowed).toBe(false);
  });

  it("says cannot_ask when the call has no way to ask (a transport that cannot carry the question)", async () => {
    expect(await runWithAskContext(null, askToTakeForeground)).toEqual({ allowed: false, why: "cannot_ask" });
    expect(await askToTakeForeground()).toEqual({ allowed: false, why: "cannot_ask" });
  });

  it("allows without asking when DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND=1", async () => {
    process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND = "1";
    const { ctx, asked } = answering({ action: "decline" });
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: true, how: "env" });
    expect(asked).toHaveLength(0);
  });

  it("lets a nested call inherit the outer call's way to ask", async () => {
    const { ctx } = answering({ action: "accept", content: { dontAskAgain: false } });
    const nested = await runWithAskContext(ctx, () => runWithAskContext(undefined, askToTakeForeground));
    expect(nested.allowed).toBe(true);
  });
});
