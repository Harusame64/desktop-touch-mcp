import {
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
} from "@nut-tree-fork/nut-js";

// Zero-delay for maximum responsiveness
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

/**
 * Default mouse movement speed in px/sec.
 * Override permanently via DESKTOP_TOUCH_MOUSE_SPEED env var:
 *   0          → instant (setPosition teleport, no animation)
 *   1500       → default gentle animation
 *   5000       → fast animation
 * Claude CLI can override per-call via the speed parameter on mouse tools.
 */
const _envSpeed = process.env["DESKTOP_TOUCH_MOUSE_SPEED"];
export const DEFAULT_MOUSE_SPEED: number = _envSpeed !== undefined
  ? (parseInt(_envSpeed, 10) >= 0 ? parseInt(_envSpeed, 10) : 1500)
  : 1500;

mouse.config.mouseSpeed = DEFAULT_MOUSE_SPEED > 0 ? DEFAULT_MOUSE_SPEED : 1500;

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
