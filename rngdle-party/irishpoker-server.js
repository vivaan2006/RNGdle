// Irish Poker — online-only card drinking game, server-side room logic.
// Fully independent from the other games: own Map, own message types, own
// WebSocket path (/irishpoker-ws). The only thing shared is the HTTP process
// and the room-code registry.
//
// Same shape as RNGold Rush: the host screen is a pure spectator (the TV),
// and the room "leader" — whoever's been connected longest — paces the game
// from their phone. Every decision happens on phones.
//
// A game runs in three acts:
//
//   1. THE DEAL (rounds 1-4). Everyone gets four face-down cards. Each round
//      everyone locks a guess about their next card at the same time —
//      red/black, higher/lower, inside/outside, then the suit — along with who
//      drinks if they're right. Right = give the round's sips to your pick.
//      Wrong = drink them. Landing exactly on a boundary card ("the post") =
//      drink double.
//
//   2. THE PYRAMID. Hands stay face-up. Ten cards sit face-down in a 4-3-2-1
//      pyramid and flip one at a time from the bottom row up. Everyone holding
//      that rank has to tap "I have it" — the game waits until every holder
//      has. Holders then hand out drinks: bottom row 1 sip, next row 2, next 3
//      (split however they like), and the top card makes someone finish their
//      drink. A card nobody holds is burned and replaced from the deck until
//      somebody does, so every card — the top one included — lands on someone.
//
//   3. RIDE THE BUS (mandatory). Whoever has the most cards they never got to
//      play rides. A row of cards is dealt with the first face up; the rider
//      calls higher/lower through the row. Any miss (a tie is a miss) means
//      drink for how far they got and a fresh deal. Spectators can side-bet
//      each call. A small, deliberately quiet "skip the bus" escape exists for
//      when someone's genuinely had enough.
//
// Pacing is deliberately casino-like: inputs resolve instantly here, and every
// state change carries `stepAt` (server time) so every screen plays the same
// slow reveal in sync. Timers that must outlast an animation (burns, the bus
// finish) are sized to match the client's timeline in irishpoker.html.

import { claimCode, releaseCode } from "./rooms-registry.js";

const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];

// ---- tunable constants ----
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const HAND_SIZE = 4;
const RECONNECT_GRACE_MS = 45000;
const EMPTY_ROOM_TTL_MS = 10*60*1000;
const GUESS_MS  = 60000;            // undecided players get a random guess + random target
const ASSIGN_MS = 75000;            // holders who never hand out drinks get random picks
// Tests set IRISHPOKER_FAST=1 so server-held animation windows don't slow the suite.
const FAST = typeof process!=='undefined' && process.env && process.env.IRISHPOKER_FAST==='1';
const BURN_MS   = FAST ? 150 : 4200;  // must outlast the client's suspense + flip + burn animation
const MAX_BURNS_BEFORE_FORCED_MATCH = 3;
const BUS_FINISH_HOLD_MS = FAST ? 150 : 7500;  // celebration on screen before the summary
const SIDE_BET_SIPS = 1;

export const INTENSITY = { sipping:1, drinking:2, hammered:3 };
export const BUS_LENGTHS = [4,5,6];

// Rounds and the bus scale with intensity; the pyramid's payouts are fixed.
export const ROUNDS = [
  { key:'color', options:['red','black'],      wrong:1, give:1 },
  { key:'hilo',  options:['higher','lower'],   wrong:2, give:2 },
  { key:'inout', options:['inside','outside'], wrong:3, give:3 },
  { key:'suit',  options:['s','h','d','c'],    wrong:2, give:4 },
];

// Bottom row first. `finish` = the holder picks someone to finish their drink.
export const LEVELS = [
  { level:4, cards:4, sips:1 },
  { level:3, cards:3, sips:2 },
  { level:2, cards:2, sips:3 },
  { level:1, cards:1, finish:true },
];

