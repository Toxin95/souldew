// Catching demos and tutorials are no battles of the player's (2.8.1, thanks to a player on Discord: Wally's catching
// tutorial in Emerald counted as the player's encounter in Petalburg City). Every generation: the old man in Viridian
// City (Red/Blue/Yellow, FireRed/LeafGreen), Oak's Pikachu (Yellow), the Dude on Route 29 (Gold/Silver/Crystal), Wally
// (Ruby/Sapphire/Emerald), the Poké Dude's Teachy TV battles (FireRed/LeafGreen), Dawn/Lucas (Diamond/Pearl/Platinum),
// Lyra/Ethan (HeartGold/SoulSilver), Juniper (Black/White) and Bianca (Black 2/White 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { readLiveParty, readLiveBattle, playerBattle, LiveTables } from '../shared/live/parse.mjs';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const entry = (id) => TABLE.games.find((g) => g.id === id);
const internal3 = (dex) => Number(Object.entries(L('gen3_index_to_dex.json').map).find(([, v]) => v === dex)[0]);
const internal1 = (dex) => Number(Object.entries(L('gen1_index_to_dex.json').map).find(([, v]) => v === dex)[0]);

/** A bus reader over a sparse byte map. */
function ram(bytes) {
  return (addr, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bytes[addr + i] ?? 0;
    return out;
  };
}
const put = (m, a, bytes) => bytes.forEach((b, i) => (m[a + i] = b));
const put16be = (m, a, v) => put(m, a, [v >> 8, v & 0xff]);
const put32 = (m, a, v) => put(m, a, [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]);

/** A Game Boy wild battle in `id`: wBattleMode 1, wBattleType `type`, a level-5 opponent. */
function gbWild(id, type, species) {
  const e = entry(id);
  const b = e.battleEnemy;
  const m = {};
  m[Number(e.inBattle.addr)] = 1;
  m[Number(b.battleTypeAddr)] = type;
  m[Number(b.speciesAddr)] = species;
  m[Number(b.levelAddr)] = 5;
  put16be(m, Number(b.hpAddr), 20);
  put16be(m, Number(b.maxHpAddr), 20);
  return readLiveBattle(e, ram(m), T, {});
}

test('Game Boy: the old man (Red/Blue/Yellow), Oak\'s Pikachu (Yellow) and the Dude (Gold/Silver/Crystal) are no battles of the player\'s', () => {
  const weedle = internal1(13);
  const oldMan = gbWild('red_us', 1, weedle);
  assert.equal(oldMan.tutorial, true, 'pokered BATTLE_TYPE_OLD_MAN');
  assert.equal(oldMan.enemy.species, 13);
  assert.equal(playerBattle(oldMan), null, 'the tracker skips it');
  assert.equal(gbWild('blue_us', 1, weedle).tutorial, true);
  assert.equal(gbWild('yellow_us', 1, weedle).tutorial, true);
  assert.equal(gbWild('yellow_us', 4, internal1(25)).tutorial, true, 'pokeyellow BATTLE_TYPE_PIKACHU: Oak catches Pikachu');
  // a normal wild battle and the Safari Zone are the player's
  const normal = gbWild('red_us', 0, weedle);
  assert.equal(normal.tutorial, undefined);
  assert.equal(playerBattle(normal), normal);
  assert.equal(gbWild('red_us', 2, weedle).tutorial, undefined, 'Safari Zone');
  assert.equal(gbWild('red_us', 4, weedle).tutorial, undefined, 'Red has no Pikachu battle');
  for (const id of ['gold_us', 'silver_us', 'crystal_us']) assert.equal(gbWild(id, 3, 19).tutorial, true, `${id}: BATTLETYPE_TUTORIAL`);
  assert.equal(gbWild('crystal_us', 6, 10).tutorial, undefined, 'the Bug-Catching Contest is the player\'s');
  assert.equal(gbWild('crystal_us', 0, 19).tutorial, undefined);
});

