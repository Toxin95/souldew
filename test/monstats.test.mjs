// Natures, abilities, IVs and EVs on the board (#74): decoded per generation from party data built as the games keep it
// (Game Boy structs, Gen 3's encrypted substructures with their checksum, PK4/PK5 and PK6/PK7 encrypted with their
// checksums), the ability a GBA ROM gives each species, the Showdown export for damage calculators, and that whatever
// wasn't read stays hidden – and private: the stream API, the overlay and the Pokelink bridge don't pass it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, LiveTables, parsePk3 } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { encryptPK6, pk6Mon, BOX_SIZE } from '../shared/live/gen67.mjs';
import { gbaBaseStats, gbaAbilityNames, gbaAbilities } from '../shared/live/romtypes.mjs';
import { cleanSummary, hiddenPower, natureEffect, showdownSet, summaryPk45, GEN_MAX_ABILITY } from '../shared/monstats.mjs';
import { overlaySnapshot } from '../shared/overlay.mjs';
import { buildState } from '../shared/streamapi.mjs';
import { pokelinkPlayers } from '../server/lib/pokelink.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const { loadData } = await import('../web/lib/data.mjs');
const { MonStats, damageCalcText } = await import('../web/views/mondetail.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const P = L('pokeapi.json');
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TABLE = L('addresses.json');
const OFFICIAL = ['en', 'de', 'fr', 'es', 'it'].map((l) => P.abilities[l]);

// the page's names (PokeAPI data, served from /shared/data)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (!String(url).startsWith('/shared/')) throw new Error('offline');
  const body = readFileSync(new URL('..' + url, import.meta.url), 'utf8');
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
};
try {
  await loadData();
} finally {
  globalThis.fetch = realFetch;
}

