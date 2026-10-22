/* Authoritative battle-royale simulation — NEON BOMBER online matches.

   The server owns every outcome: movement, bombs, explosions, damage,
   pickups, eliminations and victory. Clients only send intents
   (move / bomb / throw) and render snapshots.

   Rules are a faithful port of public/game.js so online play feels
   identical to the campaign: same collision box (ENTITY_HALF), snap
   assist, bomb-escape semantics, fuse (2.4s), flame damage window
   (0.22s inside a 0.65s visible life), blast-id damage dedupe, shield
   absorb + grace, and the same deterministic board from levelgen.

   Battle-royale differences from the campaign: one lethal hit eliminates
   (no lives), bots move at BR speed, thrown bombs use base throw range,
   Chaos Bomb only extends range, and Time Warp slows ALL bots while any
   alive human carries it (a shared-arena design call, documented).
   Everything the clients must agree on (board layout, block destruction,
   power-up drops) is derived from the arena seed via the same hashes, so
   snapshots only carry positions, fuses and event deltas. */
'use strict';

const levelgen = require('./levelgen');
const bots = require('../ai/bots');

const TILE = 48, COLS = 15, ROWS = 13;
const T_EMPTY = 0, T_SOLID = 1, T_SOFT = 2;

const PLAYER_SPEED   = 158;
const BOT_SPEED_BR   = 96;
const ENTITY_HALF    = TILE * 0.36;        // movement collision box half
const PLAYER_HIT_HALF = ENTITY_HALF * 0.7; // damage hurtbox (players only)
const SNAP_ASSIST    = 10;                 // corridor centering, per 1/60s
const SNAP_T         = 1 / 60;

const BOMB_FUSE      = 2.4;
const BOMB_RANGE     = 2;
const MAX_BOMB_RANGE = 4;                  // chaos blast may reach 5
const BOMB_LIMIT     = 6;
const FLAME_LIFETIME = 0.65;
const FLAME_DAMAGE_TIME = 0.22;
const CHAIN_FUSE     = 0.05;

const THROW_RANGE    = 3;                  // BR: no upgrade bonus
const THROW_STEP_TIME = 0.09;              // seconds per tile in flight

const START_INVULN      = 2.0;
const SHIELD_ABSORB_INVULN = 1.6;
const CONTACT_KILL_DIST = TILE * 0.78;
const PICKUP_GRAB       = TILE * 0.8;

const TURBO_MULT = 1.55, TURBO_TIME = 10;
const WARP_MULT  = 0.45, WARP_TIME  = 6;
const CHAOS_TIME = 10;
const DRONE_TIME = 8, DRONE_ZAP_RADIUS = 64.8, DRONE_ZAP_CD = 0.5;

/* BR drop table — order + weights are part of the shared deterministic
   contract with the client (roll % 94 against this list). */
const DROP_TYPES = [
  { type: 'boots',  w: 24 },
  { type: 'shield', w: 18 },
  { type: 'warp',   w: 16 },
  { type: 'chaos',  w: 14 },
  { type: 'tosser', w: 12 },
  { type: 'drone',  w: 10 },
];
const DROP_TOTAL = 94;
const DROP_GATE  = 0.22;                   // chance a broken block drops

const hash = levelgen.hash;
function rngFrom(seed) {
  let a = (typeof seed === 'string' ? hash(seed) : seed >>> 0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- deterministic world pieces (clients rebuild identically) ---------- */

function buildArena(arenaSeed, preset) {
  const gen = levelgen.make({ seed: `${arenaSeed}:l0`, preset, levelIndex: 0, cols: COLS, rows: ROWS });
  return gen.board;
}

/** Spawn cells: EMPTY, away from the corner pocket, shuffled by the seed,
    then greedily spread (Manhattan >= 3), cycling the pool if short. */
function deterministicSpawns(board, seed, count) {
  const pool = [];
  for (let y = 1; y < ROWS - 1; y++)
    for (let x = 1; x < COLS - 1; x++)
      if (board[y][x] === T_EMPTY && x + y >= 2) pool.push({ x, y });
  pool.sort((a, b) => hash(`${seed}:${a.x}:${a.y}`) - hash(`${seed}:${b.x}:${b.y}`));
  const picked = [];
  for (const c of pool) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) >= 3)) picked.push(c);
  }
  let k = 0;
  while (picked.length < count && pool.length) { picked.push(pool[k % pool.length]); k++; }
  return picked;
}

