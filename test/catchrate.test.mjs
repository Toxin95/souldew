// The battle helper's catch chance: each generation's formula (shared/catchrate.mjs) against worked examples from the
// disassemblies and Bulbapedia, which balls the row offers, and what the battle readers hand it – the opponent's status
// condition, its catch rate and the battles where no ball can be thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catchChance, catchRow, chanceText, statusKind, isUltraBeast } from '../shared/catchrate.mjs';
import { catchRate3ds } from '../shared/live/catch3ds.mjs';
import { romTypes, TYPES34 } from '../shared/live/romtypes.mjs';
import { readLiveBattle, readLiveParty, findEntry, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const ADDR = json('../shared/data/addresses.json');
const entry = (id) => ADDR.games.find((g) => g.id === id);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const SLP = 2;
const PSN = 0x08;
const PAR = 0x40;
const TOX = 0x80;

test('status words: sleep turns, then the one condition bit (Gen 3/4 layout, Gen 1/2 the same low byte)', () => {
  assert.equal(statusKind(0), null);
  assert.equal(statusKind(3), 'slp');
  assert.equal(statusKind(0x20), 'frz');
  assert.equal(statusKind(0x80 | 0x300), 'tox'); // (Gen 4: bad poison with its counter in bits 8–11)
  assert.equal(statusKind(0x08), 'psn');
  assert.equal(statusKind(0x10), 'brn');
  assert.equal(statusKind(0x40), 'par');
  assert.equal(statusKind(undefined), null);
});

test('Gen 1 (pokered ItemUseBall): both random numbers enumerated – Bulbapedia\'s exact form and its examples', () => {
  // Bulbapedia: exact as S/(N+1) + (C+1)/(N+1) · (f+1)/256 while the catch rate stays low enough (≤ 125 for an Ultra
  // Ball). A sleeping Mewtwo (catch rate 3) at full HP: f = ⌊⌊200·255/12⌋ / 50⌋ = 85 → "about six Ultra Balls"
  const mewtwo = { gen: 1, rate: 3, hp: 200, maxHp: 200, level: 70, status: SLP };
  const p = catchChance(mewtwo, 'ultra');
  near(p, 25 / 151 + (4 / 151) * (86 / 256));
  assert.equal(Math.round(1 / p), 6);
  // f is floored twice and HP/4 has at least 1: a Pidgey at 3/20 HP with a Poké Ball – ⌊⌊20·255/12⌋ / max(0, 1)⌋ > 255
  near(catchChance({ gen: 1, rate: 255, hp: 3, maxHp: 20, level: 3 }, 'poke'), 1);
  // "lowering HP to 1/3 guarantees capture with a Poké Ball" (catch rate 255: the first check always passes)
  near(catchChance({ gen: 1, rate: 255, hp: 6, maxHp: 18, level: 3 }, 'poke'), 1);
  // the Gen 1 quirk: a Great Ball beats an Ultra Ball on a Rattata at full HP (f 127 vs 85, and the Ultra Ball's
  // smaller range doesn't help a catch rate of 255)
  const rattata = { gen: 1, rate: 255, hp: 20, maxHp: 20, level: 3 };
  near(catchChance(rattata, 'great'), 128 / 256);
  near(catchChance(rattata, 'ultra'), 86 / 256);
  near(catchChance(rattata, 'poke'), 86 / 256);
  // poison/burn/paralysis: 12 of the range are a sure catch
  near(catchChance({ gen: 1, rate: 45, hp: 20, maxHp: 20, level: 5, status: PAR }, 'poke'), 12 / 256 + (46 / 256) * (86 / 256));
  // the Safari Ball works like the Ultra Ball's range with the Poké Ball's factor (pokered: Ultra/Safari 0–150, 12)
  near(catchChance({ gen: 1, rate: 30, hp: 30, maxHp: 30, level: 25 }, 'safari'), catchChance({ gen: 1, rate: 30, hp: 30, maxHp: 30, level: 25 }, 'ultra'));
});

test('Gen 2 (pokecrystal PokeBallEffect): the 8-bit steps, the status bug and the overflow of big Pokémon', () => {
  // catch rate 45, 20/20 HP: 3·MaxHP = 60 fits a byte; ⌊45·(60 − 40) / 60⌋ = 15 → (15 + 1) / 256
  const sentret = { gen: 2, rate: 45, hp: 20, maxHp: 20, level: 3 };
  near(catchChance(sentret, 'poke'), 16 / 256);
  // Great Ball ×1.5 (67), Ultra Ball ×2 (90) on the catch rate: ⌊67·20/60⌋ = 22, ⌊90·20/60⌋ = 30
  near(catchChance(sentret, 'great'), 23 / 256);
  near(catchChance(sentret, 'ultra'), 31 / 256);
  // sleep adds 10, poison/burn/paralysis nothing (the bug: the check reads the wrong bits)
  near(catchChance({ ...sentret, status: SLP }, 'poke'), 26 / 256);
  near(catchChance({ ...sentret, status: PSN }, 'poke'), 16 / 256);
  near(catchChance({ ...sentret, status: PAR }, 'poke'), 16 / 256);
  // 3·MaxHP over 255: both halved twice, ⌊(150·3)/4⌋ = 112, ⌊(2·75)/4⌋ = 37 → ⌊45·75/112⌋ = 30
  near(catchChance({ gen: 2, rate: 45, hp: 75, maxHp: 150, level: 30 }, 'poke'), 31 / 256);
  // a max HP of 342 truncates to 0 – the game would divide by it: unknown rather than a number
  assert.equal(catchChance({ gen: 2, rate: 30, hp: 342, maxHp: 342, level: 100 }, 'poke'), null);
  assert.equal(catchChance(sentret, 'net'), null, 'no Net Ball before Gen 3');
});

test('Gen 3/4 (pokeemerald Cmd_handleballthrow, pokeplatinum CalcCatchShakes): four shake checks on b', () => {
  // catch rate 45, Poké Ball, full HP: a = ⌊45·20 / 60⌋ = 15; b = ⌊1048560 / ⌊√⌊√⌊16711680/15⌋⌋⌋⌋ = ⌊1048560 / 32⌋
  const foe = { gen: 3, rate: 45, hp: 20, maxHp: 20, level: 5 };
  near(catchChance(foe, 'poke'), (32767 / 65536) ** 4);
  assert.equal(catchChance({ ...foe, gen: 4 }, 'poke'), catchChance(foe, 'poke'), 'Gen 4: the same formula');
  // a ≥ 255: caught without shake checks (a weakened Pidgey in an Ultra Ball)
  assert.equal(catchChance({ gen: 3, rate: 255, hp: 1, maxHp: 30, level: 3 }, 'ultra'), 1);
  // the ball bonus is in tenths and floored first: catch rate 45 · 15 / 10 = 67
  const a = Math.floor(67 * 20 / 60);
  near(catchChance(foe, 'great'), (Math.floor(1048560 / Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680 / a)))))) / 65536) ** 4);
  // status: sleep ×2, paralysis ×1.5 – and bad poison counts from Emerald/FireRed on, not in Ruby/Sapphire (pokeruby)
  assert.ok(catchChance({ ...foe, status: SLP }, 'poke') > catchChance({ ...foe, status: PAR }, 'poke'));
  assert.ok(catchChance({ ...foe, status: TOX }, 'poke', 'emerald_us') > catchChance(foe, 'poke', 'emerald_us'));
  assert.equal(catchChance({ ...foe, status: TOX }, 'poke', 'ruby_us'), catchChance(foe, 'poke', 'ruby_us'));
  assert.equal(catchChance({ ...foe, status: TOX }, 'poke', 'sapphire_de'), catchChance(foe, 'poke'));
  // Net Ball ×3 on a Water/Bug type; Nest Ball (40 − level)/10, never below ×1 (both decomps)
  assert.equal(catchChance(foe, 'net'), catchChance({ ...foe, rate: 135 }, 'poke'));
  assert.equal(catchChance({ ...foe, level: 10 }, 'nest'), catchChance({ ...foe, level: 10, rate: 135 }, 'poke'));
  assert.equal(catchChance({ ...foe, level: 35 }, 'nest'), catchChance({ ...foe, level: 35 }, 'poke'));
});