function memory() {
  const blocks = [];
  return {
    write(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
  };
}
const inv = (charset) => Object.fromEntries(Object.entries(charset.table).map(([k, v]) => [v, parseInt(k, 16)]));
/** Game order (HP, Atk, Def, Spe, SpA, SpD) IVs → the 30-bit word the games keep (+ flags above). */
const ivWord = ([hp, atk, def, spe, spa, spd], top = 0) => (hp | (atk << 5) | (def << 10) | (spe << 15) | (spa << 20) | (spd << 25) | top) >>> 0;
/** A personality value with this nature (pid % 25). */
const pidWith = (nature, from = 0x89abcdef) => from - (from % 25) + nature;

// ---------------------------------------------------------------------------------------------------- Game Boy

function redParty(mon) {
  const m = memory();
  m.write(0xd163, [1, 0x99, 0xff]); // count, Bulbasaur (internal 0x99), terminator
  m.write(0xd16b, mon);
  const cs = inv(L('charset_gen1.json'));
  m.write(0xd2b5, [...'BULBA'].map((c) => cs[c]).concat([0x50]));
  return m;
}

test('Gen 1 (Red): DVs and stat experience from the party struct – the HP DV made of the other four; no nature, ability or Hidden Power', () => {
  const e = findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' });
  const mon = new Uint8Array(44);
  mon[0] = 0x99;
  mon[2] = 18; // HP 18
  mon[8] = 33; mon[9] = 45; // Tackle, Growl
  mon[0x0c] = 0x12; mon[0x0d] = 0x34;
  // stat exp. (big-endian): HP 1000, Atk 2500, Def 0, Spe 65535, Special 400
  [[0x11, 1000], [0x13, 2500], [0x15, 0], [0x17, 65535], [0x19, 400]].forEach(([o, v]) => { mon[o] = v >> 8; mon[o + 1] = v & 0xff; });
  mon[0x1b] = 0xab; mon[0x1c] = 0xcd; // Atk 10, Def 11, Spe 12, Special 13
  mon[0x21] = 7;
  mon[0x23] = 23;
  const r = readLiveParty(e, redParty(mon).read, T);
  const s = r.party[0].summary;
  assert.deepEqual(s, { dvs: [5, 10, 11, 12, 13], statExp: [1000, 2500, 0, 65535, 400] });
  assert.equal(hiddenPower(s, 1), null, 'no Hidden Power in Gen 1');
  // as Showdown takes Gen 1: the EVs that give the same stat (rounded-up square root, at most 255), DV × 2 + 1
  const text = damageCalcText({ species: 1, nick: 'BULBA', level: 7, moves: [33, 45], summary: s }, 1);
  assert.equal(text, [
    'BULBA (Bulbasaur)',
    'Level: 7',
    'EVs: 32 HP / 50 Atk / 20 SpA / 20 SpD / 255 Spe',
    'IVs: 11 HP / 21 Atk / 23 Def / 27 SpA / 27 SpD / 25 Spe',
    '- Tackle',
    '- Growl',
  ].join('\n'));
});

test('Gen 2 (Crystal): DVs and stat experience at their own offsets, Hidden Power from the DVs', () => {
  const e = findEntry(TABLE, { platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
  const m = memory();
  m.write(0xdcd7, [1, 155, 0xff]);
  const mon = new Uint8Array(48);
  mon[0] = 155; // Cyndaquil
  mon[2] = 237; // Hidden Power
  mon[0x0b] = 0x01; mon[0x0c] = 0x00; // HP stat exp. 256
  mon[0x13] = 0x00; mon[0x14] = 0x09; // Special stat exp. 9
  mon[0x15] = 0xff; mon[0x16] = 0xff; // all DVs 15
  mon[0x1f] = 6;
  mon[0x23] = 20;
  mon[0x25] = 22;
  m.write(0xdcdf, mon);
  m.write(0xde41, [0x50]);
  const s = readLiveParty(e, m.read, T).party[0].summary;
  assert.deepEqual(s, { dvs: [15, 15, 15, 15, 15], statExp: [256, 0, 0, 0, 9] });
  assert.deepEqual(hiddenPower(s, 2), { type: 'dark', power: 70 }, 'all DVs 15: the famous Dark 70');
  // Atk 12, Def 13 → type 1 (Flying); the top bits of Atk/Def/Spe/Special and Special's low bits give the power
  assert.deepEqual(hiddenPower({ dvs: [0, 12, 13, 8, 6] }, 2), { type: 'flying', power: Math.floor((5 * (0 + 2 + 4 + 8) + 2) / 2) + 31 });
  assert.match(damageCalcText({ species: 155, level: 6, moves: [237], summary: s }, 2), /^Cyndaquil\nLevel: 6\nEVs: 16 HP \/ 3 SpA \/ 3 SpD\n- Hidden Power \[Dark\]$/);
});

// ---------------------------------------------------------------------------------------------------- Gen 3

const ORDERS = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];
/** A party Pokémon as Gen 3 keeps it: the 48-byte block in the personality's order, checksummed and XOR-encrypted. */
function pk3({ pid, otId = 0xbeefcafe, internal, ivs = 0, evs = [0, 0, 0, 0, 0, 0], level = 9, hp = 20, maxHp = 28 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  const cs = inv(L('charset_gen3.json'));
  [...'MON'].forEach((c, i) => (d[8 + i] = cs[c]));
  d[11] = 0xff;
  d[0x13] = 2; // has species
  const order = ORDERS[pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  const at = (ch) => order.indexOf(ch) * 12;
  pv.setUint16(at('G'), internal, true);
  pv.setUint16(at('A'), 33, true);
  evs.forEach((v, i) => (plain[at('E') + i] = v));
  plain[at('M') + 1] = 101;
  pv.setUint16(at('M') + 2, 5, true);
  pv.setUint32(at('M') + 4, ivs, true);
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

// what the server reads from a FireRed ROM (romtypes.mjs gbaAbilities): Treecko's Overgrow, Geodude's Rock Head /
// Sturdy, Rayquaza's Air Lock (Gen 3 number 77) and a hack's renamed Static
const ABILITIES3 = { slots: Object.assign([], { 277: [65, 0], 74: [69, 5], 406: [77, 0], 25: [9, 0] }), ids: { 76: 0, 77: 76 }, own: { 9: 'Zapcoat' }, max: 77 };
const T3 = T.withRom({ types: { abilities: ABILITIES3 } });

test('Gen 3 (FireRed): nature from the personality, IVs from the Misc word, EVs from the EV substructure, the ability from the ROM\'s table', () => {
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  // HP 31, Atk 30, Def 31, Spe 30, SpA 30, SpD 31 (game order) – Showdown's 31/30/31/30/31/30: Hidden Power Fire 70
  const pid = pidWith(3); // Adamant
  const mons = [
    pk3({ pid, internal: 277, ivs: ivWord([31, 30, 31, 30, 30, 31]), evs: [4, 252, 0, 252, 0, 0] }),
    pk3({ pid: pidWith(10, 0x13572468), internal: 74, ivs: ivWord([1, 2, 3, 4, 5, 6], 0x80000000) }), // second slot: Sturdy
    pk3({ pid: pidWith(0, 0x24681357), internal: 406, ivs: ivWord([0, 0, 0, 0, 0, 0]) }), // Air Lock
  ];
  const m = memory();
  m.write(0x02024029, [mons.length]);
  m.write(0x02024284, mons.flatMap((x) => [...x]));
  const r = readLiveParty(e, m.read, T3);
  assert.deepEqual(r.party.map((x) => x.species), [252, 74, 384]);
  const [treecko, geodude, rayquaza] = r.party.map((x) => x.summary);
  assert.deepEqual(treecko, { nature: 3, ivs: [31, 30, 31, 30, 31, 30], evs: [4, 252, 0, 0, 0, 252], ability: 65 });
  assert.deepEqual(hiddenPower(treecko, 3), { type: 'fire', power: 70 });
  assert.deepEqual(natureEffect(3), { up: 1, down: 3 }, 'Adamant: +Atk −SpA');
  assert.equal(geodude.nature, 10);
  assert.deepEqual(geodude.ivs, [1, 2, 3, 5, 6, 4]);
  assert.equal(geodude.ability, 5, 'the ability bit (IV word bit 31) picks the second slot: Sturdy');
  assert.equal(rayquaza.ability, 76, 'Gen 3 numbers Air Lock 77 – the app\'s 76');
  // a renamed ability keeps the game's name; one the species doesn't have in that slot stays out
  const pika = parsePk3(pk3({ pid: pidWith(5), internal: 25, ivs: ivWord([0, 0, 0, 0, 0, 0]) }), T3).summary;
  assert.deepEqual([pika.ability, pika.abilityName], [9, 'Zapcoat']);
  assert.equal(parsePk3(pk3({ pid: pidWith(5), internal: 277, ivs: ivWord([0, 0, 0, 0, 0, 0], 0x80000000) }), T3).summary.ability, undefined);
  // without the ROM's table: no ability (never the retail one guessed for a randomized game)
  assert.equal(readLiveParty(e, m.read, T).party[0].summary.ability, undefined);
  assert.equal(readLiveParty(e, m.read, T).party[0].summary.nature, 3);
});

test('Gen 3 expanded engines (Run & Bun, Unbound, Radical Red …): no summary – their IVs, abilities and natures sit elsewhere', () => {
  const TX = T.withSpecies({ engine: 'expanded', map: T.idx3 });
  const m = parsePk3(pk3({ pid: pidWith(3), internal: 277, ivs: ivWord([31, 31, 31, 31, 31, 31]) }), TX);
  assert.equal(m.species, 252);
  assert.equal(m.summary, undefined);
});

// ---------------------------------------------------------------------------------------------------- Gen 4 / 5

function plainPk({ size, pid, species, ability, evs, ivs, natureByte = 0, level = 30, hp = 60, maxHp = 70 }) {
  const mon = new Uint8Array(size);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, 31337, true);
  dv.setUint16(0x0e, 4242, true);
  mon[0x15] = ability;
  evs.forEach((v, i) => (mon[0x18 + i] = v));
  dv.setUint16(0x28, 237, true); // Hidden Power
  dv.setUint32(0x38, ivs, true);
  mon[0x41] = natureByte;
  dv.setUint16(0x46, 177, true);
  dv.setUint16(0x80, 177, true);
  mon[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  for (let i = 0x92; i < 0x9c; i += 2) dv.setUint16(i, 50, true);
  return mon;
}

test('Gen 4 (HeartGold): ability, EVs and IVs from the decrypted PK4, the nature from the personality', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const pid = pidWith(15, 0x1234abcd); // Modest
  // IVs (game order) 31/0/31/31/31/31 → Showdown 31/0/31/31/31/31; EVs HP 6, SpA 252, Spe 252
  const plain = plainPk({ size: 236, pid, species: 448, ability: 80, evs: [6, 0, 0, 252, 252, 0], ivs: ivWord([31, 0, 31, 31, 31, 31]), natureByte: 7 });
  const m = memory();
  const base = 0x0227c218;
  m.write(0x02111880, [0x18, 0xc2, 0x27, 0x02]);
  m.write(base + 0xa0, [6, 0, 0, 0, 1, 0, 0, 0, ...encryptPK4(plain)]);
  const x = readLiveParty(e, m.read, T, {}).party[0];
  assert.deepEqual(x.summary, { nature: 15, ivs: [31, 0, 31, 31, 31, 31], evs: [6, 0, 0, 252, 0, 252], ability: 80 }, 'Gen 4 ignores +0x41: no nature byte before Gen 5');
  // 31/0/31/31/31/31: the low bits make 61 → Dragon, the second bits 61 → power 68
  assert.deepEqual(hiddenPower(x.summary, 4), { type: 'dragon', power: 68 });
  assert.deepEqual(hiddenPower({ ivs: [31, 30, 30, 31, 31, 31] }, 4), { type: 'ice', power: 70 });
});

test('Gen 5 (Black 2): the nature byte, not the personality – and an ability number beyond the generation stays out', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const pid = pidWith(3, 0x5eed1234); // the personality says Adamant …
  const mons = [
    plainPk({ size: 220, pid, species: 495, ability: 65, evs: [0, 0, 0, 0, 0, 0], ivs: ivWord([10, 11, 12, 13, 14, 15]), natureByte: 13 }), // … the game: Jolly
    plainPk({ size: 220, pid: 0x10203040, species: 498, ability: 200, evs: [1, 2, 3, 4, 5, 6], ivs: 0, natureByte: 25 }),
  ].map((p) => encryptPK4(p));
  const m = memory();
  const CORE = 0x02000000 + 0x200000 + 0x19728 - 8;
  m.write(0x02000024, [0x00, 0x00, 0x20, 0x02]);
  m.write(CORE, [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...x])]);
  const [a, b] = readLiveParty(e, m.read, T, {}).party.map((x) => x.summary);
  assert.deepEqual(a, { nature: 13, ivs: [10, 11, 12, 14, 15, 13], evs: [0, 0, 0, 0, 0, 0], ability: 65 });
  assert.deepEqual(b, { ivs: [0, 0, 0, 0, 0, 0], evs: [1, 2, 3, 5, 6, 4] }, 'nature byte 25 and ability 200 (Gen 5 ends at 164) are no values: left out');
  assert.equal(GEN_MAX_ABILITY[5], 164);
  // the same decoding serves HeartGold/SoulSilver saves (shared/gen4save.mjs)
  assert.deepEqual(summaryPk45(plainPk({ size: 236, pid: 28, species: 1, ability: 65, evs: [0, 0, 0, 0, 0, 0], ivs: 0 }), 4).nature, 3);
});

// ---------------------------------------------------------------------------------------------------- Gen 6 / 7

test('Gen 6/7 (3DS): ability +0x14, nature +0x1C, EVs +0x1E, IVs +0x74 of the decrypted PK6/PK7; Hidden Power 60', () => {
  const d = new Uint8Array(BOX_SIZE + 0x1c);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, 0x12345678, true); // encryption constant
  dv.setUint16(0x08, 727, true); // Incineroar
  d[0x14] = 66; // Blaze
  d[0x1c] = 3; // Adamant
  [252, 252, 0, 4, 0, 0].forEach((v, i) => (d[0x1e + i] = v)); // HP, Atk, Def, Spe, SpA, SpD
  dv.setUint32(0x18, 0xa1b2c3d4, true);
  dv.setUint32(0x74, ivWord([31, 31, 31, 31, 30, 31]), true);
  d[0xec] = 40;
  dv.setUint16(0xf0, 120, true);
  dv.setUint16(0xf2, 130, true);
  for (let o = 0xf4; o < 0xfe; o += 2) dv.setUint16(o, 90, true);
  const m = pk6Mon(encryptPK6(d), 7);
  assert.deepEqual(m.summary, { nature: 3, ivs: [31, 31, 31, 30, 31, 31], evs: [252, 252, 0, 0, 0, 4], ability: 66 });
  assert.equal(hiddenPower(m.summary, 7).power, 60);
  d[0x14] = 240; // beyond Gen 7's last ability
  assert.equal(pk6Mon(encryptPK6(d), 7).summary.ability, undefined);
});

