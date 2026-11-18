// The rule editors – one set of rules, texts and options for both places that edit them: the new-run wizard (variant
// 'wizard': compact) and the board's Rules tab (variant 'board': grouped panels, every toggle always visible).
// Solo Nuzlocke: NuzlockeRules (presets; in the wizard the toggles only for "Custom"). SoulLink: SoulLinkRules (no
// presets – every rule shown), SoulLinkAuto, and the shared TypeHelpRule and LivesRule; the host sets them all
// (shared/hostrules.mjs), the others see them read-only (`disabled`).
import { html, useState } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { RULE_PRESETS, presetOf } from '../lib/run.mjs';
import { LIVES_DEFAULT, LIVES_MIN, LIVES_MAX, clampLives } from '/shared/lives.mjs';

const presets = () => [
  ['classic', t('nzr.classic', 'Classic'), t('nzr.classicText', 'The two core rules – only the first Pokémon of each area, fainted means dead – plus the dupes clause (an evolution line you already caught doesn’t count, keep looking) and the shiny clause (a shiny is a free catch). A blackout ends the run.')],
  ['hardcore', t('nzr.hardcore', 'Hardcore'), t('nzr.hardcoreText', 'Classic plus level caps (never above the strongest Pokémon of the next boss), no items from the bag in battle and the “Set” battle style.')],
  ['custom', t('nzr.custom', 'Custom'), t('nzr.customText', 'Switch every rule on or off yourself.')],
];

const areaOptions = () => [['area', t('nzr.optArea', 'Count as the area')], ['free', t('nzr.optFree', 'Free extra')], ['banned', t('nzr.optBanned', 'Not allowed')]];

// the dupes clause's switch – one text for the SoulLink rules (MissedDupesRule) and the solo ones (ruleDefs)
const missedDupesLabel = () => t('rules.missedDupes', 'Fled or knocked-out encounters count as dupes');
const missedDupesHint = () => t('rules.missedDupesHint', 'Like a catch, once it’s known which Pokémon it was – souldew notes it when it sees the battle.');

/**
 * Every rule once: `check` = on/off, `choice` = one of `options`. `section` groups them on the board; `honour`
 * marks rules the app can't see (it only reminds you); `when`: shown only while it applies (the other rules).
 */
