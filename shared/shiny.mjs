// Shiny odds of a run: the original Gen 3–5 games get another shiny rate – and, in Gen 3/4, shiny Pokémon for
// trainers – by patching the game's own shiny check.
//
// Gen 3–5 call a Pokémon shiny when the XOR of the four 16-bit halves of its OT ID and personality value is below
// SHINY_ODDS = 8 (8 / 65536 = 1 in 8192; pret pokeemerald include/constants/pokemon.h, pokeheartgold
// include/constants/pokemon.h, PKHeX PKM.IsShiny). The games compile that compare into a handful of places:
//   Gen 3  pokemon.c CreateBoxMon (the OT_ID_RANDOM_NO_SHINY loop of trainer Pokémon), GetMonSpritePalFromSpeciesAnd-
//          Personality, GetMonSpritePalStructFromOtIdPersonality, IsShinyOtIdPersonality and the battle's sparkle
//          (pokeemerald battle_anim_throw.c, pokefirered/pokeruby battle_anim_special.c): `cmp rN, #7` + bls/bhi
//   Gen 4  pokemon.c CreateBoxMon's OTID_NOT_SHINY loop and CalcShininessByOtIdAndPersonality (pokeplatinum
//          Pokemon_InlineIsPersonalityShiny, pokeheartgold SHINY_CHECK): `cmp r0, #8` + blo/bhs
//   Gen 5  one function every check calls (wild Pokémon, shiny locks, the not-shiny OT of NPC Pokémon, the Shiny Charm):
//          `cmp r0, #8` + bhs
// Each place is found by its code – the XOR of the halves right before the compare – never by a fixed address, and a
// game qualifies only with exactly the places its generation has. Everything not shiny-checked by the game itself
// (Gen 1: no shinies, Gen 2: shininess comes from the DVs, the 3DS games) can't get another rate.
//
// Gen 3 also passes SHINY_ODDS itself as an OT ID that is never shiny – the starter choice, Birch's Lotad, the
// Pokédex and FireRed/LeafGreen's credits draw their pictures with `CreateMonPicSprite…(species, SHINY_ODDS, 0 …)`
// (pokeemerald main_menu.c, starter_choose.c, pokedex.c; pokefirered credits.c, pokedex_screen.c). A higher
// threshold would show those shiny, so these arguments move to 0xFF along with it (an OT ID of 255 is shiny only from a
// threshold of 256 on).
//
// Since 2.8.1 any rate from 1 in 8192 to 1 in 2 (players asked for 1 in 100, 1 in 50, 1 in 10). The threshold is
// 65536 / N, as close as it can be: up to 255 it is the compare's 8-bit constant, as before. Above, it is k × 2^s with
// k ≤ 255 (8 significant bits – at most 0.4 % off, exact for every power of two), and the code around each compare is
// rewritten so the games can take it (planHigh below):
//   - shift: where the four halves come from `lsrs #16` (Gen 4/5 – and Gen 3 if a game had it), each becomes
//     `lsrs #16+s`: the XOR then is the value >> s, compared with k as before.
//   - rewrite: Gen 3 masks the low halves with 0xFFFF (`ands`), which can't shift. Its XOR of the halves of the OT ID A
//     and the personality B is computed anew in the same places: c = A ^ B, then c ^ (c << 16), whose upper half is the
//     value; the threshold << 16 is built in a register that is free there (`movs #k`, `lsls #16+s`), and the compare
//     becomes `cmp Rn, Rt` + blo/bhs. Everything else in between stays where it is.
//   - loop: the not-shiny loop for NPC Pokémon needs no exact rate, only never a shiny: `cmp #imm` becomes
//     `lsrs Rn, Rn, #s` with beq/bne – it draws again while the value is below the power of two at or above the threshold.
//   - pictures: Gen 3's SHINY_ODDS arguments (`movs r1, #8 … movs r3, #1`) become `movs r3, #1 … lsls r1, r3, #15`:
//     an OT ID of 0x8000, never shiny up to the top threshold of 32768.
// Every site is checked before it is touched: the rewritten code is run against the original on random inputs (the
// value must come out shifted or in the upper half next to the threshold, every store the same), each register that ends up different must be dead on
// every path after the branch (shared/thumb.mjs deadAfter, into the functions called), and nothing may branch into
// the middle of what changes. A game where any of that doesn't hold gets the 8-bit thresholds only (`high` false).

