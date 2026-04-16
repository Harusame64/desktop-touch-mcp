#!/usr/bin/env node
/**
 * tests/fixtures/mock-sidecar.js
 *
 * Mock WinEvent sidecar for unit/integration testing.
 * Reads JSON commands from stdin and emits synthetic WinEvent lines on stdout.
 *
 * Command format (one JSON object per line on stdin):
 *   {"cmd":"emit","event":{"event":3,"hwnd":"100","idObject":0,"idChild":0,
 *     "eventThread":1234,"sourceEventTimeMs":0,"sidecarSeq":1}}
 *   {"cmd":"emit_many","events":[...]}
 *   {"cmd":"exit","code":0}
 *   {"cmd":"crash"}   — exits with non-zero to test restart logic
 *
 * The sidecar emits each event as a JSON line on stdout.
 */

import * as readline from "node:readline";

let seq = 0;

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`[mock-sidecar] malformed command: ${trimmed}\n`);
    return;
  }

  switch (cmd.cmd) {
    case "emit": {
      const ev = { ...cmd.event, sidecarSeq: ++seq };
      process.stdout.write(JSON.stringify(ev) + "\n");
      break;
    }
    case "emit_many": {
      for (const e of cmd.events) {
        const ev = { ...e, sidecarSeq: ++seq };
        process.stdout.write(JSON.stringify(ev) + "\n");
      }
      break;
    }
    case "malformed": {
      // Emit an unparseable line to test malformed-line handling
      process.stdout.write("NOT_JSON_LINE\n");
      break;
    }
    case "exit": {
      process.exit(cmd.code ?? 0);
      break;
    }
    case "crash": {
      process.exit(1);
      break;
    }
    default: {
      process.stderr.write(`[mock-sidecar] unknown command: ${cmd.cmd}\n`);
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Signal readiness
process.stderr.write("[mock-sidecar] ready\n");
