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

// ─────────────────────────────────────────────────────────────────────────────
// D4: stripAnsi with Japanese / multibyte characters
// ─────────────────────────────────────────────────────────────────────────────

describe("D4: stripAnsi with Japanese/multibyte characters", () => {
  it("preserves plain Japanese text unchanged", () => {
    expect(stripAnsi("日本語テスト")).toBe("日本語テスト");
  });

  it("removes SGR color codes while preserving Japanese filenames", () => {
    // Typical ls --color=always output with Japanese directory/file names
    const input = "\x1b[1;34mフォルダ\x1b[0m  \x1b[0;32m日本語ファイル.txt\x1b[0m";
    expect(stripAnsi(input)).toBe("フォルダ  日本語ファイル.txt");
  });

  it("removes OSC title sequence preceding Japanese output", () => {
    // Terminal sets title via OSC, then prints Japanese content
    const input = "\x1b]0;ターミナル\x07日本語出力";
    expect(stripAnsi(input)).toBe("日本語出力");
  });

  it("handles multi-line Japanese output with ANSI color codes", () => {
    const input = [
      "\x1b[32mドキュメント\x1b[0m",
      "\x1b[33mダウンロード\x1b[0m",
      "\x1b[34mピクチャ\x1b[0m",
    ].join("\n");
    expect(stripAnsi(input)).toBe("ドキュメント\nダウンロード\nピクチャ");
  });

  it("ANSI reset sequence (ESC[0m) does not corrupt adjacent Japanese chars", () => {
    // ESC[0m = \x1b[0m — the final byte 'm' (0x6D) is ASCII and must not
    // bleed into the following Japanese code points.
    const input = "\x1b[0m漢字\x1b[0m";
    expect(stripAnsi(input)).toBe("漢字");
  });

  it("strips ls --color=always style output with mixed Japanese/ASCII", () => {
    const blue = "\x1b[1;34m";
    const green = "\x1b[0;32m";
    const reset = "\x1b[0m";
    const input = [
      `${blue}画像${reset}  ${green}README.md${reset}`,
      `${blue}ドキュメント${reset}  ${green}設定.json${reset}`,
    ].join("\n");
    expect(stripAnsi(input)).toBe("画像  README.md\nドキュメント  設定.json");
  });

  it("handles Katakana-Hiragana-Kanji mix with ANSI without corruption", () => {
    // All three Japanese script types in one line
    const input = "\x1b[33mひらがな\x1b[0m / \x1b[36mカタカナ\x1b[0m / \x1b[35m漢字\x1b[0m";
    expect(stripAnsi(input)).toBe("ひらがな / カタカナ / 漢字");
  });

  it("Windows Terminal-style prompt with Japanese directory (PowerShell)", () => {
    // PS C:\ドキュメント> with typical PS color escape sequences
    const input = "\x1b[32mPS\x1b[0m \x1b[34mC:\\ドキュメント\x1b[0m\x1b[33m>\x1b[0m ";
    expect(stripAnsi(input)).toBe("PS C:\\ドキュメント> ");
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
