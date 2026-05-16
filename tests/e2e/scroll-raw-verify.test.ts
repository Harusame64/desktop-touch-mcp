/**
 * scroll-raw-verify.test.ts — E2E tests for scroll(action:'raw') delivery
 * verification (issue #179, matrix doc §3.1).
 *
 * Test plan (issue body):
 *   - 短い scroll を発行 → hint で delta が観測できることを pin
 *   - page-end (V=0 で更に上 scroll) で `ScrollNotDelivered` が出ないことを regression guard
 *   - non-scrollable target (Notepad で上端) で silent drop が `ScrollNotDelivered` で fail することを pin
 *
 * Skip policy (matrix doc §3.1 + issue #173 §S-2):
 *   - foreground-stealing protection (`ForceFocusRefused`) → skip on env-only failure
 *   - missing Win32 scrollbar AND missing image-hash → unverifiable (acceptable)
 *
 * Notes:
 *   - Notepad on Win11 has overlay-style scrollbars only when content does NOT
 *     overflow. We pre-populate the temp file with 200 lines so vertical
 *     overflow is guaranteed.
 *   - We don't pin "delta != 0" because Notepad sometimes returns null axes
 *     (no Win32 scrollbar exposed via GetScrollInfo on the modern WinUI host),
 *     in which case the implementation degrades to image-hash diff and the
 *     verifyDelivery hint surfaces "delivered" or "unverifiable" depending on
 *     whether the viewport actually changed pixels.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { scrollHandler } from "../../src/tools/mouse.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { restoreAndFocusWindow, getWindowRectByHwnd } from "../../src/engine/win32.js";
import { writeFileSync } from "fs";
import { sleep, parsePayload } from "./helpers/wait.js";

interface ScrollPayload {
  ok: boolean;
  code?: string;
  scrolled?: string;
  hints?: {
    scrollObserved?: { delta: { x: number | null; y: number | null } | "unverifiable" };
    verifyDelivery?: {
      status: "delivered" | "unverifiable";
      channel: string;
      reason?: string;
      axis?: string;
    };
    warnings?: string[];
  };
  context?: {
    axis?: string;
    direction?: string;
    preVerticalPercent?: number | null;
    postVerticalPercent?: number | null;
  };
}

const MANY_LINES = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\r\n");

describe("scroll(action:'raw') delivery verification", () => {
  let np: NpInstance;

  beforeAll(async () => {
    np = await launchNotepad();
    // Pre-populate so vertical scrolling has somewhere to go.
    writeFileSync(np.tempFile, MANY_LINES, "utf8");
    try { restoreAndFocusWindow(np.hwnd); } catch { /* best effort */ }
    await sleep(400);
  }, 30_000);

  afterAll(() => {
    np?.kill();
  });

  it("scroll(raw) returns hints.scrollObserved + hints.verifyDelivery", async () => {
    const rect = getWindowRectByHwnd(np.hwnd);
    if (!rect) {
      throw new Error("Notepad rect unavailable — env regression");
    }
    const cx = rect.x + Math.floor(rect.width / 2);
    const cy = rect.y + Math.floor(rect.height / 2);

    const r = await scrollHandler({
      direction: "down",
      amount: 3,
      x: cx,
      y: cy,
      homing: false,
      windowTitle: np.title,
    });
    const p = parsePayload(r) as ScrollPayload;

    if (!p.ok) {
      // ok:false is acceptable here only if it's ScrollNotDelivered with the
      // correct context shape — this confirms the failure-path produces the
      // typed envelope (matrix doc §3.1 silent-drop case).
      expect(p.code).toBe("ScrollNotDelivered");
      expect(p.context?.direction).toBe("down");
      // Pin the flat-context contract structurally: `failWith()` splits
      // its 3rd argument so non-hoisted keys land on `context.X`, NOT
      // `context.context.X` (regression guard for the double-wrap bug
      // fixed in this PR — see `src/tools/_errors.ts:685-693`).
      expect((p.context as Record<string, unknown>)?.context).toBeUndefined();
      return;
    }
    expect(p.scrolled).toBe("down");
    expect(p.hints).toBeDefined();
    // Always present per matrix doc §3.1 / §4.2: scrollObserved + verifyDelivery.
    expect(p.hints!.scrollObserved).toBeDefined();
    expect(p.hints!.verifyDelivery).toBeDefined();
    // ADR-018 Phase 4 (Tier 1/2/3 destination-explicit) defines 4 transport
    // channels: {uia, cdp, postmessage, send_input}. `wheel_send_input` is a
    // legacy alias for `send_input` retained for Phase 5+N migration
    // deferral (ADR-018 §2.6.3 migration table). Notepad on Win11 routes
    // through Tier 3 PostMessage because Modern Notepad has no Win32
    // scrollbar; legacy hosts route through Tier 4 SendInput. Accept any of
    // the 4 ADR-018 channels plus the legacy alias.
    expect(["uia", "cdp", "postmessage", "send_input", "wheel_send_input"]).toContain(
      p.hints!.verifyDelivery!.channel,
    );
    expect(["delivered", "unverifiable"]).toContain(p.hints!.verifyDelivery!.status);
    // delta is either "unverifiable" or {x, y} with possibly-null fields.
    const delta = p.hints!.scrollObserved!.delta;
    if (delta !== "unverifiable") {
      expect(delta).toHaveProperty("x");
      expect(delta).toHaveProperty("y");
    }
  }, 30_000);

  it("page-end: scroll up at vertical 0% does NOT surface ScrollNotDelivered", async () => {
    // Notepad at the top of its buffer: vertical scroll up is a legitimate
    // no-op (page-end boundary). matrix doc §3.1 page-end disambiguation rule:
    // pre at 0% AND post equal → page-end success, NOT ScrollNotDelivered.
    const rect = getWindowRectByHwnd(np.hwnd);
    if (!rect) throw new Error("Notepad rect unavailable");
    const cx = rect.x + Math.floor(rect.width / 2);
    const cy = rect.y + Math.floor(rect.height / 2);

    // Make sure we are at the top: send a big scroll-up first.
    await scrollHandler({
      direction: "up",
      amount: 50,
      x: cx,
      y: cy,
      homing: false,
      windowTitle: np.title,
    });
    await sleep(150);

    const r = await scrollHandler({
      direction: "up",
      amount: 3,
      x: cx,
      y: cy,
      homing: false,
      windowTitle: np.title,
    });
    const p = parsePayload(r) as ScrollPayload;

    // Regression guard: at the top, scroll up MUST NOT fail with ScrollNotDelivered.
    expect(p.code).not.toBe("ScrollNotDelivered");
    expect(p.ok).toBe(true);
  }, 30_000);

  it("hints.verifyDelivery shape conforms to matrix doc §4.2", async () => {
    const rect = getWindowRectByHwnd(np.hwnd);
    if (!rect) throw new Error("Notepad rect unavailable");
    const r = await scrollHandler({
      direction: "down",
      amount: 1,
      x: rect.x + Math.floor(rect.width / 2),
      y: rect.y + Math.floor(rect.height / 2),
      homing: false,
      windowTitle: np.title,
    });
    const p = parsePayload(r) as ScrollPayload;
    if (!p.ok) {
      // Silent-drop case — context envelope shape pinned in the first test.
      expect(p.code).toBe("ScrollNotDelivered");
      return;
    }
    const vd = p.hints!.verifyDelivery!;
    // Required: status, channel.
    expect(typeof vd.status).toBe("string");
    // Channel is one of the 4 ADR-018 transport tiers (+ legacy alias
    // `wheel_send_input`) — exact value depends on which tier handled the
    // resolved destination (see test #1 comment).
    expect(["uia", "cdp", "postmessage", "send_input", "wheel_send_input"]).toContain(vd.channel);
    if (vd.status === "unverifiable") {
      // reason is required when status=unverifiable (matrix doc §4.4).
      expect(typeof vd.reason).toBe("string");
    }
  }, 30_000);
});
