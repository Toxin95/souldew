// NDS ROM filesystem helpers: header, FNT/FAT listing, NARC parsing, file-level diff.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function ndsHeader(rom) {
  const ascii = (a, n) => String.fromCharCode(...rom.subarray(a, a + n)).replace(/\0+$/, '');
  return {
    title: ascii(0, 12),
    code: ascii(12, 4),
    arm9: { offset: u32(rom, 0x20), size: u32(rom, 0x2c) },
    arm7: { offset: u32(rom, 0x30), size: u32(rom, 0x3c) },
    fnt: { offset: u32(rom, 0x40), size: u32(rom, 0x44) },
    fat: { offset: u32(rom, 0x48), size: u32(rom, 0x4c) },
    ovt9: { offset: u32(rom, 0x50), size: u32(rom, 0x54) },
  };
}

/**
 * List all files: [{ id, path, start, end }]. Overlay files get "overlay9/<n>". A damaged or cut-off ROM throws (or
 * lists fewer names) instead of reading past its end: the tables must lie inside the file, the directory walk stops at
 * the name table's end, at 32 levels and 65536 entries (a retail game has a few thousand).
 */
export function listNdsFiles(rom) {
  const h = ndsHeader(rom);
  const inside = (o, n) => Number.isInteger(o) && Number.isInteger(n) && o >= 0x200 && n >= 0 && o + n <= rom.length;
  if (!inside(h.fat.offset, h.fat.size) || !inside(h.fnt.offset, h.fnt.size) || h.fnt.size < 8) throw new Error('not a DS file system');
  const fatCount = Math.min(Math.floor(h.fat.size / 8), 65536);
  const files = new Array(fatCount);
  for (let i = 0; i < fatCount; i++) {
    files[i] = { id: i, path: null, start: u32(rom, h.fat.offset + i * 8), end: u32(rom, h.fat.offset + i * 8 + 4) };
  }
  const fnt = h.fnt.offset;
  const fntEnd = fnt + h.fnt.size;
  let entries = 0;
  const walk = (dirId, prefix, depth, seen) => {
    const entry = fnt + (dirId & 0xfff) * 8;
    if (depth > 32 || seen.has(dirId) || entry + 8 > fntEnd) return;
    seen.add(dirId);
    let p = fnt + u32(rom, entry);
    let fileId = u16(rom, entry + 4);
    while (p < fntEnd && entries++ < 65536) {
      const len = rom[p++];
      if (!len) break;
      const isDir = len & 0x80;
      const n = len & 0x7f;
      if (p + n + (isDir ? 2 : 0) > fntEnd) break;
      const name = String.fromCharCode(...rom.subarray(p, p + n));
      p += n;
      if (isDir) {
        const sub = u16(rom, p);
        p += 2;
        walk(sub, `${prefix}${name}/`, depth + 1, seen);
      } else {
        if (files[fileId]) files[fileId].path = prefix + name;
        fileId++;
      }
    }
  };
  walk(0xf000, '', 0, new Set());
  const ovCount = inside(h.ovt9.offset, h.ovt9.size) ? Math.min(Math.floor(h.ovt9.size / 32), 4096) : 0;
  for (let i = 0; i < ovCount; i++) {
    const fid = u32(rom, h.ovt9.offset + i * 32 + 24);
    if (files[fid] && !files[fid].path) files[fid].path = `overlay9/${u32(rom, h.ovt9.offset + i * 32)}`;
  }
  for (const f of files) if (f && !f.path) f.path = `#${f.id}`;
  return files;
}

/** NARC → array of Uint8Array subfiles. */
export function parseNarc(narc) {
  if (u32(narc, 0) !== 0x4352414e) throw new Error('not a NARC');
  let p = u16(narc, 0x0c);
  let fatb = -1;
  let fimg = -1;
  while (p + 8 <= narc.length) {
    const magic = u32(narc, p);
    const size = u32(narc, p + 4);
    if (magic === 0x46415442) fatb = p; // 'BTAF'
    if (magic === 0x46494d47) fimg = p; // 'GMIF'
    if (size < 8) break; // (a damaged block size would loop for ever)
    p += size;
  }
  if (fatb < 0 || fimg < 0) throw new Error('damaged NARC');
  const count = Math.min(u32(narc, fatb + 8), Math.floor((narc.length - fatb) / 8));
  const base = fimg + 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = u32(narc, fatb + 12 + i * 8);
    const e = u32(narc, fatb + 16 + i * 8);
    out.push(narc.subarray(base + s, base + e));
  }
  return out;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** File-level diff between two ROMs (and sub-file diff for NARCs). */
