// Irish Poker — online-only card drinking game, server-side room logic.
// Fully independent from the other games: own Map, own message types, own
// WebSocket path (/irishpoker-ws). The only things shared are the HTTP process,
// the room-code registry and irishpoker-rules.js (rules + reveal timing, also
// loaded by the page).
//
// The server IS the dealer. Nobody on a phone paces the game: it deals,
// flips, burns, spins for the rider and re-deals the bus on its own, and it
// only ever waits for the people whose move it is. It never guesses, claims or
// hands out drinks for anyone — if someone's phone falls asleep the table
// waits for them, and the host screen can sit them out.
//
// The host screen (the TV) owns the room: settings, start, pause, skip the
// wait, end the game, deal a new one, remove players. If the TV drops, any
// phone gets those controls so a game is never stranded.
//
// A game runs in three acts:
//
//   1. THE DEAL (rounds 1-4). Everyone gets four face-down cards. Each round
//      everyone locks a guess about their next card — red/black,
//      higher/lower, inside/outside, then the suit. Right = safe. Wrong = drink
//      the round's sips (1, 2, 3, 4). Landing on the post = drink double.
//
//   2. THE PYRAMID. Hands are face-up. Ten cards flip one at a time from the
//      bottom of a 4-3-2-1 pyramid. Everyone holding that rank taps "I have
//      it" — the game waits for every holder — then hands out drinks: 1 sip,
//      2, 3, and the top card makes someone finish their drink. A card nobody
//      holds is burned and replaced until somebody does.
//
//   3. RIDE THE BUS (mandatory). Most cards left unplayed rides: higher or
//      lower down a row of cards; any miss drinks and re-deals. Spectators can
//      side-bet. A small "skip the bus" escape exists for when someone's done.
//
// Every state carries `stepAt` (server time) so every screen plays the same
// slow reveal together, and every auto-advance waits out that reveal first.

import { claimCode, releaseCode } from "./rooms-registry.js";
import "./irishpoker-rules.js";                 // sets globalThis.RNGPARTY_IRISHPOKER

const R = globalThis.RNGPARTY_IRISHPOKER;
const { HAND_SIZE, MIN_PLAYERS, MAX_PLAYERS, TIMING: T } = R;
export const { INTENSITY, BUS_LENGTHS, ROUNDS, LEVELS, TIMING, judgeGuess, roundSips, judgeBus,
  pyramidSlots, holdersFor, validateAssignment, pickRider, isRed } = R;

const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];
const RECONNECT_GRACE_MS = 45000;           // lobby seats of people who left
const EMPTY_ROOM_TTL_MS  = 15*60*1000;
const STALE_SOCKET_MS    = 25000;           // a pinging client that goes quiet is gone
const RESUME_MIN_MS      = 2500;            // un-pausing never fires a timer instantly
// Tests set IRISHPOKER_FAST=1 so the dealer's holds don't slow the suite down.
const FAST = typeof process!=='undefined' && process.env && process.env.IRISHPOKER_FAST==='1';
const FAST_CAP = FAST ? (+process.env.IRISHPOKER_FAST_MS || 25) : 0;
const hold = ms => FAST ? Math.min(ms, FAST_CAP) : ms;

// ---- cards ----
const SUITS = ['s','h','d','c'];
export function newDeck(){ const d=[]; for(const s of SUITS) for(let r=2;r<=14;r++) d.push({r,s}); return d; }
export function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
const same = (a,b) => a && b && a.r===b.r && a.s===b.s;

// ---- rooms ----
const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost, lastSeen, pinged }

function newId(){ return "p"+Math.random().toString(36).slice(2,8); }
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }

function defaultSettings(){ return { intensity:'sipping', busLength:5 }; }
function mult(room){ return INTENSITY[room.settings.intensity] || 1; }
function active(room){ return [...room.players.values()].filter(p=>p.dealt); }
function mark(room){ room.stepAt=Date.now(); }
const inGame = room => room.phase!=='lobby' && room.phase!=='gameOver';

