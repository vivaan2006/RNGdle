// RNGold Rush — online-only push-your-luck party drinking game, server-side
// room logic. Fully independent from the other games: own Map, own message
// types, own WebSocket path (/rngoldrush-ws). No local/single-screen mode —
// the whole point of the game is a shared live pot everyone watches at once
// while making a simultaneous, secret stay/leave call each tick, which is
// exactly the kind of thing an app is good for and a table isn't (no way to
// "reveal on three" fairly with money on the line).
//
// Round shape: every tick, all players still "in" choose STAY or LEAVE at the
// same time; each leaver takes an equal share of the pot across everyone who
// was in for that spin and is safe, the rest of the pot rides on, then if
// anyone's left
// "in" a tile is drawn from the wheel and resolved. The wheel is weights
// rebuilt per spin (rngoldrush-rules.js, shared with the browser): gold tiles
// by rarity, pot multipliers that sit out an empty pot, and a skull whose odds
// start near zero and climb every spin. Skulls are strikes — it takes
// settings.skullsToEnd of them to end the round, and only the last one zeroes
// the pot and knocks out everyone still in with a flat drink penalty.
// Checkpoints (every 5 ticks) and cash-out gold both convert to drinks, but
// on separate tracks: checkpoint/bust sips are ones you *drink*, cashed-out
// gold becomes sips you *hand out* to whoever you want at round end.

import { claimCode, releaseCode } from "./rooms-registry.js";
import "./rngoldrush-rules.js";              // sets globalThis.RNGPARTY_GOLDRUSH
const G = globalThis.RNGPARTY_GOLDRUSH;      // wheel, rarities and settings — shared with the browser

const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];

// ---- tunable constants (named, not magic numbers) ----
const GOLD_TO_SIP_RATIO = 5;    // 5 gold cashed out = 1 sip to give
const BUST_PENALTY_SIPS = 2;    // flat sips drunk immediately on a bust
const CHECKPOINT_INTERVAL = 5;  // every 5th tick is a checkpoint
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;
const AUTO_STAY_TIMEOUT_MS = 15000; // a connected player who hasn't chosen by this deadline auto-stays
// Clients play a slot-reel animation on every draw and keep the choice buttons
// hidden until the whole reveal has played out: the spin itself (matched to the
// length of an RNGdle number reveal), the losing boxes clearing, a beat with the
// winner shut, its rarity lighting up, the number opening, and a last beat
// before the round UI comes back.
// REEL_TOTAL_MS in rngoldrush.html is the same number. The auto-stay clock has
// to wait all of it out or players lose most of their window to an animation
// they can't skip. Change both.
const REEL_REVEAL_MS = 7500 + 300 + 1000 + 900 + 1000;

const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }
const RECONNECT_GRACE_MS = 45000;

function makeCode(){ return claimCode("rngoldrush"); }   // globally unique across games
function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }
function broadcast(room,o){ const s=JSON.stringify(o); if(room.hostWs){ try{room.hostWs.send(s)}catch(e){} } for(const p of room.players.values()){ if(p.ws){ try{p.ws.send(s)}catch(e){} } } }

// Public state — never carries WHAT a player chose this tick, only whether
// they've locked something in (`locked`), so nobody can react to anyone
// else's choice before the tick resolves. Everything else about this game
// is meant to be watched live by the whole table, so there's no private
// per-player message type at all (unlike ImpostRNG's secret/hostSecret).
function stateMsg(room){
  return {
    type:"state", phase:room.phase, hostConnected:room.hostConnected, leaderPid:room.leaderPid,
    pot:room.pot, tick:room.tick,
    tickDeadline: room.phase==="round" ? room.tickDeadline : null,
    // Clients rebuild the wheel from these with the same shared rules file, so
    // the odds they display can't drift from the odds actually drawn from.
    settings: room.settings, skulls: room.skulls,
    skullPct: room.phase==="round" ? G.skullChance(room.tick, room.settings)*100 : null,
    roundLog: room.roundLog,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, connected:p.connected,
      status:p.status, spinCount:p.spinCount, locked: p.status==='in' && p.choice!=null,
      roundGold:p.roundGold, sipBalance:p.sipBalance, sipsGiven:p.sipsGiven, receivedSips:p.receivedSips,
      checkpointSips:p.checkpointSips, bustPenaltySips:p.bustPenaltySips,
    })),
  };
}
function pushState(room){ broadcast(room, stateMsg(room)); }

