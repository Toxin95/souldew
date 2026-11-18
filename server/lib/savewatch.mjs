// Watches the emulator's battery save and emits parsed snapshots (debounced, retrying on
// half-written files). Polling (fs.watchFile) is used on purpose: emulators rewrite saves in
// place or via temp-file swaps, which native fs.watch reports inconsistently across platforms.
//
// A run's save can turn up in more than one place – melonDS writes `<ROM name>.sav` next to the ROM, or into the save
// folder set in its own settings – so a watch may follow several paths: whichever was written last is the one read.
import { watchFile, unwatchFile, statSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseHgssSave } from '../../shared/gen4save.mjs';
import { findEntry, readSaveFile, LiveTables } from '../../shared/live/parse.mjs';

/** A HeartGold / SoulSilver game (a run's `game`): its save has its own parser, and only its save can be edited. */
export const isHgssGame = (game) => /^IP[KG]/i.test(game?.code || '') || /heartgold|soulsilver/i.test(game?.id || '');

/**
 * How to read the battery save of a run's game (`game`: { code, system, id }), or null when souldew can't: HeartGold /
 * SoulSilver with shared/gen4save.mjs (as before – the graveyard edits those), every other DS game the live readers
 * know – Diamond, Pearl, Platinum, Black, White, Black 2, White 2, any language – with shared/live/parse.mjs
 * readSaveFile. `gen4` = shared/data/gen4.json, `addresses` = shared/data/addresses.json.
 * → (bytes, { shinyOdds }) → the parsed save
 */
export function saveParser(game, { gen4, addresses }) {
  if (game?.system && game.system !== 'nds') return null;
  if (isHgssGame(game)) return (bytes, o) => parseHgssSave(bytes, { ...gen4, ...o });
  const entry = game?.code ? findEntry(addresses, { platform: 'nds', code: game.code }) : null;
  if (!entry || (entry.gen !== 4 && entry.gen !== 5)) return null;
  const T = new LiveTables({ gen4 });
  return (bytes, { shinyOdds } = {}) => readSaveFile(entry, bytes, T.withShinyOdds(shinyOdds));
}

/** A file that changed this recently may still be being written: read it once it has been quiet this long. */
const SETTLE_MS = 1500;