const ruleDefs = () => [
  { key: 'autoDeath', kind: 'check', section: 'core', label: t('nzr.autoDeath', 'Fainted means dead'), hint: t('nzr.autoDeathHint', 'Marked dead by the app as soon as its HP hits 0.') },
  { key: 'blackout', kind: 'choice', section: 'core', label: t('nzr.blackout', 'Blackout'),
    hint: t('nzr.blackoutHint', 'Your whole team is down. “Nothing left”: the run goes on with the box until no caught Pokémon is alive.'),
    options: [['party', t('nzr.blackoutParty', 'Ends the run')], ['box', t('nzr.blackoutBox', 'When nothing is left')], ['off', t('rules.off', 'Off')]] },
  { key: 'deathless', kind: 'check', section: 'core', label: t('nzr.deathless', 'Deathless'), hint: t('nzr.deathlessHint', 'The first death ends the run.') },
  { key: 'dupes', kind: 'choice', section: 'clauses', label: t('rules.dupes', 'Dupes clause'), hint: t('nz.dupesHint', 'Already caught it? Keep looking – dead ones count too.'),
    options: [['off', t('rules.off', 'Off')], ['species', t('nzr.dupesSpecies', 'Same species')], ['line', t('nzr.dupesLine', 'Whole evolution line')]] },
  { key: 'missedDupes', kind: 'check', section: 'clauses', when: (v) => v.dupes !== 'off', label: missedDupesLabel(), hint: missedDupesHint() },
  { key: 'shinyClause', kind: 'check', section: 'clauses', label: t('nzr.shiny', 'Shiny clause'), hint: t('nz.shinyHint', 'A shiny may always be caught, even on a used area – a bonus.') },
  { key: 'gifts', kind: 'choice', section: 'clauses', label: t('nzr.gifts', 'Gifts & eggs'), hint: t('nz.giftsHint', 'Starter aside: eggs, trades, fossils and gift Pokémon.'), options: areaOptions() },
  { key: 'statics', kind: 'choice', section: 'clauses', label: t('nzr.statics', 'Static encounters'), hint: t('nz.staticsHint', 'Legendaries and fixed encounters like Sudowoodo or Snorlax.'), options: areaOptions() },
  { key: 'typeClause', kind: 'choice', section: 'clauses', label: t('rules.type', 'Type rule'), hint: t('rules.typeHint', 'Primary types may not repeat in the team.'),
    options: [['off', t('rules.off', 'Off')], ['party', t('nzr.typeParty', 'In the team')]] },
  { key: 'nicknames', kind: 'check', section: 'clauses', label: t('nzr.nicknames', 'Nickname every catch'), hint: t('nz.nicknamesHint', 'A gentle reminder while a team member still has its species name.') },
  { key: 'cheats', kind: 'check', section: 'clauses', label: t('nzr.cheats', 'Allow cheats (Rare Candies)'), hint: t('nz.cheatsHint', 'From the play screen, to level up to the cap without grinding. Every use is written to the log.') },
  { key: 'levelCaps', kind: 'choice', section: 'hardcore', label: t('nzr.caps', 'Level caps'), hint: t('nz.capsHint', 'The next boss’s ace level. Strict: going over is a rule break, not a hint.'),
    options: [[false, t('rules.off', 'Off')], ['warn', t('nzr.capsWarn', 'Warn')], ['strict', t('nzr.capsStrict', 'Strict')]] },
  { key: 'noBattleItems', kind: 'check', section: 'hardcore', honour: true, label: t('nzr.noItems', 'No items in battle'), hint: t('nz.noItemsHint', 'Poké Balls and held items are fine.') },
  { key: 'setMode', kind: 'check', section: 'hardcore', honour: true, label: t('nzr.setMode', '“Set” battle style'), hint: t('nz.setModeHint', 'Battle style “Set” in the game options: no free switch after a knockout.') },
];

// stored values that mean the same as an option ('levelCaps: true' is the old name of 'strict')
const shown = (key, v) => (key === 'levelCaps' ? (v === true ? 'strict' : v || false) : key === 'typeClause' ? (v === 'off' ? 'off' : 'party') : v);

const Honour = () => html`<span class="honour" title=${t('nz.honourHint', 'The app can’t check this – it only reminds you. Keep it yourself.')}>${t('nz.honour', 'honour rule')}</span>`;

/** A segmented one-of-n control (also used by the SoulLink rules on the board). */
export function Choice({ value, options, onChange, label, disabled }) {
  return html`<div class=${`seg ${disabled ? 'locked' : ''}`} role="radiogroup" aria-label=${label} aria-disabled=${disabled ? 'true' : undefined}>${options.map(([v, l]) => html`<button type="button" role="radio" aria-checked=${value === v} class=${value === v ? 'on' : ''}
    disabled=${disabled} onClick=${() => !disabled && onChange(v)}>${l}</button>`)}</div>`;
}

function RuleCheck({ checked, onChange, label, hint, honour, disabled }) {
  return html`<label class=${`check ${disabled ? 'locked' : ''}`}><input type="checkbox" checked=${!!checked} disabled=${disabled} onChange=${(e) => !disabled && onChange(e.target.checked)} />
    <span>${label}${honour && html` <${Honour} />`}${hint && html`<span class="hint">${hint}</span>`}</span></label>`;
}

/**
 * "Fled or knocked-out encounters count as dupes" (SoulLink rules on the board; the solo editor has it in ruleDefs): a
 * missed encounter whose Pokémon is known uses up its evolution line like a catch (lib/run.mjs dupeOf).
 */