/** "1 in N" presets (the ones 2.8.0 knows – any other rate needs 2.8.1) – 8192 is the games' own rate. */
export const SHINY_RATES = [8192, 4096, 1024, 512, 256];
export const NORMAL_RATE = 8192;
/** The commonest rate a run can have: 1 in 2. */
export const MIN_RATE = 2;
/** The compare's threshold per preset (shiny ⇔ XOR value < threshold). 256 needed a 9-bit constant in 2.8.0: 255. */
const THRESHOLD = { 8192: 8, 4096: 16, 1024: 64, 512: 128, 256: 255 };
/** Above this, a threshold needs the rewritten code (planHigh). */
const IMM_MAX = 255;

/** Is `n` a rate a run can have (a whole "1 in N" from 1 in 2 to 1 in 8192)? */
export const validRate = (n) => Number.isInteger(n) && n >= MIN_RATE && n <= NORMAL_RATE;

/** The threshold of a rate: a preset's, else 65536 / N to the nearest value the patch can build (k × 2^s, k ≤ 255). */
function thresholdOf(rate) {
  if (THRESHOLD[rate]) return THRESHOLD[rate];
  const want = 65536 / rate;
  let best = 0;
  for (let s = 0; s <= 8; s++) {
    for (const k of [Math.floor(want / 2 ** s), Math.ceil(want / 2 ** s)]) {
      if (k < 1 || k > IMM_MAX) continue;
      const t = k * 2 ** s;
      const d = Math.abs(t - want) - Math.abs(best - want);
      if (!best || d < 0 || (d === 0 && t < best)) best = t; // (a tie: the rarer one)
    }
  }
  return Math.max(THRESHOLD[NORMAL_RATE], best);
}

/**
 * What a rate really gives: { rate, threshold, effective, exact } – `effective` the "1 in …" the threshold makes
 * (65536 / threshold), `exact` whether that is the rate asked for. null for a rate a run can't have.
 */
export function shinyOdds(rate) {
  const n = Number(rate);
  if (!validRate(n)) return null;
  const threshold = thresholdOf(n);
  const effective = 65536 / threshold;
  return { rate: n, threshold, effective, exact: effective === n };
}

/**
 * A run's shiny setting from a request, a manifest or an invite (untrusted): { rate, trainers } with a rate a run can
 * have, or null for the games' own odds without trainer shinies (what a run without the setting is).
 */
export function cleanShiny(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = Number(v.rate);
  const rate = validRate(n) ? n : NORMAL_RATE;
  const trainers = v.trainers === true;
  return rate === NORMAL_RATE && !trainers ? null : { rate, trainers };
}

/** The threshold a run's game compares with (8 = unchanged) – what the live tracker needs to call a Pokémon shiny. */
export const shinyThreshold = (shiny) => thresholdOf(cleanShiny(shiny)?.rate ?? NORMAL_RATE);

/** Does the run's rate need the rewritten code (a threshold above 255 – a game's `high` support)? */
export const shinyNeedsHigh = (shiny) => shinyThreshold(shiny) > IMM_MAX;

/** A rate 2.8.0 knows (its presets): a run with another one needs 2.8.1 (shared/runpack.mjs). */
export const shinyKnownTo280 = (shiny) => !cleanShiny(shiny) || SHINY_RATES.includes(cleanShiny(shiny).rate);

/** Does the run change anything about shinies? */
export const shinyChanged = (shiny) => cleanShiny(shiny) !== null;

