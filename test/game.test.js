import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, runCpuTurn } from '../js/game.js';

const seeded = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42);

test('2~4인 제한', () => {
  assert.throws(() => createGame([{}]));
  assert.throws(() => createGame([{}, {}, {}, {}, {}]));
  assert.equal(createGame([{}, {}]).players.length, 2);
  assert.equal(createGame([{}, {}, {}, {}]).players.length, 4);
});

test('배분: 14장씩, 더미 = 106 - 14n', () => {
  const g = createGame([{}, {}, {}], seeded);
  assert.ok(g.players.every(p => p.rack.length === 14));
  assert.equal(g.pool.length, 106 - 42);
});

test('뽑기는 턴 중 변경을 되돌리고 다음 사람으로', () => {
  const g = createGame([{ name: 'A' }, { name: 'B' }], seeded);
  const p = current(g);
  moveTiles(g, [p.rack[0].id], { kind: 'new' });
  assert.equal(g.table.length, 1);
  drawTile(g);
  assert.equal(g.table.length, 0);
  assert.equal(g.players[0].rack.length, 15);
  assert.equal(current(g).name, 'B');
});

test('잘못된 턴 종료는 거부, 되돌리기 가능', () => {
  const g = createGame([{}, {}], seeded);
  const p = current(g);
  moveTiles(g, [p.rack[0].id], { kind: 'new' });
  assert.equal(endTurn(g).ok, false);
  resetTurn(g);
  assert.equal(p.rack.length, 14);
});

test('CPU만으로 게임이 끝까지 진행된다', () => {
  const g = createGame([{ type: 'cpu' }, { type: 'cpu' }, { type: 'cpu' }, { type: 'cpu' }], seeded);
  let guard = 2000;
  while (g.phase === 'playing' && guard-- > 0) runCpuTurn(g);
  assert.equal(g.phase, 'over');
  assert.notEqual(g.winner, null);
  const total = [...g.table.flat(), ...g.players.flatMap(p => p.rack), ...g.pool].length;
  assert.equal(total, 106);
});
