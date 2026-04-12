/**
 * dock-auto.test.ts — Unit tests for auto-dock environment variable parsing.
 *
 * Pure-function tests; no Win32 API, no window manipulation required.
 */

import { describe, it, expect } from "vitest";
import { resolveDimSpec, parseCorner, parseBoolEnv } from "../../src/tools/dock.js";

describe("resolveDimSpec", () => {
  const WA_WIDTH = 3840; // 4K monitor work area width
  const WA_HEIGHT = 2160;
  const DPI_96 = 96;
  const DPI_192 = 192; // 200% scaling

  it("parses px values without DPI scaling", () => {
    expect(resolveDimSpec("480", 100, WA_WIDTH, DPI_96, false)).toBe(480);
    expect(resolveDimSpec("480", 100, WA_WIDTH, DPI_192, false)).toBe(480);
  });

  it("applies DPI scaling to px values when enabled", () => {
    expect(resolveDimSpec("480", 100, WA_WIDTH, DPI_96, true)).toBe(480); // 480 * 96/96
    expect(resolveDimSpec("480", 100, WA_WIDTH, DPI_192, true)).toBe(960); // 480 * 192/96
    expect(resolveDimSpec("480", 100, WA_WIDTH, 144, true)).toBe(720); // 480 * 144/96
  });

  it("parses ratio values (%) against work area", () => {
    expect(resolveDimSpec("25%", 100, WA_WIDTH, DPI_96, false)).toBe(960); // 3840 * 0.25
    expect(resolveDimSpec("50%", 100, WA_HEIGHT, DPI_96, false)).toBe(1080); // 2160 * 0.5
  });

  it("ratio values ignore DPI scaling (already proportional)", () => {
    expect(resolveDimSpec("25%", 100, WA_WIDTH, DPI_192, true)).toBe(960);
    expect(resolveDimSpec("25%", 100, WA_WIDTH, DPI_192, false)).toBe(960);
  });

  it("enforces a 100px minimum for ratio results", () => {
    expect(resolveDimSpec("1%", 100, 500, DPI_96, false)).toBe(100); // 500 * 0.01 = 5 → floor 100
  });

  it("falls back when spec is undefined or empty", () => {
    expect(resolveDimSpec(undefined, 480, WA_WIDTH, DPI_96, false)).toBe(480);
    expect(resolveDimSpec("", 480, WA_WIDTH, DPI_96, false)).toBe(480);
    expect(resolveDimSpec("   ", 480, WA_WIDTH, DPI_96, false)).toBe(480);
  });

  it("falls back on garbage input", () => {
    expect(resolveDimSpec("abc", 480, WA_WIDTH, DPI_96, false)).toBe(480);
    expect(resolveDimSpec("-100", 480, WA_WIDTH, DPI_96, false)).toBe(480);
    expect(resolveDimSpec("0", 480, WA_WIDTH, DPI_96, false)).toBe(480);
  });

  it("DPI-scales the fallback value when scaleDpi=true", () => {
    expect(resolveDimSpec(undefined, 480, WA_WIDTH, DPI_192, true)).toBe(960);
  });
});

describe("parseCorner", () => {
  it("accepts the four valid values", () => {
    expect(parseCorner("top-left")).toBe("top-left");
    expect(parseCorner("top-right")).toBe("top-right");
    expect(parseCorner("bottom-left")).toBe("bottom-left");
    expect(parseCorner("bottom-right")).toBe("bottom-right");
  });

  it("is case-insensitive", () => {
    expect(parseCorner("TOP-LEFT")).toBe("top-left");
    expect(parseCorner("Bottom-Right")).toBe("bottom-right");
  });

  it("falls back to bottom-right for unknown/empty input", () => {
    expect(parseCorner(undefined)).toBe("bottom-right");
    expect(parseCorner("")).toBe("bottom-right");
    expect(parseCorner("middle")).toBe("bottom-right");
    expect(parseCorner("center")).toBe("bottom-right");
  });
});

describe("parseBoolEnv", () => {
  it("parses truthy values", () => {
    expect(parseBoolEnv("1", false)).toBe(true);
    expect(parseBoolEnv("true", false)).toBe(true);
    expect(parseBoolEnv("TRUE", false)).toBe(true);
    expect(parseBoolEnv("yes", false)).toBe(true);
    expect(parseBoolEnv("on", false)).toBe(true);
  });

  it("parses falsy values", () => {
    expect(parseBoolEnv("0", true)).toBe(false);
    expect(parseBoolEnv("false", true)).toBe(false);
    expect(parseBoolEnv("no", true)).toBe(false);
    expect(parseBoolEnv("off", true)).toBe(false);
  });

  it("uses fallback for undefined or unknown", () => {
    expect(parseBoolEnv(undefined, true)).toBe(true);
    expect(parseBoolEnv(undefined, false)).toBe(false);
    expect(parseBoolEnv("maybe", true)).toBe(true);
    expect(parseBoolEnv("maybe", false)).toBe(false);
  });
});