/**
 * The game family behind a GBA/DS header code, with the shiny checks its generation has: `checks` compares, `loops`
 * not-shiny loops for NPC Pokémon (what the trainer option opens), `literals` the [min, max] SHINY_ODDS arguments
 * (Gen 3 – Ruby/Sapphire draw those pictures with the normal palette, a German FireRed/LeafGreen has a seventh one
 * for its Pokédex). null: not a game this works for.
 */
export function shinyFamily(system, code) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (system === 'gba') {
    if (c === 'AXV' || c === 'AXP') return { gen: 3, checks: 4, loops: 1, literals: [0, 0] };
    if (c === 'BPE') return { gen: 3, checks: 4, loops: 1, literals: [3, 4] };
    if (c === 'BPR' || c === 'BPG') return { gen: 3, checks: 4, loops: 1, literals: [6, 7] };
  } else if (system === 'nds') {
    if (['ADA', 'APA', 'CPU', 'IPK', 'IPG'].includes(c)) return { gen: 4, checks: 1, loops: 1, literals: [0, 0] };
    if (['IRB', 'IRA', 'IRE', 'IRD'].includes(c)) return { gen: 5, checks: 1, loops: 0, literals: [0, 0] };
  }
  return null;
}

// ---- THUMB code ------------------------------------------------------------------------------------------------
import { decode, blAt, deadAfter, branchedInto, run } from './thumb.mjs';

const NOP = 0x46c0; // mov r8, r8
const hw = (b, o) => b[o] | (b[o + 1] << 8);
const isEorInto = (h, n) => (h & 0xffc7) === (0x4040 | n); // eors Rn, Rm
const isShift16 = (h) => (h & 0xf000) === 0 && ((h >> 6) & 31) === 16; // lsls/lsrs Rd, Rm, #16

/** A THUMB `bl` at `o`: its target (offset into the same buffer), else null. */
function blTarget(b, o) {
  const h1 = hw(b, o);
  const h2 = hw(b, o + 2);
  if ((h1 & 0xf800) !== 0xf000 || (h2 & 0xf800) !== 0xf800) return null;
  let d = ((h1 & 0x7ff) << 12) | ((h2 & 0x7ff) << 1);
  if (d & 0x400000) d -= 0x800000;
  return o + 4 + d;
}

/**
 * Every shiny compare in `code` (THUMB): `cmp rN, #imm` + a conditional branch right after the XOR of the four
 * halves – the last instruction an `eors` into rN, three of the ten before eors into rN and two of them shifts by
 * 16. Gen 3 compares `#7` with bls/bhi, Gen 4/5 `#8` with blo/bhs. A branch taken for a shiny one that jumps back and
 * is followed by a plain `b` is the not-shiny loop. Returns [{ at, kind: 'check' | 'loop', imm }].
 */
export function findShinyCompares(code, imm) {
  const out = [];
  const shinyTaken = imm === 7 ? 0xd9 : 0xd3; // bls / blo
  const notShinyTaken = imm === 7 ? 0xd8 : 0xd2; // bhi / bhs
  for (let s = 20; s + 6 <= code.length; s += 2) {
    const h = hw(code, s);
    if ((h & 0xf8ff) !== (0x2800 | imm)) continue;
    const br = hw(code, s + 2);
    if (br >> 8 !== shinyTaken && br >> 8 !== notShinyTaken) continue;
    const n = (h >> 8) & 7;
    if (!isEorInto(hw(code, s - 2), n)) continue;
    let eors = 0;
    let shifts = 0;
    for (let k = 1; k <= 10; k++) {
      const p = hw(code, s - 2 * k);
      if (isEorInto(p, n)) eors++;
      if (isShift16(p)) shifts++;
    }
    if (eors < 3 || shifts < 2) continue;
    const back = (br & 0x80) !== 0;
    const loop = br >> 8 === shinyTaken && back && (hw(code, s + 4) & 0xf800) === 0xe000;
    out.push({ at: s, kind: loop ? 'loop' : 'check', imm });
  }
  return out;
}

