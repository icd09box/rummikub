import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTiles, analyzeGroup, analyzeRun, analyzeSet, validateTurn, rackPenalty } from '../js/rules.js';

const T = (color, num, id = Math.random()) => ({ id, color, num, joker: false });
const J = (id = Math.random()) => ({ id, color: null, num: 0, joker: true });

test('106장, 조커 2장', () => {
  const t = createTiles();
  assert.equal(t.length, 106);
  assert.equal(t.filter(x => x.joker).length, 2);
  assert.equal(new Set(t.map(x => x.id)).size, 106);
});

test('그룹: 같은 숫자 다른 색 3~4장', () => {
  assert.ok(analyzeGroup([T('red', 7), T('blue', 7), T('black', 7)]).ok);
  assert.equal(analyzeGroup([T('red', 7), T('blue', 7), T('black', 7), T('orange', 7)]).value, 28);
  assert.equal(analyzeGroup([T('red', 7), T('red', 7), T('black', 7)]).ok, false);
  assert.equal(analyzeGroup([T('red', 7), T('blue', 8), T('black', 7)]).ok, false);
  assert.equal(analyzeGroup([T('red', 7), T('blue', 7)]).ok, false);
  assert.equal(analyzeGroup([T('red', 7), T('blue', 7), J()]).value, 21);
  assert.equal(analyzeGroup([J(), J(), T('red', 7)]).value, 21);
});

test('런: 같은 색 연속 3장 이상, 순환 금지', () => {
  assert.equal(analyzeRun([T('red', 3), T('red', 1), T('red', 2)]).value, 6);
  assert.equal(analyzeRun([T('red', 1), T('red', 2), T('blue', 3)]).ok, false);
  assert.equal(analyzeRun([T('red', 12), T('red', 13), T('red', 1)]).ok, false);
  assert.equal(analyzeRun([T('red', 1), T('red', 1), T('red', 2)]).ok, false);
});

test('런 + 조커: 빈칸 채움, 남으면 끝에', () => {
  const r = analyzeRun([T('red', 5), J(), T('red', 7)]);
  assert.ok(r.ok); assert.equal(r.value, 18);
  assert.ok(r.ordered[1].joker);
  const top = analyzeRun([T('red', 12), T('red', 13), J()]);
  assert.ok(top.ok); assert.equal(top.value, 36); assert.ok(top.ordered[0].joker); // 11,12,13
  assert.equal(analyzeRun([T('red', 5), J(), T('red', 9)]).ok, false); // 빈칸 3개
  assert.equal(analyzeRun([T('red', 1), J(), T('red', 5), J()]).ok, false);
});

test('손패 감점: 조커 30', () => {
  assert.equal(rackPenalty([T('red', 5), J()]), 35);
});

function ids(arr) { let i = 1; return arr.map(t => ({ ...t, id: i++ })); }

test('턴 검증: 초기 등록 30점 미달', () => {
  const rack = ids([T('red', 1), T('red', 2), T('red', 3), T('blue', 9)]);
  const set = rack.slice(0, 3);
  const r = validateTurn({ tableBefore: [], tableAfter: [set], rackBefore: rack, rackAfter: [rack[3]], hasMelded: false });
  assert.equal(r.ok, false); assert.match(r.reason, /30점/);
});

test('턴 검증: 초기 등록 성공 (두 세트 합산)', () => {
  const rack = ids([T('red', 10), T('blue', 10), T('black', 10), T('orange', 1), T('orange', 2), T('orange', 3), T('red', 5)]);
  const r = validateTurn({ tableBefore: [], tableAfter: [rack.slice(0, 3), rack.slice(3, 6)], rackBefore: rack, rackAfter: [rack[6]], hasMelded: false });
  assert.ok(r.ok); assert.equal(r.meldValue, 36); assert.equal(r.placed, 6);
});

test('턴 검증: 초기 등록 전 테이블 세트 사용 금지', () => {
  const table = ids([T('red', 10), T('blue', 10), T('black', 10)]);
  const rack = [{ ...T('orange', 10), id: 50 }, { ...T('red', 1), id: 51 }];
  const r = validateTurn({ tableBefore: [table], tableAfter: [[...table, rack[0]]], rackBefore: rack, rackAfter: [rack[1]], hasMelded: false });
  assert.equal(r.ok, false); assert.match(r.reason, /초기 등록 전/);
});

test('턴 검증: 등록 후 테이블 재배열 허용', () => {
  const table = ids([T('red', 10), T('blue', 10), T('black', 10), T('orange', 10)]);
  const rack = [{ ...T('orange', 11), id: 50 }, { ...T('orange', 12), id: 51 }, { ...T('red', 1), id: 52 }];
  const after = [table.slice(0, 3), [table[3], rack[0], rack[1]]];
  const r = validateTurn({ tableBefore: [table], tableAfter: after, rackBefore: rack, rackAfter: [rack[2]], hasMelded: true });
  assert.ok(r.ok); assert.equal(r.placed, 2);
});

test('턴 검증: 아무것도 안 놓음 / 테이블 타일 회수 / 깨진 세트', () => {
  const table = ids([T('red', 10), T('blue', 10), T('black', 10)]);
  const rack = [{ ...T('red', 1), id: 50 }];
  assert.equal(validateTurn({ tableBefore: [table], tableAfter: [table], rackBefore: rack, rackAfter: rack, hasMelded: true }).ok, false);
  assert.match(validateTurn({ tableBefore: [table], tableAfter: [table.slice(0, 2)], rackBefore: rack, rackAfter: [rack[0], table[2]], hasMelded: true }).reason, /손패로/);
  assert.match(validateTurn({ tableBefore: [table], tableAfter: [[...table, rack[0]]], rackBefore: rack, rackAfter: [], hasMelded: true }).reason, /유효하지/);
});

test('canExtend: 미완성 세트에도 붙일 수 있는지', async () => {
  const { canExtend } = await import('../js/rules.js');
  assert.ok(canExtend([T('red', 5)], [T('red', 6)]));            // 런 진행 중
  assert.ok(canExtend([T('red', 5), T('red', 7)], [T('red', 6)]));
  assert.equal(canExtend([T('red', 5)], [T('red', 7)]), false);   // 빈칸, 조커 없음
  assert.ok(canExtend([T('red', 5), J()], [T('red', 7)]));        // 조커가 6
  assert.ok(canExtend([T('red', 5)], [T('blue', 5)]));            // 그룹 진행 중
  assert.equal(canExtend([T('red', 5)], [T('red', 5)]), false);
  assert.equal(canExtend([T('red', 5), T('blue', 5), T('black', 5), T('orange', 5)], [J()]), false);
  assert.equal(canExtend([T('red', 5), T('red', 6)], [T('blue', 7)]), false);
});
