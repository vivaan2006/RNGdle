import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { judgeGuess, roundSips, judgeBus, pickRider, pyramidSlots, holdersFor, validateAssignment, newDeck, ROUNDS } from '../irishpoker-server.js';

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

test('irish poker: pyramid shape, holders, hand-outs, bus calls and the rider', () => {
  const slots = pyramidSlots();
  assert.deepEqual(slots.map(s => s.level), [4,4,4,4,3,3,3,2,2,1]);
  assert.deepEqual(slots.map(s => s.finish ? 'F' : s.sips), [1,1,1,1,2,2,2,3,3,'F']);

  const players = [{ pid:'a', cards:[C(7,'h'),C(7,'s'),C(2,'d'),C(9,'c')] }, { pid:'b', cards:[C(3,'h'),C(4,'s'),C(5,'d'),C(6,'c')] }, { pid:'c', cards:[C(7,'d'),C(8,'s'),C(10,'d'),C(11,'c')] }];
  assert.deepEqual(holdersFor(players, 7), [{ pid:'a', count:2 }, { pid:'c', count:1 }]);
  assert.deepEqual(holdersFor(players, 13), []);

  const ids = ['a','b','c'];
  // Level 3 (2 sips) held twice = 4 sips to split, never to yourself.
  assert.deepEqual(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:3, c:1 } }), { sips:{ b:3, c:1 } });
  assert.deepEqual(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:4, c:0 } }), { sips:{ b:4 } });
  assert.equal(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:3 } }), null);
  assert.equal(validateAssignment(slots[4], 2, 'a', ids, { sips:{ a:2, b:2 } }), null);
  assert.equal(validateAssignment(slots[4], 1, 'a', ids, { sips:{ b:1.5, c:0.5 } }), null);
  // The top card: pick someone to finish their drink.
  assert.deepEqual(validateAssignment(slots[9], 1, 'a', ids, { finish:['c'] }), { finish:['c'] });
  assert.equal(validateAssignment(slots[9], 1, 'a', ids, { finish:['a'] }), null);
  assert.equal(validateAssignment(slots[9], 1, 'a', ids, { sips:{ b:1 } }), null);

  assert.equal(judgeBus(C(5,'h'), C(9,'s'), 'higher'), 'right');
  assert.equal(judgeBus(C(5,'h'), C(9,'s'), 'lower'), 'wrong');
  assert.equal(judgeBus(C(5,'h'), C(5,'s'), 'lower'), 'post');
  const deck = newDeck();
  assert.equal(deck.length, 52); assert.equal(new Set(deck.map(c=>c.r+c.s)).size, 52);

  const P = (pid, playedCount, wrong) => ({ pid, wrong, played:[0,1,2,3].map(i => i < playedCount) });
  assert.deepEqual(pickRider([P('a',3,4), P('b',1,0)]), { pid:'b', reason:'cardsLeft', candidates:['b'] });
  assert.deepEqual(pickRider([P('a',1,1), P('b',1,3)]), { pid:'b', reason:'wrong', candidates:['a','b'] });
  const r = pickRider([P('a',0,2), P('b',0,2)]);
  assert(['a','b'].includes(r.pid)); assert.equal(r.reason, 'random'); assert.deepEqual(r.candidates, ['a','b']);
});

