// Run docs for the "Share to Discord" cards (test/liveruns.test.mjs builds their card models, and
// scripts/render-live-cards.mjs paints them): a SoulLink of 2 and of 4 players, a 3-player 3DS run and a solo
// Nuzlocke – deaths with the killer and the place, a wipe and a won run. Made-up players and nicknames, no game data.

const T = 1763040000000; // a fixed time, so the event ids stay the same

/** A live party member (web/lib/run.mjs liveMon) – `hp: 0` is down. */
const mon = (key, area, species, nick, level, { hp = 30, maxHp = 30 } = {}) => ({ key, area, species, nick, level, hp, maxHp, status: 0, shiny: false });
/** An encounter (enc:<area>:<slot>). */
const enc = (species, nickname, level) => ({ outcome: 'caught', species, nickname, level, at: T - 3600e3, auto: true });

function doc({ players, encs = {}, parties = {}, pairs = {}, areas = {}, badges = {}, playTime = {}, extra = {} }) {
  const e = {};
  for (const [slot, name] of Object.entries(players)) e[`player:${slot}`] = { name };
  for (const [k, a] of Object.entries(areas)) e[`area:${k}`] = { name: a, met: [], auto: true, order: 1 };
  for (const [area, bySlot] of Object.entries(encs)) for (const [slot, x] of Object.entries(bySlot)) e[`enc:${area}:${slot}`] = x;
  for (const [slot, party] of Object.entries(parties)) e[`live:${slot}`] = { source: 'live', badges: badges[slot] ?? 0, party, at: T, ...(playTime[slot] ? { playTime: playTime[slot] } : {}) };
  for (const [area, p] of Object.entries(pairs)) e[`pair:${area}`] = { state: 'dead', segment: null, cause: '', ...p };
  return { ...e, ...extra };
}

// ---- a SoulLink of two in HeartGold (the curated route list) ----
const hg = {
  manifest: { id: '8f2c11aa', name: 'Robin & Kim', game: { id: 'pokemon-heartgold', code: 'IPKE', system: 'nds' }, players: { p1: { name: 'Robin' }, p2: { name: 'Kim' } } },
  gen: 4,
  entries: doc({
    players: { p1: 'Robin', p2: 'Kim' },
    encs: {
      'route-29': { p1: enc(155, 'Ember', 18), p2: enc(158, 'Chomp', 17) },
      'route-30': { p1: enc(16, 'Pidge', 15), p2: enc(19, 'Ratty', 14) },
      'route-31': { p1: enc(161, 'Scout', 12), p2: enc(187, 'Hops', 15) },
      violet: { p1: enc(92, 'Wisp', 13), p2: enc(60, 'Swirl', 14) },
      'route-32': { p1: enc(179, 'Volt', 19), p2: enc(183, 'Bubbles', 12) },
      'sprout-tower': { p1: enc(194, '', 11), p2: enc(41, 'Fang', 13) },
    },
    parties: {
      p1: [mon('a1', 'route-29', 155, 'Ember', 18, { hp: 0, maxHp: 44 }), mon('a2', 'route-30', 16, 'Pidge', 15), mon('a3', 'route-32', 179, 'Volt', 19),
        mon('a4', 'violet', 92, 'Wisp', 13), mon('a5', 'sprout-tower', 194, 'WOOPER', 11)],
      p2: [mon('b1', 'route-29', 158, 'Chomp', 17), mon('b2', 'route-30', 19, 'Ratty', 14), mon('b3', 'route-31', 187, 'Hops', 15, { hp: 0 }),
        mon('b4', 'violet', 60, 'Swirl', 14), mon('b5', 'route-32', 183, 'Bubbles', 12), mon('b6', 'sprout-tower', 41, 'Fang', 13)],
    },
    badges: { p1: 2, p2: 2 },
    pairs: {
      'route-31': { diedAt: T - 900e3, by: 'p2', level: 15, killer: { species: 74, level: 14, kind: 'wild' } },
      'route-29': { diedAt: T, by: 'p1', level: 18, killer: { species: 241, level: 19, kind: 'trainer' }, place: { gen: 4, id: 131, name: 'Goldenrod Gym' } },
    },
  }),
};

