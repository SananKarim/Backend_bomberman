/* Authoritative-simulation tests: the server, not the browser, decides
   positions, explosions, pickups, eliminations and the winner. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../game/sim');

const DT = 0.05, TILE = sim.TILE, COLS = sim.COLS, ROWS = sim.ROWS;
const T_EMPTY = 0;

function match(over = {}) {
  return sim.createMatch({
    arenaSeed: 'TEST:1000',
    preset: 'classic',
    participants: [
      { id: 'aa', name: 'A', color: '#fff' },
      { id: 'bb', name: 'B', color: '#000' },
    ],
    botCount: 0,
    ...over,
  });
}
const run = (w, sec) => { const n = Math.round(sec / DT); for (let i = 0; i < n; i++) w.update(DT); };
const clear = (w) => w.actors.forEach((a) => { a.invuln = 0; });
const cellOf = (a) => ({ x: Math.floor(a.x / TILE), y: Math.floor(a.y / TILE) });
const at = (a, cx, cy) => { a.x = cx * TILE + TILE / 2; a.y = cy * TILE + TILE / 2; };

/** Find an EMPTY cell whose +x neighbour is SOFT (for destruction tests). */
function softNeighborCell(w) {
  for (let y = 1; y < ROWS - 2; y++)
    for (let x = 1; x < COLS - 3; x++)
      if (w.board[y][x] === T_EMPTY && w.board[y][x + 1] === 2) return { x, y };
  throw new Error('no soft neighbour found');
}
/** Find a run of `len` horizontally EMPTY cells at row >= minY. */
function openRun(w, len = 4, minY = 3) {
  for (let y = minY; y < ROWS - 1; y++)
    for (let x = 1; x <= COLS - 1 - len; x++) {
      let ok = true;
      for (let i = 0; i < len; i++) if (w.board[y][x + i] !== T_EMPTY) { ok = false; break; }
      if (ok) return { x, y };
    }
  throw new Error('no open run found');
}

/* ---------- determinism (the shared contract with clients) ---------- */

test('same arena seed builds the identical board and spawn set', () => {
  const w1 = match({ arenaSeed: 'ABCD:42' });
  const w2 = match({ arenaSeed: 'ABCD:42' });
  assert.deepEqual(w1.board, w2.board);
  const s1 = sim.deterministicSpawns(w1.board, 'ABCD:42:spawn', 8);
  const s2 = sim.deterministicSpawns(w2.board, 'ABCD:42:spawn', 8);
  assert.deepEqual(s1, s2);
});

test('block drops are deterministic per cell and inside sane bounds', () => {
  const a = sim.dropFor('S:1', 5, 5);
  const b = sim.dropFor('S:1', 5, 5);
  assert.equal(a, b);
  let drops = 0;
  for (let i = 0; i < 4000; i++) if (sim.dropFor('S:2', i % COLS, (i / COLS) | 0)) drops++;
  const rate = drops / 4000;
  assert.ok(rate > 0.15 && rate < 0.32, `drop gate rate ${rate} outside 15–32%`);
});

/* ---------- start state ---------- */

test('actors spawn alive on distinct walkable cells with start invulnerability', () => {
  const w = match({ botCount: 2 });
  assert.equal(w.actors.length, 4);
  const seen = [];
  for (const a of w.actors) {
    assert.ok(a.alive);
    assert.ok(a.invuln > 0);
    const c = cellOf(a);
    assert.equal(w.board[c.y][c.x], T_EMPTY);
    for (const p of seen) assert.ok(Math.abs(p.x - c.x) + Math.abs(p.y - c.y) >= 3, 'spawns too close');
    seen.push(c);
  }
  assert.deepEqual(w.startPayload().roster.map((r) => r.id), ['aa', 'bb', 'bot-1', 'bot-2']);
});

/* ---------- movement ---------- */

test('intents move actors, walls stop them, corridors snap-center', () => {
  const w = match();
  const a = w.byId.get('aa');
  const c = cellOf(a);
  // face right; run 2 seconds — position must stay legal and end up right of (or stuck at) start
  w.applyIntent('aa', { type: 'move', dirX: 1, dirY: 0 });
  run(w, 2);
  const nc = cellOf(a);
  assert.ok(a.x >= c.x * TILE, 'moved left of spawn');
  for (let y = Math.floor((a.y - 17.3) / TILE); y <= Math.floor((a.y + 17.3) / TILE); y++)
    for (let x = Math.floor((a.x - 17.3) / TILE); x <= Math.floor((a.x + 17.3) / TILE); x++)
      assert.notEqual(w.board[y][x], 1, 'inside a solid tile');
  // snap assist: horizontal travel centres the actor vertically
  assert.ok(Math.abs(a.y - (nc.y * TILE + TILE / 2)) < 17, 'not snapped to corridor centre');
});