export function MissedDupesRule({ value, onChange, disabled }) {
  return html`<${RuleCheck} checked=${value} onChange=${onChange} label=${missedDupesLabel()} hint=${missedDupesHint()} disabled=${disabled} />`;
}

/** One rule with its title, hint and control (board layout). */
function RuleRow({ title, hint, honour, children }) {
  return html`<div class="rule-row">
    <div class="rr-text"><h3>${title}${honour && html` <${Honour} />`}</h3>${hint && html`<p class="small muted">${hint}</p>`}</div>
    <div class="rr-ctl">${children}</div>
  </div>`;
}

/** Pokémon Center visits per badge: none (0 = no limit) or 1–9. */
function CenterLimit({ value, onChange }) {
  const n = value > 0 ? value : 0;
  return html`<div class="row" style="gap:8px">
    <${Choice} label=${t('nz.centers', 'Pokémon Center limit')} value=${n > 0 ? 'on' : 'off'} onChange=${(v) => onChange(v === 'on' ? Math.max(1, n || 2) : 0)}
      options=${[['off', t('nz.noLimit', 'No limit')], ['on', t('nz.perBadge', 'Per badge')]]} />
    ${n > 0 && html`<input type="number" class="num-in" min="1" max="9" value=${n} aria-label=${t('nz.centersN', 'Visits per badge')}
      onChange=${(e) => onChange(Math.max(1, Math.min(9, Math.round(Number(e.target.value) || 1))))} />`}
  </div>`;
}

/**
 * value: the rules; onChange(patch). A preset only sets the toggles; "Custom" is stored as `preset: 'custom'`
 * so it stays chosen even while the toggles happen to match a preset.
 */
