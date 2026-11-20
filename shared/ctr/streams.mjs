// The music stream formats of 3DS games, recognised by their own bytes (never by a file name) – "music from the ROM"
// (shared/ctr/rommusic.mjs). A small registry: each codec says from the first bytes of a file whether it is one of its
// streams, reads what it needs to play it (rate, channels, length, loop, where the sample data is) and maps a byte offset
// of the file to the sample position it holds – the emulator only sees which bytes the game reads. New formats go in
// CODECS; a file no codec takes is simply not music.
//
//   cstm   BCSTM (CTR stream, "CSTM"): Nintendo's stream format – X/Y jingles, Omega Ruby/Alpha Sapphire, Sun/Moon,
//          Ultra Sun/Ultra Moon. Codec 2 (DSP-ADPCM, decoded here) or 0/1 (PCM8/PCM16); blocks of `blockSize` bytes per
//          channel, interleaved by channel; loop start / end in samples; a SEEK block with the decoder history at each
//          block start (random access).
//   adts   AAC-LC in ADTS frames: X/Y's music (bgm_xy_*.aac). Every frame has a 7–9 byte header with its length and
//          1024 samples. Decoded by the browser (web/lib/rommusic.mjs). No loop in the file: the sound archive (BCSAR,
//          bcsarStreams below) has it, else the game's own reads show it (it reads the loop start again).
//
// Everything here works on Uint8Arrays and never throws on damaged input (null instead).

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s16 = (b, o) => (u16(b, o) << 16) >> 16;
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const fits = (b, o, n) => o >= 0 && o + n <= b.length;

/** How many bytes of a file's start the codecs look at to recognise it (and the CSTM INFO block). */
export const SNIFF_BYTES = 0x1000;

// ---- BCSTM -----------------------------------------------------------------------------------------------------------
/**
 * A BCSTM's header + INFO (+ SEEK when `b` reaches that far): { codec: 'cstm', format ('dsp' | 'pcm16' | 'pcm8'),
 * channels, rate, samples, loop: { start, end } | null, blocks, blockSize, blockSamples, lastBlockSize,
 * lastBlockSamples, lastBlockPadded, dataStart (file offset of the first sample byte), coefs: Int16Array(16)[],
 * hist: [yn1, yn2][] (at the stream start), seekAt (file offset of the SEEK entries or -1), seekInterval } or null.
 */
export function cstmInfo(b) {
  try {
    if (!b || b.length < 0x40 || tag(b, 0) !== 'CSTM' || u16(b, 4) !== 0xfeff) return null;
    const nBlocks = u16(b, 0x10);
    let info = -1;
    let seek = -1;
    let data = -1;
    for (let i = 0; i < nBlocks && i < 8; i++) {
      const o = 0x14 + i * 12;
      if (!fits(b, o, 12)) return null;
      const type = u16(b, o);
      const off = u32(b, o + 4);
      if (type === 0x4000) info = off;
      else if (type === 0x4001) seek = off;
      else if (type === 0x4002) data = off;
    }
    if (info < 0 || data < 0 || !fits(b, info, 0x40) || tag(b, info) !== 'INFO') return null;
    const body = info + 8;
    if (u16(b, body) !== 0x4100) return null;
    const si = body + u32(b, body + 4);
    if (!fits(b, si, 0x38)) return null;
    const codecId = b[si];
    const format = { 0: 'pcm8', 1: 'pcm16', 2: 'dsp' }[codecId];
    if (!format) return null; // (3: IMA-ADPCM – not used by these games)
    const channels = b[si + 2];
    const rate = u32(b, si + 4);
    const samples = u32(b, si + 0x0c);
    const blockSize = u32(b, si + 0x14);
    const blockSamples = u32(b, si + 0x18);
    if (!channels || channels > 8 || rate < 8000 || rate > 96000 || !samples || !blockSize || !blockSamples) return null;
    const out = {
      codec: 'cstm', format, channels, rate, samples,
      loop: b[si + 1] ? { start: u32(b, si + 8), end: samples } : null,
      blocks: u32(b, si + 0x10), blockSize, blockSamples,
      lastBlockSize: u32(b, si + 0x1c), lastBlockSamples: u32(b, si + 0x20), lastBlockPadded: u32(b, si + 0x24),
      seekInterval: u32(b, si + 0x2c),
      dataStart: data + 8 + (u16(b, si + 0x30) === 0x1f00 ? u32(b, si + 0x34) : 0x18),
      seekAt: seek >= 0 ? seek + 8 : -1, // (the SEEK block's entries: per block, per channel { s16 yn1, s16 yn2 })
      coefs: [], hist: [],
    };
    if (out.loop && !(out.loop.start < out.loop.end)) out.loop = null;
    if (format === 'dsp') {
      // channel info table: u32 count, refs (0x4102) relative to the table → ref (0x0300) to the DSP-ADPCM info
      const cr = body + 16;
      if (u16(b, cr) !== 0x0101) return null;
      const table = body + u32(b, cr + 4);
      if (!fits(b, table, 4) || u32(b, table) < channels) return null;
      for (let c = 0; c < channels; c++) {
        const ci = table + u32(b, table + 4 + c * 8 + 4);
        if (!fits(b, ci, 8) || u16(b, ci) !== 0x0300) return null;
        const dsp = ci + u32(b, ci + 4);
        if (!fits(b, dsp, 0x2e)) return null;
        const k = new Int16Array(16);
        for (let i = 0; i < 16; i++) k[i] = s16(b, dsp + i * 2);
        out.coefs.push(k);
        out.hist.push([s16(b, dsp + 0x22), s16(b, dsp + 0x24)]);
      }
    }
    // the sizes are what the player allocates (a block decoded per channel): they must fit the bytes they describe
    return cstmSane(out, u32(b, 0x0c) || Infinity) ? out : null;
  } catch {
    return null;
  }
}

