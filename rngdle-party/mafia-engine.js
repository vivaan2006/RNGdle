import { randomInt } from 'node:crypto';
import { ROLES, ROLE_KEYS, TIMER_FIELDS, DEFAULT_RULES, HIT_GOAL, normalizeRules, setupError, hasNightAbility, canTargetSelf, sipsPerAction, nightAllowance } from './mafia-rules.js';

export function createMafia() {
  return { rules: { ...DEFAULT_RULES }, roles: {}, active: {}, sips: {}, shots: {}, hitCounts: {}, voluntarySips: {}, protectedLastNight: [], investigations: {}, actions: {}, votes: {}, acknowledgements: {}, history: [], result: null, winner: null, winnerIds: [], deadline: null, timer: null };
}
const evil = (g, id) => ROLES[g.roles[id]]?.team === 'mafia';
const living = g => Object.keys(g.roles).filter(id => g.active[id]);
const fail = message => { throw new Error(message); };
export function protectionTargets(room, driverId) {
  const g = room.mafia;
  return living(g).filter(id => (id !== driverId || g.rules.nurseSelf) && (!g.rules.protectionCooldown || !g.protectedLastNight.includes(id)));
}

export function nightPlan(room) {
  const ids = living(room.mafia);
  const players = room.phase === 'lobby' ? room.players.size : ids.length;
  const attackers = room.phase === 'lobby' ? room.mafia.rules.mafia : ids.filter(id => room.mafia.roles[id] === 'mafia').length;
  const targetsPerAttacker = nightAllowance(players, attackers);
  return { players, attackers, targetsPerAttacker, totalPicks: attackers * targetsPerAttacker };
}

