// "Music from the ROM" in the 3DS player (lib/ctrplayer.mjs): the game's RomFS reads (ctrhost.c message 9) go to the
// tracker (shared/ctr/rommusic.mjs), which says which music stream plays and where; this module reads what it needs
// through the core (ROMREAD: the RomFS tables, a file's first bytes, the whole track – the game's own RomFS, its update's
// or a LayeredFS mod's, as the game sees it), hands the track to the turbo mixer's voice (lib/romvoice.mjs) and tells it
// the game's position with every batch of reads – in band, so it lines up with the game's sound to the sample.
//
//   BCSTM   the file's bytes go to the worklet as they are (it decodes as it plays)
//   AAC     decoded here by the browser (decodeAudioData – Chromium resamples to the context's rate), loop points from
//           the game's sound archive (BCSAR) when it has them, else learned from the reads
//
// Anything that can't be read, parsed or decoded leaves the mixer as it was (its recorded loops: "music continues").
// The lead of the game's stream reader (how far its reads run ahead of its sound) is measured once per codec against the
// game's own 1× sound (calibrate) – until then the tracker's default (measured on Pokémon Sun).

import { RomMusicTracker, FRAME_SEC, isJingle } from '../../shared/ctr/rommusic.mjs';
import { romfsHeader, romfsFiles } from '../../shared/ctr/romfs.mjs';
import { sniffStream, SNIFF_BYTES, adtsFrames, bcsarStreams, cstmDecodeBlock, cstmSeekHist, cstmSane } from '../../shared/ctr/streams.mjs';
import { filesSig } from '../../shared/ctr/musicindex.mjs';

const CHUNK = 1024 * 1024; // one ROMREAD (ctrhost.c ROMREAD_MAX)
const MAX_TRACK = 64 * 1024 * 1024; // a stream file bigger than this isn't loaded
// ROMREADs: at most MAX_INFLIGHT out at once (the host queues 32 and answers "can't" beyond that); one that gets no answer
// within READ_TIMEOUT ms of play (paused time doesn't count: the host answers between frames) is "no answer" – never "not
// music" or "no files": what needed it is asked again RETRY_MS later, doubling up to RETRY_MAX_MS, RETRIES times at most
const MAX_INFLIGHT = 8;
const READ_TIMEOUT = 10000;
const RETRY_MS = 1000;
const RETRY_MAX_MS = 60000;
const RETRIES = 10;
const LOAD_RETRIES = 5; // a track that failed to load is tried again this often (backing off like the reads)
const SAR_BUDGET = 128 * 1024 * 1024; // bytes read looking for a sound archive's loops (per RomFS)
/** AAC encoder delay: the first 1024 decoded samples come before the stream's sample 0 (BCSAR loop points don't count them). */
export const AAC_PRIMING = 1024;
const LOG_EVERY = 10000; // ms: repeated restarts of one stream are summed up this often in the music log
const CAL_DECIM = 8; // the calibration compares the sound at a eighth of the rate (~4 kHz), then refines at full rate
const CAL_WIN = 1.0; // seconds of the game's sound compared
const CAL_RANGE = 0.4; // ± seconds searched around the tracker's position (0.8 while it is only placed by the start)
// When nothing in that range matches, the line may be off by more than it (a reader whose lead isn't the default – X/Y's
// AAC reader reads seconds ahead, and its calibration never took: every score 0.1–0.4 at random offsets, while the game's
// sound matched the decoded track at 0.97–0.99 elsewhere). Then a wide search: a longer stretch of the game's sound
// (less likely to match a repeated bar), ± CAL_WIDE seconds, coarse first (every 32nd sample), taken only when its peak
// stands out from every other place by CAL_MARGIN and two wide searches in a row agree.
const CAL_WIDE = 3.5;
const CAL_WIDE_WIN = 2.5;
const CAL_WIDE_DECIM = 32;
const CAL_MARGIN = 0.08;
// The measurement runs in slices of at most CAL_SLICE_MS (the page's main thread draws the game and runs the input), at
// most every CAL_EVERY ms, backing off (doubling up to CAL_EVERY_MAX) while nothing is taken, CAL_TRACK_TRIES per track
const CAL_SLICE_MS = 6;
const CAL_EVERY = 3000;
const CAL_EVERY_MAX = 60000;
const CAL_TRACK_TRIES = 16;
/**
 * How alike the game's sound and the track must be to take the measurement. The score is the better of the full-band
 * correlation and the one below ~2 kHz: the game's AAC decoder and resampler (Azahar's) and the browser's don't give the
 * same top end – Pokémon Y measured 0.83 full-band where a BCSTM gives 1.000 – while the music underneath is the same.
 */
export const CAL_SCORE = { cstm: 0.85, adts: 0.7 };

/** Parses a ROMFS payload: { frame, fast (that frame was fast-forwarded), reads: [{ serial, tag, off, len, frame }] }. */
export function parseRomfs(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (p.byteLength < 16) return { frame: 0, fast: false, reads: [] };
  const frame = Number(v.getBigUint64(0, true));
  const fast = !!(v.getUint32(12, true) & 1);
  const n = Math.min(v.getUint32(8, true), Math.floor((p.byteLength - 16) / 32));
  const reads = [];
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 32;
    reads.push({ serial: Number(v.getBigUint64(o, true)), off: Number(v.getBigUint64(o + 8, true)), len: v.getUint32(o + 16, true), tag: v.getUint32(o + 20, true), frame: Number(v.getBigUint64(o + 24, true)) });
  }
  return { frame, fast, reads };
}