// ---- cards ----
const SUITS = ['s','h','d','c'];
export function newDeck(){ const d=[]; for(const s of SUITS) for(let r=2;r<=14;r++) d.push({r,s}); return d; }
export function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
export function isRed(card){ return card.s==='h' || card.s==='d'; }
const same = (a,b) => a && b && a.r===b.r && a.s===b.s;

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

/** The 10 pyramid slots in flip order: bottom row left→right, then up. */
export function pyramidSlots(){
  const out=[];
  for(const L of LEVELS) for(let col=0; col<L.cards; col++)
    out.push({ level:L.level, col, sips:L.sips||0, finish:!!L.finish, card:null, burned:[] });
  return out;
}

/** Who holds a rank, and how many copies each. */
export function holdersFor(players, rank){
  return players.map(p=>({ pid:p.pid, count:p.cards.filter(c=>c.r===rank).length })).filter(h=>h.count>0);
}

/** Validate one holder's hand-out. Returns a normalised {sips:{pid:n}} / {finish:[pid]} or null. */
export function validateAssignment(slot, count, fromPid, dealtPids, m){
  const others=new Set(dealtPids.filter(id=>id!==fromPid));
  if(slot.finish){
    if(!Array.isArray(m.finish) || m.finish.length!==count) return null;
    if(!m.finish.every(id=>others.has(id))) return null;
    return { finish:m.finish.slice() };
  }
  if(!m.sips || typeof m.sips!=='object') return null;
  let total=0; const sips={};
  for(const [id,n] of Object.entries(m.sips)){
    if(!others.has(id) || !Number.isInteger(n) || n<0) return null;
    if(n>0){ sips[id]=n; total+=n; }
  }
  return total===slot.sips*count ? { sips } : null;
}

/** Who rides: most cards never played in the pyramid, then most wrong guesses, then chance. */
export function pickRider(players){
  if(!players.length) return { pid:null, reason:'none', candidates:[] };
  const left=p=>HAND_SIZE-p.played.filter(Boolean).length;
  const topLeft=Math.max(...players.map(left));
  let pool=players.filter(p=>left(p)===topLeft);
  if(pool.length===1) return { pid:pool[0].pid, reason:'cardsLeft', candidates:pool.map(p=>p.pid) };
  const topWrong=Math.max(...pool.map(p=>p.wrong));
  const tied=pool;
  pool=pool.filter(p=>p.wrong===topWrong);
  if(pool.length===1) return { pid:pool[0].pid, reason:'wrong', candidates:tied.map(p=>p.pid) };
  return { pid:pick(pool).pid, reason:'random', candidates:pool.map(p=>p.pid) };
}

// ---- rooms ----
const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }

function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }

function defaultSettings(){ return { intensity:'sipping', busLength:5 }; }
function mult(room){ return INTENSITY[room.settings.intensity] || 1; }
function dealtPlayers(room){ return [...room.players.values()].filter(p=>p.dealt); }
function othersFor(room, p){ return dealtPlayers(room).filter(o=>o.pid!==p.pid); }
function mark(room){ room.stepAt=Date.now(); }

function freshStats(p){
  Object.assign(p, { dealt:false, cards:[], played:[false,false,false,false], guess:null, lastTarget:p.lastTarget||null,
    sipsTaken:0, sipsGiven:0, correct:0, wrong:0, posts:0, matches:0,
    finishes:0, finishesGiven:0, betsWon:0, betsLost:0 });
}

function feed(room, text){ room.feed.push({ at:Date.now(), text }); if(room.feed.length>40) room.feed.shift(); }
function drink(room, p, sips){ if(!p || sips<=0) return; p.sipsTaken+=sips; room.stepDrinks[p.pid]=(room.stepDrinks[p.pid]||0)+sips; }
function give(room, from, to, sips){ if(from) from.sipsGiven+=sips; drink(room, to, sips); }

