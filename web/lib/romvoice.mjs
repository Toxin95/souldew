// The turbo mixer's "music from the ROM" voice (web/lib/turboaudio.mjs): plays a 3DS game's own music track at normal
// speed – the game's stream file, decoded here – from the position the page says the game is at (shared/ctr/rommusic.mjs,
// web/lib/rommusic.mjs). At 1× it plays along silently, in step with the game; while the game fast-forwards it is the
// music: on at its normal pitch, never sped up, following the track's own loop points, crossfading into the next track
// when the game starts another. Never pitched, never time-stretched: only played, jumped and crossfaded.
//
// Sources:
//   cstm   the BCSTM file's bytes (DSP-ADPCM or PCM), decoded a block at a time as it plays (two blocks held – a 3-minute
//          track is ~7 MB of ADPCM instead of ~23 MB of samples); the SEEK table gives the decoder's history at any block
//   pcm    samples the page decoded (AAC: the browser's decoder, already at the context's rate) – Int16 per channel
// A source at another rate than the context's is resampled (Catmull-Rom) – the 3DS tracks are mostly at the core's rate.
//
// Plain JS (no Web Audio types): runs in the AudioWorklet and in node --test.

import { cstmDecodeBlock, cstmSeekHist, cstmSane } from '../../shared/ctr/streams.mjs';

const Q = 1 / 32768;

/** A BCSTM file decoded block by block. */
export class CstmSource {
  constructor(file, info) {
    this.file = file;
    this.info = info;
    this.rate = info.rate;
    this.samples = info.samples;
    this.loop = info.loop;
    this.channels = info.channels;
    this.seek = info.seekAt >= 0 && info.seekAt < file.length ? file.subarray(info.seekAt) : null;
    this.cache = [null, null]; // [{ i, ch: Int16Array[], hist (after it) }]
    this.next = 0; // which cache slot the next decoded block replaces
  }

  /** Block `i` decoded (from the cache, from the block before it, or with the SEEK history). */
  block(i) {
    const c = this.cache;
    if (c[0]?.i === i) return c[0];
    if (c[1]?.i === i) return c[1];
    const prev = c[0]?.i === i - 1 ? c[0] : c[1]?.i === i - 1 ? c[1] : null;
    const s = this.info;
    let hist;
    if (prev) hist = prev.hist.map((h) => [h[0], h[1]]);
    else if (i === 0) hist = s.hist.map((h) => [h[0], h[1]]);
    else hist = Array.from({ length: s.channels }, (_, ch) => cstmSeekHist(s, this.seek, i, ch) || [0, 0]);
    const ch = cstmDecodeBlock(s, this.file, i, hist);
    const b = { i, ch, hist };
    c[this.next] = b;
    this.next ^= 1;
    return b;
  }

  /** Samples [p, p + n) of channel 0/1 into l/r (Float32, ±1) – p within the track. */
  read(p, n, l, r, at = 0) {
    p = Math.floor(p);
    if (p < 0) {
      const z = Math.min(n, -p);
      l.fill(0, at, at + z);
      r.fill(0, at, at + z);
      if (z === n) return;
      [p, n, at] = [0, n - z, at + z];
    }
    const bs = this.info.blockSamples;
    let w = 0;
    while (w < n) {
      if (p >= this.samples) {
        l.fill(0, at + w, at + n);
        r.fill(0, at + w, at + n);
        return;
      }
      const b = this.block(Math.floor(p / bs));
      const k = p - b.i * bs;
      const L = b.ch[0];
      const R = b.ch[1] || L;
      const m = Math.min(n - w, L.length - k);
      if (m <= 0) {
        l.fill(0, at + w, at + n);
        r.fill(0, at + w, at + n);
        return;
      }
      for (let j = 0; j < m; j++) {
        l[at + w + j] = L[k + j] * Q;
        r[at + w + j] = R[k + j] * Q;
      }
      w += m;
      p += m;
    }
  }
}

/** Decoded samples (Int16 per channel). */
export class PcmSource {
  constructor({ l, r, rate, loop = null }) {
    this.l = l;
    this.r = r || l;
    this.rate = rate;
    this.samples = l.length;
    this.loop = loop && loop.start < loop.end && loop.end <= l.length ? loop : null;
  }

  read(p, n, l, r, at = 0) {
    p = Math.floor(p);
    for (let j = 0; j < n; j++, p++) {
      if (p >= this.samples || p < 0) {
        l[at + j] = r[at + j] = 0;
        continue;
      }
      l[at + j] = this.l[p] * Q;
      r[at + j] = this.r[p] * Q;
    }
  }
}

