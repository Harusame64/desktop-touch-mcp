/**
 * internal #377 item 4 (2.4.1 dogfood, win2): after the browser closed, `browser_form` answered
 * `code:"ToolError"` with no `suggest`. The text was "Cannot reach Chrome/Edge CDP at port 9222 …
 * Original error: TypeError: fetch failed". The classifier's BrowserNotConnected arm looks for
 * "not connected" or "econnrefused", and Node's fetch puts ECONNREFUSED in the error's cause, not
 * its text — so the arm never fired, for any browser_* tool.
 *
 * The producer now declares the code. These cells go through the handlers, with fetch failing the
 * way Node's does, so they turn red if the declaration is dropped from `fetchTabs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/desktop-config.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/desktop-config.js")>()),
  getCdpPort: () => 9222,
}));

import { browserGetFormHandler, browserGetInteractiveHandler } from "../../src/tools/browser.js";
import { setBrowserSearchHook, waitUntilHandler } from "../../src/tools/wait-until.js";
import { listTabs } from "../../src/engine/cdp-bridge.js";

const realFetch = globalThis.fetch;

function nodeFetchFailure(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9222"), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => { throw nodeFetchFailure(); }) as never;
});
afterEach(() => { globalThis.fetch = realFetch; setBrowserSearchHook(null); });

function envelope(result: { content: Array<{ type: string; text?: string }> }): {
  ok: boolean; code: string; error: string; suggest?: string[];
} {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

describe("an unreachable CDP endpoint", () => {
  it("browser_form answers BrowserNotConnected with the re-attach advice", async () => {
    const env = envelope(await browserGetFormHandler({
      selector: "#login-form", includeHidden: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BrowserNotConnected");
    expect(env.suggest?.some((s) => s.includes("browser_open"))).toBe(true);
    expect(env.error).toContain("Cannot reach Chrome/Edge CDP at port 9222");
  });

  it("so does another browser_* tool on the same road (browser_overview)", async () => {
    const env = envelope(await browserGetInteractiveHandler({
      types: ["all"], inViewportOnly: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    expect(env.code).toBe("BrowserNotConnected");
    expect(env.suggest?.length).toBeGreaterThan(0);
  });

  it("wait_until(url_matches) names the code once, not twice", async () => {
    const env = envelope(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/dashboard", port: 9222 }, timeoutMs: 1000,
    } as never));
    expect(env.code).toBe("BrowserNotConnected");
    expect(env.error).not.toContain("BrowserNotConnected: BrowserNotConnected:");
  });

  it("wait_until(element_matches) passes the declared error through as it is", async () => {
    setBrowserSearchHook(async () => { await listTabs(9222); return []; });
    const env = envelope(await waitUntilHandler({
      condition: "element_matches", target: { by: "text", pattern: "Save", port: 9222 }, timeoutMs: 1000,
    } as never));
    expect(env.code).toBe("BrowserNotConnected");
    expect(env.error).not.toContain("BrowserNotConnected: BrowserNotConnected:");
  });
});

describe("a CDP endpoint that does not answer in time", () => {
  it("is not declared BrowserNotConnected — something holds the port, and launching would start a second browser", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as never;
    const err = await listTabs(9222).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/^Cannot reach Chrome\/Edge CDP at port 9222/);
    const env = envelope(await browserGetFormHandler({
      selector: "#login-form", includeHidden: false, maxResults: 50, port: 9222, includeContext: false,
    }));
    expect(env.code).not.toBe("BrowserNotConnected");
  });
});