export function NuzlockeRules({ value, onChange, variant = 'board' }) {
  const wizard = variant === 'wizard';
  const chosen = value.preset === 'custom' ? 'custom' : presetOf(value);
  // the wizard shows the toggles only once "Custom" is picked
  const [open, setOpen] = useState(chosen === 'custom');
  const current = wizard && open ? 'custom' : chosen;
  const pick = (id) => {
    if (wizard) setOpen(id === 'custom');
    onChange(id === 'custom' ? { preset: 'custom' } : { ...RULE_PRESETS[id], preset: null });
  };
  // editing a toggle on the board: no longer a preset (presetOf tells whether it still happens to match one);
  // in the wizard you are in "Custom" already
  const edit = (patch) => onChange({ ...patch, preset: wizard ? 'custom' : null });
  const defs = ruleDefs().filter((d) => !d.when || d.when(value));
  const control = (d) => (d.kind === 'check'
    ? html`<${RuleCheck} checked=${value[d.key]} onChange=${(v) => edit({ [d.key]: v })} label=${d.label} hint=${d.hint} honour=${d.honour} />`
    : html`<${Choice} label=${d.label} value=${shown(d.key, value[d.key])} onChange=${(v) => edit({ [d.key]: v })} options=${d.options} />`);
  const center = html`<${CenterLimit} value=${value.centerLimit} onChange=${(n) => edit({ centerLimit: n })} />`;

  if (wizard) {
    return html`<div class="stack">
      <div class="preset-list" role="radiogroup" aria-label=${t('nzr.presets', 'Rule set')}>
        ${presets().map(([id, name, desc]) => html`<button type="button" class=${`preset ${current === id ? 'on' : ''}`} role="radio" aria-checked=${current === id} onClick=${() => pick(id)}>
          <span class="radio"></span><span><b>${name}</b>${id === 'classic' ? html` <span class="faint small">${t('new.recommended', 'recommended')}</span>` : ''}</span><span class="desc">${desc}</span></button>`)}
      </div>
      ${open && html`<div class="grid-2" style="gap:12px 22px">
        <div class="stack-s">
          ${defs.filter((d) => d.kind === 'check').map(control)}
          <div class="stack-s"><b class="small">${t('nz.centers', 'Pokémon Center limit')} <${Honour} /></b>${center}
            <span class="tiny faint">${t('nz.centersHint', 'Visits per badge – you count them in the sidebar while playing.')}</span></div>
        </div>
        <div class="stack">
          ${defs.filter((d) => d.kind === 'choice').map((d) => html`<div class="stack-s"><b class="small">${d.label}</b>${control(d)}${d.hint && html`<span class="tiny faint">${d.hint}</span>`}</div>`)}
        </div>
      </div>`}
    </div>`;
  }

  const row = (d) => (d.kind === 'check' ? control(d) : html`<${RuleRow} title=${d.label} hint=${d.hint} honour=${d.honour}>${control(d)}<//>`);
  const section = (id) => defs.filter((d) => d.section === id).map(row);
  return html`<div class="stack-l">
    <section class="stack">
      <div class="rule-presets" role="radiogroup" aria-label=${t('nzr.presets', 'Rule set')}>
        ${presets().map(([id, name, desc]) => html`<button type="button" class=${`rule-preset ${id} ${current === id ? 'on' : ''}`} role="radio" aria-checked=${current === id} onClick=${() => pick(id)}>
          <span class="rp-top"><span class="radio"></span><b>${name}</b></span><span class="rp-desc">${desc}</span></button>`)}
      </div>
    </section>
    <section class="panel stack">
      <h2>${t('nz.core', 'Core rules')}</h2>
      <${RuleCheck} checked=${true} disabled=${true} onChange=${() => {}} label=${t('nz.firstEncounter', 'Only the first encounter per area may be caught')}
        hint=${t('nz.firstEncounterHint', 'Always on – it is what makes a Nuzlocke. Catches are filed by where they were met.')} />
      ${section('core')}
    </section>
    <section class="panel stack">
      <h2>${t('nz.clauses', 'Clauses')}</h2>
      ${section('clauses')}
    </section>
    <section class="panel stack">
      <h2>${t('nz.hardcoreRules', 'Hardcore rules')}</h2>
      ${section('hardcore')}
      <${RuleRow} title=${t('nz.centers', 'Pokémon Center limit')} honour=${true} hint=${t('nz.centersHint', 'Visits per badge – you count them in the sidebar while playing.')}>${center}<//>
    </section>
  </div>`;
}

/**
 * "Show type matchup help" – a rule the host sets for everyone (SoulLink and solo). Off hides the battle helper's
 * move effectiveness, "what hits you" and the weakness charts on every player's play view. `locked`: this player
 * isn't the host – they see the setting but can't change it.
 */
export function TypeHelpRule({ value, onChange, locked, hostName, solo, note = true }) {
  const hint = solo
    ? t('rules.typeHelpHintSolo', 'In battle: how your moves land, what hits you and each Pokémon’s weaknesses. Off for a run where you work them out yourself.')
    : t('rules.typeHelpHint', 'In battle: how your moves land, what hits you and each Pokémon’s weaknesses. Off hides it for every player.');
  return html`<label class=${`check ${locked ? 'locked' : ''}`}><input type="checkbox" checked=${value !== false} disabled=${locked} onChange=${(e) => !locked && onChange(e.target.checked)} />
    <span>${t('rules.typeHelp', 'Show type matchup help')}<span class="hint">${hint}</span>
      ${locked && note && html`<span class="hint host-only">${hostName ? t('rules.hostOnlyName', 'Only {name} can change this (host).', { name: hostName }) : t('rules.hostOnly', 'Only the host can change this.')}</span>`}</span></label>`;
}