/** One playing track: a source, a position (source samples, fractional when resampled), the step per output sample. */
class Play {
  constructor(id, src, pos, outRate) {
    this.id = id;
    this.src = src;
    this.step = src.rate / outRate;
    // (at the output's rate the position is a whole sample – the reads' positions come as fractions of one)
    this.pos = this.step === 1 ? Math.round(pos) : pos;
    this.ended = false;
    this.bl = new Float32Array(8);
    this.br = new Float32Array(8);
  }

  /** The track position after `d` more source samples – its loop taken. */
  wrapped(p) {
    const l = this.src.loop;
    if (l && p >= l.end) return l.start + ((p - l.start) % (l.end - l.start));
    return p;
  }

  /** Adds n output samples × the gain (g0 → g1 over the block) to outL/outR. */
  add(outL, outR, n, g0, g1) {
    if (this.ended) return;
    const s = this.src;
    if (this.bl.length < n) {
      this.bl = new Float32Array(Math.max(n, 128));
      this.br = new Float32Array(Math.max(n, 128));
    }
    const tl = this.bl;
    const tr = this.br;
    const dg = (g1 - g0) / n;
    if (this.step === 1) {
      // in runs up to the loop end (or the track's end)
      for (let i = 0; i < n;) {
        const p = this.pos;
        const lim = s.loop ? s.loop.end : s.samples;
        if (p >= lim) {
          if (!s.loop) {
            this.ended = true;
            return;
          }
          this.pos = this.wrapped(p);
          continue;
        }
        const m = Math.min(n - i, lim - p);
        s.read(p, m, tl, tr, 0);
        for (let j = 0; j < m; j++) {
          const g = g0 + dg * (i + j + 1);
          outL[i + j] += tl[j] * g;
          if (outR !== outL) outR[i + j] += tr[j] * g;
        }
        i += m;
        this.pos = this.wrapped(p + m);
      }
      return;
    }
    const nl = new Float32Array(4);
    const nr = new Float32Array(4);
    for (let i = 0; i < n; i++) {
      const p = Math.floor(this.pos);
      if (!s.loop && p >= s.samples) {
        this.ended = true;
        return;
      }
      // four neighbours (p-1 … p+2), the loop taken into account
      for (let k = 0; k < 4; k++) s.read(this.wrapped(Math.max(0, p - 1 + k)), 1, nl, nr, k);
      const f = this.pos - p;
      const g = g0 + dg * (i + 1);
      outL[i] += cr(nl, f) * g;
      if (outR !== outL) outR[i] += cr(nr, f) * g;
      this.pos = this.wrapped(this.pos + this.step);
    }
  }
}

/** Catmull-Rom between x[1] and x[2] at fraction f. */
function cr(x, f) {
  const y0 = x[0];
  const y1 = x[1];
  const y2 = x[2];
  const y3 = x[3];
  return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
}

export class RomVoice {
  constructor(sampleRate, { keep = 3 } = {}) {
    this.sr = sampleRate;
    this.keep = keep; // tracks held (the playing one, the one fading out, one more)
    this.tracks = new Map(); // id → source (least recently used first)
    this.cur = null; // Play
    this.old = null; // the Play fading out { play, left, len }
    this.xf = 0; // samples of crossfade left
    this.xlen = 0;
  }

  /** A track's data from the page: { id, kind: 'cstm', file, info } or { id, kind: 'pcm', l, r, rate, loop }. */
  add(m) {
    let src = null;
    // (sizes checked again here: what they say is allocated per block in the audio thread)
    if (m.kind === 'cstm' && m.file && cstmSane(m.info, m.file.length)) src = new CstmSource(m.file, m.info);
    else if (m.kind === 'pcm' && m.l) src = new PcmSource(m);
    if (!src) return false;
    this.tracks.delete(m.id);
    this.tracks.set(m.id, src);
    // the oldest go – never the one playing or fading out
    for (const id of this.tracks.keys()) {
      if (this.tracks.size <= this.keep) break;
      if (id !== this.cur?.id && id !== this.old?.play.id) this.tracks.delete(id);
    }
    return true;
  }

  has(id) {
    return this.tracks.has(id);
  }

  /** The id playing now (null: nothing). */
  get id() {
    return this.cur && !this.cur.ended ? this.cur.id : null;
  }

