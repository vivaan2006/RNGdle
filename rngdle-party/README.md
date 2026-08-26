# RNGdle — Party Edition

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
Requires [Bun](https://bun.sh) (already installed on this machine):

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

## Files

```
index.html   – the app (solo, local party, online host + phone views, reveal + sound)
engine.js    – the extracted rngdle scoring engine (self-contained, ~1 MB incl. the percentile CDF)
server.js    – Bun WebSocket server for online play (serves the app + runs rooms)
_reference/  – provenance: original bundles + the extraction/validation scripts (safe to delete)
```