function clearTimer(room){ clearTimeout(room.timer); room.timer=null; room.deadline=null; }
function setTimer(room, ms, fn, showDeadline=true){
  clearTimer(room);
  if(showDeadline) room.deadline=Date.now()+ms;
  room.timer=setTimeout(()=>{ if(rooms.get(room.code)!==room) return; room.timer=null; room.deadline=null; fn(); pushState(room); }, ms);
}

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
  return HAND_SIZE;   // pyramid onward: hands are face-up for good
}
function pyramidPublic(room){
  const y=room.pyr; if(!y) return null;
  const pub={ idx:y.idx, step:y.step,
    slots:y.slots.map((s,i)=>({ level:s.level, col:s.col, sips:s.sips, finish:s.finish, card: i<=y.idx ? s.card : null, burns:s.burned.length })),
    lastBurned: y.idx>=0 ? (y.slots[y.idx].burned.slice(-1)[0]||null) : null,
    result:y.result };
  if(y.step==='claim'){
    pub.claimed=[...y.claimed];
    pub.remaining=y.holders.filter(h=>!y.claimed.has(h.pid)).length;
  }
  if(y.step==='assign' || y.step==='result'){
    pub.holders=y.holders;
    pub.assigned=[...y.assigned.keys()];
  }
  return pub;
}
function busPublic(room){
  const b=room.bus; if(!b) return null;
  const shown = b.status==='guessing' ? b.pos+1 : b.status==='failed' ? b.pos+2 : b.length;
  return { length:b.length, attempt:b.attempt, pos:b.pos, status:b.status, bestRun:b.bestRun, totalSips:b.totalSips,
    cards:b.cards.map((c,i)=>i<shown?c:null), lastEvent:b.lastEvent,
    lastGuess:b.lastGuess, lastBets:b.lastBets, betCount:b.bets.size };
}
function stateMsg(room, viewer){
  const vis=visibleCardCount(room);
  const s = {
    type:"state", phase:room.phase, gameId:room.gameId, round:room.round, settings:room.settings,
    hostConnected:room.hostConnected, leaderPid:room.leaderPid,
    deadline:room.deadline, stepAt:room.stepAt, serverNow:Date.now(),
    roundResults: room.phase==='reveal' ? room.roundResults : null,
    stepDrinks: room.stepDrinks, feed: room.feed.slice(-12),
    pyramid: pyramidPublic(room), bus: busPublic(room),
    riderPid: room.riderPid, riderReason: room.riderReason, riderCandidates: room.riderCandidates, busSkipped: room.busSkipped,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, connected:p.connected, dealt:p.dealt,
      locked: room.phase==='guess' && p.dealt && !!p.guess,
      cards: p.dealt ? p.cards.map((c,i)=>i<vis?c:null) : [],
      played: p.played,
      sipsTaken:p.sipsTaken, sipsGiven:p.sipsGiven, correct:p.correct, wrong:p.wrong, posts:p.posts, matches:p.matches,
      finishes:p.finishes, finishesGiven:p.finishesGiven, betsWon:p.betsWon, betsLost:p.betsLost,
    })),
  };
  if(viewer){
    const p=room.players.get(viewer);
    if(p){
      const me={ guess:p.guess, lastTarget:p.lastTarget };
      const y=room.pyr;
      if(y && (y.step==='claim' || y.step==='assign')){
        const h=y.holders.find(h=>h.pid===p.pid);
        me.holding = h ? h.count : 0;
        me.claimed = y.claimed.has(p.pid);
        me.assigned = y.assigned.has(p.pid);
      }
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
  room.deck=shuffle(newDeck());
  for(const p of room.players.values()) freshStats(p);
  for(const p of seats){ p.dealt=true; p.cards=room.deck.splice(0,HAND_SIZE); }
  room.pyr=null; room.gameId++; room.round=1; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.bus=null; room.riderPid=null; room.riderReason=null; room.riderCandidates=null; room.busSkipped=false;
  beginGuess(room);
  return true;
}
function beginGuess(room){
  room.phase='guess'; room.stepDrinks={}; mark(room);
  for(const p of dealtPlayers(room)) p.guess=null;
  setTimer(room, GUESS_MS, ()=>resolveGuesses(room));
}
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
  room.phase='reveal'; mark(room);
}
function nextFromReveal(room){
  if(room.phase!=='reveal') return;
  room.roundResults=null;
  if(room.round<ROUNDS.length){ room.round++; beginGuess(room); return; }
  beginPyramid(room);
}

