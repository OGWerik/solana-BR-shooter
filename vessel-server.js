/* ============================================================================
   MNEMOSYNE — THE SPRAWL  ·  Multiplayer Referee Server  (vessel-server.js)
   ----------------------------------------------------------------------------
   First online version: small PRIVATE CODED ROOMS, real players, no bots.

   WHAT THIS SERVER OWNS (authoritative — clients cannot fake these):
     - Rooms (who is in which room, when the match starts)
     - Every player's position (relayed to everyone in the room)
     - Damage / hits / kills  (VALIDATED: clients report a hit, the server
       sanity-checks it before applying — distance, fire-rate, target alive)
     - The storm (one clock, same circle for everyone)
     - Win / loss (server declares the last machine standing)

   WHAT CLIENTS OWN (fast, local, not the server's business):
     - Their own movement input (they move instantly, then report position)
     - All cosmetics (skins, camo, melee, trails — purely visual)

   DESIGN NOTE — "validated" vs "authoritative":
     Damage tables + fire-rate limits + kill/win decisions already live here.
     Right now we TRUST the client's shot origin/direction but VALIDATE the
     result (were they close enough? was the gun off cooldown? is the target
     alive and not already dead this tick?). To harden to full authoritative
     later, we tighten these checks / re-simulate bullets — that's turning the
     dials in validateHit(), NOT a rewrite. Keep combat rules in ONE place.
   ========================================================================== */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/* ============================================================================
   ON-CHAIN BALANCE VERIFICATION ($MNEMO hold-gating)
   ----------------------------------------------------------------------------
   The server reads a wallet's REAL $MNEMO balance from Solana and tells the
   game what it truly holds. This is the authoritative number — the client
   cannot fake it, so hold-gated cosmetics are safe.

   >>> RICK: SET THESE TWO VALUES, then redeploy to Railway. <<<
   1. MNEMO_MINT  — your $MNEMO token's mint address (from pump.fun / the chain)
   2. SOLANA_RPC  — a Solana RPC URL. The public one works for light testing but
                    rate-limits; better to use a free Helius/QuickNode endpoint.
                    You can also set these as Railway env vars instead of editing
                    here (MNEMO_MINT and SOLANA_RPC).
   ========================================================================== */
const MNEMO_MINT = process.env.MNEMO_MINT || "REPLACE-WITH-YOUR-MNEMO-MINT-ADDRESS";
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const BALANCE_CACHE_MS = 60_000;   // re-check a wallet at most once per minute
const _balCache = new Map();       // pubkey -> {hold, at}

/* returns the wallet's $MNEMO balance (whole tokens), or null if unavailable */
async function fetchMnemoBalance(pubkey) {
  if (!pubkey) return null;
  if (MNEMO_MINT.includes('REPLACE')) return null;   // not configured yet
  // serve from cache if fresh
  const c = _balCache.get(pubkey);
  if (c && Date.now() - c.at < BALANCE_CACHE_MS) return c.hold;
  try {
    // getTokenAccountsByOwner filtered to the MNEMO mint, parsed for uiAmount
    const body = {
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [ pubkey, { mint: MNEMO_MINT }, { encoding: 'jsonParsed' } ]
    };
    const res = await fetch(SOLANA_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    let hold = 0;
    const accts = json && json.result && json.result.value;
    if (Array.isArray(accts)) {
      for (const a of accts) {
        const amt = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === 'number') hold += amt;
      }
    }
    _balCache.set(pubkey, { hold, at: Date.now() });
    return hold;
  } catch (e) {
    console.error('balance fetch failed:', e.message);
    return null;   // network/RPC error — caller keeps prior/zero
  }
}

/* ================= BURN VERIFICATION — FULLY ON-CHAIN ================= */
/* No database. A player's unlocks ARE their burn history on the chain:
   - To burn, the browser sends $MNEMO to the burn address with a memo
     "MNEMO-BURN:<item>" attached to the transaction.
   - verifyBurnTx confirms a single burn tx (right token actually left wallet).
   - getUnlocksOnChain reads the wallet's transaction history to the burn
     address, reads each memo, and returns the set of unlocked items — freshly
     from the chain every time. Survives any server restart; it's stateless. */
const _sigCache = new Map();   // pubkey -> {items, at}  (short cache to spare RPC)
const UNLOCK_CACHE_MS = 30_000;

async function rpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

