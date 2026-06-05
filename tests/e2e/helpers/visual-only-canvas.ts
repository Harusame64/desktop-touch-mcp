/**
 * tests/e2e/helpers/visual-only-canvas.ts
 *
 * Spawn the ADR-024 Seed-2 visual-only (UIA-blind) canvas fixture
 * (`benches/fixtures/visual-only-canvas.ps1`) for the roiCapture e2e. Shares the
 * SAME fixture script as the round-trip bench so the bench numbers and the e2e
 * assertions exercise one canvas definition.
 *
 * Spawn discipline matches `blank-window.ts`: NOT detached (a detached GUI exits
 * immediately), the PowerShell host console is hidden inside the script (not via
 * -WindowStyle Hidden, which would hide the form too), and the process is killed
 * on close().
 */
import { spawn } from "child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enumWindowsInZOrder } from "../../../src/engine/win32.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/e2e/helpers → repo root → benches/fixtures/visual-only-canvas.ps1
const FIXTURE = resolve(__dirname, "..", "..", "..", "benches", "fixtures", "visual-only-canvas.ps1");

export interface VisualOnlyCanvas {
  /** Unique window title — pass as `target.windowTitle` to desktop_discover. */
  title: string;
  /** Close the window (kills the backing PowerShell process). Idempotent. */
  close: () => void;
}

/**
 * Spawn the visual-only canvas and resolve once it is on screen. Returns null if
 * the window does not appear within 12s (callers should skip rather than fall
 * back). Always pair with `close()` in afterAll.
 */
export async function spawnVisualOnlyCanvas(): Promise<VisualOnlyCanvas | null> {
  const title = `dt-visualonly-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Title", title],
    { stdio: "ignore" },
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { child.kill(); } catch { /* already gone */ }
  };

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const w = enumWindowsInZOrder().find((x) => x.title === title && !x.isMinimized);
    if (w && w.region.width > 0 && w.region.height > 0) {
      return { title, close };
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  close();
  return null;
}
