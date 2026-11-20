// The two titles of a pair (HeartGold + SoulSilver, Red + Blue, …) in one plain SoulLink (#18): which titles pair up,
// which library ROMs fit an invite, what a joining player's run is built for, and the join itself through the server
// (import the invite, build with the other title) – randomized and patched runs keep needing the exact release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIR_TITLES, pairMate } from '../shared/pair-titles.mjs';
import { baseRomsFor, needsIdenticalRom, pairJoin, joinGameId, restartRequest } from '../shared/restart.mjs';
import { findEntry } from '../shared/live/parse.mjs';
import { gymCapsFamily } from '../shared/routes.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-pairs-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
const { crc32Hex } = await import('../shared/checksum.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));
const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const byId = (id) => catalog.games.find((g) => g.id === id);
const rootOf = (id) => byId(id)?.variantOf || id;

test('pairs: both titles are main games of the same system and generation, each with its own live tracking entry', () => {
  assert.equal(PAIR_TITLES.length, 12);
  const seen = new Set();
  for (const [a, b] of PAIR_TITLES) {
    for (const id of [a, b]) {
      const g = byId(id);
      assert.ok(g, `${id} is in the catalog`);
      assert.equal(g.variantOf, undefined, `${id} is a main game, not a language variant`);
      assert.ok(!seen.has(id), `${id} is in one pair only`);
      seen.add(id);
      // the entry a running copy of this title is tracked with (by its game code, header title or 3DS title ID)
      const code = g.gameCode || (/^[A-Z0-9]{4}$/.test(g.serial || '') ? g.serial : '');
      const entry = findEntry(addresses, { platform: g.system, code, title: g.headerTitle || '', titleId: g.titleIds?.[0] });
      assert.ok(entry, `${id} has live tracking`);
    }
    assert.equal(byId(a).system, byId(b).system);
    assert.equal(byId(a).generation, byId(b).generation);
    assert.equal(pairMate(a), b);
    assert.equal(pairMate(b), a);
    assert.equal(gymCapsFamily(a), gymCapsFamily(b), 'same gyms, same level caps');
  }
  // third versions have other maps and events – never a pair
  for (const id of ['pokemon-yellow', 'pokemon-crystal', 'pokemon-emerald', 'pokemon-platinum', 'pokemon-heartgold-de']) assert.equal(pairMate(id), null, id);
});

const roms = [
  { id: 'hg-rev0', crc: 'C180A0E9', gameId: 'pokemon-heartgold' },
  { id: 'hg-de', crc: '11111111', gameId: 'pokemon-heartgold-de' },
  { id: 'ss-hack', crc: '22222222', gameId: 'pokemon-soulsilver', hackId: 'some-hack' },
  { id: 'ss', crc: 'D0A0BEF9', gameId: 'pokemon-soulsilver' },
  { id: 'ss-de', crc: '33333333', gameId: 'pokemon-soulsilver-de' },
  { id: 'pt', crc: '9253921D', gameId: 'pokemon-platinum' },
  { id: 'pearl', crc: '44444444', gameId: 'pokemon-pearl' },
];
const plainHg = { base: { crc: 'C180A0E9' }, game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE' }, randomizer: { enabled: false }, patch: null };

test('joining a plain run: the exact release, then the same title, then the other title of the pair', () => {
  assert.deepEqual(baseRomsFor(plainHg, roms, rootOf).map((r) => r.id), ['hg-rev0', 'hg-de', 'ss', 'ss-de']);
  // with only the other title in the library
  const ssOnly = roms.filter((r) => /^ss/.test(r.id));
  assert.deepEqual(baseRomsFor(plainHg, ssOnly, rootOf).map((r) => r.id), ['ss', 'ss-de'], 'a hack ROM never fits');
  // and the other way round: a SoulSilver run takes HeartGold
  const plainSs = { ...plainHg, base: { crc: 'D0A0BEF9' }, game: { id: 'pokemon-soulsilver', system: 'nds', code: 'IPGE' } };
  assert.deepEqual(baseRomsFor(plainSs, roms, rootOf).map((r) => r.id), ['ss', 'ss-de', 'hg-rev0', 'hg-de']);
  // a run of a third version takes no other game
  const plainPt = { ...plainHg, base: { crc: '9253921D' }, game: { id: 'pokemon-platinum', system: 'nds' } };
  assert.deepEqual(baseRomsFor(plainPt, roms, rootOf).map((r) => r.id), ['pt']);
  // Diamond ↔ Pearl
  const plainDiamond = { ...plainHg, base: { crc: '84427823' }, game: { id: 'pokemon-diamond', system: 'nds' } };
  assert.deepEqual(baseRomsFor(plainDiamond, roms, rootOf).map((r) => r.id), ['pearl']);
});

test('randomized, patched and pre-patched hack runs still need the exact release – never the other title', () => {
  const randomized = { ...plainHg, randomizer: { enabled: true } };
  const patched = { ...plainHg, patch: { name: 'Hack', sha1: 'x' } };
  const prePatched = { ...plainHg, game: { ...plainHg.game, hackId: 'some-hack' } };
  for (const m of [randomized, patched, prePatched]) {
    assert.equal(needsIdenticalRom(m), true);
    assert.deepEqual(baseRomsFor(m, roms, rootOf).map((r) => r.id), ['hg-rev0']);
    assert.deepEqual(baseRomsFor({ ...m, base: { crc: '00000000' } }, roms, rootOf), []);
    assert.equal(pairJoin(m, roms[3], rootOf), null);
    assert.equal(joinGameId(m, roms[3], rootOf), 'pokemon-heartgold');
  }
  assert.equal(needsIdenticalRom(plainHg), false);
  // restarting your own run (no rootOf) stays exact, too
  assert.deepEqual(baseRomsFor(plainHg, roms).map((r) => r.id), ['hg-rev0']);
});

test('2.7 together: a hack the catalog doesn\'t know (game.hackName) needs the exact ROM, a ROM marked as a hack is no other edition', () => {
  // a run of an already-patched ROM the player named in the library ("This is a ROM hack…" → Other / unknown hack)
  const named = { ...plainHg, game: { ...plainHg.game, hackName: 'My Kaizo' } };
  assert.equal(needsIdenticalRom(named), true);
  assert.deepEqual(baseRomsFor(named, roms, rootOf).map((r) => r.id), ['hg-rev0']);
  assert.equal(pairJoin(named, roms[3], rootOf), null);
  assert.equal(joinGameId(named, roms[3], rootOf), 'pokemon-heartgold');
  // a joining player's SoulSilver that they marked as an unknown hack is a hack, not the other edition / release
  const marked = [...roms, { id: 'ss-marked', crc: '55555555', gameId: 'pokemon-soulsilver', customHack: 'Their Hack' },
    { id: 'hg-marked', crc: '66666666', gameId: 'pokemon-heartgold', customHack: 'Another Hack' }];
  assert.deepEqual(baseRomsFor(plainHg, marked, rootOf).map((r) => r.id), ['hg-rev0', 'hg-de', 'ss', 'ss-de']);
  assert.equal(pairJoin(plainHg, marked.find((r) => r.id === 'ss-marked'), rootOf), null);
  assert.deepEqual(baseRomsFor(plainHg, marked.filter((r) => /marked/.test(r.id)), rootOf), []);
});

test('a joining player\'s run is built for the title they play; the same title keeps the host\'s id', () => {
  assert.deepEqual(pairJoin(plainHg, roms[3], rootOf), { host: 'pokemon-heartgold', yours: 'pokemon-soulsilver' });
  assert.deepEqual(pairJoin(plainHg, roms[4], rootOf), { host: 'pokemon-heartgold', yours: 'pokemon-soulsilver' }, 'a language variant counts as its title');
  assert.equal(joinGameId(plainHg, roms[4], rootOf), 'pokemon-soulsilver');
  assert.equal(pairJoin(plainHg, roms[1], rootOf), null, 'another release of the same title');
  assert.equal(joinGameId(plainHg, roms[1], rootOf), 'pokemon-heartgold');
  assert.equal(pairJoin(plainHg, roms[2], rootOf), null, 'a hack ROM');
  assert.equal(pairJoin(plainHg, roms[5], rootOf), null, 'an unrelated game');
  assert.equal(pairJoin(plainHg, undefined, rootOf), null);
  assert.equal(joinGameId({ game: null }, roms[3], rootOf), null);
});

test('3DS: a plain X run takes Y on joining (by catalog id), a restart stays with X', () => {
  const lib = [
    { id: 'y', system: '3ds', crc: null, gameId: 'pokemon-y', code: 'EK2A' },
    { id: 'x', system: '3ds', crc: null, gameId: 'pokemon-x', code: 'EKJA' },
    { id: 'or', system: '3ds', crc: null, gameId: 'pokemon-omega-ruby', code: 'ECRA' },
  ];
  const xRun = { base: { crc: null }, game: { id: 'pokemon-x', system: '3ds', code: 'EKJA' }, randomizer: { enabled: false }, patch: null };
  assert.deepEqual(baseRomsFor(xRun, lib, rootOf).map((r) => r.id), ['x', 'y']);
  assert.deepEqual(baseRomsFor(xRun, lib).map((r) => r.id), ['x']);
  assert.deepEqual(baseRomsFor(xRun, lib.filter((r) => r.id !== 'x'), rootOf).map((r) => r.id), ['y']);
  assert.deepEqual(pairJoin(xRun, lib[0], rootOf), { host: 'pokemon-x', yours: 'pokemon-y' });
  const orRun = { ...xRun, game: { id: 'pokemon-omega-ruby', system: '3ds', code: 'ECRA' } };
  assert.deepEqual(baseRomsFor(orRun, lib, rootOf).map((r) => r.id), ['or']);
});

test('a restart of a joined pair run picks the own title again', () => {
  // the joining player's manifest names their own game (SoulSilver) and its CRC32
  const mine = { ...plainHg, base: { crc: 'D0A0BEF9' }, game: { id: 'pokemon-soulsilver', system: 'nds', code: 'IPGE' }, players: { p1: { name: 'A' }, p2: { name: 'B' } } };
  const req = restartRequest(mine, { library: { roms, patches: [] }, runs: [], mySlot: 'p2' });
  assert.equal(req.romId, 'ss');
  assert.equal(req.gameId, 'pokemon-soulsilver');
});

/** A minimal DS ROM: header title + game code, the rest filler (distinct per title, so the CRC32s differ). */
function fakeNds(title, code, fill) {
  const b = Buffer.alloc(0x4000, fill);
  b.fill(0, 0, 0x200);
  b.write(title, 0, 'ascii');
  b.write(code, 0x0c, 'ascii');
  b.write('01', 0x10, 'ascii');
  return b;
}

test('join through the server: a HeartGold invite, built from SoulSilver – the run is SoulSilver on this computer', async () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  const hg = fakeNds('POKEMON HG', 'IPKE', 0x11);
  const ss = fakeNds('POKEMON SS', 'IPGE', 0x22);
  writeFileSync(join(lib, 'SoulSilver.nds'), ss);
  const { server, url } = await startServer({ port: 0, background: false });
  const call = async (method, path, body) => {
    const r = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const invite = (o = {}) => ({
    format: 'soullink-studio/run-pack@1', id: 'abcd0123', name: 'Ana & Ben', room: 'room-pair-0123456789', secret: 'SECRET-PAIR-KEY-0f9e8d7c', mode: 'soullink',
    players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, base: { crc: crc32Hex(new Uint8Array(hg)), name: 'HeartGold.nds' }, patch: null,
    randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' }, sharedSeed: false }, outputs: { p1: { sha1: 'host-sha1-p1' }, p2: { sha1: 'host-sha1-p2' } }, rules: null, // the host built both games
    game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE', title: 'POKEMON HG', hackId: null }, ...o,
  });
  try {
    const imported = await call('POST', '/api/runs/import', { pack: invite() });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const pack = imported.body;
    const library = (await call('GET', '/api/library')).body;
    const rom = baseRomsFor(pack, library.roms, rootOf)[0];
    assert.ok(rom, 'the SoulSilver copy fits the HeartGold invite');
    assert.equal(rootOf(rom.gameId), 'pokemon-soulsilver');
    assert.deepEqual(pairJoin(pack, rom, rootOf), { host: 'pokemon-heartgold', yours: 'pokemon-soulsilver' });
    // what the join view sends (web/views/soullink.mjs JoinRun build)
    const built = await call('POST', '/api/runs/build', {
      runId: pack.id, romId: rom.id, patchId: null, values: pack.randomizer.values, randomize: false, seeds: pack.randomizer.seeds, sharedSeed: false,
      players: pack.players, buildFor: ['p2'], name: pack.name, mode: 'soullink', expectedOutputs: pack.expectedOutputs, rules: pack.rules,
      gameId: joinGameId(pack, rom, rootOf), hackId: null, gameTitle: 'Pokémon SoulSilver Version',
    });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    const m = built.body.manifest;
    assert.equal(m.game.id, 'pokemon-soulsilver', 'live tracking, cover and trophies follow the game played here');
    assert.equal(m.game.code, 'IPGE', 'the code of the ROM that was built – the tracker reads SoulSilver');
    assert.equal(m.base.crc, crc32Hex(new Uint8Array(ss)));
    assert.equal(m.outputs.p2.matchesFriend, false);
    assert.match(m.outputs.p2.rom, /SoulSilver/);
    const log = built.body.log.map((l) => l.code);
    assert.ok(log.includes('romPairMate'), log.join());
    assert.ok(!log.includes('romDiffers'), log.join());
    // the identity of the run is the host's: same room and secret, so the two apps sync
    assert.equal(m.room, 'room-pair-0123456789');
    assert.equal(m.id, 'abcd0123');

    // a pre-patched hack run (hack id, no patch file) is no plain run: another ROM is a mismatch
    const hackPack = (await call('POST', '/api/runs/import', { pack: invite({ id: 'abcd0124', game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE', title: 'POKEMON HG', hackId: 'some-hack' } }) })).body;
    assert.deepEqual(baseRomsFor(hackPack, library.roms, rootOf), []);
    const hackBuild = await call('POST', '/api/runs/build', {
      runId: hackPack.id, romId: rom.id, randomize: false, seeds: hackPack.randomizer.seeds, players: hackPack.players, buildFor: ['p2'], mode: 'soullink',
      expectedOutputs: hackPack.expectedOutputs, gameId: hackPack.game.id, hackId: 'some-hack',
    });
    assert.ok(hackBuild.body.log.some((l) => l.code === 'romDiffers'), JSON.stringify(hackBuild.body.log));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
