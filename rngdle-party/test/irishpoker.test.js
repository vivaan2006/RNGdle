import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import '../irishpoker-rules.js';
import { judgeGuess, roundSips, judgeBus, pickRider, pyramidSlots, holdersFor, validateAssignment, newDeck, ROUNDS, TIMING } from '../irishpoker-server.js';

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
  // Right is safe — sips only land on wrong guesses.
  for (let r = 1; r <= 4; r++) for (const m of [1,2,3]) assert.equal(roundSips(r, 'right', m), 0);
  assert.deepEqual([1,2,3,4].map(r => roundSips(r, 'wrong', 1)), [1,2,3,4]);
  assert.equal(roundSips(3, 'wrong', 2), 6);
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
  assert.deepEqual(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:3, c:1 } }), { sips:{ b:3, c:1 } });
  assert.deepEqual(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:4, c:0 } }), { sips:{ b:4 } });
  assert.equal(validateAssignment(slots[4], 2, 'a', ids, { sips:{ b:3 } }), null);
  assert.equal(validateAssignment(slots[4], 2, 'a', ids, { sips:{ a:2, b:2 } }), null);
  assert.equal(validateAssignment(slots[4], 1, 'a', ids, { sips:{ b:1.5, c:0.5 } }), null);
  assert.equal(validateAssignment(slots[4], 1, 'a', ids, null), null);
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

test('irish poker: the dealer never cuts a reveal short', () => {
  // Every server hold has to outlast the animation every screen is playing.
  assert(TIMING.BURN_AFTER >= 1200, 'the burn animation finishes before the next card');
  assert(TIMING.P_BURN_MSG_AGAIN > TIMING.P_SUS_BURN);
  assert(TIMING.BUS_MISS_BREAK > 0 && TIMING.BUS_DONE_HOLD > 0 && TIMING.DRINK_BREAK > 0);
  assert(TIMING.RIDER_HOLD > 900);
  assert(TIMING.PYR_INTRO > 1000);
  assert(TIMING.BUS_DEAL_UI >= TIMING.BUS_DEAL + 600);
  assert(TIMING.BUS_UI >= TIMING.BUS_VERDICT);
});

