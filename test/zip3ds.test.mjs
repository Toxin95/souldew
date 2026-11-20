// A zipped Nintendo 3DS game (2.7.0): adding the zip unpacks the game into the library as a normal file – streamed,
// CRC32-checked, ZIP64-aware, never a path outside the library – and zips with 3DS games the library scan finds in
// its folders are offered for unpacking instead of being ignored. Only tiny generated zips here, never real games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import { cci } from './fixtures/ctr.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-zip3ds-'));
const HOME = mkdtempSync(join(tmpdir(), 'sls-zip3ds-home-'));
const ELSE = mkdtempSync(join(tmpdir(), 'sls-zip3ds-else-'));
process.env.SLS_DATA_DIR = DATA;
process.env.HOME = HOME; // "Search my Mac / PC" and the import look through ~/Downloads of this fake home
process.env.USERPROFILE = HOME;
const { listZip, extractZipEntry, entryFileName, freeBytes, inflateRatioTooHigh, MAX_CD_BYTES, MAX_ZIP_ENTRIES, MAX_INFLATE_RATIO } = await import('../server/lib/zip.mjs');
const { scanLibrary, importFiles, zipCtrGames, unpackZipGames, unpackLibraryZip, discoverRoms, ctrInfo } = await import('../server/lib/library.mjs');
const { startServer } = await import('../server/app.mjs');
test.after(() => {
  for (const d of [DATA, HOME, ELSE]) rmSync(d, { recursive: true, force: true });
});

const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { addedToLibrary, addedMessage, unpackToast } = await import('../web/lib/libadded.mjs');
const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));

const LIB = join(DATA, 'Library');
mkdirSync(join(HOME, 'Downloads'), { recursive: true });

/** A fake cartridge image: Pokémon X's headers (test/fixtures/ctr.mjs), then `size` bytes in all – several MB of noise,
 * so unpacking takes more than one read. */
function fakeGame(size = 3 * 1024 * 1024 + 123, opts = {}) {
  const b = Buffer.alloc(size);
  randomBytes(size).copy(b);
  b.fill(0, 0, 0x4400);
  Buffer.from(cci(opts)).copy(b);
  return b;
}

/**
 * A zip of `entries` [{ name, data, method (0 stored | 8 deflate), crc (override, to damage it), declared (override
 * of the uncompressed size) }]. `zip64`: sizes and offsets only in ZIP64 extra fields and a ZIP64 end record, as
 * torrentzip writes them for 4 GB games.
 */
function makeZip(entries, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data);
    const size = e.declared ?? e.data.length;
    const name = Buffer.from(e.name);
    const extraL = Buffer.alloc(zip64 ? 20 : 0);
    if (zip64) {
      extraL.writeUInt16LE(1, 0);
      extraL.writeUInt16LE(16, 2);
      extraL.writeBigUInt64LE(BigInt(size), 4);
      extraL.writeBigUInt64LE(BigInt(comp.length), 12);
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(zip64 ? 45 : 20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(zip64 ? 0xffffffff : comp.length, 18);
    lh.writeUInt32LE(zip64 ? 0xffffffff : size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extraL.length, 28);
    const extraC = Buffer.alloc(zip64 ? 28 : 0);
    if (zip64) {
      extraC.writeUInt16LE(1, 0);
      extraC.writeUInt16LE(24, 2);
      extraC.writeBigUInt64LE(BigInt(size), 4);
      extraC.writeBigUInt64LE(BigInt(comp.length), 12);
      extraC.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(zip64 ? 45 : 20, 4);
    cd.writeUInt16LE(zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(zip64 ? 0xffffffff : comp.length, 20);
    cd.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extraC.length, 30);
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    parts.push(lh, name, extraL, comp);
    central.push(cd, name, extraC);
    offset += 30 + name.length + extraL.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, cdBuf, ...tail, eocd]);
}

