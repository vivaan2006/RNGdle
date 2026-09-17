// Irish Poker rules and reveal timing.
//
// Loaded by BOTH the browser (<script>) and the server (import). The server is
// the dealer: it auto-advances the game, and every hold it waits out has to
// outlast the reveal the screens are playing. Keeping the timeline here means
// the server and every client read the same numbers, so a phone can never be
// mid-flip while the server has already moved on.
(function (global) {
  'use strict';

  const HAND_SIZE = 4, MIN_PLAYERS = 2, MAX_PLAYERS = 10;
  const INTENSITY = { sipping:1, drinking:2, hammered:3 };
  const RANKS = [2,3,4,5,6,7,8,9,10,11,12,13,14];

  // A right guess is safe. A wrong guess drinks the round's sips; landing on
  // the post (round 2's tie, round 3's boundary) drinks double.
  const ROUNDS = [
    { key:'color', options:['red','black'],      wrong:1 },
    { key:'hilo',  options:['higher','lower'],   wrong:2 },
    { key:'inout', options:['inside','outside'], wrong:3 },
    { key:'suit',  options:['s','h','d','c'],    wrong:4 },
  ];

  // Bottom row first. `finish` = the holder picks someone to finish their drink.
  const LEVELS = [
    { level:4, cards:4, sips:1 },
    { level:3, cards:3, sips:2 },
    { level:2, cards:2, sips:3 },
    { level:1, cards:1, finish:true },
  ];
  const SIDE_BET_SIPS = 1;

  /* Every number is milliseconds after the state's stepAt. The client plays
     the reveal on this timeline; the server's auto-dealer waits the matching
     *_HOLD / *_BREAK before it moves on. */
  const TIMING = {
    // round reveal: drumroll, then each seat flips in turn and gets stamped
    R_SUS:1900, R_STAG:1150, R_STAMP:650, R_TAIL:900,
    DRINK_BREAK:9000,          // after a round's reveal, before the next deal
    // pyramid
    PYR_INTRO:3800,            // "the pyramid is set" before the first flip
    P_SUS:1500, P_SUS_BURN:950, P_BURN_MSG:2350, P_CLAIM_UI:2500,
    P_BURN_MSG_AGAIN:1800,     // a second burn in a row gets to the point faster
    BURN_AFTER:1950,           // burn animation plays out before the replacement card
    RES_START:450, RES_STEP:1150,
    RESULT_BREAK:6500,         // after the hand-out reveal, before the next flip
    FINISH_BREAK:11000,        // the top card gets longer: someone is chugging
    DEAD_AFTER:2800,           // a card nobody holds that can't be replaced stays up this long
    // rider reveal: every seat's leftover count lands in turn, the rider last
    RIDER_SUS:1200, RIDER_STEP:750, RIDER_TAIL:900, RIDER_HOLD:5200,
    // bus
    BUS_SUS:1700, BUS_VERDICT:2650, BUS_UI:3200, BUS_DEAL:650, BUS_DEAL_UI:1450,
    BUS_MISS_BREAK:4500,       // after a miss's verdict: drink, then a fresh deal
    BUS_DONE_HOLD:8000,        // celebration before the final summary
    READY_MIN:400,             // everyone tapped ready: move on almost at once
  };

  function burnMsgMs(burns){ return burns ? TIMING.P_BURN_MSG_AGAIN : TIMING.P_BURN_MSG; }
  /** How long a burned card stays up. `burns` = cards already burned from this slot. */
  function burnHoldMs(burns){ return burnMsgMs(burns) + TIMING.BURN_AFTER; }
  /** Gap between seats flipping. Big tables flip faster so a round never drags. */
  function roundStagger(players){ return players<=4 ? TIMING.R_STAG : Math.max(650, Math.round(4600/players)); }
  function roundFlipAt(players, i){ return TIMING.R_SUS + i*roundStagger(players); }
  function deadHoldMs(burns){ return burnMsgMs(burns) + TIMING.DEAD_AFTER; }
  function riderRevealMs(players){ return TIMING.RIDER_SUS + players*TIMING.RIDER_STEP + TIMING.RIDER_TAIL; }
  function roundRevealMs(players){ return TIMING.R_SUS + players*roundStagger(players) + TIMING.R_STAMP + TIMING.R_TAIL; }
  /** Distinct giver→receiver lines the result reveal steps through. */
  function resultLineCount(result){
    if(!result) return 0;
    return result.finishes.length + new Set(result.gives.map(g=>g.from+'>'+g.to)).size;
  }
  function resultRevealMs(result){ return TIMING.RES_START + resultLineCount(result)*TIMING.RES_STEP + 300; }

  const isRed = c => c.s==='h' || c.s==='d';

  /** Judge a round-N guess (1-based) against a hand. Returns 'right' | 'wrong' | 'post'. */
  function judgeGuess(round, cards, guess){
    const a=cards[0], b=cards[1], c=cards[2], d=cards[3];
    if(round===1) return (isRed(a)?'red':'black')===guess ? 'right' : 'wrong';
    if(round===2){
      if(b.r===a.r) return 'post';
      return (b.r>a.r ? 'higher' : 'lower')===guess ? 'right' : 'wrong';
    }
    if(round===3){
      const lo=Math.min(a.r,b.r), hi=Math.max(a.r,b.r);
      if(c.r===lo || c.r===hi) return 'post';
      return (c.r>lo && c.r<hi ? 'inside' : 'outside')===guess ? 'right' : 'wrong';
    }
    return d.s===guess ? 'right' : 'wrong';
  }

  /** Sips a verdict costs the guesser. Right guesses are free. */
  function roundSips(round, verdict, mult){
    if(verdict==='right') return 0;
    return ROUNDS[round-1].wrong*mult*(verdict==='post'?2:1);
  }

  /** The 10 pyramid slots in flip order: bottom row left→right, then up. */
  function pyramidSlots(){
    const out=[];
    for(const L of LEVELS) for(let col=0; col<L.cards; col++)
      out.push({ level:L.level, col, sips:L.sips||0, finish:!!L.finish, card:null, burned:[] });
    return out;
  }

  /** Who holds a rank, and how many copies each. */
  function holdersFor(players, rank){
    return players.map(p=>({ pid:p.pid, count:p.cards.filter(c=>c.r===rank).length })).filter(h=>h.count>0);
  }

  /** Validate one holder's hand-out. Returns a normalised {sips:{pid:n}} / {finish:[pid]} or null. */
  function validateAssignment(slot, count, fromPid, dealtPids, m){
    const others=new Set(dealtPids.filter(id=>id!==fromPid));
    if(!m || !others.size) return null;
    if(slot.finish){
      if(!Array.isArray(m.finish) || m.finish.length!==count) return null;
      if(!m.finish.every(id=>others.has(id))) return null;
      return { finish:m.finish.slice() };
    }
    if(!m.sips || typeof m.sips!=='object') return null;
    let total=0; const sips={};
    for(const id of Object.keys(m.sips)){
      const n=m.sips[id];
      if(!others.has(id) || !Number.isInteger(n) || n<0) return null;
      if(n>0){ sips[id]=n; total+=n; }
    }
    return total===slot.sips*count ? { sips } : null;
  }

  /**
   * Pick the rank for pyramid slot `idx`. No rank ever appears twice in a
   * pyramid — burned ranks included, since nobody holds them anyway.
   *
   * A card nobody holds is burned and replaced, but only while there are spare
   * ranks to burn (13 ranks, 10 slots). Once they're gone a card nobody holds
   * stays on the pyramid and nobody drinks. One held rank is kept back for the
   * top card, so somebody always has to finish their drink.
   *
   * o = { idx, used:[ranks already on the pyramid or burned], held:[ranks in play hands], reserve }
   * Returns { rank, kind:'held'|'burn'|'dead', reserve }.
   */
  function drawPyramidRank(o){
    const rand=o.rand||Math.random, slots=o.slots||10;
    const used=new Set(o.used||[]), held=new Set(o.held||[]);
    const unused=RANKS.filter(r=>!used.has(r));
    const top=o.idx>=slots-1, spare=unused.length-(slots-o.idx);
    const any=list=>list[Math.floor(rand()*list.length)];
    let reserve=o.reserve!=null && held.has(o.reserve) && !used.has(o.reserve) ? o.reserve : null;
    if(!top && reserve==null){ const h=unused.filter(r=>held.has(r)); reserve=h.length ? any(h) : null; }
    const cand = top ? unused : unused.filter(r=>r!==reserve);
    const rank=any(cand);
    if(held.has(rank)) return { rank, kind:'held', reserve };
    if(spare>0) return { rank, kind:'burn', reserve };
    const heldCand=cand.filter(r=>held.has(r));
    if(top && heldCand.length) return { rank:any(heldCand), kind:'held', reserve };
    return { rank, kind:'dead', reserve };
  }

  const cardsLeft = p => HAND_SIZE-p.played.filter(Boolean).length;
  /**
   * Who rides the bus. Never chance: whoever has the most cards they never got
   * to play in the pyramid. Ties go to most wrong guesses, then to whoever has
   * drunk the least so far. Anyone still tied after that rides too, in turn.
   * Returns { pids:[...in riding order], reason:'cardsLeft'|'wrong'|'sips'|'tied', left }.
   */
  function pickRider(players){
    if(!players.length) return { pids:[], reason:'none', left:0 };
    const topLeft=Math.max(...players.map(cardsLeft));
    let pool=players.filter(p=>cardsLeft(p)===topLeft);
    const done=reason=>({ pids:pool.map(p=>p.pid), reason, left:topLeft });
    if(pool.length===1) return done('cardsLeft');
    const topWrong=Math.max(...pool.map(p=>p.wrong||0));
    pool=pool.filter(p=>(p.wrong||0)===topWrong);
    if(pool.length===1) return done('wrong');
    const least=Math.min(...pool.map(p=>p.sipsTaken||0));
    pool=pool.filter(p=>(p.sipsTaken||0)===least);
    if(pool.length===1) return done('sips');
    return done('tied');
  }

  global.RNGPARTY_IRISHPOKER = {
    HAND_SIZE, MIN_PLAYERS, MAX_PLAYERS, INTENSITY, RANKS, ROUNDS, LEVELS, BUS_CARDS:4,
    SIDE_BET_SIPS, TIMING,
    burnMsgMs, burnHoldMs, deadHoldMs, riderRevealMs, roundStagger, roundFlipAt, roundRevealMs, resultLineCount, resultRevealMs,
    isRed, judgeGuess, roundSips, pyramidSlots, holdersFor, validateAssignment, drawPyramidRank, cardsLeft, pickRider,
  };
})(typeof window !== 'undefined' ? window : globalThis);