/** What the lives rule does, for 1 (solo), 2 or 3–4 players and the chosen pool – one text for the wizard and the board. */
function livesHint(players, pool) {
  if (players < 2) return t('lives.hintSolo', 'Every death costs a life – also one you mark by hand, and a bonus Pokémon. The death that takes the last life ends the run; undoing a death gives its life back.');
  const what = players > 2
    ? t('lives.hintGroup', 'Every death costs one life – only the Pokémon that fell, not the ones of its group that go with it.')
    : t('lives.hintPair', 'Every death costs one life – only the Pokémon that fell, not its partner that goes with it.');
  const how = pool === 'player'
    ? t('lives.hintPlayer', 'Per player: the life comes off the player whose Pokémon fell – once anyone has none left, the run is over, like a wiped team.')
    : players > 2 ? t('lives.hintSharedGroup', 'Shared: one pool for all of you – the death that takes the last life ends the run.')
      : t('lives.hintShared', 'Shared: one pool for both of you – the death that takes the last life ends the run.');
  return `${what} ${how} ${t('lives.hintUndo', 'Undoing a death gives its life back.')}`;
}

/** Off / on, how many (LIVES_MIN–LIVES_MAX), and with 2–4 players whose lives they are. onChange(patch of the rules). */
function LivesControl({ value, pool, players, onChange: change, disabled }) {
  const n = value > 0 ? value : 0;
  const onChange = (patch) => !disabled && change(patch);
  return html`<div class="row" style="gap:8px">
    <${Choice} label=${t('lives.title', 'Lives')} value=${n > 0 ? 'on' : 'off'} onChange=${(v) => onChange({ lives: v === 'on' ? n || LIVES_DEFAULT : 0 })}
      options=${[['off', t('rules.off', 'Off')], ['on', t('common.on', 'On')]]} disabled=${disabled} />
    ${n > 0 && html`<input type="number" class="num-in" min=${LIVES_MIN} max=${LIVES_MAX} value=${n} aria-label=${t('lives.count', 'Number of lives')} disabled=${disabled}
      onChange=${(e) => onChange({ lives: clampLives(e.target.value) })} />`}
    ${n > 0 && players > 1 && html`<${Choice} label=${t('lives.pool', 'Whose lives')} value=${pool === 'player' ? 'player' : 'shared'} onChange=${(v) => onChange({ livesPool: v })}
      options=${[['shared', t('lives.shared', 'Shared')], ['player', t('rules.perPlayer', 'Per player')]]} disabled=${disabled} />`}
  </div>`;
}

/**
 * The lives rule (shared/lives.mjs) – for every run, off unless switched on: a number of lives, every death costs
 * one, the death that takes the last ends the run; with 2–4 players one pool for everyone or each player's own.
 * value / pool: the rules' `lives` / `livesPool`; onChange(patch). `players`: how many play. Variant 'wizard': compact,
 * with its title; 'board': the hint over the control (the panel carries the title) and `left` – how many are left
 * (run.mjs lives()) with the players' `names`, and `ended` (the run has an end): while it hasn't, a pool the deaths so
 * far already use up says that the run goes on until the next death – changing the rule never ends a run by itself
 * (run.mjs settleLives).
 */
export function LivesRule({ value, pool, players = 1, onChange, variant = 'board', left = null, names = {}, ended = false, disabled }) {
  const control = html`<${LivesControl} value=${value} pool=${pool} players=${players} onChange=${onChange} disabled=${disabled} />`;
  const hint = livesHint(players, pool);
  if (variant === 'wizard') {
    return html`<div class="stack-s"><b class="small">${t('lives.title', 'Lives')}</b>${control}${value > 0 && html`<span class="tiny faint">${hint}</span>`}</div>`;
  }
  const pools = left ? Object.entries(left.pools) : [];
  return html`<div class="stack-s">
    <p class="small muted">${value > 0 ? hint : t('lives.hintOff', 'An extra rule: a number of lives for the run – every death costs one, and the run is over once they are gone.')}</p>
    ${control}
    ${pools.length > 0 && html`<p class="small lives-left">${pools.map(([id, p], i) => html`${i ? ' · ' : ''}<span class=${`fact ${p.low || p.out ? 'low' : ''}`}>${id === 'all'
      ? t('lives.leftOf', '{left} of {total} left', { left: p.left, total: left.total })
      : t('lives.leftOfNamed', '{name}: {left} of {total} left', { name: names[id] || id.toUpperCase(), left: p.left, total: left.total })}</span>`)}</p>`}
    ${!ended && pools.filter(([, p]) => p.out).map(([id]) => html`<p class="warning">${id === 'all'
      ? t('lives.usedUp', 'The deaths so far already use up these lives. The run goes on – the next death ends it.')
      : t('lives.usedUpNamed', '{name}: the deaths so far already use up these lives. The run goes on – the next Pokémon {name} loses ends it.', { name: names[id] || id.toUpperCase() })}</p>`)}
  </div>`;
}

