/**
 * winevent-source.ts
 *
 * Lifecycle manager for the native WinEvent sidecar process.
 * Strategy B: native sidecar communicates via stdio newline-delimited JSON.
 *
 * Sidecar contract: one JSON object per line on stdout:
 *   {"event":3,"hwnd":"123456","idObject":0,"idChild":0,"eventThread":9988,
 *    "sourceEventTimeMs":1234567,"sidecarSeq":42}
 *
 * Node side adds receivedAtMonoMs (performance.now()) and receivedAtUnixMs (Date.now())
 * at parse time. sourceEventTimeMs is for diagnostics / ordering hints only — never
 * compare to Node clocks.
 */

import { spawn, ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import * as url from "node:url";
import type { RawWinEvent } from "./perception/raw-event-queue.js";

// ── State machine ─────────────────────────────────────────────────────────────

export type WinEventSourceState =
  | "disabled"
  | "starting"
  | "live"
  | "degraded"
  | "restarting"
  | "stopped";

// ── Backoff configuration ─────────────────────────────────────────────────────

const BACKOFF_INITIAL_MS  = 500;
const BACKOFF_MULTIPLIER  = 2;
const BACKOFF_MAX_MS      = 30_000;
const MAX_RESTART_CYCLES  = 10; // after which we stay degraded

// ── WinEventSource ────────────────────────────────────────────────────────────

export interface WinEventSourceOptions {
  /** Override the sidecar binary path (defaults to DESKTOP_TOUCH_SIDECAR_PATH env or built-in bin/) */
  sidecarPath?: string;
  /** Additional arguments to pass to the sidecar process (useful for testing: node mock-sidecar.js) */
  sidecarArgs?: string[];
  /** Called for each parsed raw event */
  onRawEvent: (event: RawWinEvent) => void;
  /** Called when a line cannot be parsed (malformed JSON) */
  onMalformedLine?: (line: string) => void;
  /** Called when the state changes */
  onStateChange?: (state: WinEventSourceState) => void;
}

export interface WinEventSourceDiagnostics {
  state: WinEventSourceState;
  startCount: number;
  restartCount: number;
  malformedLines: number;
  lastRestartReasonMs: number | undefined;
}

export class WinEventSource {
  private state: WinEventSourceState = "disabled";
  private process: ChildProcess | null = null;
  private lineBuffer = "";
  private globalSeq  = 0;

  private backoffMs    = BACKOFF_INITIAL_MS;
  private restartCount = 0;
  private startCount   = 0;

  private _malformedLines = 0;
  private _lastRestartAtMs: number | undefined;

  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: WinEventSourceOptions) {}

  start(): void {
    if (this.disposed) return;
    if (this.state !== "disabled" && this.state !== "stopped") return;
    this.spawn();
  }

  stop(): void {
    this.disposed = true;
    this.clearRestartTimer();
    this.killProcess();
    this.setState("stopped");
  }

  getState(): WinEventSourceState {
    return this.state;
  }

  diagnostics(): WinEventSourceDiagnostics {
    return {
      state:              this.state,
      startCount:         this.startCount,
      restartCount:       this.restartCount,
      malformedLines:     this._malformedLines,
      lastRestartReasonMs: this._lastRestartAtMs,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private spawn(): void {
    if (this.disposed) return;

    const sidecarPath = this.opts.sidecarPath
      ?? process.env.DESKTOP_TOUCH_SIDECAR_PATH
      ?? this.defaultSidecarPath();

    this.setState("starting");
    this.startCount++;

    let proc: ChildProcess;
    try {
      proc = spawn(sidecarPath, this.opts.sidecarArgs ?? [], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      console.error(`[winevent-source] Failed to spawn sidecar: ${String(err)}`);
      this.scheduleRestart();
      return;
    }

    this.process = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.handleData(chunk);
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) console.error(`[winevent-source:stderr] ${trimmed}`);
    });

    proc.once("spawn", () => {
      if (!this.disposed && this.state === "starting") {
        this.setState("live");
        this.backoffMs    = BACKOFF_INITIAL_MS; // reset on successful start
        this.lineBuffer   = "";
      }
    });

    proc.once("error", (err) => {
      console.error(`[winevent-source] Sidecar process error: ${err.message}`);
      if (!this.disposed) this.scheduleRestart();
    });

    proc.once("exit", (code) => {
      if (!this.disposed) {
        console.error(`[winevent-source] Sidecar exited (code ${code})`);
        this.process = null;
        this.scheduleRestart();
      }
    });
  }

  private handleData(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  private parseLine(line: string): void {
    try {
      const raw = JSON.parse(line) as {
        event: number;
        hwnd: string;
        idObject: number;
        idChild: number;
        eventThread: number;
        sourceEventTimeMs: number;
        sidecarSeq: number;
      };

      const receivedAtMonoMs = performance.now();
      const receivedAtUnixMs = Date.now();

      const ev: RawWinEvent = {
        event:              raw.event,
        hwnd:               String(raw.hwnd),
        idObject:           raw.idObject,
        idChild:            raw.idChild,
        eventThread:        raw.eventThread,
        sourceEventTimeMs:  raw.sourceEventTimeMs,
        sidecarSeq:         raw.sidecarSeq,
        receivedAtMonoMs,
        receivedAtUnixMs,
        globalSeq:          ++this.globalSeq,
      };

      this.opts.onRawEvent(ev);
    } catch {
      this._malformedLines++;
      this.opts.onMalformedLine?.(line);
    }
  }

  private scheduleRestart(): void {
    if (this.disposed) return;
    if (this.restartCount >= MAX_RESTART_CYCLES) {
      console.error("[winevent-source] Max restart cycles reached — staying degraded");
      this.setState("degraded");
      return;
    }

    this.setState("restarting");
    this.restartCount++;
    this._lastRestartAtMs = Date.now();

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);

    console.error(`[winevent-source] Restarting in ${delay}ms (attempt ${this.restartCount})`);
    this.restartTimer = setTimeout(() => {
      if (!this.disposed) this.spawn();
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killProcess(): void {
    if (this.process && !this.process.killed) {
      try { this.process.kill("SIGTERM"); } catch { /* ignore */ }
      this.process = null;
    }
  }

  private setState(next: WinEventSourceState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private defaultSidecarPath(): string {
    // Resolve relative to this file's location
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    return path.join(__dirname, "..", "..", "bin", "dt-winevent-sidecar.exe");
  }

  __resetForTests(): void {
    this.clearRestartTimer();
    this.killProcess();
    this.state         = "disabled";
    this.lineBuffer    = "";
    this.globalSeq     = 0;
    this.backoffMs     = BACKOFF_INITIAL_MS;
    this.restartCount  = 0;
    this.startCount    = 0;
    this._malformedLines      = 0;
    this._lastRestartAtMs     = undefined;
    this.disposed      = false;
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let _source: WinEventSource | null = null;

export function startWinEventSource(
  onRawEvent: (event: RawWinEvent) => void,
  opts?: { sidecarPath?: string; onStateChange?: (s: WinEventSourceState) => void }
): WinEventSource {
  stopWinEventSource();
  _source = new WinEventSource({
    onRawEvent,
    onMalformedLine: (line) => {
      console.error(`[winevent-source] Malformed sidecar line: ${line.slice(0, 200)}`);
    },
    onStateChange: opts?.onStateChange,
    sidecarPath: opts?.sidecarPath,
  });
  _source.start();
  return _source;
}

export function stopWinEventSource(): void {
  if (_source) {
    _source.stop();
    _source = null;
  }
}

export function getWinEventSourceState(): WinEventSourceState {
  return _source?.getState() ?? "disabled";
}
