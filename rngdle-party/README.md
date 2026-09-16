# RNGparty

A faithful clone of **[rngdle.com](https://www.rngdle.com/)** with the good stuff added:

- **♾️ No roll rate limit** — roll as much as you want (the real site makes you wait ~8h)
- **🎰 Slot-machine reveal** — digits lock in one at a time, left to right, with synthesized slot sounds
- **🛋️ Local party** — everyone on one screen, all roll **simultaneously**
- **📱 Online party (Jackbox-style)** — one screen hosts, friends join from their phones with a room code and roll on their own device; all reveals happen at once

## How faithful is the game itself?

The scoring engine (`engine.js`) is the **original rngdle.com code**, extracted verbatim and re-hosted through a tiny module loader:

- All **233 badges** with their exact check functions and the original math helpers
- The exact **EP scores** and **probabilities**, the exact **percentile curve** (60,599-point CDF)
- The exact **rarity tiers** (badge rarity by EP; card rarity by percentile: trash→common→uncommon→rare→epic→anomaly→mythic)

**Verified:** all 2,210 of the site's own built-in match/reject test vectors pass, and
`composeRollResult(644959)` reproduces the live site exactly — score **3,335**, 13 badges, **Bottom 14%**.

## Running it

### Solo + Local party (no server needed)
Just open `index.html` — double-click it, or serve the folder any way you like. Everything runs in the browser.

### Online party (Jackbox-style) — needs the server
Runs on **Node 18+** or **[Bun](https://bun.sh)** — no dependencies to install either way:

```bash
cd rngdle-party
node server.js
```

```bash
cd rngdle-party
bun server.js
```

It prints two links:

```
Host screen (this machine):  http://localhost:3000
Friends on same Wi-Fi join:  http://192.168.x.x:3000
```

1. Open the **host** link on a TV / laptop → **Party → Online → Host on this screen**.
2. A big **ROOM CODE** appears. Friends open the Wi-Fi link on their phones (or scan/type the join link) and enter the code + their name.
3. Each round, everyone taps **ROLL** on their own phone. When all are in, every screen reveals the numbers **at the same time**, digit by digit. Cumulative EP leaderboard, highest wins.

> Rolls are generated **server-side with the same engine**, so every device stays perfectly in sync and nobody can cheat.
>
> This is built for friends on the **same Wi-Fi**. To play with remote friends over the internet, expose the port with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or ngrok) and share that URL — no code changes needed.

## Modes at a glance

| Mode | Where | How |
|------|-------|-----|
| **Solo** | one browser | endless rolling, tracks lifetime EP / best roll / best rarity |
| **Local party** | one screen | 2–12 players, tap *Roll Everyone*, all reveal together |
| **Online party** | many devices | host screen + phones, synchronized reveals |

Both party modes support **Rounds** (best of 3/5/10, highest total EP wins) or **Endless** (running leaderboard).
Mute sound anytime with the 🔊 button.

## Mafia

Open **Mafia** from the hub, or `/mafia.html` on the running server. The host
screen is shared; each player joins on their own device. The host can also play
by joining on a phone or in another tab. Rooms support 4–24 players.

### Cast and teams

Role cards provide an icon, description, and +/− count. Set optional roles to
0 to omit them; remaining seats become Partygoers. Classic is the default:
one Drink Dealer, Party Detective, and Party Medic (4+ players). The Party
Jester preset has one Drink Dealer, Party Jester, and Party Medic; with
five players, the other two are Partygoers. Double Pourers are off by default.
Start game validates and applies the displayed selections in one step;
there is no separate save button. Invalid casts and disconnected seats show
the reason beside Start and below the role cards. A large amber room-code
banner and a persistent header code help everyone join the right room.

- **Drink Dealer** (formerly Mafia): delivers night hits. The Drink Dealer team
  also includes Double Pourers. All their allies must be caught for town to win.
- **Double Pourer:** one matching Drink Dealer target gets double night sips once.
  This does not double hits, and unmatched picks cause no hits or sips.
- **Party Detective** (formerly Detective): privately learns the target's team
  at dawn, including an independent Party Jester's team.
- **Party Medic** (formerly Nurse): blocks every night hit and sip on
  their chosen player. With the default shared protection cooldown, nobody
  protected last night can be protected by any Medic tonight. This prevents
  multiple Medics from alternating permanent protection. Targets become
  available after a one-night gap. Medics may pass if there are no eligible
  targets; their bot controls handle this too. Self-protection and cooldown
  are enabled by default and no longer have lobby switches.
- **Party Jester:** independent, with repeatable voluntary drinks throughout
  play. Their private drink button assigns the difficulty's sip amount;
  voluntary sips never count as hits and are private until final totals.
  Their jester-like objective is to be chosen by a Party Medic. At dawn,
  chosen Jesters win and the game ends. Multiple simultaneously chosen Jesters
  can win; unchosen Jesters lose. A Medic must be enabled if Jesters are in play.
- **Partygoer:** discuss, bluff, and vote; no targeted night ability.

Bouncer and Gossip have been removed. Internal role IDs `mafia`, `detective`,
and `nurse` remain stable, while their display names use the party theme.

### Hits, drinks, and winning

Each Drink Dealer can select up to **ceil(active players / (3 × active
Drink Dealers))** distinct players per night, minimum 1 while any Drink Dealer is
active. The allowance is recalculated as players are caught; Double Pourers do
not increase the Drink Dealer count. Examples: 5 players / 1 Drink Dealer → 2
picks; 12 / 2 → 2 each; 12 / 1 → 4. Teammates and self-targets are allowed.
Different Drink Dealers may overlap, producing one hit per unprotected pick.

**Easy / Medium / Hard** assign **1 / 2 / 3 sips per action** (Medium by
default), covering night hits, wrong accusations, and voluntary Jester drinks.
Double Pourer matches double sips but not hit counts. Raw sip fields are no longer
accepted. The simplified lobby omits individual penalty controls; catches and
losses default to one shot each. The Medic blocks both hits and sips.

The vote accuses whoever has the most votes. Caught Drink Dealer allies are out
and take catch shots. Other players take the preset sips and stay active;
Party Jesters do not win from being accused. Ties, all-abstain rounds, and
missed actions have no penalty; missed votes abstain. Self-voting is disabled.

After every vote, town wins if every Drink Dealer ally is out. Otherwise,
Drink Dealers win when **every opposing player, including Party Jesters, has
received at least 3 successful night hits**. Hits on teammates are irrelevant
to this goal. Wrong votes, voluntary drinks, and shots never count as hits.
Town wins a simultaneous final catch / full-coverage round. Medic-triggered
Jester wins happen earlier, at dawn. All nonwinning players, including caught
allies or unchosen Jesters, receive the losing-player shots once.

### Timing, testing, and reconnects

Defaults are role reveal 20s, night 45s, discussion 90s, voting 30s, verdict
12s. Phases advance automatically; roles, night, and voting may finish early
when everyone responds. Night, discussion, and voting timers are tucked in a
collapsed section and remain editable during play; saving restarts the current
countdown. A 0 timer is manually paced. Reveal and verdict use fixed defaults
in the normal setup. Role counts and difficulty lock until the next lobby.
Public narration can be enabled
with the host's sound button; private information is never spoken.

Local testing is available only on development servers. Production builds and
Fly deployments hide its entry point and reject test-room creation and bot
commands on the server. Normal games and QR joins remain available.

**Start local test** creates five controllable bots. Adjust the count and cast,
switch between host and player screens, choose exact targets, or auto-fill
remaining legal actions and votes. **Pause timers for testing** allows manual
inspection; **Use automatic timers** restores defaults. **Reset to lobby**
clears progress and retains rules. Test rooms block real player joins and
expose bot roles only to their controlling host.

Reloading restores the same role and progress. Disconnected dealt seats remain
in the game; timers and overrides prevent stalls. The host retains the existing
45-second reconnect window. Rooms are in memory and end on server restart.

Run `npm test` (Node 22+) for role rules, hit counts, solo wins, protection
cooldowns, privacy, timers, reconnects, testing controls, and live WebSocket
integration including the existing RNGdle flow.

## Files

```
index.html   – the app (solo, local party, online host + phone views, reveal + sound)
engine.js    – the extracted rngdle scoring engine (self-contained, ~1 MB incl. the percentile CDF)
server.js    – WebSocket server for online play (serves the app + runs rooms); Bun or Node
node-ws.js   – tiny zero-dependency WebSocket + static server, used when running under Node
mafia.html   – Mafia lobby, shared host screen, and private phone view
mafia.css    – Mafia styles using the existing site's colors and typography
mafia-client.js – Mafia UI, narration, and room reconnection
mafia-rules.js  – shared role descriptions and rule validation
mafia-engine.js – server-only role assignment, actions, voting, and victory logic
test/        – game rules and live room integration tests
_reference/  – provenance: original bundles + the extraction/validation scripts (safe to delete)
```
