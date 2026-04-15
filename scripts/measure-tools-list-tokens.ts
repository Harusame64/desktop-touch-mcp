/**
 * scripts/measure-tools-list-tokens.ts
 *
 * Measures the character length (and estimated token count) of every registered
 * tool description in desktop-touch-mcp.
 *
 * Estimation: 1 token ≈ 4 characters for English technical prose (GPT/Claude rule-of-thumb).
 *
 * Run: npx tsx scripts/measure-tools-list-tokens.ts
 *
 * Output: per-tool table sorted by description length, with Tier A/B/C grouping,
 * plus grand totals for use in PR descriptions and release notes.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Tool tier classification (from docs/description-rewrite-draft.md)
// ─────────────────────────────────────────────────────────────────────────────

const TIER_A = new Set([
  "screenshot", "screenshot_background", "scroll_capture", "wait_until",
  "workspace_snapshot", "workspace_launch", "run_macro", "events_subscribe",
  "dock_window", "get_context",
]);

const TIER_B = new Set([
  "screenshot_ocr", "mouse_click", "mouse_drag", "keyboard_type", "keyboard_press",
  "click_element", "set_element_value", "focus_window", "pin_window",
  "get_ui_elements", "scope_element", "terminal_send", "terminal_read",
  "browser_connect", "browser_get_interactive", "browser_click_element",
  "browser_find_element", "browser_navigate", "browser_search",
  "browser_get_app_state", "browser_launch", "get_windows",
]);

const TIER_C = new Set([
  "get_active_window", "mouse_move", "scroll", "get_cursor_position",
  "get_screen_info", "get_document_state", "get_history",
  "events_poll", "events_unsubscribe", "events_list",
  "browser_eval", "browser_get_dom", "browser_disconnect", "unpin_window",
]);

function tier(name: string): string {
  if (TIER_A.has(name)) return "A";
  if (TIER_B.has(name)) return "B";
  if (TIER_C.has(name)) return "C";
  return "?";
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse tool descriptions from source files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the text content of a buildDesc({...}) call.
 * Reconstructs the output string: "Purpose: ...\nDetails: ...\nPrefer: ...\nCaveats: ...\nExamples:\n  ..."
 */
function extractBuildDesc(src: string, startIdx: number): string {
  // Find the matching closing paren of buildDesc(
  let depth = 1;
  let i = startIdx;
  while (i < src.length && depth > 0) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
    i++;
  }
  const body = src.slice(startIdx, i - 1);

  // Extract field values using simple string-value patterns
  function extractField(field: string): string {
    // Matches: field: "...", or field: `...`, with possible multiline
    const re = new RegExp(`${field}:\\s*\`([\\s\\S]*?)\`|${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(body);
    return m ? (m[1] ?? m[2] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
  }

  function extractExamples(): string[] {
    const m = /examples:\s*\[([^\]]*)\]/s.exec(body);
    if (!m) return [];
    const arrBody = m[1]!;
    const results: string[] = [];
    const strRe = /`([\s\S]*?)`|"((?:[^"\\]|\\.)*)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(arrBody)) !== null) {
      results.push((sm[1] ?? sm[2] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    }
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

/**
 * Extract a plain string literal (double-quoted or backtick) starting at `pos`.
 * Returns the content (without quotes), handling basic escape sequences.
 */
function extractStringLiteral(src: string, pos: number): string {
  const quote = src[pos];
  if (quote === '"' || quote === "'") {
    let result = "";
    let i = pos + 1;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\" && i + 1 < src.length) {
        const esc = src[i + 1]!;
        if (esc === "n") result += "\n";
        else if (esc === "t") result += "\t";
        else result += esc;
        i += 2;
      } else {
        result += src[i++];
      }
    }
    return result;
  }
  if (quote === "`") {
    let result = "";
    let i = pos + 1;
    while (i < src.length) {
      if (src[i] === "`") break;
      if (src[i] === "$" && src[i + 1] === "{") {
        // Skip template expression — treat as opaque
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
      } else {
        result += src[i++];
      }
    }
    return result;
  }
  return "";
}

interface ToolEntry {
  name: string;
  description: string;
  chars: number;
  estTokens: number;
  tier: string;
  file: string;
}