// ---------------------------------------------------------------------------------------------------- the ROM

/** A GBA ROM with a retail base stats table (28 bytes per species) and the ability names (13 bytes each). */
function gbaRom({ stride = 28, rename = {} } = {}) {
  const rom = new Uint8Array(0x60000);
  const base = 0x10000;
  for (let i = 1; i <= 411; i++) {
    const e = base + i * stride;
    const stats = i === 1 ? [45, 49, 49, 45, 65, 65] : i === 2 ? [60, 62, 63, 60, 80, 80] : i === 3 ? [80, 82, 83, 80, 100, 100] : [50, 50, 50, 50, 50, 50];
    rom.set(stats, e);
    rom[e + 6] = 12; rom[e + 7] = 3; rom[e + 8] = 45; // types, catch rate
    rom[e + 0x13] = 3; // growth rate
    rom[e + 0x16] = 1 + (i % 75); rom[e + 0x17] = 0;
  }
  const put = (i, a, b) => { rom[base + i * stride + 0x16] = a; rom[base + i * stride + 0x17] = b; };
  put(1, 65, 34); // Overgrow / Chlorophyll (a randomizer's choice)
  put(406, 77, 0); // Air Lock
  const cs = inv(L('charset_gen3.json'));
  const names = ['-------', ...P.abilities.en.slice(1, 76).map((n) => n.toUpperCase().replace(/[^A-Z]/g, '')), 'CACOPHONY', 'AIRLOCK'];
  for (const [id, n] of Object.entries(rename)) names[id] = n;
  names.forEach((n, i) => {
    const at = 0x30000 + i * 13;
    [...n].forEach((c, k) => (rom[at + k] = cs[c]));
    rom[at + n.length] = 0xff;
  });
  return rom;
}

