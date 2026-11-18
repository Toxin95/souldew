// Just enough of the THUMB instruction set (ARMv4T, plus the ARMv5 blx of the DS's ARM9) to change a few instructions
// of a game safely: what an instruction reads and writes, where control goes next, whether a register's value is still
// needed after a point (liveness, following branches and looking into the functions called), and a small interpreter
// for straight-line code – to check that a rewritten sequence computes what it should, on random inputs.
// Used by shared/shiny.mjs for the shiny rates the games' own 8-bit compare can't express.

const hw = (b, o) => b[o] | (b[o + 1] << 8);
const bit = (r) => 1 << r;
const SCRATCH = 0x100f; // r0–r3, r12: a called function may change them
const SAVED = 0x0ff0; // r4–r11: a called function gives them back as they were

/** A THUMB `bl` (or ARMv5 `blx`) pair at `o`: { target, arm } (offset into the same buffer), else null. */
export function blAt(b, o) {
  if (o + 4 > b.length) return null;
  const h1 = hw(b, o);
  const h2 = hw(b, o + 2);
  if ((h1 & 0xf800) !== 0xf000 || ((h2 & 0xf800) !== 0xf800 && (h2 & 0xf800) !== 0xe800)) return null;
  let d = ((h1 & 0x7ff) << 12) | ((h2 & 0x7ff) << 1);
  if (d & 0x400000) d -= 0x800000;
  const arm = (h2 & 0xf800) === 0xe800;
  return { target: arm ? (o + 4 + d) & ~3 : o + 4 + d, arm };
}

/**
 * The instruction at `o`: { size, reads, writes (register bit masks), flow, target } – flow is 'next', 'cond' (both
 * ways), 'jump', 'call', 'return' or 'unknown' (anything this doesn't model: treated as using every register).
 */
export function decode(b, o) {
  const h = hw(b, o);
  const r = (n) => bit(n & 7);
  const I = (reads, writes, extra) => ({ size: 2, reads, writes, flow: 'next', ...extra });
  const top = h >> 11;
  if (top <= 2) return I(r(h >> 3), r(h)); // lsls/lsrs/asrs Rd, Rm, #imm
  if (top === 3) return I(r(h >> 3) | (h & 0x400 ? 0 : r(h >> 6)), r(h)); // adds/subs Rd, Rn, Rm|#imm3
  if (top >= 4 && top <= 7) {
    const op = (h >> 11) & 3;
    const d = r(h >> 8);
    return op === 0 ? I(0, d) : op === 1 ? I(d, 0) : I(d, d); // movs / cmp / adds / subs Rd, #imm8
  }
  if ((h & 0xfc00) === 0x4000) {
    const op = (h >> 6) & 15;
    const d = r(h);
    const s = r(h >> 3);
    if (op === 8 || op === 10 || op === 11) return I(d | s, 0); // tst / cmp / cmn
    if (op === 9 || op === 15) return I(s, d); // negs / mvns
    return I(d | s, d);
  }
  if ((h & 0xfc00) === 0x4400) {
    const op = (h >> 8) & 3;
    const d = (h & 7) | ((h >> 4) & 8);
    const s = (h >> 3) & 15;
    if (op === 3) {
      if (h & 0x80) return { size: 2, reads: bit(s), writes: SCRATCH | bit(14), flow: 'unknown' }; // blx Rm
      return { size: 2, reads: bit(s), writes: 0, flow: 'return' }; // bx Rm (after `pop {Rm}` or with lr: a return)
    }
    if (d === 15 || s === 15 || d === 13) return { size: 2, reads: 0xffff, writes: 0, flow: 'unknown' };
    if (op === 1) return I(bit(d) | bit(s), 0); // cmp
    if (op === 2) return I(bit(s), bit(d)); // mov
    return I(bit(d) | bit(s), bit(d)); // add
  }
  if (top === 9) return I(0, r(h >> 8), { lit: ((o + 4) & ~3) + (h & 0xff) * 4 }); // ldr Rd, [pc, #imm]
  if ((h & 0xf000) === 0x5000) {
    const isStr = !(h & 0x800) && (h & 0x0e00) !== 0x0600; // str, strh, strb (0x5600 is ldrsb)
    return isStr ? I(r(h) | r(h >> 3) | r(h >> 6), 0) : I(r(h >> 3) | r(h >> 6), r(h));
  }
  if ((h & 0xe000) === 0x6000 || (h & 0xf000) === 0x8000) return h & 0x800 ? I(r(h >> 3), r(h)) : I(r(h) | r(h >> 3), 0); // ldr/str Rd, [Rb, #imm]
  if ((h & 0xf000) === 0x9000) return h & 0x800 ? I(bit(13), r(h >> 8)) : I(r(h >> 8) | bit(13), 0); // ldr/str Rd, [sp, #imm]
  if ((h & 0xf000) === 0xa000) return I(h & 0x800 ? bit(13) : 0, r(h >> 8)); // add Rd, pc|sp, #imm
  if ((h & 0xff00) === 0xb000) return I(bit(13), bit(13)); // add/sub sp, #imm
  if ((h & 0xf600) === 0xb400) {
    const list = h & 0xff;
    if (h & 0x800) return h & 0x100 ? { size: 2, reads: bit(13), writes: list | bit(13), flow: 'return', pop: true } : I(bit(13), list | bit(13), { pop: true });
    return I(list | (h & 0x100 ? bit(14) : 0) | bit(13), bit(13), { push: list });
  }
  if ((h & 0xf000) === 0xc000) return h & 0x800 ? I(r(h >> 8), r(h >> 8) | (h & 0xff)) : I(r(h >> 8) | (h & 0xff), r(h >> 8)); // ldmia / stmia
  if ((h & 0xf000) === 0xd000) {
    const cond = (h >> 8) & 15;
    if (cond === 15) return { size: 2, reads: 0xffff, writes: SCRATCH, flow: 'unknown' }; // swi
    if (cond === 14) return { size: 2, reads: 0xffff, writes: 0, flow: 'unknown' };
    return { size: 2, reads: 0, writes: 0, flow: 'cond', target: o + 4 + 2 * ((h << 24) >> 24), cond };
  }
  if ((h & 0xf800) === 0xe000) return { size: 2, reads: 0, writes: 0, flow: 'jump', target: o + 4 + 2 * ((h << 21) >> 21) };
  const bl = blAt(b, o);
  if (bl) return { size: 4, reads: 0, writes: SCRATCH | bit(14), flow: 'call', target: bl.target, arm: bl.arm };
  return { size: 2, reads: 0xffff, writes: 0, flow: 'unknown' };
}

