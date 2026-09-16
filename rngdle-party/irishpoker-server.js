// Irish Poker — online-only card drinking game, server-side room logic.
// Fully independent from the other games: own Map, own message types, own
// WebSocket path (/irishpoker-ws). The only thing shared is the HTTP process
// and the room-code registry.
//
// Same shape as RNGold Rush: the host screen is a pure spectator (the TV),
// and the room "leader" — whoever's been connected longest — paces the game
// from their phone. Every decision happens on phones.
//
// A game runs in four acts:
//
//   1. THE DEAL (rounds 1-4). Everyone gets four face-down cards. Each round
//      everyone locks a guess about their next card at the same time —
//      red/black, higher/lower, inside/outside, then the suit — along with who
//      drinks if they're right. All cards flip together. Right = give the
//      round's sips to your pick. Wrong = drink them. Landing exactly on a
//      boundary card ("the post") = drink double.
//
//   2. MEMORIZE. Everyone's hand is shown for a few seconds, then every card
//      goes face-down for the rest of the game.
//
//   3. GIVE & TAKE. Eight cards sit in two rows (take row / give row, worth
//      1-4 each) and flip alternately: take 1, give 1, take 2, give 2, ...
//      A TAKE card is automatic — anyone holding that rank drinks per match.
//      A GIVE card opens a claim window: anyone can say "I've got one" and
//      point at someone. That's a bluffing game — the target either drinks,
//      or calls bluff, and whoever's wrong drinks double. Hands stay hidden
//      (memory mode), so even honest claims can be wrong. Peeking costs a sip.
//
//   4. RIDE THE BUS (mandatory). Whoever matched the most pyramid cards
//      rides. A row of cards is dealt with the first one face up; the rider
//      calls higher/lower through the row. Any miss (a tie is a miss) means
//      drink for how far they got and a fresh deal. Spectators can place side
//      bets on each call. A small, deliberately quiet "skip the bus" escape
//      exists for when someone's genuinely had enough.
//
// No private state ever leaves the server early: unflipped cards, how anyone
// guessed, and whether a claim is honest stay here until they're resolved.

import { claimCode, releaseCode } from "./rooms-registry.js";

const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];

// ---- tunable constants ----
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;             // 10 hands + 8 pyramid cards fits one 52-card deck
const HAND_SIZE = 4;
const PYRAMID_VALUES = [1,2,3,4];
const RECONNECT_GRACE_MS = 45000;
const EMPTY_ROOM_TTL_MS = 10*60*1000; // nobody connected at all for this long -> room is torn down
const GUESS_MS    = 45000;          // undecided players get a random guess + random target
const CLAIM_MS    = 30000;          // no answer = pass
const CALL_MS     = 25000;          // no answer = drink
const MEMORIZE_MS = 15000;
const BUS_FINISH_HOLD_MS = 4500;    // leave the completed bus on screen before the summary
const PEEK_SIPS = 1;
const SIDE_BET_SIPS = 1;

export const INTENSITY = { sipping:1, drinking:2, hammered:3 };
export const BUS_LENGTHS = [4,5,6];

// Sips are per-round base values, multiplied by the intensity setting.
// Suit is the long shot (25%), so it pays out big but punishes gently.
export const ROUNDS = [
  { key:'color', options:['red','black'],          wrong:1, give:1 },
  { key:'hilo',  options:['higher','lower'],       wrong:2, give:2 },
  { key:'inout', options:['inside','outside'],     wrong:3, give:3 },
  { key:'suit',  options:['s','h','d','c'],        wrong:2, give:4 },
];

// ---- cards ----
const SUITS = ['s','h','d','c'];
export function newDeck(){ const d=[]; for(const s of SUITS) for(let r=2;r<=14;r++) d.push({r,s}); return d; }
export function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
export function isRed(card){ return card.s==='h' || card.s==='d'; }
const RANK_NAMES = {11:'J',12:'Q',13:'K',14:'A'};
export function rankLabel(r){ return RANK_NAMES[r] || String(r); }

