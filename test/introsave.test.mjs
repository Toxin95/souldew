// Intro saves (a community idea): keep a save from after a game's intro, start new attempts of the same game from it.
// shared/introsave.mjs reads synthetic saves of every generation; server/lib/introsave.mjs keeps one per game, offers it
// only for that game, applies it to new runs (randomized or not) and never puts it into a run pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, openSync, writeSync, closeSync, renameSync as renameSyncReal } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { encryptPK4, crc16ccitt } from '../shared/gen4save.mjs';
import { encryptPK6 } from '../shared/live/gen67.mjs';
import { inspectSave, blankSave } from '../shared/introsave.mjs';
import { cci } from './fixtures/ctr.mjs';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

const DATA = mkdtempSync(join(tmpdir(), 'sls-intro-'));
process.env.SLS_DATA_DIR = DATA;
const { buildRun, readManifest, runPack } = await import('../server/lib/build.mjs');
const { saveDirFor } = await import('../server/lib/ctr.mjs');
const intro = await import('../server/lib/introsave.mjs');
const { defaultSavePath } = await import('../server/app.mjs');
const { applySnapshot } = await import('../web/lib/run.mjs');
const { RunDoc } = await import('../web/lib/doc.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const opts = { savePath: defaultSavePath };
const index = (f) => {
  const j = JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
  const out = [];
  for (const [k, v] of Object.entries(j.map || j.table || j)) if (!k.startsWith('_')) out[Number(k)] = v;
  return out;
};
const TABLES = { gen1Index: index('gen1_index_to_dex.json'), gen3Index: index('gen3_index_to_dex.json') };

const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const w16be = (b, o, v) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const w32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };
const hex8 = (n) => n.toString(16).padStart(8, '0');

// ---- synthetic saves, one builder per generation (the layouts shared/introsave.mjs documents) --------------------

/** Red/Blue/Yellow: mons [{ index, ot, dv, level }]. */
function gen1Save(mons = []) {
  const b = new Uint8Array(0x8000);
  b.set([0x80, 0x8e, 0x94, 0x50], 0x2598); // the player's name
  b[0x2f2c] = mons.length;
  mons.forEach((m, i) => {
    b[0x2f2d + i] = m.index;
    const o = 0x2f34 + i * 44;
    b[o] = m.index;
    w16be(b, o + 0x0c, m.ot);
    w16be(b, o + 0x1b, m.dv);
    b[o + 0x21] = m.level;
  });
  b[0x2f2d + mons.length] = 0xff;
  let s = 0;
  for (let i = 0x2598; i < 0x3523; i++) s += b[i];
  b[0x3523] = ~s & 0xff;
  return b;
}

/** Gold/Silver (crystal = false) or Crystal: mons [{ species, ot, dv, level }]. */
function gen2Save(mons = [], crystal = true) {
  const b = new Uint8Array(0x8000);
  const party = crystal ? 0x2865 : 0x288a;
  b.set([0x80, 0x8e], 0x200b);
  b[party] = mons.length;
  mons.forEach((m, i) => {
    b[party + 1 + i] = m.species;
    const o = party + 8 + i * 48;
    b[o] = m.species;
    w16be(b, o + 0x06, m.ot);
    w16be(b, o + 0x15, m.dv);
    b[o + 0x1f] = m.level;
  });
  b[party + 1 + mons.length] = 0xff;
  const [from, to, at] = crystal ? [0x2009, 0x2b83, 0x2d0d] : [0x2009, 0x2d69, 0x2d69];
  let s = 0;
  for (let i = from; i < to; i++) s += b[i];
  w16(b, at, s & 0xffff);
  return b;
}