const noPartFiles = (dir) => !readdirSync(dir).some((n) => n.endsWith('.part') || n.startsWith('.upload-'));

test('extractZipEntry: stored, deflate and ZIP64 entries come out byte for byte, streamed, CRC32 checked', async () => {
  const dir = mkdtempSync(join(ELSE, 'x-'));
  const game = fakeGame();
  for (const [label, entry, opts] of [['stored', { method: 0 }, {}], ['deflate', { method: 8 }, {}], ['zip64', { method: 8 }, { zip64: true }], ['zip64 stored', { method: 0 }, { zip64: true }]]) {
    const zip = join(dir, `${label}.zip`);
    writeFileSync(zip, makeZip([{ name: 'Games/Pokemon X.3ds', data: game, ...entry }], opts));
    const [e] = listZip(zip);
    assert.equal(e.uncompSize, game.length, label);
    const out = join(dir, `${label}.3ds`);
    const seen = [];
    await extractZipEntry(zip, e, out, { onProgress: (done, total) => seen.push([done, total]) });
    assert.ok(readFileSync(out).equals(game), label);
    assert.ok(seen.length > 1, `${label}: progress as it goes`);
    assert.deepEqual(seen.at(-1), [game.length, game.length]);
  }
  assert.ok(noPartFiles(dir));
});

test('extractZipEntry: a wrong CRC32, a short or an oversized entry leave nothing behind', async () => {
  const dir = mkdtempSync(join(ELSE, 'bad-'));
  const game = fakeGame(512 * 1024);
  const cases = [
    ['crc', makeZip([{ name: 'a.3ds', data: game, crc: (crc32(game) ^ 1) >>> 0 }])],
    ['bomb', makeZip([{ name: 'a.3ds', data: game, declared: 1000 }])], // more inside than declared
    ['short', makeZip([{ name: 'a.3ds', data: game, declared: game.length + 10 }])],
    ['stored crc', makeZip([{ name: 'a.3ds', data: game, method: 0, crc: 1 }])],
  ];
  for (const [label, bytes] of cases) {
    const zip = join(dir, `${label}.zip`);
    writeFileSync(zip, bytes);
    const out = join(dir, `${label}.3ds`);
    await assert.rejects(extractZipEntry(zip, listZip(zip)[0], out), (e) => e.zipCode === 'damaged', label);
    assert.ok(!existsSync(out), label);
  }
  // a broken deflate stream
  const broken = makeZip([{ name: 'a.3ds', data: game }]);
  broken.fill(0xff, 40, 200);
  writeFileSync(join(dir, 'broken.zip'), broken);
  await assert.rejects(extractZipEntry(join(dir, 'broken.zip'), listZip(join(dir, 'broken.zip'))[0], join(dir, 'broken.3ds')), (e) => e.zipCode === 'damaged');
  // too large for the caller, encrypted, unknown compression
  const zip = join(dir, 'crc.zip');
  const [e] = listZip(zip);
  await assert.rejects(extractZipEntry(zip, e, join(dir, 'big.3ds'), { maxSize: 1000 }), (x) => x.zipCode === 'tooLarge');
  await assert.rejects(extractZipEntry(zip, { ...e, flags: 1 }, join(dir, 'enc.3ds')), (x) => x.zipCode === 'method');
  await assert.rejects(extractZipEntry(zip, { ...e, method: 14 }, join(dir, 'lzma.3ds')), (x) => x.zipCode === 'method');
  assert.ok(noPartFiles(dir));
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.3ds')), []);
});