/** Judge a round-N guess (1-based) against a hand. Returns 'right' | 'wrong' | 'post'. */
export function judgeGuess(round, cards, guess){
  const [a,b,c,d] = cards;
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

/** Sips owed for a verdict: right = sips given away, wrong/post = sips drunk. */
export function roundSips(round, verdict, mult){
  const def=ROUNDS[round-1];
  if(verdict==='right') return def.give*mult;
  return def.wrong*mult*(verdict==='post'?2:1);
}

/** Higher/lower on the bus. A tie is always a miss. */
export function judgeBus(current, next, guess){
  if(next.r===current.r) return 'post';
  return (next.r>current.r ? 'higher' : 'lower')===guess ? 'right' : 'wrong';
}

/** Alternating flip order through the two rows, escalating: take 1, give 1, take 2, give 2, ... */
export function pyramidOrder(cards){
  const out=[];
  PYRAMID_VALUES.forEach((value,i)=>{
    out.push({ row:'take', value, card:cards[i*2] });
    out.push({ row:'give', value, card:cards[i*2+1] });
  });
  return out;
}

/** Who rides: most pyramid matches, then most wrong guesses, then the deck decides. */
export function pickRider(players){
  if(!players.length) return { pid:null, reason:'none' };
  const topMatches=Math.max(...players.map(p=>p.matches));
  let pool=players.filter(p=>p.matches===topMatches);
  if(pool.length===1) return { pid:pool[0].pid, reason:'matches' };
  const topWrong=Math.max(...pool.map(p=>p.wrong));
  pool=pool.filter(p=>p.wrong===topWrong);
  if(pool.length===1) return { pid:pool[0].pid, reason:'wrong' };
  return { pid:pick(pool).pid, reason:'random' };
}

// ---- rooms ----
const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }

function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }

function defaultSettings(){ return { intensity:'sipping', memory:true, busLength:5 }; }
function mult(room){ return INTENSITY[room.settings.intensity] || 1; }
function dealtPlayers(room){ return [...room.players.values()].filter(p=>p.dealt); }
function othersFor(room, p){ return dealtPlayers(room).filter(o=>o.pid!==p.pid); }

function freshStats(p){
  Object.assign(p, { dealt:false, cards:[], guess:null, lastTarget:p.lastTarget||null,
    sipsTaken:0, sipsGiven:0, correct:0, wrong:0, posts:0, matches:0,
    bluffsCaught:0, bluffsGotAway:0, callsWon:0, callsLost:0, peeks:0, betsWon:0, betsLost:0 });
}

function feed(room, text){ room.feed.push({ at:Date.now(), text }); if(room.feed.length>40) room.feed.shift(); }
function drink(room, p, sips){ if(!p || sips<=0) return; p.sipsTaken+=sips; room.stepDrinks[p.pid]=(room.stepDrinks[p.pid]||0)+sips; }
function give(room, from, to, sips){ if(from) from.sipsGiven+=sips; drink(room, to, sips); }

function clearTimer(room){ clearTimeout(room.timer); room.timer=null; room.deadline=null; }
function setTimer(room, ms, fn){
  clearTimer(room);
  room.deadline=Date.now()+ms;
  room.timer=setTimeout(()=>{ if(rooms.get(room.code)!==room) return; room.timer=null; room.deadline=null; fn(); }, ms);
}

// The leader is whoever's been connected longest. Only reassigned when the
// current leader actually drops; reconnecting doesn't reclaim it.
function reassignLeaderIfNeeded(room){
  const cur = room.leaderPid!=null ? room.players.get(room.leaderPid) : null;
  if(cur && cur.connected) return;
  const next=[...room.players.values()].find(p=>p.connected);
  room.leaderPid = next ? next.pid : null;
}