export function diffRoms(a, b) {
  const fa = listNdsFiles(a);
  const fb = new Map(listNdsFiles(b).map((f) => [f.path, f]));
  const changed = [];
  const ha = ndsHeader(a);
  const hb = ndsHeader(b);
  if (!same(a.subarray(ha.arm9.offset, ha.arm9.offset + ha.arm9.size), b.subarray(hb.arm9.offset, hb.arm9.offset + hb.arm9.size))) {
    changed.push({ path: 'arm9.bin', sizeA: ha.arm9.size, sizeB: hb.arm9.size });
  }
  for (const f of fa) {
    const g = fb.get(f.path);
    if (!g) {
      changed.push({ path: f.path, removed: true });
      continue;
    }
    const da = a.subarray(f.start, f.end);
    const db = b.subarray(g.start, g.end);
    if (same(da, db)) continue;
    const entry = { path: f.path, sizeA: da.length, sizeB: db.length };
    if (u32(da, 0) === 0x4352414e && u32(db, 0) === 0x4352414e) {
      try {
        const na = parseNarc(da);
        const nb = parseNarc(db);
        entry.subfiles = [];
        for (let i = 0; i < Math.max(na.length, nb.length); i++) {
          if (!na[i] || !nb[i] || !same(na[i], nb[i])) entry.subfiles.push(i);
        }
      } catch {
        // not a parseable NARC — file-level info is enough
      }
    }
    changed.push(entry);
  }
  return changed;
}

/**
 * Undoes the NDS "backward LZ" compression of an ARM9 binary (or overlay). `data` ends with the footer: u32 packed
 * length (low 24 bits) + header length (high byte), u32 size increase. A binary without compression (increase 0) is
 * returned as is. Same algorithm as ndstool/CUE's blz.
 */
export function blzDecompress(data) {
  const len = data.length;
  if (len < 8) return data;
  const inc = u32(data, len - 4);
  if (!inc) return data;
  const hdr = data[len - 5];
  const enc = u32(data, len - 8) & 0xffffff;
  if (enc > len || hdr < 8 || hdr > enc || inc > 0x4000000) throw new Error('bad BLZ footer');
  const keep = len - enc;
  const raw = new Uint8Array(len + inc);
  raw.set(data.subarray(0, keep));
  let pak = len - hdr;
  let r = raw.length;
  let mask = 0;
  let flags = 0;
  while (r > keep) {
    mask >>= 1;
    if (!mask) {
      if (pak <= keep) break;
      flags = data[--pak];
      mask = 0x80;
    }
    if (!(flags & mask)) {
      if (pak <= keep) break;
      raw[--r] = data[--pak];
    } else {
      if (pak - 2 < keep) break;
      let pos = data[--pak] << 8;
      pos |= data[--pak];
      let l = (pos >> 12) + 3;
      pos = (pos & 0xfff) + 3;
      if (r - l < keep) l = r - keep;
      while (l--) {
        r--;
        raw[r] = raw[r + pos];
      }
    }
  }
  return raw;
}

/**
 * The tokens of a backward-LZ encoding of `raw` from its end down to `minKeep` – in decode order, [length, distance]
 * (length 1: a literal). Matches copy 3–18 bytes from 3–0x1002 bytes above; greedy longest match with one step of
 * lazy evaluation (a literal first when the next position has a match two longer).
 */
function blzTokens(raw, minKeep) {
  const n = raw.length;
  const m = n - minKeep; // positions counted from the end: x ↔ raw[n - 1 - x]
  const at = (x) => raw[n - 1 - x];
  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(Math.max(0, m)).fill(-1);
  const key = (x) => ((at(x) << 8) ^ (at(x + 1) << 4) ^ at(x + 2)) & 0xffff;
  let hashed = 0;
  const match = (x) => {
    if (x + 3 > m) return [0, 0];
    for (; hashed < x && hashed + 2 < m; hashed++) {
      const k = key(hashed);
      prev[hashed] = head[k];
      head[k] = hashed;
    }
    const max = Math.min(18, m - x);
    let len = 0;
    let dist = 0;
    for (let c = head[key(x)], chain = 0; c >= 0 && chain < 512; c = prev[c], chain++) {
      const d = x - c;
      if (d > 0x1002) break;
      if (d < 3) continue;
      let l = 0;
      while (l < max && at(x + l) === at(x + l - d)) l++;
      if (l > len) {
        len = l;
        dist = d;
        if (l === max) break;
      }
    }
    return len >= 3 ? [len, dist] : [0, 0];
  };
  const tokens = [];
  for (let x = 0; x < m;) {
    let [len, dist] = match(x);
    if (len && len < 18 && match(x + 1)[0] > len + 1) len = 0;
    tokens.push(len ? [len, dist] : [1, 0]);
    x += len || 1;
  }
  return tokens;
}