function freshStats(p){
  Object.assign(p, { dealt:false, satOut:false, cards:[], played:[false,false,false,false], guess:null,
    sipsTaken:0, sipsGiven:0, correct:0, wrong:0, posts:0, matches:0,
    finishes:0, finishesGiven:0, betsWon:0, betsLost:0 });
}

function feed(room, text){ room.feed.push({ at:Date.now(), text }); if(room.feed.length>40) room.feed.shift(); }
function drink(room, p, sips){ if(!p || sips<=0) return; p.sipsTaken+=sips; room.stepDrinks[p.pid]=(room.stepDrinks[p.pid]||0)+sips; }

// ---- the dealer's clock: one pausable auto-advance per room ----
function clearAuto(room){ if(room.auto) clearTimeout(room.auto.timer); room.auto=null; room.ready=new Set(); }
/** Run `fn` after `ms`. `minMs` is the earliest everyone-tapped-ready may cut it to. */
function schedule(room, ms, fn, opts){
  opts=opts||{};
  clearAuto(room);
  const now=Date.now();
  room.auto={ fn, at:now+hold(ms), minAt:now+hold(opts.minMs!=null?opts.minMs:ms), readyable:!!opts.readyable, left:null, minLeft:null, timer:null };
  if(room.paused){ freezeAuto(room); } else armAuto(room);
}
function armAuto(room){
  const a=room.auto; if(!a) return;
  clearTimeout(a.timer);
  a.timer=setTimeout(()=>fireAuto(room, a), Math.max(0, a.at-Date.now()));
}
function fireAuto(room, a){
  if(rooms.get(room.code)!==room || room.auto!==a || room.paused) return;
  clearAuto(room);
  a.fn();
  pushState(room);
}
function freezeAuto(room){
  const a=room.auto; if(!a || a.left!=null) return;
  clearTimeout(a.timer); a.timer=null;
  const now=Date.now();
  a.left=Math.max(0, a.at-now); a.minLeft=Math.max(0, a.minAt-now); a.at=null;
}
function thawAuto(room){
  const a=room.auto; if(!a || a.left==null) return;
  const now=Date.now();
  a.at=now+Math.max(a.left, hold(RESUME_MIN_MS)); a.minAt=now+a.minLeft; a.left=null; a.minLeft=null;
  armAuto(room);
}
function setPaused(room, on){
  if(!inGame(room) || room.paused===on) return false;
  room.paused=on;
  if(on) freezeAuto(room); else { thawAuto(room); checkReady(room); }
  feed(room, on ? '⏸ Paused by the host' : '▶️ Back on');
  return true;
}
function skipWait(room){
  const a=room.auto; if(!a) return false;
  clearAuto(room);
  a.fn();
  return true;
}
/** Everyone connected tapped "ready" during a break: cut the wait short. */
function checkReady(room){
  const a=room.auto;
  if(!a || !a.readyable || room.paused || !room.ready.size) return;
  const need=active(room).filter(p=>p.connected);
  if(!need.every(p=>room.ready.has(p.pid))) return;
  a.at=Math.max(a.minAt, Date.now()+hold(T.READY_MIN));
  armAuto(room);
}

