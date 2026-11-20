// The place sign in every language (shared/live/location.mjs): what the readers do when the RAM isn't laid out like
// the English game's – another language, a game still booting, zeroed RAM. The rule: the right place or none, never a
// wrong one. Other languages are simulated by moving the game's variables (the ROM's data stays the same – in a
// German or French game its map headers are the same bytes, found by their structure: test/romloc.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLocation, locationLabel } from '../shared/live/location.mjs';
import { romData } from '../server/lib/romloc.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const maps = json('maps.json');
const loc2 = json('locations_gen2_crystal.json');
const loc3 = json('locations_gen3.json');
const gen4 = json('gen4.json');
const tables = { maps, loc2, loc3, gen4 };
const name = (r) => (r ? locationLabel(r.gen, r.id, tables, 'en') : null);
const hexOf = (a) => a.map((v) => v.toString(16).padStart(2, '0')).join('');
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** A Game Boy's WRAM (0xC000–0xDFFF) as the players read it (web/player.html toOff), counting the reads of it all. */
function gbRam() {
  const ram = new Uint8Array(0x2000);
  const bus = {
    ram,
    big: 0,
    set: (addr, bytes) => ram.set(bytes, addr - 0xc000),
    read: (addr, len) => {
      if (addr < 0xc000 || addr + len > 0xe000) return null;
      if (len >= 0x1000) bus.big++;
      return ram.slice(addr - 0xc000, addr - 0xc000 + len);
    },
  };
  return bus;
}

// ---------------------------------------------------------------- Gen 1

// Red's map headers as the ROM data hands them over (server/lib/romloc.mjs gbMaps): 10 bytes each, made up but shaped
// like the real ones (tileset, height, width, three pointers, connections) – the towns tileset 0, map 11 unused (no
// header), maps 74 and 75 share one (two halves of a building: one place), as do 0x0C and 0x0D for the test of a shared
// header between two places
const g1Header = (i) => [i < 9 ? 0 : 1 + (i % 20), 9 + (i % 7), 10 + (i % 5), ...[0x4000 + i * 16, 0x5000 + i * 8, 0x6000 + i * 8].flatMap((p) => [p & 0xff, p >> 8]), i % 16];
const g1 = { gen: 1, headers: Array.from({ length: 248 }, (_, i) => (i === 11 ? null : hexOf(g1Header(i === 75 ? 74 : i)))) };
const red = (bus, state = null, gbMaps = g1) => readLocation(maps, 'red_us', bus.read, { gbMaps, state });

test('Gen 1: the place comes from the copy of the map header (English addresses)', () => {
  const bus = gbRam();
  bus.set(0xd35e, [0x0c]); // wCurMap: Route 1
  bus.set(0xd367, g1Header(0x0c)); // wCurMapHeader
  assert.deepEqual(red(bus), { gen: 1, id: maps.tables.gen1.pokered['12'], map: 12 });
  assert.equal(name(red(bus)), 'Route 1');
  // the header's tileset with bit 7 set (LoadMapHeader's "no previous map" flag) is still the same header
  bus.set(0xd367, [0x80 | g1Header(0x0c)[0]]);
  assert.equal(name(red(bus)), 'Route 1');
  // Yellow keeps it one byte lower, like wCurMap
  const y = gbRam();
  y.set(0xd35d, [0x0c]);
  y.set(0xd366, g1Header(0x0c));
  assert.equal(name(readLocation(maps, 'yellow_us', y.read, { gbMaps: g1 })), 'Route 1');
});

/**
 * A made-up Yellow ROM (1 MB) shaped like the real one: its cartridge header (the CGB flag – the title runs on into the
 * bytes of a manufacturer code: "POKEMON YEL" + "LOW") and its 249 maps' headers (g1Header) behind MapHeaderPointers and
 * MapHeaderBanks where pret puts them (pokeyellow.sym 3F:41F2 / 3F:43E4).
 */