/**
 * What a called function does with the scratch registers before its first branch, call or return: { reads, kills } –
 * read before written, and written before read without being saved first (straight-line code: on every path). A
 * register in neither may still be read later, or come back as it was (saved by a `push`): not known.
 */
function calleeUse(code, entry, memo) {
  if (memo.has(entry)) return memo.get(entry);
  const res = { reads: 0, kills: 0 };
  memo.set(entry, res);
  if (entry < 0 || entry + 2 > code.length) {
    res.reads = 0xffff;
    return res;
  }
  let saved = 0;
  for (let o = entry, n = 0; n < 48 && o + 2 <= code.length; n++) {
    const d = decode(code, o);
    if (d.push !== undefined) saved |= d.push & SCRATCH; // (saving a register is no use of its value – but it comes back)
    else {
      res.reads |= d.reads & SCRATCH & ~res.kills;
      res.kills |= d.writes & SCRATCH & ~res.reads & ~saved;
    }
    if (d.flow !== 'next') break;
    o += d.size;
  }
  return res;
}

/**
 * Are the registers in `mask` dead from `starts` on – overwritten before anything reads them, on every path? Follows
 * branches (both ways), looks into called functions (only the straight-line start of a THUMB one, else it assumes they
 * read their arguments) and treats a return as reading r0 and the registers r4–r11 nobody restored. Unknown code,
 * a jump outside `code` or more than `limit` instructions: false (not provably dead).
 */
export function deadAfter(code, starts, mask, { limit = 600 } = {}) {
  const memo = new Map();
  const seen = new Map(); // address → the masks already followed from there
  const work = starts.map((at) => ({ at, live: mask }));
  let steps = 0;
  while (work.length) {
    let { at, live } = work.pop();
    for (;;) {
      if (!live) break;
      if (++steps > limit || at < 0 || at + 2 > code.length) return false;
      const was = seen.get(at) || [];
      if (was.includes(live)) break;
      was.push(live);
      seen.set(at, was);
      const d = decode(code, at);
      if (d.flow === 'unknown') return false;
      if (d.flow === 'call') {
        if (d.arm) {
          if (live & SCRATCH) return false;
        } else {
          const u = calleeUse(code, d.target, memo);
          const scratch = live & SCRATCH;
          if (scratch & ~u.kills) return false; // read as an argument, or not known either way
          live &= ~u.kills; // overwritten by the callee (r4–r11 come back as they were: still live)
        }
        live &= ~bit(12); // (the veneer register is never an argument)
        at += 4;
        continue;
      }
      if (live & d.reads) return false;
      live &= ~d.writes;
      if (d.flow === 'return') {
        if (live & (bit(0) | SAVED)) return false; // the result, and registers the caller expects back
        break;
      }
      if (d.flow === 'jump') {
        at = d.target;
        continue;
      }
      if (d.flow === 'cond') work.push({ at: d.target, live });
      at += d.size;
    }
  }
  return true;
}

/**
 * Which of the address ranges [from, to) in `ranges` some instruction of `code` branches or calls into – b, b<cond>
 * (only those around: they reach ±256 bytes and ±2 KB) and bl (from anywhere: one pass over the code for all ranges).
 * → [boolean] per range.
 */
