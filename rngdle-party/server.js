// RNGparty — online (Jackbox-style) server.
// Run with:  bun server.js   (or)   node server.js
// Serves the static app and runs realtime rooms. Rolls are generated
// server-side with the SAME extracted engine so every screen stays in sync.

import "./engine.js";                 // sets globalThis.RNGDLE
import "./drinks.js";                 // sets globalThis.RNGPARTY_DRINKS
import { networkInterfaces } from "os";
import * as HorsRNG from "./horsrng-server.js";   // separate game, separate rooms, separate ws path
import * as Imposter from "./imposter-server.js"; // separate game, separate rooms, separate ws path
const R = globalThis.RNGDLE;
const D = globalThis.RNGPARTY_DRINKS;

const PORT = Number(process.env.PORT || 3000);
// All of these must match index.html — the server holds the round open for as
// long as the clients spend animating it.
const PER_DIGIT = 1100, LAST_EXTRA = 900;
const BADGE_LEAD = 750, BADGE_GAP = 520, BADGE_RARITY_HOLD = 170, PAYOFF_HOLD = 1200;
const AUTO_NEXT_DELAY = 4000;   // pause on the results screen before auto-advancing
const RARITY_ORDER = ['trash','common','uncommon','rare','epic','anomaly','mythic'];
const STATIC = { "/": "index.html", "/index.html": "index.html", "/engine.js": "engine.js", "/drinks.js": "drinks.js",
  "/horsrng": "horsrng.html", "/horsrng.html": "horsrng.html",
  "/imposter": "imposter.html", "/imposter.html": "imposter.html" };

const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }
const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];
// How long a dropped connection (host or player) gets to reconnect with its
// resume token before the seat is actually given up. Long enough to survive
// a real wifi blip or a phone getting backgrounded and switched back to;
// short enough that a genuinely abandoned room doesn't linger pointlessly.
const RECONNECT_GRACE_MS = 45000;

function makeCode(){ const A="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let c; do{ c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(""); }while(rooms.has(c)); return c; }
function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
// A bearer credential for reclaiming a seat after a disconnect — longer and
// higher-entropy than pid() since guessing this hands over someone's spot.
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }
function broadcast(room,o){ const s=JSON.stringify(o); if(room.hostWs){ try{room.hostWs.send(s)}catch(e){} } for(const p of room.players.values()){ if(p.ws){ try{p.ws.send(s)}catch(e){} } } }

function stateMsg(room){
  return { type:"state", phase:room.phase, round:room.round, target:room.target, mode:room.mode,
    autoNext:room.autoNext, revealMode:room.revealMode, revealStep:room.revealStep, revealMaxLen:room.revealMaxLen,
    drinking:room.drinking, difficulty:room.difficulty, drink:drinkMsg(room),
    hostConnected:room.hostConnected,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, score:p.score, rolls:p.rolls, ready:p.ready, connected:p.connected,
      lastNumber: p.last?p.last.number:null, lastScore:p.last?p.last.score:null,
      lastPct: p.last?p.last.pct:null, lastRarity:p.last?p.last.rarity:null,
      bestScore:p.bestScore, bestScoreTier:p.bestScoreTier, bestBadge:p.bestBadge, bestNumber:p.bestNumber
    })) };
}
function pushState(room){ broadcast(room, stateMsg(room)); }
function genRoll(){ const r=R.roll();
  // tiers stay server-side: they only size the reveal window. Clients rebuild the
  // badges themselves from the number, so nothing extra goes over the wire.
  const scoring = r.badges.filter(b=>b.isScoring);
  const tiers = scoring.slice().sort((a,b)=>a.score-b.score).map(b=>R.getBadgeRarityTier(b.score));
  const top = scoring.length ? scoring.slice().sort((a,b)=>b.score-a.score)[0] : null;
  const topBadge = top ? { id:top.id, label:top.label, emoji:top.emoji, score:top.score } : null;
  return { number:r.number, score:r.totalScore, pct:r.percentile, rarity:r.cardRarity, tiers, topBadge }; }