/**
 * One function's extent and calls, by a linear sweep from `entry`: it ends at a return (`pop {…, pc}`, `bx rM`, an
 * unconditional `b` back) that no branch inside it jumps past – at most `limit` bytes.
 */
function sweep(code, entry, limit = 0x400) {
  const calls = [];
  let far = entry;
  let o = entry;
  for (const end = Math.min(code.length - 4, entry + limit); o < end; o += 2) {
    const h = hw(code, o);
    const t = blTarget(code, o);
    if (t !== null) {
      calls.push(t);
      o += 2;
    } else if ((h & 0xf000) === 0xd000 && (h & 0x0f00) < 0x0e00) {
      far = Math.max(far, o + 4 + 2 * ((h << 24) >> 24));
    } else if ((h & 0xf800) === 0xe000) {
      const t2 = o + 4 + 2 * ((h << 21) >> 21);
      if (t2 > o) far = Math.max(far, t2);
      else if (o >= far) break;
    } else if (((h & 0xff00) === 0xbd00 || (h & 0xff87) === 0x4700) && o >= far) break;
  }
  return { start: entry, end: o + 2, calls };
}

/** Between the OT ID and the call only the next arguments are set up: `movs r2/r3, #imm` or `adds r2/r3, rM, #0`. */
const argSetup = (h) => (h & 0xfe00) === 0x2200 || ((h & 0xffc0) === 0x1c00 && ((h & 7) === 2 || (h & 7) === 3));

/**
 * Gen 3's SHINY_ODDS arguments: `movs r1, #8` (the OT ID), then only argSetup() with `movs r3, #1`, then a `bl`
 * into a picture function – one whose calls reach a shiny check within five levels (CreateMonPicSprite_HandleDeoxys →
 * CreateMonPicSprite → CreatePicSprite → LoadPicPaletteByTagOrSlot → GetMonSpritePalFromSpeciesAndPersonality).
 */
export function findShinyLiterals(code, checks) {
  const bodies = new Map();
  const body = (t) => {
    if (!bodies.has(t)) bodies.set(t, sweep(code, t));
    return bodies.get(t);
  };
  const reaches = new Map();
  const reachable = (target) => {
    if (reaches.has(target)) return reaches.get(target);
    let level = [target];
    const seen = new Set(level);
    let hit = false;
    for (let depth = 0; depth <= 5 && level.length && !hit; depth++) {
      const next = [];
      for (const t of level) {
        if (t < 0 || t >= code.length - 4) continue;
        const f = body(t);
        if (checks.some((c) => c >= f.start && c < f.end)) {
          hit = true;
          break;
        }
        for (const c of f.calls) {
          if (seen.has(c)) continue;
          seen.add(c);
          next.push(c);
        }
      }
      level = next;
    }
    reaches.set(target, hit);
    return hit;
  };
  const out = [];
  for (let o = 0; o + 12 <= code.length; o += 2) {
    if (hw(code, o) !== 0x2108) continue; // movs r1, #8
    let r3 = false;
    for (let k = o + 2; k < o + 10; k += 2) {
      const t = blTarget(code, k);
      if (t !== null) {
        if (r3 && reachable(t)) out.push(o);
        break;
      }
      const h = hw(code, k);
      if (h === 0x2301) r3 = true; // movs r3, #1
      else if (!argSetup(h)) break;
    }
  }
  return out;
}

/**
 * The shiny code of a game: `code` is the GBA ROM or the DS game's ARM9 binary (decompressed), `family` its
 * shinyFamily(). → { gen, checks: [at], loop: at | null, literals: [at], high } or { error: 'code' } when the places
 * aren't exactly the ones that generation has – `high`: planHigh's rewrite for thresholds above 255 ({ ok, … }).
 */