/** What the dupes clause means exactly (lib/run.mjs dupeOf) – "Per player" was read as "for one of us" (ticket #18). */
function dupesHint(r, n) {
  const which = {
    off: t('rules.dupesOffHint', 'Off: every first encounter counts, even one of a line you already caught.'),
    player: t('rules.dupesPlayerHint', 'Per player: a line you caught yourself doesn’t count again for you – the others’ catches don’t matter for you.'),
    both: n > 2 ? t('rules.dupesAllHint', 'For everyone: a line one of you caught doesn’t count again for any of you.') : t('rules.dupesBothHint', 'For both: a line one of you caught doesn’t count again for either of you.'),
  }[r.dupes] || '';
  const counts = r.dupes === 'off' ? '' : r.missedDupes
    ? n > 2 ? t('rules.dupesWhichGroupMissed', 'Every catch counts, also one whose group failed or died.') : t('rules.dupesWhichMissed', 'Every catch counts, also one whose pair failed or died.')
    : n > 2 ? t('rules.dupesWhichGroup', 'Every catch counts, also one whose group failed or died – a Pokémon that fled or was knocked out doesn’t.') : t('rules.dupesWhich', 'Every catch counts, also one whose pair failed or died – a Pokémon that fled or was knocked out doesn’t.');
  return [t('rules.dupesHint', 'Already own the evolution line? Keep looking.'), which, counts].filter(Boolean).join(' ');
}

const typeOptions = (n) => [['off', t('rules.off', 'Off')], ['party', t('rules.perPlayer', 'Per player')], ['global', n > 2 ? t('rules.acrossAll', 'Across all teams') : t('rules.acrossBoth', 'Across both teams')]];
const dupesOptions = (n) => [['off', t('rules.off', 'Off')], ['player', t('rules.perPlayer', 'Per player')], ['both', n > 2 ? t('rules.forAll', 'For everyone') : t('rules.forBoth', 'For both')]];
// (a SoulLink has no "not allowed" for gifts: the inbox offers to keep a gift as a free extra, or to file it on an area)
const giftOptions = () => [['area', t('nzr.optArea', 'Count as the area')], ['free', t('nzr.optFree', 'Free extra')]];
const giftsHint = (n) => (n > 2
  ? t('rules.giftsHintGroup', 'Starter aside: eggs, trades, fossils and gift Pokémon. A free extra stays out of the groups, like a bonus shiny.')
  : t('rules.giftsHint', 'Starter aside: eggs, trades, fossils and gift Pokémon. A free extra stays out of the pairs, like a bonus shiny.'));

/**
 * A SoulLink's rules – type rule, dupes clause (+ missed encounters), gifts, a missed encounter costing the pair, shiny
 * clause, level caps and cheats – for the wizard (variant 'wizard': two columns, switches left, choices right) and the
 * board's "Options" panel. value: the rules (defaults filled in); onChange(patch); players: how many play; disabled:
 * shown read-only (a player who isn't the host). The lives, the type matchup help and the automatic switches are
 * LivesRule, TypeHelpRule and SoulLinkAuto.
 */
