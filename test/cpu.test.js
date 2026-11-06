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

test('어려운 컴퓨터: 긴 연속 묶음을 쪼개 손패를 끼우고, 4장 묶음에서 빌려 새 묶음을 만든다', async () => {
  const { rearrangePlays, planCpuTurn } = await import('../js/cpu.js');
  const t = (color, num, id) => ({ id, color, num, joker: false });
  // ① 빨강 3~8 + 손패 빨강 5 → 3-4-5 / 5-6-7-8
  const run = [3, 4, 5, 6, 7, 8].map((n, i) => t('red', n, 10 + i));
  const r1 = rearrangePlays([run], [t('red', 5, 1), t('black', 13, 2)]);
  assert.ok(r1.played); assert.equal(r1.table.length, 2); assert.equal(r1.rack.length, 1);
  assert.deepEqual(r1.table.map(s => s.length).sort(), [3, 4]);
  // ② 7 네 가지 색 묶음에서 파랑 7을 빌려 손패 파랑 8·9와 연속 묶음
  const grp = [t('red', 7, 20), t('blue', 7, 21), t('black', 7, 22), t('orange', 7, 23)];
  const r2 = rearrangePlays([grp], [t('blue', 8, 3), t('blue', 9, 4)]);
  assert.ok(r2.played); assert.equal(r2.table.length, 2); assert.equal(r2.rack.length, 0);
  // 보통 컴퓨터는 같은 상황에서 뽑는다
  assert.equal(planCpuTurn({ table: [grp], rack: [t('blue', 8, 3), t('blue', 9, 4)], hasMelded: true }).action, 'draw');
  assert.equal(planCpuTurn({ table: [grp], rack: [t('blue', 8, 3), t('blue', 9, 4)], hasMelded: true, level: 'hard' }).action, 'play');
});