/**
 * Backward-LZ encodes `raw` (an ARM9 binary) into exactly `size` bytes – the size of the compressed binary it
 * replaces, so the ROM's layout, the header and the module params stay as they are – keeping at least its first
 * `minKeep` bytes as they are (the secure area and the start-up code that decompresses the rest). The compressor packs
 * tighter than Nintendo's, so more of the start stays uncompressed and the footer takes up the last bytes (up to 255).
 * The result decompresses in place (the write position never passes the unread data). null if it can't fit.
 */
export function blzCompressTo(raw, size, minKeep) {
  const n = raw.length;
  const tokens = blzTokens(raw, minKeep);
  let covered = 0; // bytes from the end the first k tokens decode
  let packed = 0; // their bytes, without the flag bytes
  let k = 0;
  for (; ; k++) {
    const pad = size - (n - covered) - packed - Math.ceil(k / 8);
    if (pad >= 8 && pad <= 255) break;
    if (k === tokens.length) return null;
    covered += tokens[k][0];
    packed += tokens[k][0] === 1 ? 1 : 2;
  }
  const keep = n - covered;
  const stream = []; // in decode order (stored back to front)
  for (let i = 0, x = 0; i < k; i += 8) {
    const flagAt = stream.push(0) - 1;
    for (let j = 0; j < 8 && i + j < k; j++) {
      const [len, dist] = tokens[i + j];
      if (len === 1) stream.push(raw[n - 1 - x]);
      else {
        stream[flagAt] |= 0x80 >> j;
        const v = ((len - 3) << 12) | (dist - 3);
        stream.push(v >> 8, v & 0xff);
      }
      x += len;
    }
  }
  const out = new Uint8Array(size).fill(0xff);
  out.set(raw.subarray(0, keep));
  for (let i = 0; i < stream.length; i++) out[keep + stream.length - 1 - i] = stream[i];
  const enc = size - keep;
  const inc = n - size;
  const footer = [enc & 0xff, (enc >> 8) & 0xff, (enc >> 16) & 0xff, size - keep - stream.length, inc & 0xff, (inc >> 8) & 0xff, (inc >> 16) & 0xff, inc >>> 24];
  out.set(footer, size - 8);
  // in place: the bytes still to read lie below the next one written
  let pak = keep + stream.length;
  let w = n;
  for (let i = 0; i < k; i += 8) {
    pak--;
    for (let j = 0; j < 8 && i + j < k; j++) {
      const len = tokens[i + j][0];
      pak -= len === 1 ? 1 : 2;
      w -= len;
      if (w < pak) return null;
    }
  }
  return out;
}

/**
 * The ARM9 binary as it runs (decompressed), plus its RAM address and the NitroSDK module params: { bytes, ram,
 * bssStart, bssEnd, packed } – `bssStart` is where the static data of the main program begins in RAM, `packed` the
 * size of the compressed binary in the ROM (0: stored uncompressed).
 */
export function ndsArm9(rom) {
  const h = ndsHeader(rom);
  const ram = u32(rom, 0x28);
  let bin = rom.subarray(h.arm9.offset, h.arm9.offset + h.arm9.size);
  // module params: 8 words ending with the magic 0xDEC00621, near the start of the binary (the compressed part is at its end)
  let params = -1;
  for (let i = 0; i + 4 <= Math.min(bin.length, 0x8000); i += 4) {
    if (u32(bin, i) === 0xdec00621 && i >= 0x1c) {
      params = i - 0x1c;
      break;
    }
  }
  const compEnd = params >= 0 ? u32(bin, params + 0x14) : 0;
  const packed = compEnd > ram && compEnd - ram <= bin.length ? compEnd - ram : 0;
  if (packed) bin = blzDecompress(bin.subarray(0, packed));
  return { bytes: bin, ram, bssStart: params >= 0 ? u32(bin, params + 0x0c) : null, bssEnd: params >= 0 ? u32(bin, params + 0x10) : null, packed };
}

/** One file of the ROM by its path ("a/0/2/7"), or null. */
export function ndsFile(rom, path, files = listNdsFiles(rom)) {
  const f = files.find((x) => x.path === path);
  return f && f.end > f.start && f.end <= rom.length ? rom.subarray(f.start, f.end) : null;
}