export function SoulLinkRules({ value: r, onChange, players: n = 2, variant = 'board', disabled = false }) {
  const set = (patch) => !disabled && onChange(patch);
  const check = (key, label, hint) => html`<${RuleCheck} checked=${key === 'levelCaps' ? !!r[key] : r[key]} onChange=${(v) => set({ [key]: v })} label=${label} hint=${hint} disabled=${disabled} />`;
  const checks = [
    check('failKillsPair', n > 2 ? t('rules.failGroup', 'A missed encounter costs the whole group') : t('rules.fail', 'A missed encounter costs the whole pair'),
      variant === 'wizard' ? (n > 2 ? t('rules.failHintGroup', 'Fled or knocked out: the others’ Pokémon from that area may not be used either.') : t('rules.failHint', 'Fled or knocked out: your partner’s Pokémon from that area may not be used either.')) : null),
    check('shinyClause', t('rules.shiny', 'Shiny clause: shinies may always be caught and stay unlinked')),
    check('levelCaps', t('rules.caps', 'Check level caps'), variant === 'wizard' ? t('rules.capsHint', 'Warns when a Pokémon is above the next boss’s ace level.') : null),
    check('cheats', t('rules.cheats', 'Allow cheats (Rare Candies)'), n > 2
      ? t('rules.cheatsHintGroup', 'From the play screen. Every use shows up in the log for all of you.')
      : t('rules.cheatsHint', 'From the play screen. Every use shows up in the log for both of you.')),
  ];
  const typeRule = html`<${Choice} label=${t('rules.type', 'Type rule')} value=${r.typeClause} onChange=${(v) => set({ typeClause: v })} options=${typeOptions(n)} disabled=${disabled} />`;
  const dupes = html`<${Choice} label=${t('rules.dupes', 'Dupes clause')} value=${r.dupes} onChange=${(v) => set({ dupes: v })} options=${dupesOptions(n)} disabled=${disabled} />`;
  const missed = r.dupes !== 'off' && html`<${MissedDupesRule} value=${r.missedDupes} onChange=${(v) => set({ missedDupes: v })} disabled=${disabled} />`;
  const gifts = html`<${Choice} label=${t('nzr.gifts', 'Gifts & eggs')} value=${r.gifts === 'free' ? 'free' : 'area'} onChange=${(v) => set({ gifts: v })} options=${giftOptions()} disabled=${disabled} />`;

  if (variant === 'wizard') {
    return html`<div class="grid-2 sl-rules" style="gap:12px 22px">
      <div class="stack-s">${checks}</div>
      <div class="stack">
        <div class="stack-s"><b class="small">${t('rules.type', 'Type rule')}</b>${typeRule}<span class="tiny faint">${t('rules.typeHint', 'Primary types may not repeat in the team.')}</span></div>
        <div class="stack-s"><b class="small">${t('rules.dupes', 'Dupes clause')}</b>${dupes}<span class="tiny faint">${dupesHint(r, n)}</span>${missed}</div>
        <div class="stack-s"><b class="small">${t('nzr.gifts', 'Gifts & eggs')}</b>${gifts}<span class="tiny faint">${giftsHint(n)}</span></div>
      </div>
    </div>`;
  }
  return html`<div class="stack">
    <div class="stack-s"><h3>${t('rules.type', 'Type rule')}</h3><p class="small muted">${t('rules.typeHint', 'Primary types may not repeat in the team.')}</p>${typeRule}</div>
    <div class="stack-s"><h3>${t('rules.dupes', 'Dupes clause')}</h3><p class="small muted">${dupesHint(r, n)}</p>${dupes}${missed}</div>
    <div class="stack-s"><h3>${t('nzr.gifts', 'Gifts & eggs')}</h3><p class="small muted">${giftsHint(n)}</p>${gifts}</div>
    ${checks}
  </div>`;
}

