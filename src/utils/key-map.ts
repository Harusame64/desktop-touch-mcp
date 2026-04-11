import { Key } from "@nut-tree-fork/nut-js";

/** Map from lower-case key name string → nut-js Key enum value */
export const KEY_MAP: Record<string, Key> = {
  // Modifiers
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  lctrl: Key.LeftControl,
  rctrl: Key.RightControl,
  alt: Key.LeftAlt,
  lalt: Key.LeftAlt,
  ralt: Key.RightAlt,
  shift: Key.LeftShift,
  lshift: Key.LeftShift,
  rshift: Key.RightShift,
  win: Key.LeftSuper,
  meta: Key.LeftSuper,
  super: Key.LeftSuper,

  // Special keys
  enter: Key.Return,
  return: Key.Return,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  del: Key.Delete,
  insert: Key.Insert,
  ins: Key.Insert,
  escape: Key.Escape,
  esc: Key.Escape,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pgup: Key.PageUp,
  pagedown: Key.PageDown,
  pgdn: Key.PageDown,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  printscreen: Key.Print,
  pause: Key.Pause,
  capslock: Key.CapsLock,
  numlock: Key.NumLock,
  scrolllock: Key.ScrollLock,

  // Function keys
  f1: Key.F1,
  f2: Key.F2,
  f3: Key.F3,
  f4: Key.F4,
  f5: Key.F5,
  f6: Key.F6,
  f7: Key.F7,
  f8: Key.F8,
  f9: Key.F9,
  f10: Key.F10,
  f11: Key.F11,
  f12: Key.F12,

  // Letters
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E,
  f: Key.F, g: Key.G, h: Key.H, i: Key.I, j: Key.J,
  k: Key.K, l: Key.L, m: Key.M, n: Key.N, o: Key.O,
  p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T,
  u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y,
  z: Key.Z,

  // Digits
  "0": Key.Num0, "1": Key.Num1, "2": Key.Num2,
  "3": Key.Num3, "4": Key.Num4, "5": Key.Num5,
  "6": Key.Num6, "7": Key.Num7, "8": Key.Num8,
  "9": Key.Num9,

  // Numpad
  num0: Key.NumPad0, num1: Key.NumPad1, num2: Key.NumPad2,
  num3: Key.NumPad3, num4: Key.NumPad4, num5: Key.NumPad5,
  num6: Key.NumPad6, num7: Key.NumPad7, num8: Key.NumPad8,
  num9: Key.NumPad9,
  nummul: Key.Multiply, numadd: Key.Add,
  numsub: Key.Subtract, numdiv: Key.Divide,
  numdec: Key.Decimal,
};

/** Parse a combo string like "ctrl+shift+s" into nut-js Key array */
export function parseKeys(combo: string): Key[] {
  const parts = combo.toLowerCase().split("+").map((s) => s.trim());
  const keys: Key[] = [];
  for (const part of parts) {
    const key = KEY_MAP[part];
    if (key === undefined) {
      throw new Error(`Unknown key: "${part}" in combo "${combo}"`);
    }
    keys.push(key);
  }
  return keys;
}
