import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describeShortExtraction, readZipFileNames } from "../../bin/launcher.js";

// Stands in for Expand-Archive: each case decides what lands in the destination
// and what goes to stderr. The exit is always 0, as it was in #208. Like Node's
// execFile, it fails once stderr outgrows the caller's maxBuffer (1 MiB unless
// set), which is how #208 surfaced as "stderr maxBuffer length exceeded".
// The zip the launcher picks on this machine (Mac port: Apple Silicon Macs get the macOS zip).
const ASSET = process.platform === "darwin" && process.arch === "arm64"
  ? "desktop-touch-mcp-macos-arm64.zip"
  : "desktop-touch-mcp-windows.zip";

const extractor = vi.hoisted(() => ({
  run: async (_destination: string): Promise<string> => "",
  /** The extractor the launcher ran, as [command, ...args] (Mac port: unzip on macOS). */
  calls: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      command: string,
      args: string[],
      options: { maxBuffer?: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      extractor.calls.push([command, ...args]);
      const maxBuffer = options?.maxBuffer ?? 1024 * 1024;
      extractor.run(args[args.length - 1]).then(
        (stderr) =>
          stderr.length > maxBuffer
            ? callback(new RangeError("stderr maxBuffer length exceeded"), "", stderr.slice(0, maxBuffer))
            : callback(null, "", stderr),
        (error: Error) => callback(error, "", ""),
      );
    },
  };
});

/**
 * internal #208: Expand-Archive under Windows PowerShell 5.1 lost every file of
 * the release under a long DESKTOP_TOUCH_MCP_HOME, exited 0, and put the real
 * cause after ~1,600 cleanup errors. The launcher now counts the files it was
 * left against the zip's central directory and names the path length itself.
 */

/** A stored (uncompressed) zip whose entries are empty; `comment` pads the EOCD. */
function buildZip(names: string[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length;
  }
  const centralDir = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, centralDir, eocd, commentBytes]);
}

describe("readZipFileNames", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dtmcp-zip-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(bytes: Buffer): Promise<string> {
    const zipPath = path.join(dir, "release.zip");
    await writeFile(zipPath, bytes);
    return zipPath;
  }

  it("lists the files in order and leaves out directory entries", async () => {
    const zipPath = await write(
      buildZip(["dist/", "dist/index.js", "node_modules/a/", "node_modules/a/b.d.ts.map", "LICENSE"]),
    );
    expect(await readZipFileNames(zipPath)).toEqual(["dist/index.js", "node_modules/a/b.d.ts.map", "LICENSE"]);
  });

  it("finds the end record behind an archive comment", async () => {
    const zipPath = await write(buildZip(["dist/index.js"], "x".repeat(300)));
    expect(await readZipFileNames(zipPath)).toEqual(["dist/index.js"]);
  });

  it("answers null, not a count, for a file it cannot read as a plain zip", async () => {
    expect(await readZipFileNames(await write(Buffer.from("not a zip at all, just text")))).toBeNull();

    // A zip64 archive leaves this field at its maximum and keeps the real
    // offset elsewhere, so it points far past the end of the file.
    const zip64 = buildZip(["dist/index.js"]);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(await readZipFileNames(await write(zip64))).toBeNull();

    const broken = buildZip(["dist/index.js"]);
    broken.writeUInt32LE(0, broken.length - 22 - (46 + "dist/index.js".length));
    expect(await readZipFileNames(await write(broken))).toBeNull();
  });
});

describe("describeShortExtraction", () => {
  // The shape of #208: a 109-character entry under a 160-character extract directory.
  const names = ["dist/index.js", `node_modules/${"n".repeat(109 - "node_modules/".length)}`];
  const longRoot = `C:\\${"h".repeat(133)}`;
  const longDir = `${longRoot}\\download-AbCdEf\\extract`;

  it("names the path length and how much shorter the home must be", () => {
    const message = describeShortExtraction({
      extracted: 0,
      names,
      cacheRoot: longRoot,
      extractDir: longDir,
      stderr: "",
    });
    expect(longDir.length).toBe(160);
    expect(message).toBe(
      [
        `Extracting ${ASSET} under ${longRoot} left 0 of 2 files.`,
        "Its longest file comes to 270 characters there, and Windows refuses a path over 259 characters " +
          "unless long paths are enabled. Set DESKTOP_TOUCH_MCP_HOME to a directory at least 11 characters " +
          `shorter than ${longRoot}.`,
      ].join("\n"),
    );
  });

  it("does not blame the path length when the longest file fits", () => {
    const message = describeShortExtraction({
      extracted: 1,
      names,
      cacheRoot: "C:\\u",
      extractDir: "C:\\u\\download-AbCdEf\\extract",
      stderr: "",
    });
    expect(message).toBe(`Extracting ${ASSET} under C:\\u left 1 of 2 files.`);
  });

  it("keeps the end of the extractor's stderr, where the real cause is", () => {
    const flood = "Remove-Item : Cannot find path because it does not exist.\n".repeat(2000);
    const cause = "ExtractToFile : Could not find a part of the path 'C:\\h\\x.d.ts.map'.";
    const message = describeShortExtraction({
      extracted: 0,
      names,
      cacheRoot: longRoot,
      extractDir: longDir,
      stderr: flood + cause,
    });
    const reported = message.split("The extractor reported:\n")[1];
    expect(reported.endsWith(cause)).toBe(true);
    expect(reported.startsWith("...")).toBe(true);
    expect(reported.length).toBe(1003);
  });
});

