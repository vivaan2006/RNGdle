// ImpostRNG — online-only social-deduction party game, server-side room logic.
// Fully independent from RNGdle/HorsRNG: own Maps, own message types, own
// WebSocket path (/imposter-ws). The only thing shared is the HTTP server
// process itself (see server.js). Local (single-screen) play is a fully
// separate, client-only code path in imposter.html — it never touches this
// file or a room at all.
//
// Round shape, no app-imposed pacing anywhere (no timers): everyone gets a
// secret (a word, or a number) except one imposter, who gets nothing (or a
// hint, depending on settings). The app announces who goes first and who's
// "director" for the round and then steps back — discussion itself is
// entirely verbal/in-person, paced by the group. When the host is ready,
// they open voting; everyone votes on their phone. If the top-voted player
// IS the imposter, the imposter gets one shot to guess the real secret —
// guessing it right flips the result back in their favor. A tied top vote
// always counts as the imposter getting away with it (the group failed to
// agree, so nobody stands accused). Final result: imposter "escapes" (wasn't
// accused, or was accused but guessed correctly) -> everyone else drinks;
// imposter "loses" (accused correctly and guessed wrong, or never guesses)
// -> imposter drinks.

const COLORS = ['#f59e0b','#22c55e','#3b82f6','#ec4899','#a855f7','#ef4444','#14b8a6','#eab308','#f97316','#8b5cf6','#06b6d4','#d946ef'];
const MIN_PLAYERS = 3;

const WORD_BANK = {
  Animals: ["Elephant","Giraffe","Penguin","Octopus","Kangaroo","Dolphin","Cheetah","Owl","Koala","Flamingo","Hedgehog","Peacock","Otter","Raccoon","Chameleon"],
  "Food & Drink": ["Pizza","Sushi","Tacos","Pancakes","Ramen","Burrito","Croissant","Margarita","Espresso","Popcorn","Nachos","Waffles","Dumplings","Milkshake","BBQ Ribs"],
  "Movies & TV": ["The Office","Star Wars","Titanic","Breaking Bad","Friends","Jurassic Park","The Matrix","Shrek","Stranger Things","Game of Thrones","Toy Story","Avatar","The Godfather","Frozen","Squid Game"],
  Locations: ["Beach","Airport","Casino","Library","Hospital","Prison","Space Station","Cruise Ship","Desert Island","Ski Resort","Amusement Park","Submarine","Nightclub","Farm","Volcano"],
  Objects: ["Umbrella","Chainsaw","Trampoline","Telescope","Skateboard","Vacuum","Fireworks","Kite","Anchor","Parachute","Toaster","Mirror","Compass","Ladder","Piñata"],
  Jobs: ["Firefighter","Surgeon","DJ","Pilot","Detective","Bartender","Lifeguard","Magician","Astronaut","Chef","Referee","Bodyguard","Tattoo Artist","Zookeeper","Wedding Planner"],
  People: ["Albert Einstein","William Shakespeare","Cleopatra","Sherlock Holmes","Batman","Abraham Lincoln","Leonardo da Vinci","Beethoven","Julius Caesar","Wonder Woman","Isaac Newton","Robin Hood","Napoleon","Mozart","Dracula"],
  Games: ["Minecraft","Fortnite","Chess","Among Us","Monopoly","Mario Kart","Roblox","Call of Duty","Uno","Tetris","Pokémon","Candy Crush","Animal Crossing","Grand Theft Auto","Clash Royale"],
  Sports: ["Basketball","Soccer","Tennis","Boxing","Swimming","Golf","Baseball","Hockey","Volleyball","Surfing","Skateboarding","Bowling","Rock Climbing","Wrestling","Table Tennis"],
  Superheroes: ["Spider-Man","Iron Man","Superman","The Flash","Thor","Black Panther","Wolverine","Captain America","Hulk","Aquaman","Green Lantern","Doctor Strange","Deadpool","Black Widow","Captain Marvel"],
  Countries: ["Japan","Brazil","Egypt","Australia","Canada","France","India","Mexico","Italy","Germany","Thailand","Greece","Iceland","Kenya","Argentina"],
  Emotions: ["Happiness","Jealousy","Nostalgia","Anxiety","Excitement","Boredom","Confusion","Pride","Embarrassment","Curiosity","Relief","Awe","Frustration","Contentment","Suspicion"],
  "Clash Royale Cards": ["Knight","Giant","Wizard","Hog Rider","P.E.K.K.A","Balloon","Golem","Mega Knight","Electro Wizard","Musketeer","Goblin Barrel","Prince","Valkyrie","Miner","Sparky"],
  "Anime & Manga": ["Naruto","One Piece","Dragon Ball Z","Attack on Titan","My Hero Academia","Death Note","Demon Slayer","Sailor Moon","Pokémon","Fullmetal Alchemist","Spirited Away","Jujutsu Kaisen","Cowboy Bebop","Bleach","Hunter x Hunter"],
  "Video Game Characters": ["Mario","Link","Master Chief","Kratos","Lara Croft","Sonic the Hedgehog","Pikachu","Cloud Strife","Samus Aran","Geralt of Rivia","Ryu","Steve (Minecraft)","Kirby","Chun-Li","Yoshi"],
};
const WORD_CATEGORIES = Object.keys(WORD_BANK);
// Niche/fandom-specific categories default OFF in a fresh room's settings —
// everything else (broad, works-for-any-group categories) defaults ON.
const NICHE_CATEGORIES = ["Clash Royale Cards","Anime & Manga","Video Game Characters"];
const DEFAULT_CATEGORIES = WORD_CATEGORIES.filter(c=>!NICHE_CATEGORIES.includes(c));

function shuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function defaultSettings(){
  return { mode:'word', difficulty:'medium', showCategory:true, drinkingMode:true, categories:DEFAULT_CATEGORIES.slice(), numberMin:1, numberMax:100 };
}
function sanitizeSettings(room, m){
  const s=room.settings;
  if(m.mode==='word'||m.mode==='number') s.mode=m.mode;
  if(['easy','medium','hard'].includes(m.difficulty)) s.difficulty=m.difficulty;
  if(typeof m.showCategory==='boolean') s.showCategory=m.showCategory;
  if(typeof m.drinkingMode==='boolean') s.drinkingMode=m.drinkingMode;
  if(Array.isArray(m.categories)){ const c=m.categories.filter(x=>WORD_CATEGORIES.includes(x)); if(c.length) s.categories=c; }
  if(Number.isFinite(m.numberMin)) s.numberMin=Math.max(0,Math.min(999998,Math.round(m.numberMin)));
  if(Number.isFinite(m.numberMax)) s.numberMax=Math.max(s.numberMin+1,Math.min(999999,Math.round(m.numberMax)));
}

const rooms = new Map();     // code -> room
const meta  = new Map();     // ws -> { roomCode, pid, isHost }
const RECONNECT_GRACE_MS = 45000;

function makeCode(){ const A="ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let c; do{ c=Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(""); }while(rooms.has(c)); return c; }
function pid(){ return "p"+Math.random().toString(36).slice(2,8); }
function token(){ return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)+Date.now().toString(36); }
function send(ws,o){ try{ ws.send(JSON.stringify(o)); }catch(e){} }
function broadcast(room,o){ const s=JSON.stringify(o); if(room.hostWs){ try{room.hostWs.send(s)}catch(e){} } for(const p of room.players.values()){ if(p.ws){ try{p.ws.send(s)}catch(e){} } } }

