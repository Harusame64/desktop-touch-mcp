/**
 * G1 (ADR-036 §10) — a `stale` target is read again before it is pressed, and refused when its label
 * is no longer there. The user's decision of 2026-09-23, "Re-read, then refuse".
 *
 * MEASURED BEFORE THIS, win2, 2026-09-23 on `main` `5163932c` (internal `ea46fd9`), three arms:
 *   - A: a painted label repainted after the read (PAINTED-A → PAINTED-X), handed back `stale` by
 *     the visual lane — pressed at its remembered place, `ok:true`, and the fixture logged a click
 *     on PAINTED-X. **The one this refuses.**
 *   - X: the new label, `observed` — pressed. Still pressed: nothing here reads an observed entity.
 *   - R: `stale`, but the label is still on screen (a window with real buttons, so the OCR lane had
 *     stopped on `uia_not_blind`) — pressed. Still pressed: the read finds the label.
 *
 * The cells name the three arms. What can only be measured on the machine — that the real OCR reads
 * PAINTED-A in R's place and PAINTED-X in A's — is win2's round after this branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StaleRereadAnswer, TouchEnvironment, WindowBlockAnswer } from "../../src/engine/world-graph/guarded-touch.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { UiEntityCandidate, Rect } from "../../src/engine/vision-gpu/types.js";
import type { Aim, WindowIdentity } from "../../src/engine/aim.js";

const GEN = "gen-1";

function entity(opts: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "painted-a",
    role: "button",
    label: "PAINTED-A",
    confidence: 0.8,
    sources: ["visual_gpu"],
    status: "stale",
    affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.8, preconditions: [], postconditions: [] }],
    generation: GEN,
    evidenceDigest: "d-a",
    rect: { x: 354, y: 227, width: 144, height: 20 },
    ...opts,
  };
}

let dir: string;
let logPath: string;
const rows = (): Record<string, unknown>[] =>
  existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const staleRows = () => rows().filter((r) => r.seam === "act.stale");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stale-reread-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

interface LoopOpts {
  reread?: TouchEnvironment["rereadStale"];
  window?: WindowBlockAnswer;
  /** Runs inside the read, to move the world while the loop awaits it. */
  during?: () => void;
}

async function touch(target: UiEntity, opts: LoopOpts = {}) {
  const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
  const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
  let gen = GEN;
  const snapshot = [target];
  const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
  const lease = store.issue(target, "v1");
  const execute = vi.fn(async () => "mouse" as const);
  const reread = opts.reread ? vi.fn(async (e: UiEntity) => {
    opts.during?.();
    return opts.reread!(e);
  }) : undefined;
  const env: TouchEnvironment = {
    resolveLiveEntities: () => snapshot,
    currentGeneration: () => gen,
    isModalBlocking: () => false,
    findBlockingModal: () => null,
    checkViewport: () => null,
    execute,
    resolvePostTouchEntities: async () => snapshot,
    ...(opts.window !== undefined && { findBlockingWindow: () => opts.window! }),
    ...(reread && { rereadStale: reread }),
  };
  const moveGeneration = () => { gen = "gen-2"; };
  const loop = new GuardedTouchLoop(store, env);
  return { loop, lease, execute, reread, moveGeneration };
}

const answer = (a: StaleRereadAnswer) => async () => a;

