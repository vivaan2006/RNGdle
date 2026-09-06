export const ROLES = {
  mafia: { name: 'Instigator', icon: '🥂', team: 'mafia', description: 'Start the trouble. Give night hits to anyone, including yourself or your teammates. Your target allowance scales with the active players and Instigators.' },
  mixologist: { name: 'Mixologist', icon: '🍸', team: 'mafia', description: 'An Instigator ally. Choose anyone, including yourself or a teammate. A matching Instigator pick doubles their night sips, but not their hit count. Your pick alone gives no hits.' },
  detective: { name: 'Vibe Checker', icon: '🔎', team: 'town', description: 'Something is off about that toast. Investigate one other player each night and privately learn their team at dawn.' },
  nurse: { name: 'Designated Driver', icon: '🚕', team: 'town', description: 'Give one player a water break: block all their night sips and hits. By default, anyone protected last night must wait a night before any Driver can protect them again. Choosing a Party Animal gives them a solo win at dawn.' },
  partyAnimal: { name: 'Party Animal', icon: '🪩', team: 'solo', description: 'Your own team, your own terrible plan. Drink voluntarily as often as you like and bluff your way into a water break. You win at dawn if a Designated Driver picks you. Voluntary sips do not count as hits.' },
  town: { name: 'Townsperson', icon: '🏘️', team: 'town', description: 'Watch, bluff, and vote. Receiving sips never takes you out of the game.' }
};
export const ROLE_KEYS = Object.keys(ROLES).filter(role => role !== 'town');
export const TIMER_FIELDS = [
  ['revealSeconds', 'Role reveal', 'Time to check secret roles', 'roleReveal'],
  ['nightSeconds', 'Night moves', 'Time to choose night actions', 'night'],
  ['discussionSeconds', 'Discussion', 'Time to argue your case', 'discussion'],
  ['voteSeconds', 'Voting', 'Time to lock in accusations', 'voting'],
  ['verdictSeconds', 'Verdict', 'Time to read results before the next night', 'roundEnd']
];
export const DIFFICULTIES = { easy: { name: 'Easy', icon: '🌱', sips: 1 }, medium: { name: 'Medium', icon: '🍻', sips: 2 }, hard: { name: 'Hard', icon: '🔥', sips: 3 } };
export const TEAM_NAMES = { mafia: 'Instigator team', town: 'Town team', solo: 'Independent' };
export const HIT_GOAL = 3;
export const DEFAULT_RULES = { mafia: 1, mixologist: 1, detective: 1, nurse: 1, partyAnimal: 0, difficulty: 'medium', caughtShots: 1, losingShots: 1, narration: true, nurseSelf: true, protectionCooldown: true, revealSeconds: 20, nightSeconds: 45, discussionSeconds: 90, voteSeconds: 30, verdictSeconds: 12 };
export const sipsPerAction = rules => DIFFICULTIES[rules.difficulty].sips;
export function nightAllowance(playerCount, instigatorCount) {
  if (instigatorCount < 1 || playerCount < 1) return 0;
  return Math.min(playerCount, Math.max(1, Math.ceil(playerCount / (3 * instigatorCount))));
}
export const hasNightAbility = role => !['town', 'partyAnimal'].includes(role);
export const canTargetSelf = (role, rules) => ROLES[role]?.team === 'mafia' || role === 'nurse' && rules.nurseSelf;
export function normalizeRules(input = {}, base = DEFAULT_RULES) {
  const rules = Object.fromEntries(Object.keys(DEFAULT_RULES).map(key => [key, base[key] ?? DEFAULT_RULES[key]]));
  if (input.difficulty !== undefined) {
    if (typeof input.difficulty !== 'string' || !Object.hasOwn(DIFFICULTIES, input.difficulty)) throw new Error('Choose Easy, Medium, or Hard.');
    rules.difficulty = input.difficulty;
  }
  for (const key of [...ROLE_KEYS, 'caughtShots', 'losingShots', ...TIMER_FIELDS.map(([key]) => key)]) {
    const value = input[key];
    if (value === undefined) continue;
    const max = key.endsWith('Seconds') ? 300 : ROLE_KEYS.includes(key) ? 12 : 10;
    const min = key === 'mafia' ? 1 : 0;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: choose a whole number from ${min} to ${max}.`);
    rules[key] = value;
  }
  for (const key of ['narration', 'nurseSelf', 'protectionCooldown']) if (typeof input[key] === 'boolean') rules[key] = input[key];
  return rules;
}
export function setupError(rules, count) {
  if (count < 4) return 'At least 4 players are needed. The host screen is not a player.';
  if (count > 24) return 'A room supports up to 24 players.';
  const special = ROLE_KEYS.reduce((sum, role) => sum + (rules[role] || 0), 0);
  if (special > count) return `${special} special roles need ${special} players. Add players or reduce optional roles.`;
  if (rules.partyAnimal > 0 && rules.nurse < 1) return 'Party Animals need at least one Designated Driver to have a chance to win.';
  if ((rules.mafia + rules.mixologist) * 2 + rules.partyAnimal >= count) return 'The Instigator team must start smaller than the town. Independent Party Animals are not town players.';
  return '';
}