// Public state — the shared/host screen. Never carries the secret or who
// the imposter is until phase 'results' (the 'guessing' phase reveals WHO
// the imposter is, since they've already been accused correctly by then,
// but still never reveals the actual word/number — that's the whole point
// of the guess).
function stateMsg(room){
  const base = { type:"state", phase:room.phase, settings:room.settings, hostConnected:room.hostConnected,
    goesFirstPid:room.goesFirstPid, direction:room.direction,
    players:[...room.players.values()].map(p=>({ pid:p.pid, name:p.name, color:p.color, connected:p.connected, voted:room.votes.has(p.pid) })) };
  if(room.phase==="guessing" || room.phase==="results"){
    base.imposterPid=room.imposterPid; base.accusedPid=room.accusedPid; base.imposterCaught=room.imposterCaught;
  }
  if(room.phase==="results"){
    base.secret=room.secret; base.votes=Object.fromEntries(room.votes);
    base.guessCorrect=room.guessCorrect; base.imposterWon=room.imposterWon;
  }
  return base;
}
function pushState(room){ broadcast(room, stateMsg(room)); }
// Private per-player payload — the only place the secret/imposter status
// ever reaches a phone before the round ends.
function secretMsgFor(room, p){
  const s=room.settings, isImposter=p.pid===room.imposterPid;
  const msg={ type:"secret", isImposter };
  if(room.settings.mode==='word'){
    msg.category = (s.showCategory || !isImposter) ? room.secret.category : null;
    msg.word = isImposter ? null : room.secret.word;
  } else {
    msg.range = (s.showCategory || !isImposter) ? [s.numberMin,s.numberMax] : null;
    msg.number = isImposter ? null : room.secret.number;
  }
  return msg;
}
function sendSecrets(room){ for(const p of room.players.values()){ if(p.ws) send(p.ws, secretMsgFor(room,p)); } }
// Sent only to the host once the imposter is caught: the caught imposter
// says their guess out loud (no in-app word list, so it can't be skimmed),
// and the host — who else already knows the secret — taps right or wrong.
// Never broadcast: sending this via stateMsg would hand the answer to the
// imposter's own phone before they've guessed.
function hostSecretMsg(room){ return { type:"hostSecret", secret:room.secret }; }

function genSecret(room){
  const s=room.settings;
  if(s.mode==='word'){
    const category=pick(s.categories.length?s.categories:WORD_CATEGORIES);
    const word=pick(WORD_BANK[category]);
    return { category, word };
  }
  const number = s.numberMin + Math.floor(Math.random()*(s.numberMax-s.numberMin+1));
  return { number };
}

function beginRound(room){
  if(room.phase!=="lobby" && room.phase!=="results") return;
  if(room.players.size<MIN_PLAYERS) return;
  room.phase="discussing";
  room.imposterPid=pick([...room.players.keys()]);
  room.secret=genSecret(room);
  room.votes=new Map();
  room.accusedPid=null; room.imposterCaught=null; room.guessCorrect=null; room.imposterWon=null;
  const order=shuffle([...room.players.keys()]);
  room.goesFirstPid=order[0];
  room.direction = Math.random()<0.5 ? 'cw' : 'ccw';
  sendSecrets(room);
  pushState(room);
}
function beginVoting(room){
  if(room.phase!=="discussing") return;
  room.phase="voting";
  pushState(room);
}
function tallyVotes(room){
  const counts=new Map();
  for(const target of room.votes.values()) counts.set(target,(counts.get(target)||0)+1);
  let top=null, topCount=-1, tied=false;
  for(const [pidVoted,count] of counts){
    if(count>topCount){ top=pidVoted; topCount=count; tied=false; }
    else if(count===topCount){ tied=true; }
  }
  return { accusedPid: tied?null:top };
}
function maybeFinishVoting(room){
  const connectedIds=[...room.players.values()].filter(p=>p.connected).map(p=>p.pid);
  if(connectedIds.length>0 && connectedIds.every(id=>room.votes.has(id))) finishVoting(room);
}
function finishVoting(room){
  if(room.phase!=="voting") return;
  const { accusedPid } = tallyVotes(room);
  room.accusedPid=accusedPid;
  room.imposterCaught = accusedPid!=null && accusedPid===room.imposterPid;
  if(room.imposterCaught){
    room.phase="guessing";
    pushState(room);
    if(room.hostWs) send(room.hostWs, hostSecretMsg(room));
  } else {
    finishResults(room, null);
  }
}
function finishResults(room, guessCorrect){
  room.guessCorrect=guessCorrect;
  room.imposterWon = !room.imposterCaught || guessCorrect===true;
  room.phase="results";
  pushState(room);
}