describe("the loop: a stale target is read again before the press", () => {
  it("A — the label is not there: refused as entity_not_found, with a detail, and nothing is pressed", async () => {
    const { loop, lease, execute } = await touch(entity(), { reread: answer({ kind: "absent" }) });
    const result = await loop.touch({ lease });
    expect(result).toMatchObject({ ok: false, reason: "entity_not_found", diff: [] });
    expect((result as { detail?: string }).detail).toMatch(/handed back from an earlier read/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("R — the label is still there: pressed", async () => {
    const { loop, lease, execute, reread } = await touch(entity(), { reread: answer({ kind: "present" }) });
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("X — an observed target is not read: pressed without asking", async () => {
    const { loop, lease, execute, reread } = await touch(entity({ status: "observed", sources: ["ocr"] }), { reread: answer({ kind: "absent" }) });
    const result = await loop.touch({ lease });
    expect(result.ok).toBe(true);
    expect(reread).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a target with no status (no lane said) is not read", async () => {
    const { loop, lease, execute, reread } = await touch(entity({ status: undefined }), { reread: answer({ kind: "absent" }) });
    expect((await loop.touch({ lease })).ok).toBe(true);
    expect(reread).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a read that cannot answer does not refuse: pressed, as before G1 (the 09-11 rule)", async () => {
    const { loop, lease, execute } = await touch(entity(), { reread: answer({ kind: "cannot_say", why: "read_failed" }) });
    expect((await loop.touch({ lease })).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a read that throws is a read that cannot answer, not an absence", async () => {
    const { loop, lease, execute } = await touch(entity(), { reread: async () => { throw new Error("ocr down"); } });
    expect((await loop.touch({ lease })).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("with nothing wired to read, the act goes on as before G1", async () => {
    const { loop, lease, execute } = await touch(entity());
    expect((await loop.touch({ lease })).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a discover that lands during the read is honoured: the lease is validated again, and refused", async () => {
    // The read is the one await before the press. Without the second validation this press would go
    // out on a lease the generation had already moved past.
    const ctx = await touch(entity(), { reread: answer({ kind: "present" }), during: () => ctx.moveGeneration() });
    const result = await ctx.loop.touch({ lease: ctx.lease });
    expect(result).toMatchObject({ ok: false, reason: "lease_generation_mismatch" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("a target refused anyway keeps its reason, and is not read", async () => {
    const blocked: WindowBlockAnswer = { kind: "blocked", blocker: { name: "MODAL", role: "dialog", hwnd: "777" } };
    const { loop, lease, execute, reread } = await touch(entity(), { reread: answer({ kind: "absent" }), window: blocked });
    const result = await loop.touch({ lease });
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking" });
    expect(reread).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("a discover during a read that answers absent is the reason given, not the absence (PR 側 codex)", async () => {
    const ctx = await touch(entity(), { reread: answer({ kind: "absent" }), during: () => ctx.moveGeneration() });
    const result = await ctx.loop.touch({ lease: ctx.lease });
    expect(result).toMatchObject({ ok: false, reason: "lease_generation_mismatch" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("the checks run again after the read: a modal that opened during it refuses the press", async () => {
    let answerNow: WindowBlockAnswer = { kind: "cannot_say" };
    const { GuardedTouchLoop } = await import("../../src/engine/world-graph/guarded-touch.js");
    const { LeaseStore } = await import("../../src/engine/world-graph/lease-store.js");
    const target = entity();
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const lease = store.issue(target, "v1");
    const execute = vi.fn(async () => "mouse" as const);
    const loop = new GuardedTouchLoop(store, {
      resolveLiveEntities: () => [target],
      currentGeneration: () => GEN,
      isModalBlocking: () => false,
      findBlockingModal: () => null,
      checkViewport: () => null,
      findBlockingWindow: () => answerNow,
      execute,
      resolvePostTouchEntities: async () => [target],
      rereadStale: async () => {
        answerNow = { kind: "blocked", blocker: { name: "MODAL", role: "dialog", hwnd: "777" } };
        return { kind: "present" };
      },
    });
    const result = await loop.touch({ lease });
    expect(result).toMatchObject({ ok: false, reason: "modal_blocking" });
    expect(execute).not.toHaveBeenCalled();
  });
});

// ── The production read ─────────────────────────────────────────────────────────────────────────

const HWND = 4242n;
const WINDOW: Rect = { x: 300, y: 150, width: 640, height: 480 };
// What win2 measured the real OCR returning in R's window (screen coordinates).
const PAINTED_A = { text: "PAINTED-A", region: { x: 357, y: 224, width: 144, height: 23 } };
const PAINTED_X = { text: "PAINTED-X", region: { x: 357, y: 224, width: 144, height: 23 } };
const aim = (extra: Partial<Aim> = {}): Aim => ({ kind: "aim", hwnd: HWND, ...extra }) as Aim;

async function reread(
  target: UiEntity,
  found: ReadonlyArray<{ text: string; region: Rect }> | Error,
  opts: { aim?: Aim; window?: Rect | null; identityNow?: WindowIdentity } = {},
) {
  const { productionRereadStale } = await import("../../src/tools/_stale-reread.js");
  const read = vi.fn(async () => {
    if (found instanceof Error) throw found;
    return found;
  });
  const result = await productionRereadStale(target, opts.aim ?? aim(), {
    windowRect: () => (opts.window === undefined ? WINDOW : opts.window),
    identityNow: () => opts.identityNow,
    read,
  });
  return { result, read };
}

describe("productionRereadStale", () => {
  it("R — finds the label that is still there", async () => {
    const { result, read } = await reread(entity(), [PAINTED_A]);
    expect(result).toEqual({ kind: "present" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("A — the place now holds another label: absent", async () => {
    const { result } = await reread(entity(), [PAINTED_X]);
    expect(result).toEqual({ kind: "absent" });
  });

  it("a read that found nothing at all cannot say — a black capture looks like this (gate 2)", async () => {
    const { result } = await reread(entity(), []);
    expect(result).toEqual({ kind: "cannot_say", why: "read_found_nothing" });
  });

  it("the label in the next row of the crop is not the label at the place (gate 2)", async () => {
    // A list scrolled one row: the place now reads "Item 2", and "Item 1" sits one row lower, inside
    // the padded crop. Found anywhere in the crop, it would press "Item 2".
    const item1 = entity({ label: "Item 1", rect: { x: 354, y: 227, width: 144, height: 30 } });
    const { result } = await reread(item1, [
      { text: "Item 2", region: { x: 357, y: 228, width: 60, height: 28 } },
      { text: "Item 1", region: { x: 357, y: 258, width: 60, height: 28 } },
    ]);
    expect(result).toEqual({ kind: "absent" });
  });

  it("a short label inside a longer word is not the label (gate 2)", async () => {
    const ok = entity({ label: "OK" });
    expect((await reread(ok, [{ text: "Book", region: PAINTED_A.region }])).result).toEqual({ kind: "absent" });
    const item1 = entity({ label: "Item 1" });
    expect((await reread(item1, [{ text: "Item 10", region: PAINTED_A.region }])).result).toEqual({ kind: "absent" });
  });

  it("a read past its bound cannot say, and the act is not held for it", async () => {
    const { productionRereadStale } = await import("../../src/tools/_stale-reread.js");
    const result = await productionRereadStale(entity(), aim(), {
      windowRect: () => WINDOW,
      identityNow: () => undefined,
      read: () => new Promise(() => {}),
      timeoutMs: 20,
    });
    expect(result).toEqual({ kind: "cannot_say", why: "read_timed_out" });
  });

  it("a throw outside the read still writes its row (gate 2)", async () => {
    const { productionRereadStale } = await import("../../src/tools/_stale-reread.js");
    const result = await productionRereadStale(entity(), aim(), {
      windowRect: () => { throw new Error("win32 down"); },
      identityNow: () => undefined,
      read: async () => [PAINTED_A],
    });
    expect(result).toEqual({ kind: "cannot_say", why: "threw" });
    expect(staleRows()).toEqual([expect.objectContaining({ answer: "cannot_say", why: "threw" })]);
  });

  it("a press point outside the window is the press path's refusal, not a read of the strip left inside (gate 2)", async () => {
    const straddling = entity({ rect: { x: 900, y: 227, width: 100, height: 20 } }); // centre x 950 > 940
    const { result, read } = await reread(straddling, [PAINTED_A]);
    expect(result).toEqual({ kind: "cannot_say", why: "point_outside_window" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the entity's own place, padded, in the window's coordinates", async () => {
    const { read } = await reread(entity(), [PAINTED_A]);
    const [hwnd, roi] = read.mock.calls[0] as unknown as [bigint, Rect];
    expect(hwnd).toBe(HWND);
    // The entity's rect in window coordinates is (54,77,144,20); the crop contains it with margin.
    expect(roi.x).toBeLessThan(54);
    expect(roi.y).toBeLessThan(77);
    expect(roi.x + roi.width).toBeGreaterThan(54 + 144);
    expect(roi.y + roi.height).toBeGreaterThan(77 + 20);
    // …and is a crop, not the whole window.
    expect(roi.width * roi.height).toBeLessThan(WINDOW.width * WINDOW.height / 4);
  });

  it("a label OCR split in two is still found", async () => {
    const { result } = await reread(entity(), [
      { text: "PAINTED", region: { x: 357, y: 224, width: 90, height: 23 } },
      { text: "-A", region: { x: 450, y: 224, width: 30, height: 23 } },
    ]);
    expect(result).toEqual({ kind: "present" });
  });

  it("a split label whose halves do not share a top edge is still found (codex, gate 1)", async () => {
    const { result } = await reread(entity(), [
      { text: "PAINTED", region: { x: 357, y: 224, width: 90, height: 23 } },
      { text: "-A", region: { x: 450, y: 223, width: 30, height: 23 } },
    ]);
    expect(result).toEqual({ kind: "present" });
  });

  it("reads the place's own line left to right, and not the line below it", async () => {
    const { labelIsAt } = await import("../../src/tools/_stale-reread.js");
    const place = { x: 354, y: 227, width: 144, height: 20 };
    const found = [
      { text: "B", region: { x: 400, y: 260, width: 20, height: 20 } },
      { text: "-A", region: { x: 450, y: 223, width: 30, height: 23 } },
      { text: "PAINTED", region: { x: 357, y: 225, width: 90, height: 23 } },
    ];
    expect(labelIsAt("PAINTED-A", found, place)).toBe(true);
    expect(labelIsAt("PAINTED-AB", found, place)).toBe(false);
    expect(labelIsAt("A PAINTED", found, place)).toBe(false);
  });

  it("a read that fails cannot say — it is not an absence", async () => {
    const { result } = await reread(entity(), new Error("ocr down"));
    expect(result).toEqual({ kind: "cannot_say", why: "read_failed" });
  });

  it("no label to look for: cannot say, and nothing is read", async () => {
    // A symbol-only label folds to nothing, as a blank one does.
    const { result, read } = await reread(entity({ label: " × " }), [PAINTED_X]);
    expect(result).toEqual({ kind: "cannot_say", why: "no_label" });
    expect(read).not.toHaveBeenCalled();
  });

  it("no window to read: cannot say", async () => {
    const { result, read } = await reread(entity(), [PAINTED_X], { window: null });
    expect(result).toEqual({ kind: "cannot_say", why: "no_window_rect" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a handle that now names another program's window is not read: the executor's refusal answers", async () => {
    const then: WindowIdentity = { hwnd: HWND, pid: 100, processName: "fixture.exe", processStartTimeMs: 1 };
    const now: WindowIdentity = { hwnd: HWND, pid: 200, processName: "other.exe", processStartTimeMs: 2 };
    const { result, read } = await reread(entity(), [PAINTED_X], { aim: aim({ identity: then }), identityNow: now });
    expect(result).toEqual({ kind: "cannot_say", why: "aim_identity_changed" });
    expect(read).not.toHaveBeenCalled();
  });

  it("the same program's window is read", async () => {
    const then: WindowIdentity = { hwnd: HWND, pid: 100, processName: "fixture.exe", processStartTimeMs: 1 };
    const { result } = await reread(entity(), [PAINTED_X], { aim: aim({ identity: then }), identityNow: then });
    expect(result).toEqual({ kind: "absent" });
  });

  it("where the press path refuses on its own (a resized window), this steps aside", async () => {
    const measured = aim({ origin: { kind: "measured", rect: { ...WINDOW, width: 800 } } });
    const { result, read } = await reread(entity({ sources: ["ocr"] }), [PAINTED_X], { aim: measured });
    expect(result).toEqual({ kind: "cannot_say", why: "homing_window_resized" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a window that moved is read where the press would go (homing applied)", async () => {
    // An OCR-sourced entity is bracketed, so the press follows the window; so does the read.
    const before = { ...WINDOW, x: 200, y: 100 };
    const measured = aim({ origin: { kind: "measured", rect: before } });
    const moved = entity({ sources: ["ocr"], rect: { x: 254, y: 177, width: 144, height: 20 } });
    const { result, read } = await reread(moved, [PAINTED_A], { aim: measured });
    expect(result).toEqual({ kind: "present" });
    const [, roi] = read.mock.calls[0] as unknown as [bigint, Rect];
    // Same window-relative place as the unmoved case: (54,77).
    expect(roi.x).toBeLessThan(54);
    expect(roi.x + roi.width).toBeGreaterThan(54 + 144);
    expect(roi.y).toBeLessThan(77);
    expect(roi.y + roi.height).toBeGreaterThan(77 + 20);
  });

  it("writes one act.stale row per read, saying which answer and why", async () => {
    await reread(entity(), [PAINTED_X]);
    await reread(entity(), new Error("x"));
    expect(staleRows()).toEqual([
      expect.objectContaining({ entityId: "painted-a", label: "PAINTED-A", answer: "absent", handle: "4242" }),
      expect.objectContaining({ entityId: "painted-a", answer: "cannot_say", why: "read_failed" }),
    ]);
  });
});

describe("labelIsAt", () => {
  const place = { x: 354, y: 227, width: 144, height: 20 };
  it("does not take one label for another that shares a prefix", async () => {
    const { labelIsAt } = await import("../../src/tools/_stale-reread.js");
    expect(labelIsAt("PAINTED-A", [PAINTED_X], place)).toBe(false);
    expect(labelIsAt("PAINTED-A", [PAINTED_A], place)).toBe(true);
    expect(labelIsAt("painted - a", [PAINTED_A], place)).toBe(true);
    // Another engine's hyphen (U+2010) is still the same label.
    expect(labelIsAt("PAINTED\u2010A", [PAINTED_A], place)).toBe(true);
    // …and an engine that dropped it.
    expect(labelIsAt("PAINTED-A", [{ text: "PAINTEDA", region: PAINTED_A.region }], place)).toBe(true);
    expect(labelIsAt("", [PAINTED_A], place)).toBe(false);
  });

  it("finds a word in an unspaced script at any character, and a spaced one only at word edges", async () => {
    const { labelIsAt } = await import("../../src/tools/_stale-reread.js");
    const at = (text: string) => [{ text, region: PAINTED_A.region }];
    expect(labelIsAt("保存", at("上書き保存"), place)).toBe(true);
    expect(labelIsAt("保存", at("保 存"), place)).toBe(true);
    expect(labelIsAt("Save", at("Save As"), place)).toBe(true);
    expect(labelIsAt("Save", at("Saved"), place)).toBe(false);
  });

  it("ignores text elsewhere in the crop", async () => {
    const { labelIsAt } = await import("../../src/tools/_stale-reread.js");
    const beside = { text: "PAINTED-A", region: { x: 560, y: 224, width: 144, height: 23 } };
    expect(labelIsAt("PAINTED-A", [beside], place)).toBe(false);
  });
});

describe("through the facade and the registry", () => {
  function visualCandidate(label: string, status: "observed" | "stale"): UiEntityCandidate {
    return {
      source: "visual_gpu",
      target: { kind: "window", id: "Fixture" },
      label,
      role: "button",
      rect: { x: 354, y: 227, width: 144, height: 20 },
      actionability: ["click"],
      confidence: 0.8,
      observedAtMs: 0,
      provisional: false,
      digest: `d-${label}`,
      status,
    } as unknown as UiEntityCandidate;
  }

  it("a stale entity from discover is read through the wired reader, and refused when absent", async () => {
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const executor = vi.fn(async () => "mouse" as const);
    const rereadStale = vi.fn(async () => ({ kind: "absent" }) as StaleRereadAnswer);
    const facade = new DesktopFacade(async () => [visualCandidate("PAINTED-A", "stale")], { executorFn: executor, rereadStale });
    const view = await facade.see({ target: { windowTitle: "Fixture" } });
    const a = view.entities.find((e) => e.label === "PAINTED-A");
    expect(a).toBeDefined();
    const result = await facade.touch({ lease: a!.lease });
    expect(result).toMatchObject({ ok: false, reason: "entity_not_found" });
    expect(rereadStale).toHaveBeenCalledTimes(1);
    expect(executor).not.toHaveBeenCalled();
  });

  it("an observed entity from discover is pressed without the reader", async () => {
    const { DesktopFacade } = await import("../../src/tools/desktop.js");
    const executor = vi.fn(async () => "mouse" as const);
    const rereadStale = vi.fn(async () => ({ kind: "absent" }) as StaleRereadAnswer);
    const facade = new DesktopFacade(async () => [visualCandidate("PAINTED-X", "observed")], { executorFn: executor, rereadStale });
    const view = await facade.see({ target: { windowTitle: "Fixture" } });
    const x = view.entities.find((e) => e.label === "PAINTED-X");
    const result = await facade.touch({ lease: x!.lease });
    expect(result.ok).toBe(true);
    expect(rereadStale).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