/* Duration of the badge portion alone: step k waits on the rarest badge any
   player lands at k, then the rarity payoff. Mirrors renderBreakdown() in
   index.html. Shared by the auto full-round timer and the manual mode's
   post-digits timer (manual skips the digit portion — the host paces that). */
function badgeScheduleMs(tiersList){
  const steps = Math.max(0, ...tiersList.map(t=>t.length));
  let ms = steps ? BADGE_LEAD : 0;
  for(let k=0;k<steps;k++){
    let hold=0;
    for(const t of tiersList) if(k<t.length) hold=Math.max(hold, RARITY_ORDER.indexOf(t[k]));
    ms += BADGE_GAP + Math.max(0,hold)*BADGE_RARITY_HOLD;
  }
  return ms + PAYOFF_HOLD;
}
/* Full round duration: digits, then the badge schedule. Mirrors hostReveal()
   in index.html — used only for auto reveal mode. */
function revealMs(pendings){
  const maxLen = Math.max(1, ...pendings.map(p=>String(p.number).length));
  return maxLen*PER_DIGIT + LAST_EXTRA + badgeScheduleMs(pendings.map(p=>p.tiers||[]));
}

function beginReveal(room){
  if(room.phase!=="collecting") return;
  room.phase="revealing";
  const pendings=[];
  for(const p of room.players.values()){ if(p.pending){ p.last=p.pending; pendings.push(p.pending); } }
  if(room.revealMode==="manual"){
    // Digits are paced by the host clicking "reveal next digit"; endReveal()
    // fires once that's done and the badge schedule (below) has played out.
    room.revealStep=0;
    room.revealMaxLen=Math.max(1, ...pendings.map(p=>String(p.number).length));
    pushState(room);
    return;
  }
  pushState(room);
  clearTimeout(room.revealTimer);
  room.revealTimer=setTimeout(()=>endReveal(room), (pendings.length?revealMs(pendings):0) + 700);
}
/* ---------- drinking game ----------
   After a reveal the round no longer ends on its own. It goes:
     assigning  — players holding a "pick someone" rule choose a target
     drinking   — everyone sees their tally and confirms they drank
   then straight back to collecting, so the next prompt is "roll". */
function drinkMsg(room){
  if(!room.drinkRolls) return null;
  return { rolls:room.drinkRolls, choices:room.drinkChoices||{},
           tally:room.drinkTally||null, confirmed:[...(room.drinkConfirmed||[])] };
}
function startDrinks(room){
  const players=[...room.players.values()].filter(p=>p.last);
  if(!players.length){ finishDrinks(room); return; }
  const scores=players.map(p=>p.last.score);
  const hi=Math.max(...scores), lo=Math.min(...scores);
  const solo=players.length===1;
  room.drinkRolls=players.map(p=>({ pid:p.pid, name:p.name,
    effects: D.effectsFor(R.roll(p.last.number), {
      isHighest: !solo && p.last.score===hi,
      isLowest:  !solo && p.last.score===lo && hi!==lo,
      soloPlayer: solo, difficulty: room.difficulty }) }));
  room.drinkChoices={}; room.drinkConfirmed=new Set();
  if(room.drinkRolls.some(r=>r.effects.some(D.needsTarget))){ room.phase="assigning"; pushState(room); }
  else beginDrinking(room);
}
function beginDrinking(room){
  const pids=[...room.players.keys()];
  room.drinkTally=D.buildTally(room.drinkRolls, room.drinkChoices, pids);
  room.phase="drinking";
  // nothing to drink = nothing to confirm, or the round would wait on them forever
  for(const pid of pids){ const t=room.drinkTally[pid]; if(!t||(!t.sips&&!t.shots)) room.drinkConfirmed.add(pid); }
  pushState(room);
  maybeFinishDrinks(room);
}
function maybeFinishDrinks(room){
  if([...room.players.keys()].every(pid=>room.drinkConfirmed.has(pid))) finishDrinks(room);
}
function finishDrinks(room){
  room.drinkRolls=null; room.drinkChoices=null; room.drinkTally=null; room.drinkConfirmed=null;
  if(room.mode==="rounds" && room.round>=room.target){ room.phase="gameOver"; pushState(room); return; }
  advanceRound(room);              // straight to collecting: next prompt is "roll"
}