/** The biggest block (bytes per channel) taken – Nintendo's streams use 0x2000. */
export const CSTM_MAX_BLOCK = 0x40000;
/** Samples `n` bytes of a block hold. */
const samplesIn = (format, n) => (format === 'dsp' ? Math.floor(n / 8) * 14 : format === 'pcm16' ? Math.floor(n / 2) : n);

/**
 * Do a BCSTM info's sizes make sense – for a file of `length` bytes (Infinity: not known)? Every size the player
 * allocates from is bounded: a block at most CSTM_MAX_BLOCK bytes, its samples what those bytes can hold, the last block
 * no bigger than the others, the samples no more than the blocks hold, the data inside the file (a block's slack
 * allowed). A damaged or hostile header is no stream – never a gigabyte allocation in the sound worklet.
 */
export function cstmSane(s, length = Infinity) {
  if (!s || s.codec !== 'cstm') return false;
  const ints = [s.channels, s.blocks, s.blockSize, s.blockSamples, s.lastBlockSize, s.lastBlockSamples, s.lastBlockPadded, s.samples, s.dataStart];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!s.channels || s.channels > 8 || !s.blocks || !s.samples) return false;
  if (!['dsp', 'pcm16', 'pcm8'].includes(s.format) || (s.format === 'dsp' && !(s.coefs?.length >= s.channels && s.hist?.length >= s.channels))) return false;
  if (!s.blockSize || s.blockSize > CSTM_MAX_BLOCK || !s.blockSamples || s.blockSamples > samplesIn(s.format, s.blockSize)) return false;
  if (s.lastBlockPadded > s.blockSize || s.lastBlockSize > s.lastBlockPadded || s.lastBlockSamples > s.blockSamples) return false;
  if (s.lastBlockSamples > samplesIn(s.format, s.lastBlockPadded)) return false;
  if (s.samples > s.blocks * s.blockSamples) return false;
  if (s.loop && !(s.loop.start >= 0 && s.loop.start < s.loop.end && s.loop.end <= s.samples)) return false;
  const end = s.dataStart + (s.blocks - 1) * s.blockSize * s.channels + s.lastBlockPadded * s.channels;
  return end <= length + s.blockSize;
}

/** Bytes per channel of block `i` (the last one is shorter, padded to 32 bytes). */
const blockBytes = (s, i) => (i === s.blocks - 1 ? s.lastBlockPadded : s.blockSize);

/**
 * Where block `i` of channel `c` starts in the file. Blocks follow each other with all channels' parts in a row: block i
 * of every channel, then block i + 1.
 */
export const cstmBlockAt = (s, i, c) => s.dataStart + i * s.blockSize * s.channels + c * blockBytes(s, i);

/**
 * The sample position a read of the file up to byte `off` (exclusive) gives the game – the end of the last whole block
 * that read reached – for the read-ahead (rommusic.mjs). Before the data: 0.
 */
