/**
 * notification-hint.test.ts — Unit pin for J1 (Phase 3a G1 fix).
 *
 * Pins the matrix §3.1 line 158 規範 contract that `notification_show`
 * MUST return `hints.verifyDelivery: { status: "unverifiable", reason:
 * "user_visible_side_effect_uninspectable", channel: "win32_balloon_tip" }`
 * on every successful response, since toast user reach is observably
 * unverifiable (Focus Assist / Notifications-off / consent UI sink — all
 * indistinguishable from the tool side).
 *
 * Pre-fix (before this PR), the handler returned `ok({ ok: true, title,
 * body })` with no hints field — silent-success regression risk per
 * Phase 3a doc audit G1 finding (audit doc:
 * `docs/llm-audit/phase3a-doc-audit.md` §3 G1).
 *
 * The PowerShell spawn is mocked via vi.mock("node:child_process") so the
 * test is hermetic and does not actually display a balloon tip in CI /
 * local runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock node:child_process before importing the handler so notificationShowHandler
// picks up the stub. The handler uses execFile from this module.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { notificationShowHandler } from "../../src/tools/notification.js";

function parseResult(r: { content: { type: string; text: string }[] }): {
  ok: boolean;
  title?: string;
  body?: string;
  hints?: {
    verifyDelivery?: {
      status?: string;
      reason?: string;
      channel?: string;
    };
  };
  error?: string;
  code?: string;
} {
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Stub execFile to fire `spawn` immediately and call back without error.
  // The handler's awaited Promise resolves on `spawn` event (handler
  // unrefs the child for fire-and-forget). Returning a fake child with
  // unref + on(spawn) emission satisfies the contract.
  vi.mocked(execFile).mockImplementation(((..._args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    // Emit `spawn` asynchronously so the handler's `child.on("spawn", ...)`
    // listener is attached before the event fires.
    setImmediate(() => child.emit("spawn"));
    return child as unknown;
  }) as unknown as typeof execFile);
});

describe("J1: notification_show verifyDelivery hint contract pin (matrix §3.1 line 158)", () => {
  it("returns hints.verifyDelivery: 'unverifiable' on successful spawn", async () => {
    const r = parseResult(
      await notificationShowHandler({ title: "Test", body: "body content" })
    );

    expect(r.ok).toBe(true);
    expect(r.title).toBe("Test");
    expect(r.body).toBe("body content");
    // Critical contract: matrix §3.1 line 158 規範
    expect(r.hints).toBeDefined();
    expect(r.hints?.verifyDelivery).toBeDefined();
    expect(r.hints?.verifyDelivery?.status).toBe("unverifiable");
    expect(r.hints?.verifyDelivery?.reason).toBe(
      "user_visible_side_effect_uninspectable"
    );
    expect(r.hints?.verifyDelivery?.channel).toBe("win32_balloon_tip");
  });

  it("hint shape is identical for any title/body inputs (no caller-controlled drift)", async () => {
    const r1 = parseResult(
      await notificationShowHandler({ title: "A", body: "1" })
    );
    const r2 = parseResult(
      await notificationShowHandler({ title: "Long title with 日本語 + 🎉", body: "Long body" })
    );

    // Both successful responses carry the same hint shape — caller cannot
    // suppress / customise the verifyDelivery degradation.
    expect(r1.hints?.verifyDelivery).toEqual(r2.hints?.verifyDelivery);
  });

  it("hint absent on spawn failure (failWith path emits ok:false envelope, not silent ok:true)", async () => {
    // Override execFile to reject with spawn error.
    vi.mocked(execFile).mockImplementation(((..._args: unknown[]) => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      setImmediate(() => child.emit("error", new Error("spawn powershell.exe ENOENT")));
      return child as unknown;
    }) as unknown as typeof execFile);

    const r = parseResult(
      await notificationShowHandler({ title: "Test", body: "body" })
    );

    expect(r.ok).toBe(false);
    // failWith routes through generic ToolError classification — confirm
    // verifyDelivery hint is NOT spuriously emitted on failure path.
    expect(r.hints).toBeUndefined();
    expect(typeof r.error).toBe("string");
  });
});
