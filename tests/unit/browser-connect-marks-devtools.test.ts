/**
 * internal #398 (gate 2 and agy on #968) — browser_connect marks DevTools' own front end, and a focused
 * DevTools is not reported as the active tab: a call with that id would read DevTools, not the page.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  listTabs: vi.fn(async () => [
    { id: "DT", type: "page", title: "DevTools", url: "devtools://devtools/bundled/devtools_app.html" },
    { id: "PG", type: "page", title: "Page", url: "https://example.com/" },
  ]),
  // Only DevTools has the focus.
  evaluateInTab: vi.fn(async (_expr: string, tabId: string | null) => tabId === "DT"),
}));

const { browserConnectHandler } = await import("../../src/tools/browser.js");

describe("browser_connect and DevTools", () => {
  it("marks DevTools devtools:true, and neither its entry nor the top level calls it active", async () => {
    const r = await browserConnectHandler({ port: 9222 });
    const t = (r.content[0] as { text: string }).text;
    const json = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) as { active: string | null; tabs: Array<{ id: string; active: boolean; devtools?: boolean }> };
    expect(json.active).toBeNull();
    expect(json.tabs.find((x) => x.id === "DT")).toMatchObject({ devtools: true, active: false });
    expect(json.tabs.find((x) => x.id === "PG")?.devtools).toBeUndefined();
    expect(t).toMatch(/DevTools' own window marked devtools:true/);
  });
});
