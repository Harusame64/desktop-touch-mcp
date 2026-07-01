import {
  mouse,
  keyboard as _rawKeyboard,
  screen,
  getWindows as _rawGetWindows,
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
import { hasExcludedPids } from "./tool-exclusion.js";
import { isExcludedWindowHandle } from "./win32.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// Atomic-sequence engine API (issue #257)
// ─────────────────────────────────────────────────────────────────────────────
//
// `keyboard(action='sequence')` needs to execute N steps without letting any
// other keyboard caller splice between a step's press and release. The
// per-call locking applied to `keyboard.pressKey/releaseKey` above is
// insufficient: it only protects each call individually, so a concurrent
// caller can still grab the lock between this sequence's step boundaries
// (and especially during the `holdMs` window of a held step), producing
// a phantom chord against the wrong target.
//
// The fix is an *outer* lock that the sequence handler takes around the
// whole step loop. Inside that lock the handler MUST NOT call the wrapped
// `keyboard.pressKey/releaseKey` (they would deadlock on the same
// `_inputQueueTail` chain). The `rawKeyboard` primitives below bypass the
// wrapper for use *inside* `withKeyboardLock(...)` only.

/**
 * Take the keyboard input lock for an arbitrary async block.
 *
 * Used by `keyboard(action='sequence')` (issue #257) to wrap the entire
 * step loop in one lock acquisition, so concurrent `keyboard` / `scroll` /
 * `terminal` callers cannot splice between steps. The block MUST use the
 * `rawKeyboard.*` primitives below — calling the wrapped `keyboard.pressKey`
 * here would deadlock on the same `_inputQueueTail` chain.
 *
 * Failure-safe: same `.then(fn, fn)` pattern as `withInputLock`, so an
 * exception inside `fn` does not poison the queue for subsequent callers.
 */
export function withKeyboardLock<T>(fn: () => Promise<T>): Promise<T> {
  return withInputLock(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// R3 tool-exclusion — filtered window enumeration (ADR-014 v2 R3 L0)
// ─────────────────────────────────────────────────────────────────────────────
//
// `getWindows()` is nut-js's own top-level-window enumerator — a SEPARATE path from win32's
// `enumWindowsInZOrder()`, feeding screenshot(mode:'background') title-match, the window list,
// workspace, and macro. While a Key Locker is alive its windows must be dropped here too, else a
// caller who knows the fixed title ('desktop-touch key locker') could capture the secure dialog
// through this enumerator despite the win32-side filter (Codex R1 P1-B). Gated on a non-empty
// exclusion set → the raw nut-js result passes straight through when no locker is alive.
type NutWindow = Awaited<ReturnType<typeof _rawGetWindows>>[number];

export async function getWindows(): Promise<NutWindow[]> {
  const wins = await _rawGetWindows();
  if (!hasExcludedPids()) return wins; // zero overhead in the common (no-locker) case
  return wins.filter(
    (w) => !isExcludedWindowHandle((w as unknown as { windowHandle: unknown }).windowHandle),
  );
}

/**
 * Raw libnut press / release primitives.
 *
 * **CONTRACT**: MUST be called only inside `withKeyboardLock(...)`.
 * Calling outside loses serialization (the libnut SendInput race that
 * issue #255 was created to fix). Calling the wrapped
 * `keyboard.pressKey / releaseKey` inside `withKeyboardLock` deadlocks
 * on the same `_inputQueueTail` chain.
 *
 * `releaseDanglingModifiers` (if present elsewhere) uses the *wrapped*
 * variant, so call it OUTSIDE the lock (e.g. from a sequence handler's
 * `catch` block that sits outside `withKeyboardLock`).
 */
// Note: libnut's pressKey/releaseKey return Promise<KeyboardClass> (fluent
// chainable). All known callers in the sequence handler `await` and discard
// the return, so collapse it to Promise<void> at the boundary — keeps the
// type discipline tight without forcing every caller to `await ... .then(()
// => undefined)` themselves (Opus PR #270 P3-4).
export const rawKeyboard = {
  pressKeyDown: (...keys: Key[]): Promise<void> =>
    _rawKeyboard.pressKey(...keys).then(() => undefined),
  pressKeyUp: (...keys: Key[]): Promise<void> =>
    _rawKeyboard.releaseKey(...keys).then(() => undefined),
};

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
// withKeyboardLock / rawKeyboard are exported at their declaration above
// (named `export function` / `export const`), so they do not need to be
// listed again in this re-export block.
