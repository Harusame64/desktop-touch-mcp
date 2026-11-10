/**
 * internal #283 — the one rule for a value the key locker writes to the diagnostic log from something it did
 * not choose (an error's name or code, a fill_aborted code): an identifier as it is, anything else `other`.
 * A message, a path or a secret is never an identifier.
 */
export function safeIdentifier(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "other";
}