test('GBA ROM: each species\' abilities from the base stats, numbered as the app numbers them, renamed ones by the game\'s name', () => {
  const rom = gbaRom({ rename: { 34: 'SUNSOAK' } });
  const names = gbaAbilityNames(rom, L('charset_gen3.json'), OFFICIAL.map((l) => l[1]), OFFICIAL.map((l) => l[2]));
  assert.equal(names.offset, 0x30000);
  assert.equal(names.stride, 13);
  assert.equal(names.names.length, 78);
  const base = gbaBaseStats(rom, 411);
  const a = gbaAbilities(rom, base, names, OFFICIAL);
  assert.deepEqual(a.slots[1], [65, 34]);
  assert.deepEqual(a.ids, { 77: 76 }, 'Air Lock: the app\'s 76');
  assert.deepEqual(a.own, { 34: 'SUNSOAK', 76: 'CACOPHONY' }, 'renamed – and the unused Cacophony, which the app has no name for');
  assert.equal(a.max, 77);
  // through the live reader: Bulbasaur's second slot is the game's renamed ability
  const s = parsePk3(pk3({ pid: pidWith(1), internal: 1, ivs: ivWord([0, 0, 0, 0, 0, 0], 0x80000000) }), T.withRom({ types: { abilities: a } })).summary;
  assert.deepEqual([s.ability, s.abilityName], [34, 'SUNSOAK']);
  // without the names: the retail numbers
  assert.deepEqual(gbaAbilities(rom, base, null, OFFICIAL).ids, { 76: 0, 77: 76 });
  // another layout (36 bytes: an expanded engine's) is not read
  const wide = gbaRom({ stride: 36 });
  assert.equal(gbaAbilities(wide, gbaBaseStats(wide, 411), null, OFFICIAL), null);
});