function yellowRom() {
  const rom = new Uint8Array(0x100000);
  rom.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104);
  rom.set([...'POKEMON YELLOW'].map((c) => c.charCodeAt(0)), 0x134);
  rom[0x143] = 0x80;
  const pointers = 0x3f * 0x4000 + 0x1f2;
  const banks = 0x3f * 0x4000 + 0x3e4;
  for (let i = 0; i < 249; i++) {
    const bank = 5 + (i % 3);
    const ptr = 0x4100 + i * 16;
    rom.set([ptr & 0xff, ptr >> 8], pointers + i * 2);
    rom[banks + i] = i === 11 ? 0 : bank;
    rom.set(g1Header(i), bank * 0x4000 + ptr - 0x4000);
  }
  return rom;
}

test('Gen 1: Yellow through the real path – its ROM data (249 maps) checks the copy of the header, Summer Beach House too', () => {
  const r = romData(yellowRom(), fileURLToPath(new URL('../shared', import.meta.url)));
  // (the memory table entry wasn't found from Yellow's header, and 248 headers never matched its table of 249 maps:
  // no ROM headers at all – the place came from the unchecked English wCurMap)
  assert.equal(r.gbMaps?.headers?.length, 249, 'the ROM data hands over Yellow\'s headers');
  const y = gbRam();
  y.set(0xd35d, [248]); // wCurMap: Summer Beach House, Yellow's own map
  y.set(0xd366, g1Header(248));
  assert.deepEqual(readLocation(maps, 'yellow_us', y.read, { gbMaps: r.gbMaps, state: {} }), { gen: 1, id: maps.tables.gen1.pokeyellow['248'], map: 248 });
  // another language's WRAM: found by the copy of the header, the number at the English address is not trusted
  const moved = gbRam();
  moved.set(0xd35d, [0]);
  moved.set(0xd35d + 0x2b, [0x0c]);
  moved.set(0xd366 + 0x2b, g1Header(0x0c));
  assert.equal(name(readLocation(maps, 'yellow_us', moved.read, { gbMaps: r.gbMaps, state: {} })), 'Route 1');
});

test('Gen 1: zeroed WRAM (title screen, Oak’s intro) is no place – it used to be Pallet Town', () => {
  const bus = gbRam();
  assert.equal(red(bus, {}), null);
  assert.equal(red(bus, null, null), null, 'without the ROM’s headers too: no header loaded yet');
  // without the ROM's headers, once a header is loaded: wCurMap as before
  bus.set(0xd35e, [0]);
  bus.set(0xd367, g1Header(0));
  assert.equal(name(red(bus, null, null)), 'Pallet Town');
});

test('Gen 1: another language’s WRAM – the copy is searched for, remembered, and never guessed', () => {
  const bus = gbRam();
  // the English addresses hold something else (here: map 0, Pallet Town – exactly what a wrong address shows);
  // the game's own variables sit 0x2B bytes further on
  bus.set(0xd35e, [0]);
  bus.set(0xd35e + 0x2b, [0x0c]);
  bus.set(0xd367 + 0x2b, g1Header(0x0c));
  const st = {};
  assert.equal(name(red(bus, st)), 'Route 1');
  assert.equal(st.gbHeaderAt, 0xd367 + 0x2b, 'remembered');
  assert.equal(bus.big, 1, 'one search');
  for (let i = 0; i < 20; i++) assert.equal(name(red(bus, st)), 'Route 1');
  assert.equal(bus.big, 1, 'then read at the remembered address only');
  // a new map there: followed
  bus.set(0xd35e + 0x2b, [0x01]);
  bus.set(0xd367 + 0x2b, g1Header(0x01));
  assert.equal(name(red(bus, st)), 'Viridian City');
  // without the state (nothing to remember a search in): no search, no place – never the English address's map
  assert.equal(red(bus, null), null);
  assert.equal(bus.big, 1);
});

test('Gen 1: searches are rare, a second copy or no copy is no place', () => {
  const bus = gbRam();
  const st = {};
  assert.equal(red(bus, st), null);
  assert.equal(red(bus, st), null);
  assert.equal(bus.big, 1, 'at most one search every 2 s');
  st.gbHeaderScan -= 5000;
  // two copies of a header: neither is trusted
  bus.set(0xc100, [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, ...g1Header(0x0c)]);
  bus.set(0xd100, [0x0d, 0, 0, 0, 0, 0, 0, 0, 0, ...g1Header(0x0d)]);
  assert.equal(red(bus, st), null);
  assert.equal(bus.big, 2);
  assert.equal(st.gbHeaderAt, null, 'nothing remembered');
});

