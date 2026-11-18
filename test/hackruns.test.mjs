// A ROM hack picked on its library page must reach the run (#68: Library › Volt White › New Nuzlocke built plain
// White). The wizard's hack picker used to drop every patch whose CRC32 differed from the ROM's – also when that CRC32
// was only the catalog's or a readme's word for an xdelta patch, while the hack's Play button patched the same ROM fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
const { patchFits, patchDiag } = await import('../web/lib/data.mjs');

const cat = {
  games: [{ id: 'pokemon-white' }, { id: 'pokemon-white-de', variantOf: 'pokemon-white' }, { id: 'pokemon-black' }, { id: 'pokemon-emerald' }],
  hacks: [{ id: 'volt-white', baseGameId: 'pokemon-white' }, { id: 'run-and-bun', baseGameId: 'pokemon-emerald' }],
};
const fits = (patch, r) => patchFits(patch, r, cat);
const rom = (gameId, crc, more = {}) => ({ id: `${gameId}-${crc}`, gameId, crc, ...more });
const volt = { id: 'vw', name: 'Volt White.xdelta', format: 'xdelta', hackId: 'volt-white', expectedCrc: 'B552501C' };

test('#68: an xdelta patch of a catalog hack goes with any copy of its base game, not only the CRC32 it names (IPS doesn\'t)', () => {
  assert.ok(fits(volt, rom('pokemon-white', 'B552501C', { exact: true })), 'the named copy');
  assert.ok(fits(volt, rom('pokemon-white', '0BADC0DE')), 'another dump of White (the reporter\'s case)');
  assert.ok(fits(volt, rom('pokemon-white-de', '12345678')), 'a release that is a variant of White');
  // IPS checks nothing it writes (another language's copy would give a broken game): it keeps the CRC32 it names
  const ips = { ...volt, format: 'ips' };
  assert.ok(!fits(ips, rom('pokemon-white', '0BADC0DE')), 'an IPS patch: not another dump');
  assert.ok(!fits(ips, rom('pokemon-white-de', '12345678')), 'an IPS patch: not another language');
  assert.ok(fits(ips, rom('pokemon-white', 'B552501C')), 'an IPS patch: the copy it names');
  assert.ok(fits({ ...ips, expectedCrc: null }, rom('pokemon-white', '0BADC0DE')), 'an IPS patch that names no copy: as before');
  assert.ok(!fits({ ...volt, format: null }, rom('pokemon-white', '0BADC0DE')), 'a patch of unknown format: only its copy');
  assert.ok(!fits(volt, rom('pokemon-black', '4F6E5580')), 'not another game');
  assert.ok(!fits(volt, rom(null, '0BADC0DE')), 'not a ROM of no known game');
  assert.ok(!fits(volt, rom('pokemon-white', '0BADC0DE', { hackId: 'volt-white' })), 'not a ROM that is a hack already');
  assert.ok(!fits(volt, rom('pokemon-white', '0BADC0DE', { customHack: 'Something' })), 'not a ROM marked as another hack');
  assert.ok(!fits(volt, null) && !fits(null, rom('pokemon-white', 'B552501C')));
});

test('a BPS/UPS patch names its ROM itself: only that one; patches of unknown hacks keep their CRC32; none named: any ROM', () => {
  const rnb = { id: 'rnb', format: 'bps', hackId: 'run-and-bun', expectedCrc: '1F1C08FB' };
  assert.ok(fits(rnb, rom('pokemon-emerald', '1F1C08FB')));
  assert.ok(!fits(rnb, rom('pokemon-emerald', 'E3A55C6A')), 'the patcher would refuse another copy');
  assert.ok(!fits({ ...rnb, format: 'ups' }, rom('pokemon-emerald', 'E3A55C6A')));
  const own = { id: 'own', format: 'xdelta', hackId: null, expectedCrc: 'B552501C' }; // a readme's CRC32, no catalog base game
  assert.ok(fits(own, rom('pokemon-white', 'B552501C')));
  assert.ok(!fits(own, rom('pokemon-white', '0BADC0DE')));
  const noCrc = { id: 'rp', format: 'xdelta', hackId: 'volt-white', expectedCrc: null };
  assert.ok(fits(noCrc, rom('pokemon-black', '4F6E5580')), 'as before: a patch that names no ROM is offered for every ROM');
});

test('the wizard\'s hack picker and the hack page use that rule, and the wizard says when the hack can\'t be used', () => {
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  const choices = wizard.slice(wizard.indexOf('function useGameChoices'), wizard.indexOf('function ShapeCards'));
  assert.match(choices, /filter\(\(p\) => patchFits\(p, rom, cat\)\)/);
  assert.doesNotMatch(choices, /p\.expectedCrc === rom\.crc/);
  assert.match(choices, /hackMissing: \(rom\) =>/);
  const run = wizard.slice(wizard.indexOf('function NewRun('), wizard.indexOf('/** Invite input'));
  assert.match(run, /const missing = !patchId \? hackMissing\(rom\) : null;/);
  assert.match(run, /\$\{missing && html`<p class="warning">\$\{t\('new\.hackNoFit'/);
  const library = readFileSync(new URL('../web/views/library.mjs', import.meta.url), 'utf8');
  const detail = library.slice(library.indexOf('function HackDetail'), library.indexOf('export function ownPatchCards'));
  assert.match(detail, /const canPatch = !!\(patch && baseRom && patchFits\(patch, baseRom, cat\)\);/);
});

test('the new message is translated (no placeholder lost)', () => {
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['new.hackNoFit']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
});

test('the randomizer\'s diagnostics name a patch by its hack, format and checksum – never by its id (an absolute path)', () => {
  const p = { id: '/Users/anna maria/Library/Hacks/Volt White.xdelta', file: '/Users/anna maria/Library/Hacks/Volt White.xdelta', name: 'Volt White', format: 'xdelta', hackId: 'volt-white', sha1: 'ab'.repeat(20) };
  assert.deepEqual(patchDiag(p), { hack: 'volt-white', format: 'xdelta', sha1: 'ab'.repeat(20) });
  assert.ok(!JSON.stringify(patchDiag(p)).includes('anna'));
  assert.equal(patchDiag(undefined), null);
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  const call = wizard.match(/diag\('rando', \{[^\n]*\}\);/)?.[0] || '';
  assert.match(call, /patch: patchDiag\(/);
  assert.doesNotMatch(call, /patch: patchId/);
});