// ---------------------------------------------------------------------------------------------------- the export

test('Showdown export: nickname, species, gender, item, ability, level, shiny, EVs, nature, IVs, moves with Hidden Power\'s type', () => {
  const mon = {
    species: 448, nick: 'Lucky', gender: 'M', level: 52, shiny: true, item: 234, moves: [396, 237, 0, 53],
    summary: { nature: 15, ability: 80, ivs: [31, 0, 31, 31, 31, 31], evs: [6, 0, 0, 252, 0, 252] },
  };
  assert.equal(damageCalcText(mon, 4), [
    'Lucky (Lucario) (M) @ Leftovers',
    'Ability: Steadfast',
    'Level: 52',
    'Shiny: Yes',
    'EVs: 6 HP / 252 SpA / 252 Spe',
    'Modest Nature',
    'IVs: 0 Atk',
    '- Aura Sphere',
    '- Hidden Power [Dragon]',
    '- Flamethrower',
  ].join('\n'));
  // a form that changes stats or types by Showdown's name; Nidoran's sign the way Showdown spells it; the default
  // nickname is no nickname; a level-100 Pokémon has no Level line
  assert.equal(damageCalcText({ species: 479, form: 2, level: 30, moves: [] }, 4), 'Rotom-Wash\nLevel: 30');
  assert.equal(damageCalcText({ species: 29, nick: 'NIDORAN♀', level: 100, moves: [] }, 3), 'Nidoran-F');
  assert.equal(damageCalcText({ species: 26, form: 1, level: 20, moves: [] }, 7), 'Raichu-Alola\nLevel: 20');
  // a renamed ability (Gen 3 hack) by the game's name; a ROM hack's own item by its name
  assert.match(damageCalcText({ species: 25, level: 5, item: 400, itemOwn: true, itemName: 'Volt Orb', moves: [], summary: { ability: 9, abilityName: 'Zapcoat' } }, 3), /^Pikachu @ Volt Orb\nAbility: Zapcoat\n/);
});

