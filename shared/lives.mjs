// The "lives" rule (off unless a run switches it on): the run has a number of lives, every death costs one, and the
// death that takes the last life ends the run. Pure – the app (web/lib/run.mjs) and the stream API
// (shared/streamapi.mjs) both count from the deaths that stand in the run document, never from a counter of their
// own: undoing a death gives its life back, a death synced twice still counts once.
//
// What a death costs: one life per Pokémon that fell. In a SoulLink the partners' Pokémon that die with it through
// the link cost nothing more – they are lost already, and charging the whole pair or group would make one mistake
// cost 2–4 lives, so the same number of lives would be worth less with every player. A bonus Pokémon (kept shiny or
// gift) costs a life like any other.
// Pools: 'shared' – one for the whole run; 'player' – one per player, the life comes off the player whose Pokémon
// fell (`pair.by`). When any pool is empty the run is over, just as when one player's team is wiped. A solo
// Nuzlocke has one pool. A death that doesn't say who fell (from an app before `by`, or a player the run no longer
// has) goes to the one player who had caught a Pokémon there – as the board's death dialog only asks when several
// had –; when that can't be told either it costs no player's own life (it still costs a shared one): charging the
// host for it would end their part of the run for someone else's loss.

export const LIVES_DEFAULT = 20;
export const LIVES_MIN = 1;
export const LIVES_MAX = 99;
/** At or below this many lives left (after a death – a run started with 3 lives isn't "low" yet) the app warns. */
export const LIVES_LOW = 3;

/** A typed-in number of lives, kept within LIVES_MIN–LIVES_MAX (anything unreadable: the default). */
export const clampLives = (n) => Math.max(LIVES_MIN, Math.min(LIVES_MAX, Math.round(Number(n)) || LIVES_DEFAULT));

/** { total, pool } of a run's rules ('shared' | 'player'), or null while the rule is off. `slots`: the run's players. */
export function livesRule(rules, slots) {
  const n = Number(rules?.lives);
  if (!Number.isFinite(n) || n < LIVES_MIN) return null;
  return { total: clampLives(n), pool: rules.livesPool === 'player' && slots.length > 1 ? 'player' : 'shared' };
}

/**
 * The deaths that stand in a run document, oldest first: [{ slot, at, area } | { slot, at, extra }]. `pairs` is
 * `pair:<area>` without the prefix ({ area: pair }), `extras` likewise `extra:<slot>:<key>` ({ 'slot:key': extra }).
 * `slot` is who fell – the group's `by`, a bonus Pokémon's owner. With the run's `slots` and its encounters `encs`
 * (`enc:<area>:<slot>` without the prefix), a group whose `by` isn't one of the players goes to the one player who
 * had caught a Pokémon there (else it stays unknown – see the top of this file).
 */
export function deathsIn(pairs, extras, { slots = null, encs = null } = {}) {
  const out = [];
  const fell = (area, by) => {
    if (!slots || slots.includes(by) || !encs) return by ?? null;
    const holders = slots.filter((s) => encs[`${area}:${s}`]?.outcome === 'caught');
    return holders.length === 1 ? holders[0] : by ?? null;
  };
  for (const [area, p] of Object.entries(pairs || {})) if (p?.state === 'dead') out.push({ slot: fell(area, p.by), at: p.diedAt || 0, area });
  for (const [extra, x] of Object.entries(extras || {})) if (x?.dead) out.push({ slot: extra.split(':')[0], at: x.diedAt || 0, extra });
  return out.sort((a, b) => a.at - b.at);
}

/** Which pool `slot` spends from: 'all' (shared) or the slot itself – null for a slot outside the run (nobody's own). */
export function poolOf(lives, slot, slots) {
  if (lives.pool !== 'player') return 'all';
  return slots.includes(slot) ? slot : null;
}

/**
 * The lives left, from the deaths that stand (deathsIn). null while the rule is off, else
 * { total, pool, pools: { [id]: { slots, used, left, out, low, lastAt } } } – id 'all' for a shared pool, else one per
 * slot. `left` never goes below 0; `out`: no life left (the death that took the last one ends the run); `low`: few
 * left (LIVES_LOW) since a death, not out yet.
 */
export function livesLeft(rules, slots, deaths) {
  const rule = livesRule(rules, slots);
  if (!rule) return null;
  const pools = {};
  for (const id of rule.pool === 'player' ? slots : ['all']) pools[id] = { slots: id === 'all' ? [...slots] : [id], used: 0, left: rule.total, out: false, low: false, lastAt: 0 };
  for (const d of deaths || []) {
    const p = pools[poolOf(rule, d.slot, slots)];
    if (!p) continue; // (who fell can't be told: no player's own life)
    p.used++;
    p.lastAt = Math.max(p.lastAt, d.at || 0);
  }
  for (const p of Object.values(pools)) {
    p.left = Math.max(0, rule.total - p.used);
    p.out = p.used >= rule.total;
    p.low = !p.out && p.used > 0 && p.left <= LIVES_LOW;
  }
  return { ...rule, pools };
}

/** The pool of `slot` in a livesLeft result (null while the rule is off). */
export function livesOf(lives, slot, slots) {
  return lives ? lives.pools[poolOf(lives, slot, slots)] || null : null;
}
