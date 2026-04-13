import { describe, it, expect } from "vitest";
import { stripAnsi, tailLines } from "../../src/engine/ansi.js";

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("removes cursor-position sequences", () => {
    expect(stripAnsi("before\x1b[10;5Hafter")).toBe("beforeafter");
  });

  it("removes OSC title sequences (both BEL and ST terminators)", () => {
    expect(stripAnsi("\x1b]0;my title\x07body")).toBe("body");
    expect(stripAnsi("\x1b]0;other\x1b\\body")).toBe("body");
  });

  it("removes lone control characters but keeps CR/LF/TAB", () => {
    expect(stripAnsi("a\x00b\x1fc")).toBe("abc");
    expect(stripAnsi("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });

  it("is a no-op for plain ASCII", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("tailLines", () => {
  it("returns whole text when it has fewer lines than n", () => {
    expect(tailLines("a\nb\nc", 10)).toBe("a\nb\nc");
  });

  it("returns the last n lines when longer", () => {
    expect(tailLines("a\nb\nc\nd\ne", 2)).toBe("d\ne");
  });

  it("returns empty string for n <= 0", () => {
    expect(tailLines("hello", 0)).toBe("");
  });
});
