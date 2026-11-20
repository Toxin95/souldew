// The music streams of a 3DS game file, found once per ROM in the server's ROM data worker (server/lib/romloc.mjs
// ctrData) and cached with the rest of its ROM data: every RomFS file whose own bytes are a stream (streams.mjs – never by
// its name), with what playing it needs, and the loop points of the sound archive (BCSAR) for streams that don't carry
// their own (X/Y's AAC). The 3DS player (web/lib/rommusic.mjs) uses it for the game's own RomFS when the tables it reads
// through the core are the same (sig) – no probing, and the track's bytes come from the file over HTTP instead of
// through the host. An update's RomFS, a LayeredFS mod or a ROM hack's rebuilt RomFS have other tables: the player then
// finds their streams itself, the same way.

import { romfsOfFile } from './romfs.mjs';
import { sniffStream, bcsarStreams, SNIFF_BYTES } from './streams.mjs';

/** A short fingerprint of a RomFS file list (FNV-1a over count, names, places, sizes): equal lists, equal sig. */
export function filesSig(files) {
  let h = 0x811c9dc5;
  const mix = (n) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= n >>> 16;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(files.length);
  for (const f of files) {
    for (let i = 0; i < f.path.length; i++) mix(f.path.charCodeAt(i));
    mix(f.start % 0x100000000);
    mix(Math.floor(f.start / 0x100000000));
    mix(f.size % 0x100000000);
  }
  return `${files.length}-${h.toString(16)}`;
}

/** JSON-safe copy of a stream info (typed arrays to plain arrays). */
export function plainInfo(info) {
  const o = { ...info };
  if (o.coefs) o.coefs = o.coefs.map((c) => Array.from(c));
  if (o.hist) o.hist = o.hist.map((h) => [...h]);
  delete o.frames;
  delete o.bytes;
  return o;
}

/**
 * { base (level 3 in the file), sig, streams: [{ path, start, size, info }], loops: { name → { start, end } | null } }
 * or null (no readable RomFS). `readAt` over the game file. Never throws.
 */
export function musicIndex(readAt, { maxSar = 64 * 1024 * 1024 } = {}) {
  try {
    const fs = romfsOfFile(readAt);
    if (!fs) return null;
    const streams = [];
    const sars = [];
    for (const f of fs.files) {
      if (f.size < 64) continue;
      const head = readAt(fs.base + f.start, Math.min(SNIFF_BYTES, f.size));
      if (!head) continue;
      if (head.length >= 4 && head[0] === 0x43 && head[1] === 0x53 && head[2] === 0x41 && head[3] === 0x52) sars.push(f); // "CSAR"
      const info = sniffStream(head);
      if (info) streams.push({ path: f.path, start: f.start, size: f.size, info: plainInfo(info) });
    }
    // the sound archives' stream loops – only their STRG and INFO blocks (the rest is waves)
    const loops = {};
    // (a game has one or two; files that share one place are one archive – and what is read in all is bounded)
    const done = new Set();
    let budget = 2 * maxSar;
    for (const f of sars) {
      if (done.has(f.start) || done.size >= 8 || budget <= 0) continue;
      done.add(f.start);
      const h = readAt(fs.base + f.start, 0x40);
      if (!h || h.length < 0x40) continue;
      let end = 0x40;
      const n = h[0x10] | (h[0x11] << 8);
      for (let i = 0; i < Math.min(n, 3); i++) {
        const o = 0x14 + i * 12;
        const type = h[o] | (h[o + 1] << 8);
        const u32 = (k) => (h[k] | (h[k + 1] << 8) | (h[k + 2] << 16) | (h[k + 3] << 24)) >>> 0;
        if ((type === 0x2000 || type === 0x2001) && u32(o + 4) !== 0xffffffff) end = Math.max(end, u32(o + 4) + u32(o + 8)); // (no STRG: 0xFFFFFFFF)
      }
      if (end > maxSar) continue;
      budget -= Math.min(end, f.size);
      for (const [k, v] of bcsarStreams(readAt(fs.base + f.start, Math.min(end, f.size)))) loops[k] = v.loop;
    }
    return { base: fs.base, sig: filesSig(fs.files), streams, loops };
  } catch {
    return null;
  }
}
