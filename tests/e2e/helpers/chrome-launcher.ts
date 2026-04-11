/**
 * chrome-launcher.ts — Test helper to launch Chrome with CDP remote debugging
 *
 * Finds the Chrome executable, starts it with a temporary user-data-dir and
 * --remote-debugging-port, waits for CDP to become available, and returns
 * a cleanup function.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CHROME_CANDIDATES: string[] = [
  process.env.CHROME_PATH ?? "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : "",
  // Edge fallback
  process.env.EDGE_PATH ?? "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

export interface ChromeInstance {
  port: number;
  kill: () => void;
}

/**
 * Launch Chrome with remote debugging enabled.
 * @param port     CDP port (default 9223 — avoids conflict with dev Chrome on 9222)
 * @param headless Run headless (default false; screen coordinate tests require headed)
 */
export async function launchChrome(
  port = 9223,
  headless = false,
  initialUrl = "about:blank"
): Promise<ChromeInstance> {
  const chromePath = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), "cdp-test-"));

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--disable-background-networking",
    "--safebrowsing-disable-auto-update",
    ...(headless ? ["--headless=new"] : []),
    initialUrl,
  ];

  const proc: ChildProcess = spawn(chromePath, args, {
    stdio: "ignore",
    detached: false,
  });

  proc.on("error", (err) => {
    console.error(`Chrome process error: ${err.message}`);
  });

  await waitForCdp(port);

  return {
    port,
    kill: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Wait until the CDP endpoint at the given port accepts connections.
 */
export async function waitForCdp(
  port: number,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Chrome CDP at port ${port} did not become available within ${timeoutMs}ms`
  );
}

/** Returns the path to the first found Chrome/Edge executable */
export function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Chrome/Edge executable not found. ` +
      `Set CHROME_PATH or EDGE_PATH environment variable, ` +
      `or install Chrome to a standard location.\n` +
      `Checked: ${CHROME_CANDIDATES.join(", ")}`
  );
}
