/* NEON BOMBER multiplayer server — Express + Socket.IO.

   Lifecycle: every socket gets a server-assigned identity only through
   room:create / room:join / room:resume (token-validated). Clients send
   INTENTS (move/bomb/throw); the server simulation answers with ordered
   snapshots. Nothing about positions, damage or victory is client-writable.

   Env: PORT, ALLOWED_ORIGINS (comma list or *), SERVE_PUBLIC=1 (dev static),
   SIM_TICK_MS, BROADCAST_MS. */
'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager, RoomError } = require('./rooms/manager');
const { sanitizeName } = require('./lib/validate');
const sim = require('./game/sim');

const PORT = Number(process.env.PORT) || 3000;
const SIM_TICK_MS = Math.max(20, Number(process.env.SIM_TICK_MS) || 50);
const BROADCAST_MS = Math.max(SIM_TICK_MS, Number(process.env.BROADCAST_MS) || 100);
const FORFEIT_GRACE_MS = 30000;              // offline in-match before the server kills you
const SWEEP_MS = 60000;
const MAX_PAYLOAD = 2048;                    // our messages are tiny; reject bloat

const originList = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigin = originList.includes('*') || originList.length === 0
  ? true : originList;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 10000,
  pingTimeout: 20000,
});

const manager = new RoomManager();
const matches = new Map();        // code → { sim, timer, counter, forfeitAt }
const startedAt = Date.now();

if (process.env.SERVE_PUBLIC === '1') {
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
}
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: manager.rooms.size, matches: matches.size,
             uptimeS: Math.round((Date.now() - startedAt) / 1000) });
});

/* ---------- small guards ---------- */

const ioRoom = (code) => `r:${code}`;
const fail = (cb, code, message) => { if (cb) cb({ ok: false, code, error: message }); };
const done = (cb, payload) => { if (cb) cb({ ok: true, ...payload }); };

/** Per-socket token buckets: cheap abuse control, not gameplay rules. */
function rateOk(socket, bucket, perSecond) {
  const b = (socket.data.buckets ||= {});
  const t = (b[bucket] ||= { n: 0, from: Date.now() });
  const now = Date.now();
  if (now - t.from > 1000) { t.from = now; t.n = 0; }
  t.n++;
  return t.n <= perSecond;
}

function badPayload(p) {
  return !p || typeof p !== 'object' || JSON.stringify(p).length > MAX_PAYLOAD;
}

function pushRoom(code) {
  const pub = manager.publicRoom(code);
  if (pub) io.to(ioRoom(code)).emit('room:update', pub);
}

function stopMatch(code, { silent = false } = {}) {
  const entry = matches.get(code);
  if (!entry) return;
  clearInterval(entry.timer);
  matches.delete(code);
  if (!silent) {
    const s = entry.sim.snapshot();          // flush remaining deltas once
    io.to(ioRoom(code)).emit('match:snapshot', s);
  }
}

function startMatchBroadcast(code, room) {
  const humans = Object.values(room.match.participants)
    .filter((p) => p.kind === 'human')
    .map((p) => ({ id: p.id, name: p.name, color: p.color }));
  const world = sim.createMatch({
    arenaSeed: room.match.seed,
    preset: room.match.preset,
    participants: humans,
    botCount: Object.values(room.match.participants).filter((p) => p.kind === 'bot').length,
  });
  const entry = {
    sim: world,
    counter: 0,
    forfeitAt: {},
    broadcastEvery: Math.max(1, Math.round(BROADCAST_MS / SIM_TICK_MS)),
    timer: null,
  };
  matches.set(code, entry);
  io.to(ioRoom(code)).emit('match:start', world.startPayload());

  const dt = SIM_TICK_MS / 1000;
  entry.timer = setInterval(() => {
    try {
      if (!world.ended) {
        const now = Date.now();
        for (const [pid, until] of Object.entries(entry.forfeitAt)) {
          if (now >= until) { world.forfeit(pid); delete entry.forfeitAt[pid]; }
        }
        world.update(dt);
      }
      if (++entry.counter >= entry.broadcastEvery) {
        entry.counter = 0;
        const s = world.snapshot();
        // Socket.IO buffers per socket, so one congested client cannot
        // stall the rest of the room; everyone gets the same ordered seq.
        io.to(ioRoom(code)).emit('match:snapshot', s);
        if (world.ended && !entry.closed) {
          entry.closed = true;
          const room2 = manager.get(code);
          if (room2) {
            room2.status = 'ended';
            room2.match.ended = true;
            room2.match.winnerId = world.winnerId;
            room2.updatedAt = Date.now();
            pushRoom(code);
          }
          setTimeout(() => stopMatch(code), 60000);   // late-ack grace, then teardown
        }
      }
    } catch (e) {
      console.error(`tick error in room ${code}:`, e && e.message);
    }
  }, SIM_TICK_MS);
}

