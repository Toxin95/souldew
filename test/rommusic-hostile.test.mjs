// 2.8.2 review of "music from the ROM" (3DS): damaged or hostile RomFS tables, sound archives and stream headers cost
// no more than a real game's (no hang, no gigabyte allocation – also in the sound worklet), a host that doesn't answer
// (paused, restarted, busy) is never taken for "no files" / "not music", an AAC track the worklet let go loads again,
// a track that can't be loaded hands the music back to the mixer, the calibration never blocks the page for long,
// old RomFS readers are let go, and an NCCH that claims a huge ExeFS hash region isn't read whole. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romfsFiles, romfsOfFile, MAX_NAME } from '../shared/ctr/romfs.mjs';
import { bcsarStreams, cstmInfo, cstmSane, adtsFrames, CSTM_MAX_BLOCK } from '../shared/ctr/streams.mjs';
import { musicIndex } from '../shared/ctr/musicindex.mjs';
import { RomMusicTracker, MAX_TAGS } from '../shared/ctr/rommusic.mjs';
import { RomVoice } from '../web/lib/romvoice.mjs';
import { TurboMixer } from '../web/lib/turboaudio.mjs';
import { RomMusic, AAC_PRIMING, bestLagSteps } from '../web/lib/rommusic.mjs';
import { ctrIntegrity } from '../server/lib/ctrcheck.mjs';
import { cciWithRomfs } from './fixtures/ctr.mjs';
import { makeCstm, makeAdts, rng } from './fixtures/rommusic.mjs';

const reader = (u8) => (o, n) => (o >= u8.length ? new Uint8Array(0) : u8.subarray(o, Math.min(u8.length, o + n)));
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const u32w = (b, o, v) => new DataView(b.buffer, b.byteOffset).setUint32(o, v >>> 0, true);

// ---- the RomFS tables ------------------------------------------------------------------------------------------------
test('RomFS: a file entry that links to itself with a huge name length is one file, its name cut – at once', () => {
  const dirs = new Uint8Array(0x18);
  u32w(dirs, 4, 0xffffffff);
  u32w(dirs, 8, 0xffffffff);
  u32w(dirs, 0x0c, 0);
  const files = new Uint8Array(4 * 1024 * 1024).fill(0x41);
  u32w(files, 4, 0); // next sibling: itself
  u32w(files, 0x1c, 0xffffffff); // name length: everything
  const t0 = performance.now();
  const out = romfsFiles({ data: 0 }, dirs, files);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(out.length, 1);
  assert.equal(out[0].path.length, MAX_NAME);
});

test('RomFS: directory lists that loop (a sibling to itself, two siblings to each other, a child to its parent) end', () => {
  const dirs = new Uint8Array(4 * 1024 * 1024).fill(0x41);
  const dir = (o, { sib = 0xffffffff, child = 0xffffffff, file = 0xffffffff, name = 0xffffffff }) => {
    u32w(dirs, o + 4, sib);
    u32w(dirs, o + 8, child);
    u32w(dirs, o + 0x0c, file);
    u32w(dirs, o + 0x14, name);
  };
  dir(0, { child: 0x100 });
  dir(0x100, { sib: 0x100, child: 0x200 }); // itself
  dir(0x200, { sib: 0x300, child: 0 }); // child: the root
  dir(0x300, { sib: 0x200, child: 0x100 }); // back to its sibling, child an ancestor
  const t0 = performance.now();
  const out = romfsFiles({ data: 0 }, dirs, new Uint8Array(0x20));
  assert.ok(performance.now() - t0 < 500, `${performance.now() - t0} ms`);
  assert.deepEqual(out, []);
});

test('RomFS: a real-looking tree still lists every file with its path', () => {
  const cci = cciWithRomfs({}, { 'a/b/c.bin': new Uint8Array(64), 'a/d.bin': new Uint8Array(64), 'e.bin': new Uint8Array(64) });
  const fs = romfsOfFile(reader(cci));
  assert.deepEqual(fs.files.map((f) => f.path).sort(), ['a/b/c.bin', 'a/d.bin', 'e.bin']);
});

