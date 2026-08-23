import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Coverage for the launcher's release-resolution contract (`ensureRelease`):
 * the network is tried first, the fail-closed default never runs an unverified
 * tree, and the DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK escape hatch only answers
 * for network-class failures.
 *
 * `bin/launcher.js` binds its cache root at module load, so every case imports
 * a fresh copy of the module with its own DESKTOP_TOUCH_MCP_HOME.
 */

const LAUNCHER_URL = pathToFileURL(
  fileURLToPath(new URL("../../bin/launcher.js", import.meta.url))
).href;
const METADATA_FILE = ".desktop-touch-release.json";

let importCounter = 0;

async function loadLauncher(home: string) {
  process.env.DESKTOP_TOUCH_MCP_HOME = home;
  importCounter += 1;
  return import(/* @vite-ignore */ `${LAUNCHER_URL}?case=${importCounter}`);
}

/** Writes a release directory; pass `metadata: null` for an install with no marker. */
async function seedRelease(home: string, tagName: string, metadata: unknown) {
  const dir = path.join(home, "releases", tagName);
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "dist", "index.js"), "// stub runtime\n", "utf8");
  if (metadata !== null) {
    await writeFile(path.join(dir, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
  return dir;
}

function networkFailure() {
  return new TypeError("fetch failed");
}

describe("launcher release resolution", () => {
  let home: string;
  let warnings: string[];
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dtmcp-launcher-"));
    warnings = [];
    // The in-repo manifest carries the PENDING placeholder; the opt-in below is
    // what a source checkout needs to resolve a release spec at all.
    process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = "1";
    delete process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK;
    delete process.env.DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS;
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    await rm(home, { recursive: true, force: true });
  });

  it("reuses a verified install without touching the network", async () => {
    const launcher = await loadLauncher(home);
    const expected = launcher.expectedReleaseSpec();
    const dir = await seedRelease(home, expected.tagName, expected);
    const fetchSpy = vi.fn(async () => {
      throw new Error("the network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(launcher.ensureRelease()).resolves.toBe(dir);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not run an unverified install when the fallback is off", async () => {
    const launcher = await loadLauncher(home);
    const expected = launcher.expectedReleaseSpec();
    // Right directory, wrong marker: the install never completed verification.
    await seedRelease(home, expected.tagName, { ...expected, tagName: "v0.0.0" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw networkFailure();
    }));

    await expect(launcher.ensureRelease()).rejects.toThrow(/fetch failed/);
  });

  it("runs the unverified install of the expected tag when the fallback is on", async () => {
    process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK = "1";
    const launcher = await loadLauncher(home);
    const expected = launcher.expectedReleaseSpec();
    const dir = await seedRelease(home, expected.tagName, { ...expected, tagName: "v0.0.0" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw networkFailure();
    }));

    await expect(launcher.ensureRelease()).resolves.toBe(dir);
    expect(warnings.join("\n")).toMatch(/without re-verification/);
  });

  it("still fails loudly on an HTTP error even with the fallback on", async () => {
    process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK = "1";
    const launcher = await loadLauncher(home);
    const expected = launcher.expectedReleaseSpec();
    await seedRelease(home, expected.tagName, { ...expected, tagName: "v0.0.0" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "rate limit exceeded",
    })));

    await expect(launcher.ensureRelease()).rejects.toThrow(/403/);
  });

  it("falls back to the newest verified cached release at or below the expected tag", async () => {
    process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK = "1";
    const launcher = await loadLauncher(home);
    const expected = launcher.expectedReleaseSpec();
    await seedRelease(home, "v1.9.10", { ...expected, tagName: "v1.9.10" });
    const newestBelow = await seedRelease(home, "v1.14.3", { ...expected, tagName: "v1.14.3" });
    // A leftover from a newer package must never be picked as a fallback.
    await seedRelease(home, "v99.0.0", { ...expected, tagName: "v99.0.0" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw networkFailure();
    }));

    await expect(launcher.ensureRelease()).resolves.toBe(newestBelow);
    expect(warnings.join("\n")).toMatch(/v1\.14\.3/);
  });

  it("ignores a cached release that carries no verified-install marker", async () => {
    process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK = "1";
    const launcher = await loadLauncher(home);
    await seedRelease(home, "v1.14.3", null);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw networkFailure();
    }));

    await expect(launcher.ensureRelease()).rejects.toThrow(/fetch failed/);
  });

  it("rethrows when the fallback is on but nothing is cached", async () => {
    process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK = "1";
    const launcher = await loadLauncher(home);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw networkFailure();
    }));

    await expect(launcher.ensureRelease()).rejects.toThrow(/fetch failed/);
  });
});

