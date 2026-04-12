/**
 * process-tree.test.ts — sanity checks for the Toolhelp32-based process walker.
 *
 * Verifies that buildProcessParentMap returns the current process's parent,
 * and that findAncestorWindow walks the tree without crashing.
 */

import { describe, it, expect } from "vitest";
import { buildProcessParentMap, findAncestorWindow, getWindowProcessId } from "../../src/engine/win32.js";

describe("buildProcessParentMap", () => {
  it("returns a non-empty map containing the current process", () => {
    const map = buildProcessParentMap();
    expect(map.size).toBeGreaterThan(5); // any Windows box has many processes
    expect(map.has(process.pid)).toBe(true);
  });

  it("returns a parent PID for the current process that differs from self", () => {
    const map = buildProcessParentMap();
    const parent = map.get(process.pid);
    expect(parent).toBeDefined();
    expect(parent).not.toBe(process.pid);
    expect(parent).toBeGreaterThan(0);
  });

  it("the parent chain reaches a root (pid 0 or 4) without cycles", () => {
    const map = buildProcessParentMap();
    const seen = new Set<number>();
    let pid: number | undefined = process.pid;
    while (pid !== undefined && pid > 4 && seen.size < 30) {
      if (seen.has(pid)) {
        throw new Error(`Cycle detected in parent chain at pid ${pid}`);
      }
      seen.add(pid);
      pid = map.get(pid);
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThan(30);
  });
});

describe("findAncestorWindow", () => {
  it("does not crash and returns either null or a window with valid fields", () => {
    const result = findAncestorWindow(process.pid);
    // Either null (no visible ancestor — e.g. headless CI runner)
    // or a populated struct. We can't assume headed.
    if (result === null) {
      return; // acceptable on CI
    }
    expect(typeof result.hwnd).toBe("bigint");
    expect(result.pid).toBeGreaterThan(0);
    expect(typeof result.title).toBe("string");
    expect(result.region.width).toBeGreaterThanOrEqual(100);
    expect(result.region.height).toBeGreaterThanOrEqual(50);
  });
});

describe("getWindowProcessId", () => {
  it("returns 0 for a null hwnd (no crash)", () => {
    const pid = getWindowProcessId(null);
    expect(pid).toBe(0);
  });
});