export function locateShiny(code, family) {
  if (!family) return { error: 'game' };
  const imm = family.gen === 3 ? 7 : 8;
  const found = findShinyCompares(code, imm);
  const checks = found.filter((x) => x.kind === 'check').map((x) => x.at);
  const loops = found.filter((x) => x.kind === 'loop').map((x) => x.at);
  if (checks.length !== family.checks || loops.length !== family.loops) return { error: 'code' };
  const literals = family.gen === 3 ? findShinyLiterals(code, checks) : [];
  if (literals.length < family.literals[0] || literals.length > family.literals[1]) return { error: 'code' };
  const located = { gen: family.gen, checks, loop: loops[0] ?? null, literals };
  located.high = planHigh(code, located);
  return located;
}

// ---- thresholds above 255: the rewritten compares (see the top) ----------------------------------------------------
const MAX_WINDOW = 24; // instructions before a compare that are looked at
const isLsr16 = (h) => (h & 0xf800) === 0x0800 && ((h >> 6) & 31) === 16;
const isAnds = (h) => (h & 0xffc0) === 0x4000;

/**
 * The straight-line code before the compare at `at`: back to the instruction after a branch, call, return, push or pop,
 * to where a branch nearby lands, or to the end of a literal pool (a word some `ldr Rd, [pc, #…]` reads – data).
 */
function windowStart(code, at) {
  const lands = new Set();
  const data = new Set();
  for (let o = Math.max(0, at - 2 * MAX_WINDOW - 2048) & ~1; o < Math.min(code.length - 1, at + 2048); o += 2) {
    const h = hw(code, o);
    if ((h & 0xf000) === 0xd000 && ((h >> 8) & 15) < 14) lands.add(o + 4 + 2 * ((h << 24) >> 24));
    else if ((h & 0xf800) === 0xe000) lands.add(o + 4 + 2 * ((h << 21) >> 21));
    else if ((h & 0xf800) === 0x4800) {
      const lit = ((o + 4) & ~3) + (h & 0xff) * 4;
      data.add(lit).add(lit + 2);
    }
  }
  let o = at;
  for (let n = 0; n < MAX_WINDOW && o >= 2 && !lands.has(o) && !data.has(o - 2); n++) {
    if (o >= 4 && blAt(code, o - 4)) break;
    const d = decode(code, o - 2);
    if (d.flow !== 'next' || d.push !== undefined || d.pop) break;
    o -= 2;
  }
  return o;
}

/**
 * Where the value the compare at `at` reads comes from: the XOR tree of rN over the window [start, at) – its leaves
 * (the instructions that made the four halves) and, per register, the instruction that last wrote it. null unless the
 * tree has exactly four leaves, each an instruction of the window.
 */
function xorLeaves(code, start, at) {
  const def = new Array(16).fill(null); // register → node
  const deps = new Map(); // instruction → the instructions in the window that made what it reads
  for (let o = start; o < at; o += 2) {
    const h = hw(code, o);
    const d = decode(code, o);
    deps.set(o, def.filter((n, r) => n && d.reads & (1 << r)).map((n) => n.at));
    if (isEorInto(h, h & 7)) {
      const rd = h & 7;
      const rs = (h >> 3) & 7;
      def[rd] = { at: o, eor: [def[rd], def[rs]] };
      continue;
    }
    for (let r = 0; r < 16; r++) if (d.writes & (1 << r)) def[r] = { at: o, h };
  }
  const rn = (hw(code, at) >> 8) & 7;
  const leaves = [];
  const eors = [];
  const walk = (n) => {
    if (!n) return false;
    if (!n.eor) {
      leaves.push(n);
      return true;
    }
    eors.push(n.at);
    return walk(n.eor[0]) && walk(n.eor[1]);
  };
  if (!walk(def[rn]) || leaves.length !== 4 || new Set(leaves.map((l) => l.at)).size !== 4 || new Set(eors).size !== 3) return null;
  // where the value's own code begins: the earliest instruction it depends on (before that the window may reach into a
  // literal pool – data that would only stop the trial runs)
  const need = new Set();
  const add = (o) => {
    if (need.has(o)) return;
    need.add(o);
    for (const p of deps.get(o) || []) add(p);
  };
  for (const o of [...leaves.map((l) => l.at), ...eors]) add(o);
  return { rn, leaves, eors, from: Math.min(...need) };
}