test('listZip refuses an oversized central directory or too many entries', () => {
  const dir = mkdtempSync(join(ELSE, 'cd-'));
  const cdSize = MAX_CD_BYTES + 1;
  const bigCd = Buffer.alloc(cdSize + 22);
  const eocd = cdSize;
  bigCd.writeUInt32LE(0x06054b50, eocd);
  bigCd.writeUInt16LE(1, eocd + 8);
  bigCd.writeUInt16LE(1, eocd + 10);
  bigCd.writeUInt32LE(cdSize, eocd + 12);
  bigCd.writeUInt32LE(0, eocd + 16);
  writeFileSync(join(dir, 'big-cd.zip'), bigCd);
  assert.throws(() => listZip(join(dir, 'big-cd.zip')), /central directory too large/);

  const many = Buffer.alloc(22);
  many.writeUInt32LE(0x06054b50, 0);
  many.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 8);
  many.writeUInt16LE(MAX_ZIP_ENTRIES + 1, 10);
  writeFileSync(join(dir, 'many.zip'), many);
  assert.throws(() => listZip(join(dir, 'many.zip')), /too many entries/);
});

test('extractZipEntry refuses a highly compressible deflate bomb before writing', async () => {
  const dir = mkdtempSync(join(ELSE, 'ratio-'));
  // zeros deflate to a tiny payload; declared size is honest, CRC would match – classic disk-fill bomb
  const zeros = Buffer.alloc(2 * 1024 * 1024, 0);
  const zip = join(dir, 'zeros.zip');
  writeFileSync(zip, makeZip([{ name: 'a.3ds', data: zeros, method: 8 }]));
  const [e] = listZip(zip);
  assert.ok(e.compSize > 0 && e.uncompSize / e.compSize > MAX_INFLATE_RATIO);
  assert.equal(inflateRatioTooHigh(e), true);
  const out = join(dir, 'a.3ds');
  await assert.rejects(extractZipEntry(zip, e, out), (x) => x.zipCode === 'tooLarge');
  assert.ok(!existsSync(out));
  assert.ok(noPartFiles(dir));
  // high-entropy 3DS-like payload stays under the ratio and still unpacks
  const game = fakeGame(512 * 1024);
  writeFileSync(zip, makeZip([{ name: 'a.3ds', data: game, method: 8 }]));
  const [ok] = listZip(zip);
  assert.equal(inflateRatioTooHigh(ok), false);
  await extractZipEntry(zip, ok, out);
  assert.ok(readFileSync(out).equals(game));
});

test('entry names that leave the folder are refused', () => {
  assert.equal(entryFileName('Pokemon Sun (USA).3ds'), 'Pokemon Sun (USA).3ds');
  assert.equal(entryFileName('Games/3DS/Pokemon Sun.3ds'), 'Pokemon Sun.3ds');
  assert.equal(entryFileName('Games\\Pokemon Sun.3ds'), 'Pokemon Sun.3ds');
  for (const bad of ['../evil.3ds', 'a/../../evil.3ds', '..\\evil.3ds', '/etc/evil.3ds', '\\\\server\\share\\evil.3ds', 'C:\\evil.3ds', 'c:evil.3ds', 'dir/', '', 'a/.']) {
    assert.throws(() => entryFileName(bad), (e) => e.zipCode === 'unsafe', bad);
  }
  assert.equal(freeBytes('/', { statfs: () => ({ bavail: 10n, bsize: 4096n }) }), 40960);
  assert.equal(freeBytes('/', { statfs: () => { throw new Error('no'); } }), null);
});