// ---- the sound archive -----------------------------------------------------------------------------------------------
/** A BCSAR whose STRG table has `n` entries all pointing at one run of `run` bytes without a NUL. */
function hostileSar(n, run) {
  const strg = 0x40;
  const body = strg + 8;
  const t = body + 0x10;
  const strStart = t + 4 + n * 12;
  const info = strStart + run + 16;
  const b = new Uint8Array(info + 0x200);
  const v = new DataView(b.buffer);
  b.set([0x43, 0x53, 0x41, 0x52]);
  v.setUint16(4, 0xfeff, true);
  v.setUint16(0x10, 2, true);
  v.setUint16(0x14, 0x2000, true);
  v.setUint32(0x18, strg, true);
  v.setUint16(0x20, 0x2001, true);
  v.setUint32(0x24, info, true);
  b.set([0x53, 0x54, 0x52, 0x47], strg);
  v.setUint16(body, 0x2400, true);
  v.setUint32(body + 4, 0x10, true);
  v.setUint32(t, n, true);
  for (let i = 0; i < n; i++) {
    v.setUint32(t + 4 + i * 12 + 4, strStart - t, true);
    v.setUint32(t + 4 + i * 12 + 8, 0xffffffff, true);
  }
  b.fill(0x41, strStart, strStart + run);
  b.set([0x49, 0x4e, 0x46, 0x4f], info);
  const ib = info + 8;
  v.setUint16(ib, 0x2100, true);
  v.setUint32(ib + 4, 0x40, true);
  v.setUint16(ib + 8, 0x2106, true);
  v.setUint32(ib + 12, 0x50, true);
  return b;
}

test('BCSAR: 100 000 labels pointing at one 4 MB run without an end – bounded work, nothing found, no throw', () => {
  const b = hostileSar(100000, 4 * 1024 * 1024);
  const t0 = performance.now();
  const m = bcsarStreams(b);
  assert.ok(performance.now() - t0 < 1500, `${performance.now() - t0} ms`);
  assert.equal(m.size, 0);
});

/** A game file read through `readAt` without being there: zeros, with `parts` ([offset, bytes]) laid over them. */
function sparse(parts, size, count) {
  return (o, n) => {
    n = Math.max(0, Math.min(n, size - o));
    count.bytes += n;
    const out = new Uint8Array(n);
    for (const [at, b] of parts) {
      const s0 = Math.max(o, at);
      const e = Math.min(o + n, at + b.length);
      if (s0 < e) out.set(b.subarray(s0 - at, e - at), s0 - o);
    }
    return out;
  };
}

