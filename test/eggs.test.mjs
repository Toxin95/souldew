// Eggs (#11, a randomized HeartGold): an egg is no catch and stays out of every team shown until it hatches – its
// species is what it will hatch into, a surprise in a randomized game – and a hatched one is filed like a hatched
// egg in every generation (the inbox: hatched from an egg), not as a catch at the place it hatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { buildState } from '../shared/streamapi.mjs';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
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
const T = new LiveTables({ gen4: L('gen4.json') });
const src = (f) => readFileSync(new URL(`../web/views/${f}`, import.meta.url), 'utf8');

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
const SOLO = (code, system) => ({ id: 'run1', game: { code, system }, mode: 'nuzlocke', players: { p1: { name: 'Steve' } } });
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, ...o });

/** A party mon as the game keeps it (PK4: encrypted, 236 bytes). */
function pk4({ pid, species, level = 5, egg = false, metLevel = 5, eggLocation = 0 }) {
  const d = new Uint8Array(236);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, 4242, true);
  dv.setUint32(0x38, egg ? 0x40000000 : 0, true); // IVs, bit 30: an egg
  dv.setUint16(0x44, eggLocation, true); // Platinum/HGSS egg location
  dv.setUint16(0x46, 177, true);
  d[0x84] = metLevel;
  d[0x8c] = level;
  dv.setUint16(0x8e, 20, true);
  dv.setUint16(0x90, 20, true);
  return encryptPK4(d);
}

test('a Gen 4 egg is read as one (bit 30 of the IV word) together with where it came from', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const ram = new Uint8Array(0x400000);
  const base = 0x0227c218;
  new DataView(ram.buffer).setUint32(0x111880, base, true);
  const core = base + 0xa0 - 0x02000000;
  ram.set([6, 0, 0, 0, 2, 0, 0, 0], core);
  ram.set(pk4({ pid: 0x11112222, species: 155 }), core + 8);
  // a randomized egg: its species field already holds what it will hatch into
  ram.set(pk4({ pid: 0x33334444, species: 249, level: 1, egg: true, metLevel: 0, eggLocation: 2011 }), core + 8 + 236);
  const r = readLiveParty(e, (a, n) => ram.slice(a - 0x02000000, a - 0x02000000 + n), T, {});
  assert.deepEqual(r.party.map((m) => [m.species, m.isEgg, m.eggLocation]), [[155, false, 0], [249, true, 2011]]);
});

test('an egg is no catch – it is kept in the live team as an egg, and the stream API leaves it out', () => {
  const d = mkDoc();
  const M = SOLO('IPKD', 'nds');
  const egg = mon({ key: 'egg', species: 249, level: 1, isEgg: true, metLevel: 0, eggLocation: 2011 });
  const res = R.applySnapshot(d, M, 4, 'p1', { source: 'live', party: [mon(), egg] });
  assert.deepEqual(res.inbox, [], 'not in the inbox either');
  assert.deepEqual(Object.keys(d.scan('enc:')), ['starter:p1']);
  assert.deepEqual(d.get('live:p1').party.map((m) => [m.species, !!m.egg]), [[152, false], [249, true]]);
  // stream overlays read the API: the egg's species would give it away
  assert.deepEqual(buildState(M, d.entries).players[0].party.map((m) => m.species), [152]);
  // no level cap note for an egg
  assert.ok(!R.checks(d, M, null).some((c) => /249|egg/i.test(c.text)));
});

