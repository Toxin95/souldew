// "TM compatibility follows the new TM moves" (#81): the bridge's TmFollow on plain data and on a stand-in game
// (`SoulLinkBridge tmcompat <case.json>`), and the run pack format that keeps older versions from building another game.
// The bridge cases need the bundled Java runtime (npm run jre) and skip without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-tmfollow-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const { detectJava, UPR_JAR, runBridge } = await import('../server/lib/toolchain.mjs');
const canRunBridge = detectJava().ok && existsSync(UPR_JAR);
const skip = !canRunBridge && 'no Java / UPR here';

let n = 0;
async function bridgeCase(c) {
  const file = join(DATA, `case-${n++}.json`);
  writeFileSync(file, JSON.stringify(c));
  const res = await runBridge(['tmcompat', file], { timeoutMs: 60000 });
  return res.json;
}

// move numbers as in the games – only the numbers matter
const SEISMIC_TOSS = 69;
const MUDDY_WATER = 330;
const SURF = 57;
const ICICLE_SPEAR = 333;
const SHEER_COLD = 329;

test('a TM with a new move goes to the Pokémon that could learn that move – itself or as an earlier evolution', { skip }, async () => {
  // the issue's example: the Seismic Toss TM now teaches Muddy Water
  const r = await bridgeCase({
    newTms: [MUDDY_WATER],
    originalTms: [SEISMIC_TOSS],
    mons: [
      { own: [MUDDY_WATER], pre: [], types: ['WATER'], compat: [false] }, // learns it by level-up
      { own: [], pre: [0], types: ['WATER'], compat: [false] }, // its evolution
      { own: [], pre: [1], types: ['WATER'], compat: [false] }, // two stages on
      { own: [SEISMIC_TOSS], pre: [], types: ['FIGHTING'], compat: [true] }, // could use the old Seismic Toss TM
      { own: [SURF], pre: [], types: ['WATER'], compat: [false] }, // a Water type that never learns Muddy Water
    ],
  });
  assert.deepEqual(r.kinds, ['learnsets']);
  assert.deepEqual(r.compat.map((c) => c[0]), [true, true, true, false, false]);
  assert.deepEqual(r.learnable[2], [MUDDY_WATER], 'moves of every earlier stage');
});

test('an earlier evolution doesn\'t get the moves of what it evolves into; broken evolution loops end', { skip }, async () => {
  const r = await bridgeCase({
    newTms: [SURF],
    originalTms: [SEISMIC_TOSS],
    mons: [
      { own: [], pre: [], types: ['WATER'], compat: [true] },
      { own: [SURF], pre: [0], types: ['WATER'], compat: [true] },
      { own: [], pre: [3], types: ['NORMAL'], compat: [false] }, // 2 ← 3 ← 2: a loop in broken data
      { own: [SURF], pre: [2], types: ['NORMAL'], compat: [false] },
    ],
  });
  assert.deepEqual(r.compat.map((c) => c[0]), [false, true, true, true]);
});

test('TMs that kept their move stay exactly as they were', { skip }, async () => {
  const r = await bridgeCase({
    newTms: [SURF, MUDDY_WATER],
    originalTms: [SURF, SEISMIC_TOSS],
    mons: [
      { own: [], pre: [], types: ['FIRE'], compat: [true, false] }, // can't learn Surf by level-up, but had the TM
      { own: [SURF, MUDDY_WATER], pre: [], types: ['WATER'], compat: [false, true] }, // learns Surf by level-up, not by TM
    ],
  });
  assert.deepEqual(r.kinds, ['kept', 'learnsets']);
  assert.deepEqual(r.compat, [[true, false], [false, true]]);
});

test('a move no Pokémon could learn goes to the Pokémon of its type; with nobody of that type the TM keeps its old list', { skip }, async () => {
  const r = await bridgeCase({
    newTms: [ICICLE_SPEAR, SHEER_COLD],
    originalTms: [SEISMIC_TOSS, SURF],
    moveTypes: { [ICICLE_SPEAR]: 'ICE', [SHEER_COLD]: 'DRAGON' },
    mons: [
      { own: [SEISMIC_TOSS], pre: [], types: ['FIGHTING', null], compat: [true, false] },
      { own: [], pre: [], types: ['WATER', 'ICE'], compat: [false, true] },
      { own: [], pre: [], types: ['ICE', null], compat: [false, false] },
    ],
  });
  assert.deepEqual(r.kinds, ['type', 'original']);
  assert.deepEqual(r.compat, [[false, false], [true, true], [true, false]]);
});

