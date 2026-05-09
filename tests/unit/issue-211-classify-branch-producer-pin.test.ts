/**
 * issue-211-classify-branch-producer-pin.test.ts
 *
 * Phase 5 §4.bis structural guard — pin every `_errors.ts` classify
 * branch to a real production producer in `src/`.
 *
 * Why this test exists:
 *   PR #219 review (epic #211 Phase 5 closure) uncovered three "dead
 *   typed codes" — entries registered in classify() + SUGGESTS dictionary
 *   but with no producer in `src/`:
 *     - AutoGuardBlocked: classify branch missing entirely (different
 *       defect class — not detected by this test, see §4.bis)
 *     - TerminalMarkerStale: classify branch + SUGGESTS exist, no producer
 *     - MaxDepthExceeded: classify branch + SUGGESTS exist, no producer
 *
 *   The pattern is the same as E1 (typeViaClipboard read-back, PR #224)
 *   and E3 (mouse_drag ForegroundRestricted, PR #223): when a unify PR
 *   adds a contract to one tool but misses a sibling that shares the
 *   helper / chain. Without a structural guard, future regressions of
 *   this shape silently land — typed codes accumulate in classify
 *   while production never emits them, and LLM-perspective recovery
 *   docs become liars.
 *
 * Pinning strategy:
 *   - Parse classify() and extract (typedCode, m.includes(keyword) list).
 *   - For each typed code, search `src/` (excluding _errors.ts and
 *     non-source paths) for at least one of:
 *       * `new Error("<keyword>")` — string-error path (most classify
 *         branches resolve via this — production throws a string-shaped
 *         error and classify maps it via substring)
 *       * `code: "<typedCode>"` — direct fail() emit (TerminalText
 *         PatternUnavailable, NavigateFailed, etc.)
 *   - Allow-list two categories:
 *       * RESERVED_ALLOW_LIST: matrix §5.2 reserved-only typed codes
 *         (MouseClickNotDelivered / MouseDragNotDelivered /
 *         BrowserClickNotDelivered — classify-only by design, hint-level
 *         degradation is the contract)
 *       * DEAD_ALLOW_LIST: §4.bis-documented dead codes still in the
 *         dictionary (TerminalMarkerStale / MaxDepthExceeded — kept for
 *         documentation reference + future producer wiring; see Phase 6
 *         cleanup carry-over)
 *
 *   Any other classify branch with no producer fails this test → forces
 *   the next PR to either add a producer, allow-list with rationale, or
 *   remove the classify+SUGGESTS entry.
 *
 * Caveats:
 *   - Producer detection is keyword-based, not AST-based. False
 *     positives (e.g., a classify keyword appearing in a code comment
 *     that uses `new Error("...")` syntax in prose) are theoretically
 *     possible but practically rare; the regex requires the literal
 *     `new Error("..."` form which doesn't normally appear inside
 *     comments. False negatives would mean a real producer using a
 *     non-standard emit path slips through — caught by the next manual
 *     audit cycle, not this CI guard.
 *   - The parser handles multi-line `if (...)` conditions via brace
 *     counting; verified against current classify() shape (32 branches as
 *     of Phase 5 closure 2026-05-10; sanity-bounded `>= 20 && < 60` to
 *     accommodate future additions).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const SRC_DIR = join(ROOT, "src");
const ERRORS_FILE = join(SRC_DIR, "tools/_errors.ts");

// ── Allow-lists ──────────────────────────────────────────────────────────────

/** matrix §5.2: typed codes deliberately reserved-only (false-positive risk). */
const RESERVED_ALLOW_LIST = new Set<string>([
  "MouseClickNotDelivered",
  "MouseDragNotDelivered",
  "BrowserClickNotDelivered",
]);

/** §4.bis: classify-registered codes documented as currently producer-less. */
const DEAD_ALLOW_LIST = new Set<string>([
  "TerminalMarkerStale",   // stale marker signaled via hints.terminalMarker.previousMatched
  "MaxDepthExceeded",      // smart-scroll caps via `while (depth < MAXDEPTH)`, no failWith
  "LensBudgetExceeded",    // discovered by THIS test on first run — classify+SUGGESTS
                           //   registered (perception/registry lens count cap concept)
                           //   but no producer in src/. Documented in §4.bis Round 2
                           //   addendum. TODO: Phase 6 — either wire a producer when
                           //   the lens cap is enforced, or remove the classify entry.
]);

// ── Parser ───────────────────────────────────────────────────────────────────

interface ClassifyBranch {
  code: string;
  keywords: string[];
}

