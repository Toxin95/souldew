// The sound worklet's buffer (native-audio-worklet.mjs): the host's stereo frames as the page hands them over, read
// out in 128-frame blocks on the sound card's clock. The sound comes in bursts – one host frame (160–640 frames) after
// each picture, and the 3DS page's pictures are up to 7 MB, so on a busy PC it can stall for a few hundred ms and then
// arrive all at once. Whatever the buffer does to bridge that must not be heard:
//
// - Running dry: the last sample dies away over ~3 ms instead of dropping to zero (a step is a click), and the sound
//   that comes back fades in over 4 ms. With `prime` (the 3DS page) it then waits until that many frames are there
//   again, one short gap rather than a crackle of tiny ones – and every gap raises `prime` by half (up to `primeMax`),
//   so a PC whose sound arrives late now and then gets a buffer that covers it; after CLEAN s without a gap it shrinks
//   (longer after repeated gaps, and not while it only just covers the stalls – it would be a gap again at the next).
// - A break the player asked for (`rebase`: a speed step, turbo on / off, another sound mode, a loaded state, a reset,
//   the game going on after a pause – and the first seconds of a game) is no gap: `prime` goes back to its base, running
//   dry for a while after it counts for nothing, and whatever piles up behind it (the host catching up, the sound from
//   before the step) is skipped – crossfaded – down to `prime`. Until 2.8.2 each of those counted as a gap: a Windows
//   player's 3DS sound sat at 230–265 ms behind the picture after a few speed toggles and loaded states (`prime` pinned at
//   its 240 ms maximum, ~3 min of play without a gap to come back down) – sound effects audibly late.
// - Too much buffered (each gap leaves the late sound queued behind it): with `trim` (the 3DS page) the buffer is read
//   a little faster – at most 0.5 % (8.6 cents, as RetroArch's dynamic rate control), through a windowed-sinc
//   interpolator – until it is back just above `prime`, and a little slower when it runs low. 2.7.3 folded one
//   frame more into every 128-frame block by linear interpolation instead: its error, modulated at 256 Hz, was only
//   25 dB below a 6 kHz tone (14 dB at 10 kHz) – a grainy, harsh sound for as long as the buffer stayed above 200 ms
//   (in a Windows test machine: up to half the time).
// - Far too much (above `maxLag`): it skips ahead to the middle of its range, crossfading over 8 ms.
// At the normal fill nothing of this runs: the frames come out exactly as they went in.
//
// `paused` (the game is paused): running dry then is no gap – `prime` stays as it is.
// `stats.breaks` counts running dry around such a break (not a gap: `underruns` doesn't count it).
// `played` counts the frames read (skipped ones too) – the positions the worklet's in-band commands wait for.

const TAPS = 32; // interpolator length (frames)
const HALF = TAPS / 2; // it reads HALF - 1 frames before the position and HALF after
const PHASES = 256; // table resolution between two frames (linear in between)
const MAX_DEV = 0.005; // the most the reading speed changes
const MIN_DEV = 0.001; // the least, while it changes at all (so the fill gets back in range, not just near it)
const SWING = 0.5; // seconds for the reading speed to go from 1 to the most
const LAND = 0.00025; // back at speed 1: the reading position drifts this much per frame onto a whole frame
const FADE_IN = 128; // frames
const DECAY = 0.96; // per frame, of the last sample when running dry (−40 dB in ~110 frames, ~3 ms)
const XFADE = 256; // frames of crossfade when skipping ahead
const CLEAN = 6; // seconds without a gap before `prime` shrinks again (by SHRINK; until 2.8.2: 30 s, by 0.8) – doubled for
// each recent gap (STRIKES at most): a PC whose sound stalls every few seconds keeps the buffer that covers it
const SHRINK = 0.7;
const STRIKES = 3;
const FORGIVE = 30; // seconds without a gap that take one of those back
const GRACE = 1.5; // seconds after a break the player asked for (`rebase`) in which running dry is no gap …
const START_GRACE = 3; // … and after the first sound (a game's first seconds: loading, shaders)
const SETTLE = 0.03; // seconds above `prime` that are skipped within that time (the sound piled up behind the break)