test('Gen 5 and Gen 6/7: X in 1/4096 steps, three shake checks (⁴√) and four (power 3/16) – about (X/255)^¾', () => {
  const foe = { rate: 45, hp: 20, maxHp: 20, level: 5 };
  for (const gen of [5, 6, 7]) near(catchChance({ ...foe, gen }, 'poke'), (15 / 255) ** 0.75, 2e-4);
  // the exact Gen 5 number: Y = ⌊65536 / ⁴√17⌋ (17 = 255 / 15, each root to 1/4096)
  const r4 = (v) => Math.round(v * 4096) / 4096;
  near(catchChance({ ...foe, gen: 5 }, 'poke'), (Math.floor(65536 / r4(Math.sqrt(r4(Math.sqrt(17))))) / 65536) ** 3);
  // sleep is ×2.5 from Gen 5 on (×2 before): X 37.5
  near(catchChance({ ...foe, gen: 5, status: SLP }, 'poke'), (37.5 / 255) ** 0.75, 3e-4);
  // X ≥ 255: certain
  assert.equal(catchChance({ gen: 6, rate: 255, hp: 1, maxHp: 40, level: 5 }, 'ultra'), 1);
  // Net Ball: ×3 in Gen 5/6, ×3.5 in Gen 7
  const water = { ...foe, rate: 45 };
  near(catchChance({ ...water, gen: 6 }, 'net'), (45 / 255) ** 0.75, 2e-4);
  near(catchChance({ ...water, gen: 7 }, 'net'), (52.5 / 255) ** 0.75, 2e-4);
  // Gen 7: every ball but the Beast Ball is ×410/4096 on an Ultra Beast, the Beast Ball ×5
  assert.ok(isUltraBeast(794) && !isUltraBeast(800));
  const ub = { gen: 7, rate: 45, hp: 100, maxHp: 100, level: 60, species: 794 };
  near(catchChance(ub, 'ultra'), catchChance(ub, 'poke'));
  near(catchChance(ub, 'poke'), (Math.floor(100 * 45 * 410 / 300) / 4096 / 255) ** 0.75, 2e-4);
  near(catchChance(ub, 'beast'), (75 / 255) ** 0.75, 2e-4);
  assert.equal(catchChance({ ...ub, gen: 6 }, 'beast'), null, 'no Beast Ball before Gen 7');
});