/**
 * Extract (typed code, keyword list) pairs from `classify(message)` in
 * `_errors.ts`. Uses brace counting to find the function body, then a
 * single pass over lines that pairs each `if (...)` block with the
 * `code: "..."` from its return statement.
 */
function parseClassifyBranches(src: string): ClassifyBranch[] {
  // Match the full classify() signature including the inline return-type
  // annotation `: { code: string; suggest: string[] }` so that the next `{`
  // is the function body, not the return-type brace. (Earlier draft used
  // just `function classify(message: string)` and matched the wrong `{`.)
  const fnSig = "function classify(message: string): { code: string; suggest: string[] }";
  const start = src.indexOf(fnSig);
  if (start === -1) throw new Error("classify() function not found in _errors.ts");

  let i = src.indexOf("{", start + fnSig.length);
  if (i === -1) throw new Error("classify() body open brace not found");
  let depth = 1;
  i++;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(bodyStart, i - 1);

  // Match each branch: `if (cond) { return { code: "...", suggest: ... }; }`.
  // Condition may span multiple lines (we use `[\s\S]+?` for non-greedy).
  // The return body always contains `code: "..."` — we capture that.
  const branchRe = /if\s*\(([\s\S]+?)\)\s*\{\s*return\s*\{\s*code:\s*"([^"]+)"/g;
  const branches: ClassifyBranch[] = [];
  let m: RegExpExecArray | null;
  while ((m = branchRe.exec(body)) !== null) {
    const condition = m[1] ?? "";
    const code = m[2] ?? "";
    const keywords: string[] = [];
    const kwRe = /m\.includes\("([^"]+)"\)/g;
    let kw: RegExpExecArray | null;
    while ((kw = kwRe.exec(condition)) !== null) {
      keywords.push(kw[1] ?? "");
    }
    // Also capture `m === "..."` for the rare `m === "disabled"` case.
    const eqRe = /m\s*===\s*"([^"]+)"/g;
    let eq: RegExpExecArray | null;
    while ((eq = eqRe.exec(condition)) !== null) {
      keywords.push(eq[1] ?? "");
    }
    // Also capture `m.startsWith("...")` if present.
    const swRe = /m\.startsWith\("([^"]+)"\)/g;
    let sw: RegExpExecArray | null;
    while ((sw = swRe.exec(condition)) !== null) {
      keywords.push(sw[1] ?? "");
    }
    branches.push({ code, keywords });
  }
  return branches;
}

// ── Producer detection ───────────────────────────────────────────────────────

/** Walk `src/` for `.ts` files, excluding stub catalog and the classify file itself. */
function walkSrcTs(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "tests") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSrcTs(full, results);
    } else if (entry.endsWith(".ts") && entry !== "_errors.ts" && entry !== "stub-tool-catalog.ts") {
      results.push(full);
    }
  }
  return results;
}

/** Escape a string for use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the first producer file (relative path) for a typed code,
 * or null if no producer is found. Producer signals (any of these counts):
 *   1. `new Error("<typedCode>"...)` — direct typed-code throw (case-insensitive
 *      since classify lowercases the message before matching, but the source
 *      typically uses the canonical PascalCase)
 *   2. `code: "<typedCode>"` — direct fail() emit
 *   3. `new Error("<keyword>...")` — Error-wrapped string matching a classify
 *      keyword (case-insensitive since classify uses .toLowerCase())
 *   4. `failWith("<keyword>...", ...)` — bare string passed to failWith
 *      (terminal.ts:279, browser.ts:844 use this form). failWith accepts
 *      either a string or an Error; classify operates on the string repr
 *      either way.
 *   5. `Write-Output '{"ok":false,...,"error":"<keyword>..."}'` — PowerShell
 *      bridge scripts that emit JSON error envelopes the TS handler then
 *      passes through failWith. Catches uia-bridge.ts ScriptElementsLoaded
 *      / Element-is-disabled / Element-not-found paths that don't go via
 *      `new Error` in TS.
 */
