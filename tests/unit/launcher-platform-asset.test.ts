/**
 * Mac port M3-2b: the launcher installs the release zip for its platform — the Windows build on
 * Windows, the macOS build on Apple Silicon Macs — and verifies it against that zip's own SHA256.
 */
import { readFileSync } from "node:fs";
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

describe("started through npm's bin symlink (codex, #785)", () => {
  it("counts a symlink to the launcher as the launcher, and another file as not", async () => {
    const { mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { isLaunchedAsScript } = await import(/* @vite-ignore */ `${LAUNCHER.href}?bin`);
    const dir = mkdtempSync(join(tmpdir(), "dtmcp-bin-"));
    const link = join(dir, "desktop-touch-mcp");
    symlinkSync(fileURLToPath(LAUNCHER), link);
    const other = join(dir, "other.js");
    writeFileSync(other, "");
    expect(isLaunchedAsScript(link, LAUNCHER.href)).toBe(true);
    expect(isLaunchedAsScript(fileURLToPath(LAUNCHER), LAUNCHER.href)).toBe(true);
    expect(isLaunchedAsScript(other, LAUNCHER.href)).toBe(false);
    expect(isLaunchedAsScript(undefined, LAUNCHER.href)).toBe(false);
  });
});