/* ---------- socket handling ---------- */

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.playerId = null;

  const me = () => {
    if (!socket.data.code || !socket.data.playerId) return null;
    const found = manager.findPlayer(socket.data.playerId);
    if (!found || found.code !== socket.data.code) return null;
    return { code: found.code, playerId: socket.data.playerId, room: found.room, player: found.player };
  };

  /* auto-reconnect: credentials ride the handshake, never a guessed id */
  const auth = socket.handshake.auth || {};
  if (auth.code && auth.playerId && auth.token) {
    try {
      const { room, player } = manager.resume(auth.code, auth.playerId, auth.token);
      socket.data.code = auth.code;
      socket.data.playerId = auth.playerId;
      manager.setSocket(auth.code, auth.playerId, socket.id);
      void socket.join(ioRoom(auth.code));
      const entry = matches.get(auth.code);
      if (entry) delete entry.forfeitAt[auth.playerId];
      socket.emit('room:resumed', {
        ok: true,
        room: manager.publicRoomObj(room),
        playerId: auth.playerId,
        inMatch: room.status === 'match' || room.status === 'ended',
        snapshot: entry ? entry.sim.snapshot() : null,
        matchStart: entry ? entry.sim.startPayload() : null,
      });
      pushRoom(auth.code);
    } catch (e) {
      socket.emit('room:resumed', { ok: false, code: e.code || 'resume-failed', error: e.message });
    }
  }

  socket.on('room:create', (payload, cb) => {
    if (!rateOk(socket, 'room', 2)) return fail(cb, 'rate-limit', 'Slow down');
    if (badPayload(payload)) return fail(cb, 'bad-payload', 'Malformed request');
    if (me()) return fail(cb, 'already-in', 'Leave your current room first');
    try {
      const { code, room, playerId, token } =
        manager.create(sanitizeName(payload && payload.name), payload && payload.config);
      socket.data.code = code; socket.data.playerId = playerId;
      manager.setSocket(code, playerId, socket.id);
      void socket.join(ioRoom(code));
      done(cb, { code, playerId, token, room: manager.publicRoomObj(room) });
    } catch (e) { fail(cb, e.code || 'create-failed', e.message); }
  });

  socket.on('room:join', (payload, cb) => {
    if (!rateOk(socket, 'room', 5)) return fail(cb, 'rate-limit', 'Slow down');
    if (badPayload(payload)) return fail(cb, 'bad-payload', 'Malformed request');
    if (me()) return fail(cb, 'already-in', 'Leave your current room first');
    try {
      const { code, room, playerId, token } =
        manager.join(payload && payload.code, payload && payload.name);
      socket.data.code = code; socket.data.playerId = playerId;
      manager.setSocket(code, playerId, socket.id);
      void socket.join(ioRoom(code));
      done(cb, { code, playerId, token, room: manager.publicRoomObj(room) });
      pushRoom(code);
    } catch (e) { fail(cb, e.code || 'join-failed', e.message); }
  });

  // no-payload events still arrive as (payload, cb) because some clients
  // send a placeholder argument — always take the trailing function.
  const ackOf = (args) => (typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null);

  socket.on('room:leave', (...args) => {
    const cb = ackOf(args);
    const found = me();
    if (!found) return fail(cb, 'not-in', 'You are not in a room');
    const { code } = found;
    const entry = matches.get(code);
    if (entry) entry.sim.forfeit(found.playerId);
    manager.leave(code, found.playerId);
    socket.leave(ioRoom(code));
    socket.data.code = null; socket.data.playerId = null;
    if (!manager.get(code)) stopMatch(code, { silent: true }); else pushRoom(code);
    done(cb);
  });

  socket.on('lobby:ready', (payload, cb) => {
    const found = me();
    if (!found) return fail(cb, 'not-in', 'You are not in a room');
    if (badPayload(payload)) return fail(cb, 'bad-payload', 'Malformed request');
    try {
      manager.setReady(found.code, found.playerId, payload && payload.ready);
      done(cb); pushRoom(found.code);
    } catch (e) { fail(cb, e.code || 'ready-failed', e.message); }
  });

  socket.on('lobby:config', (payload, cb) => {
    const found = me();
    if (!found) return fail(cb, 'not-in', 'You are not in a room');
    if (badPayload(payload)) return fail(cb, 'bad-payload', 'Malformed request');
    try {
      manager.configure(found.code, found.playerId, (payload && payload.patch) || {});
      done(cb); pushRoom(found.code);
    } catch (e) { fail(cb, e.code || 'config-failed', e.message); }
  });

  socket.on('match:start', (...args) => {
    const cb = ackOf(args);
    const found = me();
    if (!found) return fail(cb, 'not-in', 'You are not in a room');
    try {
      const room = manager.startMatch(found.code, found.playerId);
      pushRoom(found.code);
      startMatchBroadcast(found.code, room);
      done(cb);
    } catch (e) { fail(cb, e.code || 'start-failed', e.message); }
  });

  socket.on('match:return', (...args) => {
    const cb = ackOf(args);
    const found = me();
    if (!found) return fail(cb, 'not-in', 'You are not in a room');
    try {
      stopMatch(found.code);
      manager.returnToLobby(found.code, found.playerId);
      done(cb); pushRoom(found.code);
    } catch (e) { fail(cb, e.code || 'return-failed', e.message); }
  });

  /* gameplay: intents only — validated, rate-limited, never authoritative */
  socket.on('game:input', (payload) => {
    const found = me();
    const entry = found && matches.get(found.code);
    if (!entry || entry.sim.ended) return;
    if (!rateOk(socket, 'input', 30)) return;
    if (badPayload(payload) || payload.type !== 'move') return;
    entry.sim.applyIntent(found.playerId, {
      type: 'move', dirX: payload.dirX, dirY: payload.dirY,
    });
  });

  socket.on('game:action', (payload, cb) => {
    const found = me();
    const entry = found && matches.get(found.code);
    if (!entry) return fail(cb, 'not-in-match', 'No active match for you');
    if (entry.sim.ended) return fail(cb, 'ended', 'The match is over');
    if (!rateOk(socket, 'action', 10)) return fail(cb, 'rate-limit', 'Slow down');
    if (badPayload(payload)) return fail(cb, 'bad-payload', 'Malformed request');
    const type = payload.type === 'throw' ? 'throw' : payload.type === 'bomb' ? 'bomb' : null;
    if (!type) return fail(cb, 'bad-intent', 'Unknown action');
    const res = entry.sim.applyIntent(found.playerId, { type });
    if (res.ok) done(cb); else fail(cb, res.code, 'The server rejected that action');
  });

  socket.on('disconnect', () => {
    const found = me();
    if (!found) return;
    const { code, playerId } = found;
    const room = manager.get(code);
    if (!room) return;
    manager.markOnline(code, playerId, false);
    if (room.hostUid === playerId) {
      const heir = Object.values(room.players)
        .filter((p) => p.uid !== playerId)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (heir) room.hostUid = heir.uid;         // host transfer on disconnect
    }
    const entry = matches.get(code);
    if (entry && room.status === 'match') entry.forfeitAt[playerId] = Date.now() + FORFEIT_GRACE_MS;
    if (Object.values(room.players).every((p) => !p.online)) stopMatch(code, { silent: true });
    pushRoom(code);
  });
});

const sweeper = setInterval(() => {
  for (const code of manager.sweep()) stopMatch(code, { silent: true });
}, SWEEP_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`neon-bomber multiplayer server on 0.0.0.0:${port} (tick ${SIM_TICK_MS}ms, broadcast ${BROADCAST_MS}ms)`);
      resolve(server);
    });
  });
}

if (require.main === module) void start();

module.exports = { app, server, io, manager, matches, start };
