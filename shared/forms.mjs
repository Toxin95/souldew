// Alternate forms of the DS games (Gen 4/5): the form number a Pokémon carries (its data +0x40, bits 3–7 – PKHeX PK4/
// PK5 Form; the battle's own BattleMon in HeartGold/SoulSilver: +0x26, bits 0–4) → the form's types and sprite.
// Forms that change the types (Rotom's appliances from Gen 5 on, Wormadam's cloaks, Shaymin's Sky Forme, Arceus's
// plates, Castform's weather, Darmanitan's Zen Mode, Meloetta's Pirouette Forme) and forms that only look different
// (Deoxys, Giratina, the Therian Formes, Kyurem, Keldeo, Basculin). PokeAPI numbers the forms' sprites from 10001
// (pokeapi.co/api/v2/pokemon/10001 …), the sprites folders of Gen 4 and 5 included.
//
// The 3DS games (Gen 6/7) keep the form the same way (PK6/PK7 +0x1D, bits 3–7) with the National Dex number of the
// species: Mega Evolutions and Primal Reversion (PKHeX: Charizard and Mewtwo Mega X 1 / Mega Y 2, every other Mega
// and Primal 1), the Alolan forms (Sun/Moon on: form 1) and the forms a battle changes (Ash-Greninja, Zygarde Complete,
// Wishiwashi's School, Mimikyu Busted, Aegislash's Blade, Minior's core …). A form is always its species for the rules
// (route, dupes, evolution line, SoulLink pairs, Pokédex) – these tables only show it. Expanded GBA engines number
// their forms as species of their own: shared/live/romspecies.mjs maps them to the species and tells a Mega by its
// base stats (gen3Forms) – in the same form numbers as here.

// species → [form → PokeAPI id] (form 0 is the species itself)
const SPRITES = {
  386: [0, 10001, 10002, 10003], // Deoxys: Attack, Defense, Speed
  413: [0, 10004, 10005], // Wormadam: Sandy, Trash
  492: [0, 10006], // Shaymin: Sky
  487: [0, 10007], // Giratina: Origin
  479: [0, 10008, 10009, 10010, 10011, 10012], // Rotom: Heat, Wash, Frost, Fan, Mow
  351: [0, 10013, 10014, 10015], // Castform: Sunny, Rainy, Snowy
  550: [0, 10016], // Basculin: Blue-Striped
  555: [0, 10017], // Darmanitan: Zen Mode
  648: [0, 10018], // Meloetta: Pirouette
  641: [0, 10019], // Tornadus: Therian
  642: [0, 10020], // Thundurus: Therian
  645: [0, 10021], // Landorus: Therian
  646: [0, 10023, 10022], // Kyurem: White (form 1), Black (form 2)
  647: [0, 10024], // Keldeo: Resolute
  // Gen 6/7 forms with a look of their own (PKHeX form numbers)
  678: [0, 10025], // Meowstic: female
  681: [0, 10026], // Aegislash: Blade
  710: [0, 10027, 10028, 10029], // Pumpkaboo: Small, Large, Super
  711: [0, 10030, 10031, 10032], // Gourgeist
  670: [0, 0, 0, 0, 0, 10061], // Floette: Eternal Flower
  658: [0, 10116, 10117], // Greninja: Battle Bond, Ash
  718: [0, 10181, 10118, 10119, 10120], // Zygarde: 10%, 10% and 50% with Power Construct, Complete
  720: [0, 10086], // Hoopa: Unbound
  741: [0, 10123, 10124, 10125], // Oricorio: Pom-Pom, Pa'u, Sensu
  745: [0, 10126, 10152], // Lycanroc: Midnight, Dusk
  746: [0, 10127], // Wishiwashi: School
  774: [0, 10130, 10131, 10132, 10133, 10134, 10135, 10136, 10137, 10138, 10139, 10140, 10141, 10142], // Minior: Meteor 0–6, core 7–13
  778: [0, 10143, 0, 10143], // Mimikyu: Busted (and the Totem's)
  800: [0, 10155, 10156, 10157], // Necrozma: Dusk Mane, Dawn Wings, Ultra
};

// Mega Evolutions (form 1; Charizard and Mewtwo: X 1, Y 2) and Primal Reversion (form 1) → PokeAPI id
const MEGA = {
  3: 10033, 9: 10036, 65: 10037, 94: 10038, 115: 10039, 127: 10040, 130: 10041, 142: 10042, 181: 10045, 212: 10046,
  214: 10047, 229: 10048, 248: 10049, 257: 10050, 282: 10051, 303: 10052, 306: 10053, 308: 10054, 310: 10055, 354: 10056,
  359: 10057, 445: 10058, 448: 10059, 460: 10060, 380: 10062, 381: 10063, 260: 10064, 254: 10065, 302: 10066, 334: 10067,
  475: 10068, 531: 10069, 319: 10070, 80: 10071, 208: 10072, 18: 10073, 362: 10074, 719: 10075, 376: 10076, 384: 10079,
  323: 10087, 428: 10088, 373: 10089, 15: 10090,
};
const MEGA_XY = { 6: [10034, 10035], 150: [10043, 10044] };
const PRIMAL = { 382: 10077, 383: 10078 };
// the Alolan forms (Sun/Moon on, form 1) → PokeAPI id
const ALOLA = {
  19: 10091, 20: 10092, 26: 10100, 27: 10101, 28: 10102, 37: 10103, 38: 10104, 50: 10105, 51: 10106, 52: 10107, 53: 10108,
  74: 10109, 75: 10110, 76: 10111, 88: 10112, 89: 10113, 103: 10114, 105: 10115,
};

