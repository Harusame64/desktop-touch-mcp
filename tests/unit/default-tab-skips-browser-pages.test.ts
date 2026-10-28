/**
 * Internal #308 — a browser_* call without tabId works on the most recently used tab, not on a
 * sign-in or sync dialog listed as a page, and never on a target that is not a page.
 *
 * win2 (2026-10-24): Edge signed in with the Windows account listed
 * `edge://sync-confirmation-dialog` ahead of the page, and browser_click without tabId read it and
 * answered ElementNotFound for a selector that was on the page.
 * win2 (2026-10-28): a New Tab or chrome://settings in front is listed first and is
 * indistinguishable from the page behind it except by URL, so it stays the target.
 */
import { describe, expect, it } from "vitest";
import { defaultPageTab } from "../../src/engine/cdp-default-tab.js";
import { resolveBrowserTabBindingFromTabs } from "../../src/engine/perception/lens.js";
import type { LensSpec } from "../../src/engine/perception/types.js";

const tab = (id: string, url: string, type = "page") => ({ id, url, type, title: id });
const page = tab("pg", "https://example.com/");

describe("internal #308: defaultPageTab", () => {
  it("skips Edge's sync dialog listed ahead of the page", () => {
    expect(defaultPageTab([tab("dlg", "edge://sync-confirmation-dialog/"), page])?.id).toBe("pg");
  });

  it.each([
    "chrome://sync-confirmation/",
    "chrome://signin-email-confirmation/",
    "chrome://signin-error/",
    "chrome://signin-reauth/",
    "chrome://profile-customization/",
    "chrome://signin-dice-web-intercept/",
    "chrome://managed-user-profile-notice/",
    "chrome://signout-confirmation/",
    "chrome://history-sync-optin/",
    "chrome://batch-upload/",
    "chrome://privacy-sandbox-dialog/?type=notice",
    "chrome://search-engine-choice/",
    "chrome://profile-picker/",
    "chrome://intro/",
    "EDGE://sync-confirmation-dialog/",
  ])("skips the sign-in dialog %s when a page exists", (url) => {
    expect(defaultPageTab([tab("dlg", url), page])?.id).toBe("pg");
  });

  it.each(["edge://newtab/", "chrome://newtab/", "chrome://settings/", "edge://history/", "about:blank", "file:///C:/x.html"])(
    "keeps %s in front as the target (most recently used first)",
    (url) => {
      expect(defaultPageTab([tab("front", url), page])?.id).toBe("front");
    },
  );

  it("never picks a target that is not a page (win2's S1 list: background pages, browser UI)", () => {
    const tabs = [
      tab("omni", "chrome://omnibox-popup.top-chrome/", "browser_ui"),
      tab("bg", "chrome-extension://abc/background.html", "background_page"),
      tab("sw", "https://example.com/sw.js", "service_worker"),
      tab("ifr", "chrome-untrusted://new-tab-page/one-google-bar", "iframe"),
      page,
    ];
    expect(defaultPageTab(tabs)?.id).toBe("pg");
    expect(defaultPageTab([tab("sw", "https://example.com/sw.js", "service_worker")])).toBeUndefined();
  });

  it("falls back to the dialog when it is the only page", () => {
    expect(defaultPageTab([tab("dlg", "edge://sync-confirmation-dialog/")])?.id).toBe("dlg");
  });
});

// codex on #871: the perception guard of a browser_* call without tabId bound to the first listed
// target of any type, so it could check another target than the one the call worked on.
describe("internal #308: the guard's browserTab lens picks the same tab", () => {
  const spec = (match: { urlIncludes?: string; titleIncludes?: string }) =>
    ({ name: "__auto__", target: { kind: "browserTab", match } }) as unknown as LensSpec;
  const tabs = [
    tab("sw", "https://example.com/sw.js", "service_worker"),
    tab("dlg", "edge://sync-confirmation-dialog/"),
    page,
  ];

  it("with nothing to match on, binds the tab defaultPageTab picks", () => {
    expect(resolveBrowserTabBindingFromTabs(spec({}), tabs)?.hwnd).toBe("pg");
  });

  it("a tabId narrowed to a target that is not a page still binds (review on #871: a webview or worker was blocked)", () => {
    expect(resolveBrowserTabBindingFromTabs(spec({}), [tab("wv", "https://example.com/", "webview")])?.hwnd).toBe("wv");
  });

  it("with no page at all, binds tabs[0] like resolveTab, so the guard and the call agree", () => {
    const only = [tab("bg", "chrome-extension://abc/background.html", "background_page")];
    expect(resolveBrowserTabBindingFromTabs(spec({}), only)?.hwnd).toBe("bg");
  });

  it("an explicit match still wins, even on the dialog", () => {
    expect(resolveBrowserTabBindingFromTabs(spec({ urlIncludes: "sync-confirmation" }), tabs)?.hwnd).toBe("dlg");
  });
});