export function startMafia(room) {
  const g = room.mafia, ids = [...room.players.keys()];
  const error = setupError(g.rules, ids.length);
  if (error) fail(error);
  if ([...room.players.values()].some(p => !p.connected)) fail('Wait for disconnected players to return or remove them in the lobby.');
  const roles = ROLE_KEYS.flatMap(r => Array(g.rules[r] || 0).fill(r));
  while (roles.length < ids.length) roles.push('town');
  for (let i = roles.length - 1; i > 0; i--) { const j = randomInt(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  room.mafia = { ...createMafia(), rules: g.rules };
  ids.forEach((id, i) => {
    room.mafia.roles[id] = roles[i]; room.mafia.active[id] = true;
    room.mafia.sips[id] = 0; room.mafia.shots[id] = 0; room.mafia.hitCounts[id] = 0;
    room.mafia.voluntarySips[id] = 0; room.mafia.investigations[id] = [];
  });
  room.round = 1; room.phase = 'roleReveal';
}

function endGame(room, winner, winners) {
  const g = room.mafia;
  if (g.winner) return;
  g.winner = winner;
  g.winnerIds = winners || Object.keys(g.roles).filter(id => ROLES[g.roles[id]].team === winner);
  for (const id of Object.keys(g.roles)) if (!g.winnerIds.includes(id)) g.shots[id] += g.rules.losingShots;
  room.phase = 'gameOver';
}
function finishVote(room) {
  const g = room.mafia;
  // Town gets the final accusation before Instigator progress is checked.
  if (!living(g).some(id => evil(g, id))) endGame(room, 'town');
  else if (Object.keys(g.roles).filter(id => !evil(g, id)).every(id => g.hitCounts[id] >= HIT_GOAL)) endGame(room, 'mafia');
}

function resolveNight(room) {
  const g = room.mafia, hits = {}, protectedIds = new Set(), doubled = new Set();
  for (const id of living(g)) {
    const target = g.actions[id]; if (!target) continue;
    if (g.roles[id] === 'mafia') for (const victim of target) hits[victim] = (hits[victim] || 0) + 1;
    if (g.roles[id] === 'mixologist') doubled.add(target);
    if (g.roles[id] === 'nurse') protectedIds.add(target);
    if (g.roles[id] === 'detective') g.investigations[id].push({ round: room.round, pid: target, team: ROLES[g.roles[target]].team });
  }
  const drinks = [];
  for (const [id, count] of Object.entries(hits)) {
    if (protectedIds.has(id)) continue;
    const sips = count * sipsPerAction(g.rules) * (doubled.has(id) ? 2 : 1);
    g.sips[id] += sips; g.hitCounts[id] += count;
    drinks.push({ pid: id, sips, hits: count });
  }
  g.result = { kind: 'night', round: room.round, drinks };
  g.protectedLastNight = [...protectedIds];
  g.history.push(g.result); room.phase = 'discussion';
  const soloWinners = [...protectedIds].filter(id => g.roles[id] === 'partyAnimal');
  // Multiple Drivers may hand different Animals a win together. Unchosen
  // Animals do not share that victory.
  if (soloWinners.length) endGame(room, 'solo', soloWinners);
}

function resolveVote(room) {
  const g = room.mafia, counts = {};
  for (const target of Object.values(g.votes)) if (target && g.active[target]) counts[target] = (counts[target] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter(id => counts[id] === max);
  const target = leaders.length === 1 ? leaders[0] : null;
  const caught = target ? evil(g, target) : false;
  if (target) {
    if (caught) { g.active[target] = false; g.shots[target] += g.rules.caughtShots; }
    else g.sips[target] += sipsPerAction(g.rules);
  }
  g.result = { kind: 'vote', round: room.round, counts, target, caught, tie: leaders.length > 1, drinks: target ? [{ pid: target, sips: caught ? 0 : sipsPerAction(g.rules), shots: caught ? g.rules.caughtShots : 0 }] : [] };
  g.history.push(g.result); room.phase = 'roundEnd'; finishVote(room);
}

export function advanceMafia(room) {
  const g = room.mafia;
  if (room.phase === 'roleReveal' || room.phase === 'roundEnd') {
    if (room.phase === 'roundEnd') room.round++;
    g.actions = {}; g.votes = {}; g.result = null; room.phase = 'night';
  } else if (room.phase === 'night') resolveNight(room);
  else if (room.phase === 'discussion') { g.votes = {}; room.phase = 'voting'; }
  else if (room.phase === 'voting') resolveVote(room);
  else fail('That round cannot advance right now.');
}

export function mafiaAction(room, info, m) {
  const g = room.mafia, id = info.pid;
  if (info.isHost) {
    if (m.type === 'mafiaConfigure' && room.phase === 'lobby') { g.rules = normalizeRules(m.rules, g.rules); return; }
    if (m.type === 'mafiaTimers') {
      const timers = Object.fromEntries(TIMER_FIELDS.filter(([key]) => Object.hasOwn(m.rules || {}, key)).map(([key]) => [key, m.rules[key]]));
      g.rules = normalizeRules(timers, g.rules); return;
    }
    if (m.type === 'start' && room.phase === 'lobby') { startMafia(room); return; }
    if (m.type === 'mafiaAdvance') {
      if (m.phase !== room.phase || m.round !== room.round) fail('The game has already moved on. Use the current host control.');
      advanceMafia(room); return;
    }
    if (m.type === 'mafiaRematch' && room.phase === 'gameOver') { room.mafia = { ...createMafia(), rules: g.rules }; room.phase = 'lobby'; room.round = 1; return; }
    if (m.type === 'mafiaRemove' && room.phase === 'lobby') {
      const p = room.players.get(m.pid);
      if (p) { clearTimeout(p.disconnectTimer); room.players.delete(m.pid); }
      return;
    }
  }
  if (!id || !room.players.has(id) || !g.active[id]) fail('Only active players can do that.');
  if (m.type === 'mafiaSip' && ['roleReveal', 'night', 'discussion', 'voting', 'roundEnd'].includes(room.phase)) {
    if (g.roles[id] !== 'partyAnimal') fail('Only a Party Animal can use this ability.');
    g.voluntarySips[id] += sipsPerAction(g.rules); return;
  }
  if (m.type === 'mafiaReady' && room.phase === 'roleReveal') {
    g.acknowledgements[id] = true;
    if (living(g).every(p => g.acknowledgements[p])) advanceMafia(room);
    return;
  }
  if (m.type === 'mafiaAct' && room.phase === 'night') {
    if (Object.hasOwn(g.actions, id)) fail('Your night action is already locked in.');
    const role = g.roles[id];
    let target = m.target || null;
    if (role === 'mafia') {
      target = m.targets ?? (target ? [target] : []);
      const limit = nightPlan(room).targetsPerAttacker;
      if (!Array.isArray(target) || target.length < 1 || target.length > limit || new Set(target).size !== target.length) fail(`Choose 1–${limit} different players.`);
      if (target.some(pid => typeof pid !== 'string' || !Object.hasOwn(g.roles, pid) || g.active[pid] !== true)) fail('Choose active players.');
    } else {
      if (!hasNightAbility(role) && target) fail('Your role does not choose a night target.');
      if (hasNightAbility(role) && !target && !(role === 'nurse' && protectionTargets(room, id).length === 0)) fail('Choose a player first.');
      if (target && (typeof target !== 'string' || !Object.hasOwn(g.roles, target) || g.active[target] !== true)) fail('Choose an active player.');
      if (target === id && !canTargetSelf(role, g.rules)) fail('You cannot choose yourself.');
      if (role === 'nurse' && target && g.rules.protectionCooldown && g.protectedLastNight.includes(target)) fail('Protected last night. Choose someone else this night.');
    }
    g.actions[id] = target;
    if (living(g).every(p => Object.hasOwn(g.actions, p))) advanceMafia(room);
    return;
  }
  if (m.type === 'mafiaVote' && room.phase === 'voting') {
    if (Object.hasOwn(g.votes, id)) fail('Your vote is already locked in.');
    const target = m.target || null;
    if (target && (typeof target !== 'string' || !Object.hasOwn(g.roles, target) || g.active[target] !== true || target === id)) fail('Vote for another active player or abstain.');
    g.votes[id] = target;
    if (living(g).every(p => Object.hasOwn(g.votes, p))) advanceMafia(room);
    return;
  }
  fail('That action is not available in this phase.');
}

// Explicit per-recipient views keep secrets off the host screen.
export function mafiaState(room, viewerId = null) {
  const g = room.mafia, role = g.roles[viewerId];
  const teamIds = role && evil(g, viewerId) ? Object.keys(g.roles).filter(id => evil(g, id)) : [];
  return { type: 'state', game: 'mafia', code: room.code, phase: room.phase, round: room.round, hostConnected: room.hostConnected,
    rules: g.rules, deadline: g.deadline, serverNow: Date.now(), result: g.result, history: g.history, winner: g.winner, winnerIds: g.winnerIds,
    nightPlan: nightPlan(room), hitGoal: HIT_GOAL,
    setupError: room.phase === 'lobby' ? setupError(g.rules, room.players.size) : '',
    progress: { submitted: Object.keys(room.phase === 'night' ? g.actions : room.phase === 'voting' ? g.votes : g.acknowledgements).length, total: living(g).length },
    players: [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, color: p.color, connected: p.connected,
      active: g.active[p.pid] !== false, sips: (g.sips[p.pid] || 0) + (room.phase === 'gameOver' ? g.voluntarySips[p.pid] || 0 : 0), shots: g.shots[p.pid] || 0, hits: g.hitCounts[p.pid] || 0,
      role: room.phase === 'gameOver' || g.active[p.pid] === false ? g.roles[p.pid] : null })),
    private: role ? { role, teamIds, investigations: g.investigations[viewerId], voluntarySips: g.voluntarySips[viewerId], cooldownTargets: role === 'nurse' && g.rules.protectionCooldown ? g.protectedLastNight : [], ready: !!g.acknowledgements[viewerId],
      acted: Object.hasOwn(g.actions, viewerId), action: g.actions[viewerId] ?? null,
      voted: Object.hasOwn(g.votes, viewerId), vote: g.votes[viewerId] ?? null } : null };
}
