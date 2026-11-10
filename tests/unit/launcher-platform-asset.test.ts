/**
 * Mac port M3-2b: the launcher installs the release zip for its platform — the Windows build on
 * Windows, the macOS build on Apple Silicon Macs — and verifies it against that zip's own SHA256.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LAUNCHER = new URL("../../bin/launcher.js", import.meta.url);

describe("the release zip for a platform", () => {
  it("is the Windows zip on Windows (any arch, as before) and the macOS zip on Apple Silicon only", async () => {
    const { assetNameFor } = await import(/* @vite-ignore */ `${LAUNCHER.href}?asset`);
    expect(assetNameFor("win32", "x64")).toBe("desktop-touch-mcp-windows.zip");
    expect(assetNameFor("win32", "arm64")).toBe("desktop-touch-mcp-windows.zip");
    expect(assetNameFor("darwin", "arm64")).toBe("desktop-touch-mcp-macos-arm64.zip");
    expect(assetNameFor("darwin", "x64")).toBeNull();
    expect(assetNameFor("linux", "x64")).toBeNull();
  });

  it("carries a SHA256 entry for every zip it can pick, each PENDING in source", () => {
    const src = readFileSync(LAUNCHER, "utf8");
    for (const asset of ["desktop-touch-mcp-windows.zip", "desktop-touch-mcp-macos-arm64.zip"]) {
      expect(src).toContain(`"${asset}": "PENDING"`);
    }
  });

  it("verifies against this machine's zip entry", async () => {
    process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED = "1";
    try {
      const { expectedReleaseSpec, assetNameFor } = await import(/* @vite-ignore */ `${LAUNCHER.href}?spec`);
      const spec = expectedReleaseSpec();
      expect(spec.assetName).toBe(assetNameFor(process.platform, process.arch) ?? "desktop-touch-mcp-windows.zip");
      expect(spec.sha256Pending).toBe(true);
    } finally {
      delete process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED;
    }
  });
});

describe("whether the launcher was started as the script (codex, #785)", () => {
  it("counts the launcher's own path as the launcher, and another file or no path as not", async () => {
    const { isLaunchedAsScript } = await import(/* @vite-ignore */ `${LAUNCHER.href}?bin`);
    const dir = mkdtempSync(join(tmpdir(), "dtmcp-bin-"));
    try {
      const other = join(dir, "other.js");
      writeFileSync(other, "");
      expect(isLaunchedAsScript(fileURLToPath(LAUNCHER), LAUNCHER.href)).toBe(true);
      expect(isLaunchedAsScript(other, LAUNCHER.href)).toBe(false);
      expect(isLaunchedAsScript(undefined, LAUNCHER.href)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a link to the launcher as the launcher, and a link to another file as not", async () => {
    const { isLaunchedAsScript } = await import(/* @vite-ignore */ `${LAUNCHER.href}?bin`);
    const dir = mkdtempSync(join(tmpdir(), "dtmcp-bin-"));
    // npm's bin entry is a file symlink. Windows refuses one without Developer Mode or elevation
    // (EPERM; internal #275), but makes a directory junction for anyone, and the launcher resolves
    // either through the same realpath: there the link is a junction to the file's folder.
    const linkTo = (target: string, name: string): string => {
      if (process.platform === "win32") {
        symlinkSync(dirname(target), join(dir, name), "junction");
        return join(dir, name, basename(target));
      }
      symlinkSync(target, join(dir, name));
      return join(dir, name);
    };
    try {
      mkdirSync(join(dir, "elsewhere"));
      const other = join(dir, "elsewhere", "other.js");
      writeFileSync(other, "");
      expect(isLaunchedAsScript(linkTo(fileURLToPath(LAUNCHER), "desktop-touch-mcp"), LAUNCHER.href)).toBe(true);
      expect(isLaunchedAsScript(linkTo(other, "another-tool"), LAUNCHER.href)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
