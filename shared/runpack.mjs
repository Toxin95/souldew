// The run pack's format (the invite file, the code invite's payload, a new attempt's offer – server/lib/build.mjs
// runPack). Its id comes from the app's former name and must never change for packs every version can read.
//
// A pack that an older app would read *wrongly* gets a new format, which older apps refuse: a run with another shiny
// rate (2.8.0). 2.7.4 and older read only `soullink-studio/run-pack@1`, drop the unknown `shiny` field and would build
// a game with the normal odds without a word – with @2 they refuse the pack instead ("Not a valid run pack" for a
// file or a new attempt; a code invite ends with "The code didn't match" – their texts, which can't be changed now).
// Runs without it keep @1, so players on older versions can still join them. A pack names the version it needs
// (`minVersion`): an app that doesn't know the format says to update, to that version.
// 2.8.1 takes any shiny rate. 2.8.0 reads @2 but knows only its presets – another rate it would quietly turn into the
// normal odds – so a run with another rate travels as @3 (2.8.0 refuses it and says to update to 2.8.1). Runs with a
// preset keep @2, so 2.8.0 players can still join them.
import { shinyKnownTo280 } from './shiny.mjs';

export const PACK_FORMAT = 'soullink-studio/run-pack@1';
export const PACK_FORMAT_SHINY = 'soullink-studio/run-pack@2';
export const PACK_FORMAT_SHINY_ANY = 'soullink-studio/run-pack@3';
/** Formats this app reads. */
export const PACK_FORMATS = [PACK_FORMAT, PACK_FORMAT_SHINY, PACK_FORMAT_SHINY_ANY];
/** The first version that reads a pack with a shiny rate (one of the presets). */
export const SHINY_MIN_VERSION = '2.8.0';
/** The first version that reads a pack with any other shiny rate. */
export const SHINY_ANY_MIN_VERSION = '2.8.1';

/** What a run pack of manifest `m` needs: its format and, for a new format, the version that reads it. */
export function packFormatOf(m) {
  if (!m?.shiny) return { format: PACK_FORMAT };
  return shinyKnownTo280(m.shiny) ? { format: PACK_FORMAT_SHINY, minVersion: SHINY_MIN_VERSION } : { format: PACK_FORMAT_SHINY_ANY, minVersion: SHINY_ANY_MIN_VERSION };
}

/**
 * Is `pack` one this app reads? 'ok', 'newer' (a run pack of a format from a later version – update) or 'invalid'
 * (no run pack at all).
 */
export function packFormatState(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return 'invalid';
  if (PACK_FORMATS.includes(pack.format)) return 'ok';
  return typeof pack.format === 'string' && /^soullink-studio\/run-pack@\d{1,4}$/.test(pack.format) ? 'newer' : 'invalid';
}

/** The version a newer pack names (for "update to …"), or null. */
export const packMinVersion = (pack) => (typeof pack?.minVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(pack.minVersion) ? pack.minVersion : null);
