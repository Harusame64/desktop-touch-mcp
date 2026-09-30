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
  askToTakeForeground, foregroundQuestion, runWithAskContext, ASK_TIMEOUT_MS,
  type AskContext, type AskForm,
} from "../../src/tools/_ask-user.js";

/** `readMs`: how long the person took (a cancel sooner than INSTANT_CANCEL_MS is a client that cannot ask). */
const answering = (answer: Awaited<ReturnType<AskContext["ask"]>> | Error, readMs = 0) => {
  const asked: Array<{ form: AskForm; timeoutMs: number }> = [];
  const ctx: AskContext = {
    ask: vi.fn(async (form, timeoutMs) => {
      asked.push({ form, timeoutMs });
      if (readMs > 0) vi.spyOn(Date, "now").mockReturnValue(Date.now() + readMs);
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  return { ctx, asked };
};

beforeEach(() => {
});
afterEach(() => { vi.restoreAllMocks(); });

describe("askToTakeForeground", () => {
  it("allows on Accept, and asks one line with one ticked 'Type it' box and its own timeout", async () => {
    const { ctx, asked } = answering({ action: "accept", content: { typeIt: true } });
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.form.message).not.toMatch(/\n/);
    expect(Object.keys(asked[0]!.form.requestedSchema.properties)).toEqual(["typeIt"]);
    expect(asked[0]!.form.requestedSchema.properties.typeIt).toMatchObject({ type: "boolean", default: true });
    expect(asked[0]!.timeoutMs).toBe(ASK_TIMEOUT_MS);
  });

  it.each([
    [{ action: "decline" as const }, "declined"],
    [{ action: "cancel" as const }, "cancelled"],
    [new Error("MCP error -32001: Request timed out"), "timed_out"],
    [new Error("The tool call was cancelled while the question was up"), "cancelled"],
    [new Error("Client does not support form elicitation."), "cannot_ask"],
  ])("says no, and why, for %o", async (answer, why) => {
    const { ctx } = answering(answer, 8_000);
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: false, why });
  });

  it("says cannot_ask when the call has no way to ask (a transport that cannot carry the question)", async () => {
    expect(await runWithAskContext(null, askToTakeForeground)).toEqual({ allowed: false, why: "cannot_ask" });
    expect(await askToTakeForeground()).toEqual({ allowed: false, why: "cannot_ask" });
  });

  it("lets a nested call inherit the outer call's way to ask", async () => {
    const { ctx } = answering({ action: "accept", content: { typeIt: true } });
    const nested = await runWithAskContext(ctx, () => runWithAskContext(undefined, askToTakeForeground));
    expect(nested.allowed).toBe(true);
  });

  it("reads a cancel too quick for anyone to have read the question (claude -p: 4 ms) as cannot_ask", async () => {
    const { ctx } = answering({ action: "cancel" });
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: false, why: "cannot_ask" });
  });

  it("names the text and the window in the question, cut short to keep one line", () => {
    expect(foregroundQuestion({})).toBe("Type into Windows Terminal? Takes the foreground ~0.1 s.");
    const long = foregroundQuestion({ text: "x".repeat(100), windowTitle: "y".repeat(100) });
    expect(long).toMatch(/^Type "x{19}…" into Windows Terminal \(y{15}…\)\?/);
    expect(long.length).toBeLessThanOrEqual(100);
  });

  it("says no when the user unticked \"Type it\" and accepted", async () => {
    const { ctx } = answering({ action: "accept", content: { typeIt: false } }, 8_000);
    expect(await runWithAskContext(ctx, askToTakeForeground)).toEqual({ allowed: false, why: "declined" });
  });

  it("has no way to allow without asking: the old env var is ignored", async () => {
    process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND = "1";
    try {
      const { ctx, asked } = answering({ action: "decline" }, 8_000);
      expect((await runWithAskContext(ctx, askToTakeForeground)).allowed).toBe(false);
      expect(asked).toHaveLength(1);
    } finally {
      delete process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND;
    }
  });
});