// The room "leader" is whoever's been connected longest — normally the
// first player to join, so they never have to think about it. Only
// reassigned when the current leader actually drops; reconnecting later
// does NOT reclaim leadership (avoids it flip-flopping mid-game).
function reassignLeaderIfNeeded(room){
  const cur = room.leaderPid!=null ? room.players.get(room.leaderPid) : null;
  if(cur && cur.connected) return;
  const next=[...room.players.values()].find(p=>p.connected);
  room.leaderPid = next ? next.pid : null;
}

// leadMs is dead time before the decision window opens — the reel animation
// after a draw. The deadline pushed to clients includes it.
function startTickTimer(room, leadMs=0){
  clearTimeout(room.tickTimer);
  const total = leadMs + AUTO_STAY_TIMEOUT_MS;
  room.tickDeadline = Date.now()+total;
  room.tickTimer = setTimeout(()=>{
    if(rooms.get(room.code)!==room || room.phase!=='round') return;
    let changed=false;
    for(const p of room.players.values()){
      if(p.status==='in' && p.connected && p.choice==null){ p.choice='stay'; changed=true; }
    }
    room.tickDeadline=null;
    if(changed) pushState(room);
    if(allDecided(room)) resolveTick(room);
  }, total);
}

function beginRound(room){
  if(room.phase!=="lobby" && room.phase!=="results") return;
  const connected=[...room.players.values()].filter(p=>p.connected);
  if(connected.length<MIN_PLAYERS) return;
  room.phase="round";
  room.pot=G.startingPot(connected.length, room.settings);
  room.roundLog=[];
  if(room.pot>0) room.roundLog.push({type:'seed', gold:room.pot, players:connected.length});
  room.tick=0;
  room.skulls=0;
  for(const p of room.players.values()){
    p.choice=null; p.roundGold=0; p.sipBalance=0; p.sipsGiven=0; p.receivedSips=0;
    p.checkpointSips=0; p.bustPenaltySips=0;
    if(p.connected){ p.status='in'; p.spinCount=0; }
    else p.status='waiting'; // disconnected players sit this round out, rejoin fresh next round
  }
  pushState(room);
  startTickTimer(room);
}

// A disconnected player never blocks a tick — they're treated as an
// immediate LEAVE for resolution purposes (their seat still has the normal
// 45s reconnect grace, this is just about not freezing the table).
function effectiveChoice(p){
  if(p.choice) return p.choice;
  if(!p.connected) return 'leave';
  return null;
}
function allDecided(room){
  for(const p of room.players.values()){
    if(p.status!=='in') continue;
    if(effectiveChoice(p)==null) return false;
  }
  return true;
}

function submitChoice(room, playerPid, choice){
  if(choice!=='stay' && choice!=='leave') return;
  const p=room.players.get(playerPid);
  if(!p || p.status!=='in' || room.phase!=='round' || p.choice) return;
  p.choice=choice;
  pushState(room);
  if(allDecided(room)) resolveTick(room);
}