export function cstmSamplesThrough(s, off) {
  const group = s.blockSize * s.channels;
  if (off <= s.dataStart) return 0;
  // the last block is shorter (lastBlockPadded per channel): whole once the read reaches its end
  if (off >= s.dataStart + (s.blocks - 1) * group + s.lastBlockPadded * s.channels) return (s.blocks - 1) * s.blockSamples + s.lastBlockSamples;
  return Math.min(Math.floor((off - s.dataStart) / group), s.blocks - 1) * s.blockSamples;
}

/** The first sample of the block holding file offset `off` (a read starting there), or -1 before the data. */
export function cstmSampleAt(s, off) {
  if (off < s.dataStart) return -1;
  const i = Math.floor((off - s.dataStart) / (s.blockSize * s.channels));
  return Math.min(i, s.blocks - 1) * s.blockSamples;
}

/** The decoder history at the start of block `i` for channel `c` from the SEEK entries (`seek`: its bytes), or null. */
export function cstmSeekHist(s, seek, i, c) {
  if (!seek || s.seekInterval !== s.blockSamples) return null;
  const o = (i * s.channels + c) * 4;
  return fits(seek, o, 4) ? [s16(seek, o), s16(seek, o + 2)] : null;
}

/**
 * DSP-ADPCM: decodes `n` samples of one channel from `src` (frames of 8 bytes: a header byte – predictor << 4 | scale
 * exponent – and 14 four-bit samples) starting at frame `frame`, sample `skip` within it, into `out` (Int16Array or
 * Float32Array scaled to ±1 by `scale`), with history `h` = [yn1, yn2] (updated). Returns the samples written.
 */
export function dspDecode(src, coefs, h, out, n, { from = 0, skip = 0, at = 0, scale = 1 } = {}) {
  let yn1 = h[0];
  let yn2 = h[1];
  let w = 0;
  let p = from;
  let s = skip;
  while (w < n && p + 8 <= src.length) {
    const ps = src[p];
    const c1 = coefs[(ps >> 4) * 2] || 0;
    const c2 = coefs[(ps >> 4) * 2 + 1] || 0;
    const sc = 1 << (ps & 0xf);
    for (let k = 0; k < 14; k++) {
      const byte = src[p + 1 + (k >> 1)];
      let nib = k & 1 ? byte & 0xf : byte >> 4;
      if (nib >= 8) nib -= 16;
      let v = ((nib * sc) << 11) + 1024 + c1 * yn1 + c2 * yn2;
      v >>= 11;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      yn2 = yn1;
      yn1 = v;
      if (s > 0) {
        s--;
        continue;
      }
      if (w < n) out[at + w++] = v * scale;
    }
    p += 8;
  }
  h[0] = yn1;
  h[1] = yn2;
  return w;
}

/**
 * Decodes block `i` of a BCSTM (all channels) from the whole file's bytes `file`: Int16Array per channel
 * (blockSamples long, the last block shorter). `hist`: the history at the block start per channel (SEEK entries,
 * or carried over from the block before). PCM streams are copied.
 */
export function cstmDecodeBlock(s, file, i, hist) {
  const len = i === s.blocks - 1 ? s.lastBlockSamples : s.blockSamples;
  const out = [];
  for (let c = 0; c < s.channels; c++) {
    const at = cstmBlockAt(s, i, c);
    const o = new Int16Array(len);
    if (s.format === 'dsp') {
      const h = hist?.[c] ? [hist[c][0], hist[c][1]] : [0, 0];
      dspDecode(file, s.coefs[c], h, o, len, { from: at });
      if (hist) hist[c] = h;
    } else if (s.format === 'pcm16') {
      for (let k = 0; k < len && at + k * 2 + 1 < file.length; k++) o[k] = s16(file, at + k * 2);
    } else {
      for (let k = 0; k < len && at + k < file.length; k++) o[k] = ((file[at + k] << 24) >> 24) * 256;
    }
    out.push(o);
  }
  return out;
}

// ---- ADTS (AAC) ------------------------------------------------------------------------------------------------------
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** One ADTS frame header at `o`: { len, rate, channels, samples } or null. */
export function adtsHeader(b, o) {
  if (!fits(b, o, 7) || b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return null; // sync, layer 0
  const rate = ADTS_RATES[(b[o + 2] >> 2) & 0xf];
  const channels = ((b[o + 2] & 1) << 2) | (b[o + 3] >> 6);
  const len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5);
  const hdr = b[o + 1] & 1 ? 7 : 9;
  if (!rate || !channels || len <= hdr) return null;
  return { len, rate, channels, samples: ((b[o + 6] & 3) + 1) * 1024, profile: (b[o + 2] >> 6) + 1 };
}