/** A copy of `code` up to `end` (literals lie up to 1 KB after the code that loads them) with `edits` applied. */
function edited(code, edits, end) {
  const c = code.slice(0, Math.min(code.length, Math.max(end + 1028, ...edits.map((e) => e.at + e.bytes.length))));
  for (const e of edits) c.set(e.bytes, e.at);
  return c;
}

/**
 * Runs the window [start, at) as it is and with `edits` on random inputs: does `relation(original registers, edited
 * registers)` hold every time (the original rN always a 16-bit value), with the same stores, and which registers end up
 * different? → { ok, changed (mask) }.
 */
function compareRuns(code, start, at, rn, edits, relation) {
  const c = edited(code, edits, at);
  let seed = 0x2545f491 ^ at;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  let changed = 0;
  for (let trial = 0; trial < 96; trial++) {
    const regs = Array.from({ length: 16 }, () => rnd());
    regs[13] = 0x02300000 + ((rnd() & 0xfff) << 2);
    // (half the trials with OT IDs and personalities made shiny-ish: their halves close to equal)
    if (trial & 1) for (const r of [0, 1, 2, 3, 4, 5]) regs[r] = (regs[r] & 0xffff0000) | (((regs[r] >>> 16) ^ (rnd() & 0x3ff)) & 0xffff);
    const mem = new Map();
    const a = run(code, start, at, regs, rnd, mem);
    const b = run(c, start, at, regs, () => 0, new Map(mem)); // (the same memory the original saw)
    if (!a || !b) return { ok: false };
    if (a.regs[rn] > 0xffff || !relation(a.regs, b.regs)) return { ok: false };
    if (JSON.stringify(a.stores) !== JSON.stringify(b.stores)) return { ok: false };
    for (let r = 0; r < 13; r++) if (a.regs[r] !== b.regs[r]) changed |= 1 << r;
  }
  return { ok: true, changed };
}

/** The two ways on from a compare + conditional branch at `at`: the instruction after it and the branch's target. */
const onFrom = (code, at) => [at + 4, decode(code, at + 2).target];

/** The canonical XOR + threshold (see "rewrite" at the top): 7 halfwords for slots, then the compare. */
function rewriteCode({ ra, rb, rn, rt }, k, s) {
  return [
    (ra << 3) | rn, // movs rN, rA
    0x4040 | (rb << 3) | rn, // eors rN, rB
    0x0400 | (rn << 3) | rt, // lsls rT, rN, #16
    0x4040 | (rt << 3) | rn, // eors rN, rT – its upper half is the value
    0x2000 | (rt << 8) | k, // movs rT, #k
    ((16 + s) << 6) | (rt << 3) | rt, // lsls rT, rT, #16+s – the threshold << 16
    NOP,
  ];
}

/**
 * How a check at `at` takes a threshold above 255: 'shift' (all four halves from `lsrs #16`) or 'rewrite' (Gen 3: the
 * low halves masked with `ands`) – { kind, at, first, rn, leaves | slots, … } – or null.
 */
