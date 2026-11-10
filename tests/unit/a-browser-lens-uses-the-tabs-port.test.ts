/**
 * internal #254 — the perception registry's browser-tab lenses read CDP at a fixed 9222: the tab list,
 * the identity, and every fluent refresh. They now use the configured port (the config file's
 * cdpPort) to find the tab, and the port the tab was listed on (`portForTab`) to read it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { listTabsLight, portForTab, getTabContext, sensorLoopGetters } = vi.hoisted(() => ({
  listTabsLight: vi.fn(),
  portForTab: vi.fn(),
  getTabContext: vi.fn(),
  sensorLoopGetters: [] as Array<() => Array<{ tabId: string; port: number }>>,
}));

vi.mock("../../src/engine/cdp-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/cdp-bridge.js")>();
  return { ...actual, listTabsLight, portForTab, getTabContext };
});
// Keep the real refresh; capture the getter the registry hands the CDP sensor loop, without starting it.
vi.mock("../../src/engine/perception/sensors-cdp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/sensors-cdp.js")>();
  return {
    ...actual,
    startCdpSensorLoop: (getTabs: () => Array<{ tabId: string; port: number }>) => {
      sensorLoopGetters.push(getTabs);
      return () => { /* not started */ };
    },
  };
});
vi.mock("../../src/utils/desktop-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/desktop-config.js")>();
  return { ...actual, getCdpPort: () => 9333 };
});

const registry = await import("../../src/engine/perception/registry.js");

afterEach(() => { registry.__resetForTests(); vi.clearAllMocks(); sensorLoopGetters.length = 0; });

describe("a browser-tab lens reads CDP on the tab's port (internal #254)", () => {
  it("binds the tab on the configured port, records that port, and reads on it everywhere", async () => {
    listTabsLight.mockResolvedValue([{ id: "tab-9", title: "Example", url: "https://example.com/", type: "page" }]);
    getTabContext.mockResolvedValue({ id: "tab-9", url: "https://example.com/", title: "Example", readyState: "complete" });
    const { lensId } = await registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "example.com" } }, maintain: [], guards: [],
    } as never);
    expect(listTabsLight).toHaveBeenCalledWith(9333);
    expect((registry.getLens(lensId)!.boundIdentity as { port: number }).port).toBe(9333);
    // The registration read, readLens and the pre-tool guards all read on the lens's own port, not on
    // whatever the shared tab-port cache says now (gate 2 on #925).
    portForTab.mockReturnValue(9444);
    await registry.readLens(lensId);
    await registry.evaluatePreToolGuards(lensId, "browser_click", {});
    expect(getTabContext.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getTabContext.mock.calls.every((c) => c[1] === 9333)).toBe(true);
    // The sensor loop is handed the same port for the tab.
    expect(sensorLoopGetters.length).toBeGreaterThan(0);
    expect(sensorLoopGetters.at(-1)!()).toEqual([{ tabId: "tab-9", port: 9333 }]);
  });

  it("names the configured port when no tab matches", async () => {
    listTabsLight.mockResolvedValue([]);
    await expect(registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "nowhere" } }, maintain: [], guards: [],
    } as never)).rejects.toThrow(/--remote-debugging-port=9333/);
  });
});