// ---- a SoulLink of four in Black (areas made from the catches) ----
const four = {
  manifest: { id: '3b9d0e17', name: 'Unova Squad', game: { id: 'pokemon-black', code: 'IRBO', system: 'nds' },
    players: { p1: { name: 'Robin' }, p2: { name: 'Kim' }, p3: { name: 'Lou' }, p4: { name: 'Sam' } } },
  gen: 5,
  entries: doc({
    players: { p1: 'Robin', p2: 'Kim', p3: 'Lou', p4: 'Sam' },
    areas: { 'm5-1': 'Nuvema Town', 'm5-4': 'Route 2', 'm5-20': 'Pinwheel Forest', 'm5-6': 'Route 3', 'm5-30': 'Wellspring Cave' },
    encs: {
      'm5-1': { p1: enc(498, 'Bacon', 21), p2: enc(501, 'Shelly', 20), p3: enc(495, 'Leafy', 21), p4: enc(498, 'Tepig', 19) },
      'm5-4': { p1: enc(504, 'Peeko', 16), p2: enc(506, 'Biscuit', 17), p3: enc(509, 'Purrl', 15), p4: enc(504, 'Scout', 16) },
      'm5-20': { p1: enc(540, 'Leaflet', 18), p2: enc(543, 'Venny', 19), p3: enc(551, 'Dune', 20), p4: enc(546, 'Puff', 18) },
      'm5-6': { p1: enc(519, 'Coo', 17), p2: enc(522, 'Zap', 18), p3: enc(524, 'Rocky', 18), p4: enc(527, 'Woobat', 17) },
      'm5-30': { p1: enc(529, 'Drill', 20), p2: enc(527, 'Echo', 19), p3: enc(524, 'Pebble', 19), p4: enc(529, 'Digger', 20) },
    },
    parties: {
      p1: [mon('a1', 'm5-1', 499, 'Bacon', 21), mon('a2', 'm5-4', 504, 'Peeko', 16), mon('a3', 'm5-20', 540, 'Leaflet', 18, { hp: 0 }), mon('a4', 'm5-6', 519, 'Coo', 17), mon('a5', 'm5-30', 529, 'Drill', 20)],
      p2: [mon('b1', 'm5-1', 501, 'Shelly', 20), mon('b2', 'm5-4', 506, 'Biscuit', 17), mon('b3', 'm5-20', 543, 'Venny', 19), mon('b4', 'm5-6', 522, 'Zap', 18)],
      p3: [mon('c1', 'm5-1', 495, 'Leafy', 21), mon('c2', 'm5-4', 509, 'Purrl', 15), mon('c3', 'm5-20', 551, 'Dune', 20), mon('c4', 'm5-6', 524, 'Rocky', 18), mon('c5', 'm5-30', 524, 'Pebble', 19), mon('c6', null, 535, 'TYMPOLE', 12)],
      p4: [mon('d1', 'm5-1', 498, 'Tepig', 19), mon('d2', 'm5-4', 504, 'Scout', 16), mon('d3', 'm5-20', 546, 'Puff', 18), mon('d4', 'm5-30', 529, 'Digger', 20)],
    },
    badges: { p1: 1, p2: 1, p3: 2, p4: 1 },
    pairs: {
      'm5-6': { diedAt: T - 5000e3, by: 'p4', level: 17, killer: { species: 524, level: 16, kind: 'trainer' } },
      'm5-20': { diedAt: T, by: 'p1', level: 18, killer: { species: 538, level: 20, kind: 'trainer' }, place: { gen: 5, id: 20, name: 'Pinwheel Forest' } },
    },
  }),
};

// ---- a solo Nuzlocke in FireRed ----
const solo = {
  manifest: { id: 'c41e7a02', name: 'Lou – Nuzlocke #3', mode: 'nuzlocke', attempt: 3, game: { id: 'pokemon-firered', code: 'BPRE', system: 'gba' }, players: { p1: { name: 'Lou' } } },
  gen: 3,
  entries: doc({
    players: { p1: 'Lou' },
    areas: { 'm3-88': 'Pallet Town', 'm3-101': 'Route 1', 'm3-102': 'Route 2', 'm3-117': 'Viridian Forest', 'm3-104': 'Route 3', 'm3-114': 'Mt. Moon' },
    encs: {
      'm3-88': { p1: enc(4, 'Blaze', 22) },
      'm3-101': { p1: enc(16, 'Gale', 20) },
      'm3-102': { p1: enc(19, 'Nibbles', 13) },
      'm3-117': { p1: enc(10, 'Buzz', 12) },
      'm3-104': { p1: enc(56, 'Punchy', 18) },
      'm3-114': { p1: enc(41, '', 17) },
    },
    parties: {
      p1: [mon('a1', 'm3-88', 5, 'Blaze', 22, { hp: 0, maxHp: 58 }), mon('a2', 'm3-101', 17, 'Gale', 20), mon('a3', 'm3-104', 56, 'Punchy', 18),
        mon('a4', 'm3-114', 41, 'ZUBAT', 17), mon('a5', 'm3-117', 14, 'Buzz', 12)],
    },
    badges: { p1: 1 },
    pairs: {
      'm3-102': { diedAt: T - 7000e3, by: 'p1', level: 13, killer: { species: 21, level: 9, kind: 'wild' } },
      'm3-88': { diedAt: T, by: 'p1', level: 22, killer: { species: 74, level: 21, kind: 'wild' }, place: { gen: 3, id: 114, name: 'Mt. Moon' } },
    },
  }),
};

