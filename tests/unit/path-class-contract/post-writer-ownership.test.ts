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
 * Contract:
 *   - obj.post (container) + obj.post.{focusedWindow, focusedElement,
 *     windowChanged, elapsedMs}  → withPostState ONLY (wrapper before/after
 *     focus snapshot; a handler / failure presenter has no such snapshot).
 *   - obj.post.perception          → withPostState ONLY (moved from the root
 *     `_perceptionForPost` marker, then deleted — both success & failure).
 *   - obj.post.rich                → COORDINATED two writers (NOT single-writer):
 *     withPostState (from the `_richForPost` marker, success, takes precedence) +
 *     spliceRich (`_narration.ts` via withRichNarration, UIA diff, success-only,
 *     guarded by `post.rich !== undefined`). spliceRich coordination is pinned in
 *     rich-narration-edge / uia-diff tests; here we only pin the withPostState
 *     half. This file therefore does NOT claim single-writer for post.rich.
 *   - root temp markers (hoisted to ROOT via ROOT_HOISTED_KEYS, never `context`):
 *     `_perceptionForPost` consumed+deleted on both branches; `_richForPost`
 *     consumed+deleted on SUCCESS only (failure branch leaves it — latent,
 *     currently unreachable); `hints` hoisted but NOT consumed (stays at root).
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
import { getFocusedAndPointInfo } from "../../../src/engine/uia-bridge.js";

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

  // withPostState owns the `_richForPost` marker → post.rich move (success). It is
  // NOT the only writer of post.rich — spliceRich (_narration.ts) is the other,
  // guarded writer; that coordination is pinned in rich-narration-edge/uia-diff
  // tests. Here we pin only the marker-move half.
  it("_richForPost → post.rich via withPostState + marker deleted (success)", async () => {
    const rich = { appeared: [{ name: "btn" }] };
    const parsed = parse(
      await withPostState("browser_click", async () => ok({ ok: true, _richForPost: rich }))({}),
    );
    expect("_richForPost" in parsed).toBe(false);
    expect((parsed.post as Record<string, unknown>).rich).toEqual(rich);
  });

  it("_perceptionForPost → post.perception + marker deleted (failure), no stray fields", async () => {
    const env = { kind: "auto", status: "unsafe_coordinates", next: "x" };
    const parsed = parse(
      await withPostState(
        "mouse_click",
        async () =>
          fail({ ok: false, code: "AutoGuardBlocked", error: "e", _perceptionForPost: env } as never),
      )({}),
    );
    expect("_perceptionForPost" in parsed).toBe(false);
    const post = parsed.post as Record<string, unknown>;
    expect(post.perception).toEqual(env);
    // Complement: exactly the 4 snapshot fields + perception, and NO rich leaked in.
    expect(Object.keys(post).sort()).toEqual([
      "elapsedMs",
      "focusedElement",
      "focusedWindow",
      "perception",
      "windowChanged",
    ]);
    expect("rich" in post).toBe(false);
  });
});

// ── ROOT_HOISTED_KEYS asymmetries (Round 1 Opus P2): hints + _richForPost ──────

describe("PR-P2-1: ROOT_HOISTED_KEYS asymmetries", () => {
  it("hints is hoisted to root but NOT consumed/moved into post (failure)", async () => {
    const handler = async () =>
      failWith(new Error("AutoGuardBlocked"), "keyboard", {
        hints: { verifyDelivery: true },
        _perceptionForPost: { kind: "auto", status: "ok", next: "x" },
      });
    const parsed = parse(await withPostState("keyboard", handler)({}));
    // hints stays at the response root (issue #181 symmetry), not folded into post.
    expect(parsed.hints).toEqual({ verifyDelivery: true });
    expect((parsed.post as Record<string, unknown>).hints).toBeUndefined();
  });

  it("failure carrying only _richForPost leaves the marker at root (failure branch does not consume it)", async () => {
    // Current-behavior pin: the failure branch is gated on _perceptionForPost, so a
    // failure with only _richForPost gets neither a post block nor marker cleanup.
    // Latent / currently unreachable — browser handlers attach _richForPost on ok:true only.
    const rich = { appeared: [{ name: "btn" }] };
    const handler = async () => fail({ ok: false, code: "ToolError", error: "e", _richForPost: rich } as never);
    const parsed = parse(await withPostState("browser_click", handler)({}));
    expect("post" in parsed).toBe(false);
    expect(parsed._richForPost).toEqual(rich); // not consumed on the failure branch
  });
});

// ── B′ presenter routing: the PR-P2-3 codemod safety contract (§5 R1) ──────────
//
// PR-P2-3 rewrites failWith callsites to go through `toToolFailure(errorFromMessage(...))`.
// That route MUST keep placing `_perceptionForPost` at the ROOT (via
// ROOT_HOISTED_KEYS), because withPostState only looks at the root. If a future
// change pushed it under `context`, post.perception would silently vanish.

// ── ADR-022 / #352: obj.advisory is a withPostState success-only writer ───────

describe("ADR-022: obj.advisory owned by withPostState (success only)", () => {
  const editFocus = { focused: { name: "Editor", controlType: "Edit", value: "old" } };

  it("sets root obj.advisory for keyboard(type) when the focused element is a UIA text input", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(editFocus as never);
    const parsed = parse(
      await withPostState("keyboard", async () => ok({ ok: true, method: "background" }))(
        { action: "type", windowTitle: "メモ帳", text: "hi" },
      ),
    );
    const advisory = parsed.advisory as Record<string, unknown> | undefined;
    expect(advisory).toBeDefined();
    expect(advisory!.preferredPath).toBe("desktop_act");
    expect(String(advisory!.example)).toContain("windowTitle:'メモ帳'");
    // advisory is a ROOT sibling of post — not nested inside post
    expect((parsed.post as Record<string, unknown>).advisory).toBeUndefined();
  });

  it("does NOT set advisory when the focused element is not a text input", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce({ focused: { name: "Canvas", controlType: "Pane" } } as never);
    const parsed = parse(
      await withPostState("keyboard", async () => ok({ ok: true }))({ action: "type", text: "hi" }),
    );
    expect("advisory" in parsed).toBe(false);
  });

  it("never sets advisory on the failure branch (even with a qualifying focused element)", async () => {
    vi.mocked(getFocusedAndPointInfo).mockResolvedValueOnce(editFocus as never);
    const parsed = parse(
      await withPostState("keyboard", async () => fail({ ok: false, code: "ToolError", error: "e" }))(
        { action: "type", text: "hi" },
      ),
    );
    expect(parsed.ok).toBe(false);
    expect("advisory" in parsed).toBe(false);
  });
});

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