test('Gen 1: between two maps (the fade-out after a warp) the header still names the old map – no gap, no wrong place', () => {
  const bus = gbRam();
  bus.set(0xd35e, [0x25]); // wCurMap already the next map …
  bus.set(0xd367, g1Header(0x0c)); // … the header still Route 1's
  assert.equal(name(red(bus)), 'Route 1');
  // a header two maps share: one place → that place; two places → the one wCurMap names, else none
  bus.set(0xd367, g1Header(74));
  bus.set(0xd35e, [0x20]);
  assert.equal(red(bus)?.map, 74);
  const two = { gen: 1, headers: g1.headers.map((h, i) => (i === 0x0d ? g1.headers[0x0c] : h)) };
  bus.set(0xd367, g1Header(0x0c));
  bus.set(0xd35e, [0x0d]);
  assert.equal(red(bus, null, two)?.map, 0x0d);
  bus.set(0xd35e, [0x30]);
  assert.equal(red(bus, null, two), null);
  // an unused map id (no header in the ROM) never matches
  bus.set(0xd35e, [11]);
  bus.set(0xd367, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(red(bus), null);
});

// ---------------------------------------------------------------- Gen 2

// Crystal's maps (group.number, as maps.json): 5 bytes of the map's header + 12 of its attributes each, made up
const g2Keys = Object.keys(maps.tables.gen2.pokecrystal).filter((k) => !k.startsWith('_'));
const g2Header = (k) => {
  const i = g2Keys.indexOf(k);
  return [0x25, 1 + (i % 30), 1 + (i % 7), ...[0x4000 + i * 32].flatMap((p) => [p & 0xff, p >> 8]), i & 0xff, 5 + (i % 9), 5 + (i % 11), 0x26, 0x00, 0x50 + (i % 32), 0x27, i & 0xff, 0x60, 0x10, 0x70, i % 16];
};
const g2 = { gen: 2, maps: Object.fromEntries(g2Keys.map((k) => [k, hexOf(g2Header(k))])) };
const crystal = (bus, state = null, gbMaps = g2) => readLocation(maps, 'crystal_us', bus.read, { gbMaps, state });

test('Gen 2: the place comes from the copy of wMapPartial + wMapAttributes; zeroed WRAM is none', () => {
  const bus = gbRam();
  assert.equal(crystal(bus, {}), null);
  bus.set(0xd198, g2Header('24.3'));
  assert.deepEqual(crystal(bus), { gen: 2, id: 2, map: '24.3' });
  assert.equal(name(crystal(bus)), 'Route 29');
  // wMapGroup/wMapNumber don't matter: they change first on a warp, the copy follows
  bus.set(0xdcb5, [24, 4]);
  assert.equal(name(crystal(bus)), 'Route 29');
  // landmark 0 (Pokémon Center 2F …): no place
  const special = g2Keys.find((k) => maps.tables.gen2.pokecrystal[k] === 0);
  bus.set(0xd198, g2Header(special));
  assert.equal(crystal(bus), null);
});

test('Gen 2: another language’s WRAM – found by the copy, never by the English map number', () => {
  const bus = gbRam();
  bus.set(0xdcb5, [24, 3]); // the English wMapGroup/wMapNumber read Route 29 …
  bus.set(0xd198 - 0x31, g2Header('24.4')); // … but the game is in New Bark Town, its copy elsewhere
  const st = {};
  assert.equal(name(crystal(bus, st)), 'New Bark Town');
  assert.equal(st.gbHeaderAt, 0xd198 - 0x31);
  // without the ROM's headers the fixed addresses are all there is (and zeroed WRAM still reads as nothing)
  assert.equal(name(crystal(bus, null, null)), 'Route 29');
  assert.equal(crystal(gbRam(), null, null), null);
});

// ---------------------------------------------------------------- Gen 3

test('Gen 3: gMapHeader must be one of the ROM’s maps (events pointer and section) when the ROM data is there', () => {
  const ram = new Map();
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => ram.get(a + i) ?? 0);
  const put = (a, bytes) => bytes.forEach((b, i) => ram.set(a + i, b));
  const hdr = (layout, events, sec) => [...le32(layout), ...le32(events), ...le32(0x08600000), ...le32(0), 0, 0, 0, 0, sec, 0, 0, 0];
  // two maps: Route 101 (section 16) with events 0x08500000, Littleroot Town (0) with 0x08500100
  const rom = { gen: 3, family: 'rse', names: [], headers3: hexOf([...le32(0x08500000), 16, ...le32(0x08500100), 0]) };
  const em = () => readLocation(maps, 'emerald_us', read, { rom });
  put(0x02037318, hdr(0x08481234, 0x08500000, 16));
  assert.equal(em()?.id, 16);
  // the Trick House & co. swap the layout: still the map
  put(0x02037318, hdr(0x08499990, 0x08500000, 16));
  assert.equal(em()?.id, 16);
  put(0x02037318, hdr(0x08481234, 0x08500100, 0));
  assert.equal(em()?.id, 0);
  // a header that isn't one of the ROM's maps (another language's RAM, garbage with two ROM pointers): none
  put(0x02037318, hdr(0x08481234, 0x08777700, 16));
  assert.equal(em(), null);
  put(0x02037318, hdr(0x08481234, 0x08500000, 17));
  assert.equal(em(), null, 'the section must be the map’s');
  // without the headers (an older ROM data cache): the two ROM pointers as before
  assert.equal(readLocation(maps, 'emerald_us', read, { rom: { ...rom, headers3: undefined } })?.id, 17);
});