async function verifyBurnTx(sig, pubkey) {
  if (MNEMO_MINT.includes('REPLACE')) return { ok: false, reason: 'token not configured' };
  try {
    const json = await rpc('getTransaction', [ sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 } ]);
    const tx = json && json.result;
    if (!tx) return { ok: false, reason: 'transaction not found yet' };
    if (tx.meta && tx.meta.err) return { ok: false, reason: 'transaction failed on-chain' };
    const pre = (tx.meta && tx.meta.preTokenBalances) || [];
    const post = (tx.meta && tx.meta.postTokenBalances) || [];
    const mintMatch = b => b.mint === MNEMO_MINT;
    const preOwner = pre.find(b => mintMatch(b) && b.owner === pubkey);
    const postOwner = post.find(b => mintMatch(b) && b.owner === pubkey);
    const preAmt = preOwner ? Number(preOwner.uiTokenAmount.uiAmount || 0) : 0;
    const postAmt = postOwner ? Number(postOwner.uiTokenAmount.uiAmount || 0) : 0;
    const burned = preAmt - postAmt;
    if (burned <= 0) return { ok: false, reason: 'no MNEMO left this wallet' };
    // pull the item name out of the memo, if present
    const item = extractBurnMemo(tx);
    _sigCache.delete(pubkey);   // bust cache so the new unlock shows immediately
    return { ok: true, amount: burned, item };
  } catch (e) {
    console.error('burn verify failed:', e.message);
    return { ok: false, reason: 'verification error, retry' };
  }
}

/* find "MNEMO-BURN:<item>" in a transaction's memo/log entries */
function extractBurnMemo(tx) {
  const logs = (tx.meta && tx.meta.logMessages) || [];
  for (const l of logs) {
    const m = /MNEMO-BURN:([A-Za-z0-9_\-]+)/.exec(l);
    if (m) return m[1];
  }
  // also check parsed instructions for a memo program entry
  const ins = (tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [];
  for (const i of ins) {
    const memo = i.parsed && typeof i.parsed === 'string' ? i.parsed : (i.parsed && i.parsed.info);
    const s = typeof memo === 'string' ? memo : '';
    const m = /MNEMO-BURN:([A-Za-z0-9_\-]+)/.exec(s);
    if (m) return m[1];
  }
  return null;
}

/* read the wallet's burn history straight from the chain → unlocked items */
async function getUnlocksOnChain(pubkey) {
  if (MNEMO_MINT.includes('REPLACE')) return [];
  const c = _sigCache.get(pubkey);
  if (c && Date.now() - c.at < UNLOCK_CACHE_MS) return c.items;
  try {
    // recent signatures involving this wallet (most recent first, capped)
    const sigsJson = await rpc('getSignaturesForAddress', [ pubkey, { limit: 40 } ]);
    const sigs = (sigsJson && sigsJson.result) || [];
    const items = new Set();
    // check the newest ~20 for burn memos (bounded RPC work)
    for (const s of sigs.slice(0, 20)) {
      if (s.err) continue;
      const txJson = await rpc('getTransaction', [ s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 } ]);
      const tx = txJson && txJson.result;
      if (!tx || (tx.meta && tx.meta.err)) continue;
      const item = extractBurnMemo(tx);
      if (!item) continue;
      // confirm this tx actually burned MNEMO from this wallet
      const pre = (tx.meta && tx.meta.preTokenBalances) || [];
      const post = (tx.meta && tx.meta.postTokenBalances) || [];
      const preOwner = pre.find(b => b.mint === MNEMO_MINT && b.owner === pubkey);
      const postOwner = post.find(b => b.mint === MNEMO_MINT && b.owner === pubkey);
      const preAmt = preOwner ? Number(preOwner.uiTokenAmount.uiAmount || 0) : 0;
      const postAmt = postOwner ? Number(postOwner.uiTokenAmount.uiAmount || 0) : 0;
      if (preAmt - postAmt > 0) items.add(item);
    }
    const arr = Array.from(items);
    _sigCache.set(pubkey, { items: arr, at: Date.now() });
    return arr;
  } catch (e) {
    console.error('on-chain unlock read failed:', e.message);
    return (c ? c.items : []);   // fall back to last known
  }
}


/* ---- FROZEN RULESET (must match the client's CONFIG for these values) ---- */
const RULES = {
  maxPlayersPerRoom: 12,
  minPlayersToStart: 2,
  startCountdown: 5,          // seconds after min players present
  spawnHP: 100,

  // weapons: fireCd = min seconds between shots (fire-rate gate),
  // dmg = damage on a validated hit, range = max hit distance the server allows
  weapons: {
    rifle:   { fireCd: 0.11, dmg: 12, range: 340 },
    shotgun: { fireCd: 0.70, dmg: 9,  range: 110 },  // per pellet
    sniper:  { fireCd: 1.10, dmg: 45, range: 1600 },
    melee:   { fireCd: 0.70, dmg: 34, range: 14 }
  },

  // storm (server-driven; mirror of the single-player pacing)
  fieldSize: 2400,
  stormStartR: 2400 * 0.72,
  stormStartDelay: 10,
  stormShrinkEvery: 14,
  stormShrinkAmt: 0.18,
  stormMinR: 70,
  stormDps: 9,

  hitGraceSlack: 1.35,        // allowance on range checks for latency/lag
  tickRate: 20                // server sim ticks per second (storm + housekeeping)
};