const G3_SIZES = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
/** One Gen 3 slot (14 sections, rotated like the game does) – `frlg` or Emerald; mons [{ pid, otId, internal, level }]. */
function gen3Slot(b, slot, saveIndex, mons, frlg) {
  for (let i = 0; i < 14; i++) {
    const id = (i + saveIndex) % 14;
    const o = slot + i * 0x1000;
    b.fill(0, o, o + 0x1000);
    if (id === 0) w32(b, o + 0xac, frlg ? 1 : 0x5eed1234);
    if (id === 1) {
      const count = frlg ? 0x34 : 0x234;
      w32(b, o + count, mons.length);
      mons.forEach((m, k) => {
        const d = o + count + 4 + k * 100;
        w32(b, d, m.pid);
        w32(b, d + 4, m.otId);
        // the Growth block, first when pid % 24 is 0 – encrypted with pid ^ otId
        w32(b, d + 32, (m.internal ^ m.pid ^ m.otId) >>> 0);
        b[d + 84] = m.level;
      });
    }
    let sum = 0;
    for (let k = 0; k < G3_SIZES[id]; k += 4) sum = (sum + (b[o + k] | (b[o + k + 1] << 8) | (b[o + k + 2] << 16) | (b[o + k + 3] << 24))) >>> 0;
    w16(b, o + 0xff4, id);
    w16(b, o + 0xff6, ((sum >>> 16) + (sum & 0xffff)) & 0xffff);
    w32(b, o + 0xff8, 0x08012025);
    w32(b, o + 0xffc, saveIndex);
  }
}
function gen3Save(mons = [], { frlg = false, older = null } = {}) {
  const b = new Uint8Array(0x20000).fill(0xff); // flash
  gen3Slot(b, 0, 7, mons, frlg);
  if (older) gen3Slot(b, 0xe000, 6, older, frlg);
  return b;
}

/** A party PK4/PK5 (236 / 220 bytes). */
function pk45({ pid, species, tid, sid, level }, size) {
  const p = new Uint8Array(size);
  w32(p, 0, pid);
  w16(p, 0x08, species);
  w16(p, 0x0c, tid);
  w16(p, 0x0e, sid);
  p[0x8c] = level;
  return encryptPK4(p);
}

const G4 = { dp: [0xc100, 0x14, 0x98], pt: [0xcf2c, 0x14, 0xa0], hgss: [0xf628, 0x10, 0x98] };
/** Diamond/Pearl, Platinum or HeartGold/SoulSilver: the General block in partition B (the first save goes there). */
function gen4Save(game, mons = []) {
  const [size, footer, party] = G4[game];
  const b = new Uint8Array(0x80000);
  const base = 0x40000;
  b[base + 0x10] = 0x55; // something in the block besides the team
  w32(b, base + party - 4, mons.length);
  mons.forEach((m, i) => b.set(pk45(m, 236), base + party + i * 236));
  const end = base + size;
  w32(b, end - footer, 1); // save counter
  w32(b, end - 0x0c, size);
  w32(b, end - 0x08, 0x20060623);
  w16(b, end - 0x02, crc16ccitt(b, base, end - footer));
  return b;
}

/** Black/White, Black 2/White 2: the party block. */
function gen5Save(mons = []) {
  const b = new Uint8Array(0x80000);
  b[0x100] = 0x42;
  w32(b, 0x18e04, mons.length);
  mons.forEach((m, i) => b.set(pk45(m, 220), 0x18e08 + i * 220));
  w16(b, 0x19336, crc16ccitt(b, 0x18e00, 0x18e00 + 0x534));
  return b;
}

/** A 3DS `main` of Sun/Moon (0x6BE00 bytes): mons [{ pid, species, tid, sid, level }]. */
function smMain(mons = []) {
  const b = new Uint8Array(0x6be00);
  b[0x10] = 0x77;
  b[0x1400 + 6 * 260] = mons.length;
  mons.forEach((m, i) => {
    const p = new Uint8Array(260);
    w32(p, 0, 0xabcdef01 + i); // encryption constant
    w16(p, 0x08, m.species);
    w16(p, 0x0c, m.tid);
    w16(p, 0x0e, m.sid);
    w32(p, 0x18, m.pid);
    p[0xec] = m.level;
    w16(p, 0xf0, 20);
    w16(p, 0xf2, 20);
    b.set(encryptPK6(p), 0x1400 + i * 260);
  });
  return b;
}

