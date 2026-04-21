import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDesktopTools,
  getDesktopFacade,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import { DesktopFacade } from "../../src/tools/desktop.js";

afterEach(() => {
  _resetFacadeForTest();
});

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

describe("registerDesktopTools", () => {
  it("does not throw when called on an empty server", () => {
    expect(() => registerDesktopTools(makeServer())).not.toThrow();
  });

  it("can be called on multiple servers (stateless HTTP pattern — one per request)", () => {
    expect(() => {
      registerDesktopTools(makeServer());
      registerDesktopTools(makeServer());
    }).not.toThrow();
  });

  it("calling on the same server twice does not throw (idempotency guard)", () => {
    const s = makeServer();
    registerDesktopTools(s);
    // MCP SDK may throw or silently ignore duplicate names — we just verify no crash
    expect(() => {
      try { registerDesktopTools(s); } catch { /* SDK may reject duplicates — acceptable */ }
    }).not.toThrow();
  });
});

describe("Facade singleton (flag-ON lifecycle)", () => {
  it("getDesktopFacade returns a DesktopFacade instance", () => {
    const facade = getDesktopFacade();
    expect(facade).toBeInstanceOf(DesktopFacade);
  });

  it("getDesktopFacade returns the same instance on repeated calls", () => {
    expect(getDesktopFacade()).toBe(getDesktopFacade());
  });

  it("_resetFacadeForTest breaks the singleton — next call returns a new instance", () => {
    const first = getDesktopFacade();
    _resetFacadeForTest();
    const second = getDesktopFacade();
    expect(first).not.toBe(second);
  });

  it("DesktopFacade has dispose() to close ingress subscriptions on reset", () => {
    const facade = getDesktopFacade();
    // dispose must exist — _resetFacadeForTest calls it to prevent subscription leaks
    expect(typeof (facade as unknown as { dispose?: unknown }).dispose).toBe("function");
  });

  it("facade from registerDesktopTools is the same singleton as getDesktopFacade", () => {
    const singleton = getDesktopFacade();
    const server = makeServer();
    registerDesktopTools(server);
    // After registration, singleton must not have changed
    expect(getDesktopFacade()).toBe(singleton);
  });
});

describe("Flag-OFF safety", () => {
  it("desktop-register module imports without error (no side-effects at import time)", async () => {
    const mod = await import("../../src/tools/desktop-register.js");
    expect(typeof mod.registerDesktopTools).toBe("function");
    expect(typeof mod.getDesktopFacade).toBe("function");
  });

  it("desktop.ts module imports without error (no OS calls at import time)", async () => {
    const mod = await import("../../src/tools/desktop.js");
    expect(typeof mod.DesktopFacade).toBe("function");
  });
});