test('a hatched egg goes to the inbox ("hatched from an egg") in every generation, a wild catch still gets filed', () => {
  const cases = [
    // [gen, manifest, the hatched mon, a wild catch of that game]
    [2, SOLO('crystal', 'gbc'), { metLocation: 5, metLevel: 1 }, { metLocation: 5, metLevel: 4 }], // Crystal: CAUGHT_EGG_LEVEL 1
    [3, SOLO('BPEE', 'gba'), { metLocation: 16, metLevel: 0 }, { metLocation: 16, metLevel: 3 }],
    [4, SOLO('IPKD', 'nds'), { metLocation: 177, metLevel: 0, eggLocation: 2011 }, { metLocation: 177, metLevel: 3 }],
    [5, SOLO('IRBO', 'nds'), { metLocation: 4, metLevel: 1, eggLocation: 60002 }, { metLocation: 4, metLevel: 3 }],
    [6, SOLO('EKJA', '3ds'), { metLocation: 8, metLevel: 1, eggLocation: 60002 }, { metLocation: 8, metLevel: 3 }],
    [7, SOLO('BNDA', '3ds'), { metLocation: 6, metLevel: 1, eggLocation: 60002 }, { metLocation: 6, metLevel: 3 }],
  ];
  for (const [gen, M, hatched, wild] of cases) {
    const d = mkDoc();
    R.applySnapshot(d, M, gen, 'p1', { source: 'live', party: [mon({ metLocation: 1 })] }); // the starter
    const res = R.applySnapshot(d, M, gen, 'p1', { source: 'live', party: [mon({ metLocation: 1 }), mon({ key: 'h', species: 175, level: 5, ...hatched })] });
    assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason]), [['h', 'egg']], `Gen ${gen}: hatched`);
    const d2 = mkDoc();
    R.applySnapshot(d2, M, gen, 'p1', { source: 'live', party: [mon({ metLocation: 1 })] });
    const w = R.applySnapshot(d2, M, gen, 'p1', { source: 'live', party: [mon({ metLocation: 1 }), mon({ key: 'w', species: 16, ...wild })] });
    assert.deepEqual([w.inbox.length, w.newCatches.length], [0, 1], `Gen ${gen}: a wild catch is filed`);
  }
});

test('hatchedMon: the hatch marks of each generation', () => {
  assert.equal(R.hatchedMon(1, { metLevel: null }), false);
  assert.equal(R.hatchedMon(2, { metLevel: 1 }), true, 'Crystal');
  assert.equal(R.hatchedMon(2, { metLevel: null }), false, 'Gold/Silver keep no met data');
  assert.equal(R.hatchedMon(3, { metLevel: 0 }), true);
  assert.equal(R.hatchedMon(4, { metLevel: 0 }), true);
  assert.equal(R.hatchedMon(4, { metLevel: 3, eggLocation: 0 }), false);
  assert.equal(R.hatchedMon(5, { metLevel: 1, eggLocation: 60002 }), true);
  assert.equal(R.hatchedMon(6, { metLevel: 1 }), false, 'a level 1 without an egg place is no egg');
  assert.equal(R.hatchedMon(7, { metLevel: 1, eggLocation: 30002 }), true);
});

test('an egg stays out of every team shown: board, play view, savestates (#11)', () => {
  const party = src('party.mjs');
  assert.match(party, /export const unhatched = \(m\) => !!\(m\?\.egg \|\| m\?\.isEgg\);/);
  assert.match(party, /const mons = \(party \|\| \[\]\)\.filter\(\(m\) => m && m\.species && !unhatched\(m\)\)/, 'PartyGrid');
  assert.match(party, /filter\(\(m\) => m\?\.species && !unhatched\(m\)\)\.length\}\/6/, 'TeamColumns count');
  assert.match(src('board.mjs'), /if \(l\?\.party\?\.length\) return l\.party\.filter\(\(m\) => !unhatched\(m\)\);/, 'the board’s pairs');
  assert.match(src('savestates.mjs'), /filter\(\(m\) => m\?\.species && !unhatched\(m\)\)/, 'a savestate’s team');
});