function endReveal(room){
  for(const p of room.players.values()){ if(p.pending){ p.score+=p.pending.score; p.rolls++;
    if(p.pending.score>(p.bestScore||0)){ p.bestScore=p.pending.score; p.bestScoreTier=p.pending.rarity; p.bestNumber=p.pending.number; }
    if(p.pending.topBadge && (!p.bestBadge || p.pending.topBadge.score>p.bestBadge.score)) p.bestBadge=p.pending.topBadge;
    p.pending=null; } p.ready=false; }
  if(room.drinking){ startDrinks(room); return; }   // drinks replace the round-end pause
  const over = room.mode==="rounds" && room.round>=room.target;
  room.phase = over ? "gameOver" : "roundEnd";
  pushState(room);
  if(!over && room.autoNext){
    clearTimeout(room.autoNextTimer);
    room.autoNextTimer=setTimeout(()=>advanceRound(room), AUTO_NEXT_DELAY);
  }
}
function maybeAutoReveal(room){
  const ps=[...room.players.values()];
  if(ps.length>0 && ps.every(p=>p.ready)) beginReveal(room);
}
function advanceRound(room){
  if(room.phase!=="roundEnd" && room.phase!=="drinking" && room.phase!=="assigning") return;
  clearTimeout(room.autoNextTimer);
  room.round++; room.phase="collecting";
  for(const p of room.players.values()){ p.ready=false; p.pending=null; p.last=null; }
  pushState(room);
}

