# MNEMOSYNE — vessel-server deploy guide

This is the multiplayer "referee" for The Sprawl. It runs 24/7 on Railway
(separate from your Netlify game). Netlify serves the game; this server runs
the rules. They talk over a WebSocket.

You've already got: `vessel-server.js`, `package.json`, `smoketest.js`.
It's tested — all 9 checks pass locally.

------------------------------------------------------------------------
## STEP 1 — Put the server in its own GitHub repo
------------------------------------------------------------------------
1. Make a new GitHub repo, e.g. `mnemosyne-server` (private is fine).
2. Upload these three files to it:
   - vessel-server.js
   - package.json
   - smoketest.js   (optional, but nice to keep)
   Do NOT upload node_modules — Railway installs that itself.

(If you use GitHub Desktop or the web "upload files" button, that's fine —
you don't need the command line.)

------------------------------------------------------------------------
## STEP 2 — Deploy on Railway
------------------------------------------------------------------------
1. Go to railway.app → sign up (GitHub login is easiest). Free $5/mo credit,
   no card needed to start.
2. New Project → "Deploy from GitHub repo" → pick `mnemosyne-server`.
3. Railway auto-detects Node, runs `npm install`, then `npm start`.
   (Our package.json start script is `node vessel-server.js`.)
4. When it finishes, open the service → Settings → Networking →
   "Generate Domain". You'll get a URL like:
        mnemosyne-server-production.up.railway.app
5. Your WebSocket address is that domain with `wss://` in front:
        wss://mnemosyne-server-production.up.railway.app
   Copy it — the game needs it.

Railway sets the PORT env var automatically; the server reads it. Don't set
PORT yourself.

------------------------------------------------------------------------
## STEP 3 — Tell the game where the server is
------------------------------------------------------------------------
In the game's multiplayer client code there is ONE line:

        const SERVER_URL = "wss://REPLACE-ME";

Paste your Railway wss:// URL there, save, and push the game to Netlify as
usual. That's the whole "handshake."

------------------------------------------------------------------------
## STEP 4 — Test with a friend
------------------------------------------------------------------------
1. You open the game → Multiplayer → Create Room → you get a 4-letter code.
2. Text the code to a friend.
3. They open the game → Multiplayer → Join → type the code.
4. Once 2+ of you are in, a 5-second countdown starts, then you drop in
   together. Last machine standing wins.

------------------------------------------------------------------------
## IF SOMETHING DOESN'T CONNECT
------------------------------------------------------------------------
- "It won't connect": check the URL starts with `wss://` (not `https://`,
  not `ws://`) and has NO trailing slash.
- "Room not found": codes are case-insensitive but must be typed exactly;
  they expire when everyone leaves.
- Check Railway's "Deployments" tab logs — the server prints
  "vessel-server listening on :PORT" when healthy.
- Railway free credit runs down with 24/7 uptime; if the server sleeps or
  stops, redeploy or upgrade to the $5 hobby plan.

------------------------------------------------------------------------
## WHAT THIS VERSION DOES / DOESN'T DO  (by design, for the first release)
------------------------------------------------------------------------
DOES:  private coded rooms · real-time position sync · server-validated
       damage/kills/wins · one synced storm · fire-rate + range anti-cheat.
DOESN'T (yet, on purpose): bots in online rooms · token/hold verification ·
       real on-chain burns · ranked/leaderboards · public matchmaking.
       These are later dial-turns on the same server, not rewrites.

Single-player Sprawl is untouched and still works with zero server needed.
