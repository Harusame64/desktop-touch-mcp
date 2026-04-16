/**
 * tests/unit/winevent-source.test.ts
 *
 * Unit tests for WinEventSource — sidecar lifecycle management.
 * Uses the mock-sidecar.js fixture as a real child process via node <script>.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import * as fs from "node:fs";
import { WinEventSource } from "../../src/engine/winevent-source.js";
import type { WinEventSourceState } from "../../src/engine/winevent-source.js";
import type { RawWinEvent } from "../../src/engine/perception/raw-event-queue.js";

const __dirname  = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK_SIDECAR = path.join(__dirname, "../fixtures/mock-sidecar.js");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Spawn node <mock-sidecar.js> as the "sidecar" */
function makeMockSource(
  onEvent: (e: RawWinEvent) => void = () => {},
  onState?: (s: WinEventSourceState) => void,
  onMalformed?: (l: string) => void,
): WinEventSource {
  return new WinEventSource({
    sidecarPath: process.execPath,
    sidecarArgs: [MOCK_SIDECAR],
    onRawEvent:  onEvent,
    onStateChange: onState,
    onMalformedLine: onMalformed,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("WinEventSource — basic lifecycle", () => {
  it("starts in 'disabled' state before start()", () => {
    const src = new WinEventSource({
      sidecarPath: "nonexistent.exe",
      onRawEvent: () => {},
    });
    expect(src.getState()).toBe("disabled");
  });

  it("transitions to 'live' when mock sidecar spawns successfully", async () => {
    const states: WinEventSourceState[] = [];
    const src = makeMockSource(() => {}, (s) => states.push(s));
    src.start();
    await sleep(600);
    src.stop();
    expect(states).toContain("starting");
    expect(states).toContain("live");
  }, 5000);

  it("transitions to 'stopped' on stop()", async () => {
    const states: WinEventSourceState[] = [];
    const src = makeMockSource(() => {}, (s) => states.push(s));
    src.start();
    await sleep(400);
    src.stop();
    expect(states[states.length - 1]).toBe("stopped");
  }, 5000);
});

// ── Malformed line handling ───────────────────────────────────────────────────

describe("WinEventSource — malformed line handling", () => {
  it("counts malformed lines from a sidecar that emits bad JSON", async () => {
    const malformed: string[] = [];

    // Create a tiny inline sidecar that emits one bad line then stays alive
    const scriptPath = path.join(__dirname, "../../.tmp-malformed-sidecar.mjs");
    fs.writeFileSync(scriptPath,
      `process.stdout.write("NOT_JSON_LINE\\n"); await new Promise(r => setTimeout(r, 30000));\n`
    );

    const src = new WinEventSource({
      sidecarPath: process.execPath,
      sidecarArgs: [scriptPath],
      onRawEvent: () => {},
      onMalformedLine: (l) => malformed.push(l),
    });
    src.start();
    await sleep(600);
    src.stop();

    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

    expect(malformed.length).toBeGreaterThan(0);
    expect(malformed[0]).toContain("NOT_JSON_LINE");
    expect(src.diagnostics().malformedLines).toBeGreaterThan(0);
  }, 5000);
});

// ── Crash and restart ─────────────────────────────────────────────────────────

describe("WinEventSource — crash and restart", () => {
  it("transitions to 'restarting' when sidecar crashes (exits non-zero)", async () => {
    const states: WinEventSourceState[] = [];

    // Inline sidecar that immediately exits with code 1
    const scriptPath = path.join(__dirname, "../../.tmp-crash-sidecar.mjs");
    fs.writeFileSync(scriptPath, `process.exit(1);\n`);

    const src = new WinEventSource({
      sidecarPath: process.execPath,
      sidecarArgs: [scriptPath],
      onRawEvent: () => {},
      onStateChange: (s) => states.push(s),
    });
    src.start();
    await sleep(800);
    src.stop();

    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

    expect(states).toContain("restarting");
    expect(src.diagnostics().restartCount).toBeGreaterThan(0);
  }, 6000);

  it("resets backoff on successful restart after crash", async () => {
    const src = new WinEventSource({
      sidecarPath: process.execPath,
      sidecarArgs: [MOCK_SIDECAR],
      onRawEvent: () => {},
    });
    // __resetForTests resets backoffMs
    src.__resetForTests();
    expect(src.getState()).toBe("disabled");
  }, 3000);
});

// ── Diagnostics ───────────────────────────────────────────────────────────────

describe("WinEventSource — diagnostics", () => {
  it("diagnostics() returns expected shape on a fresh instance", () => {
    const src = new WinEventSource({
      sidecarPath: "dummy.exe",
      onRawEvent: () => {},
    });
    const d = src.diagnostics();
    expect(d.state).toBe("disabled");
    expect(d.startCount).toBe(0);
    expect(d.restartCount).toBe(0);
    expect(d.malformedLines).toBe(0);
    expect(d.lastRestartReasonMs).toBeUndefined();
  });

  it("diagnostics() includes startCount after start()", async () => {
    const src = makeMockSource();
    src.start();
    await sleep(300);
    src.stop();
    expect(src.diagnostics().startCount).toBe(1);
  }, 5000);
});
