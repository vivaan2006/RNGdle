import test from 'node:test';
import assert from 'node:assert/strict';
import { createMafia, startMafia, mafiaAction, mafiaState, advanceMafia, nightPlan } from '../mafia-engine.js';
import { ROLES, DEFAULT_RULES, ROLE_KEYS, TIMER_FIELDS, normalizeRules, setupError, nightAllowance } from '../mafia-rules.js';

function game(roles = ['mafia','mixologist','detective','nurse','town'], rules = {}) {
  const room = { code:'TEST', players:new Map(roles.map((role,i) => [`p${i}`,{pid:`p${i}`,name:`Player ${i}`,connected:true,color:'#f59e0b'}])), mafia:createMafia(), hostConnected:true, phase:'lobby' };
  room.mafia.rules = { ...DEFAULT_RULES, difficulty:'easy', ...Object.fromEntries(ROLE_KEYS.map(r => [r,roles.filter(x=>x===r).length])), ...rules };
  startMafia(room); roles.forEach((role,i) => room.mafia.roles[`p${i}`]=role); advanceMafia(room); return room;
}
const act = (room,id,target) => mafiaAction(room,{pid:id},{type:'mafiaAct',target});
const multi = (room,id,targets) => mafiaAction(room,{pid:id},{type:'mafiaAct',targets});
const sip = (room,id) => mafiaAction(room,{pid:id},{type:'mafiaSip'});
function votes(room,target=null) {
  if(room.phase==='discussion') advanceMafia(room);
  for(const id of Object.keys(room.mafia.roles).filter(id=>room.mafia.active[id])) mafiaAction(room,{pid:id},{type:'mafiaVote',target:id===target?null:target});
}

test('cast contains renamed roles and no retired roles', () => {
  assert.equal(ROLES.mafia.name,'Instigator');assert.equal(ROLES.detective.name,'Vibe Checker');assert.equal(ROLES.nurse.name,'Designated Driver');
  assert.equal(ROLES.bouncer,undefined);assert.equal(ROLES.gossip,undefined);assert.equal(ROLES.partyAnimal.team,'solo');
  assert.equal(normalizeRules({bouncer:2,gossip:2}).bouncer,undefined);
});
test('presets replace raw sip amounts and reject invalid settings', () => {
  assert.equal(normalizeRules({difficulty:'hard',nightSips:99,wrongVoteSips:99}).difficulty,'hard');
  assert.equal(normalizeRules({nightSips:99}).nightSips,undefined);
  for(const input of [{difficulty:'extreme'},{difficulty:'toString'},{mafia:0},{partyAnimal:13},{nurse:-1},{losingShots:11},{mafia:1.2}])assert.throws(()=>normalizeRules(input));
});
test('Party Animals require a Driver and do not count toward the town majority', () => {
  assert.match(setupError({...DEFAULT_RULES,partyAnimal:1,nurse:0},6),/Designated Driver/);
  assert.match(setupError({...DEFAULT_RULES,mixologist:1,partyAnimal:1},5),/smaller/);
  assert.equal(setupError({...DEFAULT_RULES,mixologist:1,partyAnimal:1},6),'');
  assert.equal(setupError(DEFAULT_RULES,5),'');
});

test('start applies the displayed five-player cast without a separate save', () => {
  const room = {players:new Map(Array.from({length:5},(_,i)=>['p'+i,{connected:true}])), mafia:createMafia(), phase:'lobby'};
  // The previously saved mix would block this party. The current selection must win.
  room.mafia.rules = {...DEFAULT_RULES, mixologist:1, partyAnimal:1};
  assert(setupError(room.mafia.rules,5));
  mafiaAction(room,{isHost:true},{type:'start',rules:{mafia:1,mixologist:0,detective:0,nurse:1,partyAnimal:1,difficulty:'easy'}});
  assert.equal(room.phase,'roleReveal');
  assert.deepEqual(Object.values(room.mafia.roles).sort(),['mafia','nurse','partyAnimal','town','town']);
  assert.equal(room.mafia.rules.difficulty,'easy');
});