// ---- three players in Ultra Sun (3DS: the artwork-style sprites) – the run is over ----
const usum = {
  manifest: { id: 'a0d3f9c4', name: 'Alola Trio', game: { id: 'pokemon-ultra-sun', code: 'AUS', system: '3ds' },
    players: { p1: { name: 'Robin' }, p2: { name: 'Kim' }, p3: { name: 'Lou' } } },
  gen: 7,
  entries: doc({
    players: { p1: 'Robin', p2: 'Kim', p3: 'Lou' },
    areas: { 'm7-6': 'Route 1', 'm7-10': 'Hau’oli City', 'm7-18': 'Route 2', 'm7-22': 'Verdant Cavern' },
    encs: {
      'm7-6': { p1: enc(722, 'Hoot', 14), p2: enc(725, 'Mittens', 15), p3: enc(728, 'Splash', 14) },
      'm7-10': { p1: enc(731, 'Pecks', 12), p2: enc(734, 'Gumshoe', 13), p3: enc(736, 'Grubby', 12) },
      'm7-18': { p1: enc(741, 'Tango', 13), p2: enc(744, 'Rocky', 14), p3: enc(739, 'Crabby', 13) },
      'm7-22': { p1: enc(41, 'Zubby', 12), p2: enc(50, 'Diglett', 12), p3: enc(19, 'Ratty', 11) },
    },
    parties: {
      p1: [mon('a1', 'm7-6', 722, 'Hoot', 14, { hp: 0 }), mon('a2', 'm7-10', 731, 'Pecks', 12, { hp: 0 }), mon('a3', 'm7-18', 741, 'Tango', 13, { hp: 0 }), mon('a4', 'm7-22', 41, 'Zubby', 12, { hp: 0 })],
      p2: [mon('b1', 'm7-6', 725, 'Mittens', 15), mon('b2', 'm7-10', 734, 'Gumshoe', 13), mon('b3', 'm7-18', 744, 'Rocky', 14), mon('b4', 'm7-22', 50, 'Diglett', 12)],
      p3: [mon('c1', 'm7-6', 728, 'Splash', 14), mon('c2', 'm7-10', 736, 'Grubby', 12), mon('c3', 'm7-18', 739, 'Crabby', 13), mon('c4', 'm7-22', 19, 'Ratty', 11)],
    },
    badges: { p1: 0, p2: 0, p3: 0 },
    pairs: {
      'm7-10': { diedAt: T - 400e3, by: 'p1', level: 12, killer: { species: 734, level: 13, kind: 'trainer' } },
      'm7-18': { diedAt: T - 200e3, by: 'p1', level: 13, killer: { species: 735, level: 15, kind: 'trainer' } },
      'm7-22': { diedAt: T - 100e3, by: 'p1', level: 12, killer: { species: 50, level: 12, kind: 'wild' } },
      'm7-6': { diedAt: T - 10e3, by: 'p1', level: 14, killer: { species: 735, level: 15, kind: 'trainer' }, place: { gen: 7, id: 26, name: 'Trainers’ School' } },
    },
    extra: { 'run:status': { state: 'failed', at: T, by: 'p1', auto: true, note: null, reason: 'wipe' } },
  }),
};

// ---- won runs for the Hall of Fame (made-up demo players Lena, Tim, Mo, Ida, Kai) ----
/** A linked group: area → { slot: [species, nick, level] }; returns encs + party entries for every slot. */
function linked(groups, slots) {
  const encs = {};
  const parties = Object.fromEntries(slots.map((s) => [s, []]));
  let k = 0;
  for (const [area, bySlot] of Object.entries(groups)) {
    encs[area] = {};
    for (const s of slots) {
      const [species, nick, level, alive = true] = bySlot[s];
      encs[area][s] = enc(species, nick, Math.max(2, level - 30));
      if (alive) parties[s].push(mon(`${s}${++k}`, area, species, nick, level, { hp: 120, maxHp: 140 }));
    }
  }
  return { encs, parties };
}
const won = (by) => ({ 'run:status': { state: 'won', at: T + 30 * 86400e3, by, auto: false, note: null } });