/** Is `b` (a file's first bytes) an ADTS stream? Three frames in a row that agree. */
export function adtsSniff(b) {
  let o = 0;
  let first = null;
  for (let k = 0; k < 3; k++) {
    const h = adtsHeader(b, o);
    if (!h) return k >= 2 && o >= b.length - 9 ? first : null; // (a short file: two frames are enough)
    if (first && (h.rate !== first.rate || h.channels !== first.channels)) return null;
    first ||= h;
    o += h.len;
  }
  return first;
}

/**
 * The frames of a whole ADTS file: { rate, channels, samples, offsets: Float64Array (file offset of each frame),
 * starts: Float64Array (its first sample) } – stops at the first damaged frame. null when the start isn't ADTS.
 */
export function adtsFrames(b) {
  const first = adtsHeader(b, 0);
  if (!first) return null;
  const offs = [];
  const starts = [];
  let o = 0;
  let pos = 0;
  for (;;) {
    const h = adtsHeader(b, o);
    if (!h || o + h.len > b.length) break;
    offs.push(o);
    starts.push(pos);
    pos += h.samples;
    o += h.len;
  }
  return { rate: first.rate, channels: first.channels, samples: pos, offsets: Float64Array.from(offs), starts: Float64Array.from(starts) };
}

/** ADTS: the first sample of the frame holding byte `off` (binary search), or -1. */
export function adtsSampleAt(t, off) {
  const o = t.offsets;
  if (!o.length || off < o[0]) return -1;
  let lo = 0;
  let hi = o.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (o[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return t.starts[lo];
}

/** ADTS: the samples of all frames that end at or before byte `off` (what a read up to there gives the game). */
export function adtsSamplesThrough(t, off) {
  const o = t.offsets;
  let lo = 0;
  let hi = o.length; // frames [0, lo) are complete
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const end = mid + 1 < o.length ? o[mid + 1] : Infinity;
    if (end <= off) lo = mid + 1;
    else hi = mid;
  }
  return lo < o.length ? t.starts[lo] : t.samples;
}

// ---- the registry ----------------------------------------------------------------------------------------------------
/**
 * The codecs, tried in this order on a file's first SNIFF_BYTES: sniff(head) → { codec, rate, channels, … } or null.
 * `kind`: 'stream' (the whole file is one piece of music) – more kinds (e.g. a wave inside an archive) can follow.
 */
export const CODECS = [
  { id: 'cstm', kind: 'stream', sniff: (b) => cstmInfo(b) },
  {
    id: 'adts', kind: 'stream', sniff: (b) => {
      const h = adtsSniff(b);
      return h && h.profile === 2 ? { codec: 'adts', rate: h.rate, channels: h.channels } : null; // (AAC-LC only)
    },
  },
];

/** The stream a file's first bytes are, or null: { codec, … } from the first codec that takes it. Never throws. */
export function sniffStream(head) {
  for (const c of CODECS) {
    try {
      const r = c.sniff(head);
      if (r) return r;
    } catch {
      // that codec's problem: not one of its streams
    }
  }
  return null;
}

// ---- BCSAR (the sound archive): the loop of every stream sound, by its file ------------------------------------------
/**
 * The stream sounds of a BCSAR ("CSAR"): Map of the external file's name (lower case, without folders – the BCSAR's own
 * file table names it, e.g. "bgm_xy_starting.aac") → { loop: { start, end } | null, name } – `name` the sound's label
 * when the string block has one. X/Y keep their AAC music's loop points only here. Never throws: an unknown layout
 * gives an empty map.
 *
 * Layout: header "CSAR", block refs at 0x14 { u16 type, u16 pad, u32 offset, u32 size } (0x2000 STRG, 0x2001 INFO,
 * 0x2002 FILE). INFO body (offset + 8): references { u16 type, u16 pad, u32 offset } relative to the body – 0x2100 the
 * sound table, 0x2106 the file table. A table: u32 count, then references relative to the table. A sound entry: u32 file
 * id, u32 player id, u8 volume …, then at +0x0C a reference to its details (0x2201 = a stream sound: loop start at
 * +0x14, loop end at +0x18 when the flag at +0x1C is set). A file entry: a reference (0x220D = external) to a
 * NUL-terminated path relative to the entry.
 */
export function bcsarStreams(b) {
  const out = new Map();
  try {
    if (!b || b.length < 0x40 || tag(b, 0) !== 'CSAR') return out;
    const nBlocks = u16(b, 0x10);
    let info = -1;
    let strg = -1;
    for (let i = 0; i < nBlocks && i < 8; i++) {
      const o = 0x14 + i * 12;
      if (!fits(b, o, 12)) return out;
      const type = u16(b, o);
      if (type === 0x2001) info = u32(b, o + 4);
      else if (type === 0x2000) strg = u32(b, o + 4);
    }
    if (info < 0 || !fits(b, info, 8) || tag(b, info) !== 'INFO') return out;
    const body = info + 8;
    const refOf = (type) => {
      for (let k = 0; k < 8; k++) {
        const o = body + k * 8;
        if (!fits(b, o, 8)) return -1;
        if (u16(b, o) === type) return body + u32(b, o + 4);
      }
      return -1;
    };
    const sounds = refOf(0x2100);
    const filesAt = refOf(0x2106);
    if (sounds < 0 || filesAt < 0 || !fits(b, sounds, 4) || !fits(b, filesAt, 4)) return out;
    const table = (at, i) => at + u32(b, at + 4 + i * 8 + 4);
    // file id → external path
    const nFiles = Math.min(u32(b, filesAt), 100000);
    const paths = new Array(nFiles).fill(null);
    const budget = { left: BCSAR_CHARS };
    for (let i = 0; i < nFiles && budget.left > 0; i++) {
      const e = table(filesAt, i);
      if (!fits(b, e, 8) || u16(b, e) !== 0x220d) continue;
      paths[i] = cString(b, e + u32(b, e + 4), budget);
    }
    const names = strg >= 0 ? bcsarStrings(b, strg, budget) : [];
    const nSounds = Math.min(u32(b, sounds), 100000);
    for (let i = 0; i < nSounds; i++) {
      const e = table(sounds, i);
      if (!fits(b, e, 0x14) || u16(b, e + 0x0c) !== 0x2201) continue;
      const path = paths[u32(b, e)];
      if (!path) continue;
      const ss = e + u32(b, e + 0x10);
      if (!fits(b, ss, 0x20)) continue;
      const start = u32(b, ss + 0x14);
      const end = u32(b, ss + 0x18);
      // (a stream sound without a loop has the next reference there instead: 1, 0x220E – never a loop)
      const looped = u32(b, ss + 0x1c) === 1 && !(start === 1 && end === 0x220e);
      const key = path.toLowerCase().split(/[\\/]/).pop();
      out.set(key, { loop: looped && start < end ? { start, end } : null, name: names[i] || null });
    }
  } catch {
    // damaged: what was found so far
  }
  return out;
}

/** A BCSAR's strings (paths, labels) are at most this long – longer is damage (real ones: under 64 characters). */
const BCSAR_STR = 256;
/** The characters read from one BCSAR's strings together: thousands of entries pointing at one long run cost no more. */
const BCSAR_CHARS = 4 * 1024 * 1024;

/** The NUL-terminated string at `o` (at most BCSAR_STR characters, `len` when given), counted against `budget`. */
function cString(b, o, budget, len = BCSAR_STR) {
  const n = Math.min(len, BCSAR_STR, budget.left, Math.max(0, b.length - o));
  let s = '';
  for (let k = 0; k < n && b[o + k]; k++) s += String.fromCharCode(b[o + k]);
  budget.left -= s.length + 1;
  return s;
}

/** The STRG block's string table (labels, in item order), or []. */
function bcsarStrings(b, strg, budget = { left: BCSAR_CHARS }) {
  const out = [];
  try {
    if (!fits(b, strg, 0x18) || tag(b, strg) !== 'STRG') return out;
    const body = strg + 8;
    if (u16(b, body) !== 0x2400) return out;
    const t = body + u32(b, body + 4);
    const n = Math.min(u32(b, t), 100000);
    for (let i = 0; i < n && budget.left > 0; i++) {
      const e = t + 4 + i * 12;
      if (!fits(b, e, 12)) break;
      const o = t + u32(b, e + 4);
      out.push(o >= 0 && o < b.length ? cString(b, o, budget, u32(b, e + 8)) : '');
    }
  } catch {
    // keep what was read
  }
  return out;
}
