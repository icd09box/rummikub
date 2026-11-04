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

test('직전 차례 기록(lastTurn): 낸 타일·뽑기', () => {
  const g = createGame([{ name: 'A' }, { name: 'B' }], seeded);
  drawTile(g);
  assert.equal(g.lastTurn.name, 'A'); assert.equal(g.lastTurn.placed.length, 0); assert.equal(g.lastTurn.drew, true);
  // B에게 30점짜리 손패를 심어 낸다
  const p = current(g);
  const mk = (c, n, id) => ({ id, color: c, num: n, joker: false });
  p.rack = [mk('red', 10, 901), mk('blue', 10, 902), mk('black', 10, 903), mk('red', 1, 904)];
  g.snapshot.rack = p.rack.slice();
  moveTiles(g, [901, 902, 903], { kind: 'new' });
  assert.ok(endTurn(g).ok);
  assert.equal(g.lastTurn.name, 'B'); assert.equal(g.lastTurn.placed.length, 3); assert.equal(g.lastTurn.meldValue, 30);
  assert.match(g.log.at(-1), /빨강 10, 파랑 10, 검정 10/);
});
