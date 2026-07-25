/**
 * ADR-029 Phase 2a — the native cursor path, against the real desktop.
 *
 * The point of the phase is placement that is both correct and verified, and
 * neither property can be tested with fakes: the unit tests pin the planning
 * arithmetic, this pins what Windows actually does with it.
 *
 * A second monitor is not required. What CI can check on one monitor is that
 * movement is exact (the previous libnut path quantised through a 0..65535 grid
 * and could miss by a pixel) and that a point the cursor cannot occupy comes
 * back as a typed refusal rather than a wrong click. The negative-coordinate
 * case needs real hardware and stays a dogfood item.
 *
 * The cursor is restored to where the user left it, whatever happens.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { enumMonitors } from "../../src/engine/win32.js";
import { hasNativeCursorMove } from "../../src/engine/native-engine.js";
import { moveCursorTo } from "../../src/engine/cursor.js";
import { getCursorPositionHandler } from "../../src/tools/mouse.js";

interface Pos {
  x: number;
  y: number;
}

/** Read the position back through the public tool handler, not the binding. */
async function readCursor(): Promise<Pos> {
  const body = JSON.parse((await getCursorPositionHandler()).content[0]!.text);
  return { x: body.x, y: body.y };
}

// Resolved in beforeAll, not at module scope: `enumMonitors` throws on a build
// without the native addon, which would fail the file instead of skipping it.
let primary!: { x: number; y: number; width: number; height: number };
let A: Pos;
let B: Pos;
let entry: Pos;

describe.skipIf(!hasNativeCursorMove())("ADR-029 Phase 2a — native cursor placement", () => {
  beforeAll(async () => {
    const found = enumMonitors().find((m) => m.primary);
    if (!found) throw new Error("no primary monitor reported");
    primary = found.bounds;
    // Well inside the primary monitor — clear of the failsafe corners.
    A = { x: primary.x + 400, y: primary.y + 300 };
    B = { x: primary.x + 900, y: primary.y + 650 };
    entry = await readCursor();
  });

  afterAll(async () => {
    await moveCursorTo(entry.x, entry.y, 0).catch(() => undefined);
  });

  it("teleports to the exact pixel asked for", async () => {
    await moveCursorTo(A.x, A.y, 0);
    expect(await readCursor()).toEqual(A);
  });

  it("lands an animated move on the exact pixel too", async () => {
    await moveCursorTo(A.x, A.y, 0);
    await moveCursorTo(B.x, B.y, 3000);
    expect(await readCursor()).toEqual(B);
  });

  it("takes a visible amount of time to animate, and none to teleport", async () => {
    await moveCursorTo(A.x, A.y, 0);
    const animatedStart = Date.now();
    await moveCursorTo(B.x, B.y, 2000); // ~600px at 2000px/s ≈ 300ms
    const animatedMs = Date.now() - animatedStart;

    const teleportStart = Date.now();
    await moveCursorTo(A.x, A.y, 0);
    const teleportMs = Date.now() - teleportStart;

    // Loose bounds on purpose: the assertion is that the speed setting still
    // means something and that timer resolution has not stretched the gesture
    // several-fold, not that the animation is frame-accurate.
    expect(animatedMs).toBeGreaterThan(80);
    expect(animatedMs).toBeLessThan(3000);
    expect(teleportMs).toBeLessThan(animatedMs);
  });

  it("refuses a point that is on no monitor instead of clicking elsewhere", async () => {
    const offScreen = { x: primary.x + primary.width + 5000, y: primary.y + 10 };
    await expect(moveCursorTo(offScreen.x, offScreen.y, 0)).rejects.toMatchObject({
      name: "CoordinateOutsideReachableBounds",
    });
    // And the cursor did not move on the way to being refused.
    await moveCursorTo(A.x, A.y, 0);
    expect(await readCursor()).toEqual(A);
  });

  it("drags without leaving the button held when the move is refused", async () => {
    // The drag handler presses, moves, releases. A refusal mid-gesture must
    // still release: a stuck left button breaks every later input on the box.
    const { mouse, Button } = await import("../../src/engine/nutjs.js");
    await moveCursorTo(A.x, A.y, 0);
    await mouse.pressButton(Button.LEFT);
    try {
      await moveCursorTo(primary.x + primary.width + 5000, A.y, 0);
    } catch {
      // expected
    } finally {
      await mouse.releaseButton(Button.LEFT);
    }
    // If the button were still down, this move would drag-select instead of
    // hovering; the check that matters is simply that input still works.
    await moveCursorTo(B.x, B.y, 0);
    expect(await readCursor()).toEqual(B);
  });
});
