#!/usr/bin/env node
// ADR-010 P1 / S3 D2-E0 — L4 envelope size bench harness.
//
// Measures the **assembled-envelope serialised payload size** that the
// `makeEnvelopeAware` wrapper produces for representative `desktop_state`
// shapes. Used to baseline the `< 1KB` Phase 1 SLO (ADR-010 §5.6.1) and
// drive the `confidence: degraded` size-trigger threshold (S3-3,
// `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES = 1024`).
//
// 5 scenarios cover the production traffic distribution:
//   1. minimal       — Notepad-shaped focused element only
//   2. typical       — desktop_state default (focusedWindow + element + cursor)
//   3. cursor        — typical + includeCursor=true (monitorId, displayCount)
//   4. screen        — typical + includeScreen=true (displays[], virtualScreen)
//   5. document      — typical + includeDocument=true (CDP url + selection)
//
// Plus an overhead measurement for `viewPoisoned: true` vs healthy state
// (ADR-010 §5.6.1: degraded path must add ≤ 0 bytes overhead — the same
// envelope shape with a different `confidence` enum value).
//
// Usage:
//   node benches/l4_envelope_size.mjs           # 5 scenarios + viewPoisoned diff
//
// Output: text report with each scenario's raw payload size, envelope size,
// envelope - raw delta, confidence value, and the SLO compliance flag.

import {
  buildEnvelope,
  buildFailureEnvelope,
  envelopePayloadSizeBytes,
  ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES,
} from "../dist/tools/_envelope.js";

/** ADR-010 §5.6.1 failure envelope SLO (sub-plan §3.7 G3 #4: ≤ 5KB). */
const ENVELOPE_FAILURE_SIZE_THRESHOLD_BYTES = 5 * 1024;

// ─── Scenario fixtures (representative shapes for desktop_state) ─────────────

const SCENARIO_MINIMAL = {
  focusedWindow: { title: "Notepad", hwnd: 12345, processName: "notepad.exe" },
  focusedElement: { name: "Document", type: "Document", value: "" },
  cursorPos: { x: 0, y: 0 },
  hasModal: false,
  pageState: "ready",
  attention: "ok",
  visibleWindows: 1,
};

const SCENARIO_TYPICAL = {
  ...SCENARIO_MINIMAL,
  focusedWindow: {
    title: "main.ts - desktop-touch-mcp - Visual Studio Code",
    hwnd: 67890,
    processName: "Code.exe",
  },
  focusedElement: {
    name: "Editor",
    type: "Edit",
    value: "",
    automationId: "editor:main",
  },
  cursorPos: { x: 540, y: 320 },
  cursorOverElement: { name: "Tab Bar", type: "Tab" },
  cursorOverWindow: "VSCode",
  visibleWindows: 8,
  hints: { focusedElementSource: "view" },
};

const SCENARIO_CURSOR = {
  ...SCENARIO_TYPICAL,
  cursor: { x: 540, y: 320, monitorId: 0 },
};

const SCENARIO_SCREEN = {
  ...SCENARIO_TYPICAL,
  screen: {
    virtualScreen: { x: 0, y: 0, width: 5120, height: 1440 },
    displays: [
      { id: 0, primary: true, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, dpi: 96 },
      { id: 1, primary: false, bounds: { x: 2560, y: 0, width: 2560, height: 1440 }, dpi: 96 },
    ],
    displayCount: 2,
    primaryIndex: 0,
  },
};

const SCENARIO_DOCUMENT = {
  ...SCENARIO_TYPICAL,
  document: {
    url: "https://github.com/Harusame64/desktop-touch-mcp/pull/111",
    title: "feat(adr-010 P1 S4): commit wrapper + lease validation plan",
    readyState: "complete",
    selection: { text: "", anchorOffset: 0, focusOffset: 0 },
    scroll: { x: 0, y: 1280 },
    viewport: { width: 1280, height: 720 },
  },
};

// PR #112 Round 1 P2 (Codex): non-ASCII Japanese title scenario validates
// the byte-vs-UTF-16-code-units fix in `envelopePayloadSizeBytes`. Japanese
// CJK characters take 1 UTF-16 code unit but 3 UTF-8 bytes — the SLO must
// measure bytes, not `JSON.stringify(...).length`.
const SCENARIO_JAPANESE = {
  ...SCENARIO_TYPICAL,
  focusedWindow: {
    title: "メモ帳 - 無題.txt",
    hwnd: 67890,
    processName: "notepad.exe",
  },
  focusedElement: {
    name: "テキスト エディタ",
    type: "Edit",
    value: "こんにちは、世界",
    automationId: "editor:main",
  },
};