test('the server\'s music index: many files sharing one huge sound archive are read once', () => {
  // an NCCH whose RomFS lists N files that all point at the same 100 MB: a CSAR saying its STRG is 8 MB long
  const N = 300;
  const SIZE = 200 * 1024 * 1024;
  const h = new Uint8Array(0x200);
  h.set([0x4e, 0x43, 0x43, 0x48], 0x100);
  h[0x18f] = 4;
  u32w(h, 0x1b0, 0x1000 / 0x200);
  u32w(h, 0x1b4, 1);
  const ivfc = new Uint8Array(0x60);
  ivfc.set([0x49, 0x56, 0x46, 0x43]);
  u32w(ivfc, 0x08, 0x20);
  u32w(ivfc, 0x4c, 12);
  u32w(ivfc, 0x44, SIZE - 0x2000);
  const base = 0x2000;
  const dirs = new Uint8Array(0x18);
  u32w(dirs, 4, 0xffffffff);
  u32w(dirs, 8, 0xffffffff);
  u32w(dirs, 0x0c, 0);
  u32w(dirs, 0x10, 0xffffffff);
  const E = 0x24;
  const files = new Uint8Array(N * E);
  const fv = new DataView(files.buffer);
  for (let i = 0; i < N; i++) {
    const o = i * E;
    fv.setUint32(o + 4, i + 1 < N ? (i + 1) * E : 0xffffffff, true);
    fv.setBigUint64(o + 0x10, BigInt(100 * 1024 * 1024), true);
    fv.setUint32(o + 0x18, 0xffffffff, true);
    fv.setUint32(o + 0x1c, 2, true);
    files[o + 0x20] = 0x61;
  }
  const dataOff = 0x1000 + Math.ceil(files.length / 0x1000) * 0x1000;
  const l3 = new Uint8Array(0x28);
  u32w(l3, 0, 0x28);
  u32w(l3, 0x0c, 0x100);
  u32w(l3, 0x10, 0x18);
  u32w(l3, 0x1c, 0x1000);
  u32w(l3, 0x20, files.length);
  u32w(l3, 0x24, dataOff);
  const sar = new Uint8Array(0x40);
  sar.set([0x43, 0x53, 0x41, 0x52]);
  const sv = new DataView(sar.buffer);
  sv.setUint16(4, 0xfeff, true);
  sv.setUint16(0x10, 1, true);
  sv.setUint16(0x14, 0x2000, true);
  sv.setUint32(0x18, 0x40, true);
  sv.setUint32(0x1c, 8 * 1024 * 1024, true);
  const count = { bytes: 0 };
  const readAt = sparse([[0, h], [0x1000, ivfc], [base, l3], [base + 0x100, dirs], [base + 0x1000, files], [base + dataOff, sar]], SIZE, count);
  const t0 = performance.now();
  const index = musicIndex(readAt);
  assert.ok(index, 'an index');
  assert.equal(index.sig.split('-')[0], String(N));
  assert.ok(count.bytes < 32 * 1024 * 1024, `read ${count.bytes} bytes`);
  assert.ok(performance.now() - t0 < 2000);
});

// ---- BCSTM headers ---------------------------------------------------------------------------------------------------
/** A BCSTM with its stream info's field at `off` (from the stream info) set to `v`. */
function patchCstm(fields) {
  const { file } = makeCstm({});
  const f = file.slice();
  const good = cstmInfo(f);
  const v = new DataView(f.buffer);
  let si = -1;
  for (let o = 0; o < 0x200; o += 4) {
    if (v.getUint32(o + 0x14, true) === good.blockSize && v.getUint32(o + 0x18, true) === good.blockSamples && v.getUint32(o + 4, true) === good.rate) {
      si = o;
      break;
    }
  }
  assert.ok(si > 0);
  for (const [o, x] of Object.entries(fields)) v.setUint32(si + Number(o), x, true);
  return f;
}

test('BCSTM: sizes that don\'t fit the bytes are no stream (blockSamples, blockSize, last block, samples, file size)', () => {
  for (const fields of [
    { 0x18: 0x10000000, 0x0c: 0xf0000000 }, // blockSamples 268 M: 1 GB of samples per block
    { 0x18: 0xfffffff0 },
    { 0x14: CSTM_MAX_BLOCK * 2 }, // a block of 512 KB
    { 0x20: 14 * 64 + 14 }, // last block longer than a block
    { 0x0c: 14 * 64 * 6 + 1 }, // more samples than the blocks hold
    { 0x10: 100000 }, // blocks far beyond the file
  ]) {
    assert.equal(cstmInfo(patchCstm(fields)), null, JSON.stringify(fields));
  }
  // what the fixtures make (DSP, PCM16, mono, one block, no loop) is still taken
  for (const o of [{}, { format: 'pcm16' }, { channels: 1 }, { blocks: 1, lastSamples: 14 * 30 }, { loop: null }]) {
    const c = makeCstm(o);
    const info = cstmInfo(c.file);
    assert.ok(info, JSON.stringify(o));
    assert.ok(cstmSane(info, c.file.length));
    assert.equal(cstmSane(info, 0x100), false, 'a file shorter than its data');
  }
});