function parseToolFile(filePath: string, fileName: string): ToolEntry[] {
  const src = readFileSync(filePath, "utf-8");
  const entries: ToolEntry[] = [];

  // Find all server.tool( calls
  const serverToolRe = /server\.tool\s*\(\s*/g;
  let m: RegExpExecArray | null;

  while ((m = serverToolRe.exec(src)) !== null) {
    const afterOpen = m.index + m[0].length;

    // 1st arg: tool name (string literal)
    const nameQuote = src[afterOpen];
    if (nameQuote !== '"' && nameQuote !== "'" && nameQuote !== "`") continue;
    const name = extractStringLiteral(src, afterOpen);
    const afterName = src.indexOf(nameQuote, afterOpen + 1) + 1;

    // Skip comma + whitespace
    let pos = afterName;
    while (pos < src.length && /[\s,]/.test(src[pos]!)) pos++;

    // 2nd arg: description — either buildDesc(...) or string literal
    let description: string;
    if (src.startsWith("buildDesc(", pos)) {
      const buildStart = pos + "buildDesc(".length;
      description = extractBuildDesc(src, buildStart);
    } else {
      const q = src[pos];
      if (q !== '"' && q !== "'" && q !== "`") continue;
      description = extractStringLiteral(src, pos);
    }

    const chars = description.length;
    entries.push({
      name,
      description,
      chars,
      estTokens: Math.round(chars / 4),
      tier: tier(name),
      file: fileName,
    });
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_FILES = [
  "browser.ts", "clipboard.ts", "context.ts", "dock.ts", "events.ts", "keyboard.ts",
  "macro.ts", "mouse.ts", "notification.ts", "pin.ts", "screenshot.ts", "scroll-capture.ts",
  "scroll-to-element.ts", "terminal.ts", "ui-elements.ts", "wait-until.ts", "window.ts", "workspace.ts",
];

const all: ToolEntry[] = [];
for (const f of TOOL_FILES) {
  const entries = parseToolFile(join(ROOT, "src", "tools", f), f);
  all.push(...entries);
}

// Sort by tier then by chars desc
const tierOrder: Record<string, number> = { A: 0, B: 1, C: 2, "?": 3 };
all.sort((a, b) => {
  const td = (tierOrder[a.tier] ?? 3) - (tierOrder[b.tier] ?? 3);
  return td !== 0 ? td : b.chars - a.chars;
});

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

const COL_NAME = 32;
const COL_TIER = 5;
const COL_CHARS = 7;
const COL_TOK = 7;

function pad(s: string, n: number): string { return s.padEnd(n); }
function rpad(s: string, n: number): string { return s.padStart(n); }

const header = `${pad("Tool", COL_NAME)}${pad("Tier", COL_TIER)}${rpad("Chars", COL_CHARS)}  ${rpad("~Tok", COL_TOK)}  File`;
const sep = "─".repeat(header.length);

console.log("\n" + sep);
console.log(header);
console.log(sep);

let currentTier = "";
let tierChars = 0;
let tierToks = 0;
let tierCount = 0;

function printTierSummary() {
  if (!currentTier) return;
  console.log(`${"─".repeat(COL_NAME + COL_TIER)}${rpad(String(tierChars), COL_CHARS)}  ${rpad(String(tierToks), COL_TOK)}  ← Tier ${currentTier} subtotal (${tierCount} tools)`);
}

for (const e of all) {
  if (e.tier !== currentTier) {
    printTierSummary();
    if (currentTier) console.log();
    currentTier = e.tier;
    tierChars = 0; tierToks = 0; tierCount = 0;
  }
  console.log(`${pad(e.name, COL_NAME)}${pad(e.tier, COL_TIER)}${rpad(String(e.chars), COL_CHARS)}  ${rpad(String(e.estTokens), COL_TOK)}  ${e.file}`);
  tierChars += e.chars; tierToks += e.estTokens; tierCount++;
}
printTierSummary();

console.log(sep);

const totalChars = all.reduce((s, e) => s + e.chars, 0);
const totalToks  = all.reduce((s, e) => s + e.estTokens, 0);
console.log(`${pad("TOTAL (descriptions only)", COL_NAME + COL_TIER)}${rpad(String(totalChars), COL_CHARS)}  ${rpad(String(totalToks), COL_TOK)}`);
console.log(`${pad("", COL_NAME + COL_TIER)}${"─".repeat(COL_CHARS + COL_TOK + 4)}`);
console.log(`\nNote: ~1 token = 4 chars (English technical prose estimate).`);
console.log(`      Add ~300 tok for instructions, ~50 tok/tool for schema overhead.`);
console.log(`      Total tools found: ${all.length}\n`);
