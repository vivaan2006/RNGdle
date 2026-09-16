# RNGparty

Browser party games, zero npm dependencies. `rngdle-party/` is the whole app.

## Keep context small

Context in this repo is dominated by file contents, not tooling. Some files are
big enough that a single read costs a meaningful share of the window:

| File | Size | ~Tokens if read whole |
|---|---|---|
| `engine.js` | 1.1 MB | ~275k |
| `horsrng.html` | 260 KB | ~65k |
| `index.html` | 132 KB | ~33k |
| `imposter.html` | 52 KB | ~13k |

- **Never read `engine.js`.** It is vendored verbatim from rngdle.com and is not
  edited. To ask it anything, run it instead:
  `node -e 'require("./engine.js"); console.log(globalThis.RNGDLE.roll(644959))'`
- **Never read a whole `.html` game file.** Use `grep -n` to find the line, then
  `sed -n 'A,Bp'` to read only that range.
- **Edit by targeted patch, not read-then-rewrite.** Editing echoes the changed
  file back into context, so prefer a small `Edit` or a scripted string
  replacement that asserts it matched exactly once, over reading a large file in
  order to rewrite it.
- **Batch independent tool calls** into one response rather than one per turn.

## Layout

Each game is fully independent — own page, own server module, own WebSocket
path, own room state. Nothing is shared except the HTTP process and the files
below.

```
server.js            HTTP + static + /api routes; hosts RNGdle and Mafia rooms
node-ws.js           zero-dependency WebSocket + static server (Node path)
horsrng-server.js    \
imposter-server.js    > one room map each, own ws path
rngoldrush-server.js  |
irishpoker-server.js /
rngoldrush-rules.js  SHARED: RNGold Rush wheel, rarities, settings (browser+server)
rooms-registry.js    SHARED: mints globally unique room codes, maps code -> game
qr.js                SHARED: QR encoder (byte mode, EC M, versions 1-10)
join-qr.js           SHARED: renders a join QR, resolving a LAN-reachable origin
drinks.js            SHARED: drinking rules, loaded by browser AND server
engine.js            vendored rngdle scoring engine — do not read or edit
```

`drinks.js`, `qr.js`, `join-qr.js`, `rngoldrush-rules.js` and
`rooms-registry.js` are loaded by both the browser and the server on purpose,
so rules exist in exactly one place. RNGold Rush needs this twice over: the
server draws from the wheel, and the local party mode plays a whole game in the
browser off the same file.

## Things that cost time when forgotten

- **Room codes are global.** All games mint through `rooms-registry.js`, so a
  code identifies its game. `/api/room?code=XXXX` resolves code -> game; that is
  what lets one hub join box reach any game.
- **QR origin.** `location.origin` is wrong on a localhost host — the QR would
  say "localhost", which resolves to the scanning phone. `join-qr.js` asks
  `/api/lan-origin` instead. Use it rather than encoding a URL by hand.
- **Reveal timing is duplicated on purpose.** `PER_DIGIT`, `LAST_EXTRA`,
  `BADGE_*` and `PAYOFF_HOLD` exist in both `index.html` and `server.js`. The
  server holds the round open for as long as clients animate. Change both or
  rounds end mid-animation. Same idea in Irish Poker: `BURN_MS` and
  `BUS_FINISH_HOLD_MS` in `irishpoker-server.js` must outlast the `TM` timeline
  in `irishpoker.html`.
- **Rooms are in memory.** Any restart or deploy drops every live room.
- **New shared files need a static route.** A file loaded by the browser must
  be added to `STATIC` in `server.js` or it 404s — and a server already running
  won't pick up the new route until it's restarted.

## Running and verifying

```bash
node server.js     # or: bun server.js    — port 3000, set PORT to change
npm test           # node --test, ~9s
```

Cheap checks that avoid loading files into context:

```bash
curl -s "localhost:3000/api/room?code=ABCD"     # code -> game routing
curl -s localhost:3000/api/lan-origin           # LAN origin for QRs
node -e 'import("./server.js").then(()=>console.log("loads"))'
```

To check an inline `<script>` parses without reading the file:

```bash
node -e "const h=require('fs').readFileSync('index.html','utf8');
[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new Function(m[1]));
console.log('parses')"
```

QR output can be verified for real with the browser's `BarcodeDetector` —
decode the rendered SVG and compare to the expected URL. Hand-rolled QR bugs are
invisible to inspection.

## Deploying

Pushing to `main` triggers a Fly.io deploy via GitHub Actions whenever
`rngdle-party/**` changes. Say so before pushing — a push is a live release.