/** A RomFS read that got no answer (or "can't" / "busy", or the host started anew): try again later – not a fact about the file. */
export class RomReadRetry extends Error {
  constructor(why, soon = false) {
    super(`no answer from the host (${why})`);
    this.soon = soon; // (the host started anew: ask again right away)
  }
}

const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** Runs a generator (the sliced work below) to its end at once. */
function runSync(gen) {
  let r;
  while (!(r = gen.next()).done);
  return r.value;
}

/** A ROMREAD command payload. */
export function romReadPayload(id, tag, off, len) {
  const b = new Uint8Array(20);
  const v = new DataView(b.buffer);
  v.setUint32(0, id, true);
  v.setUint32(4, tag, true);
  v.setBigUint64(8, BigInt(off), true);
  v.setUint32(16, len, true);
  return b;
}

export class RomMusic {
  /**
   * `send(payload)`: a ROMREAD to the host (resolves false when it never got there). `tell(msg, transfer)`: to the
   * worklet. `ctx`: the AudioContext (decoding AAC, its rate). `log(e)`: the music log for "Save diagnostics".
   */
  constructor({ send, tell, ctx = null, rate = 32728, log = () => {}, index = null, fetchBytes = null, ranges = null }) {
    this.send = send;
    // `ranges(tag, pairs)`: where the music streams of a RomFS are ([start, end) in its level 3) – the core recognises the
    // voices that play them and leaves them out of the game's sound while it fast-forwards (sound effects: sfxplayer.mjs)
    this.ranges = ranges;
    this.streamRanges = new Map(); // tag → Map(start → end)
    // the server's index of the game file's own streams (shared/ctr/musicindex.mjs) and its bytes over HTTP – used for
    // the RomFS whose tables are that file's (sig); any other RomFS (an update's, a mod's) is read through the core
    this.index = index; // Promise<index | null> | null
    this.fetchBytes = fetchBytes; // (off, len) → Promise<Uint8Array | null>, offsets in the file's RomFS level 3
    this.direct = new Set(); // tags that are the game file's own RomFS
    this.tell = tell;
    this.ctx = ctx;
    this.rate = ctx?.sampleRate || rate;
    this.log = log;
    this.ids = 0;
    this.waiting = new Map(); // ROMREAD id → { done(answer) }
    this.queue = []; // ROMREADs not sent yet (MAX_INFLIGHT)
    this.paused = false; // the game is paused: the host answers nothing, and no ROMREAD times out
    this.retries = new Map(); // need key → attempts that got no answer
    this.retryTimers = new Map(); // need key → { timer, need }
    this.tracks = new Map(); // stream key → { state: 'loading' | 'ready' | 'failed', ratio (voice samples per track sample), pcm? }
    this.sars = new Map(); // tag → Promise<Map> (the sound archive's stream loops)
    this.enabled = true;
    this.last = null; // the key last told to the worklet
    this.tracker = new RomMusicTracker({ onEvent: (e) => this.onTrack(e), onForget: (tag) => this.forget(tag) });
    this.game = { l: new Float32Array(Math.round(this.rate * 4)), at: 0, frame: -1, frameAt: 0 }; // the game's 1× sound (mono), for calibrate
    this.cal = new Map(); // codec → { tries, done }
    this.calTracks = new Map(); // stream key → { tries, fails } (the backoff of the measurement per track)
    this.calJob = null; // Promise of the measurement running now
    this.busy = false;
    this.starts = new Map(); // stream key → when it last (re)started (onTrack)
    this.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  // ---- talking to the host ---------------------------------------------------------------------------------------
  /**
   * Bytes of RomFS `tag`: Uint8Array (shorter at its end), or null (the RomFS is gone). Throws RomReadRetry when the host
   * didn't answer, said "can't" (busy) or started anew – the caller asks again later.
   */
  async read(tag, off, len) {
    if (this.direct.has(tag) && this.fetchBytes) {
      const b = await this.fetchBytes(off, len).catch(() => null);
      if (b) return b;
    }
    const out = new Uint8Array(len);
    let got = 0;
    while (got < len) {
      const n = Math.min(CHUNK, len - got);
      const r = await this.readOnce(tag, off + got, n);
      if (r.status === 2) return null; // (ctrhost.c: the RomFS is gone)
      if (r.status !== 0) throw new RomReadRetry(r.status === -1 ? 'timeout' : r.status === -2 ? 'host restarted' : `status ${r.status}`, r.status === -2);
      out.set(r.bytes, got);
      got += r.bytes.length;
      if (r.bytes.length < n) break;
    }
    return out.subarray(0, got);
  }

  /** One ROMREAD: the host's answer { status, size, bytes } – status −1: no answer in time, −2: the host started anew. */
  readOnce(tag, off, len) {
    return new Promise((resolve) => {
      this.queue.push({ tag, off, len, resolve });
      this.pump();
    });
  }

  /** Sends what waits, MAX_INFLIGHT at a time. */
  pump() {
    while (this.waiting.size < MAX_INFLIGHT && this.queue.length) {
      const q = this.queue.shift();
      const id = (this.ids = (this.ids + 1) >>> 0);
      const w = { left: READ_TIMEOUT, since: 0, timer: null, over: false };
      w.done = (r) => {
        if (w.over) return;
        w.over = true;
        clearTimeout(w.timer);
        this.waiting.delete(id);
        q.resolve(r);
        this.pump();
      };
      this.waiting.set(id, w);
      this.arm(w);
      Promise.resolve(this.send(romReadPayload(id, q.tag, q.off, q.len))).then(
        (ok) => ok === false && w.done({ status: -1 }),
        () => w.done({ status: -1 }),
      );
    }
  }

  /** Starts a ROMREAD's timeout – the time it has left (not while paused). */
  arm(w) {
    if (this.paused || w.over) return;
    w.since = perfNow();
    w.timer = setTimeout(() => w.done({ status: -1 }), Math.max(0, w.left));
  }

  /** The game paused / went on (lib/ctrplayer.mjs): the host answers nothing while paused – no ROMREAD times out then. */
  pause(on) {
    on = !!on;
    if (on === this.paused) return;
    this.paused = on;
    for (const w of this.waiting.values()) {
      if (on) {
        clearTimeout(w.timer);
        w.left -= perfNow() - w.since;
      } else this.arm(w);
    }
  }

  /**
   * A new host (lib/ctrplayer.mjs: "loaded" again – the server started it anew): what it was asked never comes. Every
   * ROMREAD out is asked again, what waits for a retry is asked now, and a track that failed may load again.
   */
  hostRestarted() {
    this.retries.clear();
    for (const w of [...this.waiting.values()]) w.done({ status: -2 });
    for (const [k, r] of [...this.retryTimers]) {
      clearTimeout(r.timer);
      this.retryTimers.delete(k);
      this.fetch(r.need);
    }
    for (const t of this.tracks.values()) {
      if (t.state === 'failed') {
        t.fails = 0;
        t.retryAt = 0;
      }
    }
  }

  /** ROMDATA (ctrhost.c message 10). */
  onRomData(p) {
    if (p.byteLength < 16) return;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const id = v.getUint32(0, true);
    this.waiting.get(id)?.done({ status: v.getUint32(4, true), size: Number(v.getBigUint64(8, true)), bytes: p.slice(16) });
  }

  // ---- the reads -------------------------------------------------------------------------------------------------
  /** The sound worklet's context, once it is up (AAC is decoded with it; until then only BCSTM tracks load). */
  attach(ctx) {
    this.ctx = ctx;
    this.rate = ctx?.sampleRate || this.rate;
  }

  /** ROMFS (ctrhost.c message 9) – right before that frame's sound (lib/ctrplayer.mjs calls this before posting it). */
  onRomfs(p) {
    const { frame, fast, reads } = parseRomfs(p);
    this.fast = fast;
    this.game.frame = frame; // the sound that follows is this frame's (calibrate)
    this.game.frameAt = this.game.at;
    if (reads.length) {
      for (const need of this.tracker.reads(reads)) this.fetch(need);
    }
    this.tracker.tick(frame);
    if (this.enabled) this.sync(frame); // (the reads are followed in every mode – the track is only loaded for "music")
  }

  /** The game's position (in band: it applies when the sound that follows plays). */
  sync(frame) {
    const p = this.tracker.playing(frame);
    if (!p) {
      if (this.last !== null) this.tell({ type: 'rom-sync', id: null, inband: true });
      this.last = null;
      return;
    }
    let t = this.tracks.get(p.key);
    if ((!t || (t.state === 'failed' && this.now() >= t.retryAt)) && (p.info.codec !== 'adts' || this.ctx)) {
      this.load(p, t);
      t = this.tracks.get(p.key);
    }
    if (t?.state === 'failed') {
      // the track the game plays now can't be had (for now): the mixer goes back to its own music – the track before
      // must not go on as if it were this place's music
      if (this.last !== null || this.dropped !== p.key) this.tell({ type: 'rom-sync', id: null, inband: true, drop: true });
      this.last = null;
      this.dropped = p.key;
      return;
    }
    if (!t || t.state !== 'ready') return; // (told once it's there – the worklet then catches up by the time it took)
    this.dropped = null;
    // (`slow`: from a 1× frame – only those line the track up with the game's 1× sound; a fast-forwarded frame's
    // position is behind by the frames the game raced through before the sound after it plays)
    this.tell({ type: 'rom-sync', id: p.key, pos: t.voicePos(p.pos), slow: !this.fast, inband: true });
    this.last = p.key;
    this.maybeCalibrate(p, t);
  }

  /** What a need is called in the retry tables (its tag first: let go with it). */
  needKey(need) {
    return need.type === 'files' ? `${need.tag}|files` : `${need.tag}|head|${need.file?.start}`;
  }

  async fetch(need) {
    // (the tag's state as it was asked for: a tag let go meanwhile (MAX_TAGS) doesn't come back with a late answer)
    const x0 = this.tracker.tags.get(need.tag);
    const live = () => this.tracker.tags.get(need.tag) === x0;
    try {
      if (need.type === 'files') {
        const h = romfsHeader(await this.read(need.tag, 0, 0x28));
        let files = [];
        if (h) {
          const dirs = await this.read(need.tag, h.dirMeta.off, h.dirMeta.len);
          const fl = await this.read(need.tag, h.fileMeta.off, h.fileMeta.len);
          if (dirs && fl) files = romfsFiles(h, dirs, fl);
        }
        const idx = files.length && this.index ? await this.index.catch(() => null) : null;
        if (!live()) return;
        this.retries.delete(this.needKey(need));
        const own = !!idx && idx.sig === filesSig(files);
        if (own) this.direct.add(need.tag);
        const more = this.tracker.setFiles(need.tag, files);
        if (own) {
          // the game file's own RomFS: its streams are known – every other file isn't music (no probing); AAC still needs
          // its frames (read when the game first reads it), with the sound archive's loop from the index
          this.loops = idx.loops || {};
          const known = new Map(idx.streams.map((x) => [x.start, x]));
          for (const x of idx.streams) this.addRange(need.tag, x.start, x.size);
          this.tellRanges(need.tag);
          for (const f of files) {
            const k = known.get(f.start);
            if (!k) this.tracker.setInfo(need.tag, f, null);
            else if (k.info.codec !== 'adts') this.tracker.setInfo(need.tag, f, cstmSane(k.info) ? k.info : null);
          }
        }
        this.log({ type: 'romfs', tag: need.tag, files: files.length, own });
        for (const n of more) if (this.tracker.tags.get(n.tag)?.infos.get(n.file?.start) === undefined || n.type === 'files') this.fetch(n);
      } else if (need.type === 'head') {
        const f = need.file;
        const head = f.size >= 16 ? await this.read(need.tag, f.start, Math.min(SNIFF_BYTES, f.size)) : null;
        let info = head ? sniffStream(head) : null;
        if (info?.codec === 'adts') info = await this.adtsInfo(need.tag, f, info);
        if (!live()) return;
        this.retries.delete(this.needKey(need));
        this.tracker.setInfo(need.tag, f, info);
        if (info && this.addRange(need.tag, f.start, f.size)) this.tellRanges(need.tag);
        if (info) this.log({ type: 'stream', path: f.path, codec: info.codec, rate: info.rate, seconds: +(info.samples / info.rate).toFixed(1), loop: info.loop || null, jingle: isJingle(info, f.path) });
      }
    } catch (e) {
      if (!live()) return;
      if (e instanceof RomReadRetry && this.retryLater(need, e)) return;
      if (need.type === 'files') this.tracker.setFiles(need.tag, []);
      else this.tracker.setInfo(need.tag, need.file, null);
      this.log({ type: 'error', where: need.type, message: String(e?.message || e) });
    }
  }

  /**
   * A need whose reads got no answer: asked again later (doubling the wait) – meanwhile the tracker keeps it "asked", so
   * the game's reads wait for it. False once it has been tried RETRIES times (then it is given up as unreadable).
   */
  retryLater(need, e) {
    const k = this.needKey(need);
    const n = e.soon ? 0 : (this.retries.get(k) || 0) + 1;
    if (n > RETRIES) {
      this.retries.delete(k);
      return false;
    }
    this.retries.set(k, n);
    clearTimeout(this.retryTimers.get(k)?.timer);
    const ms = n ? Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (n - 1)) : 0;
    const timer = setTimeout(() => {
      this.retryTimers.delete(k);
      this.fetch(need);
    }, ms);
    this.retryTimers.set(k, { timer, need });
    if (n <= 1 || n === RETRIES) this.log({ type: 'rom-retry', where: need.type, tag: need.tag, path: need.file?.path ?? null, attempt: n, inMs: ms, message: e.message });
    return true;
  }