test('the catch row: Poké, Great and Ultra Ball, plus the one situational ball that helps here', () => {
  const foe = { gen: 4, rate: 190, hp: 12, maxHp: 24, level: 10 };
  assert.deepEqual(catchRow(foe).map((x) => x.ball), ['poke', 'great', 'ultra', 'nest']); // below level 30
  assert.deepEqual(catchRow({ ...foe, level: 35 }).map((x) => x.ball), ['poke', 'great', 'ultra']);
  // a Water or Bug type: Net Ball – the better of the two when both apply
  const both = catchRow({ ...foe, rate: 45, hp: 24, level: 25 }, { types: ['water'] });
  assert.equal(both.at(-1).ball, 'net');
  assert.equal(catchRow({ ...foe, rate: 45, hp: 24, level: 2 }, { types: ['bug'] }).at(-1).ball, 'nest'); // ×3.8 > ×3
  // Gen 5 on: the Nest Ball's exact Gen 5+ formula isn't documented by a disassembly – left out
  assert.deepEqual(catchRow({ ...foe, gen: 5 }).map((x) => x.ball), ['poke', 'great', 'ultra']);
  assert.equal(catchRow({ gen: 7, rate: 45, hp: 50, maxHp: 50, level: 50, species: 795 }).at(-1).ball, 'beast');
  // Gen 1/2: the three balls only (no Net Ball in Gen 2)
  assert.deepEqual(catchRow({ gen: 2, rate: 45, hp: 20, maxHp: 20, level: 3 }, { types: ['water'] }).map((x) => x.ball), ['poke', 'great', 'ultra']);
  // Gen 1's Safari Zone: only the Safari Ball
  assert.deepEqual(catchRow({ gen: 1, rate: 90, hp: 30, maxHp: 30, level: 22 }, { safari: true }).map((x) => x.ball), ['safari']);
  // nothing to tell: no catch rate, a broken HP read, a generation without a formula
  assert.equal(catchRow({ ...foe, rate: undefined }), null);
  assert.equal(catchRow({ ...foe, hp: 30 }), null);
  assert.equal(catchRow({ ...foe, gen: 8 }), null);
});

