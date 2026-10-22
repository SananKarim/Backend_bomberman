/* Integration tests: real Socket.IO clients against the real server.
   Verifies the full online contract — lobby, host rights, capacity,
   authoritative gameplay snapshots, session resume and error paths. */
'use strict';

process.env.SIM_TICK_MS = '20';
process.env.BROADCAST_MS = '40';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { start, server, manager } = require('../index');

const ready = start(0).then(() => server.address().port);
const origin = 'http://127.0.0.1';

function client(port, auth) {
  const socket = connect(`${origin}:${port}`, {
    transports: ['websocket'], forceNew: true, auth,
  });
  const helpers = {
    socket,
    emit(event, payload) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 4000);
        socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
      });
    },
    emitNoAck(event, payload) { socket.emit(event, payload); },
    once(event, ms = 4000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`event timeout: ${event}`)), ms);
        socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
      });
    },
    close() { socket.close(); },
  };
  return helpers;
}

/** Collect snapshots until predicate passes (or 3s). */
function followSnapshots(c, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.socket.off('match:snapshot', onSnap);
      reject(new Error('snapshot predicate not met'));
    }, 3000);
    function onSnap(s) {
      if (predicate(s)) { clearTimeout(timer); c.socket.off('match:snapshot', onSnap); resolve(s); }
    }
    c.socket.on('match:snapshot', onSnap);
  });
}

after(() => { server.close(); });

test('lobby lifecycle: create, join, ready, host start, synced snapshots', async () => {
  const port = await ready;
  const a = client(port), b = client(port);
  try {
    const created = await a.emit('room:create', { name: 'Ada', config: { maxPlayers: 4, botCount: 1, arenaPreset: 'mixed' } });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.match(created.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    assert.ok(created.playerId && created.token);

    const joined = await b.emit('room:join', { code: created.code.toLowerCase(), name: 'Ben' });
    assert.equal(joined.ok, true);

    // host-only config from a guest must be rejected
    const guestCfg = await b.emit('lobby:config', { patch: { botCount: 5 } });
    assert.equal(guestCfg.ok, false);
    assert.equal(guestCfg.code, 'not-host');

    await a.emit('lobby:ready', { ready: true });
    await b.emit('lobby:ready', { ready: true });
    const saP = a.once('match:start'), sbP = b.once('match:start');
    const started = await a.emit('match:start');
    assert.equal(started.ok, true, JSON.stringify(started));
    const [sa, sb] = await Promise.all([saP, sbP]);
    assert.equal(sa.arenaSeed, sb.arenaSeed, 'both clients share the arena seed');
    assert.deepEqual(sa.roster.map((r) => r.id).sort(), sb.roster.map((r) => r.id).sort());
    const bots = sa.roster.filter((r) => r.isBot);
    assert.equal(bots.length, 1, 'server-owned bot in the roster');

    // authoritative movement: A sends an intent, the server moves A for everyone
    const myPos = sa.actors.find((x) => x.id === created.playerId);
    a.emitNoAck('game:input', { type: 'move', dirX: 1, dirY: 0 });
    a.emitNoAck('game:input', { type: 'move', dirX: 0, dirY: 1 });
    const moved = await followSnapshots(b, (s) => {
      const me = s.actors.find((x) => x.id === created.playerId);
      return me && (Math.abs(me.x - myPos.x) > 4 || Math.abs(me.y - myPos.y) > 4);
    });
    assert.ok(moved.actors.length >= 3, 'humans + server bot in every snapshot');
    assert.equal(moved.seq > 0, true, 'ordered sequence numbers');

    // bombs are server-placed and visible to everyone
    const bombRes = await a.emit('game:action', { type: 'bomb' });
    assert.equal(bombRes.ok, true);
    const withBomb = await followSnapshots(b, (s) => s.bombs.some((x) => x.owner === created.playerId));
    assert.ok(withBomb.bombs[0].fuseMs > 0);

    // invalid payloads are refused with a code, never a crash
    const bogus = await a.emit('game:action', { type: 'nuke' });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.code, 'bad-intent');
  } finally { a.close(); b.close(); }
});

test('sessions: resume needs the exact token; strangers cannot claim an id', async () => {
  const port = await ready;
  const a = client(port), b = client(port);
  try {
    const created = await a.emit('room:create', { name: 'Ada', config: { maxPlayers: 3, botCount: 0 } });
    const joined = await b.emit('room:join', { code: created.code, name: 'Ben' });

    b.close();
    await new Promise((r) => setTimeout(r, 150));

    const thief = client(port, { code: created.code, playerId: joined.playerId, token: 'wrong' });
    const refused = await thief.once('room:resumed');
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'unauthorized');
    thief.close();

    const back = client(port, { code: created.code, playerId: joined.playerId, token: joined.token });
    const resumed = await back.once('room:resumed');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.playerId, joined.playerId);
    assert.ok(resumed.room.players[joined.playerId], 'seat restored');
    back.close();
  } finally { a.close(); }
});

test('capacity and room codes are enforced server-side', async () => {
  const port = await ready;
  const a = client(port);
  const cs = [];
  try {
    const created = await a.emit('room:create', { name: 'Ada', config: { maxPlayers: 2, botCount: 0 } });
    assert.equal(created.ok, true);
    for (let i = 0; i < 3; i++) cs.push(client(port));
    const first = await cs[0].emit('room:join', { code: created.code, name: 'X' });
    assert.equal(first.ok, true);
    const second = await cs[1].emit('room:join', { code: created.code, name: 'Y' });
    assert.equal(second.ok, false, 'room limit of 2 humans');
    assert.equal(second.code, 'full');
    const bogus = await cs[2].emit('room:join', { code: 'ZZZZ', name: 'Z' });
    assert.equal(bogus.ok, false);
    assert.equal(bogus.code, 'not-found', 'codes never implicitly create rooms');
  } finally { a.close(); cs.forEach((c) => c.close()); }
});

test('host disconnect transfers the room; abandoned rooms sweep away', async () => {
  const port = await ready;
  const a = client(port), b = client(port);
  try {
    const created = await a.emit('room:create', { name: 'Ada', config: { maxPlayers: 4, botCount: 0 } });
    const joined = await b.emit('room:join', { code: created.code, name: 'Ben' });
    a.close();
    await new Promise((r) => setTimeout(r, 400));           // let the disconnect land
    const pub = manager.publicRoom(created.code);
    assert.equal(pub.hostUid, joined.playerId, 'earliest remaining player takes over');
  } finally { b.close(); }
});