/** A Gen 3 party struct (100 bytes): encrypted data block, the level / HP after it. */
function pk3({ pid, otId = 0xbeefcafe, species, level, hp = 20, maxHp = 20, met = 16, metLevel = level, moves = [33, 45] }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  const at = (ch) => order.indexOf(ch) * 12;
  pv.setUint16(at('G'), internal3(species), true);
  moves.forEach((mv, i) => pv.setUint16(at('A') + i * 2, mv, true));
  plain[at('M') + 1] = met;
  pv.setUint16(at('M') + 2, metLevel, true);
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return [...d];
}

/** A Gen 3 battle in `id` with gBattleTypeFlags `flags`. */
function gen3Battle(id, flags) {
  const e = entry(id);
  const m = {};
  m[Number(e.inBattle.addr)] = 0x02;
  put32(m, Number(e.battleTypeFlagsAddr), flags);
  put(m, Number(e.enemyPartyAddr), pk3({ pid: 0x0bad0001, species: 280, level: 5 }));
  return readLiveBattle(e, ram(m), T, {});
}

test('Gen 3: Wally\'s and the old man\'s catching tutorials and the Poké Dude\'s Teachy TV battles are no battles of the player\'s', () => {
  for (const id of ['emerald_us', 'ruby_us', 'sapphire_us', 'firered_us', 'leafgreen_eu']) {
    const b = gen3Battle(id, 0x200); // BATTLE_TYPE_WALLY_TUTORIAL / OLD_MAN_TUTORIAL
    assert.equal(b.tutorial, true, id);
    assert.equal(b.balls, 'none', `${id}: no catch chance either`);
    assert.equal(playerBattle(b), null);
  }
  assert.equal(gen3Battle('firered_us', 0x10000).tutorial, true, 'FireRed BATTLE_TYPE_POKEDUDE');
  assert.equal(gen3Battle('emerald_us', 0x10000 | 0x08).tutorial, undefined, 'Emerald\'s bit 16 is the Battle Dome');
  assert.equal(gen3Battle('emerald_us', 0x04).tutorial, undefined, 'a wild battle');
  assert.equal(gen3Battle('emerald_us', 0x08).kind, 'trainer');
});

// Emerald: SaveBlock1 behind gSaveBlock1Ptr; the saved party at +0x234 (count) / +0x238 (mons)
const SB1 = 0x02025a00;
function emeraldParty({ live, saved = null, flags = 0 }) {
  const e = entry('emerald_us');
  const m = {};
  m[Number(e.partyCountAddr)] = live.length;
  put(m, Number(e.partyAddr), live.flat());
  put32(m, Number(e.battleTypeFlagsAddr), flags);
  put32(m, 0x03005d8c, SB1);
  if (saved) {
    m[SB1 + 0x234] = saved.length;
    put(m, SB1 + 0x238, saved.flat());
  }
  return readLiveParty(e, ram(m), T, {});
}

test('Emerald, Ruby/Sapphire: Wally\'s Zigzagoon in the first party slot is never filed – the team saved before the tutorial stands in', () => {
  const torchic = pk3({ pid: 0x11112222, species: 255, level: 8, met: 0, metLevel: 5 });
  const wurmple = pk3({ pid: 0x33334444, species: 265, level: 4, met: 16, metLevel: 3 });
  // pokeemerald LoadWallyZigzagoon: CreateMon(ZIGZAGOON, 7) in Petalburg City (MAPSEC 7), Tackle only
  const zigzagoon = pk3({ pid: 0x5eed0007, species: 263, level: 7, met: 7, metLevel: 7, moves: [33] });
  const r = emeraldParty({ live: [zigzagoon, wurmple], saved: [torchic, wurmple] });
  assert.deepEqual(r.party.map((x) => x.species), [255, 265], 'the real team');
  // a battle flag isn't needed (the Zigzagoon is lent before the battle starts) – and during it, the same
  assert.deepEqual(emeraldParty({ live: [zigzagoon], saved: [torchic], flags: 0x200 }).party.map((x) => x.species), [255]);
  // while the saved team can't be read, the last team stays (a torn read) – the Zigzagoon is never shown
  assert.equal(emeraldParty({ live: [zigzagoon], saved: null }).torn, true);
  // a Zigzagoon of the player's own (caught on Route 101/102 – more moves, another place) is theirs
  const own = pk3({ pid: 0x7777aaaa, species: 263, level: 7, met: 16, metLevel: 3, moves: [33, 45, 39] });
  assert.deepEqual(emeraldParty({ live: [own], saved: [torchic] }).party.map((x) => x.species), [263]);
  // after the tutorial (LoadPlayerParty): the team as it is
  assert.deepEqual(emeraldParty({ live: [torchic, wurmple], saved: [torchic, wurmple] }).party.map((x) => x.species), [255, 265]);
  // Ruby/Sapphire (English): SaveBlock1 at its fixed place
  const e = entry('ruby_us');
  const m = {};
  m[Number(e.partyCountAddr)] = 1;
  put(m, Number(e.partyAddr), zigzagoon);
  m[0x02025734 + 0x234] = 1;
  put(m, 0x02025734 + 0x238, torchic);
  assert.deepEqual(readLiveParty(e, ram(m), T, {}).party.map((x) => x.species), [255]);
});