test('missing data stays hidden: no line for what wasn\'t read, garbage dropped, nothing for an egg', () => {
  // nothing read: species, level and moves only
  assert.equal(damageCalcText({ species: 252, level: 9, moves: [33] }, 3), 'Treecko\nLevel: 9\n- Tackle');
  // Gen 1/2 never get a nature or an ability line, even with a stray value
  assert.doesNotMatch(damageCalcText({ species: 1, level: 5, moves: [], summary: { nature: 3, ability: 65, dvs: [15, 15, 15, 15, 15] } }, 2), /Nature|Ability/);
  // EVs all 0 and IVs all 31: no line (Showdown's defaults)
  assert.equal(damageCalcText({ species: 252, level: 9, moves: [], summary: { ivs: [31, 31, 31, 31, 31, 31], evs: [0, 0, 0, 0, 0, 0] } }, 3), 'Treecko\nLevel: 9');
  // the shapes a partner's app may send: only valid fields are kept
  assert.equal(cleanSummary({ ivs: [1, 2, 3], evs: 'x', nature: 25, ability: 0 }), null);
  assert.deepEqual(cleanSummary({ ivs: [31, 31, 31, 31, 31, 32], evs: [0, 0, 0, 0, 0, 0], nature: 24, abilityName: 'X' }), { nature: 24, evs: [0, 0, 0, 0, 0, 0] });
  assert.equal(hiddenPower({ evs: [0, 0, 0, 0, 0, 0] }, 3), null);
  assert.equal(showdownSet({ species: 0 }, 3, {}), '');
});

/** The text a vnode tree shows (function components called with their props). */
const shown = (v) => (v == null || typeof v === 'boolean' ? '' : typeof v !== 'object' ? String(v)
  : Array.isArray(v) ? v.map(shown).join(' ') : typeof v.type === 'function' ? shown(v.type(v.props)) : shown(v.props?.children));