test('the sound worklet takes no track whose sizes are hostile – not even handed to it directly', () => {
  const c = makeCstm({});
  const info = cstmInfo(c.file);
  const v = new RomVoice(32728);
  assert.equal(v.add({ id: 'x', kind: 'cstm', file: c.file, info: { ...info, blockSamples: 0x10000000, samples: 0xf0000000 } }), false);
  assert.equal(v.add({ id: 'y', kind: 'cstm', file: c.file, info: { ...info, coefs: [] } }), false);
  assert.equal(v.add({ id: 'z', kind: 'cstm', file: c.file, info }), true);
  // the mixer, as the reviewer drove it: nothing allocated beyond the file
  const m = new TurboMixer(32728);
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'rom-track', id: 'x', kind: 'cstm', file: c.file, info: { ...info, blockSamples: 0x10000000, samples: 0xf0000000 } });
  m.command({ type: 'rom-sync', id: 'x', pos: 0, slow: true });
  const before = process.memoryUsage().arrayBuffers;
  const z = new Float32Array(128);
  for (let i = 0; i < 20; i++) m.process(z, z, new Float32Array(128), new Float32Array(128), 128);
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024);
});

// ---- ROMREAD: no answer is no fact -----------------------------------------------------------------------------------
/** A fake host answering ROMREADs from `l3` – `mode`: 'ok', 'none' (never answers), 'cant' (status 1), 'gone' (status 2). */
function fakeHost(l3) {
  const h = { mode: 'ok', sent: 0, rm: null };
  h.send = (payload) => {
    const v = new DataView(payload.buffer, payload.byteOffset);
    const id = v.getUint32(0, true);
    const off = Number(v.getBigUint64(8, true));
    const len = v.getUint32(16, true);
    h.sent++;
    const mode = h.mode;
    if (mode === 'none') return true;
    queueMicrotask(() => {
      const status = mode === 'cant' ? 1 : mode === 'gone' ? 2 : 0;
      const bytes = status ? new Uint8Array(0) : l3.subarray(off, Math.min(l3.length, off + len));
      const a = new Uint8Array(16 + bytes.length);
      const av = new DataView(a.buffer);
      av.setUint32(0, id, true);
      av.setUint32(4, status, true);
      av.setBigUint64(8, BigInt(status === 2 ? 0 : l3.length), true);
      a.set(bytes, 16);
      h.rm.onRomData(a);
    });
    return true;
  };
  return h;
}

const trackA = makeCstm({ seed: 1 });
const gameFiles = { 'zz/xq1.bin': trackA.file, 'a/0/1/2': new Uint8Array(4096).fill(7) };
function gameL3() {
  const cci = cciWithRomfs({}, gameFiles);
  const fs = romfsOfFile(reader(cci));
  return { fs, l3: cci.subarray(fs.base) };
}

test('ROMREAD: tables that get no answer (10 s) are asked again later – never "no files"; paused time doesn\'t count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fs, l3 } = gameL3();
  const host = fakeHost(l3);
  const logs = [];
  const rm = new RomMusic({ send: host.send, tell: () => {}, log: (e) => logs.push(e) });
  host.rm = rm;
  host.mode = 'none';
  for (const need of rm.tracker.reads([{ serial: 1, tag: 7, off: fs.files[0].start, len: 0x100, frame: 1 }])) rm.fetch(need);
  await flush();
  assert.equal(host.sent, 1);
  rm.pause(true); // (the host answers nothing while paused)
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(rm.tracker.tags.get(7).files, null, 'still asked, not given up');
  rm.pause(false);
  t.mock.timers.tick(10001);
  await flush();
  assert.equal(rm.tracker.tags.get(7).files, null, 'no answer is not "no files"');
  assert.ok(logs.some((e) => e.type === 'rom-retry' && e.where === 'files'));
  host.mode = 'ok';
  t.mock.timers.tick(1000); // (the first retry)
  await flush(10);
  assert.equal(rm.tracker.tags.get(7).files.length, 2);
});

