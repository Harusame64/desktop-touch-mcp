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
mouse.config.mouseSpeed = 1500;
keyboard.config.autoDelayMs = 0;

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
