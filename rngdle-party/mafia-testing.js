// Isolated practice rooms use the real game engine. Only their host can
// inspect or control bot seats; regular rooms never receive these views.
import { randomInt } from 'node:crypto';
import { createMafia, mafiaAction, mafiaState, nightPlan, protectionTargets } from './mafia-engine.js';
import { hasNightAbility, canTargetSelf } from './mafia-rules.js';

const NAMES = ['Alex', 'Blair', 'Casey', 'Drew', 'Ellis', 'Frankie', 'Gray', 'Harper', 'Indigo', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Taylor', 'Uma', 'Val', 'Wren', 'Zion'];
const COLORS = ['#f59e0b', '#22c55e', '#3b82f6', '#ec4899', '#a855f7', '#14b8a6'];

export function setTestPlayers(room, count) {
  if (!room.testMode || room.phase !== 'lobby') throw new Error('Bot counts can only change in a test lobby.');
  if (!Number.isInteger(count) || count < 4 || count > 24) throw new Error('Choose 4–24 test players.');
  room.players.clear();
  for (let i = 0; i < count; i++) {
    const pid = `bot${i + 1}`;
    room.players.set(pid, { pid, name: NAMES[i], color: COLORS[i % COLORS.length], connected: true, ws: null });
  }
}

export function testView(room) {
  return { seats: [...room.players.keys()].map(pid => ({ pid, private: mafiaState(room, pid).private })) };
}

export function testingAction(room, info, message) {
  if (!room.testMode || !info.isHost) throw new Error('Test controls are only available to the host of a test room.');
  if (message.phase !== room.phase || message.round !== room.round) throw new Error('The game has already moved on. Try the current test control.');
  if (message.type === 'mafiaTestPlayers') { setTestPlayers(room, message.count); return; }
  if (message.type === 'mafiaTestReset') {
    clearTimeout(room.mafia.timer);
    room.mafia = { ...createMafia(), rules: room.mafia.rules };
    room.phase = 'lobby'; room.round = 1;
    return;
  }
  if (message.type === 'mafiaTestAction') {
    if (!room.players.has(message.pid) || !['mafiaReady', 'mafiaAct', 'mafiaVote', 'mafiaSip'].includes(message.action?.type)) throw new Error('Choose a bot and a valid player action.');
    mafiaAction(room, { pid: message.pid }, message.action);
    return;
  }
  if (message.type !== 'mafiaTestFill' || !['roleReveal', 'night', 'voting'].includes(room.phase)) throw new Error('There are no bot moves to fill in this phase.');
  const phase = room.phase, g = room.mafia;
  const alive = [...room.players.keys()].filter(pid => g.active[pid]);
  for (const pid of alive) {
    if (room.phase !== phase) break;
    if (phase === 'roleReveal') {
      if (!g.acknowledgements[pid]) mafiaAction(room, { pid }, { type: 'mafiaReady' });
      continue;
    }
    if (phase === 'voting') {
      if (Object.hasOwn(g.votes, pid)) continue;
      // Random guesses, with a chance to abstain. Bots do not use secret roles to vote.
      const options = [null, ...alive.filter(target => target !== pid)];
      mafiaAction(room, { pid }, { type: 'mafiaVote', target: options[randomInt(options.length)] });
      continue;
    }
    if (Object.hasOwn(g.actions, pid)) continue;
    const role = g.roles[pid];
    const options = role === 'nurse' ? protectionTargets(room, pid) : alive.filter(target => target !== pid || canTargetSelf(role, g.rules));
    if (role === 'mafia') {
      const picks = [];
      while (picks.length < nightPlan(room).targetsPerAttacker && options.length) picks.push(options.splice(randomInt(options.length), 1)[0]);
      mafiaAction(room, { pid }, { type: 'mafiaAct', targets: picks });
    } else mafiaAction(room, { pid }, { type: 'mafiaAct', target: !hasNightAbility(role) || !options.length ? null : options[randomInt(options.length)] });
  }
}