test('ROMREAD: at most 8 out at once; unanswered or "can\'t" heads are retried, not "not music"; "gone" is final', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { l3 } = gameL3();
  const host = fakeHost(l3);
  const rm = new RomMusic({ send: host.send, tell: () => {}, log: () => {} });
  host.rm = rm;
  host.mode = 'none';
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `a/${i}`, start: i * 0x100, size: 0x100 }));
  rm.tracker.setFiles(3, files);
  for (const n of rm.tracker.reads(files.map((f, i) => ({ serial: i, tag: 3, off: f.start, len: 0x10, frame: 5 })))) rm.fetch(n);
  await flush();
  assert.equal(host.sent, 8, 'eight out, the rest wait');
  assert.ok(rm.waiting.size <= 8);
  t.mock.timers.tick(10001);
  await flush();
  const infos = rm.tracker.tags.get(3).infos;
  assert.equal([...infos.values()].filter((x) => x === null).length, 0, 'nothing is "not music" for lack of an answer');
  assert.equal(host.sent, 16);
  // "can't" (the host's queue was full): asked again too
  host.mode = 'cant';
  t.mock.timers.tick(10001);
  await flush(10);
  assert.equal([...infos.values()].filter((x) => x === null).length, 0);
  // the RomFS is gone: that one is final
  host.mode = 'gone';
  for (let i = 0; i < 40; i++) {
    t.mock.timers.tick(61000);
    await flush(4);
  }
  assert.equal([...infos.values()].filter((x) => x === null).length, 200);
});

test('ROMREAD: a new host gets what the old one never answered asked again at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fs, l3 } = gameL3();
  const host = fakeHost(l3);
  const rm = new RomMusic({ send: host.send, tell: () => {}, log: () => {} });
  host.rm = rm;
  host.mode = 'none';
  for (const need of rm.tracker.reads([{ serial: 1, tag: 1, off: fs.files[0].start, len: 0x100, frame: 1 }])) rm.fetch(need);
  await flush();
  host.mode = 'ok';
  rm.hostRestarted();
  await flush();
  t.mock.timers.tick(0); // (asked again right away – not after the 10 s, nor a backoff)
  await flush(10);
  assert.equal(rm.tracker.tags.get(1).files.length, 2);
});

// ---- an AAC track let go by the worklet, a track that can't be loaded --------------------------------------------------
test('an AAC track the worklet let go loads again (its bytes read anew); one that can\'t be loaded hands the music back', async (t) => {
  const SR = 48000;
  const bytes = makeAdts(Array.from({ length: 200 }, () => 300), { rate: SR });
  const frames = adtsFrames(bytes);
  const host = fakeHost(bytes); // (the stream file is level 3's first bytes here)
  const ctx = { sampleRate: SR, decodeAudioData: async () => ({ sampleRate: SR, length: frames.samples, numberOfChannels: 2, getChannelData: () => new Float32Array(frames.samples) }) };
  const told = [];
  const logs = [];
  const rm = new RomMusic({ send: host.send, tell: (m) => told.push(m), log: (e) => logs.push(e), ctx });
  host.rm = rm;
  let now = 0;
  rm.now = () => now;
  const info = { codec: 'adts', rate: SR, channels: 2, samples: frames.samples - AAC_PRIMING, priming: AAC_PRIMING, frames, loop: null, bytes };
  const p = { key: '1:0', tag: 1, file: { path: 'sound/bgm_a.aac', start: 0, size: bytes.length }, info, pos: 0, u: 0 };
  rm.tracker.playing = () => p;
  rm.sync(1);
  await flush();
  assert.equal(rm.tracks.get(p.key).state, 'ready');
  assert.equal(info.bytes, undefined, 'the bytes aren\'t kept after decoding');
  rm.missing(p.key); // (the worklet keeps three)
  rm.sync(2);
  await flush();
  assert.equal(rm.tracks.get(p.key).state, 'ready', 'loaded again');
  assert.equal(told.filter((m) => m.type === 'rom-track').length, 2);
  // the host stops answering: the load fails – the mixer is told to drop the ROM track (its own music takes over)
  t.mock.timers.enable({ apis: ['setTimeout'] });
  host.mode = 'none';
  rm.missing(p.key);
  rm.sync(3);
  await flush();
  t.mock.timers.tick(10001);
  await flush();
  assert.equal(rm.tracks.get(p.key).state, 'failed');
  assert.deepEqual(told.at(-1), { type: 'rom-sync', id: null, inband: true, drop: true });
  const n = told.length;
  rm.sync(4);
  assert.equal(told.length, n, 'told once');
  // later the host answers again: tried again after its backoff, and played
  host.mode = 'ok';
  now += 1001;
  rm.sync(5);
  await flush();
  assert.equal(rm.tracks.get(p.key).state, 'ready');
  assert.equal(told.at(-1).type, 'rom-sync');
  assert.equal(told.at(-1).id, p.key);
  assert.ok(logs.some((e) => e.type === 'rom-failed' && e.retryInMs === 1000));
});