describe("installing a release counts what the extractor left", () => {
  const LAUNCHER_URL = pathToFileURL(fileURLToPath(new URL("../../bin/launcher.js", import.meta.url))).href;
  const NAMES = ["dist/index.js", "node_modules/a/b.js"];
  const OWNED_ENV = ["DESKTOP_TOUCH_MCP_HOME", "DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED"] as const;
  const savedEnv = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  let home: string;
  let importCounter = 0;

  async function loadLauncher() {
    process.env.DESKTOP_TOUCH_MCP_HOME = home;
    importCounter += 1;
    return import(/* @vite-ignore */ `${LAUNCHER_URL}?extract=${importCounter}`);
  }

  function extractOnly(names: string[], stderr = "") {
    extractor.run = async (destination) => {
      for (const name of names) {
        await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
        await writeFile(path.join(destination, name), "// stub\n", "utf8");
      }
      return stderr;
    };
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dtmcp-extract-"));
    // The in-repo manifest carries the PENDING placeholder; this is what lets
    // a source checkout install without a real SHA256.
    process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = "1";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const key of OWNED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  async function install(zip: Buffer = buildZip(["dist/", ...NAMES])) {
    const launcher = await loadLauncher();
    const { tagName } = launcher.expectedReleaseSpec();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new URL(url).hostname === "api.github.com"
          ? new Response(
              JSON.stringify({
                tag_name: tagName,
                assets: [{ name: ASSET, browser_download_url: "https://example.test/z" }],
              }),
            )
          : new Response(zip),
      ),
    );
    return { tagName, result: launcher.ensureRelease() };
  }

  it("installs when every file arrived", async () => {
    extractOnly(NAMES);
    const { tagName, result } = await install();
    const dir = path.join(home, "releases", tagName);
    await expect(result).resolves.toBe(dir);
    expect(existsSync(path.join(dir, "node_modules", "a", "b.js"))).toBe(true);
  });

  // Mac port (gate 2, #785): which extractor runs is part of the contract — unzip on macOS (keeps
  // node_modules/.bin symlinks, adds no quarantine), PowerShell's Expand-Archive on Windows.
  it("extracts with this platform's extractor", async () => {
    extractor.calls.length = 0;
    extractOnly(NAMES);
    const { result } = await install();
    await result;
    const [command, ...args] = extractor.calls.at(-1) ?? [];
    if (process.platform === "darwin") {
      expect(command).toBe("unzip");
      expect(args.slice(0, 2)).toEqual(["-q", "-o"]);
      expect(args.at(-2)).toBe("-d");
    } else {
      expect(["powershell.exe", "pwsh.exe"]).toContain(command);
      expect(args.join(" ")).toContain("Expand-Archive");
    }
  });

  it("refuses an extraction that kept dist/index.js but lost other files", async () => {
    extractOnly(["dist/index.js"]);
    const { tagName, result } = await install();
    await expect(result).rejects.toThrow(/left 1 of 2 files/);
    expect(existsSync(path.join(home, "releases", tagName))).toBe(false);
  });

  it("reports the extractor's last words when it exits 0 having written nothing", async () => {
    const cause = "ExtractToFile : Could not find a part of the path 'x.d.ts.map'.";
    extractOnly([], "Remove-Item : does not exist.\n".repeat(50_000) + cause);
    const { result } = await install();
    await expect(result).rejects.toThrow(/left 0 of 2 files\.\nThe extractor reported:\n[\s\S]*Could not find a part of the path 'x\.d\.ts\.map'\.$/);
  });

  it("says so when it cannot read the file list, and installs as before", async () => {
    const errors = vi.mocked(console.error);
    extractOnly(NAMES);
    const { tagName, result } = await install(Buffer.from("not a zip the launcher can read"));
    await expect(result).resolves.toBe(path.join(home, "releases", tagName));
    expect(errors.mock.calls.map((call) => String(call[0]))).toContain(
      `[desktop-touch-mcp] WARNING: Could not read the file list in ${ASSET}; ` +
        "installing without checking that every file was extracted.",
    );
  });
});