// ---- reading saves ----------------------------------------------------------------------------------------------

test('Gen 1: an intro save (empty team) and one with the starter, keyed like the live reader keys them', () => {
  assert.deepEqual(inspectSave(gen1Save(), 'gb', TABLES), { state: 'ok', gen: 1, party: 0, mons: [] });
  const r = inspectSave(gen1Save([{ index: 0xb1, ot: 0x1234, dv: 0xabcd, level: 5 }]), 'gb', TABLES);
  assert.equal(r.party, 1);
  assert.deepEqual(r.mons, [{ key: 'g1-1234-abcd', species: 7, level: 5 }]); // index 0xB1 is Squirtle
  // a broken sum is no Gen 1 save this file knows – kept, but the team isn't known
  const bad = gen1Save();
  bad[0x3523] ^= 1;
  assert.equal(inspectSave(bad, 'gb').state, 'unknown');
});

test('Gen 2: Crystal and Gold/Silver have their team at their own offsets', () => {
  assert.equal(inspectSave(gen2Save([], true), 'gbc').party, 0);
  assert.equal(inspectSave(gen2Save([], false), 'gbc').party, 0);
  const c = inspectSave(gen2Save([{ species: 155, ot: 0x0042, dv: 0x0f0f, level: 5 }], true), 'gbc');
  assert.deepEqual(c.mons, [{ key: 'g2-42-0f0f', species: 155, level: 5 }]);
  const gs = inspectSave(gen2Save([{ species: 158, ot: 0xffff, dv: 0x1, level: 5 }], false), 'gbc');
  assert.deepEqual(gs.mons, [{ key: 'g2-ffff-0001', species: 158, level: 5 }]);
});

test('Gen 3: Emerald and FireRed/LeafGreen, the newer of the two slots counts', () => {
  const mudkip = TABLES.gen3Index.indexOf(258);
  const pid = 24 * 50001; // pid % 24 = 0: the Growth block comes first
  const e = inspectSave(gen3Save([{ pid, otId: 0x9876abcd, internal: mudkip, level: 5 }]), 'gba', TABLES);
  assert.deepEqual(e, { state: 'ok', gen: 3, party: 1, mons: [{ key: `g3-${hex8(pid)}-9876abcd`, species: 258, level: 5 }] });
  const fr = inspectSave(gen3Save([], { frlg: true }), 'gba', TABLES);
  assert.equal(fr.party, 0);
  // slot A (index 7, empty team) is newer than slot B (index 6, one Pokémon): the intro save is the empty one
  const two = inspectSave(gen3Save([], { older: [{ pid: 1, otId: 2, internal: 1, level: 3 }] }), 'gba', TABLES);
  assert.equal(two.party, 0);
  assert.equal(inspectSave(new Uint8Array(0x20000).fill(0xff), 'gba').state, 'empty', 'a never-written flash is no save');
});

test('Gen 4: Diamond/Pearl, Platinum and HeartGold/SoulSilver', () => {
  for (const game of ['dp', 'pt', 'hgss']) {
    assert.deepEqual(inspectSave(gen4Save(game), 'nds'), { state: 'ok', gen: 4, party: 0, mons: [] }, game);
    const r = inspectSave(gen4Save(game, [{ pid: 0x0badf00d, species: 390, tid: 12345, sid: 54321, level: 5 }]), 'nds');
    assert.deepEqual(r.mons, [{ key: '0badf00d-12345-54321', species: 390, level: 5 }], game);
  }
  // a DeSmuME .dsv: 122 bytes after the 512 KB
  const dsv = new Uint8Array(0x80000 + 122);
  dsv.set(gen4Save('hgss'));
  dsv.fill(0x7c, 0x80000);
  assert.equal(inspectSave(dsv, 'nds').party, 0);
});

