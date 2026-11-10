/**
 * internal #254 — the perception registry's browser-tab lenses read CDP at a fixed 9222: the tab list,
 * the identity, and every fluent refresh. They now use the configured port (the config file's
 * cdpPort) to find the tab, and the port the tab was listed on (`portForTab`) to read it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { listTabsLight, portForTab, getTabContext } = vi.hoisted(() => ({
  listTabsLight: vi.fn(),
  portForTab: vi.fn(),
  getTabContext: vi.fn(),
}));

vi.mock("../../src/engine/cdp-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/cdp-bridge.js")>();
  return { ...actual, listTabsLight, portForTab, getTabContext };
});
vi.mock("../../src/utils/desktop-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/desktop-config.js")>();
  return { ...actual, getCdpPort: () => 9333 };
});

const registry = await import("../../src/engine/perception/registry.js");

afterEach(() => { registry.__resetForTests(); });

describe("a browser-tab lens reads CDP on the tab's port (internal #254)", () => {
  it("lists tabs on the configured port and reads the tab on the port it was listed on", async () => {
    listTabsLight.mockResolvedValue([{ id: "tab-9", title: "Example", url: "https://example.com/", type: "page" }]);
    portForTab.mockReturnValue(9444);
    getTabContext.mockResolvedValue({ id: "tab-9", url: "https://example.com/", title: "Example", readyState: "complete" });
    await registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "example.com" } }, maintain: [], guards: [],
    } as never);
    expect(listTabsLight).toHaveBeenCalledWith(9333);
    expect(portForTab).toHaveBeenCalledWith("tab-9");
    expect(getTabContext.mock.calls.every((c) => c[1] === 9444)).toBe(true);
    expect(getTabContext).toHaveBeenCalled();
  });

  it("names the configured port when no tab matches", async () => {
    listTabsLight.mockResolvedValue([]);
    await expect(registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "nowhere" } }, maintain: [], guards: [],
    } as never)).rejects.toThrow(/--remote-debugging-port=9333/);
  });
});