const stamp = (p) => {
  try {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
};

export class SaveWatcher {
  /**
   * `shinyOdds(runId)`: the run's shiny threshold (shared/shiny.mjs) – its game may call more Pokémon shiny.
   * `parserFor(runId)`: how to read that run's save – (bytes, { shinyOdds }) → the parsed save (shared/gen4save.mjs
   * parseHgssSave's shape); without one, a HeartGold/SoulSilver save.
   */
  constructor(data, emit, { shinyOdds = () => 8, parserFor = null, interval = 1000, settleMs = SETTLE_MS } = {}) {
    this.data = data;
    this.interval = interval; // (how often the files are looked at, and how long a write must be quiet – tests go faster)
    this.settleMs = settleMs;
    this.emit = emit;
    this.shinyOdds = shinyOdds;
    this.parserFor = parserFor;
    this.watches = new Map(); // runId → { paths, path, timer, lastHash, last, … }
  }

  /**
   * What is watched: `path` the save read last (else the first place it is looked for), `paths` every place, `exists`
   * whether that file is there, `lastAt` the time it was saved (its modification time), `readAt` when souldew last read
   * it, `error` why the last read failed.
   */
  status(runId) {
    const w = this.watches.get(runId);
    if (!w) return { watching: false };
    return { watching: true, path: w.path, paths: [...w.paths], exists: existsSync(w.path), lastHash: w.lastHash, lastAt: w.lastAt, readAt: w.readAt, error: w.error || null, errorCode: w.errorCode || null };
  }

  last(runId) {
    return this.watches.get(runId)?.last || null;
  }

  /** The places watched for `runId` right now (or null). */
  paths(runId) {
    const w = this.watches.get(runId);
    return w ? [...w.paths] : null;
  }

  /** `paths`: the save file, or several places it may be written to (the first is the usual one). */
  watch(runId, paths) {
    const list = [...new Set([].concat(paths).filter((p) => typeof p === 'string' && p))];
    this.unwatch(runId);
    if (!list.length) return this.status(runId);
    const w = { paths: list, path: list[0], timer: null, lastHash: null, lastAt: null, readAt: null, last: null, error: null, errorCode: null, retries: 0, settles: 0, listeners: new Map() };
    this.watches.set(runId, w);
    for (const p of list) {
      const onChange = (curr, prev) => {
        // (a file that disappears – an emulator swapping in its temp file – reports a zeroed stat: the swap's second
        // half comes as a change of its own)
        if (!curr.mtimeMs && !curr.size && prev.mtimeMs) return;
        clearTimeout(w.timer);
        w.retries = w.settles = 0; // a new write gets its own mid-write retries
        // melonDS rewrites the file ~2–3 s after the game stops writing; wait for it to settle.
        w.timer = setTimeout(() => this.read(runId), this.settleMs);
      };
      w.listeners.set(p, onChange);
      watchFile(p, { interval: this.interval }, onChange);
    }
    if (list.some((p) => existsSync(p))) this.read(runId);
    return this.status(runId);
  }

  unwatch(runId) {
    const w = this.watches.get(runId);
    if (!w) return;
    clearTimeout(w.timer);
    for (const [p, l] of w.listeners) unwatchFile(p, l);
    this.watches.delete(runId);
  }

  /** The place written last (the newest modification time) among those that exist, or null. */
  newest(w) {
    let best = null;
    for (const p of w.paths) {
      const s = stamp(p);
      if (s && s.size > 0 && (!best || s.mtimeMs > best.s.mtimeMs)) best = { p, s };
    }
    return best;
  }

  read(runId, force = false) {
    const w = this.watches.get(runId);
    const hit = w && this.newest(w);
    if (!hit) return null;
    w.path = hit.p;
    let buf;
    try {
      buf = readFileSync(hit.p);
    } catch (e) {
      w.error = e.message;
      return null;
    }
    // Still being written (the size or the time changed while it was read, or it was written a moment ago): read it
    // again once it is quiet – a save read halfway can hold the older half of the flash and pass every check.
    const after = stamp(hit.p);
    const torn = !after || after.size !== buf.length || after.mtimeMs !== hit.s.mtimeMs;
    const fresh = !force && !!after && Date.now() - after.mtimeMs < this.settleMs / 2;
    if ((torn || fresh) && w.settles < 5) {
      w.settles++;
      clearTimeout(w.timer);
      w.timer = setTimeout(() => this.read(runId, force), this.settleMs);
      return w.last;
    }
    w.settles = 0;
    const hash = createHash('sha1').update(buf).digest('hex');
    w.readAt = new Date().toISOString();
    if (!force && hash === w.lastHash) return w.last;
    try {
      const parse = this.parserFor?.(runId) || ((bytes, o) => parseHgssSave(bytes, { ...this.data, ...o }));
      const parsed = parse(new Uint8Array(buf), { shinyOdds: this.shinyOdds(runId) });
      w.lastHash = hash;
      w.lastAt = new Date(after?.mtimeMs ?? hit.s.mtimeMs).toISOString();
      w.error = w.errorCode = null;
      w.retries = 0;
      w.last = { runId, at: w.lastAt, hash, path: hit.p, save: parsed };
      this.emit('save', w.last);
      return w.last;
    } catch (e) {
      // Possibly caught mid-write → retry a few times before reporting.
      if (w.retries++ < 3) {
        clearTimeout(w.timer);
        w.timer = setTimeout(() => this.read(runId), this.settleMs);
      } else {
        w.error = e.message;
        w.errorCode = e.code || null;
        this.emit('save-error', { runId, error: e.message, code: e.code, vars: e.vars }); // (shared/gen4save.mjs saveError: the page words it)
      }
      return null;
    }
  }
}
