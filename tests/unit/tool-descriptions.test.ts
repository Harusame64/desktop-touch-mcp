/**
 * tests/unit/tool-descriptions.test.ts
 *
 * Contract tests for tool description strings.
 * Guards against description drift as new tools are added.
 *
 * Rules:
 *   - Every description must be non-empty
 *   - No description should exceed MAX_CHARS (avoids runaway verbosity)
 *   - Every description must start with an uppercase letter or a known prefix
 *   - No description should contain placeholder text (e.g. "TODO", "FIXME", "...")
 *
 * Parsing: same regex-based approach as scripts/measure-tools-list-tokens.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const TOOL_FILES = [
  "browser.ts", "clipboard.ts", "context.ts", "dock.ts", "events.ts", "keyboard.ts",
  "macro.ts", "mouse.ts", "notification.ts", "perception.ts", "pin.ts", "screenshot.ts",
  "scroll-capture.ts", "scroll-to-element.ts", "smart-scroll.ts", "terminal.ts",
  "ui-elements.ts", "wait-until.ts", "window.ts", "workspace.ts",
];

const MIN_CHARS = 20;
const MAX_CHARS = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal parser (mirrors scripts/measure-tools-list-tokens.ts)
// ─────────────────────────────────────────────────────────────────────────────

function extractStringLiteral(src: string, pos: number): string {
  const quote = src[pos];
  if (quote === '"' || quote === "'") {
    let result = "";
    let i = pos + 1;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\" && i + 1 < src.length) {
        const esc = src[i + 1]!;
        result += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
        i += 2;
      } else { result += src[i++]; }
    }
    return result;
  }
  if (quote === "`") {
    let result = "";
    let i = pos + 1;
    while (i < src.length) {
      if (src[i] === "`") break;
      if (src[i] === "$" && src[i + 1] === "{") {
        let depth = 1; i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
      } else { result += src[i++]; }
    }
    return result;
  }
  return "";
}

function extractBuildDescText(src: string, startIdx: number): string {
  let depth = 1; let i = startIdx;
  while (i < src.length && depth > 0) {
    if (src[i] === "(") depth++; else if (src[i] === ")") depth--;
    i++;
  }
  const body = src.slice(startIdx, i - 1);

  function extractField(field: string): string {
    const re = new RegExp(`${field}:\\s*\`([\\s\\S]*?)\`|${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(body);
    return m ? (m[1] ?? m[2] ?? "") : "";
  }

  function extractExamples(): string[] {
    const m = /examples:\s*\[([^\]]*)\]/s.exec(body);
    if (!m) return [];
    const results: string[] = [];
    const strRe = /`([\s\S]*?)`|"((?:[^"\\]|\\.)*)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(m[1]!)) !== null) results.push(sm[1] ?? sm[2] ?? "");
    return results;
  }

  const parts: string[] = [];
  const purpose = extractField("purpose");
  const details = extractField("details");
  const prefer = extractField("prefer");
  const caveats = extractField("caveats");
  const examples = extractExamples();

  if (purpose) parts.push(`Purpose: ${purpose}`);
  if (details) parts.push(`Details: ${details}`);
  if (prefer) parts.push(`Prefer: ${prefer}`);
  if (caveats) parts.push(`Caveats: ${caveats}`);
  if (examples.length) parts.push(`Examples:\n${examples.map(e => `  ${e}`).join("\n")}`);
  return parts.join("\n");
}

interface ToolDesc { name: string; description: string; file: string; }

function parseToolFile(filePath: string, fileName: string): ToolDesc[] {
  const src = readFileSync(filePath, "utf-8");
  const entries: ToolDesc[] = [];
  const serverToolRe = /server\.tool\s*\(\s*/g;
  let m: RegExpExecArray | null;

  while ((m = serverToolRe.exec(src)) !== null) {
    const afterOpen = m.index + m[0].length;
    const nameQuote = src[afterOpen];
    if (nameQuote !== '"' && nameQuote !== "'" && nameQuote !== "`") continue;
    const name = extractStringLiteral(src, afterOpen);
    const afterName = src.indexOf(nameQuote, afterOpen + 1) + 1;

    let pos = afterName;
    while (pos < src.length && /[\s,]/.test(src[pos]!)) pos++;

    let description: string;
    if (src.startsWith("buildDesc(", pos)) {
      description = extractBuildDescText(src, pos + "buildDesc(".length);
    } else {
      const q = src[pos];
      if (q !== '"' && q !== "'" && q !== "`") continue;
      description = extractStringLiteral(src, pos);
    }
    entries.push({ name, description, file: fileName });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const allTools: ToolDesc[] = [];
for (const f of TOOL_FILES) {
  allTools.push(...parseToolFile(join(ROOT, "src", "tools", f), f));
}

describe("tool descriptions — contract", () => {
  it("finds at least 50 registered tools", () => {
    expect(allTools.length).toBeGreaterThanOrEqual(50);
  });

  for (const tool of allTools) {
    describe(`${tool.name} (${tool.file})`, () => {
      it("is non-empty", () => {
        expect(tool.description.trim().length).toBeGreaterThan(0);
      });

      it(`has at least ${MIN_CHARS} characters`, () => {
        expect(tool.description.length).toBeGreaterThanOrEqual(MIN_CHARS);
      });

      it(`does not exceed ${MAX_CHARS} characters`, () => {
        expect(tool.description.length).toBeLessThanOrEqual(MAX_CHARS);
      });

      it("contains no placeholder text", () => {
        const lower = tool.description.toLowerCase();
        expect(lower).not.toContain("todo");
        expect(lower).not.toContain("fixme");
        expect(lower).not.toContain("placeholder");
      });

      it("starts with an uppercase letter", () => {
        const first = tool.description.trimStart()[0] ?? "";
        expect(first).toMatch(/[A-Z]/);
      });
    });
  }
});
