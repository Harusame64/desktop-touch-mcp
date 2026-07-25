import { describe, it, expect } from "vitest";
import {
  assertCoordinateReachable,
  isCoordinateReachable,
} from "../../src/engine/reachable-bounds.js";
import { failWith } from "../../src/tools/_errors.js";
import { CursorPlacementBlockedError } from "../../src/errors/typed-errors.js";
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
// moves the OS cursor runs it. Enumerating those by hand during review missed
// `browser_click` once already.
//
// Since ADR-029 Phase 2a there is one place that moves the cursor
// (`src/engine/cursor.ts`), so the rule is stronger than "each mover guards
// itself": nothing else may move the cursor at all. Declaring the native
// bindings is a separate matter from calling them, hence the two allowlists.
describe("cursor movement — only the choke point may move the cursor", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const CHOKE_POINT = join(SRC, "engine", "cursor.ts");
  // Where the native bindings may be *declared* / probed, as opposed to called.
  const BINDING_DECLARATION = join(SRC, "engine", "native-engine.ts");
  // `native-types.ts` mirrors the napi structs and is under src/, so it IS
  // scanned — it names the types (NativeCursorPoint) but never the functions,
  // which is what keeps it out of the allowlist. Do not "fix" a future failure
  // there by widening the list; write the call in cursor.ts instead.

  const MOVES_CURSOR = /mouse\.(move|setPosition|drag)\s*\(/;
  const CALLS_NATIVE_CURSOR = /win32(MoveCursorAbsolute|MoveCursorPath|GetCursorPos)\s*\(/;
  const NAMES_NATIVE_CURSOR = /win32(MoveCursorAbsolute|MoveCursorPath|GetCursorPos)/;

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
    });
  }
  const rel = (f: string) => f.replace(SRC, "src");

  it("no file other than cursor.ts moves the cursor", () => {
    const movers = tsFiles(SRC).filter(
      (f) => f !== CHOKE_POINT && (MOVES_CURSOR.test(readFileSync(f, "utf8")) || CALLS_NATIVE_CURSOR.test(readFileSync(f, "utf8"))),
    );
    expect(movers.map(rel)).toEqual([]);
  });

  it("only the choke point and the binding declaration name the native cursor functions", () => {
    const namers = tsFiles(SRC).filter(
      (f) => f !== CHOKE_POINT && f !== BINDING_DECLARATION && NAMES_NATIVE_CURSOR.test(readFileSync(f, "utf8")),
    );
    expect(namers.map(rel)).toEqual([]);
  });

  // The choke point is not the only guard: mouse_drag checks both endpoints
  // BEFORE pressing the button (a refusal after the press would leave it held),
  // and the executor checks in its core so the fake-deps unit tests exercise the
  // guard. Those must not be dropped as "redundant now".
  it("keeps the pre-flight guards at the sites that need them before moving", () => {
    for (const f of ["tools/mouse.ts", "tools/desktop-executor.ts", "tools/browser.ts"]) {
      const src = readFileSync(join(SRC, ...f.split("/")), "utf8");
      expect(src, `${f} lost its assertCoordinateReachable pre-check`).toContain(
        "assertCoordinateReachable",
      );
    }
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
    expect(body.suggest.join(" ")).toMatch(/stale|primary monitor/i);
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

// ADR-029 Phase 2a — the sibling error for "the point was fine, the pointer was
// not". It has to classify separately, because its recovery (free the cursor,
// reconnect the session) has nothing in common with re-discovering coordinates.
describe("cursor placement failure — typed code classification", () => {
  const message =
    "CursorPlacementBlocked: the cursor could not be moved to (200, 300), which is on a " +
    "connected monitor. The pointer ended up at (0, 0) instead. Nothing was clicked.";

  it("classifies as CursorPlacementBlocked and leads with the cursor-free route", () => {
    const err = new CursorPlacementBlockedError(message);
    const body = JSON.parse(failWith(err, "mouse_click").content[0]!.text);
    expect(body.code).toBe("CursorPlacementBlocked");
    expect(body.suggest[0]).toMatch(/click_element/);
  });

  it("does not advise re-discovering the coordinate as the primary fix", () => {
    const err = new CursorPlacementBlockedError(message);
    const body = JSON.parse(failWith(err, "desktop_act").content[0]!.text);
    // Re-discovery only appears as the last resort, for the monitor-layout case.
    expect(body.suggest[0]).not.toMatch(/desktop_discover/);
  });

  // Same ordering defence as its sibling: the message names a remote-desktop
  // session and a monitor layout, either of which a later generic arm could
  // poach if the wording drifts.
  it("wins over the generic classify arms when the message contains their keywords too", () => {
    for (const suffix of ["window not found", "timed out", "element not found"]) {
      const err = new Error(`CursorPlacementBlocked: could not place the pointer … ${suffix}`);
      const body = JSON.parse(failWith(err, "mouse_click").content[0]!.text);
      expect(body.code, `poached by "${suffix}"`).toBe("CursorPlacementBlocked");
    }
  });
});