  /** The position of the playing track (source samples), or null. */
  get pos() {
    return this.cur && !this.cur.ended ? this.cur.pos : null;
  }

  /** Plays track `id` from `pos` (source samples), crossfading from what played over `xfade` seconds (0: a cut). */
  play(id, pos, xfade = 0.03) {
    const src = this.tracks.get(id);
    if (!src) return false;
    if (src.loop && pos >= src.loop.end) pos = src.loop.start + ((pos - src.loop.start) % (src.loop.end - src.loop.start));
    pos = Math.max(0, pos);
    const next = new Play(id, src, pos, this.sr);
    if (this.cur && !this.cur.ended && xfade > 0) {
      this.old = { play: this.cur, len: Math.max(1, Math.round(xfade * this.sr)) };
      this.old.left = this.old.len;
      this.xlen = this.old.len;
      this.xf = this.old.len;
    } else {
      this.old = null;
      this.xf = 0;
    }
    this.cur = next;
    // the source's cache: re-touch so it stays
    this.tracks.delete(id);
    this.tracks.set(id, src);
    return true;
  }

  stop() {
    this.cur = null;
    this.old = null;
    this.xf = 0;
  }

  /** Adds n samples × `gain` (the mixer's fade, from → to over the block) to outL/outR. */
  render(outL, outR, n, from = 1, to = from) {
    const o = this.old;
    if (o && this.xf > 0) {
      // equal-power crossfade, in block steps (the curve per block: ≤ 128 samples – smooth enough at 32 kHz)
      const t0 = 1 - this.xf / this.xlen;
      const k = Math.min(n, this.xf);
      this.xf -= k;
      const t1 = 1 - this.xf / this.xlen;
      o.play.add(outL, outR, n, Math.cos((t0 * Math.PI) / 2) * from, Math.cos((t1 * Math.PI) / 2) * to);
      this.cur?.add(outL, outR, n, Math.sin((t0 * Math.PI) / 2) * from, Math.sin((t1 * Math.PI) / 2) * to);
      if (this.xf <= 0) this.old = null;
      return;
    }
    this.cur?.add(outL, outR, n, from, to);
  }
}

/**
 * Where the game's sound really is in the track: `game` (mono, what the game played while the voice was at source
 * position `p0`, sample for sample) against the track around p0, ± `range` samples – a coarse search on every 4th
 * sample, then exact. Returns { d (the game is d samples further than the voice), score } or null (too quiet, or a
 * source at another rate). The reads only place the music to a few hundred samples; this lines it up to the sample,
 * so switching between the game's sound and the track is the same music at the same place.
 */
export function alignLag(game, src, p0, range = 2048) {
  if (!src || src.rate == null) return null;
  const W = game.length;
  const lo = Math.max(0, Math.floor(p0) - range);
  const n = W + 2 * range;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  src.read(lo, n, l, r);
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = (l[i] + r[i]) * 0.5;
  let eg = 0;
  for (let i = 0; i < W; i++) eg += game[i] * game[i];
  if (eg / W < 1e-6) return null; // (quiet: nothing to line up)
  const D = 4;
  const corr = (o, step) => {
    let num = 0;
    let et = 0;
    for (let i = 0; i < W; i += step) {
      const y = t[o + i];
      num += game[i] * y;
      et += y * y;
    }
    return et > 0 ? num / Math.sqrt(et * (eg / step)) : 0;
  };
  let best = -2;
  let at = 0;
  for (let o = 0; o + W <= n; o += D) {
    const c = corr(o, D);
    if (c > best) [best, at] = [c, o];
  }
  let fine = -2;
  let fat = at;
  for (let o = Math.max(0, at - D); o <= Math.min(n - W, at + D); o++) {
    const c = corr(o, 1);
    if (c > fine) [fine, fat] = [c, o];
  }
  // the better of the full-band match and the one below ~4 kHz (4 samples averaged): the game's AAC decoder and
  // resampler differ from the browser's in the top end, the music underneath is the same
  let num = 0;
  let ea = 0;
  let et = 0;
  for (let i = 0; i + D <= W; i += D) {
    let x = 0;
    let y = 0;
    for (let k = 0; k < D; k++) {
      x += game[i + k];
      y += t[fat + i + k];
    }
    num += x * y;
    ea += x * x;
    et += y * y;
  }
  const band = et > 0 && ea > 0 ? num / Math.sqrt(ea * et) : 0;
  return { d: lo + fat - Math.floor(p0), score: Math.max(fine, band), full: fine, band };
}