const ptSlots = ['p1', 'p2'];
const pt = linked({
  'm4-1': { p1: [392, 'Blaze', 62], p2: [395, 'Admiral', 61] },
  'm4-2': { p1: [405, 'Volt', 58], p2: [398, 'Hawk', 59] },
  'm4-3': { p1: [66, 'Brick', 21, false], p2: [77, 'Ember', 20, false] },
  'm4-4': { p1: [407, 'Thorn', 57], p2: [423, 'Slug', 58] },
  'm4-5': { p1: [94, '', 60], p2: [65, 'Spoon', 59] },
  'm4-6': { p1: [418, 'Splash', 24, false], p2: [422, '', 23, false] },
  'm4-7': { p1: [445, 'Chomp', 63], p2: [448, 'Aura', 62] },
  'm4-8': { p1: [468, 'Halo', 59], p2: [461, 'Claw', 60] },
}, ptSlots);
const platinum = {
  manifest: { id: '5e1a90bb', name: 'Lena & Tim', createdAt: new Date(T).toISOString(), game: { id: 'pokemon-platinum', code: 'CPUE', system: 'nds' }, players: { p1: { name: 'Lena' }, p2: { name: 'Tim' } } },
  gen: 4,
  entries: doc({
    players: { p1: 'Lena', p2: 'Tim' },
    areas: { 'm4-1': 'Twinleaf Town', 'm4-2': 'Route 202', 'm4-3': 'Route 203', 'm4-4': 'Route 204', 'm4-5': 'Eterna Forest', 'm4-6': 'Route 205', 'm4-7': 'Wayward Cave', 'm4-8': 'Route 210' },
    ...pt,
    badges: { p1: 8, p2: 8 },
    playTime: { p1: { h: 31, m: 42 }, p2: { h: 33, m: 5 } },
    pairs: { 'm4-3': { diedAt: T - 9e6, by: 'p1', level: 21 }, 'm4-6': { diedAt: T - 5e6, by: 'p2', level: 23 } },
    extra: { ...won('p1'), rules: { levelCaps: true, dupes: 'both', typeClause: 'global' } },
  }),
};

const emSolo = linked({
  'm3-10': { p1: [260, 'Torrent', 58] }, 'm3-11': { p1: [282, 'Grace', 55] }, 'm3-12': { p1: [263, 'Dash', 9, false] },
  'm3-13': { p1: [310, 'Spark', 54] }, 'm3-14': { p1: [286, '', 53] }, 'm3-15': { p1: [334, 'Cloud', 55] }, 'm3-16': { p1: [342, 'Pincer', 54] },
}, ['p1']);
const emerald = {
  manifest: { id: '91bd3c55', name: 'Lena – Nuzlocke #2', mode: 'nuzlocke', attempt: 2, game: { id: 'pokemon-emerald', code: 'BPEE', system: 'gba' }, players: { p1: { name: 'Lena' } } },
  gen: 3,
  entries: doc({
    players: { p1: 'Lena' },
    areas: { 'm3-10': 'Littleroot Town', 'm3-11': 'Route 102', 'm3-12': 'Route 101', 'm3-13': 'Route 110', 'm3-14': 'Petalburg Woods', 'm3-15': 'Route 114', 'm3-16': 'Route 102 (water)' },
    ...emSolo,
    badges: { p1: 8 },
    playTime: { p1: { h: 24, m: 18 } },
    pairs: { 'm3-12': { diedAt: T - 9e6, by: 'p1', level: 9, killer: { species: 261, level: 8, kind: 'wild' } } },
    extra: { ...won('p1'), rules: { levelCaps: 'strict', noBattleItems: true, setMode: true } },
  }),
};

