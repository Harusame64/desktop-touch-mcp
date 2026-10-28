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
const SIGNIN_DIALOG =
  /^(chrome|edge):\/\/(sync-confirmation|signin-email-confirmation|signin-error|signin-reauth|profile-customization|signin-dice-web-intercept|managed-user-profile-notice)/i;

/**
 * The tab a call without tabId works on: the first page target (the most recently used) that is not
 * a sign-in or sync dialog, else the first page target, else undefined. Background pages, service
 * workers, browser UI and iframes are never picked. A target with no `type` counts as a page (a
 * listing that does not carry it).
 */
export function defaultPageTab<T extends { type?: string; url?: string }>(tabs: readonly T[]): T | undefined {
  const pages = tabs.filter((t) => t.type === undefined || t.type === "page");
  return pages.find((t) => !SIGNIN_DIALOG.test(t.url ?? "")) ?? pages[0];
}