function resolveTick(room){
  if(room.phase!=='round') return;
  clearTimeout(room.tickTimer); room.tickDeadline=null;
  const inPlayers=[...room.players.values()].filter(p=>p.status==='in');
  inPlayers.forEach(p=>{ p.spinCount++; });
  room.tick++;

  const leavers=inPlayers.filter(p=>effectiveChoice(p)==='leave');
  const stayers=inPlayers.filter(p=>effectiveChoice(p)==='stay');

  if(leavers.length){
    const share=G.cashOutShare(room.pot, inPlayers.length);
    leavers.forEach(p=>{
      p.roundGold=share;
      p.sipBalance=Math.floor(share/GOLD_TO_SIP_RATIO);
      p.status='left'; p.choice=null;
      room.roundLog.push({type:'leave', pid:p.pid, name:p.name, gold:share});
    });
    room.pot -= share*leavers.length;
  }

  if(stayers.length===0){ finishRound(room); return; }

  // The wheel is rebuilt per spin from the tick and the pot, so skulls creep
  // in as the round runs long and the pot multipliers sit it out while the pot
  // is empty. room.tick was already incremented above, so this is the wheel the
  // clients have been showing odds for since the last draw landed.
  const tile=G.drawTile(G.buildWheel({tick:room.tick-1, pot:room.pot, settings:room.settings}));
  if(tile.type==='number'){ room.pot+=tile.value; room.roundLog.push({type:'draw',tileType:'number',value:tile.value,tier:tile.tier,potAfter:room.pot}); }
  else if(tile.type==='x2'){ room.pot*=2; room.roundLog.push({type:'draw',tileType:'x2',potAfter:room.pot}); }
  else if(tile.type==='half'){ room.pot=Math.floor(room.pot/2); room.roundLog.push({type:'draw',tileType:'half',potAfter:room.pot}); }
  else if(tile.type==='bust'){
    // Skulls are strikes until the last one. An early skull costs nothing but
    // nerve — the pot rides through it — which is what makes pushing on after
    // one a real decision rather than a formality.
    room.skulls++;
    const fatal = room.skulls>=room.settings.skullsToEnd;
    room.roundLog.push({type:'draw',tileType:'bust',strike:room.skulls,of:room.settings.skullsToEnd,
                        fatal, potAfter: fatal?0:room.pot});
    if(fatal){
      room.pot=0;
      stayers.forEach(p=>{ p.bustPenaltySips=BUST_PENALTY_SIPS; p.status='busted'; p.choice=null; });
    }
  }
  if(!(tile.type==='bust' && room.skulls>=room.settings.skullsToEnd)) stayers.forEach(p=>{ p.choice=null; });

  const stillIn=[...room.players.values()].some(p=>p.status==='in');
  if(stillIn){ pushState(room); startTickTimer(room, REEL_REVEAL_MS); } else finishRound(room);
}

// Checkpoints only go up to the highest spin count anyone actually reached
// this round (checkpoint 15 is meaningless if nobody made it past tick 11) —
// for each threshold below that, anyone whose final spin count fell short
// drinks one sip, stacking per missed threshold.
function finishRound(room){
  const participants=[...room.players.values()].filter(p=>p.status==='left'||p.status==='busted');
  const maxSpin=participants.reduce((m,p)=>Math.max(m,p.spinCount),0);
  const numCheckpoints=Math.floor(maxSpin/CHECKPOINT_INTERVAL);
  for(const p of participants){
    let sips=0;
    for(let i=1;i<=numCheckpoints;i++){ if(p.spinCount<i*CHECKPOINT_INTERVAL) sips++; }
    p.checkpointSips=sips;
  }
  room.phase='results';
  pushState(room);
}

