// What the built-in 3DS player (web/lib/ctrplayer.mjs) sends to its host as one INPUT: the joypad bits and the Circle
// Pad. Pure, so the half tilt can be tested without a game.
//
// The Circle Pad's way to the game: the page sends lx / ly as int16 (-0x7fff…0x7fff, native/ctr-host/ctrhost.c
// input.lx / ly), Azahar's libretro core divides by INT16_MAX (citra_libretro/input/input_factory.cpp LibRetroAxis – no
// dead zone on the Circle Pad, the core option's dead zone is only for the mouse) and the HID service multiplies by its
// calibrated limit 0x9A = 154 (core/hle/service/hid/hid.cpp MAX_CIRCLEPAD_POS); past a radius of 40 the game also sees
// the Circle Pad's direction bits. Keys only know "pressed": full tilt. Some games walk slower on a light tilt – Omega
// Ruby / Alpha Sapphire sneak (DexNav) only below about half – so a held key caps the Circle Pad at CTR_SNEAK_TILT.

/** libretro joypad bits (the numbers EmulatorJS uses, lib/controls.mjs BUTTONS.ejs) – plus ZL 12, ZR 13. */
export const CTR_BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, zl: 12, zr: 13 };
const DIRS = (1 << CTR_BIT.up) | (1 << CTR_BIT.down) | (1 << CTR_BIT.left) | (1 << CTR_BIT.right);
const FULL = 0x7fff;

/**
 * How far the Circle Pad goes while the half-tilt key is held, 0…1 of full tilt. 0.4 = 62 of 154 in the game: below the
 * point where Omega Ruby / Alpha Sapphire walk normally (about half), clearly above where the character doesn't move at
 * all (about a third, and the HID's own direction threshold of 40 ≈ 26 %) – the window players of other emulators settle
 * on (Citra's "circle pad modifier" at 40 %). On a diagonal the whole tilt is capped, not each axis (0.4 on both axes
 * would be 0.57 – a normal walk again).
 */
export const CTR_SNEAK_TILT = 0.4;

const dirStick = (bits) => [
  (bits & (1 << CTR_BIT.right) ? FULL : 0) - (bits & (1 << CTR_BIT.left) ? FULL : 0),
  (bits & (1 << CTR_BIT.down) ? FULL : 0) - (bits & (1 << CTR_BIT.up) ? FULL : 0),
];

/** (x, y) with its length capped at `max` (int16 units), rounded – a light tilt below it stays as it is. */
export function capStick(x, y, max) {
  const len = Math.hypot(x, y);
  if (len <= max || !len) return [Math.round(x), Math.round(y)];
  return [Math.round((x / len) * max), Math.round((y / len) * max)];
}

/**
 * One INPUT: { buttons, lx, ly }. keys: the keyboard's joypad bits, pad: the controller's; lx / ly: its left stick,
 * stickX / stickY: what a test set (int16 each). Sun / Moon walk with the Circle Pad only (the D-pad scrolls menus), so
 * the keyboard's direction keys move it too – full tilt – unless a stick does.
 * slow (the half-tilt key held, keyboard or controller): the Circle Pad goes at most CTR_SNEAK_TILT, and the direction
 * buttons move only the Circle Pad – not the D-pad as well (Omega Ruby / Alpha Sapphire never sneak while the D-pad is
 * held) – so a controller's D-pad sneaks too. A stick that is tilted keeps the lead.
 */
export function ctrInput({ keys = 0, pad = 0, lx = 0, ly = 0, stickX = 0, stickY = 0, slow = false } = {}) {
  const buttons = (keys | pad) >>> 0;
  if (!slow) {
    const [kx, ky] = dirStick(keys);
    return { buttons, lx: lx || stickX || kx, ly: ly || stickY || ky };
  }
  const [x, y] = lx || ly ? [lx, ly] : stickX || stickY ? [stickX, stickY] : dirStick(keys | pad);
  const [sx, sy] = capStick(x, y, CTR_SNEAK_TILT * FULL);
  return { buttons: (buttons & ~DIRS) >>> 0, lx: sx, ly: sy };
}
