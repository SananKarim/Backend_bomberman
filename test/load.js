'use strict';

const { io: connect } = require('socket.io-client');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { start, server, io, manager, matches } = require('../index');
const assert = require('node:assert/strict');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => values.length ? +values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * p)].toFixed(3) : 0;
const statistics = (values) => ({ samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) });
const sockets = [], rooms = [];

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}
async function setup(origin) {
  const clients = [];
  let created;
  for (let i = 0; i < 8; i++) {
    const socket = connect(origin, { forceNew: true, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await once(socket, 'connect');
    const seat = await request(socket, i ? 'room:join' : 'room:create', i
      ? { code: created.code, name: `P${i}` }
      : { name: 'P0', config: { maxPlayers: 8, botCount: 0 } });
    assert.equal(seat.ok, true);
    if (!i) created = seat;
    clients.push({ socket, id: seat.playerId, seq: 0, sentAt: new Map() });
    assert.equal((await request(socket, 'lobby:ready', { ready: true })).ok, true);
  }
  assert.equal((await request(clients[0].socket, 'match:start')).ok, true);
  const entry = matches.get(created.code), world = entry.sim;
  for (let y = 1; y < 12; y++) for (let x = 1; x < 14; x++) world.board[y][x] = 0;
  clients.forEach((client, i) => Object.assign(world.byId.get(client.id), {
    x: 168 + i % 2 * 384, y: 72 + Math.floor(i / 2) * 96, invuln: 1000,
  }));
  const room = { code: created.code, clients, entry };
  rooms.push(room);
  return room;
}
function cleanup() {
  sockets.splice(0).forEach((socket) => socket.close());
  for (const entry of matches.values()) { clearInterval(entry.timer); clearTimeout(entry.cleanupTimer); }
  matches.clear(); manager.rooms.clear(); rooms.length = 0;
}

async function measure(origin, count) {
  for (let i = 0; i < count; i++) await setup(origin);
  const ticks = [], sizes = [], builds = [], serializations = [], inputLatency = [], delivery = [], intervals = [];
  const published = new Map();
  let snapshots = 0, inputEvents = 0;
  for (const room of rooms) {
    const world = room.entry.sim, update = world.update, snapshot = world.snapshot;
    world.update = (dt) => { const from = performance.now(); update(dt); ticks.push(performance.now() - from); };
    world.snapshot = (...args) => {
      const from = performance.now(), value = snapshot(...args);
      builds.push(performance.now() - from);
      const serialize = performance.now();
      sizes.push(Buffer.byteLength(JSON.stringify(value)));
      serializations.push(performance.now() - serialize);
      published.set(`${room.code}:${value.seq}`, performance.now());
      if (published.size > count * 64) published.delete(published.keys().next().value);
      return value;
    };
    room.clients.forEach((client, index) => {
      let previous;
      client.socket.on('match:snapshot', (value) => {
        const now = performance.now(), actor = value.actors.find((a) => a.id === client.id);
        assert.ok(actor && value.actors.length === 8);
        assert.ok(value.actors.every((a) => world.byId.has(a.id)), 'room isolation');
        if (!index) {
          snapshots++;
          if (previous !== undefined) intervals.push(now - previous);
          previous = now;
          const at = published.get(`${room.code}:${value.seq}`);
          if (at !== undefined) delivery.push(now - at);
        }
        const sent = client.sentAt.get(actor.inputSeq);
        if (sent !== undefined) {
          inputLatency.push(now - sent);
          for (const seq of client.sentAt.keys()) if (seq <= actor.inputSeq) client.sentAt.delete(seq);
        }
      });
    });
  }
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const cpu = process.cpuUsage(), began = performance.now(), heap = process.memoryUsage().heapUsed;
  let peakHeap = heap, direction = 1;
  const input = setInterval(() => {
    direction *= -1;
    for (const room of rooms) room.clients.forEach((client, i) => {
      const seq = ++client.seq;
      client.sentAt.set(seq, performance.now());
      client.socket.volatile.emit('game:input', { type: 'move', dirX: (i % 2 ? -1 : 1) * direction, dirY: 0, seq });
      inputEvents++;
    });
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 250);
  try {
    await sleep(500);
    for (const room of rooms) assert.equal((await request(room.clients[0].socket, 'game:action', { type: 'bomb' })).ok, true);
    await sleep(3500);
  } finally { clearInterval(input); }
  delay.disable();
  const elapsed = performance.now() - began, used = process.cpuUsage(cpu);
  const result = {
    rooms: count, humansPerRoom: 8, elapsedMs: +elapsed.toFixed(1),
    tickMsPerRoom: statistics(ticks), snapshotBuildMs: statistics(builds), stringifyMs: statistics(serializations),
    snapshotBytes: statistics(sizes), snapshotsHzPerRoom: +(snapshots / count / (elapsed / 1000)).toFixed(2),
    receivedSnapshotIntervalMs: statistics(intervals), inputEvents,
    inputToAcknowledgingSnapshotMs: statistics(inputLatency), snapshotDeliveryMs: statistics(delivery),
    eventLoopDelayMs: { p95: +(delay.percentile(95) / 1e6).toFixed(3), max: +(delay.max / 1e6).toFixed(3) },
    cpuPercentOneCore: +((used.user + used.system) / (elapsed * 1000) * 100).toFixed(2),
    heapMiB: { start: +(heap / 1048576).toFixed(2), peak: +(peakHeap / 1048576).toFixed(2), end: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) },
  };
  cleanup();
  console.log(JSON.stringify(result));
}

(async () => {
  await start(0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log('Local loopback load only; synthetic open arena, invulnerability holds all eight humans active; no production latency claims.');
  for (const count of [1, 4, 8]) await measure(origin, count);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { cleanup(); io.close(); });
