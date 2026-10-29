'use strict';

process.env.SIM_TICK_MS = '50';
process.env.BROADCAST_MS = '100';

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: connect } = require('socket.io-client');
const { performance } = require('node:perf_hooks');
const { start, server, io, manager, matches } = require('../index');
const { createMatch } = require('../game/sim');
const { RoomManager } = require('../rooms/manager');
const bots = require('../ai/bots');

const ready = start(0).then(() => `http://127.0.0.1:${server.address().port}`);
const sockets = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function client(auth, transport = 'websocket') {
  const sk = connect(await ready, { forceNew: true, transports: [transport], auth, reconnection: false });
  sockets.add(sk);
  return sk;
}
function request(sk, event, payload) {
  return new Promise((resolve, reject) => {
    sk.timeout(3000).emit(event, payload, (error, reply) => error ? reject(error) : resolve(reply));
  });
}
function follow(sk, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sk.off('match:snapshot', receive); reject(new Error('snapshot timeout')); }, 3000);
    function receive(snapshot) {
      if (predicate(snapshot)) { clearTimeout(timer); sk.off('match:snapshot', receive); resolve(snapshot); }
    }
    sk.on('match:snapshot', receive);
  });
}
async function room(transport = 'websocket') {
  const a = await client(undefined, transport), b = await client(undefined, transport);
  const created = await request(a, 'room:create', { name: 'A', config: { maxPlayers: 2, botCount: 0 } });
  const joined = await request(b, 'room:join', { code: created.code, name: 'B' });
  assert.ok(created.ok && joined.ok);
  await request(a, 'lobby:ready', { ready: true });
  await request(b, 'lobby:ready', { ready: true });
  assert.equal((await request(a, 'match:start')).ok, true);
  const entry = matches.get(created.code);
  open(entry.sim);
  Object.assign(entry.sim.byId.get(created.playerId), { x: 168, y: 72 });
  Object.assign(entry.sim.byId.get(joined.playerId), { x: 552, y: 168 });
  return { a, b, created, joined, entry };
}
function open(world) {
  for (let y = 1; y < 12; y++) for (let x = 1; x < 14; x++) world.board[y][x] = 0;
  world.actors.forEach((a, i) => { a.x = i ? 552 : 168; a.y = i ? 168 : 72; a.invuln = 1000; });
}
function cleanup() {
  for (const sk of sockets) sk.close();
  sockets.clear();
  for (const entry of matches.values()) { clearInterval(entry.timer); clearTimeout(entry.cleanupTimer); }
  matches.clear(); manager.rooms.clear();
}
afterEach(cleanup);
after(() => { cleanup(); io.close(); });

function world() {
  const w = createMatch({ arenaSeed: 'sync-regression', participants: [{ id: 'a' }, { id: 'b' }], botCount: 0 });
  open(w);
  return w;
}

test('each actor moves independently, stops independently, and rejects stale input sequences', () => {
  const w = world(), a = w.byId.get('a'), b = w.byId.get('b');
  w.applyIntent('a', { type: 'move', dirX: 1, dirY: 0, seq: 1 });
  w.applyIntent('b', { type: 'move', dirX: -1, dirY: 0, seq: 1 });
  w.update(0.05);
  assert.ok(a.x > 168 && b.x < 552);
  w.applyIntent('a', { type: 'move', dirX: 0, dirY: 0, seq: 2 });
  assert.equal(w.applyIntent('a', { type: 'move', dirX: -1, seq: 1 }).ok, false);
  const x = a.x, bx = b.x;
  w.update(0.05);
  const s = w.snapshot();
  assert.equal(a.x, x); assert.ok(b.x < bx);
  assert.equal(s.actors[0].vx, 0); assert.equal(s.actors[0].dx, 1);
  assert.equal(s.actors[0].inputSeq, 2);
  assert.equal(w.applyIntent('a', { type: 'move', dirX: 1, seq: Infinity }).ok, false);
});

test('airborne bombs do not block movement at their launch cell and become solid on landing', () => {
  const w = world(), a = w.byId.get('a');
  a.tosser = true;
  assert.equal(w.applyIntent('a', { type: 'throw' }).ok, true);
  assert.equal(w.bombAtCell(3, 1), null);
  w.applyIntent('a', { type: 'move', dirX: 1 });
  w.update(0.05);
  assert.ok(a.x > 168, 'throwing must not freeze the owner during flight');
  w.applyIntent('a', { type: 'move', dirX: 0 });
  for (let i = 0; i < 6; i++) w.update(0.05);
  const b = w.bombs[0];
  assert.equal(w.flights.length, 0);
  assert.equal(w.bombAtCell(b.cellX, b.cellY), b);
});