  /** RomFS `tag` was let go (the tracker's MAX_TAGS): what is kept here for it goes too. */
  forget(tag) {
    this.sars.delete(tag);
    this.streamRanges.delete(tag);
    this.direct.delete(tag);
    const pre = `${tag}:`;
    for (const k of [...this.tracks.keys()]) if (k.startsWith(pre) && k !== this.tracker.cur?.key) this.tracks.delete(k);
    for (const k of [...this.starts.keys()]) if (k.startsWith(pre)) this.starts.delete(k);
    for (const k of [...this.calTracks.keys()]) if (k.startsWith(pre)) this.calTracks.delete(k);
    const rk = `${tag}|`;
    for (const k of [...this.retries.keys()]) if (k.startsWith(rk)) this.retries.delete(k);
    for (const [k, r] of [...this.retryTimers]) {
      if (!k.startsWith(rk)) continue;
      clearTimeout(r.timer);
      this.retryTimers.delete(k);
    }
    this.log({ type: 'rom-forget', tag });
  }

  /** A music stream at [start, start + size) of RomFS `tag` (jingles too – they are music, not sound effects). */
  addRange(tag, start, size) {
    let m = this.streamRanges.get(tag);
    if (!m) this.streamRanges.set(tag, (m = new Map()));
    if (m.get(start) === start + size) return false;
    m.set(start, start + size);
    return true;
  }