// ---- views ----
function visibleCardCount(room){
  if(room.phase==='guess') return room.round-1;
  if(room.phase==='reveal') return room.round;
  return HAND_SIZE;   // pyramid onward: hands are face-up for good
}
function waitingOn(room){
  if(room.phase==='guess') return active(room).filter(p=>!p.guess).map(p=>p.pid);
  const y=room.pyr;
  if(room.phase==='pyramid' && y.step==='claim') return y.holders.filter(h=>!y.claimed.has(h.pid)).map(h=>h.pid);
  if(room.phase==='pyramid' && y.step==='assign') return y.holders.filter(h=>!y.assigned.has(h.pid)).map(h=>h.pid);
  if(room.phase==='bus' && room.bus.status==='guessing') return [room.riderPid];
  return [];
}
function pyramidPublic(room){
  const y=room.pyr; if(!y) return null;
  const pub={ idx:y.idx, step:y.step,
    slots:y.slots.map((s,i)=>({ level:s.level, col:s.col, sips:s.sips, finish:s.finish, card: i<=y.idx ? s.card : null, burns:s.burned.length })),
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
  const vis=visibleCardCount(room), a=room.auto, now=Date.now();
  const s = {
    type:"state", phase:room.phase, gameId:room.gameId, round:room.round, settings:room.settings,
    hostConnected:room.hostConnected, stepAt:room.stepAt, serverNow:now,
    paused:room.paused, autoAt: a && a.at!=null ? a.at : null, autoLeft: a && a.left!=null ? a.left : null,
    readyable: !!(a && a.readyable), ready:[...room.ready], waitingOn:waitingOn(room), endedEarly:room.endedEarly,
    roundResults: room.phase==='reveal' ? room.roundResults : null,
    stepDrinks: room.stepDrinks, feed: room.feed.slice(-12),
    pyramid: pyramidPublic(room), bus: busPublic(room),
    riderPid: room.riderPid, riderReason: room.riderReason, riderCandidates: room.riderCandidates, busSkipped: room.busSkipped,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, connected:p.connected, dealt:p.dealt, satOut:p.satOut,
      locked: room.phase==='guess' && p.dealt && !!p.guess,
      cards: p.dealt || p.satOut ? p.cards.map((c,i)=>i<vis?c:null) : [],
      played: p.played,
      sipsTaken:p.sipsTaken, sipsGiven:p.sipsGiven, correct:p.correct, wrong:p.wrong, posts:p.posts, matches:p.matches,
      finishes:p.finishes, finishesGiven:p.finishesGiven, betsWon:p.betsWon, betsLost:p.betsLost,
    })),
  };
  if(viewer){
    const p=room.players.get(viewer);
    if(p){
      const me={ guess:p.guess, ready:room.ready.has(p.pid) };
      const y=room.pyr;
      if(room.phase==='pyramid' && y && (y.step==='claim' || y.step==='assign')){
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
/** Who gets cards: everyone connected, plus anyone whose phone only just dropped. */
function seatsForDeal(room){
  const now=Date.now();
  return [...room.players.values()].filter(p=>p.connected || (!p.gone && p.dropAt && now-p.dropAt<RECONNECT_GRACE_MS)).slice(0,MAX_PLAYERS);
}
function deal(room){
  pruneGone(room);
  const seats=seatsForDeal(room);
  if(seats.filter(p=>p.connected).length<MIN_PLAYERS) return false;
  clearAuto(room);
  room.deck=shuffle(newDeck());
  for(const p of room.players.values()) freshStats(p);
  for(const p of seats){ p.dealt=true; p.cards=room.deck.splice(0,HAND_SIZE); }
  room.pyr=null; room.gameId++; room.round=1; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.bus=null; room.riderPid=null; room.riderReason=null; room.riderCandidates=null; room.busSkipped=false;
  room.paused=false; room.endedEarly=false;
  beginGuess(room);
  return true;
}
function beginGuess(room){
  clearAuto(room);
  room.phase='guess'; room.stepDrinks={}; room.roundResults=null; mark(room);
  for(const p of active(room)) p.guess=null;
}
function allGuessed(room){ const a=active(room); return a.length>0 && a.every(p=>p.guess); }
function submitGuess(room, p, m){
  if(room.phase!=='guess' || !p.dealt || room.paused) return false;
  if(!ROUNDS[room.round-1].options.includes(m.value)) return false;
  p.guess={ value:m.value };                  // changeable until the last lock lands
  if(allGuessed(room)) resolveGuesses(room);
  return true;
}
function resolveGuesses(room){
  if(room.phase!=='guess') return;
  const x=mult(room), players=active(room);
  room.stepDrinks={};
  room.roundResults=players.map(p=>{
    const verdict=judgeGuess(room.round, p.cards, p.guess.value);
    const sips=roundSips(room.round, verdict, x);
    if(verdict==='right') p.correct++;
    else { p.wrong++; if(verdict==='post') p.posts++; drink(room, p, sips); }
    return { pid:p.pid, guess:p.guess.value, verdict, sips, card:p.cards[room.round-1] };
  });
  room.phase='reveal'; mark(room);
  const anim=R.roundRevealMs(players.length);
  schedule(room, anim+T.DRINK_BREAK, ()=>nextFromReveal(room), { minMs:anim, readyable:true });
}
function nextFromReveal(room){
  if(room.phase!=='reveal') return;
  if(room.round<ROUNDS.length){ room.round++; beginGuess(room); return; }
  beginPyramid(room);
}

// ---- act 2: the pyramid ----
function beginPyramid(room){
  room.pyr={ slots:pyramidSlots(), idx:-1, step:'intro', holders:[], claimed:new Set(), assigned:new Map(), result:null };
  room.phase='pyramid'; room.stepDrinks={}; room.roundResults=null; mark(room);
  schedule(room, T.PYR_INTRO, ()=>flip(room));
}
function flip(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.idx>=y.slots.length-1) return;
  y.idx++; room.stepDrinks={}; y.result=null;
  drawIntoSlot(room);
}
function cardsInPlay(room){
  const out=[];
  for(const p of room.players.values()) if(p.dealt || p.satOut) out.push(...p.cards);
  room.pyr.slots.forEach((s,i)=>{ if(i<=room.pyr.idx && s.card) out.push(s.card); });
  return out;
}
function nextCard(room, slot){
  const held=[...new Set(active(room).flatMap(p=>p.cards.map(c=>c.r)))];
  const inPlay=cardsInPlay(room);
  const free=()=>newDeck().filter(c=>!inPlay.some(x=>same(x,c)));
  // After a few burns in a row, stop teasing: the next card is one somebody holds.
  if(slot.burned.length>=R.maxBurns(active(room).length)){
    const pool=free().filter(c=>held.includes(c.r));
    if(pool.length) return pick(pool);
    return { r:pick(held), s:pick(SUITS) };
  }
  room.deck=room.deck.filter(c=>!inPlay.some(x=>same(x,c)));
  if(!room.deck.length) room.deck=shuffle(free());
  return room.deck.pop() || { r:pick(held), s:pick(SUITS) };
}
function drawIntoSlot(room){
  const y=room.pyr, slot=y.slots[y.idx];
  if(room.phase!=='pyramid') return;
  if(slot.card) slot.burned.push(slot.card);
  slot.card=nextCard(room, slot);
  y.holders=holdersFor(active(room), slot.card.r);
  y.claimed=new Set(); y.assigned=new Map(); y.result=null;
  mark(room);
  if(!y.holders.length){ burnCurrent(room); return; }
  clearAuto(room);
  y.step='claim';
}
function burnCurrent(room){
  const y=room.pyr, slot=y.slots[y.idx];
  y.step='burn';
  feed(room, `🔥 Nobody had a ${slot.card.r} — burned`);
  schedule(room, R.burnHoldMs(slot.burned.length), ()=>drawIntoSlot(room));
}
/** Returns 'ok' | 'nope' (tapped without holding it) | null (not now). */
function submitHave(room, p){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='claim' || !p.dealt || room.paused) return null;
  if(!y.holders.some(h=>h.pid===p.pid)) return 'nope';
  if(y.claimed.has(p.pid)) return null;
  const rank=y.slots[y.idx].card.r;
  y.claimed.add(p.pid);
  p.cards.forEach((c,i)=>{ if(c.r===rank && !p.played[i]){ p.played[i]=true; p.matches++; } });
  maybeFinishClaims(room);
  return 'ok';
}
function maybeFinishClaims(room){
  const y=room.pyr;
  if(y.step!=='claim' || !y.holders.every(h=>y.claimed.has(h.pid))) return;
  y.step='assign'; mark(room);
  maybeFinishAssign(room);
}
function submitAssign(room, p, m){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='assign' || y.assigned.has(p.pid) || room.paused) return false;
  const h=y.holders.find(h=>h.pid===p.pid); if(!h) return false;
  const ok=validateAssignment(y.slots[y.idx], h.count, p.pid, active(room).map(d=>d.pid), m);
  if(!ok) return false;
  y.assigned.set(p.pid, ok);
  maybeFinishAssign(room);
  return true;
}
function maybeFinishAssign(room){
  const y=room.pyr;
  if(y.step!=='assign' || !y.holders.every(h=>y.assigned.has(h.pid))) return false;
  const slot=y.slots[y.idx];
  const gives=[], finishes=[];
  for(const h of y.holders){
    const from=room.players.get(h.pid), a=y.assigned.get(h.pid);
    if(a.finish) for(const to of a.finish){
      const tp=room.players.get(to); if(!tp || !tp.dealt) continue;
      tp.finishes++; if(from) from.finishesGiven++;
      finishes.push({ from:h.pid, to });
    }
    if(a.sips) for(const [to,n] of Object.entries(a.sips)){
      const tp=room.players.get(to); if(!tp || !tp.dealt) continue;
      if(from) from.sipsGiven+=n;
      drink(room, tp, n);
      gives.push({ from:h.pid, to, sips:n });
    }
  }
  y.result={ card:slot.card, level:slot.level, finish:slot.finish, gives, finishes };
  y.step='result'; mark(room);
  if(finishes.length) feed(room, `🍺 ${finishes.map(f=>room.players.get(f.to)?.name).join(' & ')} had to finish their drink`);
  const anim=R.resultRevealMs(y.result);
  schedule(room, anim+(slot.finish?T.FINISH_BREAK:T.RESULT_BREAK), ()=>afterResult(room), { minMs:anim+(slot.finish?2500:0), readyable:true });
  return true;
}
function afterResult(room){
  const y=room.pyr;
  if(room.phase!=='pyramid' || y.step!=='result') return;
  if(y.idx<y.slots.length-1) flip(room); else toRider(room);
}

