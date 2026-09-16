import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { judgeGuess, roundSips, judgeBus, pickRider, pyramidOrder, newDeck, ROUNDS } from '../irishpoker-server.js';

const C = (r, s) => ({ r, s });

test('irish poker: round guesses, the post, and sip values', () => {
  const hand = [C(9,'h'), C(12,'s'), C(10,'d'), C(3,'c')];
  assert.equal(judgeGuess(1, hand, 'red'), 'right');
  assert.equal(judgeGuess(1, hand, 'black'), 'wrong');
  assert.equal(judgeGuess(2, hand, 'higher'), 'right');
  assert.equal(judgeGuess(2, hand, 'lower'), 'wrong');
  assert.equal(judgeGuess(3, hand, 'inside'), 'right');
  assert.equal(judgeGuess(3, hand, 'outside'), 'wrong');
  assert.equal(judgeGuess(4, hand, 'c'), 'right');
  assert.equal(judgeGuess(4, hand, 'h'), 'wrong');
  // Pairs and boundary cards are "the post" regardless of the guess.
  assert.equal(judgeGuess(2, [C(7,'h'), C(7,'s')], 'higher'), 'post');
  assert.equal(judgeGuess(3, [C(4,'h'), C(11,'s'), C(11,'d')], 'outside'), 'post');
  assert.equal(judgeGuess(3, [C(5,'h'), C(5,'s'), C(5,'d')], 'inside'), 'post');
  assert.equal(judgeGuess(3, [C(5,'h'), C(5,'s'), C(9,'d')], 'outside'), 'right');
  assert.equal(judgeGuess(3, [C(2,'h'), C(14,'s'), C(8,'d')], 'inside'), 'right');   // aces high
  assert.equal(roundSips(1, 'right', 1), 1);
  assert.equal(roundSips(4, 'right', 2), 8);
  assert.equal(roundSips(3, 'wrong', 1), 3);
  assert.equal(roundSips(2, 'post', 3), 12);
  assert.equal(ROUNDS.length, 4);
});

test('irish poker: bus calls, pyramid order, and choosing the rider', () => {
  assert.equal(judgeBus(C(5,'h'), C(9,'s'), 'higher'), 'right');
  assert.equal(judgeBus(C(5,'h'), C(9,'s'), 'lower'), 'wrong');
  assert.equal(judgeBus(C(5,'h'), C(5,'s'), 'lower'), 'post');
  const deck = newDeck();
  assert.equal(deck.length, 52); assert.equal(new Set(deck.map(c=>c.r+c.s)).size, 52);
  const order = pyramidOrder(deck.slice(0,8));
  assert.deepEqual(order.map(o=>o.row+o.value), ['take1','give1','take2','give2','take3','give3','take4','give4']);
  assert.deepEqual(pickRider([{pid:'a',matches:1,wrong:4},{pid:'b',matches:3,wrong:0}]), {pid:'b',reason:'matches'});
  assert.deepEqual(pickRider([{pid:'a',matches:2,wrong:1},{pid:'b',matches:2,wrong:3}]), {pid:'b',reason:'wrong'});
  const r = pickRider([{pid:'a',matches:0,wrong:2},{pid:'b',matches:0,wrong:2}]);
  assert(['a','b'].includes(r.pid)); assert.equal(r.reason, 'random');
});

