import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCpuTurn } from '../js/cpu.js';
import { validateTurn } from '../js/rules.js';

let id = 1;
const T = (color, num) => ({ id: id++, color, num, joker: false });

test('CPU 초기 등록: 30점 미만이면 뽑기', () => {
  const rack = [T('red', 1), T('red', 2), T('red', 3), T('blue', 5)];
  assert.equal(planCpuTurn({ table: [], rack, hasMelded: false }).action, 'draw');
});

test('CPU 초기 등록: 30점 이상이면 내려놓고 검증 통과', () => {
  const rack = [T('red', 11), T('red', 12), T('red', 13), T('blue', 5)];
  const r = planCpuTurn({ table: [], rack, hasMelded: false });
  assert.equal(r.action, 'play');
  assert.ok(validateTurn({ tableBefore: [], tableAfter: r.table, rackBefore: rack, rackAfter: r.rack, hasMelded: false }).ok);
});

test('CPU 등록 후: 테이블 세트에 덧붙이기', () => {
  const table = [[T('red', 5), T('red', 6), T('red', 7)]];
  const rack = [T('red', 8), T('black', 2)];
  const r = planCpuTurn({ table, rack, hasMelded: true });
  assert.equal(r.action, 'play');
  assert.equal(r.table[0].length, 4);
  assert.ok(validateTurn({ tableBefore: table, tableAfter: r.table, rackBefore: rack, rackAfter: r.rack, hasMelded: true }).ok);
});
