/* Server-side twin of public/levelgen.js — identical constants, identical
   RNG sequence, so server and clients independently derive the SAME board
   from the same seed. Do not "improve" one copy without mirroring the other. */
'use strict';

const T_EMPTY = 0, T_SOLID = 1, T_SOFT = 2;

const PRESETS = {
  classic:   { soft: 0.78, streetChance: 0.00, clusterChance: 0.35, chamberChance: 0.00, avenues: 1 },
  corridors: { soft: 0.88, streetChance: 0.45, clusterChance: 0.25, chamberChance: 0.00, avenues: 2 },
  clusters:  { soft: 0.30, streetChance: 0.00, clusterChance: 0.95, chamberChance: 0.10, avenues: 1 },
  chambers:  { soft: 0.45, streetChance: 0.15, clusterChance: 0.20, chamberChance: 0.85, avenues: 2 },
  open:      { soft: 0.18, streetChance: 0.00, clusterChance: 0.30, chamberChance: 0.00, avenues: 2 },
  mixed:     { soft: 0.60, streetChance: 0.20, clusterChance: 0.60, chamberChance: 0.40, avenues: 2 },
};
const PRESET_NAMES = Object.keys(PRESETS);

const MIN_OPEN    = 0.55;
const MIN_SPAWNS  = 6;
const MAX_ATTEMPTS = 12;

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function rngFrom(seed) {
  let a = (typeof seed === 'string' ? hash(seed) : seed >>> 0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildOnce(rng, cols, rows, cfg, difficulty) {
  const board = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) row.push(T_SOLID);
      else if (x % 2 === 0 && y % 2 === 0) row.push(T_SOLID);
      else row.push(rng() < cfg.soft ? T_SOFT : T_EMPTY);
    }
    board.push(row);
  }
  const extra = Math.min(4, difficulty);
  for (let i = 0; i < extra; i++) {
    const x = 3 + Math.floor(rng() * (cols - 6));
    const y = 3 + Math.floor(rng() * (rows - 6));
    if (board[y][x] === T_EMPTY) board[y][x] = T_SOFT;
  }

  if (rng() < cfg.streetChance) {
    const y = 3 + Math.floor(rng() * (rows - 5));
    for (let x = 2; x < cols - 2; x++) if (board[y][x] !== T_SOLID) board[y][x] = T_EMPTY;
  }
  if (rng() < cfg.streetChance) {
    const x = 3 + Math.floor(rng() * (cols - 5));
    for (let y = 2; y < rows - 2; y++) if (board[y][x] !== T_SOLID) board[y][x] = T_EMPTY;
  }

  const SHAPES = [
    [[0, 0], [1, 0], [0, 1]],
    [[0, 0], [1, 0], [2, 0], [1, 1]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
    [[0, 0], [1, 0], [2, 0]],
    [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1]],
  ];
  const clusters = 1 + Math.floor(rng() * 3 * (cfg.clusterChance > 0 ? 1 : 0));
  for (let c = 0; c < clusters; c++) {
    if (rng() > cfg.clusterChance) continue;
    const shape = SHAPES[Math.floor(rng() * SHAPES.length)];
    const ox = 2 + Math.floor(rng() * (cols - 6));
    const oy = 2 + Math.floor(rng() * (rows - 6));
    for (const [dx, dy] of shape) {
      const x = ox + dx, y = oy + dy;
      if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && board[y][x] === T_EMPTY)
        board[y][x] = T_SOFT;
    }
  }

  if (rng() < cfg.chamberChance) {
    const ox = 3 + Math.floor(rng() * (cols - 7));
    const oy = 3 + Math.floor(rng() * (rows - 7));
    for (let dy = 0; dy <= 2; dy++)
      for (let dx = 0; dx <= 2; dx++) {
        const x = ox + dx, y = oy + dy;
        const edge = dx === 0 || dy === 0 || dx === 2 || dy === 2;
        if (edge && board[y][x] === T_EMPTY) board[y][x] = T_SOFT;
      }
    board[oy + 1][ox] = T_EMPTY;
    board[oy + 1][ox + 2] = T_EMPTY;
    board[oy + 1][ox + 1] = T_EMPTY;
  }

  {
    const ox = 2 + Math.floor(rng() * (cols - 5));
    const oy = 2 + Math.floor(rng() * (rows - 5));
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 2; dx++) {
        const x = ox + dx, y = oy + dy;
        if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && board[y][x] === T_SOFT)
          board[y][x] = T_EMPTY;
      }
  }

  board[1][1] = T_EMPTY; board[1][2] = T_EMPTY; board[2][1] = T_EMPTY;

  const clearLane = (cells) => cells.forEach(([x, y]) => {
    if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1 && board[y][x] !== T_SOLID)
      board[y][x] = T_EMPTY;
  });
  const lane = [];
  for (let x = 1; x <= cols - 2; x++) { lane.push([x, 1]); lane.push([x, rows - 2]); }
  for (let y = 2; y <= rows - 3; y++) { lane.push([1, y]); lane.push([cols - 2, y]); }
  clearLane(lane);
  const oddRows = [], oddCols = [];
  for (let y = 3; y <= rows - 4; y += 2) oddRows.push(y);
  for (let x = 3; x <= cols - 4; x += 2) oddCols.push(x);
  for (let i = 0; i < cfg.avenues; i++) {
    const ry = oddRows[Math.floor(rng() * oddRows.length)];
    clearLane(Array.from({ length: cols - 2 }, (_, k) => [k + 1, ry]));
    const cx = oddCols[Math.floor(rng() * oddCols.length)];
    clearLane(Array.from({ length: rows - 2 }, (_, k) => [cx, k + 1]));
  }
  return board;
}