// ---------------------------------------------------------------- Gen 4

test('Gen 4, other languages: the save data where the party reader confirmed it, else a pointer whose save holds a trainer – never a guess', () => {
  const save = 0x0227a000;
  const rom = { gen: 4, family: 'hgss', mapLoc: maps.tables.gen4.hgss, names: gen4.locations };
  const ram = new Map();
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => ram.get(a + i) ?? 0);
  const put = (a, bytes) => bytes.forEach((b, i) => ram.set(a + i, b));
  // German HeartGold: the module params lead to a SaveData-sized block with a map id – but no trainer (another
  // structure, or the save data before the intro named the player): no place
  put(0x02000ba8, le32(0x02111800));
  put(0x02111820, le32(save));
  put(save + 0x1244, le32(33));
  const de = (state) => readLocation(maps, 'heartgold_us~IPKD', read, { rom, state });
  assert.equal(de({}), null, 'no trainer there: no place');
  assert.equal(de({ partyAddr: save + 0xa0 }), null, 'a party found by scanning may be a battle’s copy: no place from it alone');
  assert.equal(name(de({ saveBase: save })), 'Route 29', 'the save data the party reader confirmed (its trainer owns the team)');
  // with a trainer (PKHeX Trainer1 at +0x74: name "AB", money, gender) the pointer's save data counts
  put(save + 0x74, [0x2b, 0x01, 0x2c, 0x01, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, ...le32(3000), 0, 5]);
  assert.equal(name(de({})), 'Route 29');
  // English: pret's pointer
  put(0x02111880, le32(save));
  assert.equal(name(readLocation(maps, 'heartgold_us', read, { rom, state: {} })), 'Route 29');
  // zeroed save data: map 0 is the Mystery Zone – no place
  put(save + 0x1244, le32(0));
  assert.equal(de({ saveBase: save }), null);
});

test('Gen 4: a real trainer block passes the check (Platinum US, read live: "AAAAAAA", 3000 money, language 2)', () => {
  const save = 0x0227e150;
  const tr = Buffer.from('2b012b012b012b012b012b012b01ffffb6b1fa2eb80b00000002', 'hex');
  const ram = new Map();
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => ram.get(a + i) ?? 0);
  const put = (a, bytes) => bytes.forEach((b, i) => ram.set(a + i, b));
  put(0x02101d40, le32(save));
  put(save + 0x7c, [...tr]);
  put(save + 0x1294, le32(342));
  assert.equal(name(readLocation(maps, 'platinum_us', read, {})), 'Route 201');
});

// ---------------------------------------------------------------- Gen 5: Black 2/White 2

