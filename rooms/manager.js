/* In-memory room manager for the Socket.IO server.
   Room lifecycle rules live in lib/rooms.js (pure, unit-tested); this class
   owns the Map, code uniqueness and identity assignment. Because every
   mutation runs on the single Node event loop, capacity and membership are
   atomic by construction — no client ever supplies a player id. */
'use strict';

const crypto = require('node:crypto');
const codes = require('../lib/codes');
const roomsLib = require('../lib/rooms');
const cleanupLib = require('../lib/cleanup');

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const newPlayerId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString('base64url');

class RoomManager {
  constructor({ now = () => Date.now(), rng } = {}) {
    this.now = now;
    this.rng = rng || (() => crypto.randomBytes(4).readUInt32LE(0) / 0x100000000);
    this.rooms = new Map();   // code → plain room object (lib/rooms shape)
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()) || null; }

  create(rawName, config) {
    const code = codes.generateUniqueCode(this.rng, (c) => this.rooms.has(c));
    if (!code) throw new RoomError('busy', 'Room codes are busy — try again');
    const playerId = newPlayerId();
    const token = newToken();
    let room = roomsLib.createRoom({
      code, hostUid: playerId, config: config || {}, now: this.now(),
    });
    room = roomsLib.joinRoom(room, { uid: playerId, name: rawName, now: this.now() });
    room.players[playerId].token = token;
    room.players[playerId].online = true;
    room.players[playerId].socketId = null;
    this.rooms.set(code, room);
    return { code, room, playerId, token };
  }

  /** code is matched case-insensitively; never creates a room implicitly. */
  join(rawCode, rawName) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!codes.isValidCode(code)) throw new RoomError('invalid-code', 'Invalid room code');
    this.pruneOffline(code);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not-found', 'No room with that code');
    const playerId = newPlayerId();
    const token = newToken();
    const next = roomsLib.joinRoom(room, { uid: playerId, name: rawName, now: this.now() });
    next.players[playerId].token = token;
    next.players[playerId].online = true;
    next.players[playerId].socketId = null;
    this.rooms.set(code, next);
    return { code, room: next, playerId, token };
  }

  leave(code, playerId) {
    const room = this.rooms.get(code);
    if (!room || !room.players[playerId]) return false;
    const next = roomsLib.leaveRoom(room, { uid: playerId, now: this.now() });
    if (Object.keys(next.players).length === 0) this.rooms.delete(code);
    else this.rooms.set(code, next);
    return true;
  }

  setReady(code, playerId, ready) {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not-found', 'Room gone');
    const next = roomsLib.setReady(room, { uid: playerId, ready: !!ready, now: this.now() });
    this.rooms.set(code, next);
    return next;
  }

  configure(code, playerId, patch) {
    this.pruneOffline(code);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not-found', 'Room gone');
    const next = roomsLib.configureRoom(room, { uid: playerId, patch, now: this.now() });
    this.rooms.set(code, next);
    return next;
  }

  startMatch(code, playerId) {
    this.pruneOffline(code);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not-found', 'Room gone');
    const seed = `${code}:${this.now()}`;
    const next = roomsLib.startMatch(room, { uid: playerId, now: this.now(), seed });
    this.rooms.set(code, next);
    return next;
  }

  returnToLobby(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not-found', 'Room gone');
    const next = roomsLib.returnToLobby(room, { uid: playerId, now: this.now() });
    this.rooms.set(code, next);
    return next;
  }

  /* ---------- presence & sessions ---------- */

  findPlayer(playerId) {
    for (const room of this.rooms.values()) {
      const p = room.players[playerId];
      if (p) return { code: room.code, room, player: p };
    }
    return null;
  }

  /** Reconnect: the token must match the player's stored token exactly. */
  resume(code, playerId, token) {
    const room = this.rooms.get(code);
    const p = room && room.players[playerId];
    if (!p || !token || p.token !== token) {
      throw new RoomError('unauthorized', 'Session is not valid for this room');
    }
    return { code, room, player: p };
  }

  setSocket(code, playerId, socketId) {
    const room = this.rooms.get(code);
    if (room && room.players[playerId]) {
      room.players[playerId].socketId = socketId;
      room.players[playerId].online = true;
      room.players[playerId].lastSeen = this.now();
    }
  }

  markOnline(code, playerId, online) {
    const room = this.rooms.get(code);
    if (!room || !room.players[playerId]) return;
    roomsLib.presenceUpdate(room, { uid: playerId, online, now: this.now() });
    if (!online) room.players[playerId].socketId = null;
  }

  /** lib/rooms mutates in place for some paths; keep updatedAt honest. */
  touch(code) {
    const room = this.rooms.get(code);
    if (room) room.updatedAt = this.now();
  }

  /* ---------- maintenance ---------- */

  pruneOffline(code) {
    const room = this.rooms.get(code);
    if (!room || room.status === 'match') return;
    for (const player of Object.values(room.players)) {
      if (!player.online && this.now() - player.lastSeen > cleanupLib.PRESENCE_GRACE_MS) {
        this.leave(code, player.uid);
      }
    }
  }

  /** Remove rooms whose players are all stale (see lib/cleanup.js). */
  sweep() {
    const doomed = [];
    this.rooms.forEach((_room, code) => {
      this.pruneOffline(code);
      const room = this.rooms.get(code);
      if (!room || cleanupLib.isStale(room, this.now())) doomed.push(code);
    });
    doomed.forEach((c) => this.rooms.delete(c));
    return doomed;
  }

  publicRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    return this.publicRoomObj(room);
  }

  publicRoomObj(room) {
    return {
      code: room.code,
      status: room.status,
      hostUid: room.hostUid,
      config: room.config,
      players: Object.fromEntries(Object.entries(room.players).map(([uid, p]) => [uid, {
        uid, name: p.name, color: p.color, ready: p.ready, online: p.online,
        joinedAt: p.joinedAt,
      }])),
    };
  }
}

module.exports = { RoomManager, RoomError };
