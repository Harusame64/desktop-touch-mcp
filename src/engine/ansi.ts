/**
 * ansi.ts — strip ANSI escape sequences from terminal output.
 *
 * Covers SGR (colors), cursor movement, OSC, and DEC private modes commonly
 * emitted by shells, ls --color, prompts, and progress bars.
 */

// CSI: ESC [ ... finalByte (0x40-0x7E)
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... BEL or ESC \
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DEC / two-byte sequences: ESC ( | ) | * | + | letter
const TWO_BYTE_RE = /\x1b[()*+][0-9A-Za-z]/g;
// Single-char ESC (e.g. ESC = , ESC > , ESC c)
const SINGLE_RE = /\x1b[=>cDEHM78]/g;
// Bare control chars except CR/LF/TAB
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(TWO_BYTE_RE, "")
    .replace(SINGLE_RE, "")
    .replace(CTRL_RE, "");
}

/** Tail the last N lines of a (possibly very long) string. */
export function tailLines(text: string, n: number): string {
  if (n <= 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}
