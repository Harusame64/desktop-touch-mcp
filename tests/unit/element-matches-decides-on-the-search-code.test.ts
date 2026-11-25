/**
 * wait_until(element_matches) decides on the code the browser_search hook passes up
 * (BrowserSearchFailure), never on words that can hold the caller's pattern.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../../src/engine/win32.js", () => ({ enumWindowsInZOrder: () => [], getWindowProcessId: () => 0 }));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: async () => ({ found: null, why: "element_not_found", via: "powershell" }),
}));

import { waitUntilHandler, setBrowserSearchHook, BrowserSearchFailure } from "../../src/tools/wait-until.js";

afterEach(() => setBrowserSearchHook(null));

const payload = (r: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(r.content.find((b) => b.type === "text")!.text!);

async function waitWith(fail: BrowserSearchFailure, timeoutMs = 300) {
  setBrowserSearchHook(async () => { throw fail; });
  const t = Date.now();
  const out = payload(await waitUntilHandler({
    condition: "element_matches", target: { by: "text", pattern: "Save" }, timeoutMs, intervalMs: 50,
  } as never));
  return { out, wall: Date.now() - t };
}

describe("element_matches decides on the search's code", () => {
  it("BrowserNotConnected is answered at once, with the code said once", async () => {
    const { out, wall } = await waitWith(new BrowserSearchFailure("BrowserNotConnected",
      "browser_search failed: BrowserNotConnected: Cannot reach Chrome/Edge CDP at port 9222."), 2000);
    expect(out.code).toBe("BrowserNotConnected");
    expect(wall).toBeLessThan(500);
    expect(out.error.match(/BrowserNotConnected/g)).toHaveLength(1);
  });

  it("a session that closed under the poll is BrowserNotConnected, as url_matches answers it", async () => {
    const { out, wall } = await waitWith(new BrowserSearchFailure("ToolError", "browser_search failed: CDP connection closed unexpectedly"), 2000);
    expect(out.code).toBe("BrowserNotConnected");
    expect(wall).toBeLessThan(500);
  });

  it("a CDP timeout is waited past and recorded from its own prefix, with the slow-page line", async () => {
    const { out } = await waitWith(new BrowserSearchFailure("UiaTimeout",
      "browser_search failed: CDP timeout: Runtime.evaluate did not respond within 15000ms"));
    expect(out.code).toBe("WaitTimeout");
    expect(out.context.lastLook.error).toBe("CDP timeout: Runtime.evaluate did not respond within 15000ms");
    expect(out.suggest[0]).toMatch(/^The page did not answer within the CDP call's own 15 s, so it was not read/);
  });

  it("a scope that matches nothing yet is waited past and named", async () => {
    const { out } = await waitWith(new BrowserSearchFailure("ScopeNotFound", "browser_search: ScopeNotFound — #panel"));
    expect(out.code).toBe("WaitTimeout");
    expect(out.context.lastLook.error).toBe("ScopeNotFound: browser_search: ScopeNotFound — #panel");
  });

  it("an invalid regex whose words hold the bridge's closed-session words is still InvalidArgs (codex on #1044)", async () => {
    for (const pattern of ["(CDP session is not open", "(CDP connection closed unexpectedly"]) {
      const { out } = await waitWith(new BrowserSearchFailure("BrowserSearchNoResults",
        `browser_search: InvalidRegex — Invalid regular expression: /${pattern}/: Unterminated group`), 2000);
      expect(out.code, pattern).toBe("InvalidArgs");
    }
  });

  it("an invalid regex is InvalidArgs at once, even when its words name another code", async () => {
    const { out, wall } = await waitWith(new BrowserSearchFailure("BrowserSearchNoResults",
      "browser_search: InvalidRegex — Invalid regular expression: /(wait timeout/: Unterminated group"), 2000);
    expect(out.code).toBe("InvalidArgs");
    expect(wall).toBeLessThan(500);
  });
});