  tellRanges(tag) {
    const m = this.streamRanges.get(tag);
    if (!this.ranges || !m) return;
    try {
      this.ranges(tag, [...m].sort((a, b) => a[0] - b[0]));
    } catch {
      // the page's problem
    }
  }

  /** Has a track ever been ready to play (the worklet has the game's music)? */
  get hasTrack() {
    for (const t of this.tracks.values()) if (t.state === 'ready') return true;
    return false;
  }

  /** An AAC stream: its frames (the whole file), its loop from the sound archive. */
  async adtsInfo(tag, f, head) {
    if (f.size > MAX_TRACK) return null;
    const bytes = await this.read(tag, f.start, f.size);
    const frames = bytes && adtsFrames(bytes);
    if (!frames || frames.samples < head.rate) return null;
    const name = f.path.split('/').pop().toLowerCase();
    const fromSar = this.direct.has(tag) && this.loops && name in this.loops ? { loop: this.loops[name] } : (await this.soundArchive(tag, f)).get(name);
    const info = { codec: 'adts', rate: frames.rate, channels: frames.channels, samples: Math.max(0, frames.samples - AAC_PRIMING), priming: AAC_PRIMING, frames, loop: fromSar?.loop || null, bytes };
    return info;
  }

  /**
   * The stream loops of the sound archive next to a stream (BCSAR): the files whose header says "CSAR" – the ones named
   * .bcsar first, then any other in the stream's folder. Only its STRG and INFO blocks are read (the rest is waves).
   */
  soundArchive(tag, f) {
    if (this.sars.has(tag)) return this.sars.get(tag);
    const p = (async () => {
      const files = this.tracker.tags.get(tag)?.files || [];
      const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
      const named = files.filter((x) => /\.bcsar$/i.test(x.path));
      const near = files.filter((x) => x.path.startsWith(dir) && !named.includes(x) && x.size > 0x1000 && x.size < 512 * 1024 * 1024 && x.path.indexOf('/', dir.length) < 0).slice(0, 64);
      const all = new Map();
      const done = new Set();
      let budget = SAR_BUDGET;
      for (const c of [...named, ...near]) {
        if (done.has(c.start) || budget <= 0) continue; // (files at one place are one archive)
        done.add(c.start);
        const h = await this.read(tag, c.start, 0x40);
        if (!h || String.fromCharCode(...h.subarray(0, 4)) !== 'CSAR') continue;
        // block refs at 0x14: read up to the end of STRG and INFO (whichever ends later)
        const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
        let end = 0x40;
        for (let i = 0; i < Math.min(v.getUint16(0x10, true), 3); i++) {
          const type = v.getUint16(0x14 + i * 12, true);
          const at = v.getUint32(0x18 + i * 12, true);
          if ((type === 0x2000 || type === 0x2001) && at !== 0xffffffff) end = Math.max(end, at + v.getUint32(0x1c + i * 12, true)); // (no STRG: 0xFFFFFFFF)
        }
        if (end > 64 * 1024 * 1024) continue;
        budget -= Math.min(end, c.size);
        const b = await this.read(tag, c.start, Math.min(end, c.size));
        for (const [k, x] of bcsarStreams(b)) all.set(k, x);
        if (all.size) break;
      }
      return all;
    })().catch((e) => {
      if (!(e instanceof RomReadRetry)) return new Map();
      if (this.sars.get(tag) === p) this.sars.delete(tag); // (no answer: asked again with the stream's retry)
      throw e;
    });
    this.sars.set(tag, p);
    return p;
  }

