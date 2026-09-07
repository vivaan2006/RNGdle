import test from 'node:test';
import assert from 'node:assert/strict';
import { createMafia, mafiaAction, mafiaState, advanceMafia } from '../mafia-engine.js';
import { setTestPlayers, testingAction, testView } from '../mafia-testing.js';

const room = () => {
  const r = { testMode: true, players: new Map(), phase: 'lobby', round: 1, mafia: createMafia() };
  setTestPlayers(r, 5); return r;
};
const command = (r, type, extra = {}) => testingAction(r, { isHost: true }, { type, phase: r.phase, round: r.round, ...extra });

test('test rooms fill 4–24 bots and use the real role deal and player actions', () => {
  const r = room(); assert.equal(r.players.size, 5);
  command(r, 'mafiaTestPlayers', { count: 8 }); assert.equal(r.players.size, 8);
  assert.throws(() => command(r, 'mafiaTestPlayers', { count: 25 }));
  mafiaAction(r, { isHost: true }, { type: 'start' });
  const views = testView(r); assert.equal(views.seats.length, 8);
  assert(views.seats.every(p => p.private.role));
  assert.equal(mafiaState(r).private, null);
  assert(mafiaState(r).players.every(p => !p.role));
  command(r, 'mafiaTestAction', { pid: 'bot1', action: { type: 'mafiaReady' } });
  assert(r.mafia.acknowledgements.bot1);
  command(r, 'mafiaTestFill'); assert.equal(r.phase, 'night');
  assert.throws(() => command(r, 'mafiaTestPlayers', { count: 5 }));
});

test('test controls cannot alter regular rooms or bypass host and player permissions', () => {
  const r = room();
  assert.throws(() => testingAction(r, { pid: 'bot1' }, { type: 'mafiaTestReset', phase: r.phase, round: r.round }));
  r.testMode = false; assert.throws(() => command(r, 'mafiaTestReset')); r.testMode = true;
  mafiaAction(r, { isHost: true }, { type: 'start' });
  assert.throws(() => command(r, 'mafiaTestAction', { pid: 'bot1', action: { type: 'mafiaAdvance' } }));
  assert.throws(() => command(r, 'mafiaTestAction', { pid: 'unknown', action: { type: 'mafiaReady' } }));
  assert.throws(() => testingAction(r, { isHost: true }, { type: 'mafiaTestFill', phase: 'lobby', round: 1 }));
});

test('auto-fill preserves manual moves, uses legal choices, and reset preserves rules', () => {
  const r = room(); mafiaAction(r, { isHost: true }, { type: 'start' }); command(r, 'mafiaTestFill');
  const mafia = Object.keys(r.mafia.roles).find(id => r.mafia.roles[id] === 'mafia');
  const town = Object.keys(r.mafia.roles).find(id => r.mafia.roles[id] === 'town');
  command(r, 'mafiaTestAction', { pid: mafia, action: { type: 'mafiaAct', target: town } });
  command(r, 'mafiaTestFill'); assert.equal(r.phase, 'discussion'); assert.deepEqual(r.mafia.actions[mafia], [town]);
  advanceMafia(r); command(r, 'mafiaTestFill'); assert(['roundEnd','gameOver'].includes(r.phase));
  const rules = { ...r.mafia.rules };
  command(r, 'mafiaTestReset'); assert.equal(r.phase, 'lobby'); assert.equal(r.players.size, 5);
  assert.deepEqual(r.mafia.rules, rules); assert.deepEqual(r.mafia.roles, {}); assert.equal(r.mafia.timer, null);
});