test('departed seats expire without blocking a surviving host from starting', () => {
  let now = 10000;
  const m = new RoomManager({ now: () => now });
  const a = m.create('A', { maxPlayers: 3, botCount: 1 });
  const b = m.join(a.code, 'B');
  m.setReady(a.code, a.playerId, true);
  m.setReady(a.code, b.playerId, true);
  m.markOnline(a.code, b.playerId, false);
  assert.throws(() => m.startMatch(a.code, a.playerId), { code: 'not-ready' });
  now += 30001;
  const started = m.startMatch(a.code, a.playerId);
  assert.equal(started.players[b.playerId], undefined);
  assert.equal(Object.keys(started.match.participants).length, 2);
});

test('wall collision reports zero actual velocity without erasing facing', () => {
  const w = world(), a = w.byId.get('a');
  a.x = 4 * 48 - 48 * 0.36 - 1;
  w.board[1][4] = 1;
  w.applyIntent('a', { type: 'move', dirX: 1 });
  w.update(0.05);
  const state = w.snapshot().actors[0];
  assert.equal(state.vx, 0); assert.equal(state.dx, 1);
});

test('resume restores all destroyed cells without consuming pending shared deltas or events', () => {
  const w = world();
  w.board[1][4] = 2;
  w.applyIntent('a', { type: 'bomb' });
  w.bombs[0].fuse = 0;
  w.update(0.05);
  assert.equal(w.board[1][4], 0);
  const resumed = w.snapshot({ resume: true });
  assert.deepEqual(resumed.destroyed, [[4, 1]]);
  assert.deepEqual(resumed.events, []);
  const shared = w.snapshot();
  assert.deepEqual(shared.destroyed, [[4, 1]]);
  assert.ok(shared.events.some((e) => e.type === 'blast'));
  assert.deepEqual(w.snapshot().destroyed, []);
  assert.deepEqual(w.snapshot({ resume: true }).destroyed, [[4, 1]]);
});

test('unreachable bot paths honor cooldown and topology changes trigger an immediate retry', () => {
  let searches = 0;
  const facade = { tileAt: () => { searches++; return 1; }, bombAtCell: () => null,
    nearestHuman: () => ({ cx: 10, cy: 1, alive: true }), mazeVersion: 0,
    alertRange: 150, rng: () => 0.5 };
  const brain = bots.createBot(0, () => 0.5), self = { x: 72, y: 72, speed: 96 };
  for (let i = 0; i < 20; i++) bots.step(brain, self, facade, 0.05);
  assert.equal(searches, 2, 'one second must not run twenty failed searches');
  facade.mazeVersion++;
  bots.step(brain, self, facade, 0.05);
  assert.equal(searches, 3);
});

test('configuration cannot overfill an existing room, and lobby resumes survive the grace window', () => {
  let now = 10000;
  const m = new RoomManager({ now: () => now });
  const a = m.create('A', { maxPlayers: 8, botCount: 0 });
  for (let i = 0; i < 7; i++) m.join(a.code, 'Guest');
  assert.throws(() => m.configure(a.code, a.playerId, { botCount: 7 }), { code: 'full' });
  assert.equal(m.get(a.code).config.botCount, 0);
  for (const id of Object.keys(m.get(a.code).players)) m.markOnline(a.code, id, false);
  assert.deepEqual(m.sweep(), []);
  now += 30001;
  assert.deepEqual(m.sweep(), [a.code]);
});

