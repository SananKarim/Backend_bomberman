/* Input sanitisation shared by every backend operation.
   Nothing trusted ever comes from a client unchecked. */
'use strict';

const ROOM_LIMIT_MAX = 8;          // safe room ceiling (mirrors client config)
const MIN_PLAYERS    = 2;          // "2 or more human players" support
const NAME_MAX       = 14;
const ARENA_PRESETS  = ['classic', 'corridors', 'clusters', 'chambers', 'open', 'mixed'];
const COLORS = ['#22d3ee', '#f43f5e', '#a78bfa', '#4ade80', '#fbbf24', '#f0abfc', '#60a5fa', '#f87171'];

function sanitizeName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[^\w \-'\u00C0-\uFFFF]/gu, '')     // letters, digits, space, dash, apostrophe
    .trim()
    .slice(0, NAME_MAX);
  return s || 'GUEST';
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** Validated room configuration; rejects anything outside safe bounds. */
function sanitizeConfig(raw) {
  const c = raw || {};
  const maxPlayers = clampInt(c.maxPlayers, MIN_PLAYERS, ROOM_LIMIT_MAX, 4);
  return {
    maxPlayers,
    botCount: clampInt(c.botCount, 0, maxPlayers - 1, 0),
    arenaPreset: ARENA_PRESETS.includes(c.arenaPreset) ? c.arenaPreset : 'mixed',
  };
}

module.exports = { sanitizeName, sanitizeConfig, clampInt,
                   ROOM_LIMIT_MAX, MIN_PLAYERS, ARENA_PRESETS, COLORS };
