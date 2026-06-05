#!/usr/bin/env node
// ADR-024 Seed-2 S6 — round-trip reduction bench for the visual-only roiCapture.
//
// North Star (`adr-024-seed2-plan.md` §0): on a visual-only (UIA-blind) target,
// fold the post-action "confirm the result + find the next target" round-trips
// into the act itself. The agent's current flow is
//   desktop_act -> desktop_state -> screenshot   (3 calls; 2 post-act confirms)
// and S5c makes it
//   desktop_act(returnCapture:"on-change")        (1 call; 0 post-act confirms)
// because the act response carries roiCapture { somImage (≈ the screenshot crop),
// entities (≈ the discover/state preview) }.
//
// This bench QUANTIFIES that reduction live. It is **headed-gated** (needs a real
// GUI + the full native engine: DXGI / PrintWindow / OCR) and therefore is NOT a
// CI test — it spawns its own server over stdio MCP, spawns a visual-only canvas
// fixture, and reports numbers. With no GUI / no canvas it degrades to exit 0.
//
// ## What it measures (recorded in adr-024-seed2-dogfood-findings.md §S6)
//   - post-act round-trips      : baseline 3 (act+state+screenshot) vs folded 1 (act)
//   - total latency per flow     : wall-clock of [act (+state+screenshot)] (mean/p50/p95)
//   - per-call act latency       : baseline act-only vs folded act-only (the folded
//                                  act is heavier — it runs the frame-diff capture +
//                                  settle + ROI-OCR + SoM render inline — so the win
//                                  is the *eliminated round-trips*, not a cheaper act;
//                                  we report both so the trade-off is not hidden)
//   - payload bytes per flow     : baseline = act+state+screenshot(full-window SoM) JSON;
//                                  folded = act JSON (bundles a LOCALIZED SoM crop). Both
//                                  carry a SoM PNG, so the folded crop is typically the
//                                  SMALLER of the two (it is the changed region, not the
//                                  whole window). Payload scales with the ROI size; a
//                                  full-window roiCapture fallback would approach the
//                                  baseline screenshot's bytes.
//   - roiCapture content         : somImage bytes, entities count, roi localized
//                                  (not full-window)
//
// ## Usage
//   npm run build && npm run build:rs   # dist/index.js + native addon present
//   node benches/adr-024-seed2-roundtrip.mjs               # 10 iters, auto-spawn fixture
//   node benches/adr-024-seed2-roundtrip.mjs 20            # custom iter count
//   node benches/adr-024-seed2-roundtrip.mjs --title Foo   # attach to an already-open canvas
//
// ## Requirements
//   - Windows session with a real GUI (no RDP-headless / service session)
//   - `npm run build` (dist/index.js) + `npm run build:rs` (native addon)

