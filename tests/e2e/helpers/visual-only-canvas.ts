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
import { moveWindowToE2eScreen } from "./e2e-screen.js";

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
 *
 * @param opts.fontSize anchor text point size (default = the fixture's 34pt). A
 *   small size (e.g. 11) is the ADR-024 S5b-3 R1 carry-forward regression canvas
 *   (small text = the regime where ROI-crop OCR is least reliable).
 */
export async function spawnVisualOnlyCanvas(opts: { fontSize?: number } = {}): Promise<VisualOnlyCanvas | null> {
  const title = `dt-visualonly-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Title", title];
  if (opts.fontSize !== undefined) args.push("-FontSize", String(opts.fontSize));
  const child = spawn("powershell", args, { stdio: "ignore" });
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
      // Multi-monitor placement: keep the suite off the user's working screen.
      // The move happens HERE rather than in the .ps1 because that fixture is
      // shared byte-for-byte with the ADR-024 round-trip bench — the e2e
      // placement policy must not leak into the bench's canvas definition.
      // The window stays CENTRED in its monitor's WORK AREA — the same rect
      // WinForms' `StartPosition='CenterScreen'` centres in, so the placement
      // matches the primary-monitor original exactly and keeps the property the
      // fixture's own comment relies on (clear of the top-left desktop-icon /
      // Recycle Bin column). One `pickE2eScreen` call happens inside the helper,
      // so the centring and the fit-clamp read one monitor enumeration.
      // Single-monitor machines are a no-op.
      moveWindowToE2eScreen(w.hwnd, { width: w.region.width, height: w.region.height }, "centre");
      return { title, close };
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  close();
  return null;
}