test('Gen 5 and the 3DS games', () => {
  assert.deepEqual(inspectSave(gen5Save(), 'nds'), { state: 'ok', gen: 5, party: 0, mons: [] });
  const b = inspectSave(gen5Save([{ pid: 0x11223344, species: 495, tid: 1, sid: 2, level: 5 }]), 'nds');
  assert.deepEqual(b.mons, [{ key: '11223344-1-2', species: 495, level: 5 }]);
  const broken = gen5Save();
  broken[0x18e10] ^= 1; // the party block's CRC no longer fits
  assert.equal(inspectSave(broken, 'nds').state, 'unknown');
  assert.deepEqual(inspectSave(smMain(), '3ds'), { state: 'ok', gen: 7, party: 0, mons: [] });
  const sm = inspectSave(smMain([{ pid: 0xdeadbeef, species: 722, tid: 23858, sid: 38904, level: 5 }]), '3ds');
  assert.deepEqual(sm.mons, [{ key: 'deadbeef-23858-38904', species: 722, level: 5 }]);
  assert.equal(inspectSave(new Uint8Array(0x1234).fill(3), '3ds').state, 'unknown', 'a size no 3DS game has');
  assert.ok(blankSave(new Uint8Array(0x8000)) && !blankSave(gen1Save()));
});

// ---- which game an intro save belongs to ------------------------------------------------------------------------

test('the key: the exact release (catalog id by CRC32), a hack by its patch or checksum, a 3DS game by its title', () => {
  const run = (system, crc, extra = {}) => ({ base: { crc }, game: { system, id: extra.id || null, hackId: extra.hackId || null, ...(extra.hackName ? { hackName: extra.hackName } : {}) }, patch: extra.patch || null });
  assert.equal(intro.introKeyFor(run('gba', '1F1C08FB')), 'game:pokemon-emerald');
  assert.equal(intro.introKeyFor(run('gba', '34C9DF89', { id: 'pokemon-emerald' })), 'game:pokemon-emerald-de', 'German Smaragd is its own release – not the US/EU Emerald');
  assert.equal(intro.introKeyFor(run('gba', 'DD88761C')), intro.introKeyFor(run('gba', '84EE4776')), 'FireRed Rev 0 and Rev 1 share one');
  assert.equal(intro.introKeyFor(run('nds', 'C180A0E9')), 'game:pokemon-heartgold');
  assert.notEqual(intro.introKeyFor(run('nds', 'B64A5EFB')), intro.introKeyFor(run('nds', 'C180A0E9')), 'European HeartGold is another release');
  assert.equal(intro.introKeyFor(run('gba', 'DD88761C', { patch: { sha1: 'A'.repeat(40) } })), `patch:${'a'.repeat(40)}`);
  assert.equal(intro.introKeyFor(run('gba', 'DD88761C', { patch: { sha1: null } })), null, 'a patch without a checksum: no intro save');
  assert.equal(intro.introKeyFor(run('gba', '12345678', { hackId: 'radical-red' })), 'rom:12345678');
  assert.equal(intro.introKeyFor(run('gba', '1234ABCD')), 'rom:1234ABCD', 'a ROM the catalog doesn’t know: by its checksum');
  assert.equal(intro.introKeyFor(run('3ds', null, { id: 'pokemon-sun' })), 'game:pokemon-sun');
  assert.equal(intro.introKeyFor(run('psx', '1F1C08FB')), null);
  // the wizard asks before any run exists – with the library entry: the same key
  assert.equal(intro.introKeyForLibrary({ system: 'gba', crc: '34c9df89', gameId: 'pokemon-emerald-de' }), 'game:pokemon-emerald-de');
  assert.equal(intro.introKeyForLibrary({ system: 'gba', crc: 'DD88761C', gameId: 'pokemon-firered' }, { sha1: 'a'.repeat(40) }), `patch:${'a'.repeat(40)}`);
  assert.equal(intro.introKeyForLibrary({ system: 'gba', crc: '12345678', hackId: 'radical-red', gameId: 'pokemon-firered' }), 'rom:12345678');
  assert.equal(intro.introKeyForLibrary({ system: '3ds', crc: null, gameId: 'pokemon-sun' }), 'game:pokemon-sun');
});