test('Crystal\'s level 1: hatched in the original game; in a randomized run or a hack only when the app saw the egg', () => {
  // the original Crystal has no level-1 wild Pokémon – level 1 is the hatch mark (pokecrystal CAUGHT_EGG_LEVEL)
  assert.equal(R.hatchedMon(2, { key: 'k', metLevel: 1 }), true);
  // a randomizer's level modifier or a hack can put level-1 Pokémon in the grass, and Crystal marks a hatch by nothing else
  assert.equal(R.hatchedMon(2, { key: 'k', metLevel: 1 }, { levelOneWild: true }), false, 'not seen as an egg: a catch');
  assert.equal(R.hatchedMon(2, { key: 'k', metLevel: 1 }, { levelOneWild: true, wasEgg: new Set(['k']) }), true, 'seen as an egg');
  assert.equal(R.levelOneWild({ randomizer: { enabled: true } }), true);
  assert.equal(R.levelOneWild({ game: { hackId: 'x' } }), true);
  assert.equal(R.levelOneWild({ randomizer: { enabled: false } }), false);
  // through the snapshot: a randomized Crystal run
  const M = { ...SOLO('crystal', 'gbc'), randomizer: { enabled: true } };
  const start = () => {
    const d = mkDoc();
    R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [mon({ metLocation: 1 })] });
    return d;
  };
  // a level-1 wild catch on Route 31: filed there, not kept out as "hatched"
  const wild = start();
  const w = R.applySnapshot(wild, M, 2, 'p1', { source: 'live', party: [mon({ metLocation: 1 }), mon({ key: 'w', species: 16, level: 1, metLocation: 5, metLevel: 1 })] });
  assert.deepEqual([w.inbox.length, w.newCatches.length], [0, 1]);
  // the egg the app saw in the team hatches: the same key, level 1 → "hatched from an egg"
  const egg = start();
  R.applySnapshot(egg, M, 2, 'p1', { source: 'live', party: [mon({ metLocation: 1 }), mon({ key: 'h', species: 175, level: 5, isEgg: true })] });
  const h = R.applySnapshot(egg, M, 2, 'p1', { source: 'live', party: [mon({ metLocation: 1 }), mon({ key: 'h', species: 175, level: 5, metLocation: 5, metLevel: 1 })] });
  assert.deepEqual(h.inbox.map((i) => [i.mon.key, i.reason]), [['h', 'egg']]);
});

test('Crystal\'s hatch mark sticks: the hatched Pokémon stays in the inbox on the next polls, never filed as a catch', () => {
  // a randomized Crystal: level 1 is no hatch mark by itself – only the egg the app saw counts, and after the first poll
  // the egg is gone from the team (it is the hatched Pokémon now)
  const M = { ...SOLO('crystal', 'gbc'), randomizer: { enabled: true } };
  const starter = mon({ metLocation: 1 });
  const hatched = mon({ key: 'h', species: 175, level: 5, metLocation: 5, metLevel: 1 });
  const d = mkDoc();
  R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [starter] });
  R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [starter, mon({ key: 'h', species: 175, level: 5, isEgg: true })] });
  const caught = () => Object.keys(d.scan('enc:')).filter((k) => k !== 'starter:p1');
  for (const poll of [1, 2, 3]) {
    const res = R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [starter, hatched] });
    assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason]), [['h', 'egg']], `poll ${poll}: still in the inbox`);
    assert.deepEqual([res.newCatches, caught()], [[], []], `poll ${poll}: no catch filed`);
    assert.ok(!R.feedList(d).some((f) => f.type === 'catch' && f.area !== 'starter'), `poll ${poll}: no "caught" line in the log`);
  }
  assert.equal(d.get('live:p1').party.find((m) => m.key === 'h').hatched, true, 'the live team carries the mark');
  // put in the PC (the live team no longer has it): still the hatched egg, not a catch
  const boxed = R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [starter], boxes: [hatched] });
  assert.deepEqual(boxed.inbox.map((i) => [i.mon.key, i.reason]), [['h', 'egg']]);
  const again = R.applySnapshot(d, M, 2, 'p1', { source: 'live', party: [starter], boxes: [hatched] });
  assert.deepEqual([again.inbox.map((i) => i.reason), caught()], [['egg'], []]);
  // reopened (a new session, the same run): the mark in the live team still holds
  const d2 = mkDoc();
  R.applySnapshot(d2, M, 2, 'p1', { source: 'live', party: [starter] });
  d2.set('live:p1', { ...d2.get('live:p1'), party: [...d2.get('live:p1').party, { key: 'h', area: null, species: 175, level: 5, hatched: true }] });
  const reopened = R.applySnapshot(d2, M, 2, 'p1', { source: 'live', party: [starter, hatched] });
  assert.deepEqual(reopened.inbox.map((i) => [i.mon.key, i.reason]), [['h', 'egg']]);
  // another run of the same game knows nothing of it: a level-1 Pokémon with that key never seen as an egg is a catch
  const other = mkDoc();
  R.applySnapshot(other, M, 2, 'p1', { source: 'live', party: [starter] });
  assert.deepEqual(R.applySnapshot(other, M, 2, 'p1', { source: 'live', party: [starter, hatched] }).newCatches.length, 1);
});
