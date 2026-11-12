/**
 * Internal #308 — which CDP target a call without tabId works on.
 *
 * No imports, so the perception lens (pure functions) can use it without loading the CDP module.
 */

/**
 * Chromium's sign-in and sync dialogs. They are listed as `page` targets but are not tabs: Edge
 * listed `edge://sync-confirmation-dialog` (the sync modal) ahead of the page, and a call without
 * tabId read it (win2, 2026-10-24). Matched by host prefix on chrome:// or edge://.
 *
 * Not every chrome:// or edge:// page: a New Tab or a settings tab the user is looking at is a tab,
 * listed first because the list is most-recently-used first, and has the same type, browser
 * context, window and bounds as the page behind it (win2, 2026-10-28, Edge 156 and Chrome 156).
 * Only the URL tells them apart, so skipping them would act on a background page instead.
 */
const SIGNIN_DIALOG = new RegExp(
  "^(chrome|edge)://(" +
    [
      "sync-confirmation", "signin-email-confirmation", "signin-error", "signin-reauth",
      "profile-customization", "signin-dice-web-intercept", "managed-user-profile-notice",
      "signout-confirmation", "history-sync-optin", "batch-upload", "privacy-sandbox-dialog",
      "search-engine-choice", "profile-picker", "intro",
    ].join("|") +
    ")",
  "i",
);

/**
 * internal #398 — DevTools' own front end. With DevTools open on a tab it is listed as a `page` target
 * (`devtools://devtools/...`), most recently used, so a call without tabId worked on DevTools instead of
 * the page (win2, PR #967 round: browser_click answered "Element not found"). It is not a tab either.
 */
const DEVTOOLS_FRONTEND = /^(chrome-)?devtools:\/\//i;

/**
 * A page target that is the browser's own UI, not a tab: a sign-in or sync dialog, or DevTools' front
 * end. One place, so the default tab and the tab listings agree on what is not a tab (gate 2 on #968).
 */
export function isBrowserUiPage(url: string | undefined): boolean {
  return SIGNIN_DIALOG.test(url ?? "") || DEVTOOLS_FRONTEND.test(url ?? "");
}

/** internal #398 — DevTools' front end, as the tab listings mark it. */
export function isDevToolsFrontEnd(url: string | undefined): boolean {
  return DEVTOOLS_FRONTEND.test(url ?? "");
}

/**
 * The tab a call without tabId works on: the first page target (the most recently used) that is not
 * the browser's own UI (a sign-in or sync dialog, DevTools' front end), else the first page target, else
 * undefined. With DevTools open that is the next most recently used page, which is usually, not always,
 * the one DevTools inspects. It never returns a target
 * that is not a page (a background page, service worker, browser UI or iframe); a caller that has
 * to act somewhere anyway falls back on its own (resolveTab and the guard lens take tabs[0]).
 * `type` is required so a listing that dropped it fails to compile instead of counting as pages.
 */
export function defaultPageTab<T extends { type: string; url?: string }>(tabs: readonly T[]): T | undefined {
  const pages = tabs.filter((t) => t.type === "page");
  return pages.find((t) => !isBrowserUiPage(t.url)) ?? pages[0];
}