test('irish poker: a whole live game over websockets', { timeout: 30000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, NODE_ENV:'development', FLY_APP_NAME:'', PORT:String(port) }, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve,reject) => { server.stdout.on('data', d => { if (String(d).includes('server running')) resolve(); }); server.once('error',reject); server.once('exit',code=>reject(new Error(`Server exited ${code}`))); });
  assert.equal((await fetch(`http://127.0.0.1:${port}/irishpoker`)).status, 200);

  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/irishpoker-ws`), queue = [], waiters = [], seen = [];
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data); seen.push(value);
      const i = waiters.findIndex(w => w.predicate(value));
      if (i >= 0) { const [w] = waiters.splice(i,1); clearTimeout(w.timer); w.resolve(value); } else queue.push(value);
    });
    await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true}); ws.addEventListener('error',reject,{once:true}); });
    t.after(() => ws.close());
    return { ws, seen, send: m => ws.send(JSON.stringify(m)), clear: () => { queue.length = 0; }, next(predicate) {
      const i = queue.findIndex(predicate); if (i >= 0) return Promise.resolve(queue.splice(i,1)[0]);
      return new Promise((resolve,reject) => { waiters.push({ predicate, resolve, timer:setTimeout(()=>reject(new Error('Timed out waiting for room response')),5000) }); });
    } };
  }
  const type = ty => m => m.type===ty;
  const st = fn => m => m.type==='state' && fn(m);

  const tv = await client(); tv.send({ type:'host' });
  const { code } = await tv.next(type('hosted'));
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/room?code=${code}`)).json()).path, '/irishpoker');

  const players = [];
  for (const name of ['Aoife','Brendan','Ciara']) {
    const c = await client(); c.send({ type:'join', code, name }); c.seat = await c.next(type('joined')); c.name = name; players.push(c);
  }
  const [leader, p2, p3] = players;
  const lobby = await tv.next(st(m => m.phase==='lobby' && m.players.length===3));
  assert.equal(lobby.leaderPid, leader.seat.pid);

  // Only the leader can configure or start.
  p2.send({ type:'start' });
  leader.send({ type:'configure', intensity:'drinking', memory:true, busLength:4 });
  await tv.next(st(m => m.phase==='lobby' && m.settings.intensity==='drinking' && m.settings.busLength===4));
  leader.send({ type:'start' });
  let s = await tv.next(st(m => m.phase==='guess' && m.round===1));
  assert(s.players.every(p => p.dealt && p.cards.length===4 && p.cards.every(c => c===null)), 'no card is public before its flip');
  assert.equal(typeof s.deadline, 'number');

  // Four rounds of guesses; everyone targets the next seat.
  const options = [['red','black'],['higher','lower'],['inside','outside'],['s','h','d','c']];
  for (let round = 1; round <= 4; round++) {
    players.forEach((p,i) => p.send({ type:'guess', value:options[round-1][i % options[round-1].length], target:players[(i+1)%3].seat.pid }));
    const reveal = await tv.next(st(m => m.phase==='reveal' && m.round===round));
    assert.equal(reveal.roundResults.length, 3);
    for (const r of reveal.roundResults) {
      const player = reveal.players.find(p => p.pid===r.pid);
      assert.deepEqual(player.cards[round-1], r.card);
      assert.equal(player.cards.filter(Boolean).length, round);
      assert.equal(r.sips, roundSips(round, r.verdict, 2));
    }
    const drunk = Object.values(reveal.stepDrinks).reduce((a,b)=>a+b, 0);
    assert.equal(drunk, reveal.roundResults.reduce((a,r)=>a+r.sips, 0), 'every sip lands on exactly one person');
    leader.send({ type:'next' });
  }
  s = await tv.next(st(m => m.phase==='memorize'));
  assert(s.players.every(p => p.cards.every(Boolean)));
  leader.send({ type:'force' });
  s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.idx===-1));
  assert(s.players.every(p => p.cards.every(c => c===null)), 'hands are face-down in the pyramid');

  // Peeking costs a sip and only goes to the peeker.
  p3.send({ type:'peek' });
  const hand = await p3.next(type('hand'));
  assert.equal(hand.cards.length, 4);
  assert(!p2.seen.some(m => m.type==='hand'));

  for (let idx = 0; idx < 8; idx++) {
    leader.send({ type:'flip' });
    s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.idx===idx && m.pyramid.step!=='ready'));
    const slot = s.pyramid.slots[idx];
    assert(slot.card, 'flipped card is public'); assert.equal(s.pyramid.slots[idx+1]?.card ?? null, null);
    if (slot.row==='take') { assert.equal(s.pyramid.step, 'result'); continue; }
    assert.equal(s.pyramid.step, 'claims');
    // Leader claims on p2, p3 claims on the leader, p2 passes.
    leader.send({ type:'claim', target:p2.seat.pid });
    p3.send({ type:'claim', target:leader.seat.pid });
    p2.send({ type:'claim', pass:true });
    s = await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='calls'));
    assert.equal(s.pyramid.claims.length, 2);
    assert(s.pyramid.claims.every(c => !('truthful' in c)), 'honesty stays hidden while calls are open');
    const onP2 = s.pyramid.claims.find(c => c.to===p2.seat.pid), onLeader = s.pyramid.claims.find(c => c.to===leader.seat.pid);
    p2.send({ type:'call', claimId:onP2.id, response:'call' });
    leader.send({ type:'call', claimId:onLeader.id, response:'drink' });
    s = await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='result'));
    const called = s.pyramid.result.claims.find(c => c.response==='call');
    const accepted = s.pyramid.result.claims.find(c => c.response==='drink');
    assert.equal(called.sips, slot.value*2*2);
    assert.equal(called.loser, called.truthful ? p2.seat.pid : leader.seat.pid);
    assert.equal(accepted.truthful, null); assert.equal(accepted.loser, leader.seat.pid); assert.equal(accepted.sips, slot.value*2);
  }

  leader.send({ type:'toBus' });
  s = await tv.next(st(m => m.phase==='busIntro'));
  assert(s.riderPid); assert(s.players.every(p => typeof p.matches==='number'));
  const rider = players.find(p => p.seat.pid===s.riderPid);
  const spectator = players.find(p => p!==rider);
  p2.send({ type:'busGuess', value:'higher' });   // nothing happens before boarding
  rider.send({ type:'boardBus' });
  s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===1));
  assert.equal(s.bus.cards.filter(Boolean).length, 1);

  let finished = false;
  for (let tries = 0; tries < 12 && !finished; tries++) {
    for (;;) {
      const cur = s.bus.cards[s.bus.pos], pos = s.bus.pos, attempt = s.bus.attempt;
      spectator.send({ type:'bet', bet:'hit' });
      await tv.next(st(m => m.bus?.betCount===1));
      tv.clear();
      rider.send({ type:'busGuess', value: cur.r < 8 ? 'higher' : 'lower' });
      s = await tv.next(st(m => m.phase!=='bus' || (m.bus.attempt===attempt && (m.bus.pos!==pos || m.bus.status!=='guessing'))));
      assert.equal(s.bus.lastBets.length, 1);
      if (s.bus.status==='done') { finished = true; break; }
      if (s.bus.status==='failed') {
        assert.equal(s.bus.cards.filter(Boolean).length, s.bus.pos+2);
        assert(s.bus.lastGuess.sips > 0);
        tv.clear();
        rider.send({ type:'busAgain' });
        s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===attempt+1));
        break;
      }
    }
  }
  tv.clear();
  if (!finished) {
    rider.send({ type:'skipBus' });
    s = await tv.next(st(m => m.phase==='gameOver'));
    assert.equal(s.busSkipped, true);
  } else {
    s = await tv.next(st(m => m.phase==='gameOver'));
    assert.equal(s.busSkipped, false);
  }
  assert(s.players.every(p => p.cards.every(Boolean)), 'every hand is shown at the end');
  assert(s.players.every(p => typeof p.bluffsGotAway==='number'));

  // Rematch deals a fresh game straight away.
  leader.send({ type:'start' });
  s = await tv.next(st(m => m.phase==='guess' && m.gameId===2));
  assert(s.players.every(p => p.sipsTaken===0 && p.cards.every(c => c===null)));
  leader.send({ type:'toLobby' });
  await tv.next(st(m => m.phase==='lobby' && m.gameId===2));
});
