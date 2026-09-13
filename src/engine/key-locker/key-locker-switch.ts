/**
 * The key locker's kill switch, and nothing else.
 *
 * **A LEAF ON PURPOSE: this file imports nothing.** The predicate is one comparison,
 * but it used to live in `key-locker-manager.ts`, which statically imports
 * `key-locker-host.js` (`node:child_process`, `node:net`), the session tracker, the
 * SSH watch and `engine/win32.ts` — and `win32.ts` calls
 * `win32SetProcessDpiAwareness(2)` while it evaluates. `index.ts` says the repo
 * deliberately avoids static native imports because they throw off Windows.
 *
 * That cost nothing while only the locker asked the question. It stops being free
 * the moment the ADVICE path asks it: `_advice-capability.ts` resolves
 * `credential_store` through this switch, and that resolver is wired into the
 * failure road, where `_errors.ts` sits — a module that today imports two
 * dependency-free files and is reached by every refusal, on every platform
 * (gate 2, 2026-09-13, third and fourth rounds).
 *
 * `desktop-activation.ts` is the same shape for the other switch, and it was already
 * a leaf. **There is still ONE reader of this switch** — `key-locker-manager.ts`
 * re-exports this function rather than re-implementing it, so the property the
 * resolver's comment relies on is unchanged.
 *
 * Exact-match semantics, like the v2 flag: only the literal string `"1"` counts.
 * `"true"`, `"yes"`, `"0"` and `" "` all read as unset.
 */
export function keyLockerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER === "1";
}
