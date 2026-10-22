/* Bot AI unit tests: pathfinding correctness, personality behaviour and
   blast-fleeing — all decided server-side, before the sim executes intents. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bots = require('../ai/bots');

const TILE = 48;

/** Tiny fixed maze: everything EMPTY except a wall column at x=4 (gap at y=3). */
function world(over = {}) {
  const solids = new Set(['4,0', '4,1', '4,2', '4,4', '4,5', '4,6', '4,7']);
  const w = {
    tileAt: (x, y) => (x < 0 || y < 0 || x >= 8 || y >= 8) ? 1 : (solids.has(`${x},${y}`) ? 1 : 0),
    bombAtCell: () => w.bomb || false,
    mazeVersion: 0,
    rng: mulberry(7),
    alertRange: 150,
    bomb: null,
    ...over,
  };
  return w;
}
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const actor = (cx, cy, speed = 96) => ({
  x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2, speed,
  dir: { x: 1, y: 0 }, alive: true,
});
const human = (cx, cy) => ({ id: 'h1', cx, cy, dx: 1, dy: 0, alive: true });
const nearest = (w) => (cell) => {
  let best = null, bd = Infinity;
  for (const t of w.humans || []) {
    const d = Math.abs(t.cx - cell.x) + Math.abs(t.cy - cell.y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
};
const predict = (w) => (target, n) => {
  let cx = target.cx, cy = target.cy;
  for (let i = 0; i < n; i++) {
    const nx = cx + (target.dx || 1), ny = cy + target.dy;
    if (w.tileAt(nx, ny) !== 0 || w.bombAtCell(nx, ny)) break;
    cx = nx; cy = ny;
  }
  return { x: cx, y: cy };
};
function facade(over = {}) {
  const w = world();
  w.humans = over.humans || [human(1, 1)];
  w.nearestHuman = nearest(w);
  w.predictCell = predict(w);
  return Object.assign(w, over, { nearestHuman: w.nearestHuman, predictCell: w.predictCell });
}
const cellOfA = (a) => ({ x: Math.floor(a.x / TILE), y: Math.floor(a.y / TILE) });

test('bfs routes around walls, respects bombs, and returns [] at the goal', () => {
  const w = world();
  const p = bots.bfsPath(w, 1, 1, 6, 1);
  assert.ok(p, 'path must exist through the gap at y=3');
  assert.equal(Math.abs(p[0].x - 1) + Math.abs(p[0].y - 1), 1, 'first step is adjacent to start');
  assert.ok(p.every((c) => w.tileAt(c.x, c.y) === 0));
  assert.deepEqual(bots.bfsPath(w, 2, 2, 2, 2), [], 'already there');
  assert.equal(bots.bfsPath(w, 1, 1, 4, 1), null, 'a solid goal is unreachable');
  w.bomb = { cellX: 4, cellY: 3 };
  assert.equal(bots.bfsPath(w, 1, 1, 7, 1), null, 'grounded bomb seals the gap');
});

test('hunter steers straight at the nearest human', () => {
  const w = facade();
  const brain = bots.createBot(0, mulberry(3));          // hunter
  const self = actor(7, 1);
  const { intent } = bots.step(brain, self, w, 0.05);
  assert.equal(intent.x, -1, 'walks left toward (1,1)');
  assert.equal(intent.y, 0);
});

test('ambusher targets the predicted cell, not the current one', () => {
  const w = facade({ humans: [Object.assign(human(5, 1), { dx: 1, dy: 0 })] });
  const brain = bots.createBot(1, mulberry(3));          // ambush
  const self = actor(1, 1);
  bots.step(brain, self, w, 0.05);
  assert.ok(brain.aggro, 'ambusher engages within 1.4× alert range');
  assert.ok(brain.path && brain.path.length, 'paths toward the prediction');
  const last = brain.path[brain.path.length - 1];
  assert.ok(last.x >= 7, 'goal includes forward prediction cells');
});

test('patroller wanders until the human crosses the alert radius, then chases', () => {
  const w = facade({ humans: [human(7, 7)], alertRange: 150 });
  const brain = bots.createBot(2, mulberry(3));          // patrol
  const self = actor(1, 1);                              // far: pixel distance > 150
  const a1 = bots.step(brain, self, w, 0.05);
  assert.equal(brain.aggro, false);
  assert.ok(a1.intent.x || a1.intent.y, 'wanders with a real direction');
  w.humans = [human(2, 1)];                              // close (48px)
  bots.step(brain, self, w, 0.05);
  assert.ok(brain.alert > 0 || brain.aggro, 'telegraphs, then aggro');
});

test('fleeing overrides chasing for 0.8s after a nearby blast', () => {
  const w = facade({ humans: [human(1, 1)] });
  const brain = bots.createBot(0, mulberry(3));
  const self = actor(2, 1);
  const entry = { brain, actor: self };
  bots.scareNear(w, [entry], 4, 1, 4);                   // blast 2 cells away
  assert.ok(brain.fleeTimer > 0 && brain.path === null);
  const before = { ...cellOfA(self) };
  bots.step(brain, self, w, 0.05);                       // while fleeing → wander, not chase
  assert.equal(brain.fleeTimer > 0, true);
  // after the flee window the hunter replans onto the human
  for (let i = 0; i < 20; i++) bots.step(brain, self, w, 0.05);
  assert.equal(brain.fleeTimer, 0);
  assert.ok(brain.path === null || brain.path.length > 0);
  assert.deepEqual(cellOfA(self), before, 'AI itself never moves actors');
});

test('bots arm bombs only when aggro, in sight and off cooldown', () => {
  const w = facade({ humans: [human(2, 1)] });
  const brain = bots.createBot(0, mulberry(3));
  const self = actor(1, 1);
  brain.botBombCd = 1;
  let saw = false;
  for (let i = 0; i < 5; i++) if (bots.step(brain, self, w, 0.05).wantBomb) saw = true;
  assert.equal(saw, false, 'cooldown still running');
  brain.botBombCd = 0;
  assert.equal(bots.step(brain, self, w, 0.05).wantBomb, true);
  brain.botBombCd = 0;
  w.humans = [human(7, 7)];                              // out of 288px sight
  assert.equal(bots.step(brain, self, w, 0.05).wantBomb, false);
});