/* ---------- bombs ---------- */

test('bomb capacity is enforced server-side, even above the hard ceiling', () => {
  const w = match();
  const a = w.byId.get('aa');
  a.bombMax = 10;
  let accepted = 0;
  for (let i = 0; i < 12; i++) {
    // re-sit the actor on a fresh empty tile each try so placement isn't blocked by its own bomb
    const c = sim.deterministicSpawns(w.board, 'X', 12)[i];
    at(a, c.x, c.y);
    if (w.applyIntent('aa', { type: 'bomb' }).ok) accepted++;
  }
  assert.equal(accepted, 6, 'BOMB_LIMIT ceiling of 6');
});

test('placed bomb lets the owner escape, then becomes solid again', () => {
  const w = match({ preset: 'open' });
  const a = w.byId.get('aa');
  const { x, y } = openRun(w, 3);
  at(a, x, y);
  a.invuln = 99; w.byId.get('bb').invuln = 99;
  assert.ok(w.applyIntent('aa', { type: 'bomb' }).ok);
  const bomb = w.bombs[0];
  assert.ok(bomb.escape);
  w.applyIntent('aa', { type: 'move', dirX: 1, dirY: 0 });
  run(w, 0.5);
  assert.equal(bomb.escape, false, 'escape must complete once the box clears');
  assert.ok(cellOf(a).x > bomb.cellX, 'owner walked free of the bomb tile');
});

test('fuse expiry destroys a soft block and emits blast + destroyed deltas once', () => {
  const w = match({ preset: 'classic' });
  const { x, y } = softNeighborCell(w);
  const a = w.byId.get('aa');
  at(a, x, y);
  a.invuln = 99;
  w.byId.get('bb').invuln = 99;                 // bystander must survive the blast arms
  assert.ok(w.applyIntent('aa', { type: 'bomb' }).ok);
  const s = w.snapshot();
  run(w, 2.6);                                   // past the 2.4s fuse
  assert.equal(w.board[y][x + 1], T_EMPTY, 'soft block crumbled');
  const s2 = w.snapshot();
  assert.deepEqual(s2.destroyed, [[x + 1, y]]);
  assert.ok(s2.events.some((e) => e.type === 'blast'));
  assert.deepEqual(w.snapshot().destroyed, [], 'deltas drain after one snapshot');
  assert.equal(s.destroyed.length, 0);
});

test('flame kills inside the damage window; a shield absorbs once instead', () => {
  const w = match();
  clear(w);
  const victim = w.byId.get('bb');
  const c = cellOf(victim);
  w.bombs.push({ uid: 'x1', owner: 'aa', cellX: c.x, cellY: c.y, fuse: 0.04, range: 1, escape: false, byId: 'aa' });
  run(w, 0.15);
  assert.equal(victim.alive, false);
  assert.ok(w.byId.get('aa').kills === 1, 'attacker credited');

  const w2 = match();
  clear(w2);
  const v2 = w2.byId.get('bb');
  v2.shield = true;
  const c2 = cellOf(v2);
  w2.bombs.push({ uid: 'x1', owner: 'aa', cellX: c2.x, cellY: c2.y, fuse: 0.04, range: 1, escape: false, byId: 'aa' });
  run(w2, 0.15);
  assert.ok(v2.alive, 'shielded victim survives');
  assert.equal(v2.shield, false);
  assert.ok(v2.invuln > 0 && v2.invuln <= 1.6, 'shield-grace window');
});

test('one blast cannot damage the same actor twice', () => {
  const w = match();
  clear(w);
  const v = w.byId.get('bb');
  const c = cellOf(v);
  w.bombs.push({ uid: 'x1', owner: 'aa', cellX: c.x, cellY: c.y, fuse: 0.04, range: 2, escape: false, byId: 'cc' });
  run(w, 0.3);
  assert.equal(v.deaths, 1);
});

