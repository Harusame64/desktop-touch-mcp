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
