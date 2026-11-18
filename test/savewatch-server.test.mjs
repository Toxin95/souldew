// melonDS and a Platinum run, end to end on the server (2.8.2, a player's report on Discord: the team didn't update
// after saving in melonDS). Only HeartGold/SoulSilver runs ever had their save watched, so a save melonDS wrote for
// any other DS game went unread. Its own file: the server reads its data folder once, and this one starts empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { encryptPK4, crc16ccitt } from '../shared/gen4save.mjs';

const root = mkdtempSync(join(tmpdir(), 'sls-savewatch-'));
process.env.SLS_DATA_DIR = root;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

function pk({ pid, species, level = 6, met = 16 }) {
  const d = new Uint8Array(236);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, 50953, true);
  dv.setUint16(0x0e, 35290, true);
  dv.setUint16(0x46, met, true);
  d[0x84] = 5;
  d[0x8c] = level;
  dv.setUint16(0x8e, 20, true);
  dv.setUint16(0x90, 21, true);
  return encryptPK4(d);
}
/** A Platinum save holding `party` (PKHeX SAV4Pt: the general block 0xCF2C bytes, the party at 0xA0). */
function platinumSave(party, count) {
  const u8 = new Uint8Array(0x80000).fill(0xff);
  const dv = new DataView(u8.buffer);
  u8.fill(0, 0, 0xcf2c);
  dv.setUint16(0x78, 50953, true);
  dv.setUint16(0x7a, 35290, true);
  dv.setUint32(0x98, 6, true);
  dv.setUint32(0x9c, party.length, true);
  party.forEach((m, i) => u8.set(pk(m), 0xa0 + i * 236));
  const end = 0xcf2c;
  dv.setUint32(end - 0x10, count, true);
  dv.setUint32(end - 0x0c, 0xcf2c, true);
  dv.setUint32(end - 0x08, 0x20060623, true);
  dv.setUint16(end - 0x02, crc16ccitt(u8, 0, end - 0x14), true);
  return u8;
}

function sse(url) {
  const events = [];
  const req = request(url, { headers: { accept: 'text/event-stream', 'x-soullink': '1' } });
  let buf = '';
  req.on('response', (res) => {
    if (res.statusCode !== 200) events.push({ ev: 'status', data: res.statusCode });
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(data) });
      }
    });
  });
  req.end();
  const next = async (ev, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const at = events.findIndex((x) => x.ev === ev);
      if (at >= 0) return events.splice(at, 1)[0].data;
      if (Date.now() > end) throw new Error(`no ${ev} event: ${JSON.stringify(events).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { next, close: () => req.destroy() };
}

test('server: a Platinum run\'s save is watched – the built-in player\'s and melonDS\'s writes reach the page; the play view learns which file and when', async () => {
  const id = 'ab12cd34';
  const dir = join(root, 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id, name: 'Pt', mode: 'soullink', createdAt: '2026-11-17T10:00:00Z',
    players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, outputs: { p1: { rom: 'p1.nds' } } }));
  writeFileSync(join(dir, 'p1.nds'), new Uint8Array(512));
  const { server, url } = await startServer({ port: 0, background: false });
  const events = sse(`${url}/api/events`);
  const H = { 'x-soullink': '1' };
  try {
    let st = await (await fetch(`${url}/api/runs/${id}/watch`)).json();
    assert.equal(st.watching, false);
    assert.equal(st.readable, true, 'Platinum saves are read now');
    assert.equal(st.graveyard, false, 'only HeartGold/SoulSilver saves are edited');
    // the built-in player stores the in-game save: the run's save is watched from now on
    const put = await fetch(`${url}/api/runs/${id}/save/p1`, { method: 'PUT', headers: { ...H, 'content-type': 'application/octet-stream' }, body: platinumSave([{ pid: 1, species: 390 }], 1) });
    assert.equal(put.status, 200);
    let ev = await events.next('save');
    assert.equal(ev.runId, id);
    assert.deepEqual(ev.save.party.map((m) => m.species), [390]);
    st = await (await fetch(`${url}/api/runs/${id}/watch`)).json();
    assert.equal(st.watching, true);
    assert.equal(st.path, join(dir, 'p1.sav'));
    assert.ok(st.readAt && st.exists && !st.error);
    assert.ok(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).watches[id], 'remembered for the next start');
    // melonDS saves next to the ROM, rewriting the file in place: the new team reaches the page
    writeFileSync(join(dir, 'p1.sav'), platinumSave([{ pid: 1, species: 390 }, { pid: 2, species: 399, level: 3, met: 17 }], 2));
    ev = await events.next('save');
    assert.deepEqual(ev.save.party.map((m) => [m.species, m.metLocation]), [[390, 16], [399, 17]]);
    // the run page's manifest says the same
    const m = await (await fetch(`${url}/api/runs/${id}`, { headers: H })).json();
    assert.equal(m.watch.watching, true);
    assert.equal(m.watch.graveyard, false);
  } finally {
    // (the watch polls the file: unwatch, or the test process never ends)
    await fetch(`${url}/api/runs/${id}/watch`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ path: '' }) });
    events.close();
    server.closeAllConnections();
    server.close();
  }
});
