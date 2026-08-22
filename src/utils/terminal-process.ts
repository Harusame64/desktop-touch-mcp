/**
 * terminal-process.ts — is this image name a terminal / console host?
 *
 * A leaf module on purpose. `TERMINAL_PROCESS_RE` used to live in
 * `src/tools/terminal.ts`, but ADR-035 Phase C-0's topology logger sits in
 * `src/tools/_resolve-log.ts`, which `terminal.ts` imports — reaching back the
 * other way would close a cycle (the same reason `isAutoGuardEnabled` was split
 * out into `src/utils/auto-guard-env.ts` during Phase 1). Nothing here imports
 * anything.
 */

/**
 * Image names (with or without `.exe`) that identify a terminal emulator or a
 * shell hosted in one. Moved here verbatim from `terminal.ts` — the pattern is
 * byte-identical, so every existing caller keeps its exact behaviour.
 */
export const TERMINAL_PROCESS_RE =
  /^(WindowsTerminal|conhost|pwsh|powershell|cmd|bash|wsl|alacritty|wezterm|mintty)(\.exe)?$/i;

/**
 * The console hosts that own a console window, as opposed to the shells that
 * run inside one. `conhost.exe` is the classic host and is already in
 * `TERMINAL_PROCESS_RE`; `OpenConsole.exe` is the modern host Windows Terminal
 * ships and is NOT (ADR-035 plan Round 25 W-1).
 */
const CONSOLE_HOST_RE = /^(conhost|OpenConsole)(\.exe)?$/i;

/**
 * Terminal hosts the base pattern misses. `OpenConsole.exe` is the modern
 * console host Windows Terminal ships (ADR-035 plan Round 25 W-1). ConEmu is a
 * third-party host this project already documents as accepting the WM_CHAR
 * typing route, and both `findTerminalWindow` and `desktop_act`'s terminal
 * executor can select it by title — so a write can land in one, and leaving it
 * out of the measurement drops those destinations entirely (Codex Round 6).
 */
const EXTRA_TERMINAL_RE = /^(OpenConsole|ConEmu|ConEmu64|ConEmuC|ConEmuC64)(\.exe)?$/i;

/**
 * ADR-035 Phase C-0's terminal-class predicate: `TERMINAL_PROCESS_RE` widened
 * with the hosts in {@link EXTRA_TERMINAL_RE}.
 *
 * **Temporary by design.** Phase 2 folds those into `TERMINAL_PROCESS_RE`
 * itself (plan §3 / Round 25 W-1); when it does, this function collapses to a
 * direct `TERMINAL_PROCESS_RE.test` and this comment goes away. It exists
 * separately only so that C-0 — which must not change any behaviour — can
 * measure the wider class without widening what `terminal.ts` treats as a
 * terminal today.
 */
export function isTerminalClassProcessName(processName: string): boolean {
  return TERMINAL_PROCESS_RE.test(processName) || EXTRA_TERMINAL_RE.test(processName);
}

/** True for the two processes that HOST a console window (`conhost` / `OpenConsole`). */
export function isConsoleHostProcessName(processName: string): boolean {
  return CONSOLE_HOST_RE.test(processName);
}
