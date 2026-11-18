// A run's shiny setting on disk: whether a game can take it (the new-run wizard) and patching a built game with it.
// What gets patched and why: shared/shiny.mjs. GBA games are patched in the ROM; DS games in their ARM9 binary,
// which HeartGold/SoulSilver and the Gen 5 games keep compressed – those are compressed again into exactly the space
// they had (shared/nds.mjs blzCompressTo), so nothing else in the ROM moves.
import { openSync, readSync, writeSync, closeSync, fstatSync } from 'node:fs';
import { identifyRom, matchCatalog } from '../../shared/romid.mjs';
import { ndsHeader, ndsArm9, blzDecompress, blzCompressTo } from '../../shared/nds.mjs';
import { cleanShiny, shinyFamily, locateShiny, shinyEdits, trainerShiniesOk, shinyNeedsHigh } from '../../shared/shiny.mjs';
import { catalog } from './library.mjs';
import { httpError } from './fsutil.mjs';

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function readAt(fd, offset, length) {
  const buf = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done);
    if (!n) throw new Error('file ends early');
    done += n;
  }
  return buf;
}

/**
 * The code of the game at `path` the shiny check lives in: { family, code, arm9 } – the whole ROM of a GBA game, the
 * decompressed ARM9 binary of a DS game (`arm9`: where it sits in the ROM and how it is stored).
 */
function readCode(fd) {
  const size = fstatSync(fd).size;
  const head = readAt(fd, 0, Math.min(0x200, size));
  const id = identifyRom(head);
  const family = id ? shinyFamily(id.system, id.code) : null;
  if (!family) return { family: null };
  if (id.system === 'gba') return { family, code: readAt(fd, 0, Math.min(size, 0x2000000)) };
  const h = ndsHeader(head);
  if (h.arm9.offset < 0x200 || h.arm9.size > 0x400000 || h.arm9.offset + h.arm9.size > size) return { family: null };
  // ndsArm9 reads the header and the binary out of a ROM: just those two parts
  const part = new Uint8Array(h.arm9.offset + h.arm9.size);
  part.set(head);
  part.set(readAt(fd, h.arm9.offset, h.arm9.size), h.arm9.offset);
  const a9 = ndsArm9(part);
  return { family, code: a9.bytes.slice(), arm9: { offset: h.arm9.offset, packed: a9.packed, image: part.subarray(h.arm9.offset) } };
}

/** Is the ROM an original game (no patch, a dump the catalog knows by its checksum)? The rest may differ in code. */
export function isOriginalRom(patched, patchId) {
  return !patchId && !!patched?.baseCrc && !!matchCatalog({ crc: patched.baseCrc, ...(patched.header || {}) }, catalog())?.exact;
}

/**
 * Can the game at `path` get another shiny rate? → { ok, trainers, gen, high } or { ok: false, reason } – `game`: not a
 * Gen 3–5 GBA/DS game, `hack`: not an original game (`original` false), `code`: its shiny check isn't exactly where it
 * should be. `high`: rates above 1 in 257 too (thresholds above 255 – shared/shiny.mjs planHigh).
 */
export function shinySupport(path, { original = true } = {}) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const { family, code } = readCode(fd);
    if (!family) return { ok: false, reason: 'game' };
    if (!original) return { ok: false, reason: 'hack', gen: family.gen };
    const located = locateShiny(code, family);
    if (located.error) return { ok: false, reason: 'code', gen: family.gen };
    return { ok: true, gen: family.gen, trainers: trainerShiniesOk(located), high: !!located.high?.ok };
  } catch {
    return { ok: false, reason: 'code' }; // (a cut-off or damaged file)
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const unsupported = () => httpError(400, 'This run’s shiny rate can’t be built into this game – it needs an original Gen 3–5 game', 'shinyUnsupported');

/**
 * Patch the built game at `path` in place with a run's shiny setting (nothing for the games' own odds). Throws a 400
 * `shinyUnsupported` when the game can't take it – the run's other players built theirs with it.
 */
export function applyShiny(path, shiny) {
  const s = cleanShiny(shiny);
  if (!s) return { changed: 0 };
  const fd = openSync(path, 'r+');
  try {
    const { family, code, arm9 } = readCode(fd);
    const located = family ? locateShiny(code, family) : { error: 'game' };
    if (located.error || (s.trainers && !trainerShiniesOk(located)) || (shinyNeedsHigh(s) && !located.high?.ok)) throw unsupported();
    const edits = shinyEdits(located, s);
    for (const e of edits) code.set(e.bytes, e.at);
    if (!arm9) {
      for (const e of edits) writeSync(fd, Uint8Array.from(e.bytes), 0, e.bytes.length, e.at);
    } else if (!arm9.packed) {
      for (const e of edits) writeSync(fd, Uint8Array.from(e.bytes), 0, e.bytes.length, arm9.offset + e.at);
    } else {
      const img = arm9.image.subarray(0, arm9.packed);
      const keep = arm9.packed - (u32(img, arm9.packed - 8) & 0xffffff);
      const packed = blzCompressTo(code, arm9.packed, keep);
      const back = packed && blzDecompress(packed);
      if (!back || back.length !== code.length || back.some((b, i) => b !== code[i])) throw unsupported();
      writeSync(fd, packed, 0, packed.length, arm9.offset);
    }
    return { changed: edits.length };
  } finally {
    closeSync(fd);
  }
}