/**
 * The automatic switches: new catches entered by where they were caught, and (a SoulLink) a linked Pokémon that faints
 * live killing its pair or group. value: the rules; onChange(patch).
 */
export function SoulLinkAuto({ value: r, onChange, players: n = 2, solo = false, disabled = false }) {
  const set = (patch) => !disabled && onChange(patch);
  return html`<div class="stack-s">
    <${RuleCheck} checked=${r.autoAssign} onChange=${(v) => set({ autoAssign: v })} disabled=${disabled} label=${t('rules.autoAssign', 'Enter new catches automatically')}
      hint=${t('rules.autoAssignHint', 'Based on where they were caught. Unclear cases land in the inbox.')} />
    ${!solo && html`<${RuleCheck} checked=${r.autoDeath} onChange=${(v) => set({ autoDeath: v })} disabled=${disabled}
      label=${n > 2 ? t('rules.autoDeathGroup', 'A linked Pokémon that faints (live) kills its whole group automatically') : t('rules.autoDeath', 'A linked Pokémon that faints (live) kills the pair automatically')} />`}
  </div>`;
}

/**
 * Who sets the rules (board's Rules tab and the play view's drawer): the host – "you" on the host's computer, else
 * read-only with the host's name. host: the host's name; mine: this computer is the host's.
 */
export function HostRulesNote({ host, mine, players: n = 2 }) {
  return mine
    ? html`<p class="note host-note">${n > 2 ? t('rules.youHostGroup', 'You’re the host: your rules apply to all of you. Every change you make shows up in the log for everyone.')
      : t('rules.youHost', 'You’re the host: your rules apply to both of you. Every change you make shows up in the log for both of you.')}</p>`
    : html`<p class="warning info host-note" role="note"><b>${t('rules.setByHost', 'Set by the host')}</b> · ${t('rules.setByHostText', '{name} created this run and sets the rules for everyone – only {name} can change them. Every change shows up in the log.', { name: host || t('rules.theHost', 'the host') })}</p>`;
}

/**
 * The rules of a SoulLink in a few lines – what the join page shows before joining. rules: as the invite has them
 * (filled in with the defaults here); players: how many play.
 */
export function RulesSummary({ rules: r, players: n = 2 }) {
  const on = (v) => (v ? t('common.on', 'On') : t('rules.off', 'Off'));
  const pick = (opts, v) => opts.find(([k]) => k === v)?.[1] || String(v);
  const lives = r.lives > 0
    ? r.livesPool === 'player' ? t('rules.sumLivesPlayer', '{n} per player', { n: r.lives }) : t('rules.sumLivesShared', '{n} shared', { n: r.lives })
    : t('rules.off', 'Off');
  const rows = [
    [t('rules.type', 'Type rule'), pick(typeOptions(n), r.typeClause)],
    [t('rules.dupes', 'Dupes clause'), r.dupes !== 'off' && r.missedDupes ? `${pick(dupesOptions(n), r.dupes)} · ${t('rules.sumMissedToo', 'fled ones count too')}` : pick(dupesOptions(n), r.dupes)],
    [n > 2 ? t('rules.sumFailGroup', 'Missed encounter costs the group') : t('rules.sumFail', 'Missed encounter costs the pair'), on(r.failKillsPair)],
    [t('nzr.shiny', 'Shiny clause'), on(r.shinyClause)],
    [t('nzr.gifts', 'Gifts & eggs'), pick(giftOptions(), r.gifts === 'free' ? 'free' : 'area')],
    [t('nzr.caps', 'Level caps'), on(r.levelCaps)],
    [t('rules.sumCheats', 'Cheats (Rare Candies)'), r.cheats ? t('rules.sumAllowed', 'Allowed') : t('rules.off', 'Off')],
    [t('lives.title', 'Lives'), lives],
    [t('rules.sumTypeHelp', 'Type matchup help'), on(r.typeHelp !== false)],
  ];
  return html`<dl class="rule-summary">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}
