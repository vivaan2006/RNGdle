// RNGdle Party — online (Jackbox-style) server.
// Run with:  bun server.js
// Serves the static app and runs realtime rooms. Rolls are generated
// server-side with the SAME extracted engine so every screen stays in sync.

import "./engine.js";                 // sets globalThis.RNGDLE
import { networkInterfaces } from "os";
const R = globalThis.RNGDLE;

const PORT = Number(process.env.PORT || 3000);
const PER_DIGIT = 520, LAST_EXTRA = 360;   // must match index.html
const STATIC = { "/": "index.html", "/index.html": "index.html", "/engine.js": "engine.js" };

const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }
const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];

function makeCode(){ const A="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let c; do{ c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(""); }while(rooms.has(c)); return c; }
function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }
function broadcast(room,o){ const s=JSON.stringify(o); if(room.hostWs){ try{room.hostWs.send(s)}catch(e){} } for(const p of room.players.values()){ if(p.ws){ try{p.ws.send(s)}catch(e){} } } }

function stateMsg(room){
  return { type:"state", phase:room.phase, round:room.round, target:room.target, mode:room.mode,
    players:[...room.players.values()].map(p=>({
      pid:p.pid, name:p.name, color:p.color, score:p.score, rolls:p.rolls, ready:p.ready,
      lastNumber: p.last?p.last.number:null, lastScore:p.last?p.last.score:null,
      lastPct: p.last?p.last.pct:null, lastRarity:p.last?p.last.rarity:null
    })) };
}
function pushState(room){ broadcast(room, stateMsg(room)); }
function genRoll(){ const r=R.roll(); return { number:r.number, score:r.totalScore, pct:r.percentile, rarity:r.cardRarity }; }

function beginReveal(room){
  if(room.phase!=="collecting") return;
  room.phase="revealing";
  let maxLen=1;
  for(const p of room.players.values()){ if(p.pending){ p.last=p.pending; maxLen=Math.max(maxLen,String(p.pending.number).length); } }
  pushState(room);
  clearTimeout(room.revealTimer);
  room.revealTimer=setTimeout(()=>endReveal(room), maxLen*PER_DIGIT + LAST_EXTRA + 700);
}
function endReveal(room){
  for(const p of room.players.values()){ if(p.pending){ p.score+=p.pending.score; p.rolls++; p.pending=null; } p.ready=false; }
  const over = room.mode==="rounds" && room.round>=room.target;
  room.phase = over ? "gameOver" : "roundEnd";
  pushState(room);
}
function maybeAutoReveal(room){
  const ps=[...room.players.values()];
  if(ps.length>0 && ps.every(p=>p.ready)) beginReveal(room);
}

function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    const code=makeCode();
    const room={ code, hostWs:ws, players:new Map(), mode:(m.mode==="endless"?"endless":"rounds"), target:[3,5,10].includes(+m.target)?+m.target:5, round:1, phase:"lobby", revealTimer:null };
    rooms.set(code, room); meta.set(ws,{ roomCode:code, isHost:true });
    send(ws,{type:"hosted",code}); pushState(room); return;
  }
  if(m.type==="join"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    const name=String(m.name||"Player").slice(0,18).trim()||"Player";
    const id=pid();
    const color=COLORS[room.players.size % COLORS.length];
    room.players.set(id,{ pid:id, name, color, score:0, rolls:0, ws, ready:false, pending:null, last:null });
    meta.set(ws,{ roomCode:code, pid:id });
    send(ws,{type:"joined",pid:id,code}); pushState(room); return;
  }
  const room = rooms.get(info.roomCode); if(!room) return;
  if(m.type==="configure" && info.isHost && room.phase==="lobby"){
    if(m.mode) room.mode = m.mode==="endless"?"endless":"rounds";
    if([3,5,10].includes(+m.target)) room.target=+m.target;
    pushState(room); return;
  }
  if(m.type==="start" && info.isHost && room.phase==="lobby"){
    if(room.players.size<1) return;
    for(const p of room.players.values()){ p.score=0; p.rolls=0; p.ready=false; p.pending=null; p.last=null; }
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
  if(m.type==="next" && info.isHost && room.phase==="roundEnd"){
    room.round++; room.phase="collecting";
    for(const p of room.players.values()){ p.ready=false; p.pending=null; p.last=null; }
    pushState(room); return;
  }
  if(m.type==="endGame" && info.isHost){ clearTimeout(room.revealTimer); room.phase="gameOver"; pushState(room); return; }
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){ // host left → tear down room
    clearTimeout(room.revealTimer);
    broadcast(room,{type:"error",msg:"Host ended the party."});
    rooms.delete(room.code); return;
  }
  if(info.pid){
    room.players.delete(info.pid);
    if(room.phase==="collecting") maybeAutoReveal(room);
    pushState(room);
  }
}

const server = Bun.serve({
  port: PORT,
  fetch(req){
    const url=new URL(req.url);
    if(url.pathname==="/ws"){ if(server.upgrade(req)) return; return new Response("upgrade failed",{status:426}); }
    const file = STATIC[url.pathname];
    if(file) return new Response(Bun.file(file));
    return new Response("Not found",{status:404});
  },
  websocket:{
    open(ws){ meta.set(ws,{}); },
    message(ws,msg){ try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } },
    close(ws){ handleClose(ws); }
  }
});

// print addresses
const ips=[];
const nifs=networkInterfaces();
for(const name of Object.keys(nifs)){ for(const ni of nifs[name]||[]){ if(ni.family==="IPv4" && !ni.internal) ips.push(ni.address); } }
console.log("\n🎲  RNGdle Party server running\n");
console.log("   Host screen (this machine):  http://localhost:"+PORT);
for(const ip of ips) console.log("   Friends on same Wi-Fi join:  http://"+ip+":"+PORT);
console.log("\n   Open the host link, click Party → Online → Host. Share the room code.\n");