// ---- views ----
function visibleCardCount(room){
  if(room.phase==='guess') return room.round-1;
  if(room.phase==='reveal') return room.round;
  if(room.phase==='memorize' || room.phase==='gameOver') return HAND_SIZE;
  return 0;   // pyramid / busIntro / bus: every hand is face-down
}
function pyramidPublic(room){
  const y=room.pyr; if(!y) return null;
  return {
    idx:y.idx, step:y.step,
    slots:y.order.map((s,i)=>({ row:s.row, value:s.value, card: i<=y.idx ? s.card : null })),
    responded: y.step==='claims' ? [...y.responded] : null,
    claims: y.step==='calls' ? y.claims.map(c=>({ id:c.id, from:c.from, to:c.to, response:c.response })) : null,
    result:y.result,
  };
}
function busPublic(room){
  const b=room.bus; if(!b) return null;
  const shown = b.status==='guessing' ? b.pos+1 : b.status==='failed' ? b.pos+2 : b.length;
  return { length:b.length, attempt:b.attempt, pos:b.pos, status:b.status, bestRun:b.bestRun, totalSips:b.totalSips,
    cards:b.cards.map((c,i)=>i<shown?c:null),
    lastGuess:b.lastGuess, lastBets:b.lastBets, betCount:b.bets.size };
}
function stateMsg(room, viewer){
  const vis=visibleCardCount(room);
  const showMatches = ['busIntro','bus','gameOver'].includes(room.phase);
  const s = {
    type:"state", phase:room.phase, gameId:room.gameId, round:room.round, settings:room.settings,
    hostConnected:room.hostConnected, leaderPid:room.leaderPid,
    deadline:room.deadline, serverNow:Date.now(),
    roundResults: room.phase==='reveal' ? room.roundResults : null,
    stepDrinks: room.stepDrinks, feed: room.feed.slice(-12),
    pyramid: pyramidPublic(room), bus: busPublic(room),
    riderPid: room.riderPid, riderReason: room.riderReason, busSkipped: room.busSkipped,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, connected:p.connected, dealt:p.dealt,
      locked: room.phase==='guess' && p.dealt && !!p.guess,
      cards: p.dealt ? p.cards.map((c,i)=>i<vis?c:null) : [],
      sipsTaken:p.sipsTaken, sipsGiven:p.sipsGiven, correct:p.correct, wrong:p.wrong, posts:p.posts,
      matches: showMatches ? p.matches : null,
      bluffsCaught:p.bluffsCaught, callsWon:p.callsWon, callsLost:p.callsLost, peeks:p.peeks,
      betsWon:p.betsWon, betsLost:p.betsLost,
      bluffsGotAway: room.phase==='gameOver' ? p.bluffsGotAway : null,
    })),
  };
  if(viewer){
    const p=room.players.get(viewer);
    if(p){
      const me={ guess:p.guess, lastTarget:p.lastTarget };
      if(p.dealt && !room.settings.memory && ['pyramid','busIntro','bus'].includes(room.phase)) me.hand=p.cards;
      if(room.pyr && room.pyr.step==='claims') me.responded=room.pyr.responded.has(p.pid);
      if(room.pyr && room.pyr.step==='claims'){ const c=room.pyr.claims.find(c=>c.from===p.pid); me.claimedOn=c?c.to:null; }
      if(room.bus && room.bus.status==='guessing') me.bet=room.bus.bets.get(p.pid)||null;
      s.me=me;
    }
  }
  return s;
}
function pushState(room){
  if(room.hostWs) send(room.hostWs, stateMsg(room, null));
  for(const p of room.players.values()) if(p.ws) send(p.ws, stateMsg(room, p.pid));
}