// ---- keeping and applying, end to end with built runs --------------------------------------------------------------

const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });
/** A small fake GBA ROM (its own CRC32 – the key is then rom:<crc>) – `fill` makes another game. */
function fakeGba(name, fill) {
  const p = join(LIB, name);
  const b = Buffer.alloc(0x10000, fill);
  b.write('POKEMON EMER', 0xa0, 'ascii');
  b.write('BPEE01', 0xac, 'ascii');
  writeFileSync(p, b);
  return p;
}
const ROM = fakeGba('Fake Emerald.gba', 3);
const OTHER = fakeGba('Other Game.gba', 9);

/** A stand-in for the randomizer: writes a "randomized" ROM that depends on the seed (the save layout stays). */
function fakeBridge() {
  return async (args) => {
    const [, src, out, , seed, log, data] = args;
    const b = readFileSync(src);
    b.write(`SEED${seed}`, 0x1000, 'ascii');
    const fd = openSync(out, 'w');
    writeSync(fd, b);
    closeSync(fd);
    writeFileSync(log, `log ${seed}`);
    writeFileSync(data, JSON.stringify({ seed, pokemon: [], starters: [], encounters: [], statics: [] }));
    return { warnings: [], settingsString: 'S' };
  };
}

const build = (o = {}) => buildRun({ romId: ROM, randomize: false, config: {}, mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, ...o }, () => {}, () => {}, { bridge: fakeBridge() });
const sha1 = (b) => createHash('sha1').update(b).digest('hex');

test('keep a run’s battery save as the intro save, then a new attempt (randomized and not) starts from it', async () => {
  const first = await build();
  assert.equal(intro.introState(first, 'p1', opts).hasSave, false);
  assert.throws(() => intro.keepIntroSave(first, 'p1', opts), { code: 'noSaveYet' });
  // a cartridge that was never written holds no save
  writeFileSync(defaultSavePath(first, 'p1'), new Uint8Array(0x20000).fill(0xff));
  assert.throws(() => intro.keepIntroSave(first, 'p1', opts), { code: 'introEmpty' });
  const save = gen3Save([]); // after the intro, before the starter
  writeFileSync(defaultSavePath(first, 'p1'), save);
  const st = intro.introState(first, 'p1', opts);
  assert.equal(st.supported, true);
  assert.equal(st.hasSave, true);
  assert.equal(st.intro, null);

  const meta = intro.keepIntroSave(first, 'p1', opts);
  assert.equal(meta.key, intro.introKeyFor(first));
  assert.equal(meta.party, 0);
  assert.equal(meta.gen, 3);
  assert.deepEqual(meta.from, { run: first.id, name: first.name });
  assert.ok(meta.savedAt);
  // stored in the data folder, one per game – nowhere near the run
  const dir = join(DATA, 'intro-saves', meta.id);
  assert.equal(sha1(readFileSync(join(dir, 'save.sav'))), sha1(save));
  assert.equal(intro.listIntroSaves().length, 1);
  assert.equal(intro.introState(first, 'p1', opts).intro.id, meta.id);
  assert.equal('keys' in intro.publicIntro(meta), false, 'the page gets no Pokémon keys');

  // a new attempt without the randomizer
  const plain = await build();
  assert.equal(existsSync(defaultSavePath(plain, 'p1')), false);
  const started = intro.applyIntroSave(plain.id, 'p1', opts);
  assert.equal(sha1(readFileSync(defaultSavePath(plain, 'p1'))), sha1(save));
  assert.deepEqual(started.intro.p1, { savedAt: meta.savedAt, party: 0, keys: [] });
  assert.deepEqual(readManifest(plain.id).intro, started.intro, 'noted in run.json');

  // a randomized new attempt: a different ROM, the same save
  const rnd = await build({ randomize: true, values: {}, seeds: { p1: '777' } });
  assert.notEqual(rnd.outputs.p1.sha1, plain.outputs.p1.sha1);
  assert.equal(intro.introKeyFor(rnd), intro.introKeyFor(plain), 'the randomizer doesn’t change which game it is');
  assert.ok(intro.applyIntroSave(rnd.id, 'p1', opts));
  assert.equal(sha1(readFileSync(defaultSavePath(rnd, 'p1'))), sha1(save));

  // never over a save the player already has (a rebuild)
  writeFileSync(defaultSavePath(rnd, 'p1'), gen3Save([{ pid: 24, otId: 1, internal: 1, level: 30 }]));
  assert.equal(intro.applyIntroSave(rnd.id, 'p1', opts), null);
  assert.equal(inspectSave(readFileSync(defaultSavePath(rnd, 'p1')), 'gba').party, 1);

  // another game: not offered, nothing applied
  const other = await build({ romId: OTHER });
  assert.notEqual(intro.introKeyFor(other), meta.key);
  assert.equal(intro.introFor(intro.introKeyFor(other)), null);
  assert.equal(intro.applyIntroSave(other.id, 'p1', opts), null);
  assert.equal(existsSync(defaultSavePath(other, 'p1')), false);
});