function bessel0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Kaiser-windowed sinc (β 8.5, cut-off at 96 % of Nyquist), PHASES + 1 phases of TAPS taps, each summing to 1. */
function kernel() {
  const k = new Float32Array((PHASES + 1) * TAPS);
  const beta = 8.5;
  const fc = 0.96;
  const norm = bessel0(beta);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - (HALF - 1) - frac; // the tap's distance from the reading position
      const t = x / HALF;
      const w = Math.abs(t) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - t * t)) / norm;
      const s = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
      k[p * TAPS + j] = s * w;
      sum += s * w;
    }
    for (let j = 0; j < TAPS; j++) k[p * TAPS + j] /= sum;
  }
  return k;
}
const KERNEL = kernel();

export class JitterRing {
  /**
   * `rate`: the context's sample rate. Options in frames: `prime` – wait for this much after running dry (0: play
   * whatever is there), `primeMax` – how far gaps may raise it, `trim` – above this the reading speeds up (0: never
   * changes speed), `maxLag` – above this it skips ahead (default ~125 ms at 32 kHz); `startGrace` – seconds after the
   * first sound that count as a break the player asked for (see rebase).
   */
  constructor(rate, { prime = 0, primeMax = 0, trim = 0, maxLag = 0, startGrace = START_GRACE } = {}) {
    this.rate = rate;
    this.size = 65536; // frames (~2 s at 32 kHz), a power of two
    this.mask = this.size - 1;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.frac = 0; // reading position between `read` and the next frame
    this.ratio = 1; // frames read per frame played
    this.maxLag = maxLag > 0 ? Math.min(maxLag, this.size >> 1) : 4096;
    this.base = prime > 0 ? Math.min(prime, this.maxLag >> 1) : 0;
    this.prime = this.base;
    this.primeMax = Math.max(this.base, Math.min(primeMax || 0, this.size >> 2));
    this.trim = trim > 0 ? trim : 0;
    this.priming = this.prime > 0;
    this.started = false; // has any sound played yet (a gap before that is no gap)
    this.paused = false; // the game is paused: running dry is no gap
    this.fill = 0; // the buffered frames, averaged over ~0.4 s (the speed control's measure)
    this.draining = false;
    this.filling = false;
    this.clean = 0; // frames played since the last gap (or since `prime` last shrank)
    this.strikes = 0; // recent gaps (each doubles the time before `prime` shrinks)
    this.calm = 0; // frames played since the last gap (or since a strike was taken back)
    this.grace = 0; // frames left in which running dry is no gap and a pile-up is skipped (see rebase)
    this.heard = false; // has any sound played since the ring was made (START_GRACE begins then)
    this.settle = Math.round(rate * SETTLE);
    this.startGrace = startGrace;
    this.gain = 1; // fade-in
    this.tailL = 0; // the decaying last sample while dry
    this.tailR = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.xf = 0; // frames of crossfade left, from the old reading position
    this.xRead = 0;
    this.xFrac = 0;
    this.pushed = 0;
    this.played = 0;
    this.stats = { underruns: 0, breaks: 0, silent: 0, dropped: 0, skips: 0, resampled: 0 };
    this.s = new Float64Array(2); // (one frame read, and one from the old position while skipping ahead)
    this.x = new Float64Array(2);
  }

  /** Frames buffered from the reading position on. */
  get lag() {
    return (this.write - this.read) & this.mask;
  }

  /** Above this the reading speeds up (only with `trim`). */
  get high() {
    return Math.max(this.trim, this.prime + Math.round(this.trim * 0.7));
  }

  /** Interleaved stereo frames in. */
  push(d) {
    let n = d.length >> 1;
    // more than the ring holds apart from what is being read (seconds at once – a stalled page): the oldest goes now
    const over = this.lag + n - (this.size - 8192);
    if (over > 0) {
      const k = Math.min(over, this.lag);
      if (k) this.jump(k, false);
      const cut = over - k; // (only if this one message alone is too much)
      if (cut) {
        d = d.subarray(cut * 2);
        n -= cut;
        this.pushed += cut;
        this.played += cut;
        this.stats.dropped += cut;
      }
    }
    const { l, r, mask } = this;
    let w = this.write;
    for (let i = 0; i < n; i++) {
      l[w] = d[i * 2];
      r[w] = d[i * 2 + 1];
      w = (w + 1) & mask;
    }
    this.write = w;
    this.pushed += n;
  }

  /** Everything buffered is gone (a loaded state, a reset): wait for new sound. */
  clear() {
    this.read = this.write = 0;
    this.frac = 0;
    this.ratio = 1;
    this.fill = 0;
    this.draining = this.filling = false;
    this.xf = 0;
    this.played = this.pushed;
    this.priming = this.prime > 0;
    this.started = false;
    this.gain = 0;
    this.tailL = this.lastL;
    this.tailR = this.lastR;
    this.rebase();
  }

