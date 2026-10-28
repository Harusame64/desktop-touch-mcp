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
 * The tab a call without tabId works on: the first page target (the most recently used) that is not
 * a sign-in or sync dialog, else the first page target, else undefined. It never returns a target
 * that is not a page (a background page, service worker, browser UI or iframe); a caller that has
 * to act somewhere anyway falls back on its own (resolveTab and the guard lens take tabs[0]).
 * `type` is required so a listing that dropped it fails to compile instead of counting as pages.
 */
export function defaultPageTab<T extends { type: string; url?: string }>(tabs: readonly T[]): T | undefined {
  const pages = tabs.filter((t) => t.type === "page");
  return pages.find((t) => !SIGNIN_DIALOG.test(t.url ?? "")) ?? pages[0];
}
