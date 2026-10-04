/** llm22 F13 — desktop_discover's browser lane reads the tab on the port it was listed on. */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ ports: [] as number[] }));
vi.mock("../../src/engine/cdp-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/cdp-bridge.js")>();
  return {
    ...actual,
    portForTab: (tabId: string) => (tabId === "TAB-9333" ? 9333 : 9222),
    evaluateInTab: vi.fn(async (_s: string, _t: string, port: number) => { calls.ports.push(port); return []; }),
  };
});

import { fetchBrowserCandidates } from "../../src/tools/desktop-providers/browser-provider.js";

describe("fetchBrowserCandidates", () => {
  it("asks CDP on the tab's own port", async () => {
    await fetchBrowserCandidates({ tabId: "TAB-9333" });
    expect(calls.ports).toEqual([9333]);
  });
});