/** Does `species` Mega Evolve (or Primal Revert) – the forms gen3Forms looks for in an expanded GBA engine. */
export const hasMega = (species) => species in MEGA || species in MEGA_XY || species in PRIMAL;
/** Mega X and Mega Y: the two species with two Megas. */
export const megaXY = (species) => species in MEGA_XY;

/**
 * What the form is called, as a key for the UI ('mega', 'megaX', 'megaY', 'primal', 'alola') – or null for the species'
 * own form and the forms whose species name is enough. Alolan forms only from Gen 7 on (form 1 is something else before).
 */
export function formKind(species, form, gen = 7) {
  if (!formOk(form)) return null;
  if (MEGA_XY[species]) return form === 1 ? 'megaX' : form === 2 ? 'megaY' : null;
  if (form === 1 && MEGA[species]) return 'mega';
  if (form === 1 && PRIMAL[species]) return 'primal';
  if (form === 1 && ALOLA[species] && (gen >= 7 || gen === 3)) return 'alola';
  return null;
}

// species → [form → types] for the forms whose types differ from the species' (official, PokeAPI); `from`: the first
// generation the form has them (Rotom's appliances were Electric/Ghost in Gen 4)
const TYPES = {
  // Gen 6/7: the Megas, Primal Groudon and the Alolan forms whose types aren't the species' own, and the forms a battle
  // changes them in
  6: { from: 6, types: [null, ['fire', 'dragon']] },
  150: { from: 6, types: [null, ['psychic', 'fighting']] },
  181: { from: 6, types: [null, ['electric', 'dragon']] },
  130: { from: 6, types: [null, ['water', 'dark']] },
  127: { from: 6, types: [null, ['bug', 'flying']] },
  254: { from: 6, types: [null, ['grass', 'dragon']] },
  334: { from: 6, types: [null, ['dragon', 'fairy']] },
  428: { from: 6, types: [null, ['normal', 'fighting']] },
  531: { from: 6, types: [null, ['normal', 'fairy']] },
  383: { from: 6, types: [null, ['ground', 'fire']] },
  720: { from: 6, types: [null, ['psychic', 'dark']] },
  741: { from: 7, types: [null, ['electric', 'flying'], ['psychic', 'flying'], ['ghost', 'flying']] },
  800: { from: 7, types: [null, ['psychic', 'steel'], ['psychic', 'ghost'], ['psychic', 'dragon']] },
  19: { from: 7, types: [null, ['dark', 'normal']] },
  20: { from: 7, types: [null, ['dark', 'normal']] },
  26: { from: 7, types: [null, ['electric', 'psychic']] },
  27: { from: 7, types: [null, ['ice', 'steel']] },
  28: { from: 7, types: [null, ['ice', 'steel']] },
  37: { from: 7, types: [null, ['ice']] },
  38: { from: 7, types: [null, ['ice', 'fairy']] },
  50: { from: 7, types: [null, ['ground', 'steel']] },
  51: { from: 7, types: [null, ['ground', 'steel']] },
  52: { from: 7, types: [null, ['dark']] },
  53: { from: 7, types: [null, ['dark']] },
  74: { from: 7, types: [null, ['rock', 'electric']] },
  75: { from: 7, types: [null, ['rock', 'electric']] },
  76: { from: 7, types: [null, ['rock', 'electric']] },
  88: { from: 7, types: [null, ['poison', 'dark']] },
  89: { from: 7, types: [null, ['poison', 'dark']] },
  103: { from: 7, types: [null, ['grass', 'dragon']] },
  105: { from: 7, types: [null, ['fire', 'ghost']] },
  413: { types: [null, ['bug', 'ground'], ['bug', 'steel']] },
  492: { types: [null, ['grass', 'flying']] },
  479: { from: 5, types: [null, ['electric', 'fire'], ['electric', 'water'], ['electric', 'ice'], ['electric', 'flying'], ['electric', 'grass']] },
  351: { types: [null, ['fire'], ['water'], ['ice']] },
  555: { types: [null, ['fire', 'psychic']] },
  648: { types: [null, ['normal', 'fighting']] },
};

// Arceus: its form is its type, in the games' type order (Gen 4: '???' at 9 – the plates skip it; Gen 5: none)
const ARCEUS4 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', null, 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
const ARCEUS5 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];

const formOk = (form) => Number.isInteger(form) && form > 0 && form < 32;

/**
 * The official types of `species` in form `form` in generation `gen`, or null when they are the species' own. Gen 3:
 * an expanded engine's Mega or Primal (gen3Forms) – the forms of the 3DS games.
 */
export function formTypes(species, form, gen = 5) {
  if (!formOk(form) || gen < 3) return null;
  if (gen === 3) return formKind(species, form, 3) ? formTypes(species, form, 7) : null;
  if (species === 493) {
    const t = (gen === 4 ? ARCEUS4 : ARCEUS5)[form];
    return t ? [t] : null;
  }
  const f = TYPES[species];
  if (!f || (f.from && gen < f.from)) return null;
  return f.types[form] || null;
}

/** The PokeAPI id of the sprite of `species` in form `form` (the species' own number for form 0 or an unknown form). */
export function formSpriteId(species, form) {
  if (!formOk(form)) return species;
  if (MEGA_XY[species]) return MEGA_XY[species][form - 1] || species;
  if (form === 1 && (MEGA[species] || PRIMAL[species] || ALOLA[species])) return MEGA[species] || PRIMAL[species] || ALOLA[species];
  return SPRITES[species]?.[form] || species;
}
