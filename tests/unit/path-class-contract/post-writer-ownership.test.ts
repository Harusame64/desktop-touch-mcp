/**
 * tests/unit/path-class-contract/post-writer-ownership.test.ts
 * — ADR-021 Phase 2 PR-P2-1 (Plan: desktop-touch-mcp-internal §3.3.2 PR-P2-1, OQ-2(a)).
 *
 * Machine-pins the FIELD-LEVEL writer ownership of the `post` block so the
 * PR-P2-3 `failWith` → presenter codemod cannot silently create a double-attach
 * or sever post-perception recovery (§5 R1). Complements (does not duplicate)
 * `tests/unit/post-failure-perception.test.ts`, which pins the perception-attach
 * BEHAVIOUR; this file pins the OWNERSHIP contract + the B′ presenter routing.
 *
 * Contract (one writer per field):
 *   - obj.post (container) + obj.post.{focusedWindow, focusedElement,
 *     windowChanged, elapsedMs}  → withPostState ONLY (wrapper before/after
 *     focus snapshot; a handler / failure presenter has no such snapshot).
 *   - obj.post.perception          → withPostState ONLY (moved from the root
 *     `_perceptionForPost` marker, then the marker is deleted).
 *   - obj.post.rich                → withPostState ONLY (moved from the root
 *     `_richForPost` marker, then deleted; success path only).
 *   - obj._perceptionForPost / obj._richForPost (root temp markers) → written by
 *     the HANDLER (success) or `toToolFailure` / `failWith` (failure), always at
 *     the response ROOT (ROOT_HOISTED_KEYS) — never under `context`.
 *
 * @see src/tools/_post.ts withPostState
 * @see src/tools/_errors.ts errorFromMessage / toToolFailure / failWith / ROOT_HOISTED_KEYS
 */

import { describe, it, expect, vi } from "vitest";

// Decouple the wrapper's focus snapshot from the real desktop so post.* snapshot
// fields are deterministic (focusedWindow=null, windowChanged=false) — same
// mocking the existing _post.ts unit test uses.
vi.mock("../../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  getWindowProcessId: vi.fn(() => null),
  getProcessIdentityByPid: vi.fn(() => null),
}));
vi.mock("../../../src/engine/uia-bridge.js", () => ({
  getFocusedAndPointInfo: vi.fn().mockResolvedValue(null),
}));

import { withPostState } from "../../../src/tools/_post.js";
import { ok, fail } from "../../../src/tools/_types.js";
import { errorFromMessage, toToolFailure, failWith } from "../../../src/tools/_errors.js";

function parse(result: { content: ReadonlyArray<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

// ── obj.post container + snapshot fields: withPostState is the sole writer ─────

describe("PR-P2-1: obj.post container + snapshot fields owned by withPostState", () => {
  it("withPostState — not the handler — produces obj.post with exactly the 4 snapshot fields (success)", async () => {
    const handlerOut: Record<string, unknown> = { ok: true, action: "click" };
    expect("post" in handlerOut).toBe(false); // the handler never writes post

    const result = await withPostState("mouse_click", async () => ok(handlerOut))({});
    const post = parse(result).post as Record<string, unknown>;

    expect(post).toBeDefined();
    // Exactly the snapshot field set — no perception/rich because no marker present.
    expect(Object.keys(post).sort()).toEqual([
      "elapsedMs",
      "focusedElement",
      "focusedWindow",
      "windowChanged",
    ]);
    // Values come from the wrapper's (mocked) snapshot, not from handler data.
    expect(post.focusedWindow).toBeNull();
    expect(post.focusedElement).toBeNull();
    expect(post.windowChanged).toBe(false);
    expect(typeof post.elapsedMs).toBe("number");
  });

  it("failures stay pristine — no obj.post when no perception marker is present", async () => {
    const result = await withPostState(
      "mouse_click",
      async () => fail({ ok: false, code: "ToolError", error: "x" }),
    )({});
    const parsed = parse(result);
    expect(parsed.ok).toBe(false);
    expect("post" in parsed).toBe(false);
  });
});

// ── temp markers: moved into post.* and DELETED (no double-attach possible) ────

describe("PR-P2-1: root temp markers moved to post.* then deleted", () => {
  it("_perceptionForPost → post.perception + marker deleted (success)", async () => {
    const env = { kind: "auto", status: "ok", target: "win:notepad" };
    const parsed = parse(
      await withPostState("mouse_click", async () => ok({ ok: true, _perceptionForPost: env }))({}),
    );
    expect("_perceptionForPost" in parsed).toBe(false); // consumed → can't be moved twice
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });

  it("_richForPost → post.rich + marker deleted (success)", async () => {
    const rich = { appeared: [{ name: "btn" }] };
    const parsed = parse(
      await withPostState("browser_click", async () => ok({ ok: true, _richForPost: rich }))({}),
    );
    expect("_richForPost" in parsed).toBe(false);
    expect((parsed.post as Record<string, unknown>).rich).toEqual(rich);
  });

  it("_perceptionForPost → post.perception + marker deleted (failure)", async () => {
    const env = { kind: "auto", status: "unsafe_coordinates", next: "x" };
    const parsed = parse(
      await withPostState(
        "mouse_click",
        async () =>
          fail({ ok: false, code: "AutoGuardBlocked", error: "e", _perceptionForPost: env } as never),
      )({}),
    );
    expect("_perceptionForPost" in parsed).toBe(false);
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });
});

// ── B′ presenter routing: the PR-P2-3 codemod safety contract (§5 R1) ──────────
//
// PR-P2-3 rewrites failWith callsites to go through `toToolFailure(errorFromMessage(...))`.
// That route MUST keep placing `_perceptionForPost` at the ROOT (via
// ROOT_HOISTED_KEYS), because withPostState only looks at the root. If a future
// change pushed it under `context`, post.perception would silently vanish.

describe("PR-P2-1: B′ presenter routes _perceptionForPost to ROOT (R1 codemod safety)", () => {
  const env = { kind: "auto", status: "needs_escalation", next: "re-focus and retry" };

  it("toToolFailure(errorFromMessage(...,{_perceptionForPost})) places the marker at root, not under context", () => {
    const failure = toToolFailure(
      errorFromMessage(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", {
        _perceptionForPost: env,
        lensId: "lens-1",
      }),
    );
    expect(failure._perceptionForPost).toEqual(env); // root placement (load-bearing)
    const ctx = failure.context as Record<string, unknown> | undefined;
    expect(ctx?._perceptionForPost).toBeUndefined(); // never nested
    expect(ctx?.lensId).toBe("lens-1"); // ordinary keys stay nested
  });

  it("a handler returning fail(toToolFailure(...)) gets post.perception attached by withPostState", async () => {
    const handler = async () =>
      fail(
        toToolFailure(
          errorFromMessage(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", {
            _perceptionForPost: env,
          }),
        ),
      );
    const parsed = parse(await withPostState("keyboard", handler)({}));
    expect(parsed.ok).toBe(false);
    expect("_perceptionForPost" in parsed).toBe(false); // consumed by the wrapper
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });

  it("legacy failWith routes identically — both keep the post.perception path intact", async () => {
    const handler = async () =>
      failWith(new Error("AutoGuardBlocked: needs_escalation"), "keyboard", { _perceptionForPost: env });
    const parsed = parse(await withPostState("keyboard", handler)({}));
    expect((parsed.post as Record<string, unknown>).perception).toEqual(env);
  });
});