  /**
   * A break the player asked for (a speed step, turbo on / off, another sound mode, a loaded state, the game going on
   * after a pause): `prime` back to its base, and for GRACE s running dry is no gap and a pile-up is skipped.
   */
  rebase(seconds = GRACE) {
    if (!this.base) return;
    this.prime = this.base;
    this.clean = 0;
    this.grace = Math.max(this.grace, Math.round(this.rate * seconds));
  }

  /** The sound stops here (dying away) and comes back faded in – once `prime` frames are there (with `prime`). */
  halt() {
    this.tailL = this.lastL;
    this.tailR = this.lastR;
    this.gain = 0;
    this.frac = 0;
    this.ratio = 1;
    this.xf = 0;
    this.draining = this.filling = false;
    this.priming = this.base > 0;
    this.started = false;
  }

  /** Leave `n` buffered frames out – crossfaded from where the reading was (`fade`), or at once. */
  jump(n, fade = true) {
    if (fade && this.started && !this.priming) {
      this.xf = XFADE;
      this.xRead = this.read;
      this.xFrac = this.frac;
    }
    this.read = (this.read + n) & this.mask;
    this.played += n;
    this.stats.dropped += n;
    this.stats.skips++;
  }

  /**
   * The reading speed for the next block (with `trim`): 1 between 3/4 `prime` and `high`, else up to ±0.5 %. (Until
   * 2.8.2 it read slower only below half of `prime`: a buffer left 20 ms short by a break stayed so, and the next late
   * picture was a gap.)
   */
  steer(n) {
    const hi = this.high;
    const mid = this.prime + ((hi - this.prime) >> 2); // (where reading faster stops: just above `prime`)
    const lo = (this.prime * 3) >> 2;
    const up = Math.round(this.prime * 0.9); // (where reading slower stops)
    if (this.fill > hi) this.draining = true;
    else if (this.fill <= mid) this.draining = false;
    if (this.fill < lo) this.filling = true;
    else if (this.fill >= up) this.filling = false;
    const full = this.rate * 0.03; // the whole 0.5 % at 30 ms off (until 2.8.2: 100 ms – 60 ms too much took ~30 s to go)
    let want = 1;
    const dev = (off) => Math.max(MIN_DEV, Math.min(MAX_DEV, (off / full) * MAX_DEV));
    if (this.draining) want = 1 + dev(this.fill - mid);
    else if (this.filling) want = 1 - dev(up - this.fill);
    const step = (MAX_DEV * n) / (this.rate * SWING);
    if (Math.abs(want - this.ratio) <= step) this.ratio = want;
    else this.ratio += want > this.ratio ? step : -step;
  }

  /** The frame at reading position (`at`, `frac`) – interpolated unless that is a whole frame. */
  sample(at, frac, out, o) {
    if (frac === 0) {
      out[o] = this.l[at];
      out[o + 1] = this.r[at];
      return;
    }
    const ph = frac * PHASES;
    const p = Math.floor(ph);
    const t = ph - p;
    const k0 = p * TAPS;
    const k1 = k0 + TAPS;
    const { l, r, mask } = this;
    let a = 0;
    let b = 0;
    let idx = (at - (HALF - 1)) & mask;
    for (let j = 0; j < TAPS; j++) {
      const c = KERNEL[k0 + j] + (KERNEL[k1 + j] - KERNEL[k0 + j]) * t;
      a += l[idx] * c;
      b += r[idx] * c;
      idx = (idx + 1) & mask;
    }
    out[o] = a;
    out[o + 1] = b;
  }