const SCENARIOS = [
  { name: "minimal",  data: SCENARIO_MINIMAL  },
  { name: "typical",  data: SCENARIO_TYPICAL  },
  { name: "cursor",   data: SCENARIO_CURSOR   },
  { name: "screen",   data: SCENARIO_SCREEN   },
  { name: "document", data: SCENARIO_DOCUMENT },
  { name: "japanese", data: SCENARIO_JAPANESE },
];

const FRESH_WALLCLOCK = 1_738_156_823_412;

// ─── Measurement ─────────────────────────────────────────────────────────────

function measure(label, data, opts) {
  const env = buildEnvelope(data, opts);
  const rawSize = envelopePayloadSizeBytes(data);
  const envSize = envelopePayloadSizeBytes(env);
  const delta = envSize - rawSize;
  const sloOk = envSize <= ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES;
  return { label, rawSize, envSize, delta, confidence: env.confidence, sloOk };
}

function pad(s, w) {
  return String(s).padEnd(w);
}

function fmt(n) {
  return String(n).padStart(6);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("ADR-010 P1 — L4 envelope size bench (S3 D2-E0)");
console.log(`SLO threshold: ${ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES} bytes (ADR-010 §5.6.1)`);
console.log("=".repeat(78));
console.log(
  pad("scenario", 10) +
  pad("raw", 8) +
  pad("envelope", 10) +
  pad("delta", 8) +
  pad("conf", 12) +
  pad("SLO", 6)
);
console.log("-".repeat(78));

const results = [];
for (const { name, data } of SCENARIOS) {
  const r = measure(name, data, { viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK });
  results.push(r);
  console.log(
    pad(r.label, 10) +
    pad(fmt(r.rawSize), 8) +
    pad(fmt(r.envSize), 10) +
    pad(fmt(r.delta), 8) +
    pad(r.confidence, 12) +
    pad(r.sloOk ? "ok" : "OVER", 6)
  );
}

// ── viewPoisoned overhead diff ──
console.log();
console.log("viewPoisoned overhead (= same shape, different confidence enum):");
const fresh    = measure("fresh",    SCENARIO_TYPICAL, { viewPoisoned: false, asOfWallclockMs: FRESH_WALLCLOCK });
const poisoned = measure("poisoned", SCENARIO_TYPICAL, { viewPoisoned: true,  asOfWallclockMs: FRESH_WALLCLOCK });
console.log(`  fresh    envelope size = ${fresh.envSize}    confidence=${fresh.confidence}`);
console.log(`  poisoned envelope size = ${poisoned.envSize}    confidence=${poisoned.confidence}`);
console.log(`  delta = ${poisoned.envSize - fresh.envSize} bytes (+${poisoned.envSize - fresh.envSize >= 0 ? "0" : ""}; degraded path adds 'fresh'→'degraded' rename only)`);

// ── S4 failure envelope (sub-plan §2.4 + §3.7 G3 #4) ──
console.log();
console.log(`Failure envelope (S4 commit wrapper, SLO ≤ ${ENVELOPE_FAILURE_SIZE_THRESHOLD_BYTES} bytes — ADR-010 §5.6.1):`);
const FAILURE_SCENARIOS = [
  {
    label: "lease_expired",
    envelope: buildFailureEnvelope(
      "LeaseExpired",
      [{ action: "desktop_discover", args: {}, confidence: "high" }],
      { asOfWallclockMs: FRESH_WALLCLOCK },
    ),
  },
  {
    label: "lease_residual",
    envelope: buildFailureEnvelope("Unknown", [], { asOfWallclockMs: FRESH_WALLCLOCK }),
  },
  {
    label: "handler_threw",
    envelope: buildFailureEnvelope(
      "Unknown",
      [],
      { asOfWallclockMs: FRESH_WALLCLOCK },
    ),
  },
];
let failureSloOk = true;
for (const { label, envelope } of FAILURE_SCENARIOS) {
  const size = envelopePayloadSizeBytes(envelope);
  const ok = size <= ENVELOPE_FAILURE_SIZE_THRESHOLD_BYTES;
  if (!ok) failureSloOk = false;
  console.log(`  ${pad(label, 16)} ${fmt(size)} bytes   ${ok ? "ok" : "OVER"}`);
}

// ── S5 causal include envelope (sub-plan §3.7 G5 #3 + ADR-010 §5.6.1 +1KB) ──
const ENVELOPE_CAUSAL_SIZE_THRESHOLD_BYTES = 2 * 1024;
console.log();
console.log(`Causal envelope (S5 caused_by + based_on, SLO ≤ ${ENVELOPE_CAUSAL_SIZE_THRESHOLD_BYTES} bytes — ADR-010 §5.6.1 causal include +1KB):`);

// 3 causal scenarios per sub-plan §3.7 S5-7
const CAUSAL_MINIMAL_CAUSED_BY = {
  your_last_action: "desktop_act({})",
  tool_call_id: "default:1",
  elapsed_ms: 50,
  produced_changes: [],
};
const CAUSAL_MINIMAL_BASED_ON = {
  events: [],
  sources: [],
};

const CAUSAL_TYPICAL_CAUSED_BY = {
  your_last_action: "desktop_act({\"action\":\"click\",\"x\":540,\"y\":320})",
  tool_call_id: "session-abc-123:7",
  elapsed_ms: 87,
  produced_changes: [
    "focus: → input-name",
    "dirty_rects[monitor=0]: 3",
    "dirty_rects[monitor=1]: 1",
  ],
};
const CAUSAL_TYPICAL_BASED_ON = {
  events: ["100", "101"],
  sources: ["UIA", "DXGI"],
};

// Max scenario: args_summary at the 512-byte truncation cap
const CAUSAL_MAX_ARGS = "x".repeat(509) + "…";
const CAUSAL_MAX_CAUSED_BY = {
  your_last_action: `desktop_act(${CAUSAL_MAX_ARGS})`,
  tool_call_id: "long-session-id-with-uuid-prefix:99999",
  elapsed_ms: 1234,
  produced_changes: [
    "focus: → very-long-element-name-that-exceeds-typical-bounds",
    "dirty_rects[monitor=0]: 47",
    "dirty_rects[monitor=1]: 12",
  ],
};
const CAUSAL_MAX_BASED_ON = {
  events: ["18446744073709551610", "18446744073709551611"], // u64 max-ish decimal strings
  sources: ["UIA", "DXGI"],
};

const CAUSAL_SCENARIOS = [
  {
    label: "causal_minimal",
    envelope: buildEnvelope(SCENARIO_TYPICAL, {
      asOfWallclockMs: FRESH_WALLCLOCK,
      causedBy: CAUSAL_MINIMAL_CAUSED_BY,
      basedOn: CAUSAL_MINIMAL_BASED_ON,
    }),
  },
  {
    label: "causal_typical",
    envelope: buildEnvelope(SCENARIO_TYPICAL, {
      asOfWallclockMs: FRESH_WALLCLOCK,
      causedBy: CAUSAL_TYPICAL_CAUSED_BY,
      basedOn: CAUSAL_TYPICAL_BASED_ON,
    }),
  },
  {
    label: "causal_max",
    envelope: buildEnvelope(SCENARIO_TYPICAL, {
      asOfWallclockMs: FRESH_WALLCLOCK,
      causedBy: CAUSAL_MAX_CAUSED_BY,
      basedOn: CAUSAL_MAX_BASED_ON,
    }),
  },
];
let causalSloOk = true;
for (const { label, envelope } of CAUSAL_SCENARIOS) {
  const size = envelopePayloadSizeBytes(envelope);
  const ok = size <= ENVELOPE_CAUSAL_SIZE_THRESHOLD_BYTES;
  if (!ok) causalSloOk = false;
  console.log(`  ${pad(label, 16)} ${fmt(size)} bytes   ${ok ? "ok" : "OVER"}   confidence=${envelope.confidence}`);
}

console.log();
const overSlo = results.filter((r) => !r.sloOk);
if (overSlo.length === 0 && failureSloOk && causalSloOk) {
  console.log(`✓ All ${SCENARIOS.length} scenarios within ${ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES}-byte SLO + failure envelope ≤ ${ENVELOPE_FAILURE_SIZE_THRESHOLD_BYTES} bytes (S4 G3 #4) + causal envelope ≤ ${ENVELOPE_CAUSAL_SIZE_THRESHOLD_BYTES} bytes (S5 G5 #3).`);
  process.exit(0);
}
if (overSlo.length > 0) {
  console.log(`✗ ${overSlo.length} / ${SCENARIOS.length} scenarios exceeded the ${ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES}-byte SLO:`);
  for (const r of overSlo) {
    console.log(`    ${r.label}: ${r.envSize} bytes`);
  }
}
if (!failureSloOk) {
  console.log(`✗ Failure envelope exceeded the ${ENVELOPE_FAILURE_SIZE_THRESHOLD_BYTES}-byte SLO (ADR-010 §5.6.1, sub-plan §3.7 G3 #4).`);
}
if (!causalSloOk) {
  console.log(`✗ Causal envelope exceeded the ${ENVELOPE_CAUSAL_SIZE_THRESHOLD_BYTES}-byte SLO (ADR-010 §5.6.1 causal include +1KB, sub-plan §3.7 S5-7 G5 #3).`);
}
console.log();
console.log("These shapes will trigger `confidence: degraded` at runtime.");
console.log("If routinely over: bump ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES + ADR-010 §5.6.1 in sync.");
process.exit(1);