test('a save from after the starter: kept with a note of its team, and its Pokémon never count for the new run', async () => {
  const run = await build();
  const pid = 24 * 7;
  writeFileSync(defaultSavePath(run, 'p1'), gen3Save([{ pid, otId: 0x10002, internal: TABLES.gen3Index.indexOf(258), level: 5 }]));
  const meta = intro.keepIntroSave(run, 'p1', opts); // replaces the empty-team one of the test before
  assert.equal(meta.party, 1);
  assert.deepEqual(meta.species, [258]);
  assert.equal(intro.listIntroSaves().length, 1, 'one intro save per game');

  const next = await build();
  const m = intro.applyIntroSave(next.id, 'p1', opts);
  const key = `g3-${hex8(pid)}-10002`;
  assert.deepEqual(m.intro.p1.keys, [key]);
  // the play view's first live read sees that Mudkip: no starter, no encounter – it's set aside like an ignored one
  const doc = new RunDoc('test');
  const mon = { key, species: 258, nickname: 'MUDKIP', level: 5, hp: 20, maxHp: 20, metLocation: 0, metLevel: 5 };
  const out = applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [mon], boxes: [] });
  assert.deepEqual(out.newCatches, []);
  assert.deepEqual(out.inbox, []);
  assert.equal(doc.get(`ign:p1:${key}`).reason, 'intro');
  assert.equal(doc.get('enc:starter:p1', null), null);
  // it faints: no death (it belongs to no encounter)
  const down = applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [{ ...mon, hp: 0 }], boxes: [] });
  assert.deepEqual(down.deaths, []);
  // the starter picked after it is the new run's starter
  const starter = { key: 'g3-00000030-10002', species: 255, nickname: 'TORCHIC', level: 5, hp: 19, maxHp: 19, metLocation: 16, metLevel: 5 };
  const pick = applySnapshot(doc, m, 3, 'p1', { source: 'live', party: [mon, starter], boxes: [] });
  assert.deepEqual(pick.newCatches, ['starter']);
  assert.equal(doc.get('enc:starter:p1').species, 255);

  // an intro save from before the starter (the normal case): the starter is filed as always
  const doc2 = new RunDoc('test2');
  const clean = { ...m, intro: { p1: { savedAt: 'x', party: 0, keys: [] } } };
  assert.deepEqual(applySnapshot(doc2, clean, 3, 'p1', { source: 'live', party: [starter], boxes: [] }).newCatches, ['starter']);
});

