// HorsRNG — online-only horse race party game, server-side room logic.
// Fully independent from RNGdle's rooms: own Maps, own message types, own
// WebSocket path (/horsrng-ws). The only thing shared is the HTTP server
// process itself (see server.js).

const RACE_MS = 60000;                 // ~1 minute race, per spec
const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];

const NAMES = [
  "Seabiscuit's Revenge","Sir Trots-a-Lot","Whinny the Pooh","Notorious H.O.R.S.E.","Hoof Hearted",
  "Buckshot Betty","Neighin' Aggression","Stable Genius","Trojan Stallion","Mane Event",
  "The Boston Stallion","Chestnut Thunder","Foals Gold","Colonel Mustang","Big Girthy",
  "The Untamed Beast","Prancy McPranceface","Lil' Nas Neigh","Sir Squats-a-Lot","Thunder Thighs",
  "Ridin' Dirty","Gallop Gang","Bareback Mountain","Sir Reigns-a-Lot","Filly Cyrus","Clop Culture",
];
const STATS = [
  "Zestiness","Girth","Rizz","Stamina","Chaos Energy","Drip","Confidence (Unearned)","Feral Instinct",
  "Thirst Level","Mane Volume","Cuddle Aggression","Existential Dread","Flirtation Skill",
  "Horse Girl Appeal","Unhinged-ness","Business Savvy","Cursed Energy","Main Character Energy",
  "Sneaky Tactics","Immaculate Vibes",
];
function statLabel(v){ return v>=85?'Legendary':v>=65?'Unreasonable':v>=40?'Respectable':v>=15?'Mild':'Concerning'; }
function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function genHorses(){
  const names=shuffle(NAMES).slice(0,6);
  return names.map((name,i)=>({
    id:'h'+i, name,
    stats: shuffle(STATS).slice(0,4).map(label=>{ const value=1+Math.floor(Math.random()*100); return {label,value,tag:statLabel(value)}; }),
  }));
}

const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }

function makeCode(){ const A="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let c; do{ c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(""); }while(rooms.has(c)); return c; }
function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }
function broadcast(room,o){ const s=JSON.stringify(o); if(room.hostWs){ try{room.hostWs.send(s)}catch(e){} } for(const p of room.players.values()){ if(p.ws){ try{p.ws.send(s)}catch(e){} } } }

function stateMsg(room){
  return { type:"state", phase:room.phase, drinkingMode:room.drinkingMode, horses:room.horses,
    ranking:room.phase==='racing'||room.phase==='results'?room.ranking:null,
    raceStartAt:room.raceStartAt, raceDurationMs:RACE_MS,
    players:[...room.players.values()].map(p=>({ pid:p.pid, name:p.name, color:p.color, horseId:p.horseId, ready:p.ready })) };
}
function pushState(room){ broadcast(room, stateMsg(room)); }

function beginRace(room){
  if(room.phase!=="picking") return;
  room.phase="racing";
  room.ranking=shuffle(room.horses.map(h=>h.id));
  room.raceStartAt=Date.now();
  pushState(room);
  clearTimeout(room.raceTimer);
  room.raceTimer=setTimeout(()=>{ room.phase="results"; pushState(room); }, RACE_MS+400);
}
function maybeAutoRace(room){
  const ps=[...room.players.values()];
  if(ps.length>0 && ps.every(p=>p.ready)) beginRace(room);
}

function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    const code=makeCode();
    const room={ code, hostWs:ws, players:new Map(), phase:"lobby", drinkingMode:!!m.drinkingMode,
      horses:null, ranking:null, raceStartAt:null, raceTimer:null };
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
    room.players.set(id,{ pid:id, name, color, ws, horseId:null, ready:false });
    meta.set(ws,{ roomCode:code, pid:id });
    send(ws,{type:"joined",pid:id,code}); pushState(room); return;
  }
  const room = rooms.get(info.roomCode); if(!room) return;
  if(m.type==="configure" && info.isHost && room.phase==="lobby"){
    if(typeof m.drinkingMode==="boolean") room.drinkingMode=m.drinkingMode;
    pushState(room); return;
  }
  if(m.type==="start" && info.isHost && room.phase==="lobby"){
    if(room.players.size<1) return;
    for(const p of room.players.values()){ p.horseId=null; p.ready=false; }
    room.horses=genHorses(); room.phase="picking"; pushState(room); return;
  }
  if(m.type==="pickHorse" && info.pid && room.phase==="picking"){
    const p=room.players.get(info.pid); if(!p) return;
    if(!room.horses.some(h=>h.id===m.horseId)) return;
    p.horseId=m.horseId; p.ready=true; pushState(room); maybeAutoRace(room); return;
  }
  if(m.type==="forceRace" && info.isHost && room.phase==="picking"){
    for(const p of room.players.values()){ if(!p.ready){ p.horseId=room.horses[Math.floor(Math.random()*room.horses.length)].id; p.ready=true; } }
    beginRace(room); return;
  }
  if(m.type==="rematch" && info.isHost && room.phase==="results"){
    for(const p of room.players.values()){ p.horseId=null; p.ready=false; }
    room.horses=genHorses(); room.ranking=null; room.raceStartAt=null; room.phase="picking"; pushState(room); return;
  }
  if(m.type==="endGame" && info.isHost){
    clearTimeout(room.raceTimer);
    for(const p of room.players.values()){ p.horseId=null; p.ready=false; }
    room.horses=null; room.ranking=null; room.raceStartAt=null; room.phase="lobby"; pushState(room); return;
  }
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    clearTimeout(room.raceTimer);
    broadcast(room,{type:"error",msg:"Host ended the race."});
    rooms.delete(room.code); return;
  }
  if(info.pid){
    room.players.delete(info.pid);
    if(room.phase==="picking") maybeAutoRace(room);
    pushState(room);
  }
}

export const open    = ws => { meta.set(ws,{}); };
export const message = (ws,msg) => { try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } };
export const close   = ws => { handleClose(ws); };