test('chain reaction: a blast lights a neighbour bomb and the arm stops there', () => {
  const w = match();
  clear(w);
  let placed = false;
  for (let y = 1; y < ROWS - 1 && !placed; y++)
    for (let x = 1; x < COLS - 2 && !placed; x++)
      if (w.board[y][x] === T_EMPTY && w.board[y][x + 1] === T_EMPTY) {
        at(w.byId.get('aa'), x, y);
        w.byId.get('aa').invuln = 99;
        w.byId.get('bb').invuln = 99;
        w.bombs.push({ uid: 'x1', owner: 'bb', cellX: x, cellY: y, fuse: 0.04, range: 3, escape: false, byId: 'bb' });
        w.bombs.push({ uid: 'x2', owner: 'cc', cellX: x + 1, cellY: y, fuse: 30, range: 3, escape: false, byId: 'cc' });
        placed = true;
      }
  assert.ok(placed, 'arena must offer two adjacent empty cells');
  run(w, 0.3);
  assert.equal(w.bombs.length, 0, 'both bombs detonated');
});

/* ---------- elimination / winner ---------- */

test('last survivor wins; inputs stop mattering after the end', () => {
  const w = match();
  clear(w);
  const v = w.byId.get('bb');
  const c = cellOf(v);
  w.bombs.push({ uid: 'x1', owner: 'aa', cellX: c.x, cellY: c.y, fuse: 0.04, range: 1, escape: false, byId: 'aa' });
  run(w, 0.15);
  assert.equal(w.ended, true);
  assert.equal(w.winnerId, 'aa');
  assert.equal(w.applyIntent('aa', { type: 'bomb' }).ok, false);
  const s = w.snapshot();
  assert.ok(s.events.some((e) => e.type === 'matchOver' && e.winnerId === 'aa'));
});

test('mutual destruction in one tick is an explicit draw', () => {
  const w = match();
  clear(w);
  const a = w.byId.get('aa'), b = w.byId.get('bb');
  // adjacent cells so the centre kills one and the first arm tile kills the other
  let placed = false;
  for (let y = 1; y < ROWS - 1 && !placed; y++)
    for (let x = 1; x < COLS - 2 && !placed; x++)
      if (w.board[y][x] === T_EMPTY && w.board[y][x + 1] === T_EMPTY &&
          x >= 2 && !w.bombAtCell(x, y) && !w.bombAtCell(x + 1, y)) {
        at(a, x, y); at(b, x + 1, y); placed = true;
      }
  assert.ok(placed, 'arena must offer two adjacent cells');
  w.bombs.push({ uid: 'x1', owner: 'zz', cellX: cellOf(a).x, cellY: cellOf(a).y, fuse: 0.04, range: 1, escape: false, byId: null });
  run(w, 0.15);
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(w.ended, true);
  assert.equal(w.winnerId, null, 'draw, not a phantom winner');
});

test('contact with a bot eliminates the human without bot kill credit', () => {
  const w = match({ botCount: 1 });
  clear(w);
  const h = w.byId.get('aa');
  const bot = w.bots[0].actor;
  const c = cellOf(h);
  at(h, c.x, c.y);
  at(bot, c.x, c.y);                            // same cell → within contact radius
  run(w, 0.1);
  assert.equal(h.alive, false);
  assert.equal(w.byId.get('bot-1').kills, 0, 'bots never claim kill credit');
});

/* ---------- throwing ---------- */

test('throw needs the tosser, flies to the farthest valid tile, fuse starts on landing', () => {
  const w = match({ preset: 'open' });
  const a = w.byId.get('aa');
  assert.equal(w.applyIntent('aa', { type: 'throw' }).ok, false, 'no tosser → no throw');
  a.tosser = true;
  at(w.byId.get('bb'), 1, 1);                   // bystander far from the run
  const { x, y } = openRun(w);
  at(a, x, y);
  a.dir = { x: 1, y: 0 };
  a.invuln = 99;
  assert.ok(w.applyIntent('aa', { type: 'throw' }).ok);
  assert.equal(a.x, x * TILE + TILE / 2, 'owner stays put during flight');
  const bomb = w.bombs.find((b) => b.owner === 'aa');
  assert.ok(w.flights.length === 1);
  run(w, 0.3);                                  // 3 tiles × 0.09s
  assert.equal(w.flights.length, 0);
  assert.equal(bomb.cellX, x + 3);
  assert.equal(bomb.cellY, y);
  assert.ok(bomb.fuse <= 2.4 && bomb.fuse > 2.0, 'fuse only started on landing');
});

