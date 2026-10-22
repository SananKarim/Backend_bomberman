/* Stale-room / abandoned-room sweeping — pure, time-injected. */
'use strict';

const LOBBY_MAX_AGE_MS  = 2 * 60 * 60 * 1000;   // untouched lobby: 2h
const MATCH_MAX_AGE_MS  = 60 * 60 * 1000;       // a match older than 1h is stale
const PRESENCE_GRACE_MS = 30 * 1000;            // offline grace before "disconnected"
const RESULT_TTL_MS     = 10 * 60 * 1000;       // finished rounds stay viewable 10 min

/** True when the room should be deleted by the sweeper. */
function isStale(room, now) {
  if (!room) return false;
  const players = Object.values(room.players || {});
  if (players.length === 0) return true;
  if (room.status === 'ended') {
    return now - (room.updatedAt || room.createdAt || 0) > RESULT_TTL_MS;
  }
  const everyoneOffline = players.every((p) => !p.online);
  if (room.status === 'lobby') {
    if (everyoneOffline) return true;
    if (now - (room.updatedAt || room.createdAt) > LOBBY_MAX_AGE_MS) return true;
    return false;
  }
  if (room.status === 'match') {
    if (room.match && room.match.ended) {
      return now - (room.match.endedAt || room.updatedAt || 0) > RESULT_TTL_MS;
    }
    if (room.match && now - room.match.startedAt > MATCH_MAX_AGE_MS) return true;
    if (everyoneOffline &&
        now - Math.max(...players.map((p) => p.lastSeen || 0)) > PRESENCE_GRACE_MS) {
      return true;                                    // whole room dropped
    }
  }
  return false;
}

/** Which room codes to delete from a { code: room } snapshot. */
function planCleanup(rooms, now) {
  const out = [];
  Object.entries(rooms || {}).forEach(([code, room]) => {
    if (isStale(room, now)) out.push(code);
  });
  return out;
}

module.exports = { isStale, planCleanup, LOBBY_MAX_AGE_MS, MATCH_MAX_AGE_MS,
                   PRESENCE_GRACE_MS, RESULT_TTL_MS };
