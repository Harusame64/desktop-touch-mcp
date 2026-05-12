import {
  mouse,
  keyboard as _rawKeyboard,
  screen,
  getWindows,
  getActiveWindow,
  Key,
  Button,
  Point,
  Region,
  Size,
  straightTo,
  up,
  down,
  left,
  right,
} from "@nut-tree-fork/nut-js";

// Zero-delay for maximum responsiveness
mouse.config.autoDelayMs = 0;
_rawKeyboard.config.autoDelayMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard input serialization (issue #255)
// ─────────────────────────────────────────────────────────────────────────────
//
// libnut — the native key-injection backend that @nut-tree-fork/nut-js wraps
// — is not safe for concurrent SendInput invocations. Two awaited
// `keyboard.pressKey(...)` calls can yield between the press and release of
// the same key list, leaving libnut's internal modifier-state tracking in an
// undefined condition that segfaults the Node process and tears down the
// MCP server (issue #255). The race window is wide enough that the natural
// chord pattern `keyboard({press:"alt+i"})` then `keyboard({press:"m"})`
// fired in the same Claude turn hit it reliably.
//
// The lock is applied at the engine layer (not at the keyboard tool entry)
// because `scroll`, `terminal`, and `clipboard` tools all reach into the
// same libnut backend via `keyboard.pressKey` / `releaseKey` / `type`. A
// keyboard-tool-only lock would still crash when the LLM interleaves a
// `keyboard` call with a `scroll` PageDown or a `terminal` Enter. Wrapping
// the engine export catches every current and future caller in one place.
//
// The queue tail tracks the completion *point* of the in-flight call so a
// rejection does not poison the queue: the next caller sees a resolved
// tail regardless of how the prior call ended.
let _inputQueueTail: Promise<unknown> = Promise.resolve();

function withInputLock<T>(fn: () => Promise<T>): Promise<T> {
  // Wait for the current tail, run, advance the tail to my completion.
  // `then(fn, fn)` schedules `fn` whether the prior call resolved or
  // rejected — symmetric so a rejection upstream still drains the queue.
  const myResult = _inputQueueTail.then(fn, fn);
  _inputQueueTail = myResult.then(
    () => undefined,
    () => undefined,
  );
  return myResult;
}

// Wrap pressKey / releaseKey / type with the lock. Other keyboard members
// (config, etc.) pass through unchanged via Object.create + spread so callers
// can still mutate `keyboard.config.autoDelayMs` and read static enums.
type RawKeyboard = typeof _rawKeyboard;
const keyboard: RawKeyboard = Object.assign(Object.create(Object.getPrototypeOf(_rawKeyboard)) as RawKeyboard, _rawKeyboard, {
  pressKey: ((...keys: Parameters<RawKeyboard["pressKey"]>) =>
    withInputLock(() => _rawKeyboard.pressKey(...keys))) as RawKeyboard["pressKey"],
  releaseKey: ((...keys: Parameters<RawKeyboard["releaseKey"]>) =>
    withInputLock(() => _rawKeyboard.releaseKey(...keys))) as RawKeyboard["releaseKey"],
  type: ((...args: Parameters<RawKeyboard["type"]>) =>
    withInputLock(() => _rawKeyboard.type(...args))) as RawKeyboard["type"],
});

// Test-only hook so unit tests can deterministically reset the queue between
// cases. Not part of the public engine API — guarded by underscore prefix.
export function _resetInputQueueForTests(): void {
  _inputQueueTail = Promise.resolve();
}

/**
 * Default mouse movement speed in px/sec.
 * Override permanently via DESKTOP_TOUCH_MOUSE_SPEED env var:
 *   0          → instant (setPosition teleport, no animation)
 *   3000       → default animation
 *   5000       → fast animation
 * Claude CLI can override per-call via the speed parameter on mouse tools.
 */
const _envSpeed = process.env["DESKTOP_TOUCH_MOUSE_SPEED"];
export const DEFAULT_MOUSE_SPEED: number = _envSpeed !== undefined
  ? (parseInt(_envSpeed, 10) >= 0 ? parseInt(_envSpeed, 10) : 3000)
  : 3000;

mouse.config.mouseSpeed = DEFAULT_MOUSE_SPEED > 0 ? DEFAULT_MOUSE_SPEED : 3000;

export {
  mouse,
  keyboard,
  screen,
  getWindows,
  getActiveWindow,
  Key,
  Button,
  Point,
  Region,
  Size,
  straightTo,
  up,
  down,
  left,
  right,
};