function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    const code=makeCode();
    const hostToken=token();
    const room={ code, hostWs:ws, hostToken, hostConnected:true, players:new Map(),
      phase:"lobby", pot:0, roundLog:[], tick:0, skulls:0, settings:G.defaults(),
      leaderPid:null, tickTimer:null, tickDeadline:null };
    rooms.set(code, room); meta.set(ws,{ roomCode:code, isHost:true });
    send(ws,{type:"hosted",code,token:hostToken}); pushState(room); return;
  }
  if(m.type==="join"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(room.players.size>=MAX_PLAYERS){ send(ws,{type:"error",msg:`Room is full (${MAX_PLAYERS} players max).`}); return; }
    const name=String(m.name||"Player").slice(0,18).trim()||"Player";
    if([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase())){
      send(ws,{type:"error",msg:`"${name}" is already in this room — pick a different name.`}); return;
    }
    const id=pid(), seatToken=token();
    const color=COLORS[room.players.size % COLORS.length];
    room.players.set(id,{ pid:id, resumeToken:seatToken, connected:true, disconnectTimer:null, name, color, ws,
      status: room.phase==="lobby" ? 'in' : 'waiting', choice:null, spinCount:0, roundGold:0,
      sipBalance:0, sipsGiven:0, receivedSips:0, checkpointSips:0, bustPenaltySips:0 });
    meta.set(ws,{ roomCode:code, pid:id });
    reassignLeaderIfNeeded(room);
    send(ws,{type:"joined",pid:id,code,token:seatToken}); pushState(room);
    return;
  }
  if(m.type==="resume"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(!m.pid){
      if(!m.token || m.token!==room.hostToken){ send(ws,{type:"error",msg:"Could not resume as host — start a new game."}); return; }
      room.hostWs=ws; room.hostConnected=true;
      meta.set(ws,{ roomCode:code, isHost:true });
      send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room); return;
    }
    const p=room.players.get(m.pid);
    if(!p || !m.token || m.token!==p.resumeToken){ send(ws,{type:"error",msg:"Could not resume — join as a new player instead."}); return; }
    clearTimeout(p.disconnectTimer); p.disconnectTimer=null;
    p.ws=ws; p.connected=true;
    meta.set(ws,{ roomCode:code, pid:m.pid });
    send(ws,{type:"joined",pid:m.pid,code,token:p.resumeToken}); pushState(room);
    return;
  }
  const room = rooms.get(info.roomCode); if(!room) return;
  if(m.type==="start" && info.pid===room.leaderPid && (room.phase==="lobby"||room.phase==="results")){
    beginRound(room); return;
  }
  // The leader retunes the game at any point, mid-round included. The wheel is
  // rebuilt for every draw, so a change lands on the next spin and never
  // rewrites a draw already resolved — but it does move the odds on a pot
  // people are already in for, which is the leader's call to make.
  if(m.type==="settings" && info.pid===room.leaderPid){
    room.settings=G.clampSettings(m.settings);
    pushState(room); return;
  }
  if(m.type==="choice" && info.pid && room.phase==="round"){
    submitChoice(room, info.pid, m.value); return;
  }
  if(m.type==="giveSip" && info.pid && room.phase==="results"){
    const p=room.players.get(info.pid); if(!p || p.sipBalance<=0) return;
    const target=room.players.get(m.targetPid); if(!target || target.pid===p.pid) return;
    p.sipBalance--; p.sipsGiven++; target.receivedSips++;
    pushState(room); return;
  }
  if(m.type==="endGame" && info.pid===room.leaderPid){
    room.phase="lobby"; room.pot=0; room.roundLog=[]; room.tick=0; room.skulls=0;
    for(const p of room.players.values()){
      p.status='in'; p.choice=null; p.spinCount=0; p.roundGold=0;
      p.sipBalance=0; p.sipsGiven=0; p.receivedSips=0; p.checkpointSips=0; p.bustPenaltySips=0;
    }
    pushState(room); return;
  }
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    if(room.hostWs!==ws) return;
    // The shared/TV screen is a pure spectator now — nothing depends on it,
    // so losing it (laptop closed, wifi drop) must never end the game for
    // the players still playing on their phones. No grace timer, no delete.
    room.hostConnected=false; room.hostWs=null;
    pushState(room);
    return;
  }
  if(info.pid){
    const p=room.players.get(info.pid); if(!p || p.ws!==ws) return;
    p.connected=false; p.ws=null;
    reassignLeaderIfNeeded(room);
    pushState(room);
    if(room.phase==="round" && p.status==="in" && allDecided(room)) resolveTick(room);
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer=setTimeout(()=>{
      if(room.players.get(info.pid)===p && !p.connected){
        room.players.delete(info.pid);
        reassignLeaderIfNeeded(room);
        pushState(room);
      }
    }, RECONNECT_GRACE_MS);
  }
}

export const open    = ws => { meta.set(ws,{}); };
export const message = (ws,msg) => { try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } };
export const close    = ws => { handleClose(ws); };
