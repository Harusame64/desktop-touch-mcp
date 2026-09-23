import { readWindowIdentityFields, type WindowIdentity } from "../engine/aim.js";
import { getWindowClassName, getWindowIdentity, getWindowTitleW } from "../engine/win32.js";

/**
 * The identity of the window a handle names NOW, read the way the executor reads it. One place, used
 * by the modal check (`productionFindBlockingWindow`) and the stale re-read (`productionRereadStale`),
 * so the two cannot compare against different readings of the same window.
 */
export function productionWindowIdentity(hwnd: bigint): WindowIdentity | undefined {
  return readWindowIdentityFields(hwnd, { identity: getWindowIdentity, className: getWindowClassName, title: getWindowTitleW });
}
