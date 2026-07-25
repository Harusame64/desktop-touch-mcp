import { describe, it, expect } from "vitest";
import {
  assertCoordinateReachable,
  isCoordinateReachable,
} from "../../src/engine/reachable-bounds.js";
import { failWith } from "../../src/tools/_errors.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-029 Phase 1 — nut.js clamps any point outside the primary monitor into it,
// so the guard has to refuse such points before the cursor moves.

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };

describe("reachable-bounds guard", () => {
  it("accepts points inside the reachable region, including its top-left corner", () => {
    expect(isCoordinateReachable(0, 0, PRIMARY)).toBe(true);
    expect(isCoordinateReachable(960, 540, PRIMARY)).toBe(true);
    expect(isCoordinateReachable(1919, 1079, PRIMARY)).toBe(true);
  });

  it("rejects points past the right / bottom edge (half-open interval)", () => {
    expect(isCoordinateReachable(1920, 540, PRIMARY)).toBe(false);
    expect(isCoordinateReachable(960, 1080, PRIMARY)).toBe(false);
  });

  it("rejects negative coordinates — the monitor-to-the-left case", () => {
    expect(isCoordinateReachable(-200, 400, PRIMARY)).toBe(false);
    expect(isCoordinateReachable(400, -50, PRIMARY)).toBe(false);
  });

  it("throws a typed error naming the coordinate and the reachable area", () => {
    let thrown: unknown;
    try {
      assertCoordinateReachable(-1500, 300, PRIMARY);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.name).toBe("CoordinateOutsideReachableBounds");
    expect(err.message).toContain("(-1500, 300)");
    expect(err.message).toContain("1920x1080");
  });

  it("does not throw for a reachable coordinate", () => {
    expect(() => assertCoordinateReachable(10, 10, PRIMARY)).not.toThrow();
  });

  // A machine whose monitor enumeration fails must stay usable: an unknown
  // region means "cannot judge", not "block everything".
  it("allows any coordinate when the reachable region is unknown", () => {
    expect(isCoordinateReachable(-5000, -5000, null)).toBe(true);
    expect(() => assertCoordinateReachable(-5000, -5000, null)).not.toThrow();
  });
});

// Structural invariant: the guard is only worth anything if EVERY path that
// moves the OS cursor to an absolute coordinate runs it. Enumerating those by
// hand during review missed `browser_click` once already, so pin it: any source
// file that moves the nut.js cursor must also assert reachability.
describe("reachable-bounds guard — no unguarded cursor-move path", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const MOVES_CURSOR = /mouse\.(move|setPosition|drag)\s*\(/;

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
    });
  }

  it("every file that moves the cursor also calls assertCoordinateReachable", () => {
    const unguarded = tsFiles(SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      return MOVES_CURSOR.test(src) && !src.includes("assertCoordinateReachable");
    });
    expect(unguarded.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });
});

describe("reachable-bounds guard — typed code classification", () => {
  it("the thrown error classifies as CoordinateOutsideReachableBounds with recovery advice", () => {
    let thrown: unknown;
    try {
      assertCoordinateReachable(-1500, 300, PRIMARY);
    } catch (e) {
      thrown = e;
    }
    const body = JSON.parse(failWith(thrown as Error, "mouse_click").content[0]!.text);
    expect(body.code).toBe("CoordinateOutsideReachableBounds");
    expect(body.suggest.join(" ")).toMatch(/primary monitor/i);
  });

  // Ordering pin: the guard's message names the target region, and the generic
  // arms below it ("window not found" / "timeout") would poach a message that
  // ever mentions a window. Same defence as the SpawnFailed ordering pin.
  it("wins over the generic classify arms when the message contains their keywords too", () => {
    for (const suffix of ["window not found", "timed out", "element not found"]) {
      const err = new Error(`CoordinateOutsideReachableBounds: (-1500, 300) is outside … ${suffix}`);
      const body = JSON.parse(failWith(err, "mouse_click").content[0]!.text);
      expect(body.code, `poached by "${suffix}"`).toBe("CoordinateOutsideReachableBounds");
    }
  });
});
