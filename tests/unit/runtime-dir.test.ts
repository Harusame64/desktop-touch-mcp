import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { getRuntimeDir } from "../../src/utils/runtime-dir.js";

const DEFAULT = path.join(os.homedir(), ".desktop-touch-mcp");

describe("getRuntimeDir", () => {
  it("defaults to ~/.desktop-touch-mcp when no override is set", () => {
    expect(getRuntimeDir({})).toBe(DEFAULT);
  });

  it("honors DESKTOP_TOUCH_MCP_HOME, resolved to an absolute path", () => {
    const abs = process.platform === "win32" ? "C:\\custom\\dt-home" : "/custom/dt-home";
    const dir = getRuntimeDir({ DESKTOP_TOUCH_MCP_HOME: abs });
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.resolve(abs));
  });

  it("treats empty / whitespace override as unset (falls back to default)", () => {
    expect(getRuntimeDir({ DESKTOP_TOUCH_MCP_HOME: "" })).toBe(DEFAULT);
    expect(getRuntimeDir({ DESKTOP_TOUCH_MCP_HOME: "   " })).toBe(DEFAULT);
  });

  it("resolves a relative override against cwd (caller must canonicalize for trust)", () => {
    expect(getRuntimeDir({ DESKTOP_TOUCH_MCP_HOME: "rel-home" })).toBe(path.resolve("rel-home"));
  });
});