// ---- act 1: the deal ----
function deal(room){
  clearTimer(room);
  pruneGone(room);
  const seats=[...room.players.values()].filter(p=>p.connected).slice(0,MAX_PLAYERS);
  if(seats.length<MIN_PLAYERS) return false;
  const deck=shuffle(newDeck());
  for(const p of room.players.values()) freshStats(p);
  for(const p of seats){ p.dealt=true; p.cards=deck.splice(0,HAND_SIZE); }
  room.pyr={ order:pyramidOrder(deck.splice(0,PYRAMID_VALUES.length*2)), idx:-1, step:'ready', claims:[], responded:new Set(), result:null };
  room.gameId++; room.round=1; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.bus=null; room.riderPid=null; room.riderReason=null; room.busSkipped=false;
  beginGuess(room);
  return true;
}
function beginGuess(room){
  room.phase='guess'; room.stepDrinks={};
  for(const p of dealtPlayers(room)) p.guess=null;
  setTimer(room, GUESS_MS, ()=>{ resolveGuesses(room); pushState(room); });
}
// Disconnected players never stall a round — they get auto-picked at resolve.
function allGuessed(room){ return dealtPlayers(room).every(p=>p.guess || !p.connected); }
function submitGuess(room, p, m){
  if(room.phase!=='guess' || !p.dealt || p.guess) return;
  const def=ROUNDS[room.round-1];
  if(!def.options.includes(m.value)) return;
  const target=room.players.get(m.target);
  p.guess={ value:m.value, target: target && target.dealt && target.pid!==p.pid ? target.pid : null };
  if(p.guess.target) p.lastTarget=p.guess.target;
  if(allGuessed(room)) resolveGuesses(room);
}
function resolveGuesses(room){
  if(room.phase!=='guess') return;
  clearTimer(room);
  const def=ROUNDS[room.round-1], x=mult(room);
  room.stepDrinks={};
  room.roundResults=dealtPlayers(room).map(p=>{
    let auto=false;
    if(!p.guess){ p.guess={ value:pick(def.options), target:null }; auto=true; }
    if(!p.guess.target){
      const others=othersFor(room,p);
      p.guess.target = others.length ? pick(others).pid : null;
    }
    const verdict=judgeGuess(room.round, p.cards, p.guess.value);
    const sips=roundSips(room.round, verdict, x);
    if(verdict==='right'){ p.correct++; give(room, p, room.players.get(p.guess.target), sips); }
    else { p.wrong++; if(verdict==='post') p.posts++; drink(room, p, sips); }
    if(auto) feed(room, `🎲 ${p.name} ran out of time — the deck guessed for them`);
    return { pid:p.pid, guess:p.guess.value, target:p.guess.target, verdict, sips, auto, card:p.cards[room.round-1] };
  });
  room.phase='reveal';
}
function nextFromReveal(room){
  if(room.phase!=='reveal') return;
  room.roundResults=null;
  if(room.round<ROUNDS.length){ room.round++; beginGuess(room); return; }
  room.phase='memorize'; room.stepDrinks={};
  setTimer(room, MEMORIZE_MS, ()=>{ beginPyramid(room); pushState(room); });
}

// ---- act 3: give & take ----
function beginPyramid(room){
  if(room.phase!=='memorize') return;
  clearTimer(room);
  room.phase='pyramid'; room.stepDrinks={};
  feed(room, '🙈 Cards are face-down — hope you were paying attention');
}
function flip(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || !(y.step==='ready'||y.step==='result') || y.idx>=y.order.length-1) return;
  y.idx++; room.stepDrinks={}; y.claims=[]; y.responded=new Set(); y.result=null;
  const slot=y.order[y.idx];
  const holders=dealtPlayers(room).map(p=>({ p, count:p.cards.filter(c=>c.r===slot.card.r).length })).filter(h=>h.count>0);
  holders.forEach(h=>{ h.p.matches+=h.count; });
  if(slot.row==='take'){
    const sipsEach=slot.value*mult(room);
    const takers=holders.map(h=>{ drink(room, h.p, sipsEach*h.count); return { pid:h.p.pid, count:h.count, sips:sipsEach*h.count }; });
    y.result={ row:'take', card:slot.card, value:slot.value, takers };
    y.step='result';
    return;
  }
  y.step='claims';
  setTimer(room, CLAIM_MS, ()=>{ endClaims(room); pushState(room); });
}
function allResponded(room){ return dealtPlayers(room).every(p=>room.pyr.responded.has(p.pid) || !p.connected); }
function submitClaim(room, p, m){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='claims' || !p.dealt || y.responded.has(p.pid)) return;
  if(m.pass===true){ y.responded.add(p.pid); }
  else {
    const target=room.players.get(m.target);
    if(!target || !target.dealt || target.pid===p.pid) return;
    const rank=y.order[y.idx].card.r;
    y.claims.push({ id:'c'+y.claims.length, from:p.pid, to:target.pid, response:null, truthful:p.cards.some(c=>c.r===rank) });
    y.responded.add(p.pid);
    p.lastTarget=target.pid;
  }
  if(allResponded(room)) endClaims(room);
}
function endClaims(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='claims') return;
  clearTimer(room);
  if(!y.claims.length){
    y.result={ row:'give', card:y.order[y.idx].card, value:y.order[y.idx].value, claims:[] };
    y.step='result';
    return;
  }
  y.step='calls';
  if(allCalled(room)){ endCalls(room); return; }
  setTimer(room, CALL_MS, ()=>{ endCalls(room); pushState(room); });
}
function allCalled(room){ return room.pyr.claims.every(c=>c.response || !room.players.get(c.to)?.connected); }
function submitCall(room, p, m){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='calls') return;
  if(m.response!=='drink' && m.response!=='call') return;
  const c=y.claims.find(c=>c.id===m.claimId);
  if(!c || c.to!==p.pid || c.response) return;
  c.response=m.response;
  if(c.response==='call') feed(room, `🚨 ${p.name} called bluff on ${room.players.get(c.from)?.name||'someone'}`);
  if(allCalled(room)) endCalls(room);
}
function endCalls(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='calls') return;
  clearTimer(room);
  const slot=y.order[y.idx], sips=slot.value*mult(room);
  const claims=y.claims.map(c=>{
    const from=room.players.get(c.from), to=room.players.get(c.to);
    const response=c.response||'drink';
    if(response==='drink'){
      give(room, from, to, sips);
      if(!c.truthful && from) from.bluffsGotAway++;
      return { from:c.from, to:c.to, response, auto:!c.response, truthful:null, loser:c.to, sips };
    }
    // A call doubles the stakes for whoever's wrong.
    if(c.truthful){ give(room, from, to, sips*2); if(to) to.callsLost++; return { from:c.from, to:c.to, response, truthful:true, loser:c.to, sips:sips*2 }; }
    drink(room, from, sips*2); if(from) from.bluffsCaught++; if(to) to.callsWon++;
    return { from:c.from, to:c.to, response, truthful:false, loser:c.from, sips:sips*2 };
  });
  y.result={ row:'give', card:slot.card, value:slot.value, claims };
  y.step='result';
}
function peek(room, p){
  if(room.phase!=='pyramid' || !p.dealt || !room.settings.memory) return;
  p.peeks++; p.sipsTaken+=PEEK_SIPS;
  feed(room, `👀 ${p.name} peeked at their cards (+${PEEK_SIPS} sip)`);
  if(p.ws) send(p.ws, { type:'hand', cards:p.cards });
}