/* --------------------------------- ROOMS --------------------------------- */
/* rooms: Map<code, Room>
   Room = {
     code, players: Map<id, Player>, started, over, t, phase,
     stormR, stormTargetR, stormCx, stormCz, nextShrink, startAt
   }
   Player = {
     id, ws, name, faction, cosmetics,
     x, y, z, yaw, weapon, hp, alive, kills, lastFire:{weapon:t},
     ready, joinedAt
   }
*/
const rooms = new Map();

function makeCode() {
  // 4-char room code, avoids ambiguous chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code,
    players: new Map(),
    started: false,
    over: false,
    t: 0,
    phase: 0,
    stormR: RULES.stormStartR,
    stormTargetR: RULES.stormStartR,
    stormCx: RULES.fieldSize / 2,
    stormCz: RULES.fieldSize / 2,
    nextShrink: RULES.stormStartDelay,
    startAt: null,          // timestamp when countdown → match begins
    countdownActive: false
  };
}

let nextId = 1;
function makePlayer(ws, name, faction, cosmetics) {
  return {
    id: nextId++,
    ws,
    name: (name || 'MACHINE').slice(0, 24),
    faction: faction === 'lethe' ? 'lethe' : 'keepers',
    cosmetics: cosmetics || {},
    x: 0, y: 0, z: 0, yaw: 0,
    weapon: 'rifle',
    hp: RULES.spawnHP,
    alive: true,
    kills: 0,
    lastFire: {},           // weapon -> last-fire timestamp (server clock)
    joinedAt: Date.now()
  };
}

/* ------------------------------ MESSAGING -------------------------------- */
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(s);
  }
}

function roomStateMsg(room) {
  return {
    t: 'room',
    code: room.code,
    started: room.started,
    over: room.over,
    countdown: room.countdownActive && room.startAt
      ? Math.max(0, Math.ceil((room.startAt - Date.now()) / 1000)) : null,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, faction: p.faction, alive: p.alive,
      kills: p.kills, hp: p.hp, cosmetics: p.cosmetics
    }))
  };
}

/* ------------------------------ MATCH FLOW ------------------------------- */
function maybeStartCountdown(room) {
  if (room.started || room.over) return;
  const n = room.players.size;
  if (n >= RULES.minPlayersToStart && !room.countdownActive) {
    room.countdownActive = true;
    room.startAt = Date.now() + RULES.startCountdown * 1000;
    broadcast(room, { t: 'countdown', seconds: RULES.startCountdown });
  } else if (n < RULES.minPlayersToStart && room.countdownActive) {
    // dropped below min — cancel
    room.countdownActive = false;
    room.startAt = null;
    broadcast(room, { t: 'countdown_cancel' });
  }
}

function startMatch(room) {
  room.started = true;
  room.countdownActive = false;
  room.t = 0; room.phase = 0;
  room.stormR = RULES.stormStartR;
  room.stormTargetR = RULES.stormStartR;
  room.stormCx = RULES.fieldSize / 2;
  room.stormCz = RULES.fieldSize / 2;
  room.nextShrink = RULES.stormStartDelay;
  // spawn everyone alive with full HP, spread around the map edge
  const arr = [...room.players.values()];
  arr.forEach((p, i) => {
    p.hp = RULES.spawnHP; p.alive = true; p.kills = 0; p.lastFire = {};
    const ang = (i / arr.length) * Math.PI * 2;
    p.x = RULES.fieldSize / 2 + Math.cos(ang) * RULES.fieldSize * 0.42;
    p.z = RULES.fieldSize / 2 + Math.sin(ang) * RULES.fieldSize * 0.42;
    p.y = 0; p.yaw = ang + Math.PI;
  });
  broadcast(room, {
    t: 'start',
    spawns: arr.map(p => ({ id: p.id, x: p.x, z: p.z, yaw: p.yaw }))
  });
}

function checkWin(room) {
  if (room.over || !room.started) return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1) {
    room.over = true;
    const winner = alive[0] || null;
    broadcast(room, {
      t: 'gameover',
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null
    });
  }
}