import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Arg parsing ─────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
let iterations = 10;
let externalTitle = null; // when set, attach to an already-open canvas (no spawn)
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--title") {
    externalTitle = rawArgs[++i];
  } else if (Number.isFinite(Number(a))) {
    iterations = Number(a);
  } else {
    console.error(`error: unrecognised argument: ${a}`);
    console.error("usage: node adr-024-seed2-roundtrip.mjs [iterations] [--title <existing-canvas-title>]");
    process.exit(2);
  }
}
if (!Number.isFinite(iterations) || iterations < 1) {
  console.error("error: iterations must be >= 1");
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverPath = resolve(repoRoot, "dist", "index.js");
const fixturePath = resolve(__dirname, "fixtures", "visual-only-canvas.ps1");
if (!existsSync(serverPath)) {
  console.error(`server entry not found: ${serverPath} — run \`npm run build\``);
  process.exit(2);
}

// ─── Fixture spawn (skip when --title attaches to an existing canvas) ─────────
// Same spawn discipline as tests/e2e/helpers/blank-window.ts: NOT detached (a
// detached GUI exits immediately), console hidden inside the script, killed on exit.
const title = externalTitle ?? `dt-s6-roundtrip-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let fixtureChild = null;
if (!externalTitle) {
  if (!existsSync(fixturePath)) {
    console.error(`fixture not found: ${fixturePath}`);
    process.exit(2);
  }
  fixtureChild = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixturePath, "-Title", title],
    { stdio: "ignore" },
  );
}
const closeFixture = () => {
  if (fixtureChild) {
    try { fixtureChild.kill(); } catch { /* already gone */ }
    fixtureChild = null;
  }
};

// ─── MCP stdio client ────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_TOUCH_AUTO_GUARD: "0" },
  stderr: "pipe",
});
const client = new Client({ name: "s6-roundtrip-bench", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const callTool = async (name, args) => {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - t0;
  const text = Array.isArray(result?.content)
    ? (result.content.find((c) => c?.type === "text")?.text ?? "")
    : "";
  const bytes = Buffer.byteLength(text, "utf8");
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { ms, bytes, parsed };
};

// ─── Discover the visual-only canvas (poll until present) ─────────────────────
async function discoverCanvas() {
  const { parsed } = await callTool("desktop_discover", {
    target: { windowTitle: title },
    view: "action",
  });
  if (!parsed || !Array.isArray(parsed.entities)) return null;
  const warnings = parsed.warnings ?? [];
  const visualOnly = warnings.some((w) => String(w).startsWith("uia_blind"));
  return { ...parsed, visualOnly };
}

const cleanupAndExit = async (code) => {
  try { await client.close(); } catch { /* ignore */ }
  closeFixture();
  process.exit(code);
};

let disc = null;
{
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const d = await discoverCanvas();
    if (d && d.visualOnly && d.entities.some((e) => e.sources?.includes("ocr") && e.primaryAction === "click")) {
      disc = d;
      break;
    }
    await sleep(500);
  }
}
if (!disc) {
  // Graceful degrade — headed-gated bench, no hard fail on a headless / no-GUI host.
  console.log("# OPERATOR NOTE: visual-only canvas did not appear within 20s.");
  console.log("#   This bench needs a real GUI session + the native addon (npm run build:rs).");
  console.log("#   On a headless / RDP-service / locked session it cannot run — degrading to exit 0.");
  await cleanupAndExit(0);
}

// ─── Pick the two OCR anchors to alternate clicks across ──────────────────────
const ocrEntities = disc.entities.filter((e) => e.sources?.includes("ocr") && e.primaryAction === "click");
const anchorLabels = ["TARGET ALPHA", "ZONE BETA"].filter((l) => ocrEntities.some((e) => e.label === l));
const labelsToUse = anchorLabels.length > 0 ? anchorLabels : [ocrEntities[0].label];

// ─── Measurement loop ────────────────────────────────────────────────────────
// Each iteration re-discovers (a fresh lease per act), then runs ONE flow. We
// alternate baseline / folded across iters so both see the same fixture wear.
const baseline = { total: [], act: [], bytes: [] };
const folded = { total: [], act: [], bytes: [], somBytes: [], entityCounts: [], localized: 0, present: 0 };

async function leaseFor(label) {
  const d = await discoverCanvas();
  if (!d) return null;
  // Match the requested anchor by label ONLY. Do NOT fall back to "the first OCR
  // entity" — the window title bar is also OCR'd, and clicking it produces no
  // content change (no_change → no roiCapture), which would spuriously fail the
  // acceptance gate. A transient discover miss → skip the iter instead.
  return (
    d.entities.find(
      (e) => e.label === label && e.sources?.includes("ocr") && e.primaryAction === "click",
    ) ?? null
  );
}

for (let i = 0; i < iterations; i++) {
  const label = labelsToUse[i % labelsToUse.length];
  const ent = await leaseFor(label);
  if (!ent) continue;

  if (i % 2 === 0) {
    // ── Baseline: act(never) + desktop_state + screenshot (3 round-trips) ──
    // The screenshot uses detail:"som" (Set-of-Marks + OCR elements) — the SAME
    // information roiCapture bundles, but full-window. This is the fair baseline:
    // folded = localized SoM crop folded into the act; baseline = full-window SoM
    // fetched as a separate round-trip. (detail:"image" is blocked without
    // confirmImage and would only return a guidance stub, not real pixels.)
    const t0 = performance.now();
    const act = await callTool("desktop_act", { lease: ent.lease, action: "click", returnCapture: "never" });
    const state = await callTool("desktop_state", {});
    const shot = await callTool("screenshot", { windowTitle: title, detail: "som", confirmImage: true });
    const total = performance.now() - t0;
    baseline.total.push(total);
    baseline.act.push(act.ms);
    baseline.bytes.push(act.bytes + state.bytes + shot.bytes);
  } else {
    // ── Folded: act(on-change) only (1 round-trip) ──
    const act = await callTool("desktop_act", { lease: ent.lease, action: "click", returnCapture: "on-change" });
    folded.total.push(act.ms);
    folded.act.push(act.ms);
    folded.bytes.push(act.bytes);
    const cap = act.parsed?.roiCapture;
    if (cap) {
      folded.present++;
      const somB = cap.somImage ? Buffer.byteLength(String(cap.somImage), "utf8") : 0;
      folded.somBytes.push(somB);
      folded.entityCounts.push(Array.isArray(cap.entities) ? cap.entities.length : 0);
      const roi = cap.roi;
      // Localized = the ROI covers well under the 800×600 client area (the toggle
      // bar within the SSIM crop is ≤ ~192², far below a full-window grab).
      if (roi && roi.width * roi.height < 800 * 600 * 0.6) folded.localized++;
    }
  }
  await sleep(150); // let the form settle between clicks
}

// ─── Stats ───────────────────────────────────────────────────────────────────
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: pct(0.5), p95: pct(0.95) };
};
const ms = (v) => (v == null ? "—" : `${v.toFixed(1)} ms`);
const bytes = (v) => (v == null ? "—" : `${Math.round(v)} B`);
const line = (s) => (s ? `mean ${ms(s.mean)} | p50 ${ms(s.p50)} | p95 ${ms(s.p95)} (n=${s.n})` : "no samples");

const bTotal = stats(baseline.total), bAct = stats(baseline.act), bBytes = stats(baseline.bytes);
const fTotal = stats(folded.total), fAct = stats(folded.act), fBytes = stats(folded.bytes);
const somB = stats(folded.somBytes), entC = stats(folded.entityCounts);

console.log(`# adr-024-seed2-roundtrip — visual-only roiCapture round-trip reduction (${iterations} iters)`);
console.log(`# canvas="${title}" anchors=[${labelsToUse.join(", ")}]`);
console.log("");
console.log("## post-act round-trips (the North Star)");
console.log(`baseline : 3  (desktop_act + desktop_state + screenshot)`);
console.log(`folded   : 1  (desktop_act, roiCapture bundled)   →  N→1 = 3→1`);
console.log("");
console.log("## total latency (act + post-act confirmation, wall-clock)");
console.log(`baseline : ${line(bTotal)}`);
console.log(`folded   : ${line(fTotal)}`);
console.log("");
console.log("## per-call act latency (decomposition — the folded act is heavier)");
console.log(`baseline act(never)     : ${line(bAct)}`);
console.log(`folded   act(on-change) : ${line(fAct)}`);
console.log("");
console.log("## payload bytes per flow (folded bundles a LOCALIZED SoM crop)");
console.log(`baseline (act+state+screenshot[full-window som]) : ${bBytes ? bytes(bBytes.mean) : "—"}`);
console.log(`folded   (act only, localized som crop)          : ${fBytes ? bytes(fBytes.mean) : "—"}`);
console.log("");
console.log("## folded roiCapture content");
console.log(`present       : ${folded.present}/${folded.total.length}`);
console.log(`localized roi : ${folded.localized}/${folded.present} (roi < full window)`);
console.log(`somImage      : ${somB ? bytes(somB.mean) : "—"} (base64)`);
console.log(`entities      : ${entC ? entC.mean.toFixed(1) : "—"} preview avg`);
console.log("");

// ─── Acceptance gate ─────────────────────────────────────────────────────────
// Headed (canvas found): the folded act MUST attach roiCapture, else exit 1.
let exitCode = 0;
if (folded.total.length > 0 && folded.present === 0) {
  console.log("# ACCEPTANCE FAIL: folded act produced NO roiCapture on any iteration.");
  console.log("#   Expected the visual-only frame-diff to fire and bundle the SoM crop.");
  exitCode = 1;
} else {
  console.log("# ACCEPTANCE: folded act bundles roiCapture (state+screenshot round-trips eliminated).");
}

await cleanupAndExit(exitCode);
