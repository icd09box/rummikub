import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../js/host.js';

const seeded = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
function mkHost() {
  const sent = [];
  const timers = [];
  const h = new GameHost((seat, msg) => sent.push({ seat, msg }), {
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = () => {}; },
  });
  return { h, sent, timers, fire: () => { const t = timers.splice(0); t.forEach(x => x.f()); } };
}

test('로비: 사람 2 + CPU 1, 4명 초과 거부', () => {
  const { h, sent } = mkHost();
  assert.equal(h.addHuman('A', 'ta'), 0);
  assert.equal(h.addHuman('B', 'tb'), 1);
  assert.ok(h.addCpu()); assert.ok(h.addCpu());
  assert.equal(h.addHuman('E', 'te'), -1);
  assert.equal(sent.filter(x => x.msg.t === 'lobby').length > 0, true);
});

test('같은 토큰 재접속은 같은 자리', () => {
  const { h } = mkHost();
  h.addHuman('A', 'ta'); assert.equal(h.addHuman('A', 'ta'), 0); assert.equal(h.seats.length, 1);
});

test('시작 후 각자 자기 손패만 받음, 남 차례 행동 거부', () => {
  const { h, sent } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb');
  assert.ok(h.start(seeded));
  const states = sent.filter(x => x.msg.t === 'state');
  const vA = states.find(x => x.seat === 0).msg.view, vB = states.find(x => x.seat === 1).msg.view;
  assert.equal(vA.rack.length, 14); assert.equal(vB.rack.length, 14);
  assert.notDeepEqual(vA.rack.map(t => t.id), vB.rack.map(t => t.id));
  assert.equal(vB.players[0].rack, undefined);
  assert.equal(h.applyAction(1, { type: 'draw' }).ok, false);
  assert.equal(h.applyAction(0, { type: 'draw' }).ok, true);
  assert.equal(h.game.turn, 1);
});

test('테이블 타일을 손패로 가져오기 거부', () => {
  const { h } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb'); h.start(seeded);
  const g = h.game; const p = g.players[0];
  h.applyAction(0, { type: 'move', ids: [p.rack[0].id], to: { kind: 'new' } });
  assert.equal(g.table.length, 1);
  // 가짜: 스냅샷에 없는 id를 rack으로
  assert.equal(h.applyAction(0, { type: 'move', ids: [9999], to: { kind: 'rack' } }).ok, false);
  assert.equal(h.applyAction(0, { type: 'end' }).ok, false);
  h.applyAction(0, { type: 'reset' }); assert.equal(g.table.length, 0);
});

test('CPU 차례는 타이머로 자동 진행', () => {
  const { h, fire } = mkHost();
  h.addHuman('A', 'ta'); h.addCpu(); h.start(seeded);
  h.applyAction(0, { type: 'draw' });
  assert.equal(h.game.turn, 1);
  fire();
  assert.equal(h.game.turn, 0);
});

test('턴 제한시간 초과 시 자동 뽑기', () => {
  const { h, fire } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb'); h.setTurnLimit(60); h.start(seeded);
  assert.ok(h.deadline);
  fire();
  assert.equal(h.game.turn, 1);
  assert.match(h.game.log.at(-1) ?? h.game.log.at(-2), /뽑/);
});

test('끊긴 사람 차례는 자동 뽑기, 같은 이름으로 복귀', () => {
  const { h, fire } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb'); h.start(seeded);
  h.applyAction(0, { type: 'draw' });
  h.disconnect(1);
  fire();
  assert.equal(h.game.turn, 0);
  assert.equal(h.addHuman('B', 'tb2'), 1);
  assert.equal(h.game.players[1].connected, true);
});