test('default cast starts with four players; failed starts do not save invalid changes', () => {
  const room = {players:new Map(Array.from({length:4},(_,i)=>['p'+i,{connected:true}])), mafia:createMafia(), phase:'lobby'};
  const saved = {...room.mafia.rules};
  assert.throws(()=>mafiaAction(room,{isHost:true},{type:'start',rules:{nurse:0,partyAnimal:1}}),/Driver/);
  assert.deepEqual(room.mafia.rules,saved);assert.equal(room.phase,'lobby');
  room.players.get('p0').connected=false;
  assert.throws(()=>mafiaAction(room,{isHost:true},{type:'start',rules:{difficulty:'hard'}}),/disconnected/);
  assert.deepEqual(room.mafia.rules,saved);
  room.players.get('p0').connected=true;
  mafiaAction(room,{isHost:true},{type:'start'});
  assert.equal(room.phase,'roleReveal');
  assert.deepEqual(Object.values(room.mafia.roles).sort(),['detective','mafia','nurse','town']);
});
test('configured roles deal correctly; remainder are town', () => {
  const room=game(['mafia','detective','nurse','partyAnimal','town','town']);room.phase='lobby';startMafia(room);
  assert.deepEqual(Object.values(room.mafia.roles).sort(),['detective','mafia','nurse','partyAnimal','town','town']);
});
test('target allowance scales with living players and active Instigators', () => {
  assert.equal(nightAllowance(5,1),2);assert.equal(nightAllowance(12,2),2);assert.equal(nightAllowance(12,1),4);assert.equal(nightAllowance(24,1),8);assert.equal(nightAllowance(5,0),0);
  const room=game(['mafia','mafia','town','town','town','town','town','town','town','town','town','town']);
  assert.equal(nightPlan(room).targetsPerAttacker,2);room.mafia.active.p0=false;assert.equal(nightPlan(room).targetsPerAttacker,4);
});
test('multi-target actions enforce quota, uniqueness, and valid recipients', () => {
  const room=game();
  for(const targets of [[],['p2','p2'],['p2','p3','p4'],['fake'],['toString'],'p4',[{pid:'p4'}]])assert.throws(()=>multi(room,'p0',targets));
  multi(room,'p0',['p0','p1']);act(room,'p1','p1');advanceMafia(room);
  assert.equal(room.mafia.sips.p0,1);assert.equal(room.mafia.sips.p1,2);assert.equal(room.mafia.hitCounts.p1,1);
});
test('Easy Medium Hard apply 1 2 3 sips while every hit counts once', () => {
  for(const [difficulty,n] of [['easy',1],['medium',2],['hard',3]]) {
    const room=game(undefined,{difficulty});act(room,'p0','p4');act(room,'p1','p4');advanceMafia(room);
    assert.equal(room.mafia.sips.p4,n*2);assert.equal(room.mafia.hitCounts.p4,1);
    votes(room,'p2');assert.equal(room.mafia.sips.p2,n);assert.equal(room.mafia.hitCounts.p2,0);
  }
});
test('overlapping attackers add hits; multiple Mixologists double only once', () => {
  const room=game(['mafia','mafia','mixologist','mixologist','town','town','town','town','town']);
  act(room,'p0','p4');act(room,'p1','p4');act(room,'p2','p4');act(room,'p3','p4');advanceMafia(room);
  assert.equal(room.mafia.hitCounts.p4,2);assert.equal(room.mafia.sips.p4,4);assert.equal(room.mafia.active.p4,true);
});
test('Drivers block all hits and sips, including doubles', () => {
  const room=game();act(room,'p0','p4');act(room,'p1','p4');act(room,'p3','p4');advanceMafia(room);
  assert.equal(room.mafia.hitCounts.p4,0);assert.equal(room.mafia.sips.p4,0);
});
test('Vibe Checker distinguishes independent, town, and Instigator teams privately', () => {
  const room=game(['mafia','mixologist','detective','nurse','partyAnimal','town']);
  act(room,'p2','p4');advanceMafia(room);assert.equal(mafiaState(room,'p2').private.investigations[0].team,'solo');
  assert.deepEqual(mafiaState(room,'p5').private.investigations,[]);assert.equal(mafiaState(room).private,null);assert(mafiaState(room).players.every(p=>p.role===null));
});
test('Party Animal drinks repeatedly without hit progress or public role leakage', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town'],{difficulty:'medium'});
  for(let i=0;i<5;i++)sip(room,'p2');act(room,'p2',null);sip(room,'p2');
  assert.equal(mafiaState(room,'p2').private.voluntarySips,12);assert.equal(room.mafia.hitCounts.p2,0);
  const publicPlayer=mafiaState(room).players.find(p=>p.pid==='p2');assert.equal(publicPlayer.sips,0);assert.equal(publicPlayer.role,null);
  assert.throws(()=>sip(room,'p0'));assert.throws(()=>act(room,'p2','p0'));
  advanceMafia(room);sip(room,'p2');votes(room,'p2');assert.equal(room.mafia.winner,null);assert.equal(room.mafia.active.p2,true);assert.equal(room.mafia.hitCounts.p2,0);
});
test('Driver selecting Animal ends the game at dawn with that Animal as sole winner', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town']);
  act(room,'p0','p2');act(room,'p1','p2');advanceMafia(room);
  assert.equal(room.phase,'gameOver');assert.equal(room.mafia.winner,'solo');assert.deepEqual(room.mafia.winnerIds,['p2']);
  assert.equal(room.mafia.hitCounts.p2,0);assert.equal(room.mafia.shots.p2,0);assert.equal(room.mafia.shots.p1,1);
  assert.throws(()=>sip(room,'p2'));assert(mafiaState(room).players.every(p=>p.role));
});
test('unselected Animals do not share a solo win; multiple selected Animals can win', () => {
  const room=game(['mafia','nurse','partyAnimal','partyAnimal','town','town']);
  act(room,'p1','p2');advanceMafia(room);assert.deepEqual(room.mafia.winnerIds,['p2']);assert.equal(room.mafia.shots.p3,1);
  const two=game(['mafia','nurse','nurse','partyAnimal','partyAnimal','town','town']);
  act(two,'p1','p3');act(two,'p2','p4');advanceMafia(two);assert.deepEqual(two.mafia.winnerIds,['p3','p4']);
});
test('Party Animal has no old damage multiplier and still needs the Driver to win', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town']);act(room,'p0','p2');advanceMafia(room);
  assert.equal(room.mafia.sips.p2,1);assert.equal(room.mafia.hitCounts.p2,1);assert.equal(room.mafia.winner,null);
});
test('three hits on every opposing player, including Animal, are required', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town']);
  for(const id of ['p1','p3','p4'])room.mafia.hitCounts[id]=3;
  room.mafia.hitCounts.p2=2;advanceMafia(room);votes(room);assert.equal(room.mafia.winner,null);
  advanceMafia(room);act(room,'p0','p2');advanceMafia(room);assert.equal(room.phase,'discussion');votes(room);
  assert.equal(room.mafia.winner,'mafia');assert.equal(room.mafia.hitCounts.p0,0);assert.deepEqual(room.mafia.winnerIds,['p0']);
});
test('self-sips, wrong votes, and any sip amount cannot substitute for three hits', () => {
  const room=game();for(const id of ['p2','p3','p4']){room.mafia.sips[id]=100;room.mafia.hitCounts[id]=2;}
  advanceMafia(room);votes(room,'p4');assert.equal(room.mafia.hitCounts.p4,2);assert.equal(room.mafia.winner,null);
});
test('town final catch beats simultaneous Instigator coverage; solos lose with either team', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town']);for(const id of ['p1','p2','p3','p4'])room.mafia.hitCounts[id]=3;
  advanceMafia(room);votes(room,'p0');assert.equal(room.mafia.winner,'town');assert.equal(room.mafia.shots.p0,2);assert.equal(room.mafia.shots.p2,1);assert(!room.mafia.winnerIds.includes('p2'));
});
test('all Instigator allies must be caught, including remaining Mixologists', () => {
  const room=game();advanceMafia(room);votes(room,'p0');assert.equal(room.phase,'roundEnd');assert.equal(nightPlan(room).targetsPerAttacker,0);
  advanceMafia(room);assert.throws(()=>act(room,'p0','p4'));advanceMafia(room);votes(room,'p1');assert.equal(room.mafia.winner,'town');
});
test('ties, abstentions, missing actions and protection settings behave correctly', () => {
  const room=game(undefined,{nurseSelf:false});assert.throws(()=>act(room,'p3','p3'));advanceMafia(room);assert.deepEqual(room.mafia.result.drinks,[]);
  advanceMafia(room);mafiaAction(room,{pid:'p0'},{type:'mafiaVote',target:'p2'});mafiaAction(room,{pid:'p1'},{type:'mafiaVote',target:'p3'});advanceMafia(room);assert.equal(room.mafia.result.tie,true);assert(Object.values(room.mafia.hitCounts).every(n=>n===0));
});
test('server enforces role, phase, duplicate, and host permissions', () => {
  const room=game();assert.throws(()=>act(room,'p2','p2'));assert.throws(()=>act(room,'p4','p0'));assert.throws(()=>mafiaAction(room,{pid:'p4'},{type:'mafiaAdvance'}));
  act(room,'p0','p4');assert.throws(()=>act(room,'p0','p2'));assert.throws(()=>mafiaAction(room,{isHost:true},{type:'mafiaConfigure',rules:{difficulty:'hard'}}));
  assert.throws(()=>mafiaAction(room,{pid:'p4'},{type:'mafiaVote',target:'p0'}));
});
test('timers validate and live timer edits preserve roles and difficulty', () => {
  const room=game();for(const [key] of TIMER_FIELDS){assert(DEFAULT_RULES[key]>0);assert.throws(()=>normalizeRules({[key]:301}));assert.equal(normalizeRules({[key]:0})[key],0);}
  mafiaAction(room,{isHost:true},{type:'mafiaTimers',rules:{discussionSeconds:12,mafia:9,difficulty:'hard'}});
  assert.equal(room.mafia.rules.discussionSeconds,12);assert.equal(room.mafia.rules.mafia,1);assert.equal(room.mafia.rules.difficulty,'easy');
});
test('rematch clears hits, private drinks and winners but preserves settings', () => {
  const room=game(['mafia','nurse','partyAnimal','town','town'],{difficulty:'hard',losingShots:0});sip(room,'p2');act(room,'p1','p2');advanceMafia(room);
  assert.equal(mafiaState(room).players.find(p=>p.pid==='p2').sips,3);
  mafiaAction(room,{isHost:true},{type:'mafiaRematch'});assert.equal(room.phase,'lobby');assert.deepEqual(room.mafia.winnerIds,[]);assert.deepEqual(room.mafia.hitCounts,{});assert.deepEqual(room.mafia.voluntarySips,{});assert.equal(room.mafia.rules.difficulty,'hard');
});

