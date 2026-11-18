// Tiny ZIP reader (stored + deflate entries, ZIP64 sizes) — enough for ROM / patch archives. Entries are read into
// memory (readZipEntry, up to 600 MB), or – 3DS games, 1–4 GB – streamed into a file (extractZipEntry).
import * as zlib from 'node:zlib';
import { openSync, readSync, closeSync, fstatSync, createReadStream, createWriteStream, renameSync, rmSync, statfsSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join } from 'node:path';
import { crc32 as crc32js } from '../../shared/checksum.mjs';

const { inflateRawSync, createInflateRaw, constants: zlibConstants } = zlib;
/** CRC32 over a chunk, continuing from `crc` – zlib's native one where Node has it (22.2+, 20.15+). */
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32js;

/** Largest entry we ever decompress into memory (biggest NDS ROMs are 512 MB). Protects against zip bombs. */
export const MAX_ENTRY_SIZE = 600 * 1024 * 1024;

/** Central directory held in RAM while listing – a zip of ROMs is a few KB; refuse multi-GB directories. */
export const MAX_CD_BYTES = 4 * 1024 * 1024;
/** Hard cap on entries we parse from one zip (library zips hold a handful of files). */
export const MAX_ZIP_ENTRIES = 4096;
/**
 * When streaming a deflate entry to disk: refuse if uncompressed/compressed exceeds this.
 * Real 3DS dumps are encrypted / high-entropy (ratio ≈ 1); a zeros bomb is thousands-to-one.
 */
export const MAX_INFLATE_RATIO = 64;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/** List entries of a zip file without reading the payloads. */
export function listZip(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 0x10000 + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory locator sits right before the EOCD record
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64pos = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = readAt(fd, z64pos, 56);
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
    if (!(cdOffset >= 0 && cdSize >= 0 && cdOffset + cdSize <= size)) throw new Error('Corrupt zip (central directory out of range)');
    if (cdSize > MAX_CD_BYTES) throw new Error(`Zip central directory too large (${cdSize} bytes)`);
    if (count > MAX_ZIP_ENTRIES) throw new Error(`Zip has too many entries (${count})`);
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      // ZIP64 extra field
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, method, flags, crc, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and decompress one entry. Never produces more than the declared uncompressed size (capped at
 * MAX_ENTRY_SIZE). With `{ prefix: n }` only the first n bytes are decompressed (e.g. a ROM header) – that
 * reads at most 64 KB of compressed data instead of inflating a whole ROM.
 */
/** Where an entry's data starts (after its local header), checked against the file's size. */
function dataStartOf(fd, entry) {
  const fileSize = fstatSync(fd).size;
  const lh = readAt(fd, entry.localOffset, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt zip (bad local header)');
  const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (!(entry.compSize >= 0 && dataStart + entry.compSize <= fileSize)) throw new Error('Corrupt zip (entry out of range)');
  return dataStart;
}

export function readZipEntry(path, entry, { prefix = 0 } = {}) {
  const fd = openSync(path, 'r');
  try {
    const dataStart = dataStartOf(fd, entry);
    if (prefix > 0) {
      const raw = readAt(fd, dataStart, Math.min(entry.compSize, entry.method === 0 ? prefix : 64 * 1024));
      if (entry.method === 0) return raw;
      if (entry.method === 8) {
        // SYNC_FLUSH accepts the truncated stream and returns what it decodes so far (≤ ~64 MB from 64 KB).
        return inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 }).subarray(0, prefix);
      }
      throw new Error(`Unsupported zip compression method ${entry.method} in ${entry.name}`);
    }
    // (a header – `prefix` – is read from any entry; a whole entry only up to MAX_ENTRY_SIZE)
    if (!(entry.uncompSize >= 0 && entry.uncompSize <= MAX_ENTRY_SIZE)) throw new Error(`Zip entry too large: ${entry.name}`);
    if (entry.compSize > MAX_ENTRY_SIZE) throw new Error(`Zip entry too large: ${entry.name}`);
    const raw = readAt(fd, dataStart, entry.compSize);
    if (entry.method === 0) return raw;
    // maxOutputLength makes inflate throw instead of allocating past the declared size (zip bomb).
    if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.uncompSize, MAX_ENTRY_SIZE)) });
    throw new Error(`Unsupported zip compression method ${entry.method} in ${entry.name}`);
  } finally {
    closeSync(fd);
  }
}

/** An error while unpacking, with a `code` for the message the player gets (server/lib/library.mjs). */
function zipError(code, message) {
  return Object.assign(new Error(message), { zipCode: code });
}

