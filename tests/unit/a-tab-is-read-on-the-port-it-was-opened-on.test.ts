/**
 * llm22 drive F13 (win2, 2026-10-04): after browser_open(port:9333), desktop_discover on that tab
 * read CDP at a hardcoded 9222 and failed (all_providers_failed, "check port 9222"). A tab is
 * remembered with the port it was listed on; otherwise the configured default is used, as the
 * browser_* tools do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ port: 9222 }));
vi.mock("../../src/utils/desktop-config.js", () => ({ getCdpPort: () => cfg.port }));

import { listTabs, portForTab, rememberTabPort } from "../../src/engine/cdp-bridge.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { cfg.port = 9222; });

describe("portForTab", () => {
  it("answers the port a tab was listed on", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ id: "TAB-9333", type: "page", url: "about:blank", title: "x" }]))) as never;
    await listTabs(9333);
    expect(portForTab("TAB-9333")).toBe(9333);
  });

  it("answers the configured default for a tab it has not seen, and for none", () => {
    cfg.port = 9444;
    expect(portForTab("never-listed")).toBe(9444);
    expect(portForTab(null)).toBe(9444);
  });

  it("keeps the latest port a tab was listed on", () => {
    rememberTabPort("T", 9333);
    rememberTabPort("T", 9555);
    expect(portForTab("T")).toBe(9555);
  });
});