async function startServer(t, extraEnv) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, NODE_ENV:'development', FLY_APP_NAME:'', PORT:String(port), IRISHPOKER_FAST:'1', ...extraEnv }, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve,reject) => { server.stdout.on('data', d => { if (String(d).includes('server running')) resolve(); }); server.once('error',reject); server.once('exit',code=>reject(new Error(`Server exited ${code}`))); });

  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/irishpoker-ws`), queue = [], waiters = [];
    const c = { ws, last:null };
    ws.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.type==='state') c.last = value;
      const i = waiters.findIndex(w => w.predicate(value));
      if (i >= 0) { const [w] = waiters.splice(i,1); clearTimeout(w.timer); w.resolve(value); } else queue.push(value);
    });
    await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true}); ws.addEventListener('error',reject,{once:true}); });
    t.after(() => ws.close());
    return Object.assign(c, { send: m => ws.send(JSON.stringify(m)), clear: () => { queue.length = 0; }, next(predicate, ms = 5000) {
      const i = queue.findIndex(predicate); if (i >= 0) return Promise.resolve(queue.splice(i,1)[0]);
      return new Promise((resolve,reject) => { waiters.push({ predicate, resolve, timer:setTimeout(()=>reject(new Error('Timed out waiting for room response: '+(predicate.src||predicate)+' last='+JSON.stringify(c.last&&{phase:c.last.phase,round:c.last.round,paused:c.last.paused,wait:c.last.waitingOn,step:c.last.pyramid&&c.last.pyramid.step}))),ms) }); });
    } });
  }
  return { port, client };
}
const type = ty => m => m.type===ty;
const st = fn => Object.assign(m => m.type==="state" && fn(m), { src:String(fn) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('irish poker: a whole live game, dealt by the computer', { timeout: 45000 }, async t => {
  const { port, client } = await startServer(t);
  assert.equal((await fetch(`http://127.0.0.1:${port}/irishpoker`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/irishpoker-rules.js`)).status, 200);

  const tv = await client(); tv.send({ type:'host' });
  const { code } = await tv.next(type('hosted'));
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/room?code=${code}`)).json()).path, '/irishpoker');

  const players = [];
  for (const name of ['Aoife','Brendan','Ciara']) {
    const c = await client(); c.send({ type:'join', code, name }); c.seat = await c.next(type('joined')); c.name = name; players.push(c);
  }
  const byPid = pid => players.find(p => p.seat.pid===pid);
  await tv.next(st(m => m.phase==='lobby' && m.players.length===3));

  // Phones don't run the room while the TV is connected.
  players[0].send({ type:'start' });
  players[0].send({ type:'configure', intensity:'hammered' });
  tv.send({ type:'configure', intensity:'drinking', busLength:4 });
  let s = await tv.next(st(m => m.phase==='lobby' && m.settings.intensity==='drinking' && m.settings.busLength===4));
  tv.send({ type:'start' });
  s = await tv.next(st(m => m.phase==='guess' && m.round===1));
  assert(s.players.every(p => p.dealt && p.cards.length===4 && p.cards.every(c => c===null)), 'no card is public before its flip');
  assert.equal(s.leaderPid, undefined, 'there is no human dealer');
  assert.deepEqual(s.waitingOn.sort(), players.map(p => p.seat.pid).sort());

  const options = [['red','black'],['higher','lower'],['inside','outside'],['s','h','d','c']];
  for (let round = 1; round <= 4; round++) {
    if (round > 1) await tv.next(st(m => m.phase==='guess' && m.round===round));
    // Two lock in; the game doesn't move without the third — no timer, no random pick.
    players[0].send({ type:'guess', value:options[round-1][1] });
    players[0].send({ type:'guess', value:options[round-1][0] });   // changing your mind is fine
    players[1].send({ type:'guess', value:options[round-1][1] });
    s = await tv.next(st(m => m.phase==='guess' && m.round===round && m.waitingOn.length===1));
    assert.deepEqual(s.waitingOn, [players[2].seat.pid]);
    await sleep(120);
    assert.equal(tv.last.phase, 'guess', 'the dealer waits for everyone');
    players[2].send({ type:'guess', value:options[round-1][0] });
    const reveal = await tv.next(st(m => m.phase==='reveal' && m.round===round));
    assert.equal(reveal.roundResults.length, 3);
    for (const r of reveal.roundResults) {
      const player = reveal.players.find(p => p.pid===r.pid);
      assert.deepEqual(player.cards[round-1], r.card);
      assert.equal(player.cards.filter(Boolean).length, round);
      assert.equal(r.sips, roundSips(round, r.verdict, 2));
      if (r.verdict==='right') assert.equal(reveal.stepDrinks[r.pid]||0, 0, 'right guesses drink nothing');
    }
    assert.equal(r0(reveal.roundResults[0].guess), options[round-1][0]);
    assert.equal(Object.values(reveal.stepDrinks).reduce((a,b)=>a+b, 0), reveal.roundResults.reduce((a,r)=>a+r.sips, 0));
    assert.equal(typeof reveal.autoAt, 'number', 'the dealer moves on by itself');
  }
  function r0(x){ return x; }

  s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.step==='intro'));
  assert(s.players.every(p => p.cards.every(Boolean)), 'hands stay face-up for the pyramid');
  const hands = Object.fromEntries(s.players.map(p => [p.pid, p.cards]));
  let sawNope = false;

  for (let idx = 0; idx < 10; idx++) {
    s = await tv.next(st(m => m.phase==='pyramid' && m.pyramid.idx===idx && m.pyramid.step==='claim'), 8000);
    const slot = s.pyramid.slots[idx];
    const holders = s.players.filter(p => hands[p.pid].some(c => c.r===slot.card.r));
    assert(holders.length > 0, 'a card nobody holds never stays on the pyramid');
    assert.equal(s.pyramid.remaining, holders.length);
    assert.equal(s.autoAt, null, 'claims have no timer');

    const outsider = players.find(p => !holders.some(h => h.pid===p.seat.pid));
    if (outsider && !sawNope) { outsider.send({ type:'have' }); await outsider.next(type('nope')); sawNope = true; }

    for (const [i, h] of holders.entries()) {
      byPid(h.pid).send({ type:'have' });
      if (i < holders.length - 1) await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='claim' && m.pyramid.claimed.includes(h.pid)));
    }
    s = await tv.next(st(m => m.pyramid?.idx===idx && m.pyramid.step==='assign'));
    await sleep(60);
    assert.equal(tv.last.pyramid.step, 'assign', 'nobody hands out drinks for you');

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
    if (slot.finish) assert.equal(res.finishes.length, s.pyramid.holders.reduce((a,h)=>a+h.count, 0));
    else assert.equal(res.gives.reduce((a,g)=>a+g.sips, 0), slot.sips * s.pyramid.holders.reduce((a,h)=>a+h.count, 0));
    assert(s.readyable);
  }
  assert(sawNope);

  s = await tv.next(st(m => m.phase==='rider'));
  const left = p => 4 - p.played.filter(Boolean).length;
  assert.equal(left(s.players.find(p => p.pid===s.riderPid)), Math.max(...s.players.map(left)), 'the rider has the most cards left');
  const rider = byPid(s.riderPid);
  const spectator = players.find(p => p!==rider);
  s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===1));   // boards on its own
  assert.deepEqual(s.waitingOn, [rider.seat.pid]);
  spectator.send({ type:'busGuess', value:'higher' });                // not the rider

  let finished = false;
  for (let tries = 0; tries < 15 && !finished; tries++) {
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
        assert(s.bus.lastGuess.sips > 0);
        s = await tv.next(st(m => m.phase==='bus' && m.bus.attempt===attempt+1));   // re-deals on its own
        assert.equal(s.bus.lastEvent, 'redeal');
        break;
      }
    }
  }
  if (!finished) { rider.send({ type:'skipBus' }); s = await tv.next(st(m => m.phase==='gameOver')); assert.equal(s.busSkipped, true); }
  else { s = await tv.next(st(m => m.phase==='gameOver')); assert.equal(s.busSkipped, false); }

  tv.send({ type:'newGame' });
  s = await tv.next(st(m => m.phase==='guess' && m.gameId===2));
  assert(s.players.every(p => p.sipsTaken===0 && p.finishes===0 && p.cards.every(c => c===null) && p.played.every(x => !x)));
  tv.send({ type:'toLobby' });
  await tv.next(st(m => m.phase==='lobby' && m.gameId===2));
});

test('irish poker: host controls, dropped phones, sit-outs and rejoining', { timeout: 30000 }, async t => {
  const { client } = await startServer(t, { IRISHPOKER_FAST_MS:'500' });
  const tv = await client(); tv.send({ type:'host' });
  const { code } = await tv.next(type('hosted'));
  const join = async name => { const c = await client(); c.send({ type:'join', code, name }); c.seat = await c.next(type('joined')); c.name=name; return c; };
  const [a, b, c] = [await join('Aoife'), await join('Brendan'), await join('Ciara')];

  // Duplicate names are refused while that seat is live.
  const dup = await client(); dup.send({ type:'join', code, name:'aoife' });
  assert.match((await dup.next(type('error'))).msg, /already playing/);
  // The host can remove someone from the lobby.
  const d = await join('Dara');
  tv.send({ type:'kick', pid:d.seat.pid });
  await d.next(type('kicked'));
  await tv.next(st(m => m.phase==='lobby' && m.players.length===3));

  tv.send({ type:'start' });
  let s = await tv.next(st(m => m.phase==='guess'));

  // Pause blocks inputs; resume lets them through.
  tv.clear(); tv.send({ type:'pause' });
  await tv.next(st(m => m.paused));
  a.send({ type:'guess', value:'red' });
  await sleep(80);
  assert.equal(tv.last.players.find(p => p.pid===a.seat.pid).locked, false);
  tv.clear(); tv.send({ type:'unpause' });
  await tv.next(st(m => !m.paused));

  // A phone that drops is never played for: the table waits on it.
  a.send({ type:'guess', value:'red' }); b.send({ type:'guess', value:'black' });
  await tv.next(st(m => m.waitingOn.length===1));
  c.ws.close();
  s = await tv.next(st(m => m.players.find(p => p.pid===c.seat.pid).connected===false));
  await sleep(150);
  assert.equal(tv.last.phase, 'guess');
  assert.deepEqual(tv.last.waitingOn, [c.seat.pid]);

  // Session lost? Joining again with the same name takes the seat back.
  const c2 = await client(); c2.send({ type:'join', code, name:'Ciara' });
  const back = await c2.next(type('joined'));
  c2.seat = back;
  assert.equal(back.pid, c.seat.pid);
  s = await c2.next(st(m => m.phase==='guess'));
  assert(s.players.find(p => p.pid===c.seat.pid).connected);
  c2.send({ type:'guess', value:'red' });
  s = await tv.next(st(m => m.phase==='reveal'));

  // Pausing freezes the dealer's countdown.
  tv.clear(); tv.send({ type:'pause' });
  s = await tv.next(st(m => m.paused));
  assert.equal(s.autoAt, null); assert.equal(typeof s.autoLeft, 'number');
  await sleep(700);
  assert.equal(tv.last.phase, 'reveal', 'paused games stay put');
  tv.clear(); tv.send({ type:'unpause' });
  // Skip the wait instead of sitting through it.
  await tv.next(st(m => !m.paused && m.autoAt));
  tv.send({ type:'skip' });
  s = await tv.next(st(m => m.phase==='guess' && m.round===2));

  // Everyone tapping ready cuts a break short.
  for (const p of [a,b,c2]) p.send({ type:'guess', value:'higher' });
  await tv.next(st(m => m.phase==='reveal' && m.round===2));
  for (const p of [a,b,c2]) p.send({ type:'ready' });
  await tv.next(st(m => m.phase==='guess' && m.round===3), 1500);

  // Sit out a stuck player: the round resolves without them.
  tv.clear(); a.send({ type:'guess', value:'inside' }); b.send({ type:'guess', value:'outside' });
  await tv.next(st(m => m.round===3 && m.waitingOn.length===1));
  b.send({ type:'sitOut', pid:c2.seat.pid });   // players can't
  await sleep(80);
  assert.equal(tv.last.phase, 'guess');
  tv.send({ type:'sitOut', pid:c2.seat.pid });
  s = await tv.next(st(m => m.phase==='reveal' && m.round===3));
  assert.equal(s.roundResults.length, 2);
  assert.equal(s.players.find(p => p.pid===c2.seat.pid).dealt, false);

  // The host can end the game at any point, and deal a fresh one.
  tv.send({ type:'endGame' });
  s = await tv.next(st(m => m.phase==='gameOver'));
  assert.equal(s.endedEarly, true);
  tv.send({ type:'newGame' });
  s = await tv.next(st(m => m.phase==='guess' && m.gameId===2));
  assert.equal(s.players.filter(p => p.dealt).length, 3, 'a sat-out player is back in next game');

  // Sitting out below two players ends the game.
  tv.send({ type:'sitOut', pid:a.seat.pid });
  await tv.next(st(m => m.phase==='guess' && m.players.filter(p=>p.dealt).length===2));
  tv.send({ type:'sitOut', pid:b.seat.pid });
  s = await tv.next(st(m => m.phase==='gameOver'));
  assert.equal(s.endedEarly, true);

  // TV gone: phones can run the room so nobody is stranded.
  tv.ws.close();
  s = await a.next(st(m => m.hostConnected===false));
  a.send({ type:'newGame' });
  s = await a.next(st(m => m.phase==='guess' && m.gameId===3));
  b.send({ type:'endGame' });
  await a.next(st(m => m.phase==='gameOver' && m.gameId===3));

  // Heartbeat: pings are answered.
  a.send({ type:'ping' });
  assert.equal(typeof (await a.next(type('pong'))).serverNow, 'number');
});