test('chances as the panel prints them: whole percent, never a false 100 % or 0 %', () => {
  assert.deepEqual([1, 0.996, 0.5, 0.123, 0.004, 0, null].map(chanceText), ['100%', '>99%', '50%', '12%', '<1%', '0%', '–']);
});

// ---------------------------------------------------------------- what the readers hand it

/** A bus reader over a sparse byte map. */
const ram = (bytes) => (addr, len) => Uint8Array.from({ length: len }, (_, i) => bytes[addr + i] ?? 0);
const put16be = (m, a, v) => { m[a] = v >> 8; m[a + 1] = v & 0xff; };

test('Gen 1/2: the opponent\'s status and catch rate from wEnemyMon, the Safari Zone and tutorials from wBattleType', () => {
  const e = entry('red_us');
  const be = e.battleEnemy;
  const m = {};
  m[Number(e.inBattle.addr)] = 1; // wild
  m[Number(be.speciesAddr)] = 0x24; // Pidgey's Gen 1 index
  m[Number(be.levelAddr)] = 3;
  put16be(m, Number(be.hpAddr), 16);
  put16be(m, Number(be.maxHpAddr), 16);
  m[Number(be.statusAddr)] = 3; // asleep, 3 turns (checked live in Red: Spore on a wild Pidgey)
  m[Number(be.catchRateAddr)] = 255;
  const T = new LiveTables({ gen1Index: json('../shared/data/gen1_index_to_dex.json') });
  let b = readLiveBattle(e, ram(m), T);
  assert.equal(b.enemy.species, 16);
  assert.equal(b.enemy.status, 3);
  assert.equal(b.enemy.catchRate, 255);
  assert.equal(b.balls, undefined);
  m[Number(be.battleTypeAddr)] = 2; // BATTLE_TYPE_SAFARI
  assert.equal(readLiveBattle(e, ram(m), T).balls, 'safari');
  m[Number(be.battleTypeAddr)] = 1; // the old man's catching demo
  assert.equal(readLiveBattle(e, ram(m), T).balls, 'none');
  // Gen 2: the tutorial and the Bug-Catching Contest (Park Balls) – no row
  const c = entry('crystal_us');
  const m2 = {};
  m2[Number(c.inBattle.addr)] = 1;
  m2[Number(c.battleEnemy.speciesAddr)] = 161;
  m2[Number(c.battleEnemy.levelAddr)] = 3;
  put16be(m2, Number(c.battleEnemy.hpAddr), 14);
  put16be(m2, Number(c.battleEnemy.maxHpAddr), 14);
  m2[Number(c.battleEnemy.catchRateAddr)] = 255;
  b = readLiveBattle(c, ram(m2), new LiveTables({}));
  assert.equal(b.enemy.catchRate, 255);
  assert.equal(b.enemy.status, 0);
  m2[Number(c.battleEnemy.battleTypeAddr)] = 6; // BATTLETYPE_CONTEST
  assert.equal(readLiveBattle(c, ram(m2), new LiveTables({})).balls, 'none');
  // a status byte that isn't one (a struct half loaded): left out, not guessed
  m2[Number(c.battleEnemy.statusAddr)] = 0x48;
  assert.equal(readLiveBattle(c, ram(m2), new LiveTables({})).enemy.status, undefined);
});

