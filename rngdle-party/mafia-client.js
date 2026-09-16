import { ROLES, ROLE_KEYS, TIMER_FIELDS, DEFAULT_RULES, DIFFICULTIES, TEAM_NAMES, normalizeRules, setupError, sipsPerAction, hasNightAbility, canTargetSelf } from './mafia-rules.js';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'rngparty_mafia_session';
let socket, session, state, stopped = false, retry = 0, retryTimer, connectTimer, selected = null, revealed = false, speaking = false, lastPhase = '', settingsKey = '';
let testPlayer = null;
let serverOffset = 0;
const viewerId = () => testPlayer || session?.pid;
const isHostView = () => session?.role === 'host' && !testPlayer;
try { session = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch {}
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch {} }
function error(message) { $('#error').textContent = message; $('#error').classList.toggle('hidden', !message); }
function connection(message) { $('#connection').textContent = message; $('#connection').classList.toggle('hidden', !message); }
function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) { error('Reconnecting. Try again when the connection returns.'); return; }
  if (state?.testing && testPlayer && ['mafiaReady', 'mafiaAct', 'mafiaVote', 'mafiaSip'].includes(message.type)) {
    message = { type: 'mafiaTestAction', pid: testPlayer, action: message, phase: state.phase, round: state.round };
  }
  error(''); socket.send(JSON.stringify(message));
}
function connect(message) {
  let authenticated = false;
  clearTimeout(retryTimer); clearTimeout(connectTimer);
  if (location.protocol === 'file:') { error('Mafia needs the game server. Open this game through the running RNGparty server.'); return; }
  connection(session ? 'Reconnecting to your room…' : 'Connecting…');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  const current = socket;
  connectTimer = setTimeout(() => { if (current.readyState === WebSocket.CONNECTING) current.close(); }, 10000);
  socket.onopen = () => { clearTimeout(connectTimer); send(message); };
  socket.onerror = () => {};
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.type === 'hosted' || m.type === 'joined') {
      authenticated = true;
      session = { code: m.code, pid: m.pid || null, token: m.token, role: m.type === 'hosted' ? 'host' : 'player' };
      retry = 0; save(); connection(''); $('#entry').classList.add('hidden'); $('#room').classList.remove('hidden');
      $('#copy').textContent = session.code;
      $('#headerCode').textContent = session.code; $('#headerCode').classList.remove('hidden');
    } else if (m.type === 'state' && m.game === 'mafia') {
      state = m; serverOffset = (m.serverNow || Date.now()) - Date.now(); connection(m.hostConnected ? '' : 'The host disconnected. Waiting for them to return…'); render();
    } else if (m.type === 'error') {
      connection(''); error(m.msg);
      if (m.fatal || message.type === 'resume' && !authenticated) {
        stopped = true; session = null; sessionStorage.removeItem(KEY); socket.close();
        $('#entry').classList.remove('hidden'); $('#room').classList.add('hidden');
        $('#headerCode').classList.add('hidden'); document.body.classList.remove('in-room');
      }
      $('#host').disabled = false; $('#join button').disabled = false; $('#testHost').disabled = false;
    }
  };
  socket.onclose = () => {
    clearTimeout(connectTimer);
    if (stopped) return;
    if (!session) { connection(''); error('Could not connect. Check that the game server is running, then try again.'); $('#host').disabled = false; $('#join button').disabled = false; $('#testHost').disabled = false; return; }
    connection('Connection lost. Rejoining your seat…');
    retryTimer = setTimeout(() => connect({ type: 'resume', ...session }), Math.min(1000 * 1.5 ** retry++, 5000));
  };
}
function open(message) {
  if (socket && socket.readyState <= WebSocket.OPEN) { if (socket.readyState === WebSocket.OPEN) send(message); return; }
  stopped = false; connect(message);
}
$('#host').onclick = () => { $('#host').disabled = true; open({ type: 'host', game: 'mafia' }); };
$('#testHost').onclick = () => { $('#testHost').disabled = true; open({ type: 'host', game: 'mafia', testMode: true }); };
$('#join').onsubmit = event => {
  event.preventDefault();
  const code = $('#code').value.trim().toUpperCase(), name = $('#name').value.trim();
  if (!code || !name) { error('Enter a room code and your name.'); return; }
  $('#join button').disabled = true; open({ type: 'join', game: 'mafia', code, name });
};
$('#theme').onclick = () => { const dark = document.documentElement.classList.toggle('dark'); $('#theme').textContent = dark ? '🌙' : '☀️'; };
$('#speech').onclick = () => {
  if (!('speechSynthesis' in window)) { error('Spoken narration is unavailable in this browser. On-screen narration is still available.'); return; }
  speaking = !speaking; $('#speech').textContent = speaking ? '🔊' : '🔇';
  $('#speech').setAttribute('aria-label', speaking ? 'Mute spoken narration' : 'Enable spoken narration');
  window.speechSynthesis.cancel(); if (speaking) narrate();
};
function narrate() {
  if (!speaking || session?.role !== 'host' || !state?.rules.narration || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(phaseCopy()[1]));
}
$('#leave').onclick = () => {
  if (state?.phase !== 'lobby' && state?.phase !== 'gameOver' && !confirm('Leave this game? Your seat will be kept, but leaving clears this device’s rejoin key.')) return;
  stopped = true; clearTimeout(retryTimer); sessionStorage.removeItem(KEY); window.speechSynthesis?.cancel(); socket?.close(); location.href = '/mafia.html';
};
async function copyLink() {
  const link = `${location.origin}/mafia.html?room=${session.code}`;
  try { await navigator.clipboard.writeText(link); $('#copyLink').textContent = 'Copied ✓'; setTimeout(() => $('#copyLink').textContent = 'Copy join link', 1800); }
  catch { prompt('Share this join link:', link); }
}
$('#copy').onclick = $('#copyLink').onclick = $('#headerCode').onclick = copyLink;
const nameOf = id => escape(state.players.find(p => p.pid === id)?.name || 'Player');
const amount = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const me = () => state.players.find(p => p.pid === viewerId());
function phaseCopy() {
  return {
    lobby: ['The table is open', 'Gather your suspects. Everyone joins on their own device, then the host deals the roles.'],
    roleReveal: ['Keep your role close', 'Check your secret role on your own screen. Tap ready when you know which side you are on.'],
    night: ['The town goes quiet', 'Make your secret move on your phone. Everyone locks in, then the town wakes up.'],
    discussion: ['Somebody knows something', `Share your suspicions, defend your alibi, and hear everyone out. ${state.deadline ? 'Voting opens automatically when the countdown ends.' : 'The host opens voting when the table is ready.'}`],
    voting: ['Who is starting the trouble?', 'Choose who you suspect. Votes stay secret until everyone locks in or the timer ends.'],
    roundEnd: ['The verdict is in', `Take a look at the vote. Anyone who received sips stays in the game. ${state.deadline ? 'The next night starts automatically when the countdown ends.' : 'The host starts the next night.'}`],
    gameOver: state.winner === 'solo' ? ['The Party Animal fooled the Driver', 'A Designated Driver chose a Party Animal. The chosen Party Animal wins independently.'] : state.winner === 'town' ? ['The town cracked the case', 'Every Instigator-team member has been caught. The town wins.'] : ['The Instigators own the night', 'Every opposing player has taken at least three successful night hits. The Instigator team wins.']
  }[state.phase];
}
function render() {
  $('#joinedCount').textContent = `${state.players.filter(p => p.connected).length} players joined${session?.role === 'host' && !state.testing ? ' · host display is not a player' : ''}`;
  $('#joinHint').textContent = state.testing ? 'Local test room · bots only' : ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? 'Open the server’s Wi-Fi address on your phone, then enter this code.' : `Open ${location.host} on your phone and enter this code.`;
  document.body.classList.toggle('in-room', !!session);
  if (state.phase === 'lobby') $('#phase').after($('#action')); else $('#result').after($('#action'));
  if (!state.testing || !state.players.some(p => p.pid === testPlayer)) testPlayer = null;
  if (state.testing) state.private = state.testing.seats.find(p => p.pid === testPlayer)?.private || null;
  const phaseKey = `${state.phase}:${state.round}`;
  if (lastPhase !== phaseKey) { selected = null; revealed = false; lastPhase = phaseKey; narrate(); }
  const [title, copy] = phaseCopy(), host = isHostView();
  $('#phase').innerHTML = `<section class="panel phase-panel"><div class="phase-head"><span class="eyebrow">${state.phase === 'lobby' ? 'MAKE IT YOUR PARTY' : `ROUND ${state.round}`}</span><span class="clock mono" id="clock"></span></div><h1>${title}</h1>${state.phase !== 'lobby' && state.phase !== 'gameOver' ? `<div class="phase-steps">${[['roleReveal','Roles'],['night','Night'],['discussion','Discuss'],['voting','Vote'],['roundEnd','Verdict']].map(([key, label]) => `<span class="phase-step ${state.phase === key ? 'current' : ''}">${label}</span>`).join('')}</div>` : ''}<p>${copy}</p>${['roleReveal','night','voting'].includes(state.phase) ? `<span class="pill">${state.progress.submitted} / ${state.progress.total} locked in</span>` : ''}${host && state.phase === 'lobby' ? '<p class="small">This is the shared host screen. To play too, open the join link on your phone or in another tab.</p>' : ''}</section>`;
  if (!['lobby', 'gameOver'].includes(state.phase)) $('#phase').insertAdjacentHTML('beforeend', `<p class="notice">${state.nightPlan.attackers ? `Each Instigator can choose up to <b>${state.nightPlan.targetsPerAttacker} different players</b> tonight (${state.nightPlan.players} players, ${state.nightPlan.attackers} active Instigator${state.nightPlan.attackers === 1 ? '' : 's'}).` : 'No active Instigators remain. The town still needs to catch the remaining Mixologists.'} The Instigator team needs <b>3 night hits on every opposing player</b>. Sips and hits are tracked separately.</p>`);
  renderTesting(); renderSettings(); renderPrivate(); renderResult(); renderAction(); renderRoster(); renderHistory(); updateClock();
}
function testCommand(type, extra = {}) { send({ type, phase: state.phase, round: state.round, ...extra }); }
function renderTesting() {
  if (!state.testing) { $('#testing').innerHTML = ''; return; }
  const lobby = state.phase === 'lobby';
  $('#testing').innerHTML = `<section class="panel test-panel"><div class="section-head"><h2>🧪 Local test</h2><span class="pill">BOTS ONLY</span></div><p class="small">You control every seat. Use the player screens for exact moves, or auto-fill the remaining responses with random legal choices. Timers run automatically; pause them to inspect exact moves.</p><label for="testView">Screen to control</label><select class="inp" id="testView"><option value="">Shared host screen</option>${state.testing.seats.map(seat => `<option value="${seat.pid}" ${testPlayer === seat.pid ? 'selected' : ''}>${nameOf(seat.pid)}${seat.private ? ` · ${ROLES[seat.private.role].name}` : ''}${state.players.find(p => p.pid === seat.pid)?.active === false ? ' · caught' : ''}</option>`).join('')}</select><div class="test-buttons">${['roleReveal','night','voting'].includes(state.phase) ? `<button class="secbtn" id="testFill">${state.phase === 'roleReveal' ? 'Ready all bots' : state.phase === 'night' ? 'Auto-fill night moves' : 'Auto-fill votes'}</button>` : ''}${testPlayer ? '<button class="secbtn" id="testBack">Back to host controls</button>' : ''}${!lobby ? '<button class="secbtn" id="testReset">Reset to lobby</button>' : ''}</div>${lobby ? `<form id="testCountForm" class="test-count"><label for="testCount">Bot players</label><input class="inp" id="testCount" type="number" min="4" max="24" step="1" value="${state.players.length}" required><button class="secbtn">Set player count</button></form>` : ''}<p class="small">Test rooms expose bot roles here and cannot accept real players. Normal rooms keep roles private.</p></section>`;
  $('#testView').onchange = event => { testPlayer = event.target.value || null; selected = null; revealed = false; settingsKey = ''; render(); };
  const timed = TIMER_FIELDS.some(([key]) => state.rules[key] > 0);
  const timerToggle = document.createElement('button');
  timerToggle.className = 'secbtn'; timerToggle.id = 'testTimers';
  timerToggle.textContent = timed ? 'Pause timers for testing' : 'Use automatic timers';
  timerToggle.onclick = () => testCommand('mafiaTimers', { rules: Object.fromEntries(TIMER_FIELDS.map(([key]) => [key, timed ? 0 : DEFAULT_RULES[key]])) });
  $('#testing .test-buttons').prepend(timerToggle);
  if ($('#testFill')) $('#testFill').onclick = () => testCommand('mafiaTestFill');
  if ($('#testBack')) $('#testBack').onclick = () => { testPlayer = null; selected = null; revealed = false; settingsKey = ''; render(); };
  if ($('#testReset')) $('#testReset').onclick = () => { testPlayer = null; selected = null; revealed = false; settingsKey = ''; testCommand('mafiaTestReset'); };
  if ($('#testCountForm')) $('#testCountForm').onsubmit = event => { event.preventDefault(); testCommand('mafiaTestPlayers', { count: Number($('#testCount').value) }); };
}
const EDITABLE_TIMERS = TIMER_FIELDS.filter(([key]) => ['nightSeconds', 'discussionSeconds', 'voteSeconds'].includes(key));
function lobbyRules() {
  const form = $('#config');
  if (!form) return state.rules;
  const data = new FormData(form), rules = {};
  [...ROLE_KEYS, ...EDITABLE_TIMERS.map(([key]) => key)].forEach(key => rules[key] = data.get(key) === '' ? NaN : Number(data.get(key)));
  rules.difficulty = data.get('difficulty');
  return normalizeRules(rules, state.rules);
}
function lobbyError() {
  try {
    const problem = setupError(lobbyRules(), state.players.length);
    if (problem) return problem;
    const offline = state.players.filter(p => !p.connected);
    return offline.length ? `Waiting for ${offline.map(p => p.name).join(', ')} to reconnect. They can rejoin, or you can remove their seat below.` : '';
  } catch (e) { return e.message; }
}
function difficultyInputs(r) {
  return `<fieldset class="difficulty-picker"><legend>Sips per action</legend><p class="small">Applies to night hits, wrong accusations, and voluntary Party Animal drinks. Mixologist matches double the sips, not the hit count.</p><div class="difficulty-grid">${Object.entries(DIFFICULTIES).map(([key,d]) => `<label class="difficulty-option"><input type="radio" name="difficulty" value="${key}" ${r.difficulty === key ? 'checked' : ''}><span class="difficulty-body"><span class="role-icon">${d.icon}</span><strong>${d.name}</strong><span>${amount(d.sips,'sip')} per action</span></span></label>`).join('')}</div></fieldset>`;
}
function timerInputs(r) {
  return `<div class="timer-grid">${EDITABLE_TIMERS.map(([key,label,hint]) => `<label class="timer-card" for="cfg-${key}"><span>${label}</span><span class="timer-value"><input class="inp mono" id="cfg-${key}" type="number" name="${key}" min="0" max="300" step="1" value="${r[key]}" required><span>sec</span></span><span class="small">${hint}</span></label>`).join('')}</div>`;
}
function roleCards(r, editable) {
  return `<div class="role-grid">${ROLE_KEYS.map(key => {
    const role = ROLES[key];
    return `<div class="role-choice ${r[key] ? 'included' : ''}" data-role-card="${key}"><label for="role-${key}"><span class="role-icon">${role.icon}</span><span class="role-name">${role.name}</span><span class="role-team">${TEAM_NAMES[role.team]}</span></label>${editable ? `<div class="role-counter"><button type="button" data-role-step="${key}" data-step="-1" aria-label="Remove one ${role.name}">−</button><input class="mono" id="role-${key}" name="${key}" type="number" min="${key === 'mafia' ? 1 : 0}" max="12" step="1" value="${r[key]}" aria-label="${role.name} count" required><button type="button" data-role-step="${key}" data-step="1" aria-label="Add one ${role.name}">+</button></div>` : `<div class="role-number mono">${r[key]}</div>`}<details class="role-help"><summary>What they do</summary><p class="small">${role.description}</p></details></div>`;
  }).join('')}<div class="role-choice town-fill"><span class="role-icon">🏘️</span><span class="role-name">Townspeople</span><span class="role-team">TOWN</span><output id="townCount" class="role-number mono">0</output><p class="small">Automatically fills the remaining seats.</p></div></div><p class="small" id="roleBudget" aria-live="polite"></p>`;
}
function updateRoleBudget() {
  let assigned = 0;
  for (const role of ROLE_KEYS) {
    const input = $(`#role-${role}`), count = input ? Number(input.value) || 0 : state.rules[role];
    assigned += count; $(`[data-role-card="${role}"]`)?.classList.toggle('included', count > 0);
  }
  if ($('#townCount')) $('#townCount').textContent = Math.max(0, state.players.length - assigned);
  if ($('#roleBudget')) $('#roleBudget').textContent = assigned > state.players.length ? `${assigned} special roles selected for ${state.players.length} players. Add players or reduce role counts.` : `${assigned} special roles + ${state.players.length - assigned} Townspeople = ${state.players.length} players. Set an optional role to 0 to leave it out.`;
  if ($('#config') && $('#roleBudget')) {
    const problem = lobbyError();
    $('#roleBudget').classList.toggle('notice', !!problem);
    if (problem) $('#roleBudget').textContent = problem;
  }
}
function renderSettings() {
  const host = isHostView(), r = state.rules, key = JSON.stringify([host, state.phase === 'lobby', r]);
  if (settingsKey === key) { updateRoleBudget(); return; } settingsKey = key;
  if (host && state.phase === 'lobby') {
    $('#settings').innerHTML = `<section class="panel"><h2>Choose your cast</h2><p class="small">Start with Classic, or add a Party Animal. Extra seats become Townspeople.</p><div class="presets"><button class="secbtn" data-preset="classic">Classic</button><button class="secbtn" data-preset="animal">Party Animal</button></div><form id="config">${roleCards(r, true)}${difficultyInputs(r)}<details class="extra-settings"><summary>Round timers</summary><p class="small">The game runs automatically. Adjust night, discussion, and voting here. Role reveal and verdict use automatic defaults.</p>${timerInputs(r)}</details><p class="small">Your selections apply when you press Start game. Narration can be toggled with the sound button.</p></form></section>`;
    $('#config').oninput = () => { updateRoleBudget(); renderAction(); };
    $('#config').onsubmit = event => { event.preventDefault(); $('#start')?.click(); };
    $('#settings').querySelectorAll('[data-role-step]').forEach(button => button.onclick = () => {
      const input = $('#role-' + button.dataset.roleStep);
      if (button.dataset.step === '1') input.stepUp(); else input.stepDown();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    $('#settings').querySelectorAll('[data-preset]').forEach(button => button.onclick = () => {
      const animal = button.dataset.preset === 'animal';
      const roles = { mafia: 1, mixologist: 0, detective: animal ? 0 : 1, nurse: 1, partyAnimal: animal ? 1 : 0 };
      for (const role of ROLE_KEYS) $('#role-' + role).value = roles[role];
      $('#config').dispatchEvent(new Event('input'));
    });
  } else {
    $('#settings').innerHTML = `<details class="panel"><summary>This room’s roles & rules</summary>${roleCards(r, false)}<p class="small">${DIFFICULTIES[r.difficulty].name}: ${amount(sipsPerAction(r),'sip')} per action · Caught: ${amount(r.caughtShots,'shot')} · Losing players: ${amount(r.losingShots,'shot')}</p><p class="small">${TIMER_FIELDS.map(([key,label]) => label + ': ' + (r[key] ? r[key] + 's' : 'manual')).join(' · ')}</p></details>${host ? `<details class="panel"><summary>Edit round timers</summary><p class="small">Saving restarts this phase’s countdown. Set 0 to pause a phase.</p><form id="liveTimers">${timerInputs(r)}<button class="bigbtn ghost">Save timers</button></form></details>` : ''}`;
    if ($('#liveTimers')) $('#liveTimers').onsubmit = event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      send({ type: 'mafiaTimers', rules: Object.fromEntries(EDITABLE_TIMERS.map(([key]) => [key, Number(form.get(key))])) });
    };
  }
  updateRoleBudget();
}
function renderPrivate() {
  const p = state.private;
  if (!p || isHostView()) { $('#private').innerHTML = ''; return; }
  const role = ROLES[p.role];
  $('#private').innerHTML = `<section class="panel private-card ${revealed && role.team === 'mafia' ? 'mafia-team' : ''}"><div class="section-head"><span class="eyebrow">FOR YOUR EYES ONLY</span><button class="secbtn" id="reveal">${revealed ? 'Hide role' : 'Reveal role'}</button></div>${revealed ? `<div class="role-title"><span class="large-icon">${role.icon}</span><div><h2>${role.name}</h2><span class="pill">${TEAM_NAMES[role.team]}</span></div></div><p>${role.description}</p>${p.teamIds.length ? `<p class="small">Your team: ${p.teamIds.map(nameOf).join(', ')}. You can target anyone, including yourself and these teammates.</p>` : ''}${p.investigations.length ? `<h3>Your vibe checks</h3>${p.investigations.map(i => `<p class="small">Night ${i.round}: <b>${nameOf(i.pid)}</b> — ${TEAM_NAMES[i.team]}</p>`).join('')}` : ''}${p.role === 'partyAnimal' ? `<div class="animal-drinks"><p class="small">${amount(p.voluntarySips,'voluntary sip')} logged. Your voluntary tally stays private until the game ends and never adds hits.</p>${state.phase !== 'gameOver' ? `<button class="bigbtn ghost" id="animalSip">Take ${amount(sipsPerAction(state.rules),'sip')} →</button>` : ''}</div>` : ''}` : '<div class="role-cover"><span class="large-icon">🤫</span><strong>Your secret is safe.</strong><span class="small">Reveal only when your screen is private.</span></div>'}${me()?.active === false ? '<p class="notice">You were caught. Follow the game here; you can no longer act or vote.</p>' : ''}</section>`;
  $('#reveal').onclick = () => { revealed = !revealed; renderPrivate(); renderAction(); };
  if ($('#animalSip')) $('#animalSip').onclick = () => send({ type: 'mafiaSip' });
}
function resultText(result) {
  if (result.kind === 'night') return result.drinks.length ? result.drinks.map(d => `${nameOf(d.pid)} takes ${amount(d.sips,'sip')} (${amount(d.hits,'hit')})`).join(' · ') : 'No hits tonight. Somebody got lucky.';
  if (!result.target) return result.tie ? 'A tied vote. Nobody takes a penalty.' : 'No accusation. Everyone abstained or missed the vote.';
  return `${nameOf(result.target)} ${result.caught ? 'was on the Instigator team and is out.' : 'is not an Instigator ally and stays in the game.'}`;
}
function renderResult() {
  const g = state;
  $('#result').innerHTML = (g.result ? `<section class="panel"><span class="eyebrow">${g.result.kind === 'night' ? 'THE MORNING REPORT' : 'THE TABLE HAS SPOKEN'}</span><p>${resultText(g.result)}</p>${g.result.drinks.map(d => `<div class="result-row"><span>${nameOf(d.pid)}</span><strong>${d.shots ? amount(d.shots,'shot') : d.sips ? amount(d.sips,'sip') : 'No drinks'}</strong></div>`).join('')}${g.result.counts ? `<p class="small">${Object.entries(g.result.counts).map(([id,count]) => `${nameOf(id)}: ${amount(count,'vote')}`).join(' · ') || 'No votes cast'}</p>` : ''}</section>` : '') + (g.phase === 'gameOver' ? `<section class="panel host-control"><h2>${g.winner === 'solo' ? '🪩 Party Animal victory' : g.winner === 'town' ? '🏘️ Town wins' : '🥂 Instigator team wins'}</h2><p>Winners: ${g.winnerIds.map(nameOf).join(', ')}.</p><p>Losing players: ${g.players.filter(p => !g.winnerIds.includes(p.pid)).map(p => escape(p.name)).join(', ')}.</p><p><b>${amount(g.rules.losingShots,'shot')} each.</b> This is in addition to any catch penalty.</p><p class="small">All roles and total drinks, including voluntary sips, are revealed below.</p></section>` : '');
}
function renderAction() {
  const host = isHostView(), p = state.private, phase = state.phase;
  if (host && phase === 'lobby') {
    const problem = lobbyError();
    $('#action').innerHTML = `<section class="panel host-control lobby-start"><div><h2>${state.players.length} players at the table</h2><p id="startStatus" class="${problem ? 'notice' : 'small'}" role="status">${escape(problem || 'Ready to go. Start applies the roles and difficulty selected below.')}</p></div><button class="bigbtn" id="start" aria-describedby="startStatus" ${problem ? 'disabled' : ''}>Start game →</button></section>`;
    $('#start').onclick = () => {
      if (!$('#config').reportValidity()) return;
      const problem = lobbyError(); if (problem) { error(problem); renderAction(); return; }
      send({ type: 'start', rules: lobbyRules() });
    };
    return;
  }
  if (host) {
    const label = { roleReveal: 'Start night with current players →', night: 'Resolve night now →', discussion: 'Open voting →', voting: 'Close voting now →', roundEnd: 'Next night →', gameOver: 'Open a new lobby →' }[phase];
    const missing = state.progress.total - state.progress.submitted;
    const auto = !!state.deadline;
    $('#action').innerHTML = `${auto ? '<details class="panel host-control"><summary>Host override · skip ahead</summary><p class="small">The timer is running. No host action is needed.</p>' : `<section class="panel host-control"><h2>Host controls</h2>`}${['night','voting','roleReveal'].includes(phase) ? `<p class="small">${missing} still pending. ${phase === 'night' ? 'Resolving now skips missing actions.' : phase === 'voting' ? 'Closing now treats missing votes as abstentions.' : 'You can start if someone has not tapped ready.'}</p>` : ''}<button class="bigbtn" id="start">${label}</button>${auto ? '</details>' : '</section>'}`;
    $('#start').onclick = () => { if (missing && ['roleReveal','night','voting'].includes(phase) && !confirm('Advance with missing responses? Unsubmitted actions will be skipped.')) return; send({ type: phase === 'gameOver' ? 'mafiaRematch' : 'mafiaAdvance', phase, round: state.round }); };
    return;
  }
  if (phase === 'lobby') { $('#action').innerHTML = '<p class="notice">You’re in. The host will deal roles when everyone is here.</p>'; return; }
  if (!p || !me()?.active || !['roleReveal','night','voting'].includes(phase)) { $('#action').innerHTML = ''; return; }
  if (phase === 'roleReveal') {
    $('#action').innerHTML = `<button class="bigbtn" id="ready" ${p.ready || !revealed ? 'disabled' : ''}>${p.ready ? 'Ready ✓ Waiting for the table' : !revealed ? 'Reveal your role first' : 'I know my role. Ready →'}</button>`;
    $('#ready').onclick = () => send({ type: 'mafiaReady' }); return;
  }
  if (phase === 'night' && !revealed) { $('#action').innerHTML = '<p class="notice">Reveal your private role to make your night move.</p>'; return; }
  const locked = phase === 'night' ? p.acted : p.voted;
  if (locked) { $('#action').innerHTML = '<p class="notice">Locked in ✓ You can hide your role while the others finish.</p>'; return; }
  const cooling = id => phase === 'night' && p.role === 'nurse' && p.cooldownTargets.includes(id);
  const noProtection = phase === 'night' && p.role === 'nurse' && !state.players.some(target => target.active && (target.pid !== viewerId() || state.rules.nurseSelf) && !cooling(target.pid));
  const civilian = phase === 'night' && (!hasNightAbility(p.role) || noProtection);
  const titles = { mafia: 'Who gets the sips?', mixologist: 'Who gets your double?', detective: 'Whose vibe is off?', nurse: 'Who needs a water break?', partyAnimal: 'The party does not stop', town: 'Keep your eyes open' };
  const candidates = state.players.filter(target => target.active && (phase === 'voting' ? target.pid !== viewerId() : target.pid !== viewerId() || canTargetSelf(p.role, state.rules)));
  const multi = phase === 'night' && p.role === 'mafia', picks = Array.isArray(selected) ? selected : [];
  const isSelected = id => multi ? picks.includes(id) : selected === id;
  const limit = state.nightPlan.targetsPerAttacker;
  $('#action').innerHTML = `<section class="panel"><h2>${phase === 'voting' ? 'Choose your suspect' : titles[p.role]}</h2><p class="small">${civilian ? noProtection ? 'No eligible protection targets this night. Lock in to wait for the next night.' : 'You have no targeted night ability. Lock in to keep the table moving.' : multi ? `Choose up to ${limit} different players. ${picks.length} / ${limit} selected. Teammates and yourself are allowed.` : 'Choose carefully. Once locked in, your choice cannot change.'}</p>${!civilian ? `<div class="targets">${candidates.map(target => `<button class="target ${isSelected(target.pid) ? 'selected' : ''}" data-target="${target.pid}" aria-pressed="${isSelected(target.pid)}" ${cooling(target.pid) || multi && picks.length >= limit && !isSelected(target.pid) ? 'disabled' : ''}>${escape(target.name)}<span class="small">${cooling(target.pid) ? 'Protected last night' : `${target.hits} / ${state.hitGoal} hits · ${amount(target.sips,'sip')}`}</span></button>`).join('')}${phase === 'voting' ? `<button class="target ${selected === 'abstain' ? 'selected' : ''}" data-target="abstain" aria-pressed="${selected === 'abstain'}">Abstain<span class="small">No accusation</span></button>` : ''}</div>` : ''}<button class="bigbtn" id="lock" ${!civilian && (multi ? !picks.length : !selected) ? 'disabled' : ''}>${civilian ? 'Wait for dawn →' : multi ? 'Lock in targets →' : 'Lock in choice →'}</button></section>`;
  $('#action').querySelectorAll('[data-target]').forEach(button => button.onclick = () => {
    const id = button.dataset.target;
    selected = multi ? picks.includes(id) ? picks.filter(pid => pid !== id) : [...picks, id] : id;
    renderAction();
  });
  $('#lock').onclick = () => send(multi ? { type: 'mafiaAct', targets: picks } : { type: phase === 'voting' ? 'mafiaVote' : 'mafiaAct', target: civilian || selected === 'abstain' ? null : selected });
}
function renderRoster() {
  $('#rosterTitle').textContent = state.phase === 'gameOver' ? 'The unmasked table' : 'At the table';
  $('#rosterCount').textContent = `${state.players.length} / 24 players`;
  $('#roster').innerHTML = state.players.length ? state.players.map(p => `<div class="player ${p.active ? '' : 'out'}"><span class="avatar" style="background:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#f59e0b'}">${escape(p.name.slice(0,1).toUpperCase())}</span><div class="player-info"><div class="player-name">${escape(p.name)}${p.pid === viewerId() ? ' (you)' : ''}</div><div class="small">${p.role ? `${ROLES[p.role].icon} ${ROLES[p.role].name} · ` : ''}${!p.active ? 'Caught' : p.connected ? 'At the table' : 'Disconnected'}</div>${state.phase !== 'lobby' ? `<span class="hit-total">${p.hits} / ${state.hitGoal} night hits</span><span class="drink-total">${amount(p.sips,'sip')} · ${amount(p.shots,'shot')}</span>` : ''}</div>${isHostView() && state.phase === 'lobby' ? `<button class="secbtn" data-remove="${p.pid}" aria-label="Remove ${escape(p.name)}">×</button>` : ''}</div>`).join('') : '<p class="small">No suspects yet. Share the room code to fill the table.</p>';
  $('#roster').querySelectorAll('[data-remove]').forEach(button => button.onclick = () => send({ type: 'mafiaRemove', pid: button.dataset.remove }));
}
function renderHistory() {
  const open = $('#history details')?.open;
  $('#history').innerHTML = state.history.length ? `<details class="panel" ${open ? 'open' : ''}><summary>Round history · ${state.history.length} reports</summary>${state.history.slice().reverse().map(h => `<div class="log-entry"><span class="eyebrow">ROUND ${h.round} · ${h.kind === 'night' ? 'NIGHT' : 'VOTE'}</span>${resultText(h)}</div>`).join('')}</details>` : '';
}
function updateClock() {
  const clock = $('#clock');
  if (!clock) return;
  const seconds = Math.max(0, Math.ceil(((state?.deadline || 0) - Date.now() - serverOffset) / 1000));
  clock.textContent = state?.deadline ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left` : '';
  clock.setAttribute('aria-label', state?.deadline ? `${seconds} seconds until automatic advancement` : '');
}
setInterval(updateClock, 1000);
document.addEventListener('visibilitychange', () => { if (document.hidden) { revealed = false; if (state) { renderPrivate(); renderAction(); } } });
$('#roleGuide').innerHTML = Object.values(ROLES).map(role => `<div><h3>${role.icon} ${role.name}</h3><p>${role.description}</p></div>`).join('');
const roomCode = new URLSearchParams(location.search).get('room');
if (roomCode) $('#code').value = roomCode.toUpperCase().slice(0,4);
if (session?.token && (!roomCode || session.code === roomCode.toUpperCase())) connect({ type: 'resume', ...session });
else { session = null; if (roomCode) $('#name').focus(); }
