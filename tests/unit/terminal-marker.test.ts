/**
 * terminal-marker.test.ts — Unit tests for sinceMarker normalisation
 *
 * Exercises the normalizeForMarker fix for Windows Terminal UIA TextPattern
 * churn (trailing-space padding, CRLF vs LF, trailing blank lines).
 */

import { describe, it, expect } from "vitest";

// ── Inline reimplementation of the private helpers so we can test them
//    without exporting from production code. Keep in sync with terminal.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";

function normalizeForMarker(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

function makeMarker(text: string): string {
  const norm = normalizeForMarker(text);
  const slice = norm.slice(-256);
  return createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

function applySinceMarker(text: string, marker: string): { text: string; matched: boolean } {
  const norm = normalizeForMarker(text);
  const WINDOW = 256;

  function tailFromNormEnd(normEnd: number): string {
    return norm.slice(normEnd).replace(/^\n/, "");
  }

  if (norm.length >= WINDOW) {
    const maxScan = Math.min(norm.length, WINDOW + 32_000);
    for (let end = norm.length; end >= norm.length - maxScan && end >= WINDOW; end--) {
      const slice = norm.slice(end - WINDOW, end);
      if (createHash("sha256").update(slice).digest("hex").slice(0, 16) === marker) {
        return { text: tailFromNormEnd(end), matched: true };
      }
    }
    return { text, matched: false };
  }

  for (let end = norm.length; end >= 0; end--) {
    if (createHash("sha256").update(norm.slice(0, end)).digest("hex").slice(0, 16) === marker) {
      return { text: tailFromNormEnd(end), matched: true };
    }
  }

  return { text, matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeForMarker
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeForMarker", () => {
  it("converts CRLF to LF", () => {
    expect(normalizeForMarker("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("strips trailing spaces from each line", () => {
    expect(normalizeForMarker("line1   \nline2\t\nline3")).toBe("line1\nline2\nline3");
  });

  it("strips trailing blank lines", () => {
    expect(normalizeForMarker("a\nb\n\n\n")).toBe("a\nb");
  });

  it("handles CRLF + trailing spaces + trailing blank lines together", () => {
    const input = "PS C:\\>   \r\noutput   \r\nPS C:\\>   \r\n\r\n";
    expect(normalizeForMarker(input)).toBe("PS C:\\>\noutput\nPS C:\\>");
  });

  it("preserves internal blank lines (not trailing)", () => {
    expect(normalizeForMarker("a\n\nb")).toBe("a\n\nb");
  });

  it("returns empty string for all-whitespace input", () => {
    expect(normalizeForMarker("   \r\n   \r\n")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeMarker stability across padding churn
// ─────────────────────────────────────────────────────────────────────────────

describe("makeMarker stability", () => {
  const base = "PS C:\\Users\\user> echo hello\nhello\nPS C:\\Users\\user>";

  it("same content → same marker", () => {
    expect(makeMarker(base)).toBe(makeMarker(base));
  });

  it("CRLF vs LF → same marker", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    expect(makeMarker(crlf)).toBe(makeMarker(base));
  });

  it("trailing spaces on prompt line → same marker", () => {
    const padded = base.replace(/PS C:\\Users\\user>$/, "PS C:\\Users\\user>                    ");
    expect(makeMarker(padded)).toBe(makeMarker(base));
  });

  it("trailing blank line → same marker", () => {
    expect(makeMarker(base + "\n")).toBe(makeMarker(base));
    expect(makeMarker(base + "\n\n\n")).toBe(makeMarker(base));
  });

  it("CRLF + trailing spaces + trailing newline → same marker as clean LF", () => {
    const messy = base.replace(/\n/g, "   \r\n") + "   \r\n\r\n";
    expect(makeMarker(messy)).toBe(makeMarker(base));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applySinceMarker — the main sinceMarker scenario
// ─────────────────────────────────────────────────────────────────────────────

describe("applySinceMarker", () => {
  // Simulate Windows Terminal: 120-char wide rows, padded with spaces, CRLF.
  function wtLine(content: string, width = 120): string {
    return content.padEnd(width, " ");
  }
  function wtBuffer(lines: string[]): string {
    return lines.map(wtLine).join("\r\n") + "\r\n";
  }

  const prompt = "PS C:\\Users\\user>";
  const existingLines = [
    "PowerShell 7.6.0",
    prompt,
    "echo hello",
    "hello",
    prompt,
    "Get-Date",
    "2026-04-14 13:00:00",
    prompt,
  ];

  it("no new output: previousMatched=true, text=''", () => {
    const buf = wtBuffer(existingLines);
    const marker = makeMarker(buf);
    const result = applySinceMarker(buf, marker);
    expect(result.matched).toBe(true);
    expect(result.text).toBe("");
  });

  it("new command added: previousMatched=true, text contains new line", () => {
    const before = wtBuffer(existingLines);
    const marker = makeMarker(before);

    const newLines = [...existingLines, "Write-Host done", "done", prompt];
    const after = wtBuffer(newLines);

    const result = applySinceMarker(after, marker);
    expect(result.matched).toBe(true);
    expect(result.text).toContain("done");
  });

  it("trailing padding change only: still matches (the core regression)", () => {
    // Simulate: same content, prompt line gains/loses 1 trailing space.
    const before = wtBuffer(existingLines);
    const marker = makeMarker(before);

    // Slightly different padding on the last line (1 space difference)
    const tweakedLast = [...existingLines.slice(0, -1), prompt + " "];
    const after = wtBuffer(tweakedLast);

    const result = applySinceMarker(after, marker);
    expect(result.matched).toBe(true);
    expect(result.text).toBe("");
  });

  it("CRLF change only (LF buffer): still matches", () => {
    const before = wtBuffer(existingLines);
    const marker = makeMarker(before);

    // After-read uses LF instead of CRLF (different UIA rendering call)
    const afterLf = existingLines.join("\n") + "\n";
    const result = applySinceMarker(afterLf, marker);
    expect(result.matched).toBe(true);
  });

  it("unrelated marker: matched=false, full text returned", () => {
    const buf = wtBuffer(existingLines);
    const result = applySinceMarker(buf, "0000000000000000");
    expect(result.matched).toBe(false);
    expect(result.text).toBe(buf);
  });

  it("returned diff text has no trailing spaces or CRLF (normalised)", () => {
    const before = wtBuffer(existingLines);
    const marker = makeMarker(before);
    const newLines = [...existingLines, "Write-Host done", "done", prompt];
    const after = wtBuffer(newLines);

    const result = applySinceMarker(after, marker);
    expect(result.matched).toBe(true);
    // Diff must not contain trailing spaces or \r
    expect(result.text).not.toMatch(/[ \t]+\n/);
    expect(result.text).not.toMatch(/\r/);
    // Must contain the actual new content
    expect(result.text).toContain("Write-Host done");
    expect(result.text).toContain("done");
  });

  it("unchanged (no new output): matched=true, diff is exactly ''", () => {
    const buf = wtBuffer(existingLines);
    const marker = makeMarker(buf);
    const result = applySinceMarker(buf, marker);
    expect(result.matched).toBe(true);
    expect(result.text).toBe("");
  });

  it("short text (< 256 chars) path: matched when unchanged", () => {
    const short = "PS C:\\> echo hi\nhi\nPS C:\\>";
    const marker = makeMarker(short);
    expect(applySinceMarker(short, marker).matched).toBe(true);
  });

  it("short text: new content after previous short text", () => {
    const before = "PS C:\\> echo hi\nhi\nPS C:\\>";
    const marker = makeMarker(before);
    const after = before + "\nnew line\nPS C:\\>";
    const result = applySinceMarker(after, marker);
    expect(result.matched).toBe(true);
    expect(result.text).toContain("new line");
  });
});
