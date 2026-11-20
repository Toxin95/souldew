// What a Pokémon's summary screen shows beyond its level and moves – nature, ability, IVs and EVs (Game Boy: DVs and
// stat experience) – read from the party data the live readers already decrypt (shared/live/parse.mjs, gen67.mjs,
// shared/gen4save.mjs), its Hidden Power worked out from them, and the Pokémon as a Pokémon Showdown set for damage
// calculators. Only what was read: a field the game's data doesn't hold (no nature before Gen 3, no ability in the
// Game Boy games) or a value out of range is left out, never guessed.
//
// Stats are kept in Showdown's order – HP, Atk, Def, SpA, SpD, Spe. The games' own order (Gen 3+ IV word and EV bytes)
// is HP, Atk, Def, Spe, SpA, SpD; Game Boy: HP, Atk, Def, Spe, Special.

/** Showdown's stat names, in the order `ivs` / `evs` are kept. */
export const SD_STATS = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];

/** The last ability number of each generation's games (Gen 3: Air Lock … Gen 7: Neuroforce – PokeAPI numbers them alike). */
export const GEN_MAX_ABILITY = [0, 0, 0, 76, 123, 164, 191, 233];

/** Hidden Power's types by the number its formula gives (Gen 2–7). */
export const HP_TYPES = ['fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];

/** The stat a nature raises and lowers (1 Atk … 5 Spe in Showdown's order; the same one twice: neutral). */
const NATURE_STATS = [
  [1, 1], [1, 2], [1, 5], [1, 3], [1, 4], [2, 1], [2, 2], [2, 5], [2, 3], [2, 4], [5, 1], [5, 2], [5, 5], [5, 3], [5, 4],
  [3, 1], [3, 2], [3, 5], [3, 3], [3, 4], [4, 1], [4, 2], [4, 5], [4, 3], [4, 4],
];

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The games' order (HP, Atk, Def, Spe, SpA, SpD) → Showdown's (HP, Atk, Def, SpA, SpD, Spe). */
export const fromGameOrder = (a) => [a[0], a[1], a[2], a[4], a[5], a[3]];

/** The IVs of a Gen 3–7 IV word (5 bits each from bit 0: HP, Atk, Def, Spe, SpA, SpD) in Showdown's order. */
export const ivsOfWord = (w) => fromGameOrder([0, 5, 10, 15, 20, 25].map((s) => (w >>> s) & 31));

/** { up, down } of a nature (indices into SD_STATS), or null for a neutral one. */
export function natureEffect(n) {
  const e = NATURE_STATS[n];
  return e && e[0] !== e[1] ? { up: e[0], down: e[1] } : null;
}

/**
 * Game Boy party struct (pokered party_struct: stat exp. at +0x11, DVs at +0x1B; pokecrystal: stat exp. at +0x0B, DVs
 * at +0x15): DVs 0–15 as [HP, Atk, Def, Spe, Special] – the HP DV is made of the low bits of the other four, as the game
 * makes it – and stat experience 0–65535 in the same order (big-endian words).
 */
export function summaryGB(d, gen) {
  const se = gen === 1 ? 0x11 : 0x0b;
  const dv = gen === 1 ? 0x1b : 0x15;
  if (!d || d.length < dv + 2) return null;
  const atk = d[dv] >> 4;
  const def = d[dv] & 15;
  const spe = d[dv + 1] >> 4;
  const spc = d[dv + 1] & 15;
  const hp = ((atk & 1) << 3) | ((def & 1) << 2) | ((spe & 1) << 1) | (spc & 1);
  return { dvs: [hp, atk, def, spe, spc], statExp: [0, 1, 2, 3, 4].map((i) => (d[se + 2 * i] << 8) | d[se + 2 * i + 1]) };
}

/**
 * Gen 3 (retail engine): the nature is the personality value mod 25, the IVs and the ability slot (bit 31) are in the
 * Misc substructure's IV word, the EVs the EV substructure's first six bytes. `ability(slot)` → the ability the game
 * gives this species in that slot (the ROM's base stats – shared/live/romtypes.mjs gbaAbilities), { id, name? } or null.
 */
export function summaryPk3(pid, ivWord, evBytes, ability = null) {
  const out = { nature: pid % 25, ivs: ivsOfWord(ivWord), evs: fromGameOrder(Array.from(evBytes.subarray(0, 6))) };
  const a = ability ? ability(ivWord >>> 31) : null;
  if (a?.id) Object.assign(out, { ability: a.id }, a.name ? { abilityName: a.name } : {});
  return out;
}

/**
 * Gen 4/5 decrypted PK4/PK5 (PKHeX): ability +0x15, EVs +0x18–0x1D, IVs +0x38, Gen 5's nature byte +0x41 (Gen 4: the
 * personality value mod 25 – no nature of its own before Gen 5, no mints before Gen 8).
 */
export function summaryPk45(d, gen) {
  const nature = gen === 5 ? d[0x41] : u32(d, 0) % 25;
  return withAbility({ ...(nature < 25 ? { nature } : {}), ivs: ivsOfWord(u32(d, 0x38)), evs: fromGameOrder(Array.from(d.subarray(0x18, 0x1e))) }, d[0x15], gen);
}

/** Gen 6/7 decrypted PK6/PK7 (PKHeX): ability +0x14, nature +0x1C, EVs +0x1E–0x23, IVs +0x74. */
export function summaryPk67(d, gen) {
  const nature = d[0x1c];
  return withAbility({ ...(nature < 25 ? { nature } : {}), ivs: ivsOfWord(u32(d, 0x74)), evs: fromGameOrder(Array.from(d.subarray(0x1e, 0x24))) }, d[0x14], gen);
}

/** An ability number the generation has (a hack's own one beyond them has no name here: left out). */
function withAbility(out, id, gen) {
  if (id >= 1 && id <= (GEN_MAX_ABILITY[gen] || 0)) out.ability = id;
  return out;
}

/**
 * A summary as it may be stored and shown: only fields of the right shape and range (the run doc syncs between
 * computers – a partner's older or broken app must not show garbage). → the cleaned summary or null.
 */
export function cleanSummary(s) {
  if (!s || typeof s !== 'object') return null;
  const nums = (a, n, max) => (Array.isArray(a) && a.length === n && a.every((v) => Number.isInteger(v) && v >= 0 && v <= max) ? a.slice() : null);
  const out = {};
  if (Number.isInteger(s.nature) && s.nature >= 0 && s.nature < 25) out.nature = s.nature;
  if (Number.isInteger(s.ability) && s.ability > 0 && s.ability < 1024) {
    out.ability = s.ability;
    if (typeof s.abilityName === 'string' && s.abilityName.trim()) out.abilityName = s.abilityName.trim().slice(0, 20);
  }
  const ivs = nums(s.ivs, 6, 31);
  const evs = nums(s.evs, 6, 255);
  const dvs = nums(s.dvs, 5, 15);
  const statExp = nums(s.statExp, 5, 65535);
  if (ivs) out.ivs = ivs;
  if (evs) out.evs = evs;
  if (dvs) out.dvs = dvs;
  if (statExp) out.statExp = statExp;
  return Object.keys(out).length ? out : null;
}

/**
 * Hidden Power: { type, power } – Gen 2 from the DVs (power 31–70), Gen 3–5 from the IVs (power 30–70), Gen 6/7 from the
 * IVs with power 60 always. null in Gen 1 (no Hidden Power) or without the numbers it needs.
 */
export function hiddenPower(s, gen) {
  if (gen === 2) {
    if (!s?.dvs) return null;
    const [, atk, def, spe, spc] = s.dvs;
    const top = (spc >> 3) + 2 * (spe >> 3) + 4 * (def >> 3) + 8 * (atk >> 3);
    return { type: HP_TYPES[((atk & 3) << 2) | (def & 3)], power: Math.floor((5 * top + (spc & 3)) / 2) + 31 };
  }
  if (!(gen >= 3) || !s?.ivs) return null;
  const [hp, atk, def, spa, spd, spe] = s.ivs;
  const bits = (k) => ((hp >> k) & 1) + 2 * ((atk >> k) & 1) + 4 * ((def >> k) & 1) + 8 * ((spe >> k) & 1) + 16 * ((spa >> k) & 1) + 32 * ((spd >> k) & 1);
  return { type: HP_TYPES[Math.floor((bits(0) * 15) / 63)], power: gen >= 6 ? 60 : Math.floor((bits(1) * 40) / 63) + 30 };
}

/** The sum of the EVs (Gen 3+: at most 510 in the games). */
export const evTotal = (s) => (s?.evs ? s.evs.reduce((a, b) => a + b, 0) : null);

// ---------------------------------------------------------------------------------------------------------------------
// Pokémon Showdown export (the text format Showdown's teambuilder and the damage calculators import)

const HIDDEN_POWER = 237;

/**
 * Showdown's name for an alternate form (species → [form number → suffix]): forms that change stats, types or the
 * ability. A form not listed (Unown's letters, Shellos's sea, Vivillon's patterns …) only looks different – the species'
 * own name is right for it.
 */
const SD_FORMS = {
  386: ['', 'Attack', 'Defense', 'Speed'], 413: ['', 'Sandy', 'Trash'], 492: ['', 'Sky'], 487: ['', 'Origin'],
  479: ['', 'Heat', 'Wash', 'Frost', 'Fan', 'Mow'], 351: ['', 'Sunny', 'Rainy', 'Snowy'], 550: ['', 'Blue-Striped'],
  555: ['', 'Zen'], 648: ['', 'Pirouette'], 641: ['', 'Therian'], 642: ['', 'Therian'], 645: ['', 'Therian'],
  646: ['', 'White', 'Black'], 647: ['', 'Resolute'], 678: ['', 'F'], 710: ['', 'Small', 'Large', 'Super'],
  711: ['', 'Small', 'Large', 'Super'], 720: ['', 'Unbound'], 741: ['', 'Pom-Pom', 'Pa\'u', 'Sensu'],
  745: ['', 'Midnight', 'Dusk'], 800: ['', 'Dusk-Mane', 'Dawn-Wings', 'Ultra'], 718: ['', '10%', '10%', '', 'Complete'],
  658: ['', 'Bond', 'Ash'], 670: ['', '', '', '', '', 'Eternal'],
  // the forms a battle changes (a Pokémon read mid-battle)
  681: ['', 'Blade'], 746: ['', 'School'], 778: ['', 'Busted', '', 'Busted'], 774: ['Meteor', 'Meteor', 'Meteor', 'Meteor', 'Meteor', 'Meteor', 'Meteor'],
  // Mega Evolutions (form 1; Charizard and Mewtwo: X 1, Y 2) and Primal Reversion
  ...Object.fromEntries([3, 9, 15, 18, 65, 80, 94, 115, 127, 130, 142, 181, 208, 212, 214, 229, 248, 254, 257, 260, 282, 302, 303, 306,
    308, 310, 319, 323, 334, 354, 359, 362, 373, 376, 380, 381, 384, 428, 445, 448, 460, 475, 531, 719].map((id) => [id, ['', 'Mega']])),
  6: ['', 'Mega-X', 'Mega-Y'], 150: ['', 'Mega-X', 'Mega-Y'], 382: ['', 'Primal'], 383: ['', 'Primal'],
  // Alolan forms (Sun/Moon, Ultra Sun/Ultra Moon: form 1)
  ...Object.fromEntries([19, 20, 26, 27, 28, 37, 38, 50, 51, 52, 53, 74, 75, 76, 88, 89, 103, 105].map((id) => [id, ['', 'Alola']])),
};

/** Showdown spells a few names its own way. */
const sdSpecies = (name) => name.replace(/♀$/, '-F').replace(/♂$/, '-M');

const sdType = (k) => (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');

/**
 * The Pokémon as a Showdown set. `mon`: the run's live party shape (web/lib/run.mjs liveMon: species, nick, level,
 * gender, shiny, form, moves, summary); `gen`: the run's generation; `N`: names in English – { species(id) , item(mon),
 * move(id), ability(summary), nature(n) } → '' when unknown (a line without a name is left out).
 */
export function showdownSet(mon, gen, N) {
  if (!mon?.species) return '';
  const s = cleanSummary(mon.summary) || {};
  const raw = N.species(mon.species) || '';
  const base = sdSpecies(raw);
  if (!base) return '';
  // (Minior's Meteor Forms are form 0–6 – its core the species' own name; Gen 3: an expanded engine's Megas)
  const suffix = gen >= 3 && (mon.form || mon.species === 774) ? SD_FORMS[mon.species]?.[mon.form || 0] : '';
  const species = suffix ? `${base}-${suffix}` : base;
  const nick = String(mon.nick ?? mon.nickname ?? '').replace(/[()@\n\r]/g, '').trim().slice(0, 18);
  // (the species' own name as the game writes it – "BULBASAUR", "NIDORAN♀" – is no nickname)
  const named = nick && ![raw, base, species].some((n) => n.toLowerCase() === nick.toLowerCase());
  const gender = mon.gender === 'M' || mon.gender === 'F' ? ` (${mon.gender})` : '';
  const item = N.item(mon) || '';
  const lines = [`${named ? `${nick} (${species})` : species}${gender}${item ? ` @ ${item}` : ''}`];
  const ability = gen >= 3 && s.ability ? N.ability(s) : '';
  if (ability) lines.push(`Ability: ${ability}`);
  if (Number.isInteger(mon.level) && mon.level >= 1 && mon.level < 100) lines.push(`Level: ${mon.level}`);
  if (mon.shiny) lines.push('Shiny: Yes');
  // EVs: Gen 3+ as read; Game Boy stat experience as the EVs that give the same stat (the games use the rounded-up
  // square root, capped at 255, where later games use the EV)
  const evs = gen >= 3 ? s.evs : s.statExp ? gbStats(s.statExp.map((x) => Math.min(255, Math.ceil(Math.sqrt(x))))) : null;
  const evLine = evs ? SD_STATS.map((k, i) => (evs[i] ? `${evs[i]} ${k}` : '')).filter(Boolean).join(' / ') : '';
  if (evLine) lines.push(`EVs: ${evLine}`);
  const nature = gen >= 3 && s.nature !== undefined ? N.nature(s.nature) : '';
  if (nature) lines.push(`${nature} Nature`);
  // IVs: Gen 3+ as read; Game Boy DVs as Showdown takes them (it halves the IV: DV × 2 + 1, DV 15 is 31)
  const ivs = gen >= 3 ? s.ivs : s.dvs ? gbStats(s.dvs.map((d) => d * 2 + 1)) : null;
  const ivLine = ivs ? SD_STATS.map((k, i) => (ivs[i] !== 31 ? `${ivs[i]} ${k}` : '')).filter(Boolean).join(' / ') : '';
  if (ivLine) lines.push(`IVs: ${ivLine}`);
  const hp = hiddenPower(s, gen);
  for (const id of mon.moves || []) {
    const name = N.move(id);
    if (!name) continue;
    lines.push(`- ${id === HIDDEN_POWER && hp ? `${name} [${sdType(hp.type)}]` : name}`);
  }
  return lines.join('\n');
}

/** Game Boy [HP, Atk, Def, Spe, Special] → Showdown's six (Special is both SpA and SpD). */
const gbStats = ([hp, atk, def, spe, spc]) => [hp, atk, def, spc, spc, spe];