/**
 * The file name an entry is unpacked under – its last path part ("Games/Pokemon Sun.3ds" → "Pokemon Sun.3ds"). Names
 * that try to leave the folder ("../x", "/etc/x", "C:\\x", "\\\\server\\x") are refused (throws, zipCode 'unsafe').
 */
export function entryFileName(name) {
  const s = String(name ?? '');
  const parts = s.split(/[\\/]/);
  if (!s || s.includes('\0') || /^[\\/]/.test(s) || /^[a-zA-Z]:/.test(s) || parts.includes('..') || !parts.at(-1) || parts.at(-1) === '.') {
    throw zipError('unsafe', `Unsafe name in the zip: ${s}`);
  }
  return parts.at(-1);
}

/** Free bytes on the disk that holds `dir` (null when the system can't tell). */
export function freeBytes(dir, { statfs = statfsSync } = {}) {
  try {
    const s = statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * True when a deflate entry's declared sizes imply an absurd compression ratio (zip bomb that still matches CRC).
 * Stored entries are never flagged here.
 */
export function inflateRatioTooHigh(entry) {
  if (entry.method !== 8) return false;
  if (!(entry.uncompSize > 0)) return false;
  if (!(entry.compSize > 0)) return true;
  return entry.uncompSize / entry.compSize > MAX_INFLATE_RATIO;
}

/**
 * Stream one entry into the file `dest` – never held in memory, any size up to `maxSize` (ZIP64 sizes and offsets
 * come from listZip). Written to a hidden temp file next to `dest` (the library scan skips it) and renamed once the
 * size and the CRC32 match the central directory; on any failure the temp file is removed and nothing is at `dest`.
 * `onProgress(done, total)` is called as the bytes are written. Throws errors with `zipCode`: 'method' (encrypted or
 * a compression other than stored / deflate), 'tooLarge', 'damaged' (size, CRC32 or the data itself); file system
 * errors (disk full, no permission) pass through.
 */
export async function extractZipEntry(zipPath, entry, dest, { maxSize = Infinity, onProgress = null } = {}) {
  if (entry.flags & 1) throw zipError('method', `Encrypted zip entry: ${entry.name}`);
  if (![0, 8].includes(entry.method)) throw zipError('method', `Unsupported zip compression method ${entry.method} in ${entry.name}`);
  if (!(entry.uncompSize >= 0 && entry.uncompSize <= maxSize)) throw zipError('tooLarge', `Zip entry too large: ${entry.name}`);
  if (inflateRatioTooHigh(entry)) throw zipError('tooLarge', `Zip entry compression ratio too high: ${entry.name}`);
  if (entry.method === 0 && entry.compSize !== entry.uncompSize) throw zipError('damaged', `Corrupt zip (stored entry sizes differ): ${entry.name}`);
  let dataStart;
  const fd = openSync(zipPath, 'r');
  try {
    dataStart = dataStartOf(fd, entry);
  } catch (e) {
    throw zipError('damaged', e.message);
  } finally {
    closeSync(fd);
  }
  const part = join(dirname(dest), `.${basename(dest)}.${process.pid}.part`);
  rmSync(part, { force: true }); // (left behind by a crash)
  let written = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk, enc, cb) {
      written += chunk.length;
      // more than the central directory says: a damaged entry or a zip bomb – stop before the disk fills up
      if (written > entry.uncompSize) return cb(zipError('damaged', `Corrupt zip (entry larger than declared): ${entry.name}`));
      crc = crc32(chunk, crc);
      onProgress?.(written, entry.uncompSize);
      cb(null, chunk);
    },
  });
  const source = entry.compSize > 0
    ? createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compSize - 1, highWaterMark: 1 << 20 })
    : Readable.from([]);
  try {
    try {
      await pipeline(source, ...(entry.method === 8 ? [createInflateRaw()] : []), check, createWriteStream(part, { flags: 'wx' }));
    } catch (e) {
      // zlib: a broken deflate stream
      throw e.zipCode || !/^Z_|zlib|incorrect|invalid/i.test(`${e.code || ''} ${e.message}`) ? e : zipError('damaged', `Corrupt zip (${e.message}): ${entry.name}`);
    }
    if (written !== entry.uncompSize) throw zipError('damaged', `Corrupt zip (entry shorter than declared): ${entry.name}`);
    if ((crc >>> 0) !== (entry.crc >>> 0)) throw zipError('damaged', `CRC32 mismatch in ${entry.name}`);
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}