function findFirstProducer(branch: ClassifyBranch, srcFiles: string[]): string | null {
  const escCode = escapeRegex(branch.code);
  // Direct typed-code references — these alone are sufficient producer signals.
  const codeReDirects = [
    new RegExp(`new Error\\("${escCode}["\\s:]`, "i"),
    new RegExp(`code:\\s*"${escCode}"`),
    // browser.ts:1960 internal `__error: "ScopeNotFound"` shape and the
    // mapping at browser.ts:2150 `__error === "ScopeNotFound" ? "..."`.
    new RegExp(`__error:\\s*"${escCode}"`),
    new RegExp(`__error\\s*===\\s*"${escCode}"`),
  ];
  // Per-keyword regexes — match any string-literal (double-quote OR
  // backtick template) in src/ that contains the keyword and is wrapped
  // by Error(...) / failWith(...) / super(...) / a PowerShell JSON `error`
  // field. Backtick variant catches template literals like
  // `failWith(\`OverflowHiddenAncestor: '${selector}' has overflow:hidden\`)`
  // (smart-scroll.ts:123) and `super(\`Blocked: ... is not allowed because
  // it could open a shell\`)` (key-safety.ts:18).
  const keywordReSets = branch.keywords.map((kw) => {
    const escKw = escapeRegex(kw);
    return [
      new RegExp(`new Error\\(\\s*"[^"]*${escKw}[^"]*"`, "i"),
      new RegExp(`failWith\\(\\s*"[^"]*${escKw}[^"]*"`, "i"),
      new RegExp(`super\\(\\s*"[^"]*${escKw}[^"]*"`, "i"),
      new RegExp(`new Error\\(\\s*\`[^\`]*${escKw}`, "i"),
      new RegExp(`failWith\\(\\s*\`[^\`]*${escKw}`, "i"),
      new RegExp(`super\\(\\s*\`[^\`]*${escKw}`, "i"),
      // PowerShell `Write-Output '{"ok":false,...,"error":"<kw>..."}` — match
      // `"error":"...<kw>..."` inside a single-quoted PS string.
      new RegExp(`"error"\\s*:\\s*"[^"]*${escKw}[^"]*"`, "i"),
    ];
  });

  for (const file of srcFiles) {
    const content = readFileSync(file, "utf8");
    if (codeReDirects.some((re) => re.test(content))) return file;
    if (keywordReSets.some((res) => res.some((re) => re.test(content)))) return file;
  }
  return null;
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("Phase 5 §4.bis (epic #211): classify() branch producer pin", () => {
  it("every classify() branch has a production producer (or is allow-listed)", () => {
    const errorsContent = readFileSync(ERRORS_FILE, "utf8");
    const branches = parseClassifyBranches(errorsContent);

    // Sanity: parser should find ~30 branches today (currently 32 at
    // _errors.ts:316-428 as of Phase 5 closure 2026-05-10). If the count
    // drops drastically the parser is miss-matching the regex (e.g., due
    // to a refactor of the if-chain shape).
    expect(branches.length).toBeGreaterThanOrEqual(20);
    expect(branches.length).toBeLessThan(60);

    const srcFiles = walkSrcTs(SRC_DIR);
    expect(srcFiles.length).toBeGreaterThan(20); // sanity: src walker found .ts files

    const newDeadCodes: Array<{ code: string; keywords: string[] }> = [];

    for (const branch of branches) {
      if (RESERVED_ALLOW_LIST.has(branch.code)) continue;
      if (DEAD_ALLOW_LIST.has(branch.code)) continue;
      const producer = findFirstProducer(branch, srcFiles);
      if (producer === null) {
        newDeadCodes.push({ code: branch.code, keywords: branch.keywords });
      }
    }

    if (newDeadCodes.length > 0) {
      const lines = newDeadCodes.map(
        (d) => `  - ${d.code} (keywords: ${d.keywords.map((k) => `"${k}"`).join(", ")})`,
      );
      throw new Error(
        `Phase 5 §4.bis structural guard: ${newDeadCodes.length} new dead typed code(s) detected — classify() registered, no producer in src/.\n${lines.join("\n")}\n\nFix one of:\n` +
          `  (a) Add a production producer (failWith(new Error("<code>...")) or fail({code:"<code>", ...}))\n` +
          `  (b) Add to RESERVED_ALLOW_LIST if reserved-only per matrix §5.2 (false-positive risk)\n` +
          `  (c) Add to DEAD_ALLOW_LIST with §4.bis-style documentation\n` +
          `  (d) Remove the classify branch (and SUGGESTS entry) entirely`,
      );
    }
  });

  it("allow-listed dead codes are still classify-registered (negative pin)", () => {
    const errorsContent = readFileSync(ERRORS_FILE, "utf8");
    const branches = parseClassifyBranches(errorsContent);
    const knownCodes = new Set(branches.map((b) => b.code));

    for (const code of [...RESERVED_ALLOW_LIST, ...DEAD_ALLOW_LIST]) {
      expect(knownCodes.has(code)).toBe(true);
    }
  });
});