function planCheck(code, at) {
  const x = xorLeaves(code, windowStart(code, at), at);
  if (!x) return null;
  const { rn, leaves, eors, from: start } = x;
  const first = Math.min(...leaves.map((l) => l.at));
  const after = onFrom(code, at);
  if (leaves.every((l) => isLsr16(l.h))) {
    // (s only changes the shift amounts: checked with the smallest and the largest)
    for (const sh of [1, 8]) {
      const edits = leaves.map((l) => ({ at: l.at, bytes: le16((l.h & ~(31 << 6)) | ((16 + sh) << 6)) }));
      const r = compareRuns(code, start, at, rn, edits, (a, b) => b[rn] === a[rn] >>> sh);
      if (!r.ok || !deadAfter(code, after, r.changed)) return null;
    }
    return { kind: 'shift', at, first, rn, leaves: leaves.map((l) => ({ at: l.at, h: l.h })) };
  }
  // rewrite: A and B are what the two `ands` leaves mask (the hi leaves shift the same values, or copies of them)
  const ands = leaves.filter((l) => isAnds(l.h));
  if (ands.length !== 2) return null;
  let [ra, rb] = ands.map((l) => l.h & 7);
  if (rb === rn) [ra, rb] = [rb, ra];
  if (ra === rb || rb === rn) return null;
  const slots = [...leaves.map((l) => l.at), ...eors].sort((p, q) => p - q);
  const br = hw(code, at + 2);
  const shinyTaken = br >> 8 === 0xd9 || br >> 8 === 0xd3; // bls / blo
  // the free register for the threshold: A's or B's (no longer needed once c is made), else one a leaf wrote
  const cands = [...new Set([ra, rb, ...leaves.map((l) => l.h & 7)])].filter((r) => r !== rn);
  for (const rt of cands) {
    const regs = { ra, rb, rn, rt };
    let ok = true;
    for (const [k, sh] of [[128, 1], [255, 7], [128, 8]]) {
      const code7 = rewriteCode(regs, k, sh);
      const edits = [...slots.map((o, i) => ({ at: o, bytes: le16(code7[i]) }))];
      const r = compareRuns(code, start, at, rn, edits, (a, b) => b[rn] >>> 16 === a[rn] && b[rt] === (k << (16 + sh)) >>> 0);
      if (!r.ok || !deadAfter(code, after, r.changed)) {
        ok = false;
        break;
      }
    }
    if (ok) return { kind: 'rewrite', at, first: slots[0], ...regs, slots, br, shinyTaken };
  }
  return null;
}

/** The not-shiny loop at `at` as `lsrs rN, rN, #s` + beq/bne: rN must be dead after it, both ways. */
function planLoop(code, at) {
  const rn = (hw(code, at) >> 8) & 7;
  return deadAfter(code, onFrom(code, at), 1 << rn) ? { at, rn, br: hw(code, at + 2) } : null;
}

/** A Gen 3 picture argument at `at` (`movs r1, #8`): only `movs r2, #imm` up to the `movs r3, #1` → { at, r3 } or null. */
function planLiteral(code, at) {
  for (let o = at + 2; o < at + 10; o += 2) {
    const h = hw(code, o);
    if (h === 0x2301) return blAt(code, o + 2) ? { at, r3: o } : null;
    if ((h & 0xff00) !== 0x2200) return null;
  }
  return null;
}

/**
 * The rewrite for thresholds above 255 (see the top): a plan per check, for the loop and for each picture argument –
 * { ok: true, checks, loop, literals } – or { ok: false, why } when one of them can't be done safely.
 */
export function planHigh(code, located) {
  const checks = located.checks.map((at) => planCheck(code, at));
  if (checks.some((p) => !p)) return { ok: false, why: 'check' };
  const loop = located.loop === null ? null : planLoop(code, located.loop);
  if (located.loop !== null && !loop) return { ok: false, why: 'loop' };
  const literals = located.literals.map((at) => planLiteral(code, at));
  if (literals.some((p) => !p)) return { ok: false, why: 'literal' };
  // nothing may branch into the middle of what changes (it would run half of the old code, half of the new)
  const ranges = [...checks.map((p) => [p.first + 2, p.at + 4]), ...literals.map((p) => [p.at + 2, p.r3 + 2])];
  if (branchedInto(code, ranges).some(Boolean)) return { ok: false, why: 'branch' };
  return { ok: true, checks, loop, literals };
}

const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** The threshold as k × 2^s (k ≤ 255). */
function splitThreshold(t) {
  let s = 0;
  while (t > IMM_MAX) {
    t /= 2;
    s++;
  }
  return { k: t, s };
}