for (const transport of ['websocket', 'polling']) {
  test(`${transport}: opposite simultaneous movement, bombs and explosions stay room-scoped`, async () => {
    const first = await room(transport), second = await room(transport);
    const aId = first.created.playerId, bId = first.joined.playerId;
    first.a.emit('game:input', { type: 'move', dirX: 1, dirY: 0, seq: 1 });
    first.b.emit('game:input', { type: 'move', dirX: -1, dirY: 0, seq: 1, playerId: aId });
    const moved = await follow(first.b, (s) => s.actors.find((a) => a.id === aId).x > 172 && s.actors.find((a) => a.id === bId).x < 548);
    assert.ok(moved.actors.every((a) => [aId, bId].includes(a.id)));
    assert.equal(second.entry.sim.byId.get(second.created.playerId).x, 168);
    assert.equal((await request(first.a, 'game:action', { type: 'bomb' })).ok, true);
    assert.equal((await request(first.b, 'game:action', { type: 'bomb' })).ok, true);
    const armed = await follow(first.b, (s) => s.bombs.length === 2);
    assert.ok(armed.bombs.every((b) => [aId, bId].includes(b.owner)));
    first.entry.sim.bombs.forEach((b) => { b.fuse = 0; });
    const blasted = await follow(first.a, (s) => s.flames.length > 0);
    assert.ok(blasted.actors.find((a) => a.id === aId).x > moved.actors.find((a) => a.id === aId).x);
    const isolated = await follow(second.a, () => true);
    assert.equal(isolated.bombs.length, 0); assert.equal(isolated.flames.length, 0);
    assert.equal((await request(first.b, 'match:return')).code, 'not-host');
    assert.equal(matches.get(first.created.code), first.entry, 'unauthorized return must not stop simulation');
    const before = first.entry.sim.t;
    await follow(first.a, (s) => s.t > before * 1000);
  });
}

test('a superseded socket cannot control or disconnect the replacement seat', async () => {
  const r = await room();
  const credentials = { code: r.created.code, playerId: r.joined.playerId, token: r.joined.token };
  const back = await client(credentials);
  const [resumed] = await once(back, 'room:resumed');
  assert.equal(resumed.ok, true);
  await pause(20);
  const seat = manager.get(r.created.code).players[r.joined.playerId];
  assert.equal(seat.online, true); assert.equal(seat.socketId, back.id);
  const before = r.entry.sim.byId.get(r.joined.playerId).x;
  back.emit('game:input', { type: 'move', dirX: -1, seq: 1 });
  await follow(back, (s) => s.actors.find((a) => a.id === r.joined.playerId).x < before);
  r.b.close();
  assert.equal(seat.online, true);
  assert.equal(r.entry.forfeitAt[r.joined.playerId], undefined);
});

test('all-client disconnect keeps the world for resume and neutralizes retained movement', async () => {
  const r = await room();
  r.a.emit('game:input', { type: 'move', dirX: 1, seq: 1 });
  await follow(r.a, (s) => s.actors.find((a) => a.id === r.created.playerId).inputSeq === 1);
  r.a.close(); r.b.close();
  await pause(80);
  assert.equal(matches.get(r.created.code), r.entry);
  assert.equal(r.entry.sim.byId.get(r.created.playerId).intent.x, 0);
  const back = await client({ code: r.created.code, playerId: r.created.playerId, token: r.created.token });
  const [resumed] = await once(back, 'room:resumed');
  assert.equal(resumed.ok, true); assert.equal(resumed.inMatch, true);
  assert.equal(resumed.snapshot.actors.length, 2);
  back.emit('game:input', { type: 'move', dirX: 1, seq: 2 });
  await follow(back, (s) => s.actors.find((a) => a.id === r.created.playerId).inputSeq === 2);
});

test('stale inputs expire and a refreshed unchanged direction restores movement', async () => {
  const r = await room(), id = r.created.playerId;
  r.a.emit('game:input', { type: 'move', dirX: 1, seq: 1 });
  await follow(r.a, (s) => s.actors.find((a) => a.id === id).inputSeq === 1);
  r.entry.lastInputAt[id] = performance.now() - 1001;
  await follow(r.a, (s) => s.actors.find((a) => a.id === id).vx === 0);
  assert.equal(r.entry.sim.byId.get(id).intent.x, 0);
  r.a.emit('game:input', { type: 'move', dirX: 1, seq: 2 });
  await follow(r.a, (s) => s.actors.find((a) => a.id === id).vx > 0);
});

test('finished worlds stop ticking, and rematch cancels the old round cleanup timer', async () => {
  const r = await room();
  r.entry.sim.forfeit(r.joined.playerId);
  await follow(r.a, (s) => s.ended);
  const cleanupTimer = r.entry.cleanupTimer;
  assert.ok(cleanupTimer);
  assert.equal(r.entry.timer._destroyed, true);
  const started = await request(r.a, 'match:start');
  assert.equal(started.ok, true);
  assert.equal(cleanupTimer._destroyed, true);
  assert.notEqual(matches.get(r.created.code), r.entry);
  const next = await follow(r.a, (s) => !s.ended);
  assert.equal(next.actors.length, 2);
});