function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    const code=makeCode();
    const hostToken=token();
    const room={ code, hostWs:ws, hostToken, hostConnected:true, hostGraceTimer:null, players:new Map(), mode:(m.mode==="endless"?"endless":"rounds"), target:[3,5,10].includes(+m.target)?+m.target:5, round:1, phase:"lobby", revealTimer:null,
      autoNext:(m.autoNext!==false), autoNextTimer:null, drinking:!!m.drinking, difficulty:(D.DIFFICULTY[m.difficulty]?m.difficulty:"medium"),
      drinkRolls:null, drinkChoices:null, drinkTally:null, drinkConfirmed:null, revealMode:(m.revealMode==="manual"?"manual":"auto"), revealStep:0, revealMaxLen:0 };
    rooms.set(code, room); meta.set(ws,{ roomCode:code, isHost:true });
    send(ws,{type:"hosted",code,token:hostToken}); pushState(room); return;
  }
  if(m.type==="join"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    const name=String(m.name||"Player").slice(0,18).trim()||"Player";
    if([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase())){
      send(ws,{type:"error",msg:`"${name}" is already in this room — pick a different name.`}); return;
    }
    const id=pid(), seatToken=token();
    const color=COLORS[room.players.size % COLORS.length];
    room.players.set(id,{ pid:id, resumeToken:seatToken, connected:true, disconnectTimer:null, name, color, score:0, rolls:0, ws, ready:false, pending:null, last:null, bestScore:0, bestScoreTier:null, bestBadge:null, bestNumber:null });
    meta.set(ws,{ roomCode:code, pid:id });
    send(ws,{type:"joined",pid:id,code,token:seatToken}); pushState(room); return;
  }
  if(m.type==="resume"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(!m.pid){   // host resuming
      if(!m.token || m.token!==room.hostToken){ send(ws,{type:"error",msg:"Could not resume as host — start a new party."}); return; }
      clearTimeout(room.hostGraceTimer); room.hostGraceTimer=null;
      room.hostWs=ws; room.hostConnected=true;
      meta.set(ws,{ roomCode:code, isHost:true });
      send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
    }
    const p=room.players.get(m.pid);
    if(!p || !m.token || m.token!==p.resumeToken){ send(ws,{type:"error",msg:"Could not resume — join as a new player instead."}); return; }
    clearTimeout(p.disconnectTimer); p.disconnectTimer=null;
    p.ws=ws; p.connected=true;
    meta.set(ws,{ roomCode:code, pid:m.pid });
    send(ws,{type:"joined",pid:m.pid,code,token:p.resumeToken}); pushState(room); return;
  }
  const room = rooms.get(info.roomCode); if(!room) return;
  if(m.type==="configure" && info.isHost){
    // Every setting is changeable mid-party. Shortening the round target below
    // the current round just means the next round end is the last one.
    if(m.mode) room.mode = m.mode==="endless"?"endless":"rounds";
    if([3,5,10].includes(+m.target)) room.target=+m.target;
    if(m.revealMode) room.revealMode = m.revealMode==="manual"?"manual":"auto";
    if(typeof m.drinking==="boolean") room.drinking=m.drinking;
    if(D.DIFFICULTY[m.difficulty]) room.difficulty=m.difficulty;
    if(typeof m.autoNext==="boolean") room.autoNext=m.autoNext;
    pushState(room); return;
  }
  if(m.type==="start" && info.isHost && room.phase==="lobby"){
    if(room.players.size<1) return;
    for(const p of room.players.values()){ p.score=0; p.rolls=0; p.ready=false; p.pending=null; p.last=null; p.bestScore=0; p.bestScoreTier=null; p.bestBadge=null; p.bestNumber=null; }
    room.round=1; room.phase="collecting"; pushState(room); return;
  }
  if(m.type==="rollReady" && info.pid && room.phase==="collecting"){
    const p=room.players.get(info.pid); if(!p || p.ready) return;
    p.pending=genRoll(); p.ready=true; pushState(room); maybeAutoReveal(room); return;
  }
  if(m.type==="forceReveal" && info.isHost && room.phase==="collecting"){
    for(const p of room.players.values()){ if(!p.ready){ p.pending=genRoll(); p.ready=true; } }
    beginReveal(room); return;
  }
  if(m.type==="next" && info.isHost){ advanceRound(room); return; }
  if(m.type==="revealStep" && info.isHost && room.phase==="revealing" && room.revealMode==="manual"){
    if(room.revealStep>=room.revealMaxLen) return;
    room.revealStep++;
    pushState(room);
    if(room.revealStep>=room.revealMaxLen){
      const pendings=[...room.players.values()].map(p=>p.last).filter(Boolean);
      clearTimeout(room.revealTimer);
      room.revealTimer=setTimeout(()=>endReveal(room), badgeScheduleMs(pendings.map(p=>p.tiers||[])) + 700);
    }
    return;
  }
  if(m.type==="assignDrink" && info.pid && room.phase==="assigning"){
    const roll=room.drinkRolls&&room.drinkRolls.find(r=>r.pid===info.pid); if(!roll) return;
    const i=+m.idx, e=roll.effects[i];
    if(!e || !D.needsTarget(e) || !room.players.has(m.toPid)) return;
    room.drinkChoices[info.pid+":"+i]=m.toPid;
    const pending=room.drinkRolls.some(r=>r.effects.some((x,j)=>D.needsTarget(x)&&!room.drinkChoices[r.pid+":"+j]));
    if(pending) pushState(room); else beginDrinking(room);
    return;
  }
  if(m.type==="drinkDone" && info.pid && room.phase==="drinking"){
    room.drinkConfirmed.add(info.pid); pushState(room); maybeFinishDrinks(room); return;
  }
  // escape hatch: someone locked their phone mid-round and the table is waiting
  if(m.type==="skipDrinks" && info.isHost && (room.phase==="assigning"||room.phase==="drinking")){
    finishDrinks(room); return;
  }
  if(m.type==="endGame" && info.isHost){ clearTimeout(room.revealTimer); clearTimeout(room.autoNextTimer); room.phase="gameOver"; pushState(room); return; }
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    // Only tear down if THIS socket is still the room's current host connection —
    // a stale close firing after the host already reconnected elsewhere must not
    // kill the fresh session.
    if(room.hostWs!==ws) return;
    room.hostConnected=false; room.hostWs=null;
    pushState(room);   // lets players' screens show "waiting for host to reconnect…"
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer=setTimeout(()=>{
      clearTimeout(room.revealTimer); clearTimeout(room.autoNextTimer);
      broadcast(room,{type:"error",msg:"Host didn't reconnect in time — party ended."});
      rooms.delete(room.code);
    }, RECONNECT_GRACE_MS);
    return;
  }
  if(info.pid){
    const p=room.players.get(info.pid); if(!p || p.ws!==ws) return;   // stale close after a resume elsewhere
    p.connected=false; p.ws=null;
    // A player who vanishes while everyone's waiting on THEM shouldn't stall
    // the table for the whole grace window — resolve what we safely can now.
    if(room.phase==="drinking" && room.drinkConfirmed && !room.drinkConfirmed.has(info.pid)){
      room.drinkConfirmed.add(info.pid); maybeFinishDrinks(room);
    }
    pushState(room);
    if(room.phase==="collecting") maybeAutoReveal(room);
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer=setTimeout(()=>{
      if(room.players.get(info.pid)===p && !p.connected){
        room.players.delete(info.pid);
        if(room.phase==="collecting") maybeAutoReveal(room);
        pushState(room);
      }
    }, RECONNECT_GRACE_MS);
  }
}

