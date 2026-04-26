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
  "browser.ts", "clipboard.ts", "desktop-state.ts", "dock.ts", "server-status.ts", "events.ts",
  "keyboard.ts", "macro.ts", "mouse.ts", "notification.ts", "perception.ts", "pin.ts",
  "screenshot.ts", "scroll-capture.ts", "scroll-to-element.ts", "smart-scroll.ts",
  "terminal.ts", "ui-elements.ts", "wait-until.ts", "window.ts", "workspace.ts",
  // Phase 2 dispatchers
  "window-dock.ts",
  "scroll.ts",
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

/** Extract the description from a registerTool config block (description: "..." or buildDesc(...)) */
function extractRegisterToolDescription(src: string, configStartIdx: number): string {
  // Find the end of the config object by matching braces
  let depth = 1; let i = configStartIdx;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++; else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(configStartIdx, i - 1);

  // Look for description: "..." or description: buildDesc(...)
  const descFieldRe = /description\s*:\s*/g;
  let dm: RegExpExecArray | null;
  while ((dm = descFieldRe.exec(body)) !== null) {
    const pos = dm.index + dm[0].length;
    if (body.startsWith("buildDesc(", pos)) {
      return extractBuildDescText(body, pos + "buildDesc(".length);
    }
    const q = body[pos];
    if (q === '"' || q === "'" || q === "`") {
      return extractStringLiteral(body, pos);
    }
  }
  return "";
}

function parseToolFile(filePath: string, fileName: string): ToolDesc[] {
  const src = readFileSync(filePath, "utf-8");
  const entries: ToolDesc[] = [];

  // --- server.tool(...) calls ---
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

  // --- server.registerTool(...) calls ---
  const registerToolRe = /server\.registerTool\s*\(\s*/g;
  let rm: RegExpExecArray | null;

  while ((rm = registerToolRe.exec(src)) !== null) {
    const afterOpen = rm.index + rm[0].length;
    const nameQuote = src[afterOpen];
    if (nameQuote !== '"' && nameQuote !== "'" && nameQuote !== "`") continue;
    const name = extractStringLiteral(src, afterOpen);
    const afterName = src.indexOf(nameQuote, afterOpen + 1) + 1;

    let pos = afterName;
    while (pos < src.length && /[\s,]/.test(src[pos]!)) pos++;

    // Next arg should be the config object starting with {
    if (src[pos] !== "{") continue;
    const description = extractRegisterToolDescription(src, pos + 1);
    if (!description) continue;
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
  // Phase 2a: -7 old (keyboard_type/press, clipboard_read/write, dock_window, pin_window, unpin_window)
  //            +3 new dispatchers (keyboard, clipboard, window_dock) → 58-7+3 = 54
  // Phase 2b: -4 old (scroll raw, scroll_capture, smart_scroll, scroll_to_element)
  //            +1 new dispatcher (scroll) → 54-4+1 = 51
  // Phase 2c: -2 old (terminal_read, terminal_send) +1 new dispatcher (terminal) → 51-2+1 = 50
  // Phase 3:  -4 old (browser_launch, browser_get_dom, browser_get_app_state, browser_disconnect)
  //           browser_launch absorbed into browser_open.launch, get_dom + get_app_state into
  //           browser_eval discriminatedUnion, browser_disconnect privatized → 50-4 = 46
  // Phase 4: -20 (10 privatized: events_*/perception_*/get_history/mouse_move
  //              + 3 screenshot absorbed: screenshot_background/screenshot_ocr/scope_element
  //              + 1 desktop_act absorbed: set_element_value
  //              + 6 desktop_state/desktop_discover absorbed:
  //                get_active_window/get_cursor_position/get_document_state/
  //                get_screen_info/get_ui_elements/get_windows) → 46-20 = 26
  it("finds exactly 26 registered tools", () => {
    expect(allTools.length).toBe(26);
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