test('the mixer: a dropped ROM track stops in fast-forward too (no other place\'s music), "no stream" alone doesn\'t', () => {
  const SR = 32728;
  const n = SR * 2;
  const l = new Int16Array(n).fill(1000);
  const m = new TurboMixer(SR);
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'rom-track', id: 'A', kind: 'pcm', l, r: l.slice(), rate: SR, loop: null });
  m.command({ type: 'rom-sync', id: 'A', pos: 100, slow: true });
  m.command({ type: 'speed', ratio: 4 });
  const z = new Float32Array(128);
  for (let i = 0; i < 10; i++) m.process(z, z, new Float32Array(128), new Float32Array(128), 128);
  assert.equal(m.rom.id, 'A');
  m.command({ type: 'rom-sync', id: null, inband: true });
  assert.equal(m.rom.id, 'A', '"Music continues" while fast-forwarding');
  m.command({ type: 'rom-sync', id: null, inband: true, drop: true });
  assert.equal(m.rom.id, null);
});

// ---- the calibration: sliced, backing off ----------------------------------------------------------------------------
test('calibration: no slice of the work takes long; a track that never matches backs off and stops after its tries', async () => {
  const SR = 48000;
  const rm = new RomMusic({ send: () => true, tell: () => {}, rate: SR });
  const r = rng(5);
  const len = SR * 60;
  const l = new Int16Array(len);
  for (let i = 0; i < len; i++) l[i] = Math.round((r() - 0.5) * 60000);
  const t = { pcm: { l, r: l }, loop: null, ratio: 1, voicePos: (x) => x };
  for (let i = 0; i < SR * 4; i++) rm.game.l[i] = Math.sin(i * 0.05) * 0.3;
  rm.game.at = SR * 4;
  rm.game.frameAt = SR * 4;
  const p = { key: '1:7', pos: SR * 20, u: SR * 20, info: { codec: 'cstm', rate: SR } };
  // every step between two yields is short (the slices are ~6 ms of them) – one outlier allowed (a GC pause isn't ours)
  const steps = [];
  for (const opts of [{ range: 0.8 }, { range: 3.5, win: 2.5, decim: 32, margin: true }]) {
    const gen = rm.calibrateSteps(p, t, opts);
    for (;;) {
      const t0 = performance.now();
      const x = gen.next();
      steps.push(performance.now() - t0);
      if (x.done) break;
    }
  }
  // (on a busy machine – the whole suite runs files side by side – everything takes longer: then no step may be more
  // than a twentieth of the whole)
  const total = steps.reduce((x, y) => x + y, 0);
  steps.sort((x, y) => y - x);
  assert.ok(steps.length > 50 && (steps[1] < 8 || steps[1] < total / 20), `longest steps ${steps.slice(0, 3).map((x) => x.toFixed(1)).join(', ')} of ${total.toFixed(0)} ms`);
  // the same result as all at once
  const a = rm.calibrate(p, t, { range: 0.4 });
  const b = await rm.sliced(rm.calibrateSteps(p, t, { range: 0.4 }));
  assert.deepEqual(a, b);
  // never taken: each try waits longer, and the track stops being measured
  rm.tracker.cur = { anchor: { guess: true } };
  const waits = [];
  for (let i = 0; i < 30; i++) {
    const c = rm.cal.get('cstm');
    if (c) c.next = 0;
    rm.maybeCalibrate(p, t);
    if (rm.calJob) await rm.calJob;
    waits.push(rm.cal.get('cstm').next - performance.now());
  }
  assert.equal(rm.calTracks.get('1:7').tries, 16);
  assert.ok(waits[0] > 5000 && waits[3] > 40000, waits.slice(0, 4).map(Math.round).join(' '));
});