test('thrown bomb counts toward capacity while airborne', () => {
  const w = match({ preset: 'open' });
  const a = w.byId.get('aa');
  a.tosser = true;
  at(w.byId.get('bb'), 1, 1);
  const { x, y } = openRun(w);
  at(a, x, y); a.dir = { x: 1, y: 0 }; a.invuln = 99;
  assert.ok(w.applyIntent('aa', { type: 'throw' }).ok);
  run(w, 0.05);
  // step off the airborne bomb's tile, then try to place two more bombs:
  // capacity is 2 and the flight already consumes one slot
  const r2 = openRun(w, 2, 5);
  at(a, r2.x, r2.y);
  assert.ok(w.applyIntent('aa', { type: 'bomb' }).ok, 'one grounded bomb still allowed');
  assert.equal(w.applyIntent('aa', { type: 'bomb' }).ok, false, 'cap reached with airborne counted');
  assert.equal(w.bombs.filter((b) => b.owner === 'aa').length, 2, 'capacity respected mid-flight');
});

/* ---------- power-ups ---------- */

test('pickups go to exactly one actor: the nearest', () => {
  const w = match();
  const a = w.byId.get('aa'), b = w.byId.get('bb');
  const c = cellOf(a);
  at(a, c.x, c.y);
  w.pickups.push({ uid: 'p1', cellX: c.x, cellY: c.y, type: 'tosser' });
  // b parked one tile away, also inside grab radius at first — a is nearer
  at(b, c.x, c.y); b.x += 20;
  run(w, 0.1);
  assert.equal(w.pickups.length, 0);
  assert.equal(a.tosser, true);
  assert.equal(b.tosser, false, 'cannot be collected twice');
});

test('chaos bomb: permanent +1 range until MAX, then temporary, blast capped at 5', () => {
  const w = match();
  const a = w.byId.get('aa');
  a.bombRange = 4;
  const c = cellOf(a);
  w.pickups.push({ uid: 'p1', cellX: c.x, cellY: c.y, type: 'chaos' });
  run(w, 0.1);
  assert.equal(a.chaosTimer > 0, true);
  assert.ok(w.applyIntent('aa', { type: 'bomb' }).ok);
  assert.equal(w.bombs[w.bombs.length - 1].range, 5);
});

test('phantom drone zaps a nearby bot and credits the owner', () => {
  const w = match({ botCount: 1 });
  clear(w);
  const a = w.byId.get('aa');
  a.invuln = 99;                                 // keep the owner off the contact table
  const bot = w.bots[0].actor;
  const c = cellOf(a);
  at(bot, c.x, c.y);                             // bot parked on the owner
  a.drone = { x: bot.x, y: bot.y, life: 8, zapCd: 0 };
  run(w, 0.1);
  assert.equal(bot.alive, false);
  assert.equal(a.kills, 1);
});

/* ---------- bots ---------- */

test('hunter bot paths toward the nearest human and participates with bombs', () => {
  // ids sort so bot-1 lands at actor index 0 → hunter
  const w = sim.createMatch({
    arenaSeed: 'HUNT:3', preset: 'open',
    participants: [{ id: 'u1', name: 'U1' }, { id: 'u2', name: 'U2' }],
    botCount: 1,
  });
  const bot = w.bots[0];
  assert.equal(bot.brain.kind, 'hunter');
  const humans = [w.byId.get('u1'), w.byId.get('u2')];
  humans.forEach((h) => { h.invuln = 99; });     // survive the practice run
  bot.brain.botBombCd = Infinity;                // chase only, no suicide bombs
  const bc = () => ({ x: Math.floor(bot.actor.x / TILE), y: Math.floor(bot.actor.y / TILE) });
  const dist = () => Math.min(...humans.map((h) =>
    Math.abs(bc().x - Math.floor(h.x / TILE)) + Math.abs(bc().y - Math.floor(h.y / TILE))));
  const d0 = dist();
  let best = d0;
  for (let i = 0; i < 40; i++) { run(w, 0.1); best = Math.min(best, dist()); }
  assert.ok(best < d0, `hunter closed distance (${d0} → best ${best})`);
  assert.ok(bot.actor.alive, 'hunter survived its practice run');
  const c = cellOf(bot.actor);
  assert.equal(w.board[c.y][c.x], T_EMPTY, 'bot stayed on walkable tiles');
});

/* ---------- post-end hygiene ---------- */

test('after the match ends the sim freezes and broadcasts ended state', () => {
  const w = match();
  clear(w);
  const v = w.byId.get('bb');
  const c = cellOf(v);
  w.bombs.push({ uid: 'x1', owner: 'aa', cellX: c.x, cellY: c.y, fuse: 0.04, range: 1, escape: false, byId: 'aa' });
  run(w, 0.15);
  const before = JSON.stringify(w.snapshot());
  run(w, 2);
  const s = w.snapshot();
  assert.equal(s.ended, true);
  assert.equal(s.winnerId, 'aa');
  assert.equal(s.alive, 1);
  assert.ok(before.includes('matchOver'));
});