function floodFree(board, cols, rows) {
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  if (board[1][1] !== T_EMPTY) return seen;
  const q = [[1, 1]];
  seen[1][1] = true;
  let n = 1;
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx <= 0 || ny <= 0 || nx >= cols - 1 || ny >= rows - 1) continue;
      if (seen[ny][nx] || board[ny][nx] !== T_EMPTY) continue;
      seen[ny][nx] = true; n++;
      q.push([nx, ny]);
    }
  }
  return seen;
}

function spawnCandidates(board, cols, rows) {
  const reach = floodFree(board, cols, rows);
  const out = [];
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1; x < cols - 1; x++) {
      if (board[y][x] !== T_EMPTY || !reach[y][x]) continue;
      if (x + y < 8) continue;
      out.push({ x, y, minDist: 2 });
    }
  return out;
}

function validate(board, cols, rows) {
  if (board[1][1] !== T_EMPTY || board[1][2] !== T_EMPTY || board[2][1] !== T_EMPTY)
    return false;
  const reach = floodFree(board, cols, rows);
  let free = 0, reachable = 0;
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1; x < cols - 1; x++) {
      if (board[y][x] === T_EMPTY) { free++; if (reach[y][x]) reachable++; }
    }
  if (free === 0 || reachable / free < MIN_OPEN) return false;
  const spawns = spawnCandidates(board, cols, rows);
  return spawns.length >= MIN_SPAWNS;
}

function make(opts) {
  const cols = opts.cols, rows = opts.rows;
  const presetName = opts.preset && PRESETS[opts.preset] ? opts.preset : 'mixed';
  const cfg = PRESETS[presetName];
  const base = typeof opts.seed === 'string' ? hash(opts.seed) : (opts.seed >>> 0);
  const difficulty = Math.max(0, opts.levelIndex | 0);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = rngFrom(base + attempt * 7919);
    const board = buildOnce(rng, cols, rows, cfg, difficulty);
    if (validate(board, cols, rows))
      return { board, spawnCells: spawnCandidates(board, cols, rows), preset: presetName };
  }
  const rng = rngFrom(base);
  const board = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) row.push(T_SOLID);
      else if (x % 2 === 0 && y % 2 === 0) row.push(T_SOLID);
      else row.push(rng() < 0.78 ? T_SOFT : T_EMPTY);
    }
    board.push(row);
  }
  board[1][1] = board[1][2] = board[2][1] = T_EMPTY;
  return { board, spawnCells: spawnCandidates(board, cols, rows), preset: 'classic' };
}

function presetForLevel(levelIndex) {
  const order = ['classic', 'corridors', 'clusters', 'chambers', 'open', 'mixed'];
  return order[levelIndex % order.length];
}

module.exports = { make, validate, spawnCandidates, presetForLevel, PRESET_NAMES, PRESETS, hash };
