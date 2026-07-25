/* Boots the server in-process and runs two mock clients through the full flow:
   create room -> join -> countdown -> start -> position -> validated hit -> kill.
   Run: node smoketest.js */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const proc = spawn('node', ['vessel-server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: '8099' },
  stdio: ['ignore', 'pipe', 'pipe']
});
proc.stdout.on('data', d => process.stdout.write('[server] ' + d));
proc.stderr.on('data', d => process.stderr.write('[server-err] ' + d));

const URL = 'ws://localhost:8099';
let pass = 0, fail = 0;
function check(name, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
  cond ? pass++ : fail++;
}

function client() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on('message', d => { try { ws.inbox.push(JSON.parse(d)); } catch {} });
  ws.sendMsg = o => ws.send(JSON.stringify(o));
  return ws;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function last(ws, type) { return [...ws.inbox].reverse().find(m => m.t === type); }

(async () => {
  await wait(600); // let server boot

  const host = client();
  await new Promise(r => host.on('open', r));
  host.sendMsg({ t: 'create', name: 'HOST', faction: 'keepers' });
  await wait(200);
  const joined = last(host, 'joined');
  check('host creates room + gets code', joined && joined.code && joined.host === true);
  const code = joined.code;
  const hostId = joined.youId;

  const guest = client();
  await new Promise(r => guest.on('open', r));
  guest.sendMsg({ t: 'join', code, name: 'GUEST', faction: 'lethe' });
  await wait(200);
  const gj = last(guest, 'joined');
  check('guest joins by code', gj && gj.code === code && gj.host === false);
  const guestId = gj.youId;

  // countdown should fire (2 players >= min)
  await wait(300);
  check('countdown starts with 2 players', !!last(host, 'countdown'));

  // wait for the match to start (5s countdown + slack)
  await wait(5600);
  const start = last(host, 'start');
  check('match starts, spawns delivered', start && Array.isArray(start.spawns) && start.spawns.length === 2);

  // put host and guest right next to each other via position updates
  host.sendMsg({ t: 'pos', x: 100, y: 0, z: 100, yaw: 0, w: 'rifle' });
  guest.sendMsg({ t: 'pos', x: 105, y: 0, z: 100, yaw: 0, w: 'rifle' });
  await wait(200);

  // FIRE-RATE TEST: two rifle shots fired back-to-back (same millisecond-ish).
  // The first should apply, the second should be rejected by the 110ms gate.
  host.inbox.length = 0;
  host.sendMsg({ t: 'hit', targetId: guestId, weapon: 'rifle' });
  host.sendMsg({ t: 'hit', targetId: guestId, weapon: 'rifle' }); // immediate — too fast
  await wait(200);
  const backToBackHits = host.inbox.filter(m => m.t === 'hit').length;
  check('valid hit is applied (server broadcasts hit)', backToBackHits >= 1);
  check('fire-rate gate rejects too-fast second shot', backToBackHits === 1);

  // out-of-range hit should be rejected: move guest far away
  guest.sendMsg({ t: 'pos', x: 2000, y: 0, z: 2000, yaw: 0, w: 'rifle' });
  await wait(200);
  const hitsB2 = host.inbox.filter(m => m.t === 'hit').length;
  await wait(700); // clear rifle cooldown
  host.sendMsg({ t: 'hit', targetId: guestId, weapon: 'rifle' });
  await wait(120);
  const hitsA2 = host.inbox.filter(m => m.t === 'hit').length;
  check('out-of-range hit rejected', hitsA2 === hitsB2);

  // bring guest back and finish them with a sniper (45) x enough shots to kill
  guest.sendMsg({ t: 'pos', x: 100, y: 0, z: 100, yaw: 0, w: 'rifle' });
  await wait(200);
  let gotKill = false;
  for (let i = 0; i < 4; i++) {
    host.sendMsg({ t: 'hit', targetId: guestId, weapon: 'sniper' });
    await wait(1200); // respect sniper fireCd 1.1
    if (last(host, 'kill')) { gotKill = true; break; }
  }
  check('kill is registered after enough damage', gotKill);

  // with guest dead, host should be last standing -> gameover
  await wait(300);
  const go = last(host, 'gameover');
  check('gameover declares winner', go && go.winnerId === hostId);

  console.log(`\n${pass} passed, ${fail} failed`);
  host.close(); guest.close();
  proc.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); proc.kill(); process.exit(1); });
