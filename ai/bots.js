/* Multiplayer bot AI — server-side, same behaviors as the campaign enemies:
   hunter (chases), ambusher (cuts predicted off), patroller (wanders until
   close). Bots live under the same movement/bomb/elimination rules as humans:
   the sim executes their intents, this module only decides them. */
'use strict';

const TILE = 48, COLS = 15, ROWS = 13;

const PATH_INTERVAL   = 0.6;
const ALERT_BASE      = 150;
const TELEGRAPH_TIME  = 0.5;
const AGGRO_SPEED     = 1.18;
const AMBUSH_PREDICT  = 2;
const FLEE_TIME       = 0.8;
const BOT_BOMB_CD_MIN = 2.2;
const BOT_BOMB_CD_RND = 1.6;
const BOT_BOMB_SIGHT  = TILE * 6;          // 288 px

const KINDS = ['hunter', 'ambush', 'patrol'];

/* Grid BFS, 4-dir; walkable = tile EMPTY and no grounded bomb.
   Returns cells goal-inclusive / start-exclusive, or null. */
function bfsPath(world, fromCx, fromCy, toCx, toCy) {
  if (fromCx === toCx && fromCy === toCy) return [];
  const ok = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS
    && world.tileAt(x, y) === 0 && !world.bombAtCell(x, y);
  if (!ok(toCx, toCy)) return null;
  const prev = new Map();
  const q = [[fromCx, fromCy]];
  prev.set(`${fromCx},${fromCy}`, null);
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h];
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const key = `${nx},${ny}`;
      if (prev.has(key) || !ok(nx, ny)) continue;
      prev.set(key, [x, y]);
      if (nx === toCx && ny === toCy) {                  // reconstruct backwards
        const path = [];
        let cur = [nx, ny];
        while (cur) {
          const [px, py] = cur;
          if (px === fromCx && py === fromCy) break;
          path.unshift({ x: px, y: py });
          cur = prev.get(`${px},${py}`);
        }
        return path.length ? path : null;
      }
      q.push([nx, ny]);
    }
  }
  return null;
}

function createBot(index, rng) {
  return {
    kindIndex: index % KINDS.length,
    kind: KINDS[index % KINDS.length],
    alert: 0,
    aggro: false,
    fleeTimer: 0,
    path: null,
    pathTimer: 0,
    mazeVer: -1,
    turnTimer: 1,
    wander: { x: -1, y: 0 },
    botBombCd: 1.5 + index * 0.4,
    rng,
  };
}

const cellOf = (actor) => ({ x: Math.floor(actor.x / TILE), y: Math.floor(actor.y / TILE) });

/* Decide this bot's intent for the tick. world = facade from the sim:
   { tileAt, bombAtCell, pickupAtCell, humans[], bots[], mazeVersion, rng,
     alertRange, nearestTargetCell, predictCell }
   Returns { intent:{x,y}, wantBomb:bool }. */
function step(bot, self, world, dt) {
  const out = { intent: { x: 0, y: 0 }, wantBomb: false };
  bot.pathTimer -= dt;
  bot.fleeTimer = Math.max(0, bot.fleeTimer - dt);
  bot.alert = Math.max(0, bot.alert - dt);

  const target = world.nearestHuman(cellOf(self));
  if (!target) {                              // no humans left: wander
    wander(bot, self, world, dt, out);
    return out;
  }
  const dist = Math.hypot(target.cx * TILE + TILE / 2 - self.x,
                          target.cy * TILE + TILE / 2 - self.y);
  const alertRange = world.alertRange;

  if (bot.kind === 'patrol') {
    if (!bot.aggro && dist < alertRange) { bot.aggro = true; bot.alert = TELEGRAPH_TIME; }
    if (bot.aggro && dist > alertRange * 1.6) bot.aggro = false;
  } else if (bot.kind === 'ambush') {
    bot.aggro = dist < alertRange * 1.4 && target.alive;
  } else {
    bot.aggro = true;
  }

  if (bot.fleeTimer > 0) {                    // escaping a fresh blast
    wander(bot, self, world, dt, out);
    return out;
  }

  let goal;
  if (bot.kind === 'ambush') {
    goal = world.predictCell(target, bot.aggro ? AMBUSH_PREDICT + 1 : AMBUSH_PREDICT);
  } else if (bot.kind === 'patrol' && (!bot.aggro || bot.alert > 0)) {
    wander(bot, self, world, dt, out);
    return out;
  } else {
    goal = { x: target.cx, y: target.cy };
  }

  const from = cellOf(self);
  if (bot.pathTimer <= 0 || bot.mazeVer !== world.mazeVersion) {
    bot.path = bfsPath(world, from.x, from.y, goal.x, goal.y);
    bot.pathTimer = PATH_INTERVAL;
    bot.mazeVer = world.mazeVersion;
  }
  if (!bot.path) { wander(bot, self, world, dt, out); return out; }

  if (bot.path.length) {
    const w = bot.path[0];
    const wx = w.x * TILE + TILE / 2, wy = w.y * TILE + TILE / 2;
    const dx = wx - self.x, dy = wy - self.y;
    const d = Math.hypot(dx, dy);
    const speed = self.speed * (bot.aggro && bot.kind !== 'ambush' ? AGGRO_SPEED : 1);
    if (d <= Math.max(speed * dt, 0.5)) bot.path.shift();
    else out.intent = { x: Math.round(dx / d), y: Math.round(dy / d) };
  }

  // bombs: only when aggro'd, nearest human in sight, cooldown expired
  bot.botBombCd -= dt;
  if (bot.aggro && bot.botBombCd <= 0 && dist <= BOT_BOMB_SIGHT) out.wantBomb = true;
  return out;
}

function wander(bot, self, world, dt, out) {
  bot.turnTimer -= dt;
  if (bot.turnTimer <= 0) {
    bot.turnTimer = 0.5 + world.rng() * 0.9;
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
      .filter((d) => !(bot.wander && d.x === -bot.wander.x && d.y === -bot.wander.y));
    bot.wander = dirs[Math.floor(world.rng() * dirs.length)];
  }
  out.intent = { ...bot.wander };
}

/* Every detonation scares bots whose cell is within BOMB_RANGE+2 Manhattan. */
function scareNear(world, bots, cellX, cellY, radius = 4) {
  for (const b of bots) {
    const c = cellOf(b.actor);
    if (Math.abs(c.x - cellX) + Math.abs(c.y - cellY) <= radius) {
      b.brain.fleeTimer = FLEE_TIME;
      b.brain.path = null;
      b.brain.pathTimer = 0;
      b.brain.turnTimer = 0;
    }
  }
}

module.exports = { createBot, step, bfsPath, scareNear, cellOf,
                   KINDS, BOT_BOMB_CD_MIN, BOT_BOMB_CD_RND, BOT_BOMB_SIGHT };