/** A DS main RAM (4 MiB, zeroed) with a bus read that counts the reads of all of it. */
function dsRam() {
  const ram = new Uint8Array(0x400000);
  const bus = {
    ram,
    big: 0,
    set: (a, bytes) => ram.set(bytes, a - 0x02000000),
    read: (a, n) => {
      if (a < 0x02000000 || a + n > 0x02400000) return null;
      if (n >= 0x100000) bus.big++;
      return ram.slice(a - 0x02000000, a - 0x02000000 + n);
    },
  };
  return bus;
}
// Black 2's zones as the ROM data hands them over: 48 bytes each, parent at +0x18 (zone 0 Black City – what zeroed
// RAM read as –, 1 a room in zone 3, 3 Aspertia City)
const zones = new Uint8Array(5 * 48);
for (let z = 0; z < 5; z++) {
  zones.set([0x10, z, 0xd2, z * 3], z * 48);
  zones.set([z === 1 ? 3 : z, 0], z * 48 + 0x18);
}
const b2 = { gen: 5, family: 'b2w2', code: 'IREO', lang: 'en', mapLoc: [50, 0, 0, 117, 0], names: Object.assign(new Array(118).fill(''), { 50: 'Black City', 117: 'Aspertia City' }), zoneHeaders: hexOf([...zones]) };
const copyOf = (z) => [...zones.subarray(z * 48, z * 48 + 48), z & 0xff, z >> 8];
const black2 = (bus, state = null) => readLocation(maps, 'black2_us', bus.read, { rom: b2, state });

test('Black 2/White 2: the copy of the zone header behind the main pointer; zeroed RAM is no place (was Black City)', () => {
  const bus = dsRam();
  bus.set(0x02000024, le32(0x02204cc4));
  assert.equal(black2(bus, {}), null, 'power-on: the pointer is set, the field isn’t (Black 2 / White 2 US live: zone 0)');
  bus.set(0x02204cc4 + 0x41b2c, copyOf(3));
  assert.equal(black2(bus)?.romName, 'Aspertia City');
  bus.set(0x02204cc4 + 0x41b2c, copyOf(1));
  assert.deepEqual(black2(bus), { gen: 5, id: 117, map: 3, romName: 'Aspertia City' }, 'the room: its parent zone');
  // a zone id with a header that isn't its own (zone 3 after room 1's header, whose parent is 3 too): behind an English
  // game's own pointer that is a header the game changed while it runs – mostly the ROM's bytes, the same parent –, the
  // place stays (as Black/White's, see bwLooseZone); in another language only an exact copy counts
  bus.set(0x02204cc4 + 0x41b2c + 48, [3, 0]);
  assert.equal(black2(bus)?.romName, 'Aspertia City');
  assert.equal(readLocation(maps, 'black2_us', bus.read, { rom: { ...b2, code: 'IREF' } }), null);
  // … but not with another parent, nor for zone 0
  bus.set(0x02204cc4 + 0x41b2c + 48, [4, 0]);
  assert.equal(black2(bus), null);
  bus.set(0x02204cc4 + 0x41b2c + 48, [0, 0]);
  assert.equal(black2(bus), null);
});

test('Black 2/White 2: a mismatching poll keeps the place, a lost copy is searched for again – slowly', () => {
  const bus = dsRam();
  bus.set(0x02000024, le32(0x02204cc4));
  bus.set(0x02204cc4 + 0x41b2c, copyOf(3));
  const st = {};
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  bus.set(0x02204cc4 + 0x41b2c, new Array(50).fill(0)); // the game rewriting the copy (or back on the title screen)
  assert.equal(black2(bus, st)?.romName, 'Aspertia City', 'one poll: the place stays');
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  assert.equal(black2(bus, st), null, 'then no place');
  assert.equal(bus.big, 1, 'and one search');
  for (let i = 0; i < 6; i++) {
    st.b2w2ZoneScan -= 3000;
    black2(bus, st);
  }
  const n = bus.big;
  st.b2w2ZoneScan -= 3000;
  black2(bus, st);
  assert.equal(bus.big, n, 'after several searches without a hit: every 30 s only');
  // another game in the same state: searched for at once, at the fast pace again
  const other = { ...b2, code: 'IRDO', zoneHeaders: b2.zoneHeaders + '00'.repeat(48) };
  readLocation(maps, 'white2_us', bus.read, { rom: other, state: st });
  assert.equal(bus.big, n + 1);
  assert.equal(st.b2w2ScanMiss, 1);
});