// ---- act 4: ride the bus ----
function toBusIntro(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='result' || y.idx<y.order.length-1) return;
  const r=pickRider(dealtPlayers(room));
  room.riderPid=r.pid; room.riderReason=r.reason; room.stepDrinks={};
  room.phase='busIntro';
}
function dealBus(room){
  const b=room.bus;
  b.cards=shuffle(newDeck()).slice(0,b.length);
  b.pos=0; b.status='guessing'; b.lastGuess=null; b.lastBets=null; b.bets=new Map();
}
function boardBus(room){
  if(room.phase!=='busIntro') return;
  room.bus={ length:room.settings.busLength, attempt:1, bestRun:0, totalSips:0, cards:[], pos:0, status:'guessing', lastGuess:null, lastBets:null, bets:new Map() };
  dealBus(room);
  room.phase='bus'; room.stepDrinks={};
}
function busGuess(room, p, value){
  const b=room.bus;
  if(room.phase!=='bus' || b.status!=='guessing' || p.pid!==room.riderPid) return;
  if(value!=='higher' && value!=='lower') return;
  room.stepDrinks={};
  const verdict=judgeBus(b.cards[b.pos], b.cards[b.pos+1], value);
  const hit=verdict==='right';
  b.lastBets=[...b.bets].map(([bpid,bet])=>{
    const bp=room.players.get(bpid); const won=(bet==='hit')===hit;
    if(bp){ if(won) bp.betsWon++; else { bp.betsLost++; drink(room, bp, SIDE_BET_SIPS); } }
    return { pid:bpid, bet, won };
  });
  b.bets=new Map();
  const guessNo=b.pos+1;
  if(hit){
    b.pos++;
    b.bestRun=Math.max(b.bestRun, b.pos);
    b.lastGuess={ guess:value, verdict, sips:0 };
    if(b.pos>=b.length-1){
      b.status='done';
      feed(room, `🎉 ${p.name} got off the bus after ${b.attempt} ${b.attempt===1?'try':'tries'}`);
      setTimer(room, BUS_FINISH_HOLD_MS, ()=>{ finishGame(room); pushState(room); });
    }
    return;
  }
  const sips=guessNo*mult(room);
  drink(room, p, sips); b.totalSips+=sips;
  b.lastGuess={ guess:value, verdict, sips };
  b.status='failed';
}
function busAgain(room){
  if(room.phase!=='bus' || room.bus.status!=='failed') return;
  room.bus.attempt++; room.stepDrinks={};
  dealBus(room);
}
function placeBet(room, p, bet){
  const b=room.bus;
  if(room.phase!=='bus' || b.status!=='guessing' || p.pid===room.riderPid) return;
  if(bet==='hit' || bet==='miss') b.bets.set(p.pid, bet);
  else if(bet===null) b.bets.delete(p.pid);
}
function skipBus(room, p){
  if(room.phase!=='busIntro' && room.phase!=='bus') return;
  room.busSkipped=true;
  feed(room, `🥴 ${p.name} pulled the emergency stop — bus skipped`);
  finishGame(room);
}
function finishGame(room){
  clearTimer(room);
  room.phase='gameOver'; room.stepDrinks={};
}
function toLobby(room){
  clearTimer(room);
  room.phase='lobby'; room.pyr=null; room.bus=null; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.riderPid=null; room.riderReason=null; room.busSkipped=false; room.round=0;
  pruneGone(room);
  for(const p of room.players.values()) freshStats(p);
  reassignLeaderIfNeeded(room);
}
// Seats that timed out mid-game stay put (their cards are still in play);
// they're only cleared out between games.
function pruneGone(room){
  for(const [id,p] of room.players) if(p.gone && !p.connected) room.players.delete(id);
}

