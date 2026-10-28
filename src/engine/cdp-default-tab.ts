/**
 * Internal #308 — which CDP target a call without tabId works on.
 *
 * No imports, so the perception lens (pure functions) can use it without loading the CDP module.
 */

/**
 * Browser-internal schemes. A page target on one of these is the browser's own UI, not a page the
 * user opened: Edge listed `edge://sync-confirmation-dialog` (a sign-in modal) ahead of the page,
 * and a call without tabId read it (win2, 2026-10-24). `about:` is not here: about:blank is a page.
 */
const INTERNAL_PAGE_SCHEME =
  /^(chrome|edge|devtools|chrome-untrusted|chrome-search|chrome-error|chrome-native|brave|opera|vivaldi):/i;

/**
 * The tab a call without tabId works on: the first page target that is not browser-internal, else
 * the first page target (a browser showing only its New Tab page), else undefined. A target with no
 * `type` counts as a page (a listing that does not carry it).
 */
export function defaultPageTab<T extends { type?: string; url?: string }>(tabs: readonly T[]): T | undefined {
  const pages = tabs.filter((t) => t.type === undefined || t.type === "page");
  return pages.find((t) => !INTERNAL_PAGE_SCHEME.test(t.url ?? "")) ?? pages[0];
}
