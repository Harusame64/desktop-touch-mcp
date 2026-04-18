/**
 * tests/unit/tab-drag-heuristic.test.ts
 *
 * Unit tests for detectTabDragRisk — no Win32 calls.
 */

import { describe, it, expect } from "vitest";
import { detectTabDragRisk, TITLEBAR_HEIGHT_PX } from "../../src/engine/perception/tab-drag-heuristic.js";

const WIN_TOP = 40; // simulated window top Y

describe("detectTabDragRisk", () => {
  it("returns risk:false for an unknown process", () => {
    const result = detectTabDragRisk(500, WIN_TOP + 10, 700, WIN_TOP + 10, WIN_TOP, "unknown");
    expect(result.risk).toBe(false);
  });

  it("returns risk:true for Notepad horizontal drag in title-bar (case-insensitive)", () => {
    // startY inside title bar, horizontal dominant
    const result = detectTabDragRisk(500, WIN_TOP + 20, 800, WIN_TOP + 20, WIN_TOP, "Notepad");
    expect(result.risk).toBe(true);
    expect(result.processName).toBe("notepad");
  });

  it("returns risk:true for WindowsTerminal", () => {
    const result = detectTabDragRisk(400, WIN_TOP + 30, 700, WIN_TOP + 30, WIN_TOP, "WindowsTerminal");
    expect(result.risk).toBe(true);
  });

  it("returns risk:false when startY is below the title-bar zone", () => {
    // startY is TITLEBAR_HEIGHT_PX below the window top → outside title bar
    const result = detectTabDragRisk(
      500, WIN_TOP + TITLEBAR_HEIGHT_PX + 1,
      800, WIN_TOP + TITLEBAR_HEIGHT_PX + 1,
      WIN_TOP, "Notepad"
    );
    expect(result.risk).toBe(false);
  });

  it("returns risk:false for a vertical drag (window-move intent)", () => {
    // |dy| > |dx| * 2 → vertical dominant
    const result = detectTabDragRisk(500, WIN_TOP + 20, 510, WIN_TOP + 200, WIN_TOP, "Notepad");
    expect(result.risk).toBe(false);
  });

  it("returns risk:false when dx ≤ dy*2 (diagonal drag — ambiguous, do not block)", () => {
    // dx=100, dy=60 → dx > dy*2? 100 > 120? No → false
    const result = detectTabDragRisk(500, WIN_TOP + 20, 600, WIN_TOP + 80, WIN_TOP, "Notepad");
    expect(result.risk).toBe(false);
  });

  it("returns risk:true for chrome.exe (no .exe suffix in processName)", () => {
    const result = detectTabDragRisk(400, WIN_TOP + 10, 700, WIN_TOP + 10, WIN_TOP, "chrome");
    expect(result.risk).toBe(true);
  });

  it("returns risk:false when drag starts exactly at title-bar boundary (not strictly inside)", () => {
    // startY - windowTop === TITLEBAR_HEIGHT_PX → NOT < TITLEBAR_HEIGHT_PX
    const result = detectTabDragRisk(
      500, WIN_TOP + TITLEBAR_HEIGHT_PX,
      800, WIN_TOP + TITLEBAR_HEIGHT_PX,
      WIN_TOP, "Notepad"
    );
    expect(result.risk).toBe(false);
  });
});
