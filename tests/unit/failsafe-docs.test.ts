/**
 * tests/unit/failsafe-docs.test.ts
 *
 * ADR-030 Phase 1 (AC4a / plan §4.7) — permanent guard against stale failsafe
 * wording. The "move the mouse to the corner to IMMEDIATELY TERMINATE the
 * server" description survived the v1.7.2 dwell redesign in six places
 * because nothing checked the living documentation surfaces; a LITERAL string
 * grep then missed SECURITY.md's different phrasing ("immediately terminates
 * the server"), so the forbidden patterns here are REGEXES tolerant of
 * wording drift (強制命令 7 — enforce by mechanism, not memory).
 *
 * Scope: the four LIVING surfaces only (README en/ja, SECURITY.md, and the
 * model-facing MCP server instructions in server-windows.ts). Dated history
 * (CHANGELOG, site/ articles, past plan docs) is deliberately out of scope —
 * plan §3.5.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const SURFACES = ["README.md", "README.ja.md", "SECURITY.md", "src/server-windows.ts"] as const;

// Wording-drift-tolerant forbidden patterns (plan §4.7): "immediately
// terminate/terminates/terminating", the Japanese equivalents, and the
// "instantly stops/terminates" variant that appeared in a v1.8 article.
const FORBIDDEN: readonly RegExp[] = [
  /immediately\s+terminat/i,
  /即座に(終了|停止)/,
  /instantly\s+(stop|terminat)/i,
];

describe("failsafe documentation — stale 'immediate termination' wording is banned", () => {
  for (const file of SURFACES) {
    for (const pattern of FORBIDDEN) {
      it(`${file} does not match ${pattern}`, () => {
        const text = repoFile(file);
        const m = text.match(pattern);
        expect(m, m ? `stale wording "${m[0]}" found in ${file}` : undefined).toBeNull();
      });
    }
  }
});

describe("failsafe documentation — the primary-monitor corner is stated on every living surface", () => {
  it("README.md names the primary-monitor corner at least twice (feature list + Security section)", () => {
    const text = repoFile("README.md");
    const hits = text.match(/top-left corner of the primary monitor/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("README.ja.md names プライマリモニタ at least twice (機能一覧 + セキュリティ節)", () => {
    const text = repoFile("README.ja.md");
    const hits = text.match(/プライマリモニタ/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("SECURITY.md names the primary monitor", () => {
    expect(repoFile("SECURITY.md")).toMatch(/primary monitor/);
  });

  it("server-windows.ts MCP instructions name the PRIMARY monitor and the 500ms dwell", () => {
    const text = repoFile("src/server-windows.ts");
    expect(text).toMatch(/PRIMARY monitor/);
    expect(text).toMatch(/500ms/);
  });
});
