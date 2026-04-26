/**
 * desktop-reliability-matrix.test.ts
 *
 * Pre-v1.0.0 reliability + latency sweep for the v2 World-Graph public
 * surface (desktop_discover / desktop_act). Iterates every (source lane ×
 * action) pair the schema accepts, runs see() → touch() with mocked deps,
 * and records:
 *   - whether the round-trip succeeded
 *   - the median latency over 5 attempts (mocked deps, so we're measuring
 *     the TS overhead — Win32 / CDP cost is excluded by design)
 *   - which executor route the touch took
 *
 * The output is a markdown table printed once per run. Treat it as
 * documentation of "what desktop_discover / desktop_act actually covers"
 * rather than a performance regression gate. The hard assertions only
 * fail if a combination that should have succeeded didn't, or a measured
 * latency exceeds 50ms (a generous ceiling — typical mocked-dep latency
 * is sub-millisecond).
 */

import { describe, it, expect } from "vitest";
import {
  DesktopFacade,
  type CandidateProvider,
} from "../../src/tools/desktop.js";
import type { UiEntityCandidate } from "../../src/engine/vision-gpu/types.js";
import type { TouchAction } from "../../src/engine/world-graph/guarded-touch.js";
import type { ExecutorKind } from "../../src/engine/world-graph/types.js";

type Source = "uia" | "cdp" | "terminal" | "visual_gpu";

const SOURCES: Source[] = ["uia", "cdp", "terminal", "visual_gpu"];
const ACTIONS: TouchAction[] = ["auto", "click", "invoke", "type", "setValue", "select"];

const RECT = { x: 100, y: 200, width: 80, height: 30 };

function buildCandidate(source: Source): UiEntityCandidate {
  // Each lane gets a minimally complete candidate. Affordances are widened so
  // the resolver doesn't reject "type" on a button. Tests are documenting
  // dispatch routing, not affordance validation (covered separately).
  const base: UiEntityCandidate = {
    source,
    target: { kind: "window", id: "win-1" },
    label: `Target-${source}`,
    role: source === "terminal" ? "label" : "button",
    actionability: ["invoke", "click", "type", "select"],
    confidence: 0.9,
    observedAtMs: 1000,
    provisional: false,
    digest: `digest-${source}`,
    rect: RECT,
  };
  if (source === "uia") {
    return {
      ...base,
      locator: { uia: { name: base.label, automationId: "auto-1" } },
    };
  }
  if (source === "cdp") {
    return {
      ...base,
      locator: { cdp: { selector: "#target", tabId: "tab-1" } },
    };
  }
  if (source === "terminal") {
    return {
      ...base,
      locator: { terminal: { windowTitle: "PowerShell" } },
    };
  }
  return base;
}

interface MatrixRow {
  source: Source;
  action: TouchAction;
  ok: boolean;
  reason?: string;
  route?: ExecutorKind;
  medianMs: number;
}

const TIMING_RUNS = 5;
const TIMING_CEILING_MS = 50;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measure(source: Source, action: TouchAction): Promise<MatrixRow> {
  const provider: CandidateProvider = () => [buildCandidate(source)];
  const calls: Array<{ route: ExecutorKind }> = [];
  const facade = new DesktopFacade(provider, {
    executorFn: async (_entity, _action) => {
      // Mocked executor: route purely based on the entity's primary source.
      const k: ExecutorKind = source === "visual_gpu" ? "mouse" : (source as ExecutorKind);
      calls.push({ route: k });
      return k;
    },
  });

  const samples: number[] = [];
  let lastResult: Awaited<ReturnType<typeof facade.touch>> | undefined;

  for (let i = 0; i < TIMING_RUNS; i++) {
    const t0 = performance.now();
    const view = await facade.see({});
    const lease = view.entities[0]!.lease!;
    lastResult = await facade.touch({
      lease,
      action,
      // Always provide text — the executor decides whether to use it based
      // on action; passing it for click/invoke/select is harmless.
      text: action === "type" || action === "setValue" || action === "auto" ? "sample-text" : undefined,
    });
    samples.push(performance.now() - t0);
  }

  const ok = lastResult?.ok === true;
  return {
    source,
    action,
    ok,
    reason: ok ? undefined : (lastResult as { ok: false; reason?: string }).reason,
    route: calls[calls.length - 1]?.route,
    medianMs: median(samples),
  };
}

function formatTable(rows: MatrixRow[]): string {
  const header = "| source | action | ok | route | median ms | reason |";
  const sep    = "|---|---|---|---|---|---|";
  const body = rows.map((r) =>
    `| ${r.source} | ${r.action} | ${r.ok ? "✅" : "❌"} | ${r.route ?? "-"} | ${r.medianMs.toFixed(2)} | ${r.reason ?? ""} |`
  );
  return [header, sep, ...body].join("\n");
}

// ── Failure-reason reachability ─────────────────────────────────────────────
//
// TouchFailReason enumerates every error path desktop_act can surface. A
// release-readiness check is "every reason has at least one test that
// produces it, so callers (LLM + recovery code) never see one that the
// suite hasn't exercised". We grep the test directory rather than try to
// re-stage every scenario here — the existing desktop-facade tests already
// cover the hard cases (lease_expired, modal_blocking, etc.).

const FAIL_REASONS = [
  "lease_expired",
  "lease_generation_mismatch",
  "entity_not_found",
  "lease_digest_mismatch",
  "modal_blocking",
  "entity_outside_viewport",
  "executor_failed",
] as const;

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function searchTestSources(needle: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(here).filter((f) => f.endsWith(".test.ts") && f !== "desktop-reliability-matrix.test.ts");
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(here, f), "utf-8");
    if (text.includes(needle)) hits.push(f);
  }
  return hits;
}

describe("desktop_discover / desktop_act — reliability + latency matrix (v1.0.0 sanity)", () => {
  it("every TouchFailReason is reachable from at least one other unit test", () => {
    const rows = FAIL_REASONS.map((reason) => ({ reason, files: searchTestSources(`"${reason}"`) }));

    // eslint-disable-next-line no-console
    console.log("\n=== TouchFailReason reachability ===\n" +
      "| reason | covered in |\n" +
      "|---|---|\n" +
      rows.map((r) => `| ${r.reason} | ${r.files.length === 0 ? "❌ MISSING" : r.files.join(", ")} |`).join("\n") +
      "\n");

    for (const row of rows) {
      expect(row.files.length, `TouchFailReason "${row.reason}" not exercised in any test file`).toBeGreaterThan(0);
    }
  });

  it("every (source × action) combination round-trips at unit level under 50ms median", async () => {
    const rows: MatrixRow[] = [];
    for (const source of SOURCES) {
      for (const action of ACTIONS) {
        rows.push(await measure(source, action));
      }
    }

    // Print the matrix once so the developer running this test can eyeball
    // coverage without scrolling through individual it() output.
    // eslint-disable-next-line no-console
    console.log("\n=== desktop_discover / desktop_act capability matrix ===\n" + formatTable(rows) + "\n");

    // Hard assertions: every combination must complete with ok:true at unit
    // level, and every median latency must stay under the ceiling.
    for (const row of rows) {
      expect(row.ok, `(${row.source}, ${row.action}) failed: ${row.reason ?? "unknown"}`).toBe(true);
      expect(row.medianMs, `(${row.source}, ${row.action}) median ${row.medianMs}ms exceeds ${TIMING_CEILING_MS}ms`).toBeLessThan(TIMING_CEILING_MS);
    }
  });
});
