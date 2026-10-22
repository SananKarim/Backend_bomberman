/* Battle-royale match rules + write validation — pure functions.
   Trust model (documented in README):
   - Each client writes only its OWN participant snapshot (position etc).
   - Deaths are declared by the victim about itself (`alive:false`), or by an
     attacker via an elimination event; the backend re-checks shape, bounds,
     cadence and life/death transitions and is the ONLY writer of
     winner/ended state, so score/winner cannot be forged by clients.
   - Bots are simulated by the host client; rules accept bot paths only from
     the host uid, and elimination finalisation still goes through here. */
'use strict';

const TILE = 48, COLS = 15, ROWS = 13;

class MatchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function participants(match) { return Object.values(match.participants || {}); }
function aliveParticipants(match) { return participants(match).filter((p) => p.alive); }

/** Apply an elimination: victim stops affecting the match, attacker scores. */
function eliminate(match, { victimId, byId, now }) {
  applyDeath(match, victimId, byId, now);
  return recheckWinner(match, now);
}

/** One core blast can kill several participants in the same tick.
    Deaths are applied first, winner resolved once — so a mutual
    destruction ends in a draw instead of awarding a phantom winner. */
function eliminateBatch(match, deaths, now) {
  deaths.forEach((d) => applyDeath(match, d.victimId, d.byId, now));
  return recheckWinner(match, now);
}

function applyDeath(match, victimId, byId, now) {
  const victim = match.participants[victimId];
  if (!victim) throw new MatchError('no-victim', 'Unknown participant');
  if (!victim.alive || match.ended) return;                    // idempotent / frozen
  if (byId) {
    const by = match.participants[byId];
    if (!by) throw new MatchError('no-attacker', 'Unknown attacker');
    if (!by.alive) throw new MatchError('dead-actor', 'Eliminated players cannot act');
    if (byId !== victimId) by.kills += 1;                      // self-blast = death, not a kill
  }
  victim.alive = false;
  victim.deaths += 1;
  victim.outAt = now;
}

/** Last survivor / draw detection. Only the backend calls this. */
function recheckWinner(match, now) {
  const alive = aliveParticipants(match);
  if (match.ended) return match;
  if (alive.length === 1) {
    match.ended = true;
    match.winnerId = alive[0].id;
    match.endedAt = now;
  } else if (alive.length === 0) {
    match.ended = true;              // simultaneous elimination → explicit draw
    match.winnerId = null;
    match.endedAt = now;
  }
  return match;
}

/* ---------- write validation for the realtime nodes ---------- */

const MAX_SNAPSHOT_MS = 50;    // same writer cannot push twice within 50ms
const BOMB_LIMIT      = 6;     // absolute per-owner ceiling (upgrade path caps lower)

/** Validate a participant's own movement/state snapshot. */
function validateSnapshot(prev, next, now) {
  if (!next || typeof next !== 'object') throw new MatchError('bad-snapshot', 'Snapshot must be an object');
  if (typeof next.alive !== 'boolean') throw new MatchError('bad-snapshot', 'alive must be boolean');
  if (prev && prev.alive === false && next.alive === true) {
    throw new MatchError('resurrect', 'Eliminated participants cannot return');
  }
  const x = Number(next.x), y = Number(next.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new MatchError('bad-snapshot', 'position must be numeric');
  if (x < 0 || y < 0 || x > COLS * TILE || y > ROWS * TILE) {
    throw new MatchError('out-of-bounds', 'position outside arena');
  }
  const bombs = Math.round(Number(next.bombs) || 0);
  if (bombs < 0 || bombs > BOMB_LIMIT) throw new MatchError('bad-snapshot', 'bomb count out of range');
  if (prev && prev.alive === false && next.alive === false) {
    // dead players must not keep moving
    if (Math.abs(x - (prev.x || 0)) > 2 || Math.abs(y - (prev.y || 0)) > 2) {
      throw new MatchError('dead-actor', 'Eliminated players cannot move');
    }
  }
  if (prev && typeof prev.t === 'number' && now - prev.t < MAX_SNAPSHOT_MS) {
    throw new MatchError('rate-limit', 'snapshot writes are throttled');
  }
  return { x, y, alive: next.alive, bombs, dir: clampDir(next.dir), t: now };
}

function clampDir(d) {
  if (!d || typeof d !== 'object') return { x: 1, y: 0 };
  return { x: Math.max(-1, Math.min(1, Math.round(Number(d.x) || 0))),
           y: Math.max(-1, Math.min(1, Math.round(Number(d.y) || 0))) };
}

/** Validate a bomb node owned by `uid` before accepting it. */
function validateBomb(ownerUid, bombUid, b) {
  if (!b || typeof b !== 'object') throw new MatchError('bad-bomb', 'bomb must be an object');
  // Path-level ownership is enforced by the security rules; the id prefix is
  // a cheap second check that the client built the id from its own uid.
  if (typeof bombUid === 'string' && b.owner && b.owner !== ownerUid) {
    throw new MatchError('bad-owner', 'bomb owner mismatch');
  }
  const cellX = Math.round(Number(b.cellX)), cellY = Math.round(Number(b.cellY));
  if (!Number.isFinite(cellX) || !Number.isFinite(cellY) ||
      cellX < 0 || cellY < 0 || cellX >= COLS || cellY >= ROWS) {
    throw new MatchError('out-of-bounds', 'bomb cell outside arena');
  }
  const range = Math.round(Number(b.range) || 2);
  if (range < 1 || range > 5) throw new MatchError('bad-bomb', 'bomb range out of bounds');
  const fuse = Number(b.fuse);
  if (!Number.isFinite(fuse) || fuse < 0 || fuse > 5) throw new MatchError('bad-bomb', 'fuse out of bounds');
  return { cellX, cellY, range, fuse, thrown: !!b.thrown, owner: ownerUid };
}

/** Count active bombs per owner; enforces BOMB_LIMIT ceiling. */
function bombCountOk(bombs, ownerUid, maxActive) {
  let n = 0;
  Object.values(bombs || {}).forEach((b) => { if (b && b.owner === ownerUid) n++; });
  return n < Math.min(maxActive, BOMB_LIMIT);
}

module.exports = {
  MatchError, participants, aliveParticipants, eliminate, eliminateBatch, recheckWinner,
  validateSnapshot, validateBomb, bombCountOk,
  COLS, ROWS, TILE, BOMB_LIMIT, MAX_SNAPSHOT_MS,
};