describe("parseFetchTimeoutMs", () => {
  it("accepts only a finite positive number of milliseconds", async () => {
    const launcher = await import(/* @vite-ignore */ `${LAUNCHER_URL}?case=timeout`);
    const { parseFetchTimeoutMs } = launcher;

    expect(parseFetchTimeoutMs(undefined)).toEqual({ timeoutMs: 15000, invalidValue: null });
    expect(parseFetchTimeoutMs("2500")).toEqual({ timeoutMs: 2500, invalidValue: null });
    expect(parseFetchTimeoutMs("  2500  ")).toEqual({ timeoutMs: 2500, invalidValue: null });

    // Each of these coerces to a ~1ms timer through the old Number(...) path,
    // which would abort every request before it could start.
    expect(parseFetchTimeoutMs("")).toEqual({ timeoutMs: 15000, invalidValue: "" });
    expect(parseFetchTimeoutMs("   ")).toEqual({ timeoutMs: 15000, invalidValue: "" });
    expect(parseFetchTimeoutMs("abc")).toEqual({ timeoutMs: 15000, invalidValue: "abc" });
    expect(parseFetchTimeoutMs("0")).toEqual({ timeoutMs: 15000, invalidValue: "0" });
    expect(parseFetchTimeoutMs("-5")).toEqual({ timeoutMs: 15000, invalidValue: "-5" });
    expect(parseFetchTimeoutMs("Infinity")).toEqual({ timeoutMs: 15000, invalidValue: "Infinity" });
  });
});

describe("isNetworkClassError", () => {
  it("separates an unreachable network from an answer we did not like", async () => {
    const launcher = await import(/* @vite-ignore */ `${LAUNCHER_URL}?case=classify`);
    const { isNetworkClassError } = launcher;

    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    const timedOut = new Error("timed out after 15000ms");
    timedOut.name = "TimeoutError";
    const refused = new Error("connect ECONNREFUSED");
    (refused as NodeJS.ErrnoException).code = "ECONNREFUSED";
    const wrapped = new Error("request failed", { cause: { code: "ENOTFOUND" } });

    expect(isNetworkClassError(aborted)).toBe(true);
    expect(isNetworkClassError(timedOut)).toBe(true);
    expect(isNetworkClassError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkClassError(refused)).toBe(true);
    expect(isNetworkClassError(wrapped)).toBe(true);

    expect(isNetworkClassError(new Error("GitHub Releases API returned 404 Not Found"))).toBe(false);
    expect(isNetworkClassError(new Error("SHA256 mismatch for desktop-touch-mcp-windows.zip"))).toBe(false);
    expect(isNetworkClassError(new Error("Unexpected tag: expected v1.0.0, got v2.0.0"))).toBe(false);
    expect(isNetworkClassError(undefined)).toBe(false);
  });
});

describe("compareTagVersions", () => {
  it("orders release tags numerically, not lexically", async () => {
    const launcher = await import(/* @vite-ignore */ `${LAUNCHER_URL}?case=compare`);
    const { compareTagVersions } = launcher;

    expect(compareTagVersions("v1.10.0", "v1.9.10")).toBe(1);
    expect(compareTagVersions("v1.9.10", "v1.9.9")).toBe(1);
    expect(compareTagVersions("v1.9.0", "v1.9.0")).toBe(0);
    expect(compareTagVersions("v1.9.0", "v1.10.0")).toBe(-1);
    expect(["v1.9.9", "v1.10.0", "v1.9.10"].sort((a, b) => compareTagVersions(b, a))).toEqual([
      "v1.10.0",
      "v1.9.10",
      "v1.9.9",
    ]);
  });
});