  // ---- the track for the worklet -----------------------------------------------------------------------------------
  /**
   * Loads the track `p` (tracker.playing) and hands it to the worklet. `prev`: the entry of a load that failed before
   * (its failures count on: the next try waits twice as long). A track that fails is tried again later (sync).
   */
  async load(p, prev = null) {
    const key = p.key;
    const t = { state: 'loading', ratio: 1, voicePos: (x) => x, fails: prev?.fails || 0, retryAt: 0 };
    this.tracks.set(key, t);
    try {
      const info = p.info;
      if (info.codec === 'cstm') {
        if (p.file.size > MAX_TRACK) throw new Error('track too big');
        const file = await this.read(p.tag, p.file.start, p.file.size);
        if (!file || file.length < p.file.size) throw new Error('track not readable');
        if (!cstmSane(info, file.length)) throw new Error('track damaged');
        const plain = { ...info, coefs: info.coefs.map((c) => Int16Array.from(c)), hist: info.hist.map((h) => [...h]) };
        if (this.tracks.get(key) !== t) return;
        t.file = file; // (kept for calibrate – the worklet gets its own copy)
        t.info = plain;
        this.tell({ type: 'rom-track', id: key, kind: 'cstm', file: file.slice(), info: plain });
        t.ratio = 1;
      } else if (info.codec === 'adts') {
        // (the file's bytes: read again when the worklet let the track go – they aren't kept after decoding)
        let bytes = info.bytes;
        if (!bytes) {
          if (p.file.size > MAX_TRACK) throw new Error('track too big');
          bytes = await this.read(p.tag, p.file.start, p.file.size);
          if (!bytes || bytes.length < p.file.size) throw new Error('track not readable');
        }
        delete info.bytes;
        const pcm = await this.decodeAac(info, bytes);
        if (this.tracks.get(key) !== t) return;
        const ratio = this.rate / info.rate;
        const loop = info.loop ? { start: Math.round(info.loop.start * ratio), end: Math.round(info.loop.end * ratio) } : null;
        t.pcm = pcm; // (kept for calibrate)
        t.loop = loop;
        t.ratio = ratio;
        t.voicePos = (x) => x * ratio;
        this.tell({ type: 'rom-track', id: key, kind: 'pcm', l: pcm.l.slice(), r: pcm.r.slice(), rate: this.rate, loop });
      } else throw new Error(`no player for ${info.codec}`);
      t.state = 'ready';
      t.fails = 0;
      if (!t.voicePos || info.codec === 'cstm') t.voicePos = (x) => x;
      this.log({ type: 'rom-ready', path: p.file.path });
      this.sync(this.tracker.frame);
      // only the playing track's samples are kept here (calibrate) – the worklet keeps its own three
      for (const [k, x] of this.tracks) {
        if (k === key) continue;
        delete x.pcm;
        delete x.file;
        if (this.tracks.size > 4 && x.state !== 'loading') this.tracks.delete(k);
      }
    } catch (e) {
      if (this.tracks.get(key) !== t) return;
      t.state = 'failed';
      const soon = e instanceof RomReadRetry && e.soon; // (the host started anew: right away, not counted)
      if (!soon) t.fails++;
      const ms = soon ? 0 : t.fails < LOAD_RETRIES ? Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (t.fails - 1)) : Infinity;
      t.retryAt = this.now() + ms;
      this.log({ type: 'rom-failed', path: p.file.path, message: String(e?.message || e), attempt: t.fails, retryInMs: Number.isFinite(ms) ? ms : null });
      this.sync(this.tracker.frame); // (the mixer hears of it now – not with the next reads)
    }
  }

  /** AAC (`bytes`: the whole file) → Int16 per channel at the context's rate, the encoder delay taken off (index 0 = the stream's sample 0). */
  async decodeAac(info, bytes = info.bytes) {
    if (!this.ctx) throw new Error('no audio context');
    if (!bytes) throw new Error('no bytes');
    const buf = await this.ctx.decodeAudioData(bytes.slice().buffer);
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const skip = Math.round((primingOf(buf, info) * buf.sampleRate) / info.rate);
    const n = Math.max(0, L.length - skip);
    const l = new Int16Array(n);
    const r = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = Math.max(-32768, Math.min(32767, Math.round(L[i + skip] * 32767)));
      r[i] = Math.max(-32768, Math.min(32767, Math.round(R[i + skip] * 32767)));
    }
    return { l, r };
  }

  /**
   * The tracker's events to the music log ("Save diagnostics") – the changes only: a new track, a stop, a loop, the
   * line moved by the game's sound, a loop learned. A stream that (re)starts again and again (a reader the tracker
   * doesn't follow) is told once, then summed up every LOG_EVERY ms – it must not push everything else out of the log.
   */
  onTrack(e) {
    const now = this.now();
    if (e.type === 'start') {
      const last = this.starts.get(e.key);
      this.starts.set(e.key, now);
      if (last != null && now - last < LOG_EVERY * 3) {
        this.restarts = (this.restarts || 0) + 1;
        if (now - (this.restartsAt || 0) >= LOG_EVERY) {
          this.log({ type: 'rom-restarts', key: e.key, count: this.restarts, at: e.at, frame: e.frame });
          this.restarts = 0;
          this.restartsAt = now;
        }
        return;
      }
    }
    this.log({ ...e, type: `rom-${e.type}` });
  }

  /**
   * The worklet doesn't have a track it was told about (it keeps three, or it was made anew): loaded again with the
   * next position (the page only sends positions for tracks it handed over).
   */
  missing(id) {
    const t = this.tracks.get(id);
    if (t && t.state === 'ready') this.tracks.delete(id);
  }

  /** Diagnostics ("Save diagnostics", tests): what the music from the ROM knows right now. */
  state() {
    const p = this.tracker.playing();
    const st = this.tracker.cur;
    return {
      enabled: this.enabled,
      frame: this.tracker.frame,
      playing: p ? { path: p.file.path, codec: p.info.codec, pos: Math.round(p.pos), seconds: +(p.pos / p.info.rate).toFixed(2), loops: p.loops } : null,
      anchor: st?.anchor ? { frame: st.anchor.frame, u: Math.round(st.anchor.u), guess: !!st.anchor.guess } : null,
      steady: st?.steady ?? null,
      lead: st ? this.tracker.leadOf(st.info) : null,
      tracks: [...this.tracks].map(([k, t]) => ({ key: k, state: t.state, ...(t.fails ? { fails: t.fails } : {}) })),
      reads: { out: this.waiting.size, queued: this.queue.length, retrying: this.retryTimers.size, paused: this.paused },
      tags: [...this.tracker.tags].map(([tag, x]) => ({ tag, files: x.files?.length ?? null, direct: this.direct.has(tag) })),
    };
  }

  /** A new speed: the game's sound kept for calibrate starts over (fast-forward sound isn't 1× sound). */
  speed() {
    this.game.at = 0;
    this.game.frameAt = 0;
  }

  /** The game's state jumped (a loaded state, a reset): the reads start over. */
  cut() {
    for (const st of this.tracker.streams.values()) st.active = false;
    this.tracker.cur = null;
    this.last = null;
  }

  // ---- calibration: the reads' lead, measured against the game's own sound -------------------------------------------
  /** The host's 1× sound as it arrives (interleaved floats) – kept for calibrate. */
  onGameSound(f) {
    const g = this.game;
    const cap = g.l.length;
    for (let i = 0; i + 1 < f.length; i += 2) g.l[g.at++ % cap] = (f[i] + f[i + 1]) * 0.5;
  }

  /** The measurement's state for a track (its tries, how many in a row weren't taken) – kept for the latest 32. */
  calTrack(key) {
    let k = this.calTracks.get(key);
    if (!k) {
      this.calTracks.set(key, (k = { tries: 0, fails: 0 }));
      for (const old of this.calTracks.keys()) {
        if (this.calTracks.size <= 32) break;
        this.calTracks.delete(old);
      }
    }
    return k;
  }

  maybeCalibrate(p, t) {
    const c = this.cal.get(p.info.codec) || { tries: 0, done: false, next: 0, good: 0 };
    this.cal.set(p.info.codec, c);
    const st = this.tracker.cur;
    if (c.key !== p.key) {
      // (another track: its own backoff – not the last one's)
      c.key = p.key;
      c.next = Math.min(c.next, perfNow() + CAL_EVERY);
    }
    if (!st || this.busy || perfNow() < c.next) return;
    // (a line placed only by the start is measured until it is heard right – whatever the codec's state)
    if ((c.done || c.tries >= 20) && !st.anchor?.guess) return;
    const k = this.calTrack(p.key);
    if (k.tries >= CAL_TRACK_TRIES) return; // (this track never matched: the reads' line it is)
    if (p.u < this.rate * CAL_WIN || this.game.at < this.rate * Math.max((CAL_WIN + CAL_RANGE) * 2, CAL_WIDE_WIN + 0.5)) return;
    c.tries++;
    k.tries++;
    c.next = perfNow() + CAL_EVERY;
    this.busy = true;
    // (what the game played up to this frame, and where the tracker says that is – taken now, measured a moment later)
    const end = this.game.frameAt;
    const range = st.anchor?.guess ? 2 * CAL_RANGE : CAL_RANGE;
    p = { ...p };
    this.calJob = this.runCalibration(p, t, st, c, k, end, range).finally(() => {
      this.busy = false;
    });
  }

  /** One measurement (maybeCalibrate), in slices: near the line, else the wide search – and what it means for the line. */
  async runCalibration(p, t, st, c, k, end, range) {
    await new Promise((res) => setTimeout(res, 0));
    let taken = false;
    let candidate = false;
    try {
      const need = CAL_SCORE[p.info.codec] ?? 0.85;
      let r = await this.sliced(this.calibrateSteps(p, t, { end, range }));
      let ok = !!r && r.score >= need;
      let wide = false;
      if (!ok) {
        // nothing near the line: look further (see CAL_WIDE) – taken when it stands out and agrees with the last one
        const w = await this.sliced(this.calibrateSteps(p, t, { end, range: CAL_WIDE, win: CAL_WIDE_WIN, decim: CAL_WIDE_DECIM, margin: true }));
        if (w && w.score >= need && w.margin >= CAL_MARGIN) {
          wide = true;
          r = w;
          ok = c.wide != null && Math.abs(c.wide - w.err) < 0.02 * p.info.rate;
          c.wide = ok ? null : w.err;
          candidate = !ok;
        } else if (w) {
          c.wide = null;
          if (!r || w.score > r.score) r = w;
        }
      } else c.wide = null;
      if (r) {
        this.log({ type: 'rom-calibrated', codec: p.info.codec, offsetMs: Math.round((r.err / p.info.rate) * 1000), score: +r.score.toFixed(3), full: +r.full.toFixed(3), band: +r.band.toFixed(3), taken: ok, ...(r.margin != null ? { wide: true, margin: +r.margin.toFixed(3) } : {}) });
        if (ok && this.tracker.cur === st) {
          taken = true;
          this.tracker.nudge(r.err, { codec: p.info.codec });
          if (wide) c.next = perfNow() + 500; // (measure again soon, near the line now)
          if (Math.abs(r.err) < 0.01 * p.info.rate && ++c.good >= 2) c.done = true; // (agrees twice: no more tries)
        }
      }
    } catch (e) {
      this.log({ type: 'error', where: 'calibrate', message: String(e?.message || e) });
    }
    // nothing taken (and no wide match waiting for its second): the next try waits twice as long
    if (taken) k.fails = 0;
    else if (!candidate) {
      k.fails++;
      c.next = Math.max(c.next, perfNow() + Math.min(CAL_EVERY_MAX, CAL_EVERY * 2 ** Math.min(k.fails, 5)));
    }
  }

  /** Runs a generator in slices of at most CAL_SLICE_MS, a task each (the main thread stays free in between). */
  sliced(gen) {
    return new Promise((resolve, reject) => {
      const step = () => {
        try {
          const t0 = perfNow();
          for (;;) {
            const r = gen.next();
            if (r.done) return resolve(r.value);
            if (perfNow() - t0 >= CAL_SLICE_MS) break;
          }
          setTimeout(step, 0);
        } catch (e) {
          reject(e);
        }
      };
      step();
    });
  }

  /**
   * Where the game's sound really is in the track: the last CAL_WIN seconds of the game's 1× sound against the track
   * around the tracker's position. { err (track samples: true − tracker), score } or null.
   */
  calibrate(p, t, opts) {
    return runSync(this.calibrateSteps(p, t, opts));
  }

  /** calibrate as a generator: yields every few hundred microseconds of work (sliced). */
  *calibrateSteps(p, t, { end = this.game.frameAt, range: rangeSec = CAL_RANGE, win: winSec = CAL_WIN, decim = CAL_DECIM, margin = false } = {}) {
    const g = this.game;
    const cap = g.l.length;
    const rate = this.rate; // the game's sound is at the context's rate (= the core's)
    const win = Math.round(winSec * rate);
    if (win > cap) return null;
    if (end < win + 16) return null;
    if (g.at - (end - win) > cap) return null; // (overwritten since: the ring went on)
    const game = new Float32Array(win);
    for (let i = 0; i < win; i++) game[i] = g.l[(end - win + i) % cap];
    // the tracker's position at the start of this frame's sound, in the voice's samples (= the context's rate here)
    const posAtEnd = t.voicePos(p.pos);
    const range = Math.round(rangeSec * rate);
    const from = Math.round(posAtEnd - win - range);
    const track = yield* this.trackSamplesSteps(t, p, from, win + 2 * range);
    if (!track) return null;
    const r = yield* bestLagSteps(game, track, decim, margin ? Math.round(0.05 * rate) : 0);
    if (!r) return null;
    // track[r.lag] lines up with game[0]: the game's sound started at track position from + lag (voice samples)
    const truth = from + r.lag + win;
    return { err: (truth - posAtEnd) / t.ratio, score: Math.max(r.score, r.band), full: r.score, band: r.band, ...(margin ? { margin: r.margin } : {}) };
  }

  /** Mono samples [from, from + n) of a track (voice samples), loop taken into account; null when not decodable. */
  trackSamples(t, p, from, n) {
    return runSync(this.trackSamplesSteps(t, p, from, n));
  }

  *trackSamplesSteps(t, p, from, n) {
    const out = new Float32Array(n);
    // (its samples held here: a track loaded meanwhile lets go of this one's)
    const pcm = t.pcm;
    const file = t.file;
    if (pcm) {
      const L = pcm.l;
      const R = pcm.r;
      const lp = t.loop; // (voice samples)
      for (let i = 0; i < n; i++) {
        let k = from + i;
        if (lp && k >= lp.end) k = lp.start + ((k - lp.start) % (lp.end - lp.start));
        out[i] = k >= 0 && k < L.length ? (L[k] + R[k]) / 65536 : 0;
        if ((i & 0xffff) === 0xffff) yield;
      }
      return out;
    }
    if (!file) return null;
    const s = t.info;
    const seek = s.seekAt >= 0 ? file.subarray(s.seekAt) : null;
    const loop = s.loop;
    const at = (k) => (loop && k >= loop.end ? loop.start + ((k - loop.start) % (loop.end - loop.start)) : k);
    let block = -1;
    let ch = null;
    for (let i = 0; i < n; i++) {
      const k = at(from + i);
      if (k < 0 || k >= s.samples) continue;
      const b = Math.floor(k / s.blockSamples);
      if (b !== block) {
        if (block >= 0) yield;
        block = b;
        const hist = Array.from({ length: s.channels }, (_, c) => (b === 0 ? [...s.hist[c]] : cstmSeekHist(s, seek, b, c) || [0, 0]));
        ch = cstmDecodeBlock(s, file, b, hist);
      }
      const j = k - block * s.blockSamples;
      out[i] = ((ch[0][j] || 0) + ((ch[1] || ch[0])[j] || 0)) / 65536;
    }
    return out;
  }
}