test('Black 2/White 2, another language: the copy searched for, remembered; the pointer never trusted alone', () => {
  const bus = dsRam();
  bus.set(0x02000024, le32(0x02204cc4));
  bus.set(0x02204cc4 + 0x41b2c + 48, [0, 0]); // what the English address holds: zone 0 – Black City
  bus.set(0x0225d830, copyOf(3)); // the game's copy, elsewhere
  const st = {};
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  assert.equal(st.b2w2ZoneAt, 0x0225d830);
  for (let i = 0; i < 10; i++) black2(bus, st);
  assert.equal(bus.big, 1, 'one search, then the remembered address');
  // no state: nothing searched for, no place
  assert.equal(black2(bus, null), null);
  // two copies: neither
  const two = dsRam();
  two.set(0x0225d830, copyOf(3));
  two.set(0x0230d830, copyOf(1));
  const st2 = {};
  assert.equal(black2(two, st2), null);
  assert.equal(black2(two, st2), null);
  assert.equal(two.big, 1, 'searched at most every 3 s');
});

test('Black 2/White 2: a lost copy’s address is read again on every poll – back in the game, the place at once', () => {
  const bus = dsRam();
  bus.set(0x02000024, le32(0x02204cc4));
  bus.set(0x02204cc4 + 0x41b2c + 48, [0, 0]); // the English address: zone 0
  bus.set(0x0225d830, copyOf(3)); // another language's copy, found by the search
  const st = {};
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  bus.set(0x0225d830, new Array(50).fill(0)); // back on the title screen
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  assert.equal(black2(bus, st)?.romName, 'Aspertia City');
  assert.equal(black2(bus, st), null, 'then no place');
  for (let i = 0; i < 6; i++) {
    st.b2w2ZoneScan -= 3000;
    black2(bus, st);
  }
  const n = bus.big;
  // the game loaded again: its copy where it was – the place on the next poll, without a search (the address was
  // dropped: the sign stayed empty until the next search, up to 30 s)
  bus.set(0x0225d830, copyOf(1));
  assert.deepEqual(black2(bus, st), { gen: 5, id: 117, map: 3, romName: 'Aspertia City' });
  assert.equal(bus.big, n);
  assert.equal(st.b2w2ScanMiss, 0);
});

test('Black 2/White 2: the slow searches go back to the fast pace once the game sets something up – never a wrong place', () => {
  const bus = dsRam();
  bus.set(0x02000024, le32(0x02204cc4));
  bus.set(0x02204cc4 + 0x41b2c + 48, [0, 0]);
  const st = {};
  const search = () => {
    st.b2w2ZoneScan -= 3000; // 3 s on
    return black2(bus, st);
  };
  black2(bus, st);
  for (let i = 0; i < 5; i++) search();
  const n = bus.big;
  assert.equal(search(), null);
  assert.equal(bus.big, n, 'the title screen: every 30 s only');
  // the save loaded: the party reader found the team
  st.partyAddr = 0x0221e3ec;
  assert.equal(search(), null);
  assert.equal(bus.big, n + 1, 'searched for at once');
  for (let i = 0; i < 5; i++) search();
  const m = bus.big;
  assert.equal(m, n + 4, 'a few more at the fast pace, then slow again');
  // a new value of the main pointer: the same
  bus.set(0x02000024, le32(0x02204d04));
  bus.set(0x0225d830, copyOf(3));
  assert.equal(search()?.romName, 'Aspertia City');
  assert.equal(bus.big, m + 1);
  // the copy twice (a second one turned up): no place – the searches stay single-hit only
  const two = dsRam();
  two.set(0x0225d830, copyOf(3));
  two.set(0x0230d830, copyOf(1));
  const st2 = { partyAddr: 0x0221e3ec };
  assert.equal(black2(two, st2), null);
  st2.partyAddr = 0x0221e400;
  st2.b2w2ZoneScan -= 3000;
  assert.equal(black2(two, st2), null);
  assert.equal(two.big, 2);
});