const b2Slots = ['p1', 'p2', 'p3', 'p4'];
const b2 = linked({
  'm5-1': { p1: [500, 'Ham', 56], p2: [503, 'Shell', 55], p3: [497, 'Leaf', 56], p4: [500, 'Bacon', 55] },
  'm5-2': { p1: [612, 'Axe', 57], p2: [635, 'Hydra', 58], p3: [637, 'Moth', 56], p4: [609, 'Lamp', 57] },
  'm5-3': { p1: [530, 'Drill', 54], p2: [534, 'Beams', 53], p3: [553, 'Croc', 55], p4: [571, 'Fox', 54] },
  'm5-4': { p1: [584, 'Frost', 52], p2: [579, 'Blob', 53], p3: [598, 'Spike', 52], p4: [604, 'Eel', 53] },
  'm5-5': { p1: [596, 'Web', 24, false], p2: [523, 'Zap', 25, false], p3: [526, 'Rock', 24, false], p4: [545, 'Wheel', 23, false] },
  'm5-6': { p1: [625, 'Blade', 53], p2: [567, 'Fossil', 52], p3: [560, 'Hood', 53], p4: [628, 'Wing', 54] },
}, b2Slots);
const black2 = {
  manifest: { id: '7c22e810', name: 'Unova Four', randomizer: { enabled: true }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' },
    players: { p1: { name: 'Lena' }, p2: { name: 'Tim' }, p3: { name: 'Mo' }, p4: { name: 'Ida' } } },
  gen: 5,
  entries: doc({
    players: { p1: 'Lena', p2: 'Tim', p3: 'Mo', p4: 'Ida' },
    areas: { 'm5-1': 'Aspertia City', 'm5-2': 'Route 19', 'm5-3': 'Floccesy Ranch', 'm5-4': 'Virbank Complex', 'm5-5': 'Route 20', 'm5-6': 'Castelia Sewers' },
    ...b2,
    badges: { p1: 8, p2: 8, p3: 8, p4: 8 },
    playTime: { p1: { h: 28, m: 10 }, p2: { h: 27, m: 55 }, p3: { h: 29, m: 3 }, p4: { h: 28, m: 41 } },
    pairs: { 'm5-5': { diedAt: T - 5e6, by: 'p3', level: 24 } },
    extra: won('p2'),
  }),
};

const usSlots = ['p1', 'p2', 'p3'];
const us = linked({
  'm7-6': { p1: [724, 'Hoot', 61], p2: [727, 'Mittens', 62], p3: [730, 'Splash', 60] },
  'm7-10': { p1: [733, 'Pecks', 58], p2: [735, 'Gumshoe', 57], p3: [738, 'Volty', 59] },
  'm7-18': { p1: [745, 'Tango', 59], p2: [784, 'Scales', 63], p3: [740, 'Crabby', 58] },
  'm7-22': { p1: [778, 'Mimi', 60], p2: [763, 'Kicks', 58], p3: [800, '', 64] },
  'm7-30': { p1: [752, 'Bubble', 56], p2: [758, 'Toxi', 57], p3: [748, 'Spike', 56] },
}, usSlots);
const ultrasun = {
  manifest: { id: 'e4a19d02', name: 'Alola Trio', createdAt: new Date(T).toISOString(), game: { id: 'pokemon-ultra-sun', code: 'AUS', system: '3ds' },
    players: { p1: { name: 'Lena' }, p2: { name: 'Tim' }, p3: { name: 'Kai' } } },
  gen: 7,
  entries: doc({
    players: { p1: 'Lena', p2: 'Tim', p3: 'Kai' },
    areas: { 'm7-6': 'Route 1', 'm7-10': 'Hau’oli City', 'm7-18': 'Route 2', 'm7-22': 'Verdant Cavern', 'm7-30': 'Brooklet Hill' },
    ...us,
    badges: { p1: 0, p2: 0, p3: 0 },
    extra: won('p3'),
  }),
};

export const LIVE_FIXTURES = [
  { name: 'soullink-2-death', ...hg, event: { kind: 'death', area: 'route-29' } },
  { name: 'soullink-2-victory', ...hg, entries: { ...hg.entries, 'run:status': { state: 'won', at: T + 9e6, by: 'p2', auto: false, note: null } }, event: { kind: 'victory' } },
  { name: 'soullink-4-death', ...four, event: { kind: 'death', area: 'm5-20' } },
  { name: 'soullink-3-wipe-3ds', ...usum, event: { kind: 'wipe' } },
  { name: 'nuzlocke-death', ...solo, event: { kind: 'death', area: 'm3-88' } },
  { name: 'nuzlocke-wipe', ...solo, entries: { ...solo.entries, 'run:status': { state: 'failed', at: T + 60e3, by: 'p1', auto: true, note: null, reason: 'blackout', rule: 'party' } }, event: { kind: 'wipe' } },
  { name: 'hof-soullink-2', ...platinum, event: { kind: 'victory' } },
  { name: 'hof-nuzlocke', ...emerald, event: { kind: 'victory' } },
  { name: 'hof-soullink-4-randomized', ...black2, event: { kind: 'victory' } },
  { name: 'hof-soullink-3-3ds', ...ultrasun, event: { kind: 'victory' } },
];