test('FireRed/LeafGreen: the Poké Dude\'s team on the Teachy TV is never filed – the saved team stands in', () => {
  const e = entry('firered_us');
  const sb1 = 0x0202552c;
  const read = ({ live, saved, flags }) => {
    const m = {};
    m[Number(e.partyCountAddr)] = live.length;
    put(m, Number(e.partyAddr), live.flat());
    put32(m, Number(e.battleTypeFlagsAddr), flags);
    put32(m, 0x03005008, sb1);
    m[sb1 + 0x34] = saved.length;
    put(m, sb1 + 0x38, saved.flat());
    return readLiveParty(e, ram(m), T, {}).party.map((x) => x.species);
  };
  const bulbasaur = pk3({ pid: 0x22220001, species: 1, level: 12, met: 88 });
  const pidgey = pk3({ pid: 0x22220002, species: 16, level: 9, met: 89 });
  const dude = [pk3({ pid: 0x99990001, species: 19, level: 15, met: 88 }), pk3({ pid: 0x99990002, species: 43, level: 15, met: 88 })];
  assert.deepEqual(read({ live: dude, saved: [bulbasaur, pidgey], flags: 0x10000 }), [1, 16]);
  // the flag stays set after the battle, when the team is back – and the team changes afterwards (a Pokémon taken from the PC)
  const caterpie = pk3({ pid: 0x22220003, species: 10, level: 5, met: 90 });
  assert.deepEqual(read({ live: [bulbasaur, pidgey, caterpie], saved: [bulbasaur, pidgey], flags: 0x10000 }), [1, 16, 10]);
  // without the flag the team is never swapped
  assert.deepEqual(read({ live: dude, saved: [bulbasaur, pidgey], flags: 0x04 }), [19, 43]);
});

test('the tracker: a tutorial battle is no encounter, no missed encounter and no cause of death', () => {
  const E = { id: 'e', mode: 'nuzlocke', players: { p1: { name: 'May' } }, game: { id: 'pokemon-emerald', system: 'gba' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('enc:starter:p1', { outcome: 'caught', species: 255, key: 'g3-11112222-beefcafe', level: 8 });
  const tutorial = { kind: 'wild', tutorial: true, enemy: { species: 280, level: 5, hp: 20, maxHp: 20 }, active: null };
  // what the play view hands the tracker: playerBattle() – nothing for a tutorial
  const fight = playerBattle(tutorial);
  assert.equal(fight, null);
  const torchic = { key: 'g3-11112222-beefcafe', species: 255, level: 8, hp: 0, maxHp: 25, metLocation: 0, metLevel: 5 };
  const r = R.applySnapshot(d, E, 3, 'p1', { source: 'live', party: [torchic] }, { battle: fight });
  // (a death without a battle has no killer – the tutorial's Ralts is never one)
  assert.equal(d.get('pair:starter', null)?.killer ?? null, null);
  assert.deepEqual(r.newCatches, []);
});