test('SoulLink: only my own player starts from my intro save, the run pack and invite never carry it', async () => {
  const host = await build({ mode: 'soullink', players: { p1: { name: 'Lou' }, p2: { name: 'Noa' } }, buildFor: ['p1', 'p2'] });
  const meta = intro.introFor(intro.introKeyFor(host));
  assert.ok(meta, 'the intro save of this game from the tests before');
  const m = intro.applyIntroSave(host.id, 'p1', opts);
  assert.ok(existsSync(defaultSavePath(m, 'p1')));
  assert.equal(existsSync(defaultSavePath(m, 'p2')), false, 'the partner’s game built here starts as usual');
  assert.deepEqual(Object.keys(m.intro), ['p1']);
  // nothing of it in the pack – not on disk, not in the one the page hands out
  const pack = runPack(m);
  assert.equal('intro' in pack, false);
  const onDisk = readFileSync(join(DATA, 'runs', host.id, 'run-pack.soullink.json'), 'utf8');
  assert.ok(!onDisk.includes('intro'), onDisk);
  assert.ok(!JSON.stringify(pack).includes(meta.id));
  // the partner imports the pack on their computer (here: the same run, their slot) – no intro save comes along
  const theirs = await build({ identity: { id: host.id, room: host.room, secret: host.secret }, mode: 'soullink', players: pack.players, buildFor: ['p2'], expectedOutputs: pack.outputs });
  assert.equal(existsSync(defaultSavePath(theirs, 'p2')), false);
});

test('a 3DS game: the save folder of the title is kept and copied into the new run’s 3DS save folder', async () => {
  const rom = join(LIB, 'Pokemon Sun.3ds');
  writeFileSync(rom, cci({ productCode: 'CTR-P-BNDA', titleId: '0004000000164800' }));
  const b3 = (o = {}) => buildRun({ romId: rom, gameId: 'pokemon-sun', gameTitle: 'Pokémon Sun', randomize: false, mode: 'nuzlocke', players: { p1: { name: 'Ash' } }, config: {}, ...o });
  const first = await b3();
  assert.equal(intro.introState(first, 'p1', opts).hasSave, false);
  const rel = ['Azahar', 'sdmc', 'Nintendo 3DS', '0'.repeat(32), '0'.repeat(32), 'title', '00040000', '00164800', 'data'];
  const data = join(saveDirFor(`run-${first.id}-p1`), ...rel);
  mkdirSync(join(data, '00000001'), { recursive: true });
  writeFileSync(join(data, '00000001', 'main'), smMain());
  writeFileSync(join(data, '00000001.metadata'), 'meta');
  const meta = intro.keepIntroSave(first, 'p1', opts);
  assert.equal(meta.key, 'game:pokemon-sun');
  assert.equal(meta.party, 0);
  assert.equal(meta.gen, 7);
  const next = await b3();
  assert.ok(intro.applyIntroSave(next.id, 'p1', opts));
  const copied = join(saveDirFor(`run-${next.id}-p1`), ...rel);
  assert.equal(sha1(readFileSync(join(copied, '00000001', 'main'))), sha1(smMain()));
  assert.equal(readFileSync(join(copied, '00000001.metadata'), 'utf8'), 'meta');
  assert.equal(intro.applyIntroSave(next.id, 'p1', opts), null, 'a save folder that is there stays');
});

test('remove an intro save: gone from the data folder, no longer offered', async () => {
  const before = intro.listIntroSaves();
  assert.ok(before.length >= 2);
  const one = before.find((x) => x.system === 'gba');
  assert.equal(intro.removeIntroSave(one.id), true);
  assert.equal(existsSync(join(DATA, 'intro-saves', one.id)), false);
  assert.equal(intro.introFor(one.key), null);
  assert.equal(intro.removeIntroSave(one.id), false);
  assert.throws(() => intro.removeIntroSave('../runs'), { code: 'badRequest' });
  const run = await build();
  assert.equal(intro.applyIntroSave(run.id, 'p1', opts), null);
  assert.deepEqual(readdirSync(join(DATA, 'intro-saves')).filter((d) => d.startsWith('.')), [], 'no half-written folder left behind');
  assert.ok(dirname(defaultSavePath(run, 'p1')).startsWith(join(DATA, 'runs')));
});