/** The encoder delay to take off a decoded AAC buffer: what the decoder left in (it may trim it itself). */
function primingOf(buf, info) {
  const expect = info.samples + AAC_PRIMING; // frames × 1024
  const got = Math.round((buf.length * info.rate) / buf.sampleRate);
  // a decoder that trims the delay itself gives ~1024 samples less than the frames hold
  return Math.abs(got - expect) <= Math.abs(got - info.samples) ? AAC_PRIMING : 0;
}

/**
 * The lag where `a` (shorter) matches `b` best: a coarse search on every `decim`-th sample's average, then exact around
 * it. { lag, score } (normalized correlation) or null.
 */
export function bestLag(a, b, decim = 8, apart = 0) {
  return runSync(bestLagSteps(a, b, decim, apart));
}

/** Multiply-adds between two yields of bestLagSteps (~0.2 ms). */
const STEP_WORK = 1 << 17;

/** bestLag as a generator: yields every STEP_WORK multiply-adds or so (sliced) – the loops themselves are plain functions. */
export function* bestLagSteps(a, b, decim = 8, apart = 0) {
  const W = a.length;
  const L = b.length - W;
  if (L < 1) return null;
  const da = decimate(a, decim);
  yield;
  const db = decimate(b, decim);
  yield;
  const w = da.length;
  let ea = 0;
  for (let i = 0; i < w; i++) ea += da[i] * da[i];
  if (ea < 1e-9) return null; // (the game was quiet: nothing to compare)
  const n = db.length - w + 1;
  const coarse = new Float32Array(Math.max(0, n));
  const per = Math.max(1, Math.floor(STEP_WORK / Math.max(1, w)));
  for (let o = 0; o < n; o += per) {
    coarseScores(da, db, ea, o, Math.min(n, o + per), coarse);
    yield;
  }
  let best = -2;
  let lag = 0;
  for (let o = 0; o < n; o++) if (coarse[o] > best) [best, lag] = [coarse[o], o * decim];
  // (`apart` samples: how far the best place stands out from the best one at least that far from it – a repeated bar)
  let second = -2;
  if (apart) for (let o = 0; o < n; o++) if (Math.abs(o * decim - lag) >= apart && coarse[o] > second) second = coarse[o];
  // exact, ± decim samples
  let fine = -2;
  let at = lag;
  let fa = 0;
  for (let i = 0; i < W; i++) fa += a[i] * a[i];
  const perFine = Math.max(1, Math.floor(STEP_WORK / Math.max(1, W)));
  const hi = Math.min(L, lag + decim);
  for (let o = Math.max(0, lag - decim); o <= hi; o += perFine) {
    const r = fineBest(a, b, fa, o, Math.min(hi, o + perFine - 1));
    if (r.c > fine) [fine, at] = [r.c, r.o];
    yield;
  }
  // the same place below ~2 kHz (every `decim` samples averaged): decoders that differ in the top end still agree here
  return { lag: at, score: fine, band: corrAt(da, db, Math.round(at / decim)), ...(apart ? { margin: best - second } : {}) };
}

