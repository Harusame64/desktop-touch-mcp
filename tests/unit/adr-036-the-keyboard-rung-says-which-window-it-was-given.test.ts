/**
 * The keyboard rung says which window it was given — ADR-036, internal #157.
 *
 * Measured on public main `d47f4421` (win2, 2026-09-22): a `setValue` on a read-only field refused on
 * the keyboard rung and wrote one `act.route` row of twenty-three keys, none of them an addressing
 * axis. The press road's rows on the same build carried `addressedWindowBy`, so the grid's write column
 * (c4) had no window axis to read and its axis was waived (release cut W-h).
 *
 * The rung addresses a window and no element by name — it finds its receiver by handles, which its row
 * already records as `receiver*` — so its rows carry the window axis alone. These cells pin it on all
 * four rows the rung writes (unchecked, cannot resolve, refusal, posted), on both roads that reach it,
 * by value, and pin that the element axes are NOT written there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aim } from "../../src/engine/aim.js";
import type { ExecutorDeps, KeyboardReceipt } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;
const CTRL = 5001n;
const OTHER = 5002n;
const RECT = { x: 100, y: 200, width: 120, height: 24 };
const EDIT = "WindowsForms10.EDIT.app.0.1";
const WRITABLE = 0x50010080;

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyboard-rung-window-axis-"));
  logPath = join(dir, "aim-probe.jsonl");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

/** A field on the value road: the value road fails, so the rung is reached from it. */
const valueRoadField: UiEntity = {
  entityId: "u4", role: "textbox", label: "DELTA", confidence: 0.9, sources: ["uia"],
  locator: { uia: { name: "DELTA", automationId: "DELTA", nativeWindowHandle: "5001" } },
  affordances: [{ verb: "type", executors: ["uia"], confidence: 0.9, preconditions: [], postconditions: [] }],
  generation: "gen-1", evidenceDigest: "d", rect: RECT, controlType: "Edit",
};

/** An entity only the keyboard reaches: the rung's other entry. */
const keyboardOnly: UiEntity = {
  ...valueRoadField,
  entityId: "k1",
  // Not a UIA source, so the UIA road is not entered; the handle stays, so the rule judges the same facts.
  sources: ["visual_gpu"],
  preferredExecutors: ["keyboard"],
  affordances: [{ verb: "type", executors: ["keyboard"], confidence: 0.9, preconditions: [], postconditions: [] }],
};

function receiptOf(over: Partial<KeyboardReceipt> = {}): KeyboardReceipt {
  return {
    windowHwnd: HWND, receiverHwnd: CTRL, receiverClass: EDIT, receiverRect: RECT, receiverRootHwnd: HWND,
    receiverStyle: WRITABLE, receiverAncestors: [], ancestorsComplete: true,
    entityRootHwnd: HWND, originRootHwnd: null, aimRootHwnd: null, lookupRootHwnd: HWND, ownerChain: [],
    ...over,
  };
}

function depsFor(receipt: KeyboardReceipt, over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}),
    uiaSetValue: vi.fn(async () => { throw new Error("ValuePattern not supported by this element"); }),
    cdpClick: vi.fn(async () => {}),
    cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => receipt),
    keyboardResolve: vi.fn(async () => receipt),
    keyboardPost: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    ...over,
  };
}

function keyboardRows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.seam === "act.route" && (r.route === "keyboard" || (r.route === "refusal" && r.rung === "keyboard")));
}

type Target = Aim | { windowTitle: string } | undefined;

async function type(target: Target, entity: UiEntity, d: ExecutorDeps) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  return createDesktopExecutor(target as Aim, d)(entity, "type", "PROBE-W").then((v) => v, (e: unknown) => e);
}

// The last column is the handle the backend must be handed: the row's value is only true if the
// lookup used what the row says (gate 2 on public #721 — a dropped handle survived a value-only cell).
const roads: Array<[string, Target, "handle" | "title" | "nothing", bigint | undefined]> = [
  ["a handle (a title riding along)", { kind: "aim", title: "RFS-CELL", hwnd: HWND }, "handle", HWND],
  ["a title", { windowTitle: "RFS-CELL" }, "title", undefined],
  ["no window at all", undefined, "nothing", undefined],
];

/** The handle each backend call received; the rung reaches exactly one lookup per act. */
function handlesHanded(d: ExecutorDeps): Array<bigint | undefined> {
  const calls = [
    ...((d.keyboardResolve as unknown as { mock?: { calls: unknown[][] } } | undefined)?.mock?.calls ?? []).map((c) => c[1]),
    ...((d.keyboardTypeBg as unknown as { mock: { calls: unknown[][] } }).mock.calls).map((c) => c[2]),
  ];
  return calls as Array<bigint | undefined>;
}

// The four rows the rung writes, each reached by one fact.
const rows: Array<[string, () => ExecutorDeps, "keyboard" | "refusal", Record<string, unknown>]> = [
  ["posted", () => depsFor(receiptOf()), "keyboard", { verdict: "posted" }],
  ["refused", () => depsFor(receiptOf({ receiverHwnd: OTHER })), "refusal", { refused: "keyboard_target_unsafe", ground: "other_control" }],
  ["cannot resolve", () => depsFor(receiptOf(), { keyboardResolve: undefined, keyboardPost: undefined }), "keyboard",
    { verdict: "unconfirmed:receiver_unknown" }],
];

describe("every row the keyboard rung writes carries the window it was given, by value", () => {
  for (const [entry, entity] of [["from the value road", valueRoadField], ["keyboard-only", keyboardOnly]] as const) {
    for (const [road, target, expected, handle] of roads) {
      for (const [label, makeDeps, route, marks] of rows) {
        it(`${entry} · ${road} · ${label} → addressedWindowBy "${expected}"`, async () => {
          const d = makeDeps();
          await type(target, entity, d);
          const got = keyboardRows();
          expect(got, "exactly one rung row").toHaveLength(1);
          expect(got[0]).toMatchObject({ route, ...marks, addressedWindowBy: expected });
          expect(handlesHanded(d), "the handle the lookup used").toEqual([handle]);
        });
      }

      it(`${entry} · ${road} · unchecked → addressedWindowBy "${expected}"`, async () => {
        vi.stubEnv("DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED", "1");
        const d = depsFor(receiptOf());
        await type(target, entity, d);
        const got = keyboardRows();
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ route: "keyboard", verdict: "unchecked", addressedWindowBy: expected });
        expect(handlesHanded(d), "the handle the lookup used").toEqual([handle]);
      });
    }
  }

  it("writes the window axis only: the rung names no element, so the element axes are not on its rows", async () => {
    await type({ windowTitle: "RFS-CELL" }, valueRoadField, depsFor(receiptOf({ receiverHwnd: OTHER })));
    const [row] = keyboardRows();
    expect(row).toHaveProperty("addressedWindowBy", "title");
    expect(row).not.toHaveProperty("addressedBy");
    expect(row).not.toHaveProperty("addressedElementBy");
  });

  it("counts `@active` and an empty title as naming no window, as the press road does", async () => {
    for (const title of ["@active", ""]) {
      rmSync(logPath, { force: true });
      await type({ windowTitle: title }, keyboardOnly, depsFor(receiptOf()));
      expect(keyboardRows()[0], JSON.stringify(title)).toMatchObject({ addressedWindowBy: "nothing" });
    }
  });
});
