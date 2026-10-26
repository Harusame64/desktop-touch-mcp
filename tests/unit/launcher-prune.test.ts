import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The launcher's release-cache pruning (#848): after the server has started, old verified releases are removed so
 * the cache does not grow by one ~184 MB runtime per version. What must never go: the release being run, the
 * expected tag, the one in current.json, anything not a verified install, anything just installed.
 *
 * `bin/launcher.js` binds its cache root at module load, so every case imports a fresh copy with its own
 * DESKTOP_TOUCH_MCP_HOME (as launcher-release-resolution.test.ts does).
 */

const LAUNCHER_PATH = fileURLToPath(new URL("../../bin/launcher.js", import.meta.url));
const LAUNCHER_URL = pathToFileURL(LAUNCHER_PATH).href;
const METADATA_FILE = ".desktop-touch-release.json";
const DAY = 24 * 60 * 60 * 1000;

/** The pid of a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("could not start a process to take a dead pid from");
  return pid;
}

let importCounter = 0;

async function loadLauncher(home: string) {
  process.env.DESKTOP_TOUCH_MCP_HOME = home;
  importCounter += 1;
  return import(/* @vite-ignore */ `${LAUNCHER_URL}?prune=${importCounter}`);
}

describe("launcher release pruning", () => {
  let home: string;
  let tmpRoot: string;
  let warnings: string[];
  let launcher: any;
  let expected: any;
  const OWNED_ENV = ["DESKTOP_TOUCH_MCP_HOME", "DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED"] as const;
  const savedEnv = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));

  /** A verified install of `tagName`, installed `ageMs` ago; `metadata: null` for one with no marker. */
  async function seed(tagName: string, { ageMs = DAY, metadata }: { ageMs?: number; metadata?: unknown } = {}) {
    const dir = path.join(home, "releases", tagName);
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, "dist", "index.js"), "// stub runtime\n", "utf8");
    const marker = metadata === undefined
      ? { ...expected, tagName, updatedAt: new Date(Date.now() - ageMs).toISOString() }
      : metadata;
    if (marker !== null) await writeFile(path.join(dir, METADATA_FILE), JSON.stringify(marker), "utf8");
    return dir;
  }

  async function left() {
    return (await readdir(path.join(home, "releases"))).sort();
  }

  beforeEach(async () => {
    home = tmpRoot = await mkdtemp(path.join(os.tmpdir(), "dtmcp-prune-"));
    warnings = [];
    process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = "1";            // the in-repo manifest is PENDING
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => { warnings.push(String(message)); });
    launcher = await loadLauncher(home);
    expected = launcher.expectedReleaseSpec();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of OWNED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await chmod(path.join(home, "releases"), 0o755).catch(() => {});
    for (const d of await readdir(path.join(home, "releases")).catch(() => [] as string[])) {
      await chmod(path.join(home, "releases", d, "dist"), 0o755).catch(() => {});
    }
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("keeps the release being run and the newest other one, and removes the rest", async () => {
    // v2.10.0 against v2.9.0 catches a lexical sort.
    for (const tag of ["v2.8.0", "v2.9.0", "v2.10.0", "v2.11.0"]) await seed(tag);
    const removed = await launcher.pruneCache({ running: "v2.11.0", expectedTag: "v2.11.0", keep: 2 });
    expect(await left()).toEqual(["v2.10.0", "v2.11.0"]);
    expect(removed.sort()).toEqual(["v2.8.0", "v2.9.0"]);
  });

  it("keeps an expected tag older than a cached newer one (a pinned rollback)", async () => {
    for (const tag of ["v2.1.0", "v2.2.0", "v2.3.0"]) await seed(tag);
    await launcher.pruneCache({ running: "v2.1.0", expectedTag: "v2.1.0", keep: 2 });
    expect(await left()).toEqual(["v2.1.0", "v2.3.0"]);
  });

  it("keeps the release named in current.json and the one actually running (an offline fallback)", async () => {
    for (const tag of ["v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0"]) await seed(tag);
    await writeFile(path.join(home, "current.json"), JSON.stringify({ ...expected, tagName: "v2.0.0" }), "utf8");
    await launcher.pruneCache({ running: "v2.1.0", expectedTag: "v2.3.0", keep: 2 });
    expect(await left()).toEqual(["v2.0.0", "v2.1.0", "v2.3.0"]);
  });

  it("leaves anything that is not a verified install alone", async () => {
    await seed("v2.0.0", { metadata: null });                                   // interrupted install
    await seed("v2.1.0", { metadata: { ...expected, tagName: "v9.9.9" } });     // marker names another tag
    await seed("v2.2.0", { metadata: { ...expected, tagName: "v2.2.0", assetName: "other.zip" } });
    await seed("latest", { metadata: null });
    await seed("v2.3.0_foo", { metadata: null });
    await seed("v2.9.0");
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 });
    expect(await left()).toEqual(["latest", "v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0_foo", "v2.9.0"]);
  });

  it("does not remove a release installed in the last few minutes", async () => {
    await seed("v2.0.0", { ageMs: 60 * 1000 });
    await seed("v1.9.0", { ageMs: DAY });
    await seed("v2.9.0");
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 });
    expect(await left()).toEqual(["v2.0.0", "v2.9.0"]);
  });

  it("removes nothing when DESKTOP_TOUCH_MCP_KEEP_RELEASES is 0", async () => {
    for (const tag of ["v2.0.0", "v2.1.0", "v2.9.0"]) await seed(tag);
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 0 });
    expect(await left()).toEqual(["v2.0.0", "v2.1.0", "v2.9.0"]);
  });

  it("parses DESKTOP_TOUCH_MCP_KEEP_RELEASES as a whole number, otherwise the default", () => {
    expect(launcher.parseKeepReleases(undefined)).toEqual({ keep: 2, invalidValue: null });
    expect(launcher.parseKeepReleases("0")).toEqual({ keep: 0, invalidValue: null });
    expect(launcher.parseKeepReleases(" 5 ")).toEqual({ keep: 5, invalidValue: null });
    for (const raw of ["", "abc", "-1", "1.5", "2x"]) {
      expect(launcher.parseKeepReleases(raw)).toEqual({ keep: 2, invalidValue: raw.trim() });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a release it cannot move aside, intact, with a warning, and does not throw",
    async () => {
      const dir = await seed("v2.0.0");
      await seed("v2.9.0");
      // A read-only releases/ refuses the rename, as a release in use does on Windows.
      await chmod(path.join(home, "releases"), 0o555);
      await expect(launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 })).resolves.toEqual([]);
      expect(existsSync(path.join(dir, METADATA_FILE))).toBe(true);
      expect(existsSync(path.join(dir, "dist", "index.js"))).toBe(true);
      expect(warnings.join("\n")).toMatch(/Could not remove the old release v2\.0\.0/);
    }
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "never leaves a half-deleted release under its own name when a file inside cannot be removed",
    async () => {
      const dir = await seed("v2.0.0");
      await seed("v2.9.0");
      // dist/ read-only: its index.js cannot be deleted, as a loaded file cannot on Windows.
      await chmod(path.join(dir, "dist"), 0o555);
      await expect(launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 })).resolves.toBeDefined();
      // Either the release is whole under its name, or its name is gone; never in between.
      const whole = existsSync(path.join(dir, METADATA_FILE)) && existsSync(path.join(dir, "dist", "index.js"));
      expect(whole || !existsSync(dir)).toBe(true);
      expect(await launcher.findCachedRelease({ ...expected, tagName: "v2.5.0" })).toBeNull();
    }
  );

  it("removes what an earlier prune left half-deleted, which is never taken for a release", async () => {
    const trash = path.join(home, "releases", `.trash-v1.0.0-${deadPid()}-x`);
    await mkdir(path.join(trash, "dist"), { recursive: true });
    await writeFile(path.join(trash, "dist", "index.js"), "// leftover\n", "utf8");
    await writeFile(path.join(trash, METADATA_FILE), JSON.stringify({ ...expected, tagName: "v1.0.0" }), "utf8");
    expect(await launcher.findCachedRelease({ ...expected, tagName: "v9.0.0" })).toBeNull();
    await seed("v2.9.0");
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 2 });
    expect(await left()).toEqual(["v2.9.0"]);
  });

  it("keeps a release another live launcher runs, however old, and forgets the marks of launchers that are gone", async () => {
    // On macOS a release in use can be renamed away like any other, so the running/ marks are what spare it.
    for (const tag of ["v2.0.0", "v2.1.0", "v2.2.0", "v2.9.0"]) await seed(tag);
    await mkdir(path.join(home, "running"));
    await writeFile(path.join(home, "running", String(process.ppid)), "v2.0.0", "utf8");   // alive: our parent
    const gone = deadPid();
    await writeFile(path.join(home, "running", String(gone)), "v2.1.0", "utf8");
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 2 });
    // A release another launcher runs counts toward the two kept, as the one in current.json does.
    expect(await left()).toEqual(["v2.0.0", "v2.9.0"]);
    expect(existsSync(path.join(home, "running", String(gone)))).toBe(false);
    expect(existsSync(path.join(home, "running", String(process.ppid)))).toBe(true);
  });

  it("asks for the running marks again around the move of a release", async () => {
    // pruneCache's own snapshot of the marks can be older than a launcher that started meanwhile. The checks before
    // and after the rename cover for each other, so this cell is red only when both are gone.
    const dir = await seed("v2.0.0");
    await mkdir(path.join(home, "running"));
    await writeFile(path.join(home, "running", String(process.ppid)), "v2.0.0", "utf8");
    await expect(launcher.removeRelease(dir, "v2.0.0")).resolves.toBe(false);
    expect(existsSync(path.join(dir, METADATA_FILE))).toBe(true);
  });

  it("leaves a trash folder alone while the launcher that made it is alive (it may still put it back)", async () => {
    await seed("v2.9.0");
    const trash = path.join(home, "releases", `.trash-v1.0.0-${process.ppid}-x`);
    await mkdir(trash);
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 2 });
    expect(existsSync(trash)).toBe(true);
  });

  it("reads the releases a process list runs, by their dist/index.js", () => {
    const root = path.join(home, "releases");
    const ps = [
      `/usr/local/bin/node ${path.join(root, "v2.1.0", "dist", "index.js")} --stdio`,
      `node ${path.join(root, "v2.2.0", "dist", "other.js")}`,                  // not the runtime
      `vim ${path.join(root, "v2.3.0")}`,
      "/usr/bin/zsh",
    ].join("\n");
    expect([...launcher.releasesInCommandLines(ps, root)]).toEqual(["v2.1.0"]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a release whose runtime is running though no launcher marked it (one from before the marks)",
    async () => {
      // A cache root deep enough that the command line is longer than any display width (ps must not cut it).
      // Padded to the length, not by a fixed amount: a short temp root (/tmp on Linux) must get there too.
      while (path.join(home, "releases", "v2.0.0", "dist", "index.js").length <= 300) home = path.join(home, "d".repeat(100));
      launcher = await loadLauncher(home);
      const dir = await seed("v2.0.0");
      await seed("v2.9.0");
      expect(path.join(dir, "dist", "index.js").length).toBeGreaterThan(300);
      // A process whose command line names v2.0.0's runtime, as an old launcher's child does.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", path.join(dir, "dist", "index.js")], { stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 });
        expect(await left()).toEqual(["v2.0.0", "v2.9.0"]);
      } finally {
        child.kill();
      }
    }
  );

  it("asks a download folder's launcher whether it is still alive, whatever the folder's age", async () => {
    await seed("v2.9.0");
    const owned = path.join(home, `download-${process.ppid}-abc`);              // a long download still running
    const orphan = path.join(home, `download-${deadPid()}-def`);                 // its launcher was killed just now
    await mkdir(owned);
    await mkdir(orphan);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(owned, old, old);
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 2 });
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("removes a download folder an aborted launcher left, but not one being written now", async () => {
    await seed("v2.9.0");
    // Named without a pid, as before #848: the age decides.
    const stale = path.join(home, "download-stale");
    const fresh = path.join(home, "download-fresh");
    await mkdir(stale);
    await mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 2 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("says what it removed on stderr only: stdout is the MCP channel", async () => {
    for (const tag of ["v2.0.0", "v2.9.0"]) await seed(tag);
    const log = vi.spyOn(console, "log");
    const out = vi.spyOn(process.stdout, "write");
    await launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 });
    expect(log).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toMatch(/Removed old releases.*v2\.0\.0/);
  });

  it("prunes only after the server has been spawned, never on the way to starting it", async () => {
    // main() is not exported; the order is the contract, so it is read from the source.
    const source = await readFile(LAUNCHER_PATH, "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    const spawnAt = main.indexOf("launchServer(releaseDir);");
    const pruneAt = main.indexOf("pruneCache(");
    expect(spawnAt).toBeGreaterThan(0);
    expect(pruneAt).toBeGreaterThan(spawnAt);
    expect(main.slice(0, spawnAt)).not.toMatch(/pruneCache/);
  });
});