/** Normalized correlation of `da` with `db` at offsets [from, to) into `out`. */
function coarseScores(da, db, ea, from, to, out) {
  const w = da.length;
  for (let o = from; o < to; o++) {
    let num = 0;
    let eb = 0;
    for (let i = 0; i < w; i++) {
      const y = db[o + i];
      num += da[i] * y;
      eb += y * y;
    }
    out[o] = num / Math.sqrt(ea * eb + 1e-12);
  }
}

/** The best normalized correlation of `a` with `b` at offsets [from, to]: { c, o }. */
function fineBest(a, b, fa, from, to) {
  const W = a.length;
  let best = -2;
  let at = from;
  for (let o = from; o <= to; o++) {
    let num = 0;
    let fb = 0;
    for (let i = 0; i < W; i++) {
      const y = b[o + i];
      num += a[i] * y;
      fb += y * y;
    }
    const c = num / Math.sqrt(fa * fb + 1e-12);
    if (c > best) [best, at] = [c, o];
  }
  return { c: best, o: at };
}

function corrAt(a, b, o) {
  let num = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < a.length && o + i < b.length; i++) {
    num += a[i] * b[o + i];
    ea += a[i] * a[i];
    eb += b[o + i] * b[o + i];
  }
  return num / Math.sqrt(ea * eb + 1e-12);
}

function decimate(x, d) {
  const n = Math.floor(x.length / d);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < d; k++) s += x[i * d + k];
    out[i] = s / d;
  }
  return out;
}

export { FRAME_SEC };