// ---- act 3: ride the bus ----
function toRider(room){
  const r=pickRider(active(room));
  room.riderPid=r.pid; room.riderReason=r.reason; room.riderCandidates=r.candidates;
  room.bus=null; room.stepDrinks={}; room.phase='rider'; mark(room);
  schedule(room, T.ROUL+T.RIDER_HOLD, ()=>boardBus(room));
}
function dealBus(room, event){
  clearAuto(room);
  const b=room.bus;
  b.cards=shuffle(newDeck()).slice(0,b.length);
  b.pos=0; b.status='guessing'; b.lastGuess=null; b.lastBets=null; b.bets=new Map(); b.lastEvent=event;
  mark(room);
}
function boardBus(room){
  if(room.phase!=='rider') return false;
  room.bus={ length:room.settings.busLength, attempt:1, bestRun:0, totalSips:0, cards:[], pos:0, status:'guessing', lastGuess:null, lastBets:null, bets:new Map(), lastEvent:'deal' };
  room.phase='bus'; room.stepDrinks={};
  dealBus(room, 'deal');
  return true;
}
function busGuess(room, p, value){
  const b=room.bus;
  if(room.phase!=='bus' || b.status!=='guessing' || p.pid!==room.riderPid || room.paused) return false;
  if(value!=='higher' && value!=='lower') return false;
  // No calling a card before it has finished landing on everyone's screen.
  const gate = b.lastEvent==='deal'||b.lastEvent==='redeal' ? T.BUS_DEAL_UI : T.BUS_UI;
  if(Date.now() < room.stepAt+hold(gate)-400) return false;
  room.stepDrinks={};
  const verdict=judgeBus(b.cards[b.pos], b.cards[b.pos+1], value);
  const hit=verdict==='right';
  b.lastBets=[...b.bets].map(([bpid,bet])=>{
    const bp=room.players.get(bpid); const won=(bet==='hit')===hit;
    if(bp){ if(won) bp.betsWon++; else { bp.betsLost++; drink(room, bp, R.SIDE_BET_SIPS); } }
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
      schedule(room, T.BUS_VERDICT+T.BUS_DONE_HOLD, ()=>finishGame(room));
    }
    return true;
  }
  const sips=guessNo*mult(room);
  drink(room, p, sips); b.totalSips+=sips;
  b.lastGuess={ guess:value, verdict, sips };
  b.status='failed'; b.lastEvent='miss';
  schedule(room, T.BUS_VERDICT+T.BUS_MISS_BREAK, ()=>busAgain(room));
  return true;
}
function busAgain(room){
  if(room.phase!=='bus' || room.bus.status!=='failed') return false;
  room.bus.attempt++; room.stepDrinks={};
  dealBus(room, 'redeal');
  return true;
}
function placeBet(room, p, bet){
  const b=room.bus;
  if(room.phase!=='bus' || b.status!=='guessing' || p.pid===room.riderPid || room.paused) return false;
  if(bet==='hit' || bet==='miss') b.bets.set(p.pid, bet);
  else if(bet===null) b.bets.delete(p.pid);
  else return false;
  return true;
}
function skipBus(room, who){
  if(room.phase!=='rider' && room.phase!=='bus') return false;
  room.busSkipped=true;
  feed(room, `🥴 ${who} pulled the emergency stop — bus skipped`);
  finishGame(room);
  return true;
}
function finishGame(room){
  clearAuto(room);
  room.paused=false;
  room.phase='gameOver'; room.stepDrinks={}; mark(room);
}

