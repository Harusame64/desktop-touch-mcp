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
 * failure road, where `_errors.ts` sits — a module reached by every refusal, on
 * every platform (gate 2, 2026-09-13, third and fourth rounds).
 *
 * **The property is "that road's import closure stays free of the native chain", and
 * it is asserted, not described here**:
 * `tests/unit/the-advice-road-does-not-import-the-native-chain.test.ts` walks it. This
 * paragraph used to say the road imported "two dependency-free files"; wiring the
 * resolver in made that three, and the new one is not dependency-free — it pulls
 * `desktop-activation.ts` and this switch (gate 2, sixth round). **A count in prose
 * goes stale the first time the graph grows**, so there is none here, and the walk was
 * re-rooted at `_errors.ts` in the same round because it had been rooted one module
 * downstream of the road this sentence names.
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