/** The edits of the rewrite for threshold `t` (above 255) from a located game's `high` plan. */
function highEdits(located, t, trainers) {
  const plan = located.high;
  const { k, s } = splitThreshold(t);
  const lessOrEqual = located.gen === 3; // Gen 3: `cmp #7` + bls/bhi, Gen 4/5: `cmp #8` + blo/bhs
  const edits = [];
  for (const p of plan.checks) {
    if (p.kind === 'shift') {
      for (const l of p.leaves) edits.push({ at: l.at, bytes: le16((l.h & ~(31 << 6)) | ((16 + s) << 6)) }); // lsrs #16+s
      edits.push({ at: p.at, bytes: [lessOrEqual ? k - 1 : k] });
    } else {
      const code7 = rewriteCode(p, k, s);
      p.slots.forEach((at, i) => edits.push({ at, bytes: le16(code7[i]) }));
      edits.push({ at: p.at, bytes: le16(0x4280 | (p.rt << 3) | p.rn) }); // cmp rN, rT
      edits.push({ at: p.at + 2, bytes: le16((p.br & 0xf0ff) | ((p.shinyTaken ? 3 : 2) << 8)) }); // blo / bhs
    }
  }
  if (plan.loop) {
    if (trainers) edits.push({ at: plan.loop.at + 2, bytes: le16(NOP) });
    else {
      let sl = 0;
      while (2 ** sl < t) sl++;
      const shinyTaken = plan.loop.br >> 8 === 0xd9 || plan.loop.br >> 8 === 0xd3; // bls / blo
      edits.push({ at: plan.loop.at, bytes: le16(0x0800 | (sl << 6) | (plan.loop.rn << 3) | plan.loop.rn) }); // lsrs rN, rN, #sl
      edits.push({ at: plan.loop.at + 2, bytes: le16((plan.loop.br & 0xf0ff) | ((shinyTaken ? 0 : 1) << 8)) }); // beq / bne
    }
  }
  for (const p of plan.literals) {
    edits.push({ at: p.at, bytes: le16(0x2301) }); // movs r3, #1
    edits.push({ at: p.r3, bytes: le16(0x03d9) }); // lsls r1, r3, #15
  }
  return edits;
}

/** Can the trainer option be patched into this game? (the not-shiny loop of Gen 3/4 – Gen 5 has none to open) */
export const trainerShiniesOk = (located) => !located?.error && located.loop !== null;

/**
 * The byte edits (offsets into `code`) that give a located game the shiny setting: each compare's constant becomes
 * the new threshold, the not-shiny loop runs once with `trainers` (its branch back a nop – NPC Pokémon then keep their
 * first random OT ID and are shiny at the same rate) and Gen 3's SHINY_ODDS arguments move above the threshold. A
 * threshold above 255 takes the rewritten code of the located game's `high` plan (throws if it has none).
 */
export function shinyEdits(located, shiny) {
  const s = cleanShiny(shiny);
  if (!s || located?.error) return [];
  if (s.trainers && !trainerShiniesOk(located)) throw new Error('trainer shinies are not available for this game');
  const t = thresholdOf(s.rate);
  if (t > IMM_MAX) {
    if (!located.high?.ok) throw new Error('this shiny rate is not available for this game');
    return highEdits(located, t, s.trainers).sort((a, b) => a.at - b.at);
  }
  const was = located.gen === 3 ? 7 : 8;
  const value = located.gen === 3 ? t - 1 : t; // Gen 3: `cmp #7` + bls (≤ 7), Gen 4/5: `cmp #8` + blo (< 8)
  const edits = [];
  if (value !== was) for (const at of located.checks) edits.push({ at, bytes: [value] });
  if (located.loop !== null) {
    if (s.trainers) edits.push({ at: located.loop + 2, bytes: [NOP & 0xff, NOP >> 8] });
    else if (value !== was) edits.push({ at: located.loop, bytes: [value] });
  }
  if (t > 8) for (const at of located.literals) edits.push({ at, bytes: [0xff] });
  return edits.sort((a, b) => a.at - b.at);
}