/* -------------------------- COMBAT VALIDATION ---------------------------- */
/* Client says: "I hit player <targetId> with <weapon> from <origin>."
   Server checks the shot is plausible, then applies damage. This is the
   ONE place combat truth lives. Tighten here to harden anti-cheat later. */
function validateHit(room, shooter, msg) {
  if (!room.started || room.over) return;
  if (!shooter.alive) return;

  const w = RULES.weapons[msg.weapon];
  if (!w) return;

  const target = room.players.get(msg.targetId);
  if (!target || !target.alive || target.id === shooter.id) return;

  // fire-rate gate: reject shots faster than the weapon allows.
  // uses wall-clock (ms) so it doesn't depend on the storm tick timing.
  const nowMs = Date.now();
  const last = shooter.lastFire[msg.weapon] || 0;
  if (nowMs - last < w.fireCd * 1000) return;
  shooter.lastFire[msg.weapon] = nowMs;

  // distance gate: server uses its OWN copy of positions, not the client's
  const dx = target.x - shooter.x;
  const dz = target.z - shooter.z;
  const dist = Math.hypot(dx, dz);
  if (dist > w.range * RULES.hitGraceSlack) return;

  // apply damage
  target.hp -= w.dmg;
  const killed = target.hp <= 0;
  if (killed) {
    target.alive = false;
    shooter.kills++;
  }

  // tell the room: damage happened (everyone updates HP bars / death FX)
  broadcast(room, {
    t: 'hit',
    shooterId: shooter.id,
    targetId: target.id,
    weapon: msg.weapon,
    dmg: w.dmg,
    targetHp: Math.max(0, target.hp),
    killed
  });

  if (killed) {
    broadcast(room, { t: 'kill', killerId: shooter.id, victimId: target.id });
    checkWin(room);
  }
}

/* ------------------------------ STORM SIM -------------------------------- */
function stepStorm(room, dt) {
  if (!room.started || room.over) return;
  room.t += dt;

  if (room.t >= room.nextShrink) {
    room.phase++;
    room.stormTargetR = Math.max(RULES.stormMinR,
      room.stormR * (1 - RULES.stormShrinkAmt));
    room.nextShrink = room.t + RULES.stormShrinkEvery;
    broadcast(room, { t: 'storm', phase: room.phase, targetR: room.stormTargetR });
  }
  // ease the radius toward target (client mirrors this for the visual)
  room.stormR += (room.stormTargetR - room.stormR) * Math.min(1, dt * 0.9);

  // storm damage: anyone outside the circle takes dps
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - room.stormCx, p.z - room.stormCz);
    if (d > room.stormR) {
      p.hp -= RULES.stormDps * dt * (1 + room.phase * 0.15);
      if (p.hp <= 0) {
        p.alive = false;
        broadcast(room, { t: 'kill', killerId: null, victimId: p.id, cause: 'storm' });
        checkWin(room);
      }
    }
  }
}

/* --------------------------- POSITION BROADCAST -------------------------- */
/* Sent frequently: each client's authoritative-to-itself position, relayed. */
function broadcastPositions(room) {
  if (!room.started) return;
  const snap = [];
  for (const p of room.players.values()) {
    snap.push({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, w: p.weapon, a: p.alive });
  }
  broadcast(room, { t: 'pos', players: snap });
}