test('the server: keep, offer, build with "Start from my intro save", remove', async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const call = (method, path, body) => fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const first = await build();
    writeFileSync(defaultSavePath(first, 'p1'), gen3Save([]));
    assert.equal((await call('GET', `/api/runs/${first.id}/intro/p1`)).body.hasSave, true);
    const kept = await call('POST', `/api/runs/${first.id}/intro/p1`);
    assert.equal(kept.status, 200);
    assert.equal(kept.body.intro.party, 0);
    assert.equal('keys' in kept.body.intro, false);
    assert.equal((await call('GET', `/api/intro-saves/for?run=${first.id}`)).body.intro.id, kept.body.intro.id);
    // the wizard's question for the library ROM – and for another one
    const lib = (await call('GET', '/api/library')).body;
    const mine = lib.roms.find((r) => r.name.startsWith('Fake Emerald'));
    const other = lib.roms.find((r) => r.name.startsWith('Other Game'));
    assert.equal((await call('GET', `/api/intro-saves/for?romId=${encodeURIComponent(mine.id)}`)).body.intro.id, kept.body.intro.id);
    assert.equal((await call('GET', `/api/intro-saves/for?romId=${encodeURIComponent(other.id)}`)).body.intro, null);
    // building with it – and without it
    const body = { romId: mine.id, randomize: false, mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, seeds: { p1: '1' } };
    const on = await call('POST', '/api/runs/build', { ...body, introSave: true, introSlot: 'p1' });
    assert.equal(on.status, 200);
    assert.ok(on.body.log.some((l) => l.code === 'introApplied'));
    assert.equal(on.body.manifest.intro.p1.party, 0);
    assert.ok(existsSync(defaultSavePath(on.body.manifest, 'p1')));
    const off = await call('POST', '/api/runs/build', body);
    assert.equal(off.body.manifest.intro, undefined);
    assert.equal(existsSync(defaultSavePath(off.body.manifest, 'p1')), false);
    assert.equal((await call('GET', `/api/runs/${on.body.manifest.id}`)).body.pack.intro, undefined);
    // remove
    assert.deepEqual((await call('DELETE', `/api/intro-saves/${kept.body.intro.id}`)).body, { removed: true });
    assert.equal((await call('GET', `/api/intro-saves/for?run=${first.id}`)).body.intro, null);
    assert.equal((await call('POST', `/api/runs/${first.id}/intro/p3`)).status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('replacing an intro save never loses both: the old one is moved aside, not deleted, until the new one is in place', () => {
  const { INTRO_DIR, swapIn, listIntroSaves } = intro;
  const id = 'abcdef0123456789';
  const put = (dir, n) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, key: 'k', savedAt: `2026-01-0${n}T00:00:00Z`, n }));
  };
  const meta = () => JSON.parse(readFileSync(join(INTRO_DIR, id, 'meta.json'), 'utf8')).n;
  put(join(INTRO_DIR, id), 1);
  // the rename of the new one fails (Windows: a virus scanner holds the folder): the old one is still there
  put(join(INTRO_DIR, '.new-a'), 2);
  let calls = 0;
  const failing = (a, b) => {
    if (++calls === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return renameSyncReal(a, b);
  };
  assert.throws(() => swapIn(join(INTRO_DIR, '.new-a'), id, { rename: failing }), /EPERM/);
  assert.equal(meta(), 1, 'the old intro save is kept');
  assert.equal(existsSync(join(INTRO_DIR, '.new-a')), false, 'the new copy is cleaned up');
  // interrupted between the two renames (the app closed): put back the next time they are read
  const aside = join(INTRO_DIR, `.old-${id}-0badf00d`);
  renameSyncReal(join(INTRO_DIR, id), aside);
  assert.equal(listIntroSaves().find((m) => m.id === id)?.n, 1);
  assert.equal(existsSync(aside), false);
  // and the normal case: the new one in place, nothing left aside
  put(join(INTRO_DIR, '.new-b'), 3);
  swapIn(join(INTRO_DIR, '.new-b'), id);
  assert.equal(meta(), 3);
  assert.deepEqual(readdirSync(INTRO_DIR).filter((d) => d.startsWith('.')), []);
});