function pk3({ pid, otId, internal, level, hp, maxHp, status = 0 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, internal, true);
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  dv.setUint32(80, status, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

test('Gen 3: the opponent\'s status from gEnemyParty, its catch rate from the ROM\'s table, no row in the Safari Zone', () => {
  const e = entry('emerald_us');
  const m = {};
  const put = (a, bytes) => bytes.forEach((x, i) => { m[a + i] = x; });
  put(Number(e.inBattle.addr), [0x02]);
  put(Number(e.battleTypeFlagsAddr), [0x04, 0, 0, 0]); // a wild battle (IS_MASTER)
  // a sleeping Wurmple (checked live in Emerald: Spore → status 3 in gEnemyParty)
  put(Number(e.enemyPartyAddr), [...pk3({ pid: 0x11223300, otId: 0x55667788, internal: 290, level: 2, hp: 14, maxHp: 14, status: 3 })]);
  const T0 = new LiveTables({ charsetGen3: json('../shared/data/charset_gen3.json'), gen3Index: json('../shared/data/gen3_index_to_dex.json').map });
  let b = readLiveBattle(e, ram(m), T0);
  assert.equal(b.enemy.species, 265);
  assert.equal(b.enemy.status, 3);
  assert.equal(b.enemy.catchRate, undefined, 'no ROM table: no catch rate, no row');
  const types = { gen: 3, keys: [...TYPES34], species: { 265: ['bug'] }, catchRates: { 265: 255 } };
  b = readLiveBattle(e, ram(m), T0.withRom({ types }));
  assert.equal(b.enemy.catchRate, 255);
  assert.equal(b.balls, undefined);
  for (const flag of [0x80, 0x200, 0x10]) { // Safari Zone, Wally's tutorial, the first battle (Birch's bag)
    put(Number(e.battleTypeFlagsAddr), [flag & 0xff, flag >> 8, 0, 0]);
    assert.equal(readLiveBattle(e, ram(m), T0).balls, 'none', flag.toString(16));
  }
  put(Number(e.battleTypeFlagsAddr), [0, 0x80, 0, 0]); // FireRed's unidentified ghost …
  assert.equal(readLiveBattle(e, ram(m), T0).balls, 'none');
  put(Number(e.battleTypeFlagsAddr), [0, 0xa0, 0, 0]); // … unveiled by the Silph Scope
  assert.equal(readLiveBattle(e, ram(m), T0).balls, undefined);
});

test('3DS: the catch rates of each game from PKHeX\'s tables (OR/AS and Ultra Sun/Moon changed some)', () => {
  assert.equal(catchRate3ds('xy', 1), 45);
  assert.equal(catchRate3ds('xy', 384), 3); // Rayquaza
  assert.equal(catchRate3ds('oras', 384), 45); // a story catch there
  assert.equal(catchRate3ds('xy', 382), 5); // Kyogre …
  assert.equal(catchRate3ds('oras', 382), 3); // … lowered in OR/AS
  assert.equal(catchRate3ds('sm', 800), 3); // Necrozma
  assert.equal(catchRate3ds('usum', 800), 255);
  assert.equal(catchRate3ds('sm', 795), 255); // Pheromosa …
  assert.equal(catchRate3ds('usum', 795), 45); // … every Ultra Beast 45 in USUM
  assert.equal(catchRate3ds('xy', 722), null, 'not in the game');
  assert.equal(catchRate3ds('nope', 1), null);
  // the battle reader puts it on the opponent
  const e = entry('xy');
  const base = Number(e.battle.wild);
  const m = {};
  const block = (i, species, slot, level, hp) => {
    const o = base + i * (e.battle.stride || 580);
    m[o + 4] = species & 0xff; m[o + 5] = species >> 8;
    m[o + 6] = 30; m[o + 8] = hp; m[o + 0x10] = level; m[o + 0x11] = slot;
  };
  block(0, 650, 0, 10, 30);
  block(1, 661, 12, 5, 20); // a wild Fletchling
  const b = readLiveBattle(e, ram(m), new LiveTables({}));
  assert.equal(b.kind, 'wild');
  assert.equal(b.enemy.catchRate, 255);
  assert.equal(b.enemy.status, undefined, 'no status read on the 3DS');
});

test('the ROM\'s species table gives each Pokémon\'s catch rate (Game Boy base data: right after the types)', () => {
  // a Game Boy ROM with Gen 1's base data: dex number, five stats, two types, the catch rate – 28 bytes per species
  const rom = new Uint8Array(0x10000);
  rom[0x104] = 0xce;
  rom[0x105] = 0xed;
  const at = 0x4000;
  for (let i = 1; i <= 150; i++) {
    const o = at + (i - 1) * 28;
    rom.set(i === 1 ? [1, 45, 49, 49, 45, 65] : [i, 50, 50, 50, 50, 50], o);
    rom[o + 6] = 0x16; // Grass
    rom[o + 7] = 0x03; // Poison
    rom[o + 8] = i === 1 ? 45 : i === 2 ? 3 : 190;
  }
  rom.set([151, 100, 100, 100, 100, 100, 0x18, 0x18, 45], 0x8000); // Mew, kept apart
  const t = romTypes(rom);
  assert.equal(t.gen, 1);
  assert.equal(t.catchRates[1], 45);
  assert.equal(t.catchRates[2], 3);
  assert.equal(t.catchRates[150], 190);
  assert.equal(t.catchRates[151], 45);
  // a table whose byte there isn't a catch rate (zeros everywhere): none rather than wrong chances
  for (let i = 1; i <= 150; i++) rom[at + (i - 1) * 28 + 8] = 0;
  assert.equal(romTypes(rom).catchRates, null);
});

test('the battle helper shows the catch chance in wild battles only, with the reader\'s data and the running game', () => {
  const panel = readFileSync(new URL('../web/views/session-info.mjs', import.meta.url), 'utf8');
  const play = readFileSync(new URL('../web/views/play.mjs', import.meta.url), 'utf8');
  // wild battles, not when the rules say "don't catch it"
  assert.match(panel, /battle\.kind === 'wild' && !\(rule && !rule\.ok\) && html`<\$\{CatchChance\} foe=\$\{foe\}/);
  // no row where no ball can be thrown, without a catch rate, or while two opponents stand in Gen 3/4
  assert.match(panel, /if \(balls === 'none' \|\| !foe\.catchRate \|\| \(gen <= 4 && foes\.filter\(\(f\) => f\.hp > 0\)\.length > 1\)\) return null;/);
  // a game whose status the reader can't tell says so instead of pretending there is none
  assert.match(panel, /held\.current = holdFoeStatus\(held\.current, `\$\{foe\.species\}:\$\{foe\.level\}:\$\{foe\.maxHp\}`, foe\.status\);/);
  assert.match(panel, /const \{ read: statusRead, status \} = held\.current;/);
  assert.match(panel, /t\('battle\.catchNoStatus', 'status not read'\)/);
  // the running game's entry goes to the panel (Ruby/Sapphire's bad-poison quirk)
  assert.match(play, /setLiveGame\(\(g\) => \(g === entry\.id \? g : entry\.id \|\| ''\)\);/);
  assert.match(play, /<\$\{BattlePanel\} battle=\$\{battle\} mine=\$\{myParty\} gen=\$\{gameGen\} game=\$\{liveGame\}/);
});

test('the catch row: when both situational balls are certain, the one with the bigger bonus', () => {
  // a sleeping Wurmple (Bug, level 2) with a third of its HP: Net Ball ×3 and Nest Ball ×3.8 both catch for sure
  const row = catchRow({ gen: 3, rate: 255, hp: 5, maxHp: 14, level: 2, status: 3 }, { types: ['bug'] });
  assert.deepEqual(row.at(-1), { ball: 'nest', p: 1 });
});

// ---------------------------------------------------------------- Gen 5: the battle struct's conditions

/** A sparse memory of written blocks. */
function memory() {
  const blocks = [];
  return {
    write(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) for (let i = 0; i < len; i++) {
        const o = addr + i - b.addr;
        if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
      }
      return out;
    },
  };
}
function pk5({ pid, species, level, hp, maxHp }) {
  const mon = new Uint8Array(220);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, 31337, true);
  dv.setUint16(0x0e, 4242, true);
  mon[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  for (let i = 0x92; i < 0x9c; i += 2) dv.setUint16(i, 20 + i, true);
  return encryptPK4(mon);
}

test('Gen 5: the opponent\'s status from its battle struct – one u32 per condition from +0x10 (the party copy keeps none)', () => {
  const e = findEntry(ADDR, { platform: 'nds', code: 'IREO' }); // Black 2
  const tepig = { pid: 0x7e9170aa, species: 498, level: 6, hp: 24, maxHp: 24 };
  const wild = { pid: 0x5eed0042, species: 504, level: 4, hp: 17, maxHp: 17 };
  const m = memory();
  const CORE = 0x02000000 + 0x200000 + 0x19728 - 8;
  m.write(0x02000024, [0x00, 0x00, 0x20, 0x02]);
  m.write(CORE, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5(tepig)]);
  m.write(CORE + 0x600 + 0x14, [31337 & 0xff, 31337 >> 8, 4242 & 0xff, 4242 >> 8]);
  const MINE = 0x02257d6c;
  const FOE = 0x0225882c;
  m.write(MINE, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5(tepig)]);
  m.write(FOE, [6, 0, 0, 0, 1, 0, 0, 0, ...pk5(wild)]);
  // { u32 → the Pokémon in the party copy, …, u16 species, u16 max HP, u16 HP, …, u8 level at +12, conditions from +0x10 }
  const struct = (addr, pp, x, sick = {}) => {
    const b = new Uint8Array(0x0c + 0x28);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, pp, true);
    dv.setUint16(0x0c, x.species, true);
    dv.setUint16(0x0e, x.maxHp, true);
    dv.setUint16(0x10, x.hp, true);
    b[0x0c + 12] = x.level;
    for (const [k, v] of Object.entries(sick)) dv.setUint32(0x0c + 0x10 + Number(k) * 4, v, true);
    m.write(addr - 0x0c, b);
  };
  struct(0x0225b414, MINE + 8, tepig);
  struct(0x0225b638, FOE + 8, wild);
  m.write(0x021b5138, [0x00, 0x21]); // in battle
  const T = new LiveTables({ gen4: json('../shared/data/gen4.json') });
  const state = {};
  const poll = () => readLiveBattle(e, m.read, T, state, readLiveParty(e, m.read, T, state).party);
  for (let i = 0; i < 6; i++) poll(); // (the heap search takes a few polls)
  assert.equal(poll().enemy.status, 0);
  // as found live in Black: Spore → +0x18 = 18 (sleep), Thunder Wave → +0x14 = 1, Toxic → +0x24 = 0x1E79
  for (const [k, v, want] of [[2, 18, 'slp'], [1, 1, 'par'], [5, 0x1e79, 'psn'], [4, 1, 'brn'], [3, 1, 'frz']]) {
    struct(0x0225b638, FOE + 8, wild, { [k]: v });
    assert.equal(statusKind(poll().enemy.status), want, want);
  }
  // two at once can't be: no status rather than a wrong one
  struct(0x0225b638, FOE + 8, wild, { 1: 1, 2: 18 });
  assert.equal(poll().enemy.status, undefined);
});

test('the foe\'s status is held for the battle: a poll without it (Gen 3/4, struct not found that frame) doesn\'t flicker "status not read"', async () => {
  const { holdFoeStatus } = await import('../shared/catchrate.mjs');
  let h = holdFoeStatus(null, '16:3:14', undefined);
  assert.deepEqual([h.read, h.status], [false, undefined], 'nothing read yet: "status not read"');
  h = holdFoeStatus(h, '16:3:14', 0);
  assert.deepEqual([h.read, h.status], [true, 0]);
  h = holdFoeStatus(h, '16:3:14', undefined);
  assert.deepEqual([h.read, h.status], [true, 0], 'one poll without it: still read');
  h = holdFoeStatus(h, '16:3:14', 3);
  h = holdFoeStatus(h, '16:3:14', undefined);
  assert.deepEqual([h.read, h.status], [true, 3], 'the last status stands');
  h = holdFoeStatus(h, '19:4:16', undefined);
  assert.deepEqual([h.read, h.status], [false, undefined], 'another foe: nothing held');
});