// ---- host controls ----
function endGame(room){
  if(!inGame(room)) return false;
  room.endedEarly=true;
  feed(room, '⏹ The host ended the game');
  finishGame(room);
  return true;
}
function toLobby(room){
  clearAuto(room);
  room.phase='lobby'; room.pyr=null; room.bus=null; room.roundResults=null; room.stepDrinks={}; room.feed=[];
  room.riderPid=null; room.riderReason=null; room.riderCandidates=null; room.busSkipped=false; room.round=0;
  room.paused=false; room.endedEarly=false;
  pruneGone(room);
  for(const p of room.players.values()) freshStats(p);
  mark(room);
}
function pruneGone(room){
  const now=Date.now();
  for(const [id,p] of room.players){
    if(!p.connected && (p.gone || (p.dropAt && now-p.dropAt>=RECONNECT_GRACE_MS))){ clearTimeout(p.disconnectTimer); room.players.delete(id); }
  }
}
function configure(room, m){
  if(room.phase!=='lobby' && room.phase!=='gameOver') return false;
  const s=room.settings;
  if(INTENSITY[m.intensity]) s.intensity=m.intensity;
  if(BUS_LENGTHS.includes(+m.busLength)) s.busLength=+m.busLength;
  return true;
}
/** Take a stuck player out of the current game so the table can move on. */
function sitOut(room, pid){
  const p=room.players.get(pid);
  if(!p || !p.dealt || !inGame(room)) return false;
  p.dealt=false; p.satOut=true; p.guess=null;
  room.ready.delete(pid);
  feed(room, `🪑 ${p.name} sat out the rest of this game`);
  if(active(room).length<MIN_PLAYERS){ room.endedEarly=true; finishGame(room); return true; }
  const y=room.pyr;
  switch(room.phase){
    case 'guess': if(allGuessed(room)) resolveGuesses(room); break;
    case 'reveal': checkReady(room); break;          // their flip already happened on every screen
    case 'pyramid':
      y.holders=y.holders.filter(h=>h.pid!==pid); y.claimed.delete(pid); y.assigned.delete(pid);
      if((y.step==='claim' || y.step==='assign') && !y.holders.length){ mark(room); burnCurrent(room); break; }
      if(y.step==='claim') maybeFinishClaims(room);
      else if(y.step==='assign') maybeFinishAssign(room);
      else checkReady(room);
      break;
    case 'rider': case 'bus':
      if(room.riderPid===pid) toRider(room);
      else if(room.bus) room.bus.bets.delete(pid);
      break;
  }
  return true;
}
function kick(room, pid){
  const p=room.players.get(pid);
  if(!p || (p.dealt && inGame(room))) return false;
  clearTimeout(p.disconnectTimer);
  room.players.delete(pid);
  if(p.ws){ const w=p.ws; meta.delete(w); send(w,{type:'kicked'}); try{ w.close(); }catch(e){} }
  return true;
}

