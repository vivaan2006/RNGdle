import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

test('real rooms: private views, reconnects, timed rounds, rematch, and RNGdle regression', { timeout: 20000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve,reject) => { server.stdout.on('data', data => { if (String(data).includes('server running')) resolve(); }); server.once('error',reject); server.once('exit',code=>reject(new Error(`Server exited ${code}`))); });
  for (const path of ['/', '/mafia.html', '/mafia-client.js', '/mafia.css', '/mafia-rules.js']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/mafia-engine.js`)).status,404);
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), queue = [], waiters = [];
    ws.addEventListener('message', event => {
      const value=JSON.parse(event.data), i=waiters.findIndex(w=>w.predicate(value));
      if(i>=0){const [w]=waiters.splice(i,1);clearTimeout(w.timer);w.resolve(value);}else queue.push(value);
    });
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    t.after(()=>ws.close());
    return { ws, send:m=>ws.send(JSON.stringify(m)), next(predicate) {
      const i=queue.findIndex(predicate);if(i>=0)return Promise.resolve(queue.splice(i,1)[0]);
      return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>reject(new Error('Timed out waiting for room response')),5000)};waiters.push(waiter);});
    } };
  }
  const type = type => m=>m.type===type;
  const phase = phase => m=>m.type==='state'&&m.phase===phase;
  const host=await client();host.send({type:'host',game:'mafia'});const hosted=await host.next(type('hosted'));
  host.send({type:'mafiaConfigure',rules:{mafia:1,mixologist:0,detective:1,nurse:1,nightSeconds:1,voteSeconds:1}});
  const players=[];
  for(let i=0;i<4;i++){
    const c=await client();c.send({type:'join',code:hosted.code,name:`Guest ${i}`});c.seat=await c.next(type('joined'));players.push(c);
  }
  host.send({type:'start'});const hostState=await host.next(phase('roleReveal'));
  assert.equal(hostState.private,null);assert(hostState.players.every(p=>p.role===null));assert.equal(hostState.testing,undefined);
  host.send({type:'mafiaTestFill',phase:'roleReveal',round:1});assert.match((await host.next(type('error'))).msg,/test room/);
  const secrets=await Promise.all(players.map(p=>p.next(phase('roleReveal'))));
  assert.deepEqual(secrets.map(s=>s.private.role).sort(),['detective','mafia','nurse','town']);
  players[0].send({type:'mafiaAdvance',phase:'roleReveal',round:1});assert.match((await players[0].next(type('error'))).msg,/not available/);
  const late=await client();late.send({type:'join',code:hosted.code,name:'Late'});assert.match((await late.next(type('error'))).msg,/started/);
  const bad=await client();bad.send({type:'resume',code:hosted.code,pid:players[0].seat.pid,token:'wrong'});assert.match((await bad.next(type('error'))).msg,/resume/);
  const replaced=players[0], replacement=await client();replacement.seat=replaced.seat;
  replacement.send({type:'resume',code:hosted.code,pid:replaced.seat.pid,token:replaced.seat.token});
  await replacement.next(type('joined'));assert.equal((await replacement.next(phase('roleReveal'))).private.role,secrets[0].private.role);players[0]=replacement;
  for(const p of players)p.send({type:'mafiaReady'});
  const night=await host.next(phase('night'));assert.equal(typeof night.deadline,'number');
  // Everyone misses the timer: no accidental targets, and the game still advances.
  const dawn=await host.next(phase('discussion'));assert.deepEqual(dawn.result.drinks,[]);
  host.send({type:'mafiaAdvance',phase:'night',round:1});assert.match((await host.next(type('error'))).msg,/already moved/);
  host.send({type:'mafiaAdvance',phase:'discussion',round:1});await host.next(phase('voting'));
  const verdict=await host.next(phase('roundEnd'));assert.equal(verdict.result.target,null);
  host.send({type:'mafiaAdvance',phase:'roundEnd',round:1});await host.next(m=>m.type==='state'&&m.phase==='night'&&m.round===2);
  host.send({type:'mafiaAdvance',phase:'night',round:2});await host.next(m=>m.type==='state'&&m.phase==='discussion'&&m.round===2);
  host.send({type:'mafiaAdvance',phase:'discussion',round:2});await host.next(m=>m.type==='state'&&m.phase==='voting'&&m.round===2);
  const mafiaId=players[secrets.findIndex(s=>s.private.role==='mafia')].seat.pid;
  for(const p of players)p.send({type:'mafiaVote',target:p.seat.pid===mafiaId?null:mafiaId});
  const end=await host.next(phase('gameOver'));assert.equal(end.winner,'town');assert.equal(end.players.find(p=>p.pid===mafiaId).shots,2);
  host.send({type:'mafiaRematch'});const lobby=await host.next(m=>m.type==='state'&&m.phase==='lobby'&&m.players.length===4&&m.players.every(p=>p.sips===0));assert(lobby.players.every(p=>p.role===null));
  const tester=await client();tester.send({type:'host',game:'mafia',testMode:true});const practice=await tester.next(type('hosted'));
  const testLobby=await tester.next(phase('lobby'));assert.equal(testLobby.players.length,5);assert.equal(testLobby.rules.nightSeconds,45);assert.equal(testLobby.testing.seats.length,5);
  const intruder=await client();intruder.send({type:'join',code:practice.code,name:'Human'});assert.match((await intruder.next(type('error'))).msg,/test room/);
  tester.send({type:'start'});const dealt=await tester.next(phase('roleReveal'));assert(dealt.testing.seats.every(s=>s.private.role));
  tester.send({type:'mafiaTestFill',phase:'roleReveal',round:1});await tester.next(phase('night'));
  tester.send({type:'mafiaTestFill',phase:'night',round:1});await tester.next(phase('discussion'));
  tester.send({type:'mafiaTestReset',phase:'discussion',round:1});const reset=await tester.next(phase('lobby'));assert(reset.testing.seats.every(s=>s.private===null));
  // A whole round now runs without a single host advance command.
  tester.send({type:'mafiaConfigure',rules:{revealSeconds:1,nightSeconds:1,discussionSeconds:1,voteSeconds:1,verdictSeconds:1}});
  tester.send({type:'start'});await tester.next(phase('roleReveal'));
  await tester.next(phase('night'));await tester.next(phase('discussion'));await tester.next(phase('voting'));await tester.next(phase('roundEnd'));
  const nextNight=await tester.next(m=>m.type==='state'&&m.phase==='night'&&m.round===2);assert(nextNight.deadline>nextNight.serverNow);
  // Pause, then resume the current phase through a live duration edit.
  tester.send({type:'mafiaTimers',rules:{nightSeconds:0}});
  const paused=await tester.next(m=>m.type==='state'&&m.round===2&&m.phase==='night'&&m.deadline===null);assert.equal(paused.rules.nightSeconds,0);
  tester.send({type:'mafiaTimers',rules:{nightSeconds:1}});await tester.next(m=>m.type==='state'&&m.phase==='discussion'&&m.round===2);
  // Existing RNGdle traffic still uses its original room state and roll engine.
  const rngHost=await client();rngHost.send({type:'host',revealMode:'manual'});const rng=await rngHost.next(type('hosted'));
  const rngPlayer=await client();rngPlayer.send({type:'join',code:rng.code,name:'Roller'});await rngPlayer.next(type('joined'));
  rngHost.send({type:'start'});await rngPlayer.next(phase('collecting'));rngPlayer.send({type:'rollReady'});
  const roll=await rngHost.next(phase('revealing'));assert.equal(typeof roll.players[0].lastNumber,'number');assert.equal(roll.revealMode,'manual');assert.equal(roll.private,undefined);
});
