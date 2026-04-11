/**
 * Blocked key combinations that could escape the desktop sandbox
 * by opening shell execution vectors.
 *
 * Keys are normalized as sorted lowercase parts joined by "+".
 * e.g. "Win+R" → "r+win", "win+x" → "win+x"
 */
const BLOCKED_KEY_COMBOS = new Set([
  "r+win",    // Win+R → Run dialog → arbitrary command execution
  "win+x",    // Win+X → Power User menu → admin tools
  "s+win",    // Win+S → Windows Search → can launch apps
  "l+win",    // Win+L → Lock screen
]);

export class BlockedKeyComboError extends Error {
  constructor(combo: string) {
    super(
      `Blocked: key combination "${combo}" is not allowed because it could open a shell ` +
      `or execute arbitrary commands. Use workspace_launch to open applications instead.`
    );
    this.name = "BlockedKeyComboError";
  }
}

/**
 * Normalize a key combo string to a canonical sortable form.
 * "Win+R" → "r+win", "META+r" → "r+win"
 */
function normalizeCombo(combo: string): string {
  return combo
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .map((s) => (s === "meta" || s === "super" ? "win" : s))
    .sort()
    .join("+");
}

/**
 * Throw BlockedKeyComboError if the combo is on the blocklist.
 */
export function assertKeyComboSafe(combo: string): void {
  const normalized = normalizeCombo(combo);
  if (BLOCKED_KEY_COMBOS.has(normalized)) {
    throw new BlockedKeyComboError(combo);
  }
}