// ---- messages ----
function handle(ws, m){
  let info = meta.get(ws);
  if(!info){ info={}; meta.set(ws, info); }
  info.lastSeen=Date.now();
  if(m.type==='ping'){ info.pinged=true; send(ws,{type:'pong', serverNow:Date.now()}); return; }

  if(m.type==="host"){
    if(info.roomCode) return;
    const code=claimCode("irishpoker");
    const room={ code, hostWs:ws, hostToken:token(), hostConnected:true, players:new Map(), phase:"lobby",
      settings:defaultSettings(), gameId:0, round:0, stepAt:Date.now(), emptyTimer:null, auto:null, ready:new Set(), paused:false, endedEarly:false,
      deck:[], pyr:null, bus:null, roundResults:null, stepDrinks:{}, feed:[], riderPid:null, riderReason:null, riderCandidates:null, busSkipped:false };
    rooms.set(code, room); Object.assign(info,{ roomCode:code, isHost:true });
    send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
  }
  if(m.type==="join"){
    if(info.roomCode) return;
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    const name=String(m.name||"Player").replace(/\s+/g,' ').trim().slice(0,18)||"Player";
    const existing=[...room.players.values()].find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(existing){
      if(existing.connected){ send(ws,{type:"error",msg:`"${name}" is already playing in this room — pick a different name.`}); return; }
      // Same name, seat is empty: that's them on a new tab or after a lost session.
      takeSeat(room, existing, ws, info, token());
      return;
    }
    if(room.players.size>=MAX_PLAYERS){ send(ws,{type:"error",msg:`Room is full (${MAX_PLAYERS} players max).`}); return; }
    const used=new Set([...room.players.values()].map(p=>p.color));
    const color=COLORS.find(c=>!used.has(c)) || COLORS[room.players.size % COLORS.length];
    const p={ pid:newId(), resumeToken:token(), connected:false, disconnectTimer:null, gone:false, dropAt:null, name, color, ws:null };
    freshStats(p);
    room.players.set(p.pid,p);
    takeSeat(room, p, ws, info, p.resumeToken);
    return;
  }
  if(m.type==="resume"){
    if(info.roomCode) return;
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"That room has closed.",fatal:true}); return; }
    if(!m.pid){
      if(!m.token || m.token!==room.hostToken){ send(ws,{type:"error",msg:"Could not resume as host — start a new game.",fatal:true}); return; }
      if(room.hostWs && room.hostWs!==ws){ meta.delete(room.hostWs); try{ room.hostWs.close(); }catch(e){} }
      room.hostWs=ws; room.hostConnected=true; clearTimeout(room.emptyTimer);
      Object.assign(info,{ roomCode:code, isHost:true });
      send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
    }
    const p=room.players.get(m.pid);
    if(!p || !m.token || m.token!==p.resumeToken){ send(ws,{type:"error",msg:"Your seat is gone — join again with your name.",fatal:true}); return; }
    takeSeat(room, p, ws, info, p.resumeToken);
    return;
  }

  const room = rooms.get(info.roomCode); if(!room) return;
  const p = info.pid ? room.players.get(info.pid) : null;
  const isHost = !!info.isHost && room.hostWs===ws;
  if(!isHost && !p) return;
  // The TV runs the room. If it's gone, any phone can, so nobody is stranded.
  const control = isHost || (!!p && !room.hostConnected);
  const isRider = !!p && p.pid===room.riderPid;
  let changed=false;

  switch(m.type){
    // --- the room (host screen) ---
    case 'configure': changed = control && configure(room, m); break;
    case 'start': case 'newGame':
      if(!control) return;
      if(!deal(room)){ send(ws,{type:'error',msg:`Need at least ${MIN_PLAYERS} connected players to deal.`}); return; }
      changed=true; break;
    case 'endGame':  changed = control && endGame(room); break;
    case 'toLobby':  changed = control && room.phase!=='lobby' && (toLobby(room), true); break;
    case 'pause':    changed = control && setPaused(room, true); break;
    case 'unpause':  changed = control && setPaused(room, false); break;
    case 'skip':     changed = control && !room.paused && skipWait(room); break;
    case 'sitOut':   changed = control && sitOut(room, String(m.pid||'')); break;
    case 'kick':     changed = control && kick(room, String(m.pid||'')); break;
    // --- players ---
    case 'guess':    changed = !!p && submitGuess(room, p, m); break;
    case 'have': {
      if(!p) return;
      const r=submitHave(room, p);
      if(r==='nope'){ send(ws,{type:'nope'}); return; }
      changed = r==='ok'; break;
    }
    case 'assign':   changed = !!p && submitAssign(room, p, m); break;
    case 'ready':
      if(!p || !p.dealt || !room.auto || !room.auto.readyable || room.ready.has(p.pid)) return;
      room.ready.add(p.pid); checkReady(room); changed=true; break;
    case 'boardBus':
      if(!(isRider||control) || room.phase!=='rider' || Date.now()<room.stepAt+hold(T.ROUL+900)) return;
      changed = boardBus(room); break;
    case 'busAgain':
      if(!(isRider||control) || room.phase!=='bus' || room.bus.status!=='failed' || Date.now()<room.stepAt+hold(T.BUS_UI)-150) return;
      changed = busAgain(room); break;
    case 'busGuess': changed = !!p && busGuess(room, p, m.value); break;
    case 'bet':      changed = !!p && placeBet(room, p, m.bet===undefined?null:m.bet); break;
    case 'skipBus':  changed = (isRider||control) && skipBus(room, p ? p.name : 'The host'); break;
    default: return;
  }
  if(changed) pushState(room);
}