// ---- act 2: the pyramid ----
function beginPyramid(room){
  clearTimer(room);
  room.pyr={ slots:pyramidSlots(), idx:-1, step:'ready', holders:[], claimed:new Set(), assigned:new Map(), result:null };
  room.phase='pyramid'; room.stepDrinks={}; mark(room);
}
function flip(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || !(y.step==='ready'||y.step==='result') || y.idx>=y.slots.length-1) return;
  y.idx++; room.stepDrinks={}; y.result=null;
  drawIntoSlot(room);
}
function cardsInPlay(room){
  const out=[];
  for(const p of dealtPlayers(room)) out.push(...p.cards);
  room.pyr.slots.forEach((s,i)=>{ if(i<=room.pyr.idx && s.card) out.push(s.card); });
  return out;
}
function nextCard(room, slot){
  const held=[...new Set(dealtPlayers(room).flatMap(p=>p.cards.map(c=>c.r)))];
  const inPlay=cardsInPlay(room);
  const free=()=>newDeck().filter(c=>!inPlay.some(x=>same(x,c)));
  // After a few burns in a row, stop teasing: the next card is one somebody holds.
  if(slot.burned.length>=MAX_BURNS_BEFORE_FORCED_MATCH){
    const pool=free().filter(c=>held.includes(c.r));
    if(pool.length) return pick(pool);
    return { r:pick(held), s:pick(SUITS) };
  }
  if(!room.deck.length) room.deck=shuffle(free());
  return room.deck.pop() || { r:pick(held), s:pick(SUITS) };
}
function drawIntoSlot(room){
  const y=room.pyr, slot=y.slots[y.idx];
  if(slot.card) slot.burned.push(slot.card);
  slot.card=nextCard(room, slot);
  y.holders=holdersFor(dealtPlayers(room), slot.card.r);
  y.claimed=new Set(); y.assigned=new Map();
  mark(room);
  if(!y.holders.length){
    y.step='burn';
    feed(room, `🔥 Nobody had a ${slot.card.r} — burned`);
    setTimer(room, BURN_MS, ()=>drawIntoSlot(room), false);
    return;
  }
  clearTimer(room);
  y.step='claim';
  for(const h of y.holders){ const p=room.players.get(h.pid); if(p && !p.connected) claimFor(room, p); }
  maybeFinishClaims(room);
}
function claimFor(room, p){
  const y=room.pyr, rank=y.slots[y.idx].card.r;
  if(y.claimed.has(p.pid)) return;
  y.claimed.add(p.pid);
  p.cards.forEach((c,i)=>{ if(c.r===rank && !p.played[i]){ p.played[i]=true; p.matches++; } });
}
/** Returns 'ok' | 'nope' (tapped without holding it). */
function submitHave(room, p){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='claim' || !p.dealt) return null;
  if(!y.holders.some(h=>h.pid===p.pid)) return 'nope';
  claimFor(room, p);
  maybeFinishClaims(room);
  return 'ok';
}
function maybeFinishClaims(room){
  const y=room.pyr;
  if(y.step!=='claim' || !y.holders.every(h=>y.claimed.has(h.pid))) return;
  y.step='assign'; mark(room);
  for(const h of y.holders){ const p=room.players.get(h.pid); if(p && !p.connected) randomAssign(room, p); }
  if(!maybeFinishAssign(room)) setTimer(room, ASSIGN_MS, ()=>{ assignStragglers(room); maybeFinishAssign(room); });
}
function randomAssign(room, p){
  const y=room.pyr, slot=y.slots[y.idx], h=y.holders.find(h=>h.pid===p.pid);
  const others=othersFor(room,p); if(!h || !others.length) { y.assigned.set(p.pid, slot.finish?{finish:[]}:{sips:{}}); return; }
  if(slot.finish){ y.assigned.set(p.pid, { finish:Array.from({length:h.count},()=>pick(others).pid) }); return; }
  const sips={}; for(let i=0;i<slot.sips*h.count;i++){ const t=pick(others).pid; sips[t]=(sips[t]||0)+1; }
  y.assigned.set(p.pid, { sips, auto:true });
}
function assignStragglers(room){
  const y=room.pyr;
  for(const h of y.holders) if(!y.assigned.has(h.pid)){ const p=room.players.get(h.pid); if(p) randomAssign(room, p); else y.assigned.set(h.pid,{sips:{}}); }
}
function submitAssign(room, p, m){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='assign' || y.assigned.has(p.pid)) return;
  const h=y.holders.find(h=>h.pid===p.pid); if(!h) return;
  const ok=validateAssignment(y.slots[y.idx], h.count, p.pid, dealtPlayers(room).map(d=>d.pid), m);
  if(!ok) return;
  y.assigned.set(p.pid, ok);
  maybeFinishAssign(room);
}
function maybeFinishAssign(room){
  const y=room.pyr;
  if(y.step!=='assign' || !y.holders.every(h=>y.assigned.has(h.pid))) return false;
  clearTimer(room);
  const slot=y.slots[y.idx];
  const gives=[], finishes=[];
  for(const h of y.holders){
    const from=room.players.get(h.pid), a=y.assigned.get(h.pid);
    if(a.finish) for(const to of a.finish){
      const tp=room.players.get(to); if(!tp) continue;
      tp.finishes++; if(from) from.finishesGiven++;
      finishes.push({ from:h.pid, to });
    }
    if(a.sips) for(const [to,n] of Object.entries(a.sips)){
      give(room, from, room.players.get(to), n);
      gives.push({ from:h.pid, to, sips:n, auto:!!a.auto });
    }
  }
  y.result={ card:slot.card, level:slot.level, finish:slot.finish, gives, finishes };
  y.step='result'; mark(room);
  if(finishes.length) feed(room, `🍺 ${finishes.map(f=>room.players.get(f.to)?.name).join(' & ')} had to finish their drink`);
  return true;
}
function forceStep(room){
  const y=room.pyr;
  if(room.phase==='guess'){ resolveGuesses(room); return true; }
  if(room.phase!=='pyramid') return false;
  if(y.step==='claim'){
    for(const h of y.holders){ const p=room.players.get(h.pid); if(p) claimFor(room,p); else y.claimed.add(h.pid); }
    maybeFinishClaims(room); return true;
  }
  if(y.step==='assign'){ assignStragglers(room); maybeFinishAssign(room); return true; }
  return false;
}