test('import: a zip with a 3DS game is unpacked into the library (not copied), identified like a loose file', async () => {
  const game = fakeGame();
  const zip = join(HOME, 'Downloads', 'Pokemon X (Europe) (En,Fr,De).zip');
  writeFileSync(zip, makeZip([{ name: 'Pokemon X (Europe) (En,Fr,De).3ds', data: game }, { name: '__MACOSX/._Pokemon X.3ds', data: Buffer.from('junk') }], { zip64: true }));
  const before = scanLibrary({});
  const events = [];
  const added = await importFiles([zip], {}, { onUnpack: (p) => events.push(p) });
  const file = join(LIB, 'Pokemon X (Europe) (En,Fr,De).3ds');
  assert.deepEqual(added, [file]);
  assert.ok(readFileSync(file).equals(game));
  assert.ok(!existsSync(join(LIB, 'Pokemon X (Europe) (En,Fr,De).zip')), 'no second copy of the zip in the library');
  assert.ok(existsSync(zip), 'the original stays where it was');
  assert.ok(noPartFiles(LIB));
  assert.equal(ctrInfo(file, '3ds').code, 'EKJA');
  assert.deepEqual(events.map((e) => e.state), ['start', 'done']);
  assert.equal(events[0].gameId, 'pokemon-x');
  assert.equal(events[0].size, game.length);
  // on the shelf like any 3DS file – and the message after adding says so
  const after = scanLibrary({});
  const rom = after.roms.find((r) => r.file === file);
  assert.equal(rom.gameId, 'pokemon-x');
  assert.equal(rom.system, '3ds');
  const msg = addedMessage(addedToLibrary(before, after, added), catalog);
  assert.equal(msg.kind, 'ok');
  assert.match(msg.title, /Pok.mon X/);
  // the same zip again: not unpacked a second time, "already in your library"
  const again = await importFiles([zip], {}, {});
  assert.deepEqual(again, [file]);
  assert.equal(addedMessage(addedToLibrary(after, scanLibrary({}), again), catalog).title, 'Already in your library');
  rmSync(file);
});

test('import: a zip with a 3DS game and other ROMs is unpacked and kept; a refused name unpacks nothing', async () => {
  const gba = Buffer.alloc(0x400);
  gba.write('POKEMON FIRE', 0xa0);
  gba.write('BPRE', 0xac);
  const zip = join(HOME, 'Downloads', 'mixed.zip');
  writeFileSync(zip, makeZip([{ name: 'X.3ds', data: fakeGame(300000) }, { name: 'fire.gba', data: gba }]));
  const added = await importFiles([zip], {}, {});
  assert.deepEqual(added, [join(LIB, 'X.3ds'), join(LIB, 'mixed.zip')]);
  rmSync(join(LIB, 'X.3ds'));
  rmSync(join(LIB, 'mixed.zip'));

  const evil = join(HOME, 'Downloads', 'evil.zip');
  writeFileSync(evil, makeZip([{ name: '../../evil.3ds', data: fakeGame(300000) }]));
  await assert.rejects(importFiles([evil], {}, {}), (e) => e.status === 400 && e.code === 'zipEntryUnsafe');
  assert.ok(!existsSync(join(DATA, 'evil.3ds')) && !existsSync(join(LIB, 'evil.3ds')) && !existsSync(join(HOME, 'evil.3ds')));

  const damaged = join(HOME, 'Downloads', 'damaged.zip');
  const game = fakeGame(300000);
  writeFileSync(damaged, makeZip([{ name: 'Damaged.3ds', data: game, crc: (crc32(game) ^ 0xff) >>> 0 }]));
  const events = [];
  await assert.rejects(importFiles([damaged], {}, { onUnpack: (p) => events.push(p.state) }), (e) => e.status === 422 && e.code === 'zipDamaged' && e.vars.name === 'Damaged.3ds');
  assert.deepEqual(events, ['start', 'failed']);
  assert.ok(!existsSync(join(LIB, 'Damaged.3ds')));
  assert.ok(noPartFiles(LIB));
});

test('not enough disk space: refused before a byte is written, with a clear message', async () => {
  const zip = join(HOME, 'Downloads', 'Pokemon X.zip');
  writeFileSync(zip, makeZip([{ name: 'Pokemon X.3ds', data: fakeGame(300000) }]));
  const [g] = zipCtrGames(zip);
  const huge = { ...g, entry: { ...g.entry, uncompSize: 2 ** 52 } }; // more than any disk has free
  await assert.rejects(unpackZipGames(zip, { games: [huge] }), (e) => e.status === 507 && e.code === 'diskFull' && /GB$/.test(e.vars.need) && /GB$/.test(e.vars.free));
  assert.ok(!existsSync(join(LIB, 'Pokemon X.3ds')));
  // the queue goes on after a failure
  assert.deepEqual(await unpackZipGames(zip), [join(LIB, 'Pokemon X.3ds')]);
  rmSync(join(LIB, 'Pokemon X.3ds'));
});