export function branchedInto(code, ranges) {
  const hit = ranges.map(() => false);
  const mark = (t) => ranges.forEach(([from, to], i) => t >= from && t < to && (hit[i] = true));
  for (const [from, to] of ranges) {
    for (let o = Math.max(0, from - 2048) & ~1; o < Math.min(code.length - 1, to + 2048); o += 2) {
      const h = hw(code, o);
      if ((h & 0xf000) === 0xd000 && ((h >> 8) & 15) < 14) mark(o + 4 + 2 * ((h << 24) >> 24));
      else if ((h & 0xf800) === 0xe000) mark(o + 4 + 2 * ((h << 21) >> 21));
    }
  }
  for (let o = 0; o + 4 <= code.length; o += 2) {
    if ((code[o + 1] & 0xf8) !== 0xf0) continue;
    const bl = blAt(code, o);
    if (bl) mark(bl.target);
  }
  return hit;
}

/**
 * Runs the straight-line THUMB code [from, to) of `code` (a copy may carry edits) on registers `regs` (16 × uint32) with
 * the memory `mem` (address → byte, filled with random bytes on first read by `rnd`), literal loads reading `code`.
 * Returns { regs, stores } or null for an instruction it doesn't model.
 */
export function run(code, from, to, regs, rnd, mem = new Map()) {
  const R = Uint32Array.from(regs);
  const stores = [];
  const read = (a, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const k = (a + i) >>> 0;
      if (!mem.has(k)) mem.set(k, rnd() & 0xff);
      v |= mem.get(k) << (8 * i);
    }
    return v >>> 0;
  };
  const write = (a, n, v) => {
    stores.push([a >>> 0, n, n === 4 ? v >>> 0 : v & ((1 << (8 * n)) - 1)]);
    for (let i = 0; i < n; i++) mem.set((a + i) >>> 0, (v >>> (8 * i)) & 0xff);
  };
  for (let o = from; o < to; o += 2) {
    const h = hw(code, o);
    const d = h & 7;
    const s = (h >> 3) & 7;
    const top = h >> 11;
    if (top <= 2) {
      const imm = (h >> 6) & 31;
      const v = R[s];
      R[d] = top === 0 ? v << imm : top === 1 ? (imm ? v >>> imm : 0) : imm ? v >> imm : v >> 31;
    } else if (top === 3) {
      const n = h & 0x400 ? (h >> 6) & 7 : R[(h >> 6) & 7];
      R[d] = h & 0x200 ? R[s] - n : R[s] + n;
    } else if (top >= 4 && top <= 7) {
      const rd = (h >> 8) & 7;
      const imm = h & 0xff;
      const op = top & 3;
      if (op === 0) R[rd] = imm;
      else if (op === 2) R[rd] += imm;
      else if (op === 3) R[rd] -= imm;
    } else if ((h & 0xfc00) === 0x4000) {
      const op = (h >> 6) & 15;
      const a = R[d];
      const v = R[s];
      const out = [a & v, a ^ v, a << (v & 255), (v & 255) >= 32 ? 0 : a >>> (v & 255), a >> Math.min(31, v & 255), null, null, null, null, -v, null, null, a | v, Math.imul(a, v), a & ~v, ~v][op];
      if (out === null && ![8, 10, 11].includes(op)) return null;
      if (out !== null) R[d] = out;
    } else if ((h & 0xfc00) === 0x4400) {
      const op = (h >> 8) & 3;
      const rd = (h & 7) | ((h >> 4) & 8);
      const rs = (h >> 3) & 15;
      if (op === 3 || rd === 15 || rs === 15) return null;
      if (op === 0) R[rd] += R[rs];
      else if (op === 2) R[rd] = R[rs];
    } else if (top === 9) {
      const a = ((o + 4) & ~3) + (h & 0xff) * 4;
      if (a + 4 > code.length) return null;
      R[(h >> 8) & 7] = (code[a] | (code[a + 1] << 8) | (code[a + 2] << 16) | (code[a + 3] << 24)) >>> 0;
    } else if ((h & 0xf000) === 0x5000) {
      const a = (R[s] + R[(h >> 6) & 7]) >>> 0;
      const op = (h >> 9) & 7;
      if (op === 0) write(a, 4, R[d]);
      else if (op === 1) write(a, 2, R[d]);
      else if (op === 2) write(a, 1, R[d]);
      else if (op === 3) R[d] = (read(a, 1) << 24) >> 24;
      else if (op === 4) R[d] = read(a, 4);
      else if (op === 5) R[d] = read(a, 2);
      else if (op === 6) R[d] = read(a, 1);
      else R[d] = (read(a, 2) << 16) >> 16;
    } else if ((h & 0xe000) === 0x6000 || (h & 0xf000) === 0x8000) {
      const n = (h & 0xf000) === 0x8000 ? 2 : h & 0x1000 ? 1 : 4;
      const a = (R[s] + ((h >> 6) & 31) * n) >>> 0;
      if (h & 0x800) R[d] = read(a, n);
      else write(a, n, R[d]);
    } else if ((h & 0xf000) === 0x9000) {
      const a = (R[13] + (h & 0xff) * 4) >>> 0;
      if (h & 0x800) R[(h >> 8) & 7] = read(a, 4);
      else write(a, 4, R[(h >> 8) & 7]);
    } else if ((h & 0xf800) === 0xa800) R[(h >> 8) & 7] = R[13] + (h & 0xff) * 4;
    else return null;
  }
  return { regs: R, stores };
}