// ---- act 3: ride the bus ----
function toRider(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='result' || y.idx<y.slots.length-1) return;
  const r=pickRider(dealtPlayers(room));
  room.riderPid=r.pid; room.riderReason=r.reason; room.riderCandidates=r.candidates;
  room.stepDrinks={}; room.phase='rider'; mark(room);
}
function dealBus(room, event){
  const b=room.bus;
  b.cards=shuffle(newDeck()).slice(0,b.length);
  b.pos=0; b.status='guessing'; b.lastGuess=null; b.lastBets=null; b.bets=new Map(); b.lastEvent=event;
  mark(room);
}
function boardBus(room){
  if(room.phase!=='rider') return;
  room.bus={ length:room.settings.busLength, attempt:1, bestRun:0, totalSips:0, cards:[], pos:0, status:'guessing', lastGuess:null, lastBets:null, bets:new Map(), lastEvent:'deal' };
  room.phase='bus'; room.stepDrinks={};
  dealBus(room, 'deal');
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
  mark(room);
  if(hit){
    b.pos++;
    b.bestRun=Math.max(b.bestRun, b.pos);
    b.lastGuess={ guess:value, verdict, sips:0 };
    b.lastEvent='hit';
    if(b.pos>=b.length-1){
      b.status='done'; b.lastEvent='done';
      feed(room, `🎉 ${p.name} got off the bus after ${b.attempt} ${b.attempt===1?'try':'tries'}`);
      setTimer(room, BUS_FINISH_HOLD_MS, ()=>finishGame(room), false);
    }
    return;
  }
  const sips=guessNo*mult(room);
  drink(room, p, sips); b.totalSips+=sips;
  b.lastGuess={ guess:value, verdict, sips };
  b.status='failed'; b.lastEvent='miss';
}
function busAgain(room){
  if(room.phase!=='bus' || room.bus.status!=='failed') return;
  room.bus.attempt++; room.stepDrinks={};
  dealBus(room, 'redeal');
}
function placeBet(room, p, bet){
  const b=room.bus;
  if(room.phase!=='bus' || b.status!=='guessing' || p.pid===room.riderPid) return;
  if(bet==='hit' || bet==='miss') b.bets.set(p.pid, bet);
  else if(bet===null) b.bets.delete(p.pid);
}
function skipBus(room, p){
  if(room.phase!=='rider' && room.phase!=='bus') return;
  room.busSkipped=true;
  feed(room, `🥴 ${p.name} pulled the emergency stop — bus skipped`);
  finishGame(room);
}
function finishGame(room){
  clearTimer(room);
  room.phase='gameOver'; room.stepDrinks={}; mark(room);
}
function toLobby(room){
  clearTimer(room);
  room.phase='lobby'; room.pyr=null; room.bus=null; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.riderPid=null; room.riderReason=null; room.riderCandidates=null; room.busSkipped=false; room.round=0;
  pruneGone(room);
  for(const p of room.players.values()) freshStats(p);
  reassignLeaderIfNeeded(room); mark(room);
}
function pruneGone(room){
  for(const [id,p] of room.players) if(p.gone && !p.connected) room.players.delete(id);
}
function configure(room, m){
  if(room.phase!=='lobby') return;
  const s=room.settings;
  if(INTENSITY[m.intensity]) s.intensity=m.intensity;
  if(BUS_LENGTHS.includes(+m.busLength)) s.busLength=+m.busLength;
}

