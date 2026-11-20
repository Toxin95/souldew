// Screen layouts of the built-in 3DS player (web/lib/ctrplayer.mjs). Azahar's libretro core always renders its default
// layout – the top screen (400×240) above the bottom one (320×240, centred: x 40…360), 400×480 at 1×, n times that at
// the resolution factor n – and the page arranges the two screens from that picture. Pure, so the touch mapping can be
// tested without a GPU.

/** The layouts, in the order the play view offers them. */
export const CTR_LAYOUTS = ['tb', 'lr', 'large', 'bt', 'top'];

// the screens in the core's picture, in 1× units
const TOP = { x: 0, y: 0, w: 400, h: 240 };
const BOTTOM = { x: 40, y: 240, w: 320, h: 240 };

// each layout: its size and where the screens go, in 1× units (the bottom screen is the touch screen)
const LAYOUTS = {
  tb: { w: 400, h: 480, top: { x: 0, y: 0, w: 400, h: 240 }, bottom: { x: 40, y: 240, w: 320, h: 240 } }, // top above bottom
  bt: { w: 400, h: 480, top: { x: 0, y: 240, w: 400, h: 240 }, bottom: { x: 40, y: 0, w: 320, h: 240 } }, // swapped
  lr: { w: 720, h: 240, top: { x: 0, y: 0, w: 400, h: 240 }, bottom: { x: 400, y: 0, w: 320, h: 240 } }, // side by side
  large: { w: 560, h: 240, top: { x: 0, y: 0, w: 400, h: 240 }, bottom: { x: 400, y: 120, w: 160, h: 120 } }, // large top, small bottom
  top: { w: 400, h: 240, top: { x: 0, y: 0, w: 400, h: 240 }, bottom: null }, // top screen only (no touch)
};

/** Width / height of a layout (the play view sizes the game's frame with it before the first picture). */
export function ctrLayoutAspect(id) {
  const l = LAYOUTS[id] || LAYOUTS.tb;
  return l.w / l.h;
}

const scaleRect = (r, kx, ky) => ({ x: Math.round(r.x * kx), y: Math.round(r.y * ky), w: Math.round(r.w * kx), h: Math.round(r.h * ky) });

/**
 * Layout `id` for a picture of w×h pixels from the core: { id, width, height, quads: [{ screen, src, dst }] } – the
 * canvas size and, per screen, its rectangle in the picture (src) and on the canvas (dst), in pixels. A picture that
 * isn't the core's 400:480 default layout is shown as it is.
 */
export function ctrLayout(id, w, h) {
  const l = LAYOUTS[id] || LAYOUTS.tb;
  const k = w / 400;
  if (!(w > 0 && h > 0) || Math.abs(h - 480 * k) > 1) {
    const whole = { x: 0, y: 0, w: Math.max(1, w | 0), h: Math.max(1, h | 0) };
    return { id: 'raw', width: whole.w, height: whole.h, quads: [{ screen: 'all', src: whole, dst: whole }] };
  }
  const quads = [{ screen: 'top', src: scaleRect(TOP, k, k), dst: scaleRect(l.top, k, k) }];
  if (l.bottom) quads.push({ screen: 'bottom', src: scaleRect(BOTTOM, k, k), dst: scaleRect(l.bottom, k, k) });
  return { id: LAYOUTS[id] ? id : 'tb', width: Math.round(l.w * k), height: Math.round(l.h * k), source: { w, h }, quads };
}

/**
 * Where a click lands for the core: `fx`, `fy` 0…1 over the canvas of `lay` (ctrLayout) → { x, y } 0…1 over the
 * core's own picture (its pointer), or null when it misses the bottom screen. `clamp`: a drag that leaves the bottom
 * screen stays on its edge instead of ending.
 */
export function ctrTouchAt(lay, fx, fy, { clamp = false } = {}) {
  if (!lay || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const q = lay.quads.find((x) => x.screen === 'bottom') || (lay.id === 'raw' ? lay.quads[0] : null);
  if (!q) return null;
  const cx = fx * lay.width;
  const cy = fy * lay.height;
  let u = (cx - q.dst.x) / q.dst.w;
  let v = (cy - q.dst.y) / q.dst.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    if (!clamp) return null;
    u = Math.min(1, Math.max(0, u));
    v = Math.min(1, Math.max(0, v));
  }
  const src = lay.source || { w: lay.width, h: lay.height };
  return { x: (q.src.x + u * q.src.w) / src.w, y: (q.src.y + v * q.src.h) / src.h };
}

/**
 * Is a picture of the 3DS player black (lib/ctrplayer.mjs: a game that never draws anything)? `px` RGBA / BGRA rows of
 * w×h; up to ~400 pixels spread over it are looked at.
 */
export function blackPicture(px, w, h) {
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 397));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (px[o] > 12 || px[o + 1] > 12 || px[o + 2] > 12) return false;
  }
  return true;
}