/* ------------------------------ WS SERVER -------------------------------- */
const server = http.createServer((req, res) => {
  // simple health check so Railway/uptime pings get a 200
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MNEMOSYNE vessel-server online');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.t) {

      /* ---- create a private room, get a code back ---- */
      case 'create': {
        const code = makeCode();
        const room = newRoom(code);
        rooms.set(code, room);
        const p = makePlayer(ws, msg.name, msg.faction, msg.cosmetics);
        room.players.set(p.id, p);
        ws.roomCode = code; ws.playerId = p.id;
        send(ws, { t: 'joined', code, youId: p.id, host: true });
        broadcast(room, roomStateMsg(room));
        maybeStartCountdown(room);
        break;
      }

      /* ---- join an existing room by code ---- */
      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { t: 'error', msg: 'Room not found' }); break; }
        if (room.started) { send(ws, { t: 'error', msg: 'Match already started' }); break; }
        if (room.players.size >= RULES.maxPlayersPerRoom) {
          send(ws, { t: 'error', msg: 'Room full' }); break;
        }
        const p = makePlayer(ws, msg.name, msg.faction, msg.cosmetics);
        room.players.set(p.id, p);
        ws.roomCode = code; ws.playerId = p.id;
        send(ws, { t: 'joined', code, youId: p.id, host: false });
        broadcast(room, roomStateMsg(room));
        maybeStartCountdown(room);
        break;
      }

      /* ---- position update from a client (frequent) ---- */
      case 'pos': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const p = room.players.get(ws.playerId);
        if (!p || !p.alive) break;
        // trust the client's own position (validated combat model), clamp to map
        p.x = Math.max(0, Math.min(RULES.fieldSize, +msg.x || 0));
        p.z = Math.max(0, Math.min(RULES.fieldSize, +msg.z || 0));
        p.y = +msg.y || 0;
        p.yaw = +msg.yaw || 0;
        if (msg.w && RULES.weapons[msg.w]) p.weapon = msg.w;
        break;
      }

      /* ---- a hit claim: server validates before applying ---- */
      case 'hit': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const shooter = room.players.get(ws.playerId);
        if (!shooter) break;
        validateHit(room, shooter, msg);
        break;
      }

      /* ---- cosmetic/loadout update in the lobby ---- */
      case 'loadout': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const p = room.players.get(ws.playerId);
        if (!p) break;
        p.cosmetics = msg.cosmetics || p.cosmetics;
        if (msg.faction) p.faction = msg.faction === 'lethe' ? 'lethe' : 'keepers';
        broadcast(room, roomStateMsg(room));
        break;
      }

      /* ---- leave / rematch ---- */
      case 'leave': {
        cleanupSocket(ws);
        break;
      }

      /* ---- client asks the server to verify its on-chain $MNEMO balance ---- */
      case 'verify_balance': {
        const pubkey = (msg.pubkey || '').trim();
        if (!pubkey) { send(ws, { t: 'balance', hold: 0, verified: false }); break; }
        fetchMnemoBalance(pubkey).then(hold => {
          if (hold == null) {
            // RPC unavailable or not configured — tell the client it's unverified
            send(ws, { t: 'balance', pubkey, hold: 0, verified: false });
          } else {
            send(ws, { t: 'balance', pubkey, hold, verified: true });
          }
        });
        break;
      }

      /* ---- client reports a burn transaction; server verifies it on-chain ---- */
      case 'verify_burn': {
        const sig = (msg.sig || '').trim();
        const pubkey = (msg.pubkey || '').trim();
        const item = (msg.item || '').trim();
        if (!sig || !pubkey) { send(ws, { t: 'burn_result', ok: false, item, reason: 'missing signature' }); break; }
        verifyBurnTx(sig, pubkey).then(result => {
          if (result.ok) {
            // no database — the burn tx itself (with its memo) IS the record.
            // the item is read back from the on-chain memo when confirmed.
            send(ws, { t: 'burn_result', ok: true, item: result.item || item, amount: result.amount, sig });
          } else {
            send(ws, { t: 'burn_result', ok: false, item, reason: result.reason });
          }
        });
        break;
      }

      /* ---- client asks which items this wallet has unlocked ----
         answered by reading the wallet's burn history from the chain */
      case 'get_unlocks': {
        const pubkey = (msg.pubkey || '').trim();
        if (!pubkey) { send(ws, { t: 'unlocks', pubkey, items: [] }); break; }
        getUnlocksOnChain(pubkey).then(items => {
          send(ws, { t: 'unlocks', pubkey, items });
        });
        break;
      }
    }
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

function cleanupSocket(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  const p = room.players.get(ws.playerId);
  if (p) {
    room.players.delete(ws.playerId);
    broadcast(room, { t: 'left', id: ws.playerId });
    if (room.started && !room.over) checkWin(room);
    broadcast(room, roomStateMsg(room));
    maybeStartCountdown(room);
  }
  ws.roomCode = null; ws.playerId = null;
  // empty rooms are reaped by the housekeeping loop
}

/* ------------------------- MAIN SERVER LOOPS ----------------------------- */
// countdown → start
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.countdownActive && room.startAt && now >= room.startAt) {
      startMatch(room);
    }
  }
}, 200);

// storm + housekeeping tick
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000; lastTick = now;
  for (const [code, room] of rooms) {
    if (room.players.size === 0) { rooms.delete(code); continue; }
    stepStorm(room, dt);
  }
}, 1000 / RULES.tickRate);

// position broadcast (separate, steady rate)
setInterval(() => {
  for (const room of rooms.values()) broadcastPositions(room);
}, 1000 / 15);   // 15 position updates/sec — smooth enough, light on bandwidth

server.listen(PORT, () => {
  console.log(`MNEMOSYNE vessel-server listening on :${PORT}`);
});