function configure(room, m){
  if(room.phase!=='lobby') return;
  const s=room.settings;
  if(INTENSITY[m.intensity]) s.intensity=m.intensity;
  if(typeof m.memory==='boolean') s.memory=m.memory;
  if(BUS_LENGTHS.includes(+m.busLength)) s.busLength=+m.busLength;
}

// ---- messages ----
function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    if(info.roomCode) return;
    const code=claimCode("irishpoker");
    const room={ code, hostWs:ws, hostToken:token(), hostConnected:true, players:new Map(), phase:"lobby",
      settings:defaultSettings(), leaderPid:null, gameId:0, round:0, timer:null, deadline:null, emptyTimer:null,
      pyr:null, bus:null, roundResults:null, stepDrinks:{}, feed:[], riderPid:null, riderReason:null, busSkipped:false };
    rooms.set(code, room); meta.set(ws,{ roomCode:code, isHost:true });
    send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
  }
  if(m.type==="join"){
    if(info.roomCode) return;
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(room.players.size>=MAX_PLAYERS){ send(ws,{type:"error",msg:`Room is full (${MAX_PLAYERS} players max).`}); return; }
    const name=String(m.name||"Player").slice(0,18).trim()||"Player";
    if([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase())){
      send(ws,{type:"error",msg:`"${name}" is already in this room — pick a different name.`}); return;
    }
    const id=pid(), seatToken=token();
    const used=new Set([...room.players.values()].map(p=>p.color));
    const color=COLORS.find(c=>!used.has(c)) || COLORS[room.players.size % COLORS.length];
    const p={ pid:id, resumeToken:seatToken, connected:true, disconnectTimer:null, gone:false, name, color, ws };
    freshStats(p);
    room.players.set(id,p);
    meta.set(ws,{ roomCode:code, pid:id });
    clearTimeout(room.emptyTimer);
    reassignLeaderIfNeeded(room);
    send(ws,{type:"joined",pid:id,code,token:seatToken}); pushState(room);
    return;
  }
  if(m.type==="resume"){
    if(info.roomCode) return;
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(!m.pid){
      if(!m.token || m.token!==room.hostToken){ send(ws,{type:"error",msg:"Could not resume as host — start a new game."}); return; }
      if(room.hostWs && room.hostWs!==ws){ meta.delete(room.hostWs); try{ room.hostWs.close(); }catch(e){} }
      room.hostWs=ws; room.hostConnected=true; clearTimeout(room.emptyTimer);
      meta.set(ws,{ roomCode:code, isHost:true });
      send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
    }
    const p=room.players.get(m.pid);
    if(!p || !m.token || m.token!==p.resumeToken){ send(ws,{type:"error",msg:"Could not resume — join as a new player instead."}); return; }
    clearTimeout(p.disconnectTimer); p.disconnectTimer=null; p.gone=false;
    if(p.ws && p.ws!==ws){ meta.delete(p.ws); try{ p.ws.close(); }catch(e){} }
    p.ws=ws; p.connected=true; clearTimeout(room.emptyTimer);
    meta.set(ws,{ roomCode:code, pid:m.pid });
    reassignLeaderIfNeeded(room);
    send(ws,{type:"joined",pid:m.pid,code,token:p.resumeToken}); pushState(room);
    return;
  }

  const room = rooms.get(info.roomCode); if(!room) return;
  const p = info.pid ? room.players.get(info.pid) : null;
  if(!p) return;                       // the TV never acts
  const isLeader = p.pid===room.leaderPid;
  const isRider = p.pid===room.riderPid;

  switch(m.type){
    case 'configure': if(isLeader) configure(room, m); break;
    case 'start':     if(isLeader && (room.phase==='lobby'||room.phase==='gameOver')){ if(!deal(room)) return; } else return; break;
    case 'guess':     submitGuess(room, p, m); break;
    case 'next':      if(isLeader) nextFromReveal(room); break;
    case 'force':
      if(!isLeader) return;
      if(room.phase==='guess') resolveGuesses(room);
      else if(room.phase==='memorize') beginPyramid(room);
      else if(room.phase==='pyramid' && room.pyr.step==='claims') endClaims(room);
      else if(room.phase==='pyramid' && room.pyr.step==='calls') endCalls(room);
      else return;
      break;
    case 'flip':      if(isLeader) flip(room); break;
    case 'claim':     submitClaim(room, p, m); break;
    case 'call':      submitCall(room, p, m); break;
    case 'peek':      peek(room, p); break;
    case 'toBus':     if(isLeader) toBusIntro(room); break;
    case 'boardBus':  if(isLeader||isRider) boardBus(room); break;
    case 'busGuess':  busGuess(room, p, m.value); break;
    case 'busAgain':  if(isLeader||isRider) busAgain(room); break;
    case 'bet':       placeBet(room, p, m.bet===undefined?null:m.bet); break;
    case 'skipBus':   if(isLeader||isRider) skipBus(room, p); break;
    case 'toLobby':   if(isLeader) toLobby(room); break;
    default: return;
  }
  pushState(room);
}

