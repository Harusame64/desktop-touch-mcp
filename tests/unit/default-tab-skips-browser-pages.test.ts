/**
 * Internal #308 — a browser_* call without tabId works on the first page the user opened, not on
 * a page target that is the browser's own UI.
 *
 * win2 (2026-10-24): Edge signed in with the Windows account listed
 * `edge://sync-confirmation-dialog` ahead of the page, and browser_click without tabId read it and
 * answered ElementNotFound for a selector that was on the page.
 */
import { describe, expect, it } from "vitest";
import { defaultPageTab } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserTabBindingFromTabs } from "../../src/engine/perception/lens.js";
import type { LensSpec } from "../../src/engine/perception/types.js";

const tab = (id: string, url: string, type = "page") => ({ id, url, type, title: id });

describe("internal #308: defaultPageTab", () => {
  it("skips an edge:// page target listed ahead of the page", () => {
    const tabs = [tab("dlg", "edge://sync-confirmation-dialog/"), tab("pg", "https://example.com/")];
    expect(defaultPageTab(tabs)?.id).toBe("pg");
  });

  it.each([
    "chrome://newtab/",
    "edge://settings/",
    "devtools://devtools/bundled/inspector.html",
    "chrome-untrusted://print/",
    "chrome-search://local-ntp/",
    "CHROME://version/",
  ])("skips %s when an ordinary page exists", (url) => {
    expect(defaultPageTab([tab("in", url), tab("pg", "https://example.com/")])?.id).toBe("pg");
  });

  it("keeps about:blank and file: pages as pages", () => {
    expect(defaultPageTab([tab("a", "about:blank"), tab("b", "https://example.com/")])?.id).toBe("a");
    expect(defaultPageTab([tab("f", "file:///C:/x.html"), tab("b", "https://example.com/")])?.id).toBe("f");
  });

  it("falls back to the first page target when every page is the browser's own (a New Tab only)", () => {
    expect(defaultPageTab([tab("ntp", "edge://newtab/"), tab("set", "edge://settings/")])?.id).toBe("ntp");
  });

  it("ignores targets that are not pages", () => {
    const tabs = [tab("sw", "https://example.com/sw.js", "service_worker"), tab("pg", "https://example.com/")];
    expect(defaultPageTab(tabs)?.id).toBe("pg");
    expect(defaultPageTab([tab("sw", "https://example.com/sw.js", "service_worker")])).toBeUndefined();
  });
});

// codex on #871: the perception guard of a browser_* call without tabId bound to the first listed
// target, so it read the dialog while the call worked on the page.
describe("internal #308: the guard's browserTab lens picks the same tab", () => {
  const spec = (match: { urlIncludes?: string; titleIncludes?: string }) =>
    ({ name: "__auto__", target: { kind: "browserTab", match } }) as unknown as LensSpec;
  const tabs = [
    tab("sw", "https://example.com/sw.js", "service_worker"),
    tab("dlg", "edge://sync-confirmation-dialog/"),
    tab("pg", "https://example.com/"),
  ];

  it("with nothing to match on, binds the first page that is not the browser's own", () => {
    expect(resolveBrowserTabBindingFromTabs(spec({}), tabs)?.hwnd).toBe("pg");
  });

  it("an explicit match still wins, even on a browser page", () => {
    expect(resolveBrowserTabBindingFromTabs(spec({ urlIncludes: "sync-confirmation" }), tabs)?.hwnd).toBe("dlg");
  });
});
