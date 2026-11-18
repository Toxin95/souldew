// Alternate forms of the DS games (Gen 4/5): the form number a Pokémon carries (its data +0x40, bits 3–7 – PKHeX PK4/
// PK5 Form; the battle's own BattleMon in HeartGold/SoulSilver: +0x26, bits 0–4) → the form's types and sprite.
// Forms that change the types (Rotom's appliances from Gen 5 on, Wormadam's cloaks, Shaymin's Sky Forme, Arceus's
// plates, Castform's weather, Darmanitan's Zen Mode, Meloetta's Pirouette Forme) and forms that only look different
// (Deoxys, Giratina, the Therian Formes, Kyurem, Keldeo, Basculin). PokeAPI numbers the forms' sprites from 10001
// (pokeapi.co/api/v2/pokemon/10001 …), the sprites folders of Gen 4 and 5 included.

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
};

// species → [form → types] for the forms whose types differ from the species' (official, PokeAPI); `from`: the first
// generation the form has them (Rotom's appliances were Electric/Ghost in Gen 4)
const TYPES = {
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

/** The official types of `species` in form `form` in generation `gen`, or null when they are the species' own. */
export function formTypes(species, form, gen = 5) {
  if (!formOk(form) || gen < 4) return null;
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
  return (formOk(form) && SPRITES[species]?.[form]) || species;
}