test('irish poker: a whole live game over websockets', { timeout: 45000 }, async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, NODE_ENV:'development', FLY_APP_NAME:'', PORT:String(port), IRISHPOKER_FAST:'1' }, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve,reject) => { server.stdout.on('data', d => { if (String(d).includes('server running')) resolve(); }); server.once('error',reject); server.once('exit',code=>reject(new Error(`Server exited ${code}`))); });
  assert.equal((await fetch(`http://127.0.0.1:${port}/irishpoker`)).status, 200);

  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/irishpoker-ws`), queue = [], waiters = [];
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      const i = waiters.findIndex(w => w.predicate(value));
      if (i >= 0) { const [w] = waiters.splice(i,1); clearTimeout(w.timer); w.resolve(value); } else queue.push(value);
    });
    await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true}); ws.addEventListener('error',reject,{once:true}); });
    t.after(() => ws.close());
    return { ws, send: m => ws.send(JSON.stringify(m)), clear: () => { queue.length = 0; }, next(predicate, ms = 5000) {
      const i = queue.findIndex(predicate); if (i >= 0) return Promise.resolve(queue.splice(i,1)[0]);
      return new Promise((resolve,reject) => { waiters.push({ predicate, resolve, timer:setTimeout(()=>reject(new Error('Timed out waiting for room response')),ms) }); });
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
  const [leader] = players;
  const byPid = pid => players.find(p => p.seat.pid===pid);
  const lobby = await tv.next(st(m => m.phase==='lobby' && m.players.length===3));
  assert.equal(lobby.leaderPid, leader.seat.pid);

  players[1].send({ type:'start' });   // only the leader can start
  leader.send({ type:'configure', intensity:'drinking', busLength:4 });
  await tv.next(st(m => m.phase==='lobby' && m.settings.intensity==='drinking' && m.settings.busLength===4));
  leader.send({ type:'start' });
  let s = await tv.next(st(m => m.phase==='guess' && m.round===1));
  assert(s.players.every(p => p.dealt && p.cards.length===4 && p.cards.every(c => c===null)), 'no card is public before its flip');
  assert.equal(typeof s.deadline, 'number'); assert.equal(typeof s.stepAt, 'number');

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
    assert.equal(Object.values(reveal.stepDrinks).reduce((a,b)=>a+b, 0), reveal.roundResults.reduce((a,r)=>a+r.sips, 0), 'every sip lands on exactly one person');
    leader.send({ type:'next' });
  }

  s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.step==='ready'));
  assert(s.players.every(p => p.cards.every(Boolean)), 'hands stay face-up for the pyramid');
  assert.equal(s.pyramid.slots.length, 10); assert(s.pyramid.slots.every(sl => sl.card===null));
  const hands = Object.fromEntries(s.players.map(p => [p.pid, p.cards]));
  let sawBurn = false, sawNope = false;

  for (let idx = 0; idx < 10; idx++) {
    tv.clear();
    leader.send({ type:'flip' });
    s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.idx===idx && m.pyramid.step==='claim'), 8000);
    const slot = s.pyramid.slots[idx];
    if (slot.burns) sawBurn = true;
    assert(slot.card, 'flipped card is public');
    const holders = s.players.filter(p => hands[p.pid].some(c => c.r===slot.card.r));
    assert(holders.length > 0, 'a card nobody holds never stays on the pyramid');
    assert.equal(s.pyramid.remaining, holders.length);

    // A non-holder tapping "I have it" is refused and doesn't move the game.
    const outsider = players.find(p => !holders.some(h => h.pid===p.seat.pid));
    if (outsider && !sawNope) { outsider.send({ type:'have' }); await outsider.next(type('nope')); sawNope = true; }

    // The game waits for every holder.
    for (const [i, h] of holders.entries()) {
      byPid(h.pid).send({ type:'have' });
      if (i < holders.length - 1) await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='claim' && m.pyramid.claimed.includes(h.pid)));
    }
    s = await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='assign'));
    assert.deepEqual(s.pyramid.holders.map(h => h.pid).sort(), holders.map(h => h.pid).sort());

    for (const h of s.pyramid.holders) {
      const others = players.filter(p => p.seat.pid!==h.pid).map(p => p.seat.pid);
      const c = byPid(h.pid);
      if (slot.finish) c.send({ type:'assign', finish: Array(h.count).fill(others[0]) });
      else {
        c.send({ type:'assign', sips:{ [others[0]]: slot.sips*h.count + 1 } });   // wrong total — ignored
        c.send({ type:'assign', sips: slot.sips*h.count > 1 ? { [others[0]]: slot.sips*h.count - 1, [others[1]]: 1 } : { [others[0]]: 1 } });
      }
    }
    s = await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='result'));
    const res = s.pyramid.result;
    if (slot.finish) {
      assert.equal(res.finishes.length, s.pyramid.holders.reduce((a,h)=>a+h.count, 0));
      assert.equal(res.gives.length, 0);
    } else {
      assert.equal(res.gives.reduce((a,g)=>a+g.sips, 0), slot.sips * s.pyramid.holders.reduce((a,h)=>a+h.count, 0));
      assert(res.gives.every(g => g.from!==g.to));
    }
    for (const h of holders) {
      const p = s.players.find(x => x.pid===h.pid);
      hands[h.pid].forEach((c,i) => { if (c.r===slot.card.r) assert(p.played[i], 'matched cards are marked played'); });
    }
  }
  assert(sawNope);
  assert(s.players.some(p => p.finishes > 0), 'the top card makes someone finish their drink');

  leader.send({ type:'toRider' });
  s = await tv.next(st(m => m.phase==='rider'));
  const left = p => 4 - p.played.filter(Boolean).length;
  const most = Math.max(...s.players.map(left));
  assert.equal(left(s.players.find(p => p.pid===s.riderPid)), most, 'the rider has the most cards left');
  assert(s.riderCandidates.includes(s.riderPid));

  const rider = byPid(s.riderPid);
  const spectator = players.find(p => p!==rider);
  spectator.send({ type:'busGuess', value:'higher' });   // not the rider, and not boarded yet
  rider.send({ type:'boardBus' });
  s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===1));
  assert.equal(s.bus.cards.filter(Boolean).length, 1); assert.equal(s.bus.lastEvent, 'deal');

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
      if (s.bus.status==='done') { finished = true; assert.equal(s.bus.lastEvent, 'done'); break; }
      if (s.bus.status==='failed') {
        assert.equal(s.bus.lastEvent, 'miss');
        assert.equal(s.bus.cards.filter(Boolean).length, s.bus.pos+2);
        assert(s.bus.lastGuess.sips > 0);
        tv.clear();
        rider.send({ type:'busAgain' });
        s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===attempt+1));
        assert.equal(s.bus.lastEvent, 'redeal');
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

  leader.send({ type:'start' });
  s = await tv.next(st(m => m.phase==='guess' && m.gameId===2));
  assert(s.players.every(p => p.sipsTaken===0 && p.finishes===0 && p.cards.every(c => c===null) && p.played.every(x => !x)));
  leader.send({ type:'toLobby' });
  await tv.next(st(m => m.phase==='lobby' && m.gameId===2));
  void sawBurn;
});
