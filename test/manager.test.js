'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RoomManager, RoomError } = require('../rooms/manager');

function fresh(overrides = {}) {
  let now = 1000;
  const seq = overrides.seq || [0, 1 / 32, 2 / 32, 3 / 32, 4 / 32, 5 / 32, 6 / 32, 7 / 32];
  let k = 0;
  const mgr = new RoomManager({ now: () => now, rng: () => seq[k++ % seq.length] });
  return { mgr, advance: (ms) => { now += ms; }, now: () => now };
}

test('create assigns a valid unique code, host id and token', () => {
  const { mgr } = fresh();
  const a = mgr.create('ALICE', { maxPlayers: 4, botCount: 2 });
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(a.playerId && a.token);
  assert.equal(a.room.hostUid, a.playerId);
  assert.equal(a.room.players[a.playerId].name, 'ALICE');
  assert.equal(a.room.config.botCount, 2);
  const b = mgr.create('BOB', {});
  assert.notEqual(b.code, a.code);
});

test('busy code space surfaces as a retryable error', () => {
  const { mgr } = fresh({ seq: [0] });           // rng always yields 'AAAA'
  mgr.create('H', {});
  assert.throws(() => mgr.create('H2', {}), (e) => e instanceof RoomError && e.code === 'busy');
});

test('join is case-insensitive, validates the code and never creates rooms', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', { maxPlayers: 4, botCount: 0 });
  assert.throws(() => mgr.join('nope', 'X'), (e) => e.code === 'invalid-code');
  assert.throws(() => mgr.join('ZZZZ', 'X'), (e) => e.code === 'not-found');
  assert.equal(mgr.rooms.size, 1);
  const j = mgr.join(a.code.toLowerCase(), 'xena');
  assert.equal(mgr.rooms.size, 1);
  assert.ok(j.room.players[j.playerId]);
});

test('capacity is enforced server-side; bots reserve slots too', () => {
  const { mgr } = fresh({ seq: [0, 1 / 32, 2 / 32, 3 / 32, 4 / 32, 5 / 32, 6 / 32, 7 / 32] });
  const a = mgr.create('H', { maxPlayers: 3, botCount: 2 });   // human cap = 1
  assert.throws(() => mgr.join(a.code, 'second'), (e) => e.code === 'failed-precondition' || /full/i.test(e.message));
  const b = mgr.create('H2', { maxPlayers: 3, botCount: 0 });  // human cap = 3
  mgr.join(b.code, 'p2');
  mgr.join(b.code, 'p3');
  assert.throws(() => mgr.join(b.code, 'p4'), /full/i);
});

test('duplicate membership is impossible by construction (fresh ids)', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', {});
  const j1 = mgr.join(a.code, 'G');
  const j2 = mgr.join(a.code, 'G');
  assert.notEqual(j1.playerId, j2.playerId);
  assert.equal(Object.keys(mgr.get(a.code).players).length, 3);
});

test('leaving host transfers to the earliest joiner; last leave deletes', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', { botCount: 0, maxPlayers: 4 });
  const g = mgr.join(a.code, 'G');
  mgr.leave(a.code, a.playerId);
  assert.equal(mgr.get(a.code).hostUid, g.playerId);
  mgr.leave(a.code, g.playerId);
  assert.equal(mgr.get(a.code), null);
});

test('resume requires the exact issued token', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', {});
  assert.throws(() => mgr.resume(a.code, a.playerId, 'stolen'), (e) => e.code === 'unauthorized');
  assert.throws(() => mgr.resume(a.code, 'other-player', a.token), (e) => e.code === 'unauthorized');
  const ok = mgr.resume(a.code, a.playerId, a.token);
  assert.equal(ok.player.uid, a.playerId);
});

test('startMatch: host-only, ready-gated, fills bot slots', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', { botCount: 2, maxPlayers: 4 });
  const g = mgr.join(a.code, 'G');
  assert.throws(() => mgr.startMatch(a.code, g.playerId), /host/i);
  assert.throws(() => mgr.startMatch(a.code, a.playerId), /ready/i);
  mgr.setReady(a.code, a.playerId, true);
  mgr.setReady(a.code, g.playerId, true);
  const room = mgr.startMatch(a.code, a.playerId);
  assert.equal(room.status, 'match');
  const parts = Object.values(room.match.participants);
  assert.equal(parts.length, 4);                        // 2 humans + 2 bots
  assert.ok(parts.every((p) => p.alive));
  assert.ok(parts.filter((p) => p.kind === 'bot').every((p) => p.owner === a.playerId));
});

test('sweep removes abandoned rooms only after the grace windows', () => {
  let clock = 1000;
  const seq = [0, 1 / 32, 2 / 32, 3 / 32];
  let k = 0;
  const mgr = new RoomManager({ now: () => clock, rng: () => seq[k++ % seq.length] });
  const a = mgr.create('H', {});
  clock += 10;
  assert.deepEqual(mgr.sweep(), []);
  mgr.markOnline(a.code, a.playerId, false);
  clock += 60000;
  assert.deepEqual(mgr.sweep(), [a.code]);              // everyone offline
  assert.equal(mgr.rooms.size, 0);
});

test('publicRoom strips tokens and sockets', () => {
  const { mgr } = fresh();
  const a = mgr.create('H', {});
  const pub = mgr.publicRoom(a.code);
  const p = pub.players[a.playerId];
  assert.deepEqual(Object.keys(p).sort(), ['color', 'joinedAt', 'name', 'online', 'ready', 'uid']);
});
