/* Room lifecycle state machine — pure functions over plain objects.
   The Cloud Functions layer feeds these from the Realtime Database and
   writes results back with Admin privileges; nothing here touches Firebase,
   which is what makes the rules testable in isolation.

   Room shape:
   {
     code, status: 'lobby' | 'match' | 'ended',
     hostUid, createdAt, updatedAt,
     config: { maxPlayers, botCount, arenaPreset },
     players: { [uid]: { uid, name, color, ready, online, joinedAt, lastSeen } },
     match: null | { seed, startedAt, participants: {...} }
   }
*/
'use strict';

const { sanitizeName, sanitizeConfig, ROOM_LIMIT_MAX, MIN_PLAYERS, COLORS } = require('./validate');

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function humanPlayers(room) {
  return Object.values(room.players || {});
}

function humanCapacity(room) {
  // Bots occupy combat slots too: humans + bots never exceed the safe limit.
  return Math.max(0, Math.min(room.config.maxPlayers, ROOM_LIMIT_MAX) - room.config.botCount);
}

function createRoom({ code, hostUid, name, config, now }) {
  if (!code || !hostUid) throw new RoomError('invalid', 'code and hostUid required');
  return {
    code,
    status: 'lobby',
    hostUid,
    createdAt: now,
    updatedAt: now,
    config: sanitizeConfig(config),
    players: {},
    match: null,
  };
}

function joinRoom(room, { uid, name, now }) {
  if (!room) throw new RoomError('no-room', 'Room does not exist');
  if (room.status !== 'lobby') throw new RoomError('closed', 'Room is not accepting players');
  if (room.players[uid]) throw new RoomError('duplicate', 'Already in this room');
  if (humanPlayers(room).length >= humanCapacity(room)) throw new RoomError('full', 'Room is full');

  const used = new Set(humanPlayers(room).map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const player = {
    uid, name: sanitizeName(name), color,
    ready: false, online: true, joinedAt: now, lastSeen: now,
  };
  return {
    ...room,
    players: { ...room.players, [uid]: player },
    updatedAt: now,
  };
}

function leaveRoom(room, { uid, now }) {
  if (!room.players[uid]) return room;
  const players = { ...room.players };
  delete players[uid];
  let next = { ...room, players, updatedAt: now };
  if (room.hostUid === uid) {
    const remaining = Object.values(players).sort((a, b) => a.joinedAt - b.joinedAt);
    if (remaining.length === 0) {
      next.status = 'ended';                 // empty: the sweeper deletes it
    } else {
      next.hostUid = remaining[0].uid;       // earliest joiner takes over
    }
  }
  return next;
}

function setReady(room, { uid, ready, now }) {
  const p = room.players[uid];
  if (!p) throw new RoomError('not-member', 'Not a member of this room');
  p.ready = !!ready;
  return { ...room, updatedAt: now };
}

/** Host-only room configuration; only valid while waiting in the lobby. */
function configureRoom(room, { uid, patch, now }) {
  if (uid !== room.hostUid) throw new RoomError('not-host', 'Only the host can change settings');
  if (room.status !== 'lobby') throw new RoomError('locked', 'Cannot reconfigure during a match');
  room.config = sanitizeConfig({ ...room.config, ...patch });
  return { ...room, updatedAt: now };
}

function presenceUpdate(room, { uid, online, now }) {
  const p = room.players[uid];
  if (!p) return room;
  p.online = !!online;
  p.lastSeen = now;
  return { ...room, updatedAt: now };
}

/** Why the match cannot start yet, or null when it can. */
function startCheck(room) {
  const humans = humanPlayers(room);
  if (room.status !== 'lobby') return 'Room is not in the lobby';
  if (humans.length === 0) return 'Room is empty';
  if (humans.some((p) => !p.ready)) return 'Waiting for players to be ready';
  const totalSlots = humans.length + room.config.botCount;
  if (totalSlots < MIN_PLAYERS) return 'Need at least 2 participants (a friend or a bot)';
  if (humans.length < MIN_PLAYERS && room.config.botCount === 0) {
    return 'Add bots or invite another player';
  }
  return null;
}

function botId(index) { return 'bot-' + String(index + 1); }

/**
 * Host starts the match. All human members become participants; bots are
 * filled in and owned by the host client (trusted-host simulation — the
 * rules only accept bot writes from the host uid, and the backend owns
 * winner/elimination finalisation).
 */
function startMatch(room, { uid, now, seed, makeBotName }) {
  if (uid !== room.hostUid) throw new RoomError('not-host', 'Only the host can start the match');
  const why = startCheck(room);
  if (why) throw new RoomError('not-ready', why);

  const participants = {};
  humanPlayers(room).forEach((p) => {
    participants[p.uid] = {
      id: p.uid, kind: 'human', name: p.name, color: p.color,
      ready: true, alive: true, kills: 0, deaths: 0, joinedAt: p.joinedAt,
    };
  });
  for (let i = 0; i < room.config.botCount; i++) {
    const id = botId(i);
    participants[id] = {
      id, kind: 'bot', name: (makeBotName ? makeBotName(i) : 'BOT-' + (i + 1)),
      color: COLORS[(humanPlayers(room).length + i) % COLORS.length],
      owner: room.hostUid,
      ready: true, alive: true, kills: 0, deaths: 0, joinedAt: now,
    };
  }
  return {
    ...room,
    status: 'match',
    updatedAt: now,
    match: {
      seed: seed || (room.code + ':' + now),
      startedAt: now,
      preset: room.config.arenaPreset,
      participants,
      winnerId: null,
      ended: false,
    },
  };
}

/** Host ends a finished round and reopens the lobby for a rematch. */
function returnToLobby(room, { uid, now }) {
  if (uid !== room.hostUid) throw new RoomError('not-host', 'Only the host can restart the lobby');
  if (room.status !== 'ended' && room.status !== 'match') {
    throw new RoomError('locked', 'Room is already in the lobby');
  }
  Object.values(room.players).forEach((p) => { p.ready = false; });
  room.status = 'lobby';
  room.match = null;
  room.updatedAt = now;
  return room;
}

module.exports = {
  RoomError, createRoom, joinRoom, leaveRoom, setReady, configureRoom,
  presenceUpdate, startCheck, startMatch, returnToLobby, humanPlayers, humanCapacity, botId,
};