test('bestLagSteps finds the same lag as a plain search', () => {
  const r = rng(9);
  const b = new Float32Array(20000);
  let x = 0;
  for (let i = 0; i < b.length; i++) b[i] = x = x * 0.9 + (r() - 0.5);
  const a = b.slice(7321, 7321 + 4000);
  const gen = bestLagSteps(a, b, 8, 0);
  let res;
  while (!(res = gen.next()).done);
  assert.equal(res.value.lag, 7321);
  assert.ok(res.value.score > 0.999);
});

// ---- old RomFS readers are let go ------------------------------------------------------------------------------------
test('RomFS readers: after resets only the latest tags are kept (and what the page kept for the others goes too)', async () => {
  const { fs, l3 } = gameL3();
  const host = fakeHost(l3);
  const rm = new RomMusic({ send: host.send, tell: () => {}, log: () => {} });
  host.rm = rm;
  for (let tag = 1; tag <= 30; tag++) {
    rm.sars.set(tag, Promise.resolve(new Map()));
    rm.streamRanges.set(tag, new Map([[0, 1]]));
    for (const need of rm.tracker.reads([{ serial: tag, tag, off: fs.files[1].start, len: 0x100, frame: tag * 1000 }])) await rm.fetch(need);
    await flush();
    rm.cut();
  }
  assert.ok(rm.tracker.tags.size <= MAX_TAGS, `${rm.tracker.tags.size} tags`);
  assert.deepEqual([...rm.sars.keys()].sort(), [...rm.tracker.tags.keys()].sort());
  assert.deepEqual([...rm.streamRanges.keys()].sort(), [...rm.tracker.tags.keys()].sort());
});

test('RomFS readers: tags read at the same time stay (up to four), the playing music\'s tag always', () => {
  const tr = new RomMusicTracker();
  const files = [{ path: 'x', start: 0, size: 0x1000 }];
  for (let tag = 1; tag <= 3; tag++) tr.setFiles(tag, files);
  for (let f = 0; f < 100; f++) tr.reads([1, 2, 3].map((tag) => ({ serial: f, tag, off: 0, len: 4, frame: f })));
  assert.equal(tr.tags.size, 3, 'all three are being read');
  for (let f = 100; f < 200; f++) tr.reads([1, 2, 3, 4, 5, 6].map((tag) => ({ serial: f, tag, off: 0, len: 4, frame: f })));
  assert.ok(tr.tags.size <= 4);
  // the playing stream's tag stays however long it isn't read
  const t2 = new RomMusicTracker();
  for (const tag of [9, 20, 21]) t2.setFiles(tag, files);
  t2.tags.get(9).last = 0;
  t2.frame = 100000;
  t2.tags.get(20).last = 99990;
  t2.tags.get(21).last = 100000;
  t2.cur = { tag: 9 };
  t2.prune();
  assert.ok(t2.tags.has(9) && t2.tags.has(21));
  t2.cur = null;
  t2.prune();
  assert.deepEqual([...t2.tags.keys()].sort((a, b) => a - b), [20, 21]);
});

// ---- the integrity check ---------------------------------------------------------------------------------------------
test('3DS integrity: an ExeFS hash region of almost the whole file is left unchecked – never read and hashed whole', () => {
  const SIZE = 1024 * 1024 * 1024;
  const h = new Uint8Array(0x200);
  h.set([0x4e, 0x43, 0x43, 0x48], 0x100);
  h[0x18f] = 0x04; // NoCrypto
  u32w(h, 0x1a0, 1);
  u32w(h, 0x1a4, 0x1000);
  u32w(h, 0x1a8, (SIZE - 0x400) / 0x200);
  let biggest = 0;
  const readAt = (o, n) => {
    biggest = Math.max(biggest, n);
    return o === 0 ? h : new Uint8Array(Math.min(n, 0x200));
  };
  const r = ctrIntegrity(readAt, SIZE, () => '00');
  assert.ok(biggest <= 1024 * 1024, `read ${biggest} bytes at once`);
  assert.notEqual(r.state, 'damaged');
});