function dropFor(arenaSeed, cellX, cellY) {
  const r = hash(`${arenaSeed}:drop|type:${cellX * COLS + cellY}`);
  if (((r % 1000) / 1000) >= DROP_GATE) return null;
  let roll = r % DROP_TOTAL, i = 0;
  while (roll >= DROP_TYPES[i].w) { roll -= DROP_TYPES[i].w; i++; }
  return DROP_TYPES[i].type;
}

/* ---------- simulation ---------- */

function createMatch(opts) {
  const arenaSeed = String(opts.arenaSeed);
  const preset = opts.preset && levelgen.PRESET_NAMES.includes(opts.preset) ? opts.preset : 'mixed';
  const board = buildArena(arenaSeed, preset);
  const mazeSeedFnv = hash(arenaSeed);

  /* participants: [{id, name, color, isBot}] — humans + bots share the rules */
  const actors = [];
  const botsList = [];
  let uidSeq = 1;
  const nextUid = () => `e${(uidSeq++).toString(36)}${(mazeSeedFnv % 46656).toString(36)}`;

  const roster = opts.participants
    .map((p) => ({ ...p, isBot: false }))
    .concat(Array.from({ length: opts.botCount | 0 }, (_, i) =>
      ({ id: `bot-${i + 1}`, name: `AUTOBOT ${i + 1}`, color: '#94a3b8', isBot: true })))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const spawns = deterministicSpawns(board, `${arenaSeed}:spawn`, roster.length);

  roster.forEach((p, i) => {
    const cell = spawns[i] || { x: 1, y: 1 };
    const actor = {
      id: p.id, name: p.name, color: p.color, isBot: p.isBot,
      x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2,
      dir: { x: 1, y: 0 },
      speed: p.isBot ? BOT_SPEED_BR : PLAYER_SPEED,
      alive: true,
      invuln: START_INVULN,
      bombMax: 2, bombRange: BOMB_RANGE,
      turboTimer: 0, warpTimer: 0, chaosTimer: 0,
      shield: false, tosser: false,
      drone: null,
      lastBlast: -1,
      throwCd: 0,
      rng: rngFrom(`${arenaSeed}:actor:${p.id}`),
      kills: 0, deaths: 0, outAt: 0,
    };
    actors.push(actor);
    if (p.isBot) {
      const brain = bots.createBot(actors.length - 1, rngFrom(`${arenaSeed}:botbrain:${p.id}`));
      botsList.push({ brain, actor });
    }
  });
  const byId = new Map(actors.map((a) => [a.id, a]));

  const world = {
    arenaSeed, preset, cols: COLS, rows: ROWS, board,
    actors, humans: actors.filter((a) => !a.isBot), bots: botsList, byId,
    bombs: [],        // {uid, owner, cellX, cellY, fuse, range, escape, thrown}
    flights: [],      // {bomb, fromX, fromY, toX, toY, t, dur}
    flames: [],       // {cellX, cellY, shape, kind, blast, by, life, dmg}
    pickups: [],      // {uid, cellX, cellY, type}
    destroyed: [],    // cells removed since the last snapshot
    events: [],       // {type, ...} since the last snapshot
    mazeVersion: 0,
    blastSeq: 0,
    seq: 0,
    t: 0,
    ended: false,
    winnerId: null,
    dropTable: dropFor,
  };

  const tileAt = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? T_SOLID : board[y][x];
  const bombAtCell = (x, y) => world.bombs.find((b) => b.cellX === x && b.cellY === y) || null;
  world.tileAt = tileAt;
  world.bombAtCell = bombAtCell;

  /* ---- movement ---- */
  function boxBlocked(x, y, self) {
    const x0 = Math.floor((x - ENTITY_HALF) / TILE), x1 = Math.floor((x + ENTITY_HALF) / TILE);
    const y0 = Math.floor((y - ENTITY_HALF) / TILE), y1 = Math.floor((y + ENTITY_HALF) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tileAt(tx, ty) !== T_EMPTY) return true;
        const bomb = bombAtCell(tx, ty);
        if (bomb) {
          if (bomb.escape && bomb.owner === self.id) continue; // just-placed escape
          return true;
        }
      }
    }
    return false;
  }

  function moveActor(a, ix, iy, dt) {
    const sp = effectiveSpeed(a);
    const dx = ix * sp * dt, dy = iy * sp * dt;
    if (dx !== 0 && !boxBlocked(a.x + dx, a.y, a)) a.x += dx;
    if (dy !== 0 && !boxBlocked(a.x, a.y + dy, a)) a.y += dy;
    if (ix !== 0 && iy === 0) {
      const cy = Math.floor(a.y / TILE) * TILE + TILE / 2;
      a.y += (cy - a.y) * Math.min(1, SNAP_ASSIST * SNAP_T);
    } else if (iy !== 0 && ix === 0) {
      const cx = Math.floor(a.x / TILE) * TILE + TILE / 2;
      a.x += (cx - a.x) * Math.min(1, SNAP_ASSIST * SNAP_T);
    }
  }

  function effectiveSpeed(a) {
    let sp = a.speed;
    if (a.turboTimer > 0) sp *= TURBO_MULT;
    if (a.isBot && warpActive()) sp *= WARP_MULT;
    return sp;
  }
  function warpActive() {
    return world.humans.some((h) => h.alive && h.warpTimer > 0);
  }

  /* bomb escape completes once the owner's box fully clears the tile */
  function updateEscapes() {
    for (const b of world.bombs) {
      if (!b.escape) continue;
      const owner = byId.get(b.owner);
      if (!owner || !owner.alive) { b.escape = false; continue; }
      const left = b.cellX * TILE, top = b.cellY * TILE;
      const overlaps = owner.x + ENTITY_HALF > left && owner.x - ENTITY_HALF < left + TILE &&
                       owner.y + ENTITY_HALF > top  && owner.y - ENTITY_HALF < top + TILE;
      if (!overlaps) b.escape = false;
    }
  }

  /* ---- client intents ---- */
  function applyIntent(actorId, intent) {
    const a = byId.get(actorId);
    if (!a || !a.alive || world.ended) return { ok: false, code: 'ignored' };
    if (intent.type === 'move') {
      const dx = clampUnit(intent.dirX), dy = clampUnit(intent.dirY);
      if (dx || dy) a.dir = { x: dx, y: dy };
      a.intent = { x: dx, y: dy };
      return { ok: true };
    }
    if (intent.type === 'bomb') return placeBomb(a) ? { ok: true } : { ok: false, code: 'no-bomb' };
    if (intent.type === 'throw') return throwBomb(a) ? { ok: true } : { ok: false, code: 'no-throw' };
    return { ok: false, code: 'bad-intent' };
  }
  const clampUnit = (v) => Math.max(-1, Math.min(1, Math.round(Number(v) || 0)));

  function ownerBombs(a) {
    return world.bombs.filter((b) => b.owner === a.id).length;
  }

  function placeBomb(a, opts = {}) {
    if (world.ended || !a.alive) return false;
    const cx = Math.floor(a.x / TILE), cy = Math.floor(a.y / TILE);
    if (tileAt(cx, cy) !== T_EMPTY) return false;
    if (bombAtCell(cx, cy)) return false;
    if (ownerBombs(a) >= Math.min(a.bombMax, BOMB_LIMIT)) return false;
    const range = Math.min(a.bombRange + (a.chaosTimer > 0 ? 1 : 0), MAX_BOMB_RANGE + 1);
    world.bombs.push({ uid: nextUid(), owner: a.id, cellX: cx, cellY: cy,
                       fuse: BOMB_FUSE, range, escape: true, byId: a.id });
    world.mazeVersion++;
    return true;
  }

  /* Z-throw: farthest valid tile within THROW_RANGE; airborne counts toward
     capacity; the fuse only starts on landing; if the landing tile got taken
     meanwhile the bomb drops at the owner's feet (or fails there too). */
  function throwBomb(a) {
    if (world.ended || !a.alive || !a.tosser || a.throwCd > 0) return false;
    if (ownerBombs(a) >= Math.min(a.bombMax, BOMB_LIMIT)) return false;
    const cx = Math.floor(a.x / TILE), cy = Math.floor(a.y / TILE);
    let land = null;
    for (let i = 1; i <= THROW_RANGE; i++) {
      const tx = cx + a.dir.x * i, ty = cy + a.dir.y * i;
      if (tileAt(tx, ty) !== T_EMPTY) break;
      if (landValid(tx, ty)) land = { x: tx, y: ty };
    }
    if (!land) return false;
    const range = Math.min(a.bombRange + (a.chaosTimer > 0 ? 1 : 0), MAX_BOMB_RANGE + 1);
    const bomb = { uid: nextUid(), owner: a.id, cellX: cx, cellY: cy,
                   fuse: Infinity, range, escape: false, byId: a.id };
    world.bombs.push(bomb);
    world.flights.push({ bomb, fromX: a.x, fromY: a.y, toX: land.x, toY: land.y,
                         t: 0, dur: THROW_STEP_TIME * (Math.abs(land.x - cx) + Math.abs(land.y - cy)) });
    a.throwCd = 0.25;
    world.mazeVersion++;
    return true;
  }
  function landValid(x, y) {
    if (tileAt(x, y) !== T_EMPTY) return false;
    if (bombAtCell(x, y)) return false;
    if (world.pickups.some((p) => p.cellX === x && p.cellY === y)) return false;
    // never land on top of a standing actor's cell
    return !world.actors.some((o) => o.alive &&
      Math.floor(o.x / TILE) === x && Math.floor(o.y / TILE) === y);
  }

  function updateFlights(dt) {
    for (const f of world.flights) {
      f.t += dt;
      if (f.t < f.dur) continue;
      f.bomb.fuse = Infinity;                   // decide landing
      if (landValid(f.toX, f.toY)) {
        f.bomb.cellX = f.toX; f.bomb.cellY = f.toY;
      } else {
        const owner = byId.get(f.bomb.owner);
        const cx = owner ? Math.floor(owner.x / TILE) : f.toX;
        const cy = owner ? Math.floor(owner.y / TILE) : f.toY;
        if (!landValid(cx, cy)) {               // nowhere to drop: bomb dies harmlessly
          world.bombs = world.bombs.filter((b) => b !== f.bomb);
          f.done = true; world.mazeVersion++; continue;
        }
        f.bomb.cellX = cx; f.bomb.cellY = cy;
      }
      f.bomb.fuse = BOMB_FUSE;                  // fuse starts on landing
      f.bomb.escape = false;                    // landed away from owner
      f.done = true;
      world.mazeVersion++;
    }
    world.flights = world.flights.filter((f) => !f.done);
  }

  /* ---- explosions ---- */
  function detonate(bomb) {
    world.bombs = world.bombs.filter((b) => b !== bomb);
    world.mazeVersion++;
    const blast = ++world.blastSeq;
    const { cellX, cellY } = bomb;
    const mkFlame = (x, y, shape, kind) =>
      world.flames.push({ cellX: x, cellY: y, shape, kind, blast,
                          by: bomb.byId || bomb.owner, life: FLAME_LIFETIME, dmg: FLAME_DAMAGE_TIME });
    mkFlame(cellX, cellY, 'center', 'center');
    bots.scareNear(world, world.bots, cellX, cellY, 4);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      for (let i = 1; i <= bomb.range; i++) {
        const tx = cellX + dx * i, ty = cellY + dy * i;
        const tile = tileAt(tx, ty);
        if (tile === T_SOLID) break;
        mkFlame(tx, ty, dx ? 'h' : 'v', (i === bomb.range || tile !== T_EMPTY) ? 'end' : 'body');
        if (tile === T_SOFT) {
          board[ty][tx] = T_EMPTY;
          world.destroyed.push([tx, ty]);
          const drop = dropFor(arenaSeed, tx, ty);
          if (drop) world.pickups.push({ uid: nextUid(), cellX: tx, cellY: ty, type: drop });
          break;                                // flame is absorbed by the block it ate
        }
        const other = bombAtCell(tx, ty);       // chain reaction — arm stops here
        if (other) { if (other.fuse > CHAIN_FUSE) other.fuse = CHAIN_FUSE; break; }
      }
    }
    world.events.push({ type: 'blast', x: cellX, y: cellY });
  }

  function updateBombs(dt) {
    for (const b of world.bombs) b.fuse -= dt;
    let guard = world.bombs.length + 8;
    while (guard-- > 0) {
      const next = world.bombs.find((b) => b.fuse <= 0);
      if (!next) break;
      detonate(next);
    }
  }

  /* ---- damage ---- */
  function flameHitsPlayer(a) {
    const x0 = Math.floor((a.x - PLAYER_HIT_HALF) / TILE), x1 = Math.floor((a.x + PLAYER_HIT_HALF) / TILE);
    const y0 = Math.floor((a.y - PLAYER_HIT_HALF) / TILE), y1 = Math.floor((a.y + PLAYER_HIT_HALF) / TILE);
    return world.flames.some((f) => f.dmg > 0 && f.cellX >= x0 && f.cellX <= x1 && f.cellY >= y0 && f.cellY <= y1);
  }

  function applyFlameDamage(deaths) {
    for (const a of world.actors) {
      if (!a.alive || world.ended) continue;
      const hit = a.isBot
        ? world.flames.some((f) => f.dmg > 0 && f.cellX === Math.floor(a.x / TILE) && f.cellY === Math.floor(a.y / TILE))
        : flameHitsPlayer(a);
      if (!hit) continue;
      const src = world.flames.find((f) => f.dmg > 0 &&
        (a.isBot ? (f.cellX === Math.floor(a.x / TILE) && f.cellY === Math.floor(a.y / TILE))
                  : flameCellHits(a, f)));
      if (!src || a.lastBlast === src.blast) continue;   // one blast damages once
      a.lastBlast = src.blast;
      kill(a, src.by && src.by !== a.id ? src.by : null, deaths);
    }
  }
  function flameCellHits(a, f) {
    const x0 = Math.floor((a.x - PLAYER_HIT_HALF) / TILE), x1 = Math.floor((a.x + PLAYER_HIT_HALF) / TILE);
    const y0 = Math.floor((a.y - PLAYER_HIT_HALF) / TILE), y1 = Math.floor((a.y + PLAYER_HIT_HALF) / TILE);
    return f.cellX >= x0 && f.cellX <= x1 && f.cellY >= y0 && f.cellY <= y1;
  }

  function kill(a, byId_, deaths) {
    if (!a.alive) return;
    if (a.invuln > 0) return;
    if (a.shield) { a.shield = false; a.invuln = SHIELD_ABSORB_INVULN; return; }
    a.alive = false;
    a.outAt = world.t;
    a.deaths++;
    const by = byId_ ? world.byId.get(byId_) : null;
    if (by && by.alive && by.id !== a.id) by.kills++;
    deaths.push({ victimId: a.id, byId: byId_ || null });
    world.events.push({ type: 'elimination', victimId: a.id, victim: a.name, byId: byId_ || null });
  }

  function updateFlamesAndTimers(dt) {
    for (const f of world.flames) { f.dmg -= dt; f.life -= dt; }
    world.flames = world.flames.filter((f) => f.life > 0);
    for (const a of world.actors) {
      a.invuln = Math.max(0, a.invuln - dt);
      a.turboTimer = Math.max(0, a.turboTimer - dt);
      a.warpTimer = Math.max(0, a.warpTimer - dt);
      a.chaosTimer = Math.max(0, a.chaosTimer - dt);
      a.throwCd = Math.max(0, a.throwCd - dt);
    }
  }

  /* ---- pickups: nearest wins, id tiebreak, single collection ---- */
  function collectPickups(deaths) {
    for (const p of world.pickups.slice()) {
      const px = p.cellX * TILE + TILE / 2, py = p.cellY * TILE + TILE / 2;
      const takers = world.actors.filter((a) => a.alive && !a.isBot &&
        Math.hypot(a.x - px, a.y - py) < PICKUP_GRAB);
      if (!takers.length) continue;
      takers.sort((m, n) => {
        const dm = Math.hypot(m.x - px, m.y - py), dn = Math.hypot(n.x - px, n.y - py);
        return dm !== dn ? dm - dn : (m.id < n.id ? -1 : 1);
      });
      world.pickups = world.pickups.filter((q) => q !== p);
      grant(takers[0], p.type, deaths);
      world.events.push({ type: 'pickup', actorId: takers[0].id, kind: p.type });
    }
  }

  function grant(a, type) {
    if (type === 'boots') a.turboTimer = TURBO_TIME;
    else if (type === 'shield') a.shield = true;
    else if (type === 'warp') a.warpTimer = WARP_TIME;
    else if (type === 'chaos') {
      if (a.bombRange < MAX_BOMB_RANGE) a.bombRange++;
      else a.chaosTimer = CHAOS_TIME;          // already maxed: temporary +1 (cap 5)
    } else if (type === 'tosser') a.tosser = true;
    else if (type === 'drone') a.drone = { x: a.x, y: a.y - 14, life: DRONE_TIME, zapCd: 0 };
  }

  /* ---- phantom drone: trails the owner, zaps bots ---- */
  function updateDrones(dt, deaths) {
    for (const a of world.humans) {
      if (!a.drone) continue;
      a.drone.life -= dt;
      if (a.drone.life <= 0 || !a.alive) { a.drone = null; continue; }
      const tx = a.x - a.dir.x * TILE * 0.9;
      const ty = a.y - a.dir.y * TILE * 0.9 - 14;
      const k = Math.min(1, 6 * dt);
      a.drone.x += (tx - a.drone.x) * k;
      a.drone.y += (ty - a.drone.y) * k;
      a.drone.zapCd -= dt;
      if (a.drone.zapCd <= 0) {
        const target = world.bots.find((b) => b.actor.alive &&
          Math.hypot(b.actor.x - a.drone.x, b.actor.y - a.drone.y) < DRONE_ZAP_RADIUS);
        if (target) { a.drone.zapCd = DRONE_ZAP_CD; kill(target.actor, a.id, deaths); }
      }
    }
  }

  /* ---- contact kills (bot touches a human) ---- */
  function contactChecks(deaths) {
    for (const h of world.humans) {
      if (!h.alive || h.invuln > 0) continue;
      const touch = world.bots.some((b) => b.actor.alive &&
        Math.hypot(b.actor.x - h.x, b.actor.y - h.y) < CONTACT_KILL_DIST);
      if (touch) kill(h, null, deaths);        // bots claim no kill credit
    }
  }

  /* ---- bot world facade ---- */
  const botWorld = {
    tileAt, bombAtCell,
    get mazeVersion() { return world.mazeVersion; },
    rng: null,
    alertRange: 150,
    nearestHuman(cell) {
      let best = null, bd = Infinity;
      for (const h of world.humans) {
        if (!h.alive) continue;
        const d = Math.abs(Math.floor(h.x / TILE) - cell.x) + Math.abs(Math.floor(h.y / TILE) - cell.y);
        if (d < bd) { bd = d; best = h; }
      }
      if (!best) return null;
      return { id: best.id, cx: Math.floor(best.x / TILE), cy: Math.floor(best.y / TILE),
               dx: best.dir.x, dy: best.dir.y, alive: best.alive };
    },
    predictCell(target, n) {
      let cx = target.cx, cy = target.cy;
      for (let i = 0; i < n; i++) {
        const nx = cx + (target.dx || 1), ny = cy + target.dy;
        if (tileAt(nx, ny) !== T_EMPTY || bombAtCell(nx, ny)) break;
        cx = nx; cy = ny;
      }
      return { x: cx, y: cy };
    },
  };

  function stepBots(dt) {
    for (const entry of world.bots) {
      if (!entry.actor.alive) continue;
      botWorld.rng = entry.brain.rng;
      entry.brain.speed = effectiveSpeed(entry.actor);
      const { intent, wantBomb } = bots.step(entry.brain, entry.actor, botWorld, dt);
      moveActor(entry.actor, intent.x, intent.y, dt);
      if (intent.x || intent.y) entry.actor.dir = { x: intent.x, y: intent.y };
      if (wantBomb && placeBomb(entry.actor)) {
        entry.brain.botBombCd = bots.BOT_BOMB_CD_MIN + entry.brain.rng() * bots.BOT_BOMB_CD_RND;
      }
    }
  }

  /* ---- one fixed tick ---- */
  function update(dt) {
    if (world.ended) return;
    const deaths = [];

    stepBots(dt);
    for (const h of world.humans) {
      if (!h.alive) continue;
      const it = h.intent || { x: 0, y: 0 };
      moveActor(h, it.x, it.y, dt);
    }
    updateEscapes();
    updateFlights(dt);
    updateBombs(dt);
    updateFlamesAndTimers(dt);
    applyFlameDamage(deaths);
    collectPickups(deaths);
    updateDrones(dt, deaths);
    contactChecks(deaths);

    /* batched: all deaths land first, then one winner check — so mutual
       destruction in the same tick is an honest draw, not a phantom king. */
    const alive = world.actors.filter((a) => a.alive);
    if (deaths.length && alive.length <= 1) {
      world.ended = true;
      world.winnerId = alive.length === 1 ? alive[0].id : null;
      world.events.push({ type: 'matchOver', winnerId: world.winnerId,
                          alive: alive.map((a) => a.id) });
    }
    world.t += dt;
  }

  /* ---- snapshot for broadcast ---- */
  function snapshot() {
    world.seq++;
    const destroyed = world.destroyed.splice(0);
    const events = world.events.splice(0);
    return {
      seq: world.seq, t: Math.round(world.t * 1000),
      alive: world.actors.filter((a) => a.alive).length,
      ended: world.ended, winnerId: world.winnerId,
      actors: world.actors.map((a) => ({
        id: a.id, x: Math.round(a.x), y: Math.round(a.y),
        dx: a.dir.x, dy: a.dir.y, alive: a.alive,
        bombs: ownerBombs(a), bombMax: a.bombMax, shield: a.shield,
        invuln: a.invuln > 0, tosser: a.tosser,
        turboMs: Math.round(a.turboTimer * 1000),
        warpMs: Math.round(a.warpTimer * 1000),
        chaosMs: Math.round(a.chaosTimer * 1000),
        kills: a.kills, deaths: a.deaths,
      })),
      bombs: world.bombs.map((b) => {
        const f = world.flights.find((x) => x.bomb === b);
        return { uid: b.uid, owner: b.owner, cellX: b.cellX, cellY: b.cellY,
                 range: b.range, fuseMs: f ? -1 : Math.max(0, Math.round(b.fuse * 1000)),
                 flight: f ? { fx: Math.round(f.fromX), fy: Math.round(f.fromY),
                               tx: f.toX * TILE + TILE / 2, ty: f.toY * TILE + TILE / 2,
                               p: +Math.min(1, f.t / f.dur).toFixed(2) } : null };
      }),
      flames: world.flames.map((f) => ({ x: f.cellX, y: f.cellY,
        m: Math.max(0, Math.round(f.life * 1000)), s: f.shape, k: f.kind })),
      pickups: world.pickups.map((p) => ({ uid: p.uid, x: p.cellX, y: p.cellY, type: p.type })),
      drones: world.humans.filter((h) => h.drone && h.alive)
        .map((h) => ({ id: h.id, x: Math.round(h.drone.x), y: Math.round(h.drone.y) })),
      destroyed, events,
    };
  }

  function startPayload() {
    const kindOf = (actor) => {
      const e = world.bots.find((b) => b.actor === actor);
      return e ? e.brain.kind : 'human';
    };
    return {
      arenaSeed, preset, cols: COLS, rows: ROWS,
      roster: actors.map((a) => ({ id: a.id, name: a.name, color: a.color,
                                   isBot: a.isBot, kind: kindOf(a) })),
      actors: actors.map((a) => ({ id: a.id, x: Math.round(a.x), y: Math.round(a.y) })),
    };
  }

  /** A player who forfeited (disconnect grace expired): the server, not the
      browser, removes them from the match — and re-checks the winner. */
  function forfeit(actorId) {
    const a = byId.get(actorId);
    if (!a || !a.alive || world.ended) return false;
    a.invuln = 0; a.shield = false;
    const deaths = [];
    kill(a, null, deaths);
    const alive = world.actors.filter((x) => x.alive);
    if (alive.length <= 1) {
      world.ended = true;
      world.winnerId = alive.length === 1 ? alive[0].id : null;
      world.events.push({ type: 'matchOver', winnerId: world.winnerId,
                          alive: alive.map((x) => x.id) });
    }
    return true;
  }

  world.applyIntent = applyIntent;
  world.update = update;
  world.snapshot = snapshot;
  world.startPayload = startPayload;
  world.forfeit = forfeit;
  return world;
}

module.exports = { createMatch, deterministicSpawns, dropFor, buildArena,
                   TILE, COLS, ROWS, PLAYER_SPEED, BOT_SPEED_BR, DROP_TYPES };