function scheduleEmptyCleanup(room){
  const anyone = room.hostConnected || [...room.players.values()].some(p=>p.connected);
  if(anyone) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer=setTimeout(()=>{
    if(rooms.get(room.code)!==room) return;
    if(room.hostConnected || [...room.players.values()].some(p=>p.connected)) return;
    clearTimer(room);
    for(const p of room.players.values()) clearTimeout(p.disconnectTimer);
    releaseCode(room.code); rooms.delete(room.code);
  }, EMPTY_ROOM_TTL_MS);
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    if(room.hostWs!==ws) return;
    // The TV is a pure spectator — losing it never ends or blocks the game.
    room.hostConnected=false; room.hostWs=null;
    pushState(room); scheduleEmptyCleanup(room);
    return;
  }
  if(!info.pid) return;
  const p=room.players.get(info.pid); if(!p || p.ws!==ws) return;
  p.connected=false; p.ws=null;
  reassignLeaderIfNeeded(room);
  // Whoever just dropped shouldn't be what the table is waiting on.
  if(room.phase==='guess' && allGuessed(room)) resolveGuesses(room);
  else if(room.phase==='pyramid' && room.pyr.step==='claims' && allResponded(room)) endClaims(room);
  else if(room.phase==='pyramid' && room.pyr.step==='calls' && allCalled(room)) endCalls(room);
  if(room.bus) room.bus.bets.delete(p.pid);
  pushState(room);
  scheduleEmptyCleanup(room);
  clearTimeout(p.disconnectTimer);
  p.disconnectTimer=setTimeout(()=>{
    if(room.players.get(info.pid)!==p || p.connected) return;
    if(p.dealt && room.phase!=='lobby'){ p.gone=true; return; }   // keep the seat until the game ends
    room.players.delete(info.pid);
    reassignLeaderIfNeeded(room);
    pushState(room);
  }, RECONNECT_GRACE_MS);
}

export const open    = ws => { meta.set(ws,{}); };
export const message = (ws,msg) => { try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } };
export const close   = ws => { handleClose(ws); };