// ---- messages ----
function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    if(info.roomCode) return;
    const code=claimCode("irishpoker");
    const room={ code, hostWs:ws, hostToken:token(), hostConnected:true, players:new Map(), phase:"lobby",
      settings:defaultSettings(), leaderPid:null, gameId:0, round:0, timer:null, deadline:null, stepAt:Date.now(), emptyTimer:null,
      deck:[], pyr:null, bus:null, roundResults:null, stepDrinks:{}, feed:[], riderPid:null, riderReason:null, riderCandidates:null, busSkipped:false };
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
    case 'force':     if(!isLeader || !forceStep(room)) return; break;
    case 'flip':      if(isLeader) flip(room); break;
    case 'have': {
      const r=submitHave(room, p);
      if(r==='nope'){ send(ws,{type:'nope'}); return; }
      if(!r) return;
      break;
    }
    case 'assign':    submitAssign(room, p, m); break;
    case 'toRider':   if(isLeader) toRider(room); break;
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
  else if(room.phase==='pyramid' && room.pyr.step==='claim' && room.pyr.holders.some(h=>h.pid===p.pid)){ claimFor(room, p); maybeFinishClaims(room); }
  else if(room.phase==='pyramid' && room.pyr.step==='assign' && room.pyr.holders.some(h=>h.pid===p.pid) && !room.pyr.assigned.has(p.pid)){ randomAssign(room, p); maybeFinishAssign(room); }
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