  /** The next n frames into outL / outR. */
  take(outL, outR, n) {
    let lag = this.lag;
    // a close call (the buffer nearly ran dry – a stall it only just covered): the larger `prime` was needed, it doesn't
    // shrink yet (until 2.8.2's review it shrank 6 s after the last gap, and the next stall was a gap again)
    if (this.started && !this.priming && !this.paused && this.grace <= 0 && lag < this.prime >> 2) this.clean = this.calm = 0;
    this.fill += (lag - this.fill) * Math.min(1, n / (this.rate * 0.4));
    if (this.priming && lag >= this.prime) {
      this.priming = false;
      this.fill = lag;
    }
    if (this.grace > 0 && !this.priming && this.started && lag > this.prime + this.settle) {
      // right after a break: what piled up behind it goes (crossfaded) – back to `prime` at once, not in a minute
      this.jump(lag - this.prime);
      lag = this.lag;
      this.fill = lag;
      this.draining = this.filling = false;
    } else if (this.grace > 0 && !this.priming && this.started && this.fill < (this.prime * 3) >> 2) {
      // … or it left too little behind it (the sound ran low but not dry across it): wait for `prime` again – one short
      // pause now, at the break, instead of a gap at the next late picture
      this.stats.breaks++;
      this.halt();
    }
    if (!this.priming) {
      const max = this.trim ? Math.max(this.maxLag, this.high + this.trim) : this.maxLag;
      if (lag > max) {
        this.jump(lag - (this.trim ? (this.prime + this.high) >> 1 : this.maxLag >> 1));
        lag = this.lag;
        this.fill = lag;
      }
      if (this.trim) this.steer(n);
    }
    if (this.ratio !== 1 || this.frac !== 0) this.stats.resampled++;
    const { s, x } = this;
    for (let i = 0; i < n; i++) {
      let L = 0;
      let R = 0;
      let sound = false;
      if (!this.priming) {
        const exact = this.frac === 0 && this.ratio === 1;
        if (lag >= (exact ? 1 : HALF + 1)) {
          this.sample(this.read, this.frac, s, 0);
          L = s[0];
          R = s[1];
          if (this.xf > 0) {
            // skipping ahead: the old position fades out as the new one comes in (equal power)
            this.sample(this.xRead, this.xFrac, x, 0);
            const g = Math.sin(((XFADE - this.xf) / XFADE) * Math.PI * 0.5);
            const h = Math.cos(((XFADE - this.xf) / XFADE) * Math.PI * 0.5);
            L = L * g + x[0] * h;
            R = R * g + x[1] * h;
            this.xf--;
            const xn = this.xFrac + this.ratio;
            const xk = Math.floor(xn);
            this.xFrac = xn - xk;
            this.xRead = (this.xRead + xk) & this.mask;
          }
          // on to the next position (back at speed 1 a fractional position drifts onto a whole frame, then is exact)
          let next = this.frac + this.ratio;
          if (this.ratio === 1 && this.frac !== 0) next = Math.min(2, next + LAND); // (2: landed on a whole frame)
          const k = Math.floor(next);
          this.frac = next - k;
          this.read = (this.read + k) & this.mask;
          this.played += k;
          lag -= k;
          if (this.gain < 1) {
            this.gain = Math.min(1, this.gain + 1 / FADE_IN);
            L *= this.gain;
            R *= this.gain;
          }
          sound = true;
          if (!this.heard) {
            this.heard = true;
            if (this.startGrace > 0) this.rebase(this.startGrace);
          }
          this.started = true;
          this.clean++;
          this.calm++;
        } else if (this.started) {
          // ran dry – a gap, unless the game is paused (then nothing was due) or right after a break the player asked for
          if (this.grace > 0) this.stats.breaks++;
          else if (!this.paused) {
            this.stats.underruns++;
            this.clean = this.calm = 0;
            this.strikes = Math.min(STRIKES, this.strikes + 1);
            if (this.base) this.prime = Math.min(this.primeMax, Math.round(this.prime * 1.5));
          }
          this.halt();
        }
      }
      if (!sound) this.stats.silent++;
      // the last sample before a gap dies away instead of stopping (added under the sound that comes back)
      if (this.tailL || this.tailR) {
        this.tailL *= DECAY;
        this.tailR *= DECAY;
        if (Math.abs(this.tailL) < 1e-6 && Math.abs(this.tailR) < 1e-6) this.tailL = this.tailR = 0;
        L += this.tailL;
        R += this.tailR;
      }
      outL[i] = L;
      outR[i] = R;
      if (sound) {
        this.lastL = L;
        this.lastR = R;
      }
    }
    if (this.grace > 0 && this.heard) this.grace = Math.max(0, this.grace - n);
    if (this.base && this.prime > this.base && this.clean > this.rate * CLEAN * 2 ** this.strikes) {
      this.prime = Math.max(this.base, Math.round(this.prime * SHRINK));
      this.clean = 0;
    }
    if (this.strikes && this.calm > this.rate * FORGIVE) {
      this.strikes--;
      this.calm = 0;
    }
  }
}
