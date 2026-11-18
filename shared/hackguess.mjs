// Which catalog ROM hack a ROM file might be, from its file name: "kaizo-emerald.gba", "Emerald_Kaizo_v2.gba" and
// "radicalred 4.1.gba" are already-patched hacks whose header still says Emerald / FireRed. Only a suggestion – the
// player confirms it (server/lib/library.mjs romHacks) – and only for a hack of the game the ROM's header names.

/** Words of a name, lower case without accents: "Pokémon Emerald_Kaizo v2.gba" → ['emerald', 'kaizo', 'v2']. */
export function nameWords(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\.(gba|gbc|gb|sgb|nds|zip|bin)$/i, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'pokemon');
}

const joined = (s) => nameWords(s).join('');

/**
 * The catalog hack `fileName` looks like, among the hacks of `gameId` (the ROM's header game; regional variants count
 * as their main game) – or null. A hack matches when every word of its name is in the file name, or the file name
 * written together contains it ("radicalred"). Hacks whose name adds nothing to the base game's ("Pokémon Emerald")
 * never match; of several, the one with the longest name wins ("Too Many Types 2" over "Too Many Types").
 */
export function guessHack(fileName, gameId, catalog) {
  if (!gameId || !catalog) return null;
  const rootOf = (id) => (catalog.games || []).find((g) => g.id === id)?.variantOf || id;
  const root = rootOf(gameId);
  const words = new Set(nameWords(fileName));
  const together = joined(fileName);
  let best = null;
  for (const h of catalog.hacks || []) {
    if (!h.baseGameId || rootOf(h.baseGameId) !== root) continue;
    const base = (catalog.games || []).find((g) => g.id === h.baseGameId);
    const baseWords = new Set([...nameWords(base?.title), ...nameWords(base?.titleDe)]);
    const hw = nameWords(h.name);
    if (!hw.length || hw.every((w) => baseWords.has(w))) continue;
    const hj = hw.join('');
    const idj = joined(String(h.id).replace(/-/g, ' '));
    const fits = hw.every((w) => words.has(w)) || (hj.length > 4 && together.includes(hj)) || (idj.length > 4 && together.includes(idj));
    if (fits && (!best || hj.length > best.len)) best = { hack: h, len: hj.length };
  }
  return best?.hack || null;
}