test('the board\'s stats block shows only the lines the game holds', () => {
  assert.equal(MonStats({ mon: { species: 1 }, gen: 3 }), null, 'nothing read: no block at all');
  const gb = shown(MonStats({ mon: { species: 1, summary: { dvs: [5, 10, 11, 12, 13], statExp: [1, 2, 3, 4, 5] } }, gen: 1 }));
  assert.match(gb, /DVs/);
  assert.match(gb, /Stat exp\./);
  assert.doesNotMatch(gb, /Nature|Ability|Hidden Power|IVs|EVs/);
  assert.match(shown(MonStats({ mon: { species: 155, summary: { dvs: [15, 15, 15, 15, 15] } }, gen: 2 })), /Hidden Power.*Dark.*70/);
  const g3 = shown(MonStats({ mon: { species: 252, summary: { nature: 3, ivs: [31, 30, 31, 30, 31, 30], evs: [4, 252, 0, 0, 0, 252] } }, gen: 3 }));
  assert.match(g3, /Nature.*Adamant/);
  assert.match(g3, /Hidden Power.*Fire.*70/);
  assert.match(g3, /508/, 'the EV total');
  assert.doesNotMatch(g3, /Ability/, 'no ability read (no ROM table): no line');
  const g7 = shown(MonStats({ mon: { species: 727, summary: { ability: 66, ivs: [31, 31, 31, 31, 31, 31] } }, gen: 7 }));
  assert.match(g7, /Ability.*Blaze/);
  assert.doesNotMatch(g7, /Nature|EVs|60/, 'no nature read, no EV row; Gen 6/7 Hidden Power shows no power');
});

// ---------------------------------------------------------------------------------------------------- the run

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}

test('the live party carries the summary (cleaned) – not for an egg; the stream API, overlay and Pokelink don\'t pass it on', () => {
  const manifest = { id: 'run1', game: { id: 'pokemon-heartgold', code: 'IPKE', system: 'nds' }, mode: 'soullink', players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } } };
  const d = mkDoc();
  const summary = { nature: 15, ability: 80, ivs: [31, 0, 31, 31, 31, 31], evs: [6, 0, 0, 252, 0, 252] };
  R.applySnapshot(d, manifest, 4, 'p1', {
    source: 'live',
    party: [
      { key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, moves: [33], summary },
      { key: 'k2', species: 175, nickname: 'EGG', level: 1, hp: 10, maxHp: 10, metLocation: 126, metLevel: 0, isEgg: true, summary },
      { key: 'k3', species: 16, nickname: 'PIP', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, summary: { ivs: [99, 0, 0, 0, 0, 0], nature: 30 } },
    ],
  });
  const party = R.live(d, 'p1').party;
  assert.deepEqual(party[0].summary, summary);
  assert.equal(party[1].summary, undefined, 'an egg\'s stay out');
  assert.equal(party[2].summary, undefined, 'garbage isn\'t stored');
  // what leaves the computer for viewers: none of it
  const raw = Object.fromEntries(Object.entries(d.entries).map(([k, e]) => [k, { v: e.v, t: e.t }]));
  const bad = /summary|ivs|evs|"nature"|"ability"/;
  assert.doesNotMatch(JSON.stringify(overlaySnapshot(manifest, raw)), bad, 'overlay');
  assert.doesNotMatch(JSON.stringify(buildState(manifest, raw, { speciesName: (id) => `S${id}`, itemName: () => null, gameName: () => null })), bad, 'stream API');
  const mon = pokelinkPlayers(manifest, raw)[0].party[0].pokemon;
  assert.deepEqual([mon.nature, mon.ability, Object.values(mon.ivs).every((v) => v === 0), Object.values(mon.evs).every((v) => v === 0)], ['', '', true, true], 'Pokelink');
});

test('every nature\'s effect matches the PokeAPI data the app names them with', () => {
  for (let n = 0; n < 25; n++) {
    const [up, down] = P.natureStats[n];
    assert.deepEqual(natureEffect(n), up === down ? null : { up, down }, P.natures.en[n]);
  }
});