test('library scan: a zipped 3DS game in a library folder is offered for unpacking, then shows up once', async () => {
  const folder = mkdtempSync(join(ELSE, 'roms-'));
  const zip = join(folder, 'Pokemon X.zip');
  writeFileSync(zip, makeZip([{ name: 'Pokemon X.3ds', data: fakeGame() }]));
  const config = { libraryFolders: [folder] };
  let lib = scanLibrary(config);
  assert.equal(lib.roms.filter((r) => r.file === zip).length, 0, 'not on the shelf as a game that can’t be played');
  assert.equal(lib.zipped.length, 1);
  assert.deepEqual([lib.zipped[0].gameId, lib.zipped[0].system, lib.zipped[0].entry, lib.zipped[0].zipped], ['pokemon-x', '3ds', 'Pokemon X.3ds', true]);
  assert.equal(scanLibrary(config).zipped.length, 1, 'from the index cache too');
  const added = await unpackLibraryZip(lib.zipped[0].id, config);
  assert.deepEqual(added, [join(LIB, 'Pokemon X.3ds')]);
  assert.ok(existsSync(zip), 'the zip in the folder stays');
  lib = scanLibrary(config);
  assert.equal(lib.roms.filter((r) => r.gameId === 'pokemon-x').length, 1);
  assert.equal(lib.zipped.length, 0, 'unpacked already – not offered again');
  // only zips inside library folders
  await assert.rejects(unpackLibraryZip(`${join(HOME, 'Downloads', 'Pokemon X.zip')}::Pokemon X.3ds`, {}), (e) => e.status === 403);
  rmSync(join(LIB, 'Pokemon X.3ds'));
});

