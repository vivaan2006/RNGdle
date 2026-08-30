// RNGparty drinking rules.
//
// Loaded by BOTH the browser (<script>) and the server (import), so the rules
// exist in exactly one place — the server needs them to drive the give-out /
// drink-up phases, and the clients need them to render what you owe.
//
// An effect is: who drinks, how much, and why.
//   target 'self'     — the roller drinks
//   target 'choose'   — the roller picks someone (phones get a picker)
//   target 'others'   — everyone except the roller
//   target 'everyone' — the whole table, roller included
//   alsoSelf          — a 'choose' effect where the roller drinks too
(function (global) {

  // Exactly one of these fires per roll, from the card's rarity.
  const RARITY = {
    trash:    { label: 'Absolute disaster',        emoji: '🗑️', amount: 1, unit: 'shot', target: 'self' },
    common:   { label: 'Painfully average',        emoji: '🥱', amount: 1, unit: 'sip',  target: 'self' },
    uncommon: null,                             // respectable enough to be spared
    rare:     { label: "Now we're talking",        emoji: '🔥', amount: 1, unit: 'sip',  target: 'choose' },
    epic:     { label: 'EPIC — hand out sips',     emoji: '💜', amount: 2, unit: 'sip',  target: 'choose' },
    anomaly:  { label: 'ANOMALY — everyone else drinks', emoji: '🌀', amount: 2, unit: 'sip',  target: 'others' },
    mythic:   { label: 'MYTHIC — shots all round', emoji: '👑', amount: 1, unit: 'shot', target: 'everyone' }
  };

  // Bonus rules, keyed to real badge ids. Deliberately picked from the 1–5%
  // band: anything that fires on half of all rolls (ODD/EVEN are literally
  // "divisible by 2 or not") stops being a moment and just becomes a tax.
  const BADGE_RULES = [
    { id: 'NICE',              label: 'Nice.',                     emoji: '😏', amount: 1, unit: 'sip',  target: 'everyone' },
    { id: 'MEANING',           label: 'The answer to everything',  emoji: '🌌', amount: 2, unit: 'sip',  target: 'choose' },
    { id: 'SIXTY_SEVEN',       label: 'Six… seven',                emoji: '🔢', amount: 1, unit: 'sip',  target: 'choose' },
    { id: 'BLACKJACK',         label: 'Blackjack — digits hit 21', emoji: '🃏', amount: 2, unit: 'sip',  target: 'choose' },
    { id: 'SNAKE_EYES',        label: 'Snake eyes',                emoji: '🐍', amount: 2, unit: 'sip',  target: 'self' },
    { id: 'HIGH_ROLLER',       label: 'High roller',               emoji: '🎩', amount: 2, unit: 'sip',  target: 'choose' },
    { id: 'LOW_BALL',          label: 'Low ball — sad digits',     emoji: '🐛', amount: 2, unit: 'sip',  target: 'self' },
    { id: 'QUADS',             label: 'Four of a kind',            emoji: '🍀', amount: 4, unit: 'sip',  target: 'choose' },
    { id: 'CONTIGUOUS_TRIPS',  label: 'Triple threat',             emoji: '🎰', amount: 3, unit: 'sip',  target: 'choose' },
    { id: 'EIGHTY_SIX',        label: "You're 86'd",               emoji: '🚫', amount: 1, unit: 'sip',  target: 'choose' },
    { id: 'DEEP_VOID',         label: 'Stared into the void',      emoji: '🕳️', amount: 1, unit: 'sip',  target: 'self' },
    { id: 'THREE_PAIR',        label: 'Three pairs, three drinks', emoji: '👯', amount: 3, unit: 'sip',  target: 'choose' },
    { id: 'PALINDROME',        label: 'Mirror match — shots together', emoji: '🪞', amount: 1, unit: 'shot', target: 'choose', alsoSelf: true },
    // the bookends family: pick someone and drink alongside them
    { id: 'BOOKENDS',          label: 'Bookends — drink with me',      emoji: '📚', amount: 2, unit: 'sip', target: 'choose', alsoSelf: true },
    { id: 'MIRROR_BOOKENDS',   label: 'Mirror bookends — drink with me', emoji: '🔁', amount: 2, unit: 'sip', target: 'choose', alsoSelf: true },
    { id: 'PAIRED_BOOKENDS',   label: 'Paired bookends — drink with me', emoji: '🎎', amount: 2, unit: 'sip', target: 'choose', alsoSelf: true },
    { id: 'SEQUENCE_4',        label: 'Little waterfall',          emoji: '💧', amount: 1, unit: 'sip',  target: 'everyone' },
    { id: 'SEQUENCE_6',        label: 'WATERFALL',                 emoji: '🌊', amount: 2, unit: 'sip',  target: 'everyone' }
  ];

  // Fired from the round context rather than the roll itself.
  const TOP_DOG  = { label: 'Top roll of the round',    emoji: '🏆', amount: 2, unit: 'sip', target: 'choose' };
  const BOTTOM   = { label: 'Worst roll of the round',  emoji: '🪣', amount: 1, unit: 'sip', target: 'self' };

  // Nobody needs eleven shots because the dice were funny.
  const CAP = { shot: 3, sip: 8 };

  /* How hard the table is drinking. `mult` scales every amount; `skip` drops
     whole rules. Tuned by simulation against sips-per-person-per-round:
     easy ~1-1.5, medium ~3, hard ~4-5. */
  const DIFFICULTY = {
    easy:   { label: 'Easy',   mult: 0.5, skip: ['rarity:common', 'ctx:bottom'] },
    medium: { label: 'Medium', mult: 1,   skip: [] },
    hard:   { label: 'Hard',   mult: 1.8, skip: [] }
  };
  const scaleAmount = (n, mult) => Math.max(1, Math.round(n * mult));

  /**
   * Effects owed for one roll.
   * @param result  a full RNGDLE.roll() result
   * @param ctx     { isHighest, isLowest, soloPlayer } — soloPlayer drops rules
   *                that need someone else to point at
   */
  function effectsFor(result, ctx) {
    ctx = ctx || {};
    const diff = DIFFICULTY[ctx.difficulty] || DIFFICULTY.medium;
    const out = [];
    const push = (key, r) => {
      if (diff.skip.indexOf(key) !== -1) return;
      out.push({
        key, label: r.label, emoji: r.emoji, amount: scaleAmount(r.amount, diff.mult),
        unit: r.unit, target: r.target, alsoSelf: !!r.alsoSelf
      });
    };

    const rarity = RARITY[result.cardRarity];          // null tiers (uncommon) owe nothing
    if (rarity) push('rarity:' + result.cardRarity, rarity);

    const earned = new Set((result.badges || []).map(b => b.id));
    for (const rule of BADGE_RULES) if (earned.has(rule.id)) push('badge:' + rule.id, rule);

    if (ctx.isHighest) push('ctx:top', TOP_DOG);
    if (ctx.isLowest)  push('ctx:bottom', BOTTOM);

    // With nobody to hand a drink to, 'choose'/'others' would stall the round.
    if (ctx.soloPlayer) {
      return out.filter(e => e.target === 'self' || e.target === 'everyone')
                .map(e => (e.alsoSelf ? Object.assign({}, e, { alsoSelf: false }) : e));
    }
    return out;
  }

  /** Does this effect need the roller to name someone? */
  const needsTarget = e => e.target === 'choose';

  /**
   * Fold every player's effects into "what each person actually drinks".
   * @param rolls   [{ pid, name, effects }]
   * @param choices { "pid:effectIndex": targetPid }
   * @param pids    every player id at the table
   * @returns { pid: { sips, shots, lines:[{emoji,label,from,amount,unit}] } }
   */
  function buildTally(rolls, choices, pids) {
    const tally = {};
    for (const pid of pids) tally[pid] = { sips: 0, shots: 0, lines: [] };

    const add = (pid, e, fromName) => {
      const t = tally[pid];
      if (!t) return;
      t.lines.push({ emoji: e.emoji, label: e.label, from: fromName, amount: e.amount, unit: e.unit });
      if (e.unit === 'shot') t.shots += e.amount; else t.sips += e.amount;
    };

    for (const roll of rolls) {
      roll.effects.forEach((e, i) => {
        if (e.target === 'self') add(roll.pid, e, null);
        else if (e.target === 'everyone') for (const pid of pids) add(pid, e, roll.name);
        else if (e.target === 'others') for (const pid of pids) { if (pid !== roll.pid) add(pid, e, roll.name); }
        else if (e.target === 'choose') {
          const to = choices[roll.pid + ':' + i];
          if (to) add(to, e, roll.name);
          if (e.alsoSelf) add(roll.pid, e, null);
        }
      });
    }

    for (const pid of pids) {
      tally[pid].shots = Math.min(tally[pid].shots, CAP.shot);
      tally[pid].sips  = Math.min(tally[pid].sips,  CAP.sip);
    }
    return tally;
  }

  /** "2 sips + 1 shot" / "Nothing this round 🎉" */
  function describe(t) {
    if (!t || (!t.sips && !t.shots)) return null;
    const bits = [];
    if (t.shots) bits.push(t.shots + ' shot' + (t.shots === 1 ? '' : 's'));
    if (t.sips)  bits.push(t.sips  + ' sip'  + (t.sips  === 1 ? '' : 's'));
    return bits.join(' + ');
  }

  global.RNGPARTY_DRINKS = { effectsFor, needsTarget, buildTally, describe, RARITY, BADGE_RULES, CAP, DIFFICULTY };

})(typeof window !== 'undefined' ? window : globalThis);