function takeSeat(room, p, ws, info, seatToken){
  clearTimeout(p.disconnectTimer); p.disconnectTimer=null; p.gone=false; p.dropAt=null;
  if(p.ws && p.ws!==ws){ meta.delete(p.ws); try{ p.ws.close(); }catch(e){} }
  p.ws=ws; p.connected=true; p.resumeToken=seatToken;
  clearTimeout(room.emptyTimer);
  Object.assign(info,{ roomCode:room.code, pid:p.pid });
  send(ws,{type:"joined",pid:p.pid,code:room.code,token:seatToken});
  checkReady(room);
  pushState(room);
}

function scheduleEmptyCleanup(room){
  const anyone = room.hostConnected || [...room.players.values()].some(p=>p.connected);
  if(anyone) return;
  clearTimeout(room.emptyTimer);
  room.emptyTimer=setTimeout(()=>{
    if(rooms.get(room.code)!==room) return;
    if(room.hostConnected || [...room.players.values()].some(p=>p.connected)) return;
    clearAuto(room);
    for(const p of room.players.values()) clearTimeout(p.disconnectTimer);
    releaseCode(room.code); rooms.delete(room.code);
  }, EMPTY_ROOM_TTL_MS);
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    if(room.hostWs!==ws) return;
    room.hostConnected=false; room.hostWs=null;
    // Nobody left to un-pause it otherwise.
    if(room.paused) setPaused(room, false);
    pushState(room); scheduleEmptyCleanup(room);
    return;
  }
  if(!info.pid) return;
  const p=room.players.get(info.pid); if(!p || p.ws!==ws) return;
  // Never play for someone who dropped: the table waits, and the host can sit them out.
  p.connected=false; p.ws=null; p.dropAt=Date.now();
  if(room.bus) room.bus.bets.delete(p.pid);
  checkReady(room);
  pushState(room);
  scheduleEmptyCleanup(room);
  clearTimeout(p.disconnectTimer);
  p.disconnectTimer=setTimeout(()=>{
    if(room.players.get(p.pid)!==p || p.connected) return;
    if(room.phase==='lobby'){ room.players.delete(p.pid); pushState(room); return; }
    p.gone=true;       // keep the seat and the stats until this game is over
  }, RECONNECT_GRACE_MS);
}

// Browsers can't send WebSocket pings, so clients ping in-band. A client that
// has pinged before and then goes silent (phone locked, wifi gone) is treated
// as disconnected instead of looking online forever on a half-dead socket.
const sweeper=setInterval(()=>{
  const now=Date.now();
  for(const [ws,info] of meta){
    if(info.pinged && now-info.lastSeen>STALE_SOCKET_MS){ handleClose(ws); try{ ws.close(); }catch(e){} }
  }
}, 5000);
if(sweeper.unref) sweeper.unref();

export const open    = ws => { meta.set(ws,{ lastSeen:Date.now() }); };
export const message = (ws,msg) => { let m; try{ m=JSON.parse(msg); }catch(e){ return; } try{ handle(ws, m); }catch(e){ console.error('[irishpoker]', e); } };
export const close   = ws => { handleClose(ws); };