test('an index from before 2.7.0 is read again for 3DS games in zips', () => {
  const folder = mkdtempSync(join(ELSE, 'old-'));
  const zip = join(folder, 'Y.zip');
  writeFileSync(zip, makeZip([{ name: 'Pokemon Y.3ds', data: fakeGame(300000, { productCode: 'CTR-P-EK2A', titleId: '0004000000055E00' }) }]));
  const config = { libraryFolders: [folder] };
  assert.equal(scanLibrary(config).zipped.length, 1);
  const indexPath = join(DATA, 'library-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const v of Object.values(index)) if (v && v.ctr) delete v.ctr; // what 2.6.3 cached: roms / patches / notes only
  writeFileSync(indexPath, JSON.stringify(index));
  assert.equal(scanLibrary(config).zipped.length, 1);
});

test('"Search my Mac / PC" lists zipped 3DS games; importing them unpacks the game', async () => {
  const zip = join(HOME, 'Downloads', 'Pokemon X found.zip');
  writeFileSync(zip, makeZip([{ name: 'Pokemon X found.3ds', data: fakeGame() }], { zip64: true }));
  const { found } = discoverRoms({ roots: [join(HOME, 'Downloads')], known: [] });
  const f = found.find((x) => x.path === zip);
  assert.ok(f, 'found');
  assert.deepEqual([f.entry, f.system, f.gameId, f.zipped], ['Pokemon X found.3ds', '3ds', 'pokemon-x', true]);
  assert.deepEqual(await importFiles([f.path], {}, {}), [join(LIB, 'Pokemon X found.3ds')]);
  rmSync(join(LIB, 'Pokemon X found.3ds'));
});

test('upload: a zip with a 3DS game becomes the game in the library – no zip, no temp file left', async () => {
  const { server, url } = await startServer({ port: 0, background: false });
  try {
    const game = fakeGame();
    const res = await fetch(`${url}/api/library/upload?name=${encodeURIComponent('Pokemon X up.zip')}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: makeZip([{ name: 'Pokemon X up.3ds', data: game }]) });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).added, [join(LIB, 'Pokemon X up.3ds')]);
    assert.ok(readFileSync(join(LIB, 'Pokemon X up.3ds')).equals(game));
    assert.ok(!existsSync(join(LIB, 'Pokemon X up.zip')));
    assert.ok(noPartFiles(LIB));
    // a plain zip (GBA) is kept as it was
    const gba = Buffer.alloc(0x400);
    gba.write('POKEMON FIRE', 0xa0);
    const plain = await fetch(`${url}/api/library/upload?name=fire.zip`, { method: 'POST', headers: { 'x-soullink': '1' }, body: makeZip([{ name: 'fire.gba', data: gba }]) });
    assert.deepEqual((await plain.json()).added, [join(LIB, 'fire.zip')]);
    // a damaged one: the error, and nothing left
    const bad = await fetch(`${url}/api/library/upload?name=bad.zip`, { method: 'POST', headers: { 'x-soullink': '1' }, body: makeZip([{ name: 'Bad.3ds', data: game, crc: 7 }]) });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).code, 'zipDamaged');
    assert.ok(!existsSync(join(LIB, 'Bad.3ds')) && !existsSync(join(LIB, 'bad.zip')));
    assert.ok(noPartFiles(LIB));
    // a scan-found zipped game, unpacked from the page
    const folder = mkdtempSync(join(ELSE, 'srv-'));
    writeFileSync(join(folder, 'Z.zip'), makeZip([{ name: 'Pokemon Z.3ds', data: fakeGame(300000) }]));
    const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { grantPicked, clearPicked } = await import('../server/lib/grants.mjs');
    grantPicked([folder], { folder: true });
    assert.equal((await post('/api/library/folders', { add: folder })).status, 200);
    clearPicked();
    const lib = await (await fetch(`${url}/api/library`)).json();
    assert.equal(lib.zipped.length, 1);
    const un = await post('/api/library/unpack', { id: lib.zipped[0].id });
    assert.equal(un.status, 200);
    assert.deepEqual((await un.json()).added, [join(LIB, 'Pokemon Z.3ds')]);
    assert.equal((await (await fetch(`${url}/api/library`)).json()).zipped.length, 0);
    await post('/api/library/folders', { remove: folder });
  } finally {
    server.close();
  }
});

test('the progress toast while unpacking', () => {
  const start = unpackToast({ state: 'start', name: 'Pokemon X (Europe)', gameId: 'pokemon-x', size: 4 * 1024 ** 3, done: 0 }, catalog);
  assert.equal(start.key, 'unpack');
  assert.match(start.title, /^Unpacking Pok.mon X …$/);
  assert.match(start.text, /^0 % of 4\.0 GB/);
  const mid = unpackToast({ state: 'progress', name: 'Some Homebrew', gameId: null, size: 2 * 1024 ** 3, done: 1024 ** 3 }, catalog);
  assert.equal(mid.title, 'Unpacking Some Homebrew …');
  assert.match(mid.text, /^50 % of 2\.0 GB/);
  assert.deepEqual(unpackToast({ state: 'done' }, catalog), { key: 'unpack', remove: true });
  assert.deepEqual(unpackToast({ state: 'failed' }, catalog), { key: 'unpack', remove: true });
});

test('every new message has a German translation (and the other languages)', () => {
  const keys = ['lib.unpacking', 'lib.unpackingText', 'lib.zippedTitle', 'lib.zippedText', 'lib.unpack', 'lib.unpackBusy', 'lib.unpackFailed', 'disc.zipped',
    'err.diskFull', 'err.zipEntryUnsafe', 'err.zipDamaged', 'err.zipMethod', 'err.unpackFailed'];
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of keys) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
      // the same placeholders in every language
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
});
