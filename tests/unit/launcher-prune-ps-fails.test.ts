import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * #848: when the process list cannot be read, the prune removes no release. An unknown list is not an empty one: a
 * runtime started by a launcher from before the running/ marks is only visible there.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" }), "");
    },
  };
});

const LAUNCHER_URL = pathToFileURL(fileURLToPath(new URL("../../bin/launcher.js", import.meta.url))).href;

describe.skipIf(process.platform === "win32")("launcher release pruning without a process list", () => {
  let home: string;
  let warnings: string[];
  const saved = { home: process.env.DESKTOP_TOUCH_MCP_HOME, unverified: process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dtmcp-prune-ps-"));
    warnings = [];
    process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = "1";
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => { warnings.push(String(message)); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (saved.home === undefined) delete process.env.DESKTOP_TOUCH_MCP_HOME; else process.env.DESKTOP_TOUCH_MCP_HOME = saved.home;
    if (saved.unverified === undefined) delete process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED;
    else process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = saved.unverified;
    await rm(home, { recursive: true, force: true });
  });

  it("removes no release, says why, and still clears a download whose launcher is gone", async () => {
    process.env.DESKTOP_TOUCH_MCP_HOME = home;
    const launcher = await import(/* @vite-ignore */ `${LAUNCHER_URL}?psfails=1`);
    const expected = launcher.expectedReleaseSpec();
    for (const tag of ["v2.0.0", "v2.1.0", "v2.9.0"]) {
      const dir = path.join(home, "releases", tag);
      await mkdir(path.join(dir, "dist"), { recursive: true });
      await writeFile(path.join(dir, "dist", "index.js"), "// stub\n", "utf8");
      await writeFile(path.join(dir, ".desktop-touch-release.json"),
        JSON.stringify({ ...expected, tagName: tag, updatedAt: new Date(Date.now() - 86400000).toISOString() }), "utf8");
    }
    const legacyDownload = path.join(home, "download-legacy");
    await mkdir(legacyDownload);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await (await import("node:fs/promises")).utimes(legacyDownload, old, old);

    await expect(launcher.pruneCache({ running: "v2.9.0", expectedTag: "v2.9.0", keep: 1 })).resolves.toEqual([]);
    expect((await readdir(path.join(home, "releases"))).sort()).toEqual(["v2.0.0", "v2.1.0", "v2.9.0"]);
    expect(warnings.join("\n")).toMatch(/Could not list the running processes/);
    expect((await readdir(home)).includes("download-legacy")).toBe(false);
  });
});
