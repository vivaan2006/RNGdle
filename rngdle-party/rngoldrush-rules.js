// RNGold Rush wheel, rarity and settings rules.
//
// Loaded by BOTH the browser (<script>) and the server (import), so the odds
// exist in exactly one place: the server draws from the wheel, every client
// renders the same percentages and tile colours for it, and the local party
// mode — which runs the whole game in the browser — plays by identical rules
// instead of its own drifting copy.
//
// The wheel is weights, not a deck. It's rebuilt for every spin from the tick
// number and the current pot, which is what lets skulls creep in over the
// course of a round and lets the pot-multiplier tiles disappear when there's
// no pot to multiply. Nothing is drawn "without replacement" any more — the
// escalation comes from the skull weight climbing, which is both easier to
// reason about and honest to show as a percentage.
(function (global) {
  'use strict';

  /* Six rarity bands across the gold tiles. The hues deliberately follow
     RNGdle's own rarity ladder (grey -> green -> blue -> purple -> orange ->
     red) so a player who knows one game reads the other at a glance, but
     saturated for this game's dark tiles rather than RNGdle's pastel card
     backgrounds. `weight` is per *value*, so how much of the wheel a tier
     really owns also depends on how many numbers land in its band. */
  const TIERS = [
    { key:'common',    label:'Common',    color:'#9ca3af', weight:100 },
    { key:'uncommon',  label:'Uncommon',  color:'#34d399', weight:55  },
    { key:'rare',      label:'Rare',      color:'#60a5fa', weight:28  },
    { key:'epic',      label:'Epic',      color:'#c084fc', weight:12  },
    { key:'legendary', label:'Legendary', color:'#fb923c', weight:4   },
    { key:'mythic',    label:'Mythic',    color:'#f87171', weight:1   },
  ];

  /* The specials sit outside the rarity ladder and can't win a fight for hues
     with it: the ladder already owns grey, green, blue, purple, orange and red,
     so ×2's green landed on uncommon's, ½'s amber on legendary's, and the
     skull's red on mythic's — death reading as the jackpot. They keep the
     colours that mean something (green good, amber bad, bone dead) and are told
     apart from gold by shape instead: see .reeltile.special in rngoldrush.html,
     where a special is a solid block and a gold tile is an outline. */
  const SPECIAL_COLORS = { x2:'#22c55e', half:'#f59e0b', bust:'#f1f5f9' };

  // ×2 and ½ each hold this flat percentage of the wheel, spin after spin.
  // They're seasoning, not an escalation — the skull is the only thing that
  // climbs. Expressed as a share of the whole wheel rather than of the gold
  // tiles, because the skull weight grows underneath them: as a share of gold
  // they read as 5.8% on spin 1 and decay to 1.2% by spin 26, squeezed out by
  // a rising skull rather than by any decision to thin them.
  const SPECIAL_PCT = 5;
  // Gold never gets squeezed off the wheel entirely: at extreme skull odds the
  // specials give way instead, so there's always something worth winning.
  const MIN_GOLD_SHARE = 0.05;
  const SKULL_CAP_PCT = 90;   // however long a round runs, never a certain skull

  /* The host-configurable knobs, as data so both settings panels (the room
     leader's phone and the local-party setup screen) can render themselves
     from one list and stay in step. */
  const SETTINGS = [
    { key:'skullsToEnd', label:'Skulls to end the round', min:1, max:6, step:1, def:3,
      help:'Skulls before the last one are just strikes — the pot survives them.' },
    { key:'skullStartPct', label:'Skull chance on spin 1', min:0, max:40, step:1, def:5, unit:'%',
      help:'Deliberately low, so the first few spins are nearly free.' },
    { key:'skullGrowthPct', label:'Extra skull chance per spin', min:0, max:20, step:1, def:3, unit:'%',
      help:'Added every spin, so the wheel fills with skulls the longer you push.' },
    { key:'maxNumber', label:'Highest gold tile', min:6, max:60, step:1, def:30,
      help:'Gold tiles run 1 to this, split evenly across the six rarities.' },
    { key:'startPotPerPlayer', label:'Starting pot per player', min:0, max:10, step:1, def:1,
      help:'Seeded when the round begins, so there is something on the table from the first spin.' },
  ];

  function defaults(){
    const out={}; for(const s of SETTINGS) out[s.key]=s.def; return out;
  }
  /** Settings arrive from a client, so every field is clamped and anything
      unrecognised is dropped — never trust the phone that sent them. */
  function clampSettings(raw){
    const out=defaults();
    if(raw && typeof raw==='object'){
      for(const s of SETTINGS){
        const v=Number(raw[s.key]);
        if(Number.isFinite(v)) out[s.key]=Math.min(s.max, Math.max(s.min, Math.round(v)));
      }
    }
    return out;
  }

  /** Which rarity a gold tile's value falls in: the 1..maxNumber range split
      into six even bands, so the tiers scale with a changed number range. */
  function tierOf(value, maxNumber){
    const i=Math.min(TIERS.length-1, Math.floor((value-1)*TIERS.length/maxNumber));
    return TIERS[Math.max(0,i)];
  }
  /** The span of values in a tier. The odds bar deliberately doesn't show
      this — rarity and chance are what a player reads — but it's the clearest
      way to assert the bands actually partition the range. */
  function tierRange(tierKey, maxNumber){
    let lo=null, hi=null;
    for(let v=1;v<=maxNumber;v++){
      if(tierOf(v,maxNumber).key===tierKey){ if(lo===null) lo=v; hi=v; }
    }
    return {lo,hi};
  }

  /** What the pot is seeded with when a round begins. A round that opened on an
      empty pot had nothing to cash out and nothing for ×2 or ½ to act on, so
      the first spin or two were dead weight. */
  function startingPot(playerCount, settings){
    return Math.max(0, playerCount|0) * clampSettings(settings).startPotPerPlayer;
  }

  /** What one player takes when they cash out: an equal share of the pot across
      everyone who was still in for this spin — including the players cashing
      out, and including the ones pushing on. Not the whole pot, and not a split
      between the leavers alone; whatever the leavers don't take stays on the
      table for whoever stayed. So three of four players pushing on keep three
      quarters of the pot rather than watching one player walk off with it. */
  function cashOutShare(pot, playersIn){
    return Math.floor(Math.max(0, pot|0) / Math.max(1, playersIn|0));
  }

  /** Chance of a skull on the spin after `tick` completed spins. */
  function skullChance(tick, settings){
    const s=clampSettings(settings);
    const pct=Math.min(SKULL_CAP_PCT, s.skullStartPct + s.skullGrowthPct*Math.max(0,tick));
    return pct/100;
  }

  /** The wheel for the next spin: every face and its weight. */
  function buildWheel(opts){
    const s=clampSettings(opts && opts.settings);
    const tick=Math.max(0,(opts&&opts.tick)|0), pot=Math.max(0,(opts&&opts.pot)|0);
    const entries=[];
    let goldTotal=0;
    for(let v=1;v<=s.maxNumber;v++){
      const t=tierOf(v,s.maxNumber);
      entries.push({ key:'n'+v, type:'number', value:v, tier:t.key, weight:t.weight });
      goldTotal+=t.weight;
    }
    /* Both the skull's share and the specials' are solved back from the
       percentages they're meant to be, rather than set as raw weights and
       whatever falls out. Set as weights, every share moves whenever any other
       one does — which is how ×2 and ½ ended up quietly decaying as the skull
       climbed. Here the gold tiles absorb all the movement instead, so the
       settings percentage and the specials' 5% are both exactly what the odds
       bar shows, on every spin of the round. */
    const q=skullChance(tick,s);
    // ×2 and ½ both act on the pot, so with an empty pot they're pure no-ops —
    // a dead spin that still costs the table the full reel animation. They come
    // off the wheel entirely until there's gold for them to act on.
    let p = pot>0 ? SPECIAL_PCT/100 : 0;
    if(q + 2*p > 1 - MIN_GOLD_SHARE) p = Math.max(0, (1 - MIN_GOLD_SHARE - q)/2);
    const total = goldTotal/(1 - 2*p - q);
    if(p>0){
      entries.push({ key:'x2',   type:'x2',   weight:p*total });
      entries.push({ key:'half', type:'half', weight:p*total });
    }
    entries.push({ key:'bust', type:'bust', weight:q*total });
    return { entries, total, settings:s, tick, pot };
  }

  /** Weighted pick. rnd is injectable so tests can make a wheel deterministic. */
  function drawTile(wheel, rnd){
    let r=(rnd||Math.random)()*wheel.total;
    for(const e of wheel.entries){
      r-=e.weight;
      if(r<=0) return e.type==='number' ? {type:'number',value:e.value,tier:e.tier} : {type:e.type};
    }
    const last=wheel.entries[wheel.entries.length-1];
    return last.type==='number' ? {type:'number',value:last.value,tier:last.tier} : {type:last.type};
  }

  /** The wheel collapsed to display rows — gold tiles grouped by rarity, then
      the specials. This is what replaced the old "how many tiles are left"
      counts: with a wheel that changes every spin, a percentage is the only
      honest thing to show. */
  function wheelOdds(wheel){
    const rows=[], byTier={};
    for(const e of wheel.entries) if(e.type==='number') byTier[e.tier]=(byTier[e.tier]||0)+e.weight;
    for(const t of TIERS){
      if(!byTier[t.key]) continue;
      rows.push({ key:t.key, label:t.label, color:t.color, tier:t.key,
                  pct: byTier[t.key]/wheel.total*100 });
    }
    const w=k=>{ const e=wheel.entries.find(x=>x.key===k); return e?e.weight:0; };
    if(w('x2'))   rows.push({ key:'x2',   label:'✨ ×2',   color:SPECIAL_COLORS.x2,   pct:w('x2')/wheel.total*100 });
    if(w('half')) rows.push({ key:'half', label:'➗ ½',    color:SPECIAL_COLORS.half, pct:w('half')/wheel.total*100 });
    rows.push({ key:'bust', label:'💀 Skull', color:SPECIAL_COLORS.bust, pct:w('bust')/wheel.total*100 });
    return rows;
  }

  /** Percentages small enough to round to 0% still matter to a player deciding
      whether to push, so those keep a decimal instead of vanishing. */
  function formatPct(pct){
    if(pct>=9.5) return Math.round(pct)+'%';
    if(pct>=0.95) return pct.toFixed(1).replace(/\.0$/,'')+'%';
    return pct<0.05 ? '<0.1%' : pct.toFixed(1)+'%';
  }

  global.RNGPARTY_GOLDRUSH = {
    TIERS, SETTINGS, SPECIAL_PCT, SKULL_CAP_PCT, SPECIAL_COLORS,
    defaults, clampSettings, tierOf, tierRange, skullChance, startingPot, cashOutShare,
    buildWheel, drawTile, wheelOdds, formatPct,
  };

})(typeof window !== 'undefined' ? window : globalThis);