test('protection cooldown prevents all Drivers from repeating last night’s target', () => {
  const room=game(['mafia','nurse','nurse','town','town']);
  act(room,'p0','p4');act(room,'p1','p4');advanceMafia(room);assert.equal(room.mafia.hitCounts.p4,0);
  assert.deepEqual(mafiaState(room,'p2').private.cooldownTargets,['p4']);assert.deepEqual(mafiaState(room,'p0').private.cooldownTargets,[]);
  votes(room);advanceMafia(room);
  assert.throws(()=>act(room,'p1','p4'),/Protected last night/);assert.throws(()=>act(room,'p2','p4'),/Protected last night/);
  act(room,'p0','p4');act(room,'p1','p3');advanceMafia(room);assert.equal(room.mafia.hitCounts.p4,1);
  votes(room);advanceMafia(room);act(room,'p2','p4'); // Available again after a one-night gap.
});
test('protection cooldown can be disabled and empty target lists can safely pass', () => {
  const room=game(undefined,{protectionCooldown:false});act(room,'p3','p4');advanceMafia(room);votes(room);advanceMafia(room);act(room,'p3','p4');
  const empty=game(undefined,{nurseSelf:false});empty.mafia.protectedLastNight=['p0','p1','p2','p4'];act(empty,'p3',null);advanceMafia(empty);assert.deepEqual(empty.mafia.protectedLastNight,[]);
});

test('a complete game naturally reaches three hits per opponent over multiple rounds', () => {
  const room=game(['mafia','nurse','town','town']);
  for(let night=1;night<=5;night++) {
    const targets=['p1','p2','p3'].filter(id=>room.mafia.hitCounts[id]<3).sort((a,b)=>room.mafia.hitCounts[a]-room.mafia.hitCounts[b]).slice(0,2);
    multi(room,'p0',targets);advanceMafia(room);votes(room);
    if(night<5){assert.equal(room.mafia.winner,null);advanceMafia(room);}
  }
  assert.equal(room.mafia.winner,'mafia');assert.equal(room.round,5);
  assert.deepEqual(['p1','p2','p3'].map(id=>room.mafia.hitCounts[id]),[3,3,3]);
});
