/**
 * tests/unit/post-failure-perception.test.ts
 * Verifies that _post.ts attaches post.perception on ok:false responses
 * when _perceptionForPost is present (A-8 requirement, 4 cases).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OS-dependent calls in _post.ts
const { mockSnapshotFocus, mockSnapshotFocusedElement } = vi.hoisted(() => ({
  mockSnapshotFocus: vi.fn(),
  mockSnapshotFocusedElement: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  getWindowProcessId: vi.fn(() => null),
  getProcessIdentityByPid: vi.fn(() => null),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getFocusedAndPointInfo: vi.fn().mockResolvedValue(null),
}));

import { withPostState } from "../../src/tools/_post.js";
import { ok } from "../../src/tools/_types.js";
import { fail } from "../../src/tools/_types.js";

// Patch internal snapshotFocus by mocking win32 — let _post.ts call it naturally.
// Instead, test the output shape.

describe("_post.ts failure path perception attachment", () => {
  it("attaches post.perception on ok:false when _perceptionForPost present", async () => {
    const guardSummary = { kind: "auto", status: "unsafe_coordinates", canContinue: false, next: "Out of bounds" };
    const handler = async (_args: Record<string, unknown>) => {
      return fail({
        ok: false,
        code: "AutoGuardBlocked" as import("../../src/tools/_errors.js").ToolErrorCode,
        error: "mouse_click failed: AutoGuardBlocked",
        _perceptionForPost: guardSummary,
      } as Record<string, unknown> & { ok: false; code: import("../../src/tools/_errors.js").ToolErrorCode; error: string });
    };

    const wrapped = withPostState("mouse_click", handler);
    const result = await wrapped({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      post?: { perception?: { kind: string; status: string } };
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.post).toBeDefined();
    expect(parsed.post?.perception?.kind).toBe("auto");
    expect(parsed.post?.perception?.status).toBe("unsafe_coordinates");
  });

  it("does NOT add post.perception when _perceptionForPost absent on failure", async () => {
    const handler = async (_args: Record<string, unknown>) => {
      return fail({
        ok: false,
        code: "ToolError" as import("../../src/tools/_errors.js").ToolErrorCode,
        error: "mouse_click failed: something",
      });
    };

    const wrapped = withPostState("mouse_click", handler);
    const result = await wrapped({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      post?: unknown;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.post).toBeUndefined();
  });

  it("success path still works (existing success path non-breaking)", async () => {
    const handler = async (_args: Record<string, unknown>) => ok({ ok: true, action: "click" });
    const wrapped = withPostState("mouse_click", handler);
    const result = await wrapped({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      post?: { focusedWindow: unknown };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.post).toBeDefined();
    expect("focusedWindow" in (parsed.post ?? {})).toBe(true);
  });

  it("strips _perceptionForPost key from failure response body", async () => {
    const guardSummary = { kind: "auto", status: "identity_changed", canContinue: false, next: "Window replaced" };
    const handler = async (_args: Record<string, unknown>) => {
      return fail({
        ok: false,
        code: "AutoGuardBlocked" as import("../../src/tools/_errors.js").ToolErrorCode,
        error: "keyboard_type failed",
        _perceptionForPost: guardSummary,
      } as Record<string, unknown> & { ok: false; code: import("../../src/tools/_errors.js").ToolErrorCode; error: string });
    };

    const wrapped = withPostState("keyboard_type", handler);
    const result = await wrapped({});
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;

    expect("_perceptionForPost" in parsed).toBe(false);
    expect((parsed.post as Record<string, unknown> | undefined)?.perception).toBeDefined();
  });
});