const onOpen    = ws => { meta.set(ws,{}); };
const onMessage = (ws,msg) => { try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } };
const onClose   = ws => { handleClose(ws); };

const WS_ROUTES = {
  "/ws":          { open:onOpen, message:onMessage, close:onClose },
  "/horsrng-ws":  { open:HorsRNG.open, message:HorsRNG.message, close:HorsRNG.close },
  "/imposter-ws": { open:Imposter.open, message:Imposter.message, close:Imposter.close },
};

if (globalThis.Bun) {
  var server = Bun.serve({
    port: PORT,
    fetch(req){
      const url=new URL(req.url);
      const route = WS_ROUTES[url.pathname];
      if(route){ if(server.upgrade(req,{data:{route}})) return; return new Response("upgrade failed",{status:426}); }
      const file = STATIC[url.pathname];
      if(file) return new Response(Bun.file(file), {headers:{"cache-control":"no-cache"}});  // else edits look stale in the browser
      return new Response("Not found",{status:404});
    },
    // One shared handler set, dispatching to the right game's room logic by
    // whichever route each socket upgraded through — Bun keeps ws handlers global.
    websocket:{
      open:ws=>ws.data.route.open(ws),
      message:(ws,msg)=>ws.data.route.message(ws,msg),
      close:ws=>ws.data.route.close(ws),
    }
  });
} else {
  const { serve } = await import("./node-ws.js");
  serve({ port:PORT, staticFiles:STATIC, wsRoutes:WS_ROUTES });
}

// print addresses
const ips=[];
const nifs=networkInterfaces();
for(const name of Object.keys(nifs)){ for(const ni of nifs[name]||[]){ if(ni.family==="IPv4" && !ni.internal) ips.push(ni.address); } }
console.log("\n🎲  RNGparty server running on "+(globalThis.Bun?"Bun":"Node "+process.version)+"\n");
console.log("   Host screen (this machine):  http://localhost:"+PORT);
for(const ip of ips) console.log("   Friends on same Wi-Fi join:  http://"+ip+":"+PORT);
console.log("\n   Open the host link, click Party → Online → Host. Share the room code.\n");