function handle(ws, m){
  const info = meta.get(ws) || {};
  if(m.type==="host"){
    const code=makeCode();
    const hostToken=token();
    const room={ code, hostWs:ws, hostToken, hostConnected:true, hostGraceTimer:null, players:new Map(), phase:"lobby",
      settings:defaultSettings(), imposterPid:null, secret:null, votes:new Map(), accusedPid:null, imposterCaught:null,
      goesFirstPid:null, direction:null, guessCorrect:null, imposterWon:null };
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
    room.players.set(id,{ pid:id, resumeToken:seatToken, connected:true, disconnectTimer:null, name, color, ws });
    meta.set(ws,{ roomCode:code, pid:id });
    send(ws,{type:"joined",pid:id,code,token:seatToken}); pushState(room);
    if(room.phase!=="lobby") send(ws, secretMsgFor(room, room.players.get(id)));
    return;
  }
  if(m.type==="resume"){
    const code=String(m.code||"").toUpperCase().trim();
    const room=rooms.get(code);
    if(!room){ send(ws,{type:"error",msg:"Room not found — check the code."}); return; }
    if(!m.pid){
      if(!m.token || m.token!==room.hostToken){ send(ws,{type:"error",msg:"Could not resume as host — start a new game."}); return; }
      clearTimeout(room.hostGraceTimer); room.hostGraceTimer=null;
      room.hostWs=ws; room.hostConnected=true;
      meta.set(ws,{ roomCode:code, isHost:true });
      send(ws,{type:"hosted",code,token:room.hostToken}); pushState(room);
      if(room.phase==="guessing") send(ws, hostSecretMsg(room));
      return;
    }
    const p=room.players.get(m.pid);
    if(!p || !m.token || m.token!==p.resumeToken){ send(ws,{type:"error",msg:"Could not resume — join as a new player instead."}); return; }
    clearTimeout(p.disconnectTimer); p.disconnectTimer=null;
    p.ws=ws; p.connected=true;
    meta.set(ws,{ roomCode:code, pid:m.pid });
    send(ws,{type:"joined",pid:m.pid,code,token:p.resumeToken}); pushState(room);
    if(room.phase!=="lobby") send(ws, secretMsgFor(room, p));
    return;
  }
  const room = rooms.get(info.roomCode); if(!room) return;
  if(m.type==="configure" && info.isHost && room.phase==="lobby"){
    sanitizeSettings(room, m); pushState(room); return;
  }
  if(m.type==="start" && info.isHost && (room.phase==="lobby"||room.phase==="results")){
    beginRound(room); return;
  }
  if(m.type==="startVoting" && info.isHost && room.phase==="discussing"){
    beginVoting(room); return;
  }
  if(m.type==="forceResults" && info.isHost && room.phase==="voting"){
    finishVoting(room); return;
  }
  if(m.type==="vote" && info.pid && room.phase==="voting"){
    const p=room.players.get(info.pid); if(!p) return;
    if(!room.players.has(m.targetPid) || m.targetPid===info.pid) return;
    room.votes.set(info.pid, m.targetPid);
    pushState(room); maybeFinishVoting(room); return;
  }
  if(m.type==="guessResult" && info.isHost && room.phase==="guessing"){
    finishResults(room, m.correct===true); return;
  }
  if(m.type==="endGame" && info.isHost){
    room.phase="lobby"; room.imposterPid=null; room.secret=null; room.votes=new Map();
    room.accusedPid=null; room.imposterCaught=null; room.goesFirstPid=null; room.direction=null;
    room.guessCorrect=null; room.imposterWon=null;
    pushState(room); return;
  }
}

function handleClose(ws){
  const info=meta.get(ws); meta.delete(ws); if(!info) return;
  const room=rooms.get(info.roomCode); if(!room) return;
  if(info.isHost){
    if(room.hostWs!==ws) return;
    room.hostConnected=false; room.hostWs=null;
    pushState(room);
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer=setTimeout(()=>{
      broadcast(room,{type:"error",msg:"Host didn't reconnect in time — game ended."});
      rooms.delete(room.code);
    }, RECONNECT_GRACE_MS);
    return;
  }
  if(info.pid){
    const p=room.players.get(info.pid); if(!p || p.ws!==ws) return;
    p.connected=false; p.ws=null;
    pushState(room);
    if(room.phase==="voting") maybeFinishVoting(room);
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer=setTimeout(()=>{
      if(room.players.get(info.pid)===p && !p.connected){
        room.players.delete(info.pid);
        room.votes.delete(info.pid);
        if(room.phase==="voting") maybeFinishVoting(room);
        pushState(room);
      }
    }, RECONNECT_GRACE_MS);
  }
}

export const open    = ws => { meta.set(ws,{}); };
export const message = (ws,msg) => { try{ handle(ws, JSON.parse(msg)); }catch(e){ /* ignore bad frames */ } };
export const close   = ws => { handleClose(ws); };
