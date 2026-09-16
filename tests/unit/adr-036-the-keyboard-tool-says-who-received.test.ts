/**
 * The `keyboard` tool says who received the characters — ADR-036 family 2, arm A, observation only.
 *
 * Measured on 2026-09-16 (win2, seven arms on `main`, then two more): a `keyboard` write into a
 * window whose thread holds its focus in ANOTHER top-level window answers `ok:true` and produces a
 * record — `logDispatchSink`, written BEFORE the send with the window that was AIMED at — that is
 * byte-identical to the record of a write that landed correctly. A plain sibling and an OWNED window
 * produce the same row as each other too. Meanwhile `postCharsToHwnd` has returned the receiver all
 * along, and the `desktop_act` rung has read it since #630.
 *
 * These cells pin the row, the two absences it distinguishes, and the fact that the rule's verdict is
 * RECORDED AND NOT ACTED ON. Behaviour is unchanged: nothing here refuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIN = 0x00010010n;        // the window the tool addressed
const CHILD = 0x00010020n;      // a child edit inside it
const OTHER_ROOT = 0x00020010n; // another top-level window, same thread
const OWNED_CHILD = 0x00020020n; // a child edit inside the owned window

const parentOf: Record<string, bigint | null> = {
  [String(CHILD)]: WIN,
  [String(OWNED_CHILD)]: OTHER_ROOT,
};
const rootOf: Record<string, bigint> = {
  [String(WIN)]: WIN,
  [String(CHILD)]: WIN,
  [String(OTHER_ROOT)]: OTHER_ROOT,
  [String(OWNED_CHILD)]: OTHER_ROOT,
};
let ownerOf: Record<string, bigint | null> = {};
let styleOf: Record<string, number> = {};
let classOf: Record<string, string> = {};

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getWindowRoot: vi.fn((h: bigint) => rootOf[String(h)] ?? null),
    getWindowParent: vi.fn((h: bigint) => parentOf[String(h)] ?? null),
    getWindowOwner: vi.fn((h: bigint) => ownerOf[String(h)] ?? null),
    getWindowClassName: vi.fn((h: bigint) => classOf[String(h)] ?? "Edit"),
    getWindowStyle: vi.fn((h: bigint) => styleOf[String(h)] ?? 0),
    getWindowRectByHwnd: vi.fn(() => ({ x: 0, y: 0, width: 10, height: 10 })),
  };
});

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kbd-receiver-"));
  logPath = join(dir, "aim-probe.jsonl");
  process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
  process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
  ownerOf = {};
  styleOf = {};
  classOf = {};
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DESKTOP_TOUCH_AIM_PROBE;
  delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.seam === "keyboard.dispatch");
}

async function probe(row: Record<string, unknown>) {
  const { probeKeyboardDispatch } = await import("../../src/engine/keyboard-dispatch-probe.js");
  await probeKeyboardDispatch(row as never);
}

describe("the keyboard tool's dispatch row", () => {
  it("names the receiver the post reached, and says it is inside the window addressed", async () => {
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: CHILD, payloadChars: 4 });
    expect(rows()).toHaveLength(1);
    const r = rows()[0] as { receiver: Record<string, unknown>; receiverKnown: boolean };
    expect(r.receiverKnown).toBe(true);
    expect(r.receiver).toMatchObject({
      hwnd: String(CHILD),
      rootHwnd: String(WIN),
      isWindowItself: false,
      inNamedWindow: true,
    });
  });

  it("says the receiver is in ANOTHER top-level window — the case the sink row cannot show", async () => {
    // THE ARM THIS ROW EXISTS FOR. Measured 2026-09-16: the characters land in the other window and
    // the existing record is identical to a correct landing, field for field.
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: OWNED_CHILD });
    expect(rows()[0]).toMatchObject({
      receiver: { rootHwnd: String(OTHER_ROOT), inNamedWindow: false },
    });
  });

  it("carries the OWNER relation, which the receiver's own handle cannot", async () => {
    // Measured 2026-09-16: with an owned window, the receiver is that window's CHILD EDIT — one
    // level deeper than the ownership — so a row that named only the receiver would still not name
    // the owner. Same receiver as the cell above; only the ownership differs, and the row splits.
    ownerOf = { [String(OTHER_ROOT)]: WIN };
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: OWNED_CHILD });
    expect(rows()[0]).toMatchObject({
      receiver: { inNamedWindow: false, ownerChainLength: 1, ownerIsNamedWindow: true },
    });
  });

  it("keeps `isWindowItself` and the class apart, because the arm that merges them could not be built", async () => {
    // The thread had no focus, so the post fell back to the window. `isWindowItself` covers both
    // that and "the question could not be asked" (the rule's step 4). Whether a fallback window can
    // TAKE the characters is unmeasured: a posted WM_CHAR never reaches a top-level EDIT on the
    // measuring machine while a sent one does (win2, 2026-09-16, control run from outside the
    // server). So the row carries both facts rather than one that would merge two results.
    classOf = { [String(WIN)]: "Edit" };
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: false, receiver: WIN });
    expect(rows()[0]).toMatchObject({
      receiver: { isWindowItself: true, className: "Edit", inNamedWindow: true },
    });
  });

  it("records the rule's verdict and does not act on it — and on this road it is `cannot say`", async () => {
    // The point of the row. `judgeKeyboardTarget` wants the named CONTROL's own window, and this
    // road names a window. So step 2 can never match and step 3 refuses `other_window` only when
    // that is usable: the arm where the characters demonstrably went to another top-level window
    // comes back "cannot say". The row counts it; nothing refuses.
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: OWNED_CHILD });
    expect(rows()[0]).toMatchObject({ wouldJudge: { kind: "post", confirmed: false } });
  });

  it("still reaches the one refusal this road can — a read-only receiver", async () => {
    classOf = { [String(CHILD)]: "Edit" };
    styleOf = { [String(CHILD)]: 0x0800 };
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: CHILD });
    expect(rows()[0]).toMatchObject({
      receiver: { readOnly: true },
      wouldJudge: { kind: "refuse", ground: "read_only" },
    });
  });

  it("judges with the same switch the acting road honours, and says which grounds were off", async () => {
    // WITHOUT THIS THE TWO ROADS DISAGREE FOR IDENTICAL FACTS. `desktop_act`'s rung passes the
    // disabled grounds to the rule; a measurement round that turns one off would otherwise read
    // `refuse / read_only` here and a marked success there, on a row whose whole purpose is that the
    // two roads can be compared (gate 2, 2026-09-16). The switch state rides beside the verdict so a
    // reader knows which rule produced it.
    classOf = { [String(CHILD)]: "Edit" };
    styleOf = { [String(CHILD)]: 0x0800 };
    process.env.DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED = "read_only";
    try {
      await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: CHILD });
    } finally {
      delete process.env.DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED;
    }
    expect(rows()[0]).toMatchObject({
      switchDisabled: ["read_only"],
      wouldJudge: { kind: "post", confirmed: false },
    });
  });

  it("prints a handle with bit 31 set in the shared 32-bit form, like every other seam", async () => {
    // THE CELL THE OTHER FIXTURES COULD NOT BE: every handle in this file is small, so the raw
    // bigint and the 32-bit form are the same string and a mutation that drops the normalisation
    // stays green. A USER handle is 32 bits sign-extended for interop, so one with the high bit set
    // is where `act.route` and this row would start naming one window two ways (gate 2, 2026-09-16).
    // AND THE FIRST VERSION OF THIS CELL COULD NOT TELL EITHER: `0xFFFF0010n` is positive and fits
    // in 32 bits, so the raw string and the normalised one are equal and the mutant stayed green.
    // The case that splits them is a handle already WIDENED to 64 bits with the sign extended —
    // which is how `GetFocus` hands one back.
    const HIGH = 0xFFFFFFFFFFFF0010n;
    rootOf[String(HIGH)] = HIGH;
    try {
      await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: HIGH, byHandle: true, receiver: HIGH });
      expect(rows()[0]).toMatchObject({
        windowHwnd: "4294901776",
        receiver: { hwnd: "4294901776", isWindowItself: true },
      });
    } finally {
      delete rootOf[String(HIGH)];
    }
  });

  it("separates the two absences: a rung with no receiver, and a primitive that drops it", async () => {
    // ABSENCE RECORDED, NOT INFERRED. A record that only omits makes "nobody asked" and "nobody
    // answered" look identical — which is the same defect this row exists to close one layer up.
    await probe({ tool: "keyboard:type", rung: "sendinput", windowHwnd: null, byHandle: false, receiver: null, noReceiverWhy: "rung_has_no_receiver" });
    await probe({ tool: "keyboard:press", rung: "wm_char", windowHwnd: WIN, byHandle: false, receiver: null, noReceiverWhy: "primitive_does_not_report" });
    expect(rows()[0]).toMatchObject({ receiverKnown: false, why: "rung_has_no_receiver", windowHwnd: null });
    expect(rows()[1]).toMatchObject({ receiverKnown: false, why: "primitive_does_not_report", windowHwnd: String(WIN) });
  });

  it("says which reference it judged against: the handle the caller gave, or the rung's own lookup", async () => {
    // THE SAME SPLIT #665 BUILT FOR THE VALUE ROAD, on the road that has no entity. The rule treats
    // its own lookup as the last resort because a title takes the first window whose caption
    // CONTAINS the string, so a row that did not say which one it judged against would be reporting
    // two different confidences under one word.
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: CHILD });
    expect(rows()[0]).toMatchObject({ wouldJudge: { referenceFrom: "aim" } });
    rmSync(logPath, { force: true });
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: false, receiver: CHILD });
    expect(rows()[0]).toMatchObject({ wouldJudge: { referenceFrom: "lookup" } });
  });

  it("writes nothing AND reads nothing when the probe is off", async () => {
    // Both halves, and the second is why the guard exists. The write is refused by the probe file
    // itself, so a cell that only checked the log would pass with the guard deleted — a check that
    // cannot fail. What the guard protects is the NATIVE READS: a handful of Win32 calls per
    // keystroke dispatch, on a road that ships with the probe off.
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    vi.resetModules();
    const win32 = await import("../../src/engine/win32.js");
    const root = vi.mocked(win32.getWindowRoot);
    root.mockClear();
    await probe({ tool: "keyboard:type", rung: "wm_char", windowHwnd: WIN, byHandle: true, receiver: CHILD });
    expect(rows()).toHaveLength(0);
    expect(root).not.toHaveBeenCalled();
  });
});