test('on a stand-in game: TMs follow the original TM/HM, tutor and level-up data; HMs and other TMs stay', { skip }, async () => {
  const r = await bridgeCase({
    tmMoves: [SEISMIC_TOSS, SURF, 10],
    hmMoves: [15],
    tutorMoves: [ICICLE_SPEAR],
    newTms: [MUDDY_WATER, SURF, ICICLE_SPEAR],
    moveTypes: { [MUDDY_WATER]: 'WATER', [ICICLE_SPEAR]: 'ICE' },
    mons: [
      // TM: Seismic Toss, Surf, move 10, HM 15
      { types: ['WATER'], tm: [false, true, false, true], tutor: [false], levelUp: [MUDDY_WATER] },
      { types: ['WATER'], tm: [true, true, true, false], tutor: [true], levelUp: [], evolvesFrom: 0 },
      { types: ['FIGHTING'], tm: [true, false, true, true], tutor: [false], levelUp: [SEISMIC_TOSS] },
    ],
  });
  assert.deepEqual(r.compat, [
    [true, true, false, true], // Muddy Water by level-up; the HM untouched
    [true, true, true, false], // Muddy Water from its pre-evolution, Icicle Spear from the tutor
    [false, false, false, true], // lost the old Seismic Toss slot: Muddy Water is no move it ever learns
  ]);
  assert.match(r.report[0], /^TM01 MOVE330: 2 Pokémon \(could learn it\)$/);
  assert.match(r.report[1], /^TM02 MOVE57: 2 Pokémon \(move unchanged, kept\)$/);
  assert.match(r.report[2], /^TM03 MOVE333: 1 Pokémon \(could learn it\)$/);
});

test('on a stand-in game: with random or full compatibility the option does nothing (UPR replaces the table anyway)', { skip }, async () => {
  const r = await bridgeCase({
    tmMoves: [SEISMIC_TOSS], hmMoves: [], tutorMoves: [], newTms: [MUDDY_WATER], compatMod: 'FULL',
    mons: [{ types: ['WATER'], tm: [false], levelUp: [MUDDY_WATER] }, { types: ['FIGHTING'], tm: [true], levelUp: [] }],
  });
  assert.deepEqual(r.compat, [[false], [true]]);
  assert.match(r.report[0], /Not applied/);
});

test('a run with the option travels as run pack @4: 2.8.2 and older refuse it instead of building another game', async () => {
  const { runPack } = await import('../server/lib/build.mjs');
  const { PACK_FORMAT, PACK_FORMAT_TMS, PACK_FORMATS, TMS_MIN_VERSION, packFormatState } = await import('../shared/runpack.mjs');
  const { PACK_FORMATS: CODE_FORMATS } = await import('../web/lib/invitecode.mjs');
  const { TMS_FOLLOW_MOVES } = await import('../shared/randomizer-options.mjs');
  const m = { id: 'a1b2c3d4', name: 'Duo', room: 'r', secret: 's', players: {}, outputs: {} };
  const randomizer = (values, enabled = true) => ({ enabled, values, seeds: { p1: '1' }, sharedSeed: false });
  assert.equal(runPack({ ...m, randomizer: randomizer({ tmsMod: 'RANDOM' }) }).format, PACK_FORMAT, 'without it: older players can still join');
  const on = runPack({ ...m, randomizer: randomizer({ tmsMod: 'RANDOM', [TMS_FOLLOW_MOVES]: true }) });
  assert.deepEqual([on.format, on.minVersion], [PACK_FORMAT_TMS, '2.8.3']);
  assert.equal(TMS_MIN_VERSION, '2.8.3');
  // 2.8.2 reads @1–@3 only
  assert.ok(!['soullink-studio/run-pack@1', 'soullink-studio/run-pack@2', 'soullink-studio/run-pack@3'].includes(on.format));
  assert.equal(runPack({ ...m, randomizer: randomizer({ tmsMod: 'RANDOM', [TMS_FOLLOW_MOVES]: true }), shiny: { rate: 100, trainers: false } }).format, PACK_FORMAT_TMS,
    'with a shiny rate too (2.8.3 reads every rate)');
  assert.equal(runPack({ ...m, randomizer: randomizer({ [TMS_FOLLOW_MOVES]: true }, false) }).format, PACK_FORMAT, 'randomizer off: nothing to build differently');
  assert.ok(PACK_FORMATS.includes(PACK_FORMAT_TMS));
  assert.deepEqual(CODE_FORMATS, PACK_FORMATS, 'the code invite reads the same formats as the import route');
  assert.equal(packFormatState({ format: PACK_FORMAT_TMS }), 'ok');
});
