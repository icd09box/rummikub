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

test('한 수 취소: 직전 이동만 되돌리고, 처음대로 뒤엔 되돌릴 게 없다', () => {
  const { h } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb'); h.start(seeded);
  const g = h.game; const p = g.players[0];
  const [a, b] = p.rack;
  h.applyAction(0, { type: 'move', ids: [a.id], to: { kind: 'new' } });
  h.applyAction(0, { type: 'move', ids: [b.id], to: { kind: 'new' } });
  assert.equal(g.table.length, 2);
  assert.ok(h.applyAction(0, { type: 'undo' }).ok);
  assert.equal(g.table.length, 1); assert.equal(p.rack.length, 13);
  h.applyAction(0, { type: 'reset' });
  assert.equal(h.applyAction(0, { type: 'undo' }).ok, false);
  assert.equal(g.table.length, 0); assert.equal(p.rack.length, 14);
});

test('같은 사람들과 다음 판: 누적 점수와 판 수가 이어진다', () => {
  const { h, sent } = mkHost();
  h.addHuman('A', 'ta'); h.addCpu(); h.start(seeded);
  assert.equal(h.rematch(), false);                 // 진행 중엔 불가
  // 강제 종료: A가 다 낸 것으로
  const g = h.game; g.players[0].rack = []; g.players[1].rack = g.players[1].rack.slice(0, 2);
  g.phase = 'over'; g.winner = 0; g.players[0].score = 15; g.players[1].score = -15; g.players[0].total = 15; g.players[1].total = -15;
  assert.ok(h.rematch(seeded));
  assert.equal(h.game.phase, 'playing'); assert.equal(h.game.round, 2);
  assert.equal(h.game.players[0].total, 15); assert.equal(h.game.players[1].total, -15);
  const v = sent.filter(x => x.msg.t === 'state').at(-1).msg.view;
  assert.equal(v.round, 2); assert.equal(v.players[0].total, 15); assert.equal(v.rack.length, 14);
});

test('저장·복구: 같은 판·같은 자리로 되살리고 참가자는 끊김 상태로 시작', () => {
  const { h } = mkHost();
  let saved = null; h.onPersist = s => { saved = JSON.parse(JSON.stringify(s)); };
  h.addHuman('방장', 'host'); h.addHuman('B', 'tb'); h.addCpu(); h.start(seeded);
  h.applyAction(0, { type: 'draw' });
  assert.ok(saved && saved.game && saved.game.turn === 1);
  const { h: h2, sent } = mkHost();
  h2.restore(saved);
  assert.equal(h2.seats.length, 3); assert.equal(h2.game.turn, 1);
  assert.equal(h2.seats[0].connected, true); assert.equal(h2.seats[1].connected, false); assert.equal(h2.seats[2].connected, true);
  assert.deepEqual(h2.game.players[0].rack.map(t => t.id), h.game.players[0].rack.map(t => t.id));
  assert.ok(sent.some(x => x.msg.t === 'state'));
  // B가 같은 토큰으로 돌아오면 같은 자리
  assert.equal(h2.addHuman('B', 'tb'), 1); assert.equal(h2.seats[1].connected, true);
});

test('이모지 반응: 남의 차례에도 보내지고 모두에게 전달, 1.5초 안 연타는 무시', () => {
  const { h, sent } = mkHost();
  h.addHuman('A', 'ta'); h.addHuman('B', 'tb'); h.start(seeded);
  assert.ok(h.applyAction(1, { type: 'react', emoji: '👍' }).ok);
  const v = sent.filter(x => x.msg.t === 'state' && x.seat === 0).at(-1).msg.view;
  assert.equal(v.reaction.emoji, '👍'); assert.equal(v.reaction.seat, 1);
  const n = sent.length;
  h.applyAction(1, { type: 'react', emoji: '🔥' });
  assert.equal(sent.length, n);  // 연타 무시
  assert.equal(h.applyAction(1, { type: 'react', emoji: '💩' }).ok, false);
  assert.equal(h.game.turn, 0);  // 차례는 그대로
});

test('게임 중 들어온 사람은 구경꾼, 다음 판부터 자리를 받고 승수가 이어진다', () => {
  const { h, sent } = mkHost();
  h.addHuman('A', 'ta'); h.addCpu('hard'); h.start(seeded);
  assert.equal(h.seats[1].name, '컴퓨터 1 (어려움)'); assert.equal(h.game.players[1].level, 'hard');
  assert.equal(h.addHuman('C', 'tc'), -2);
  assert.equal(h.watchers.length, 1);
  const w = sent.filter(x => x.seat === 'tc' && x.msg.t === 'state').at(-1);
  assert.ok(w && w.msg.view.watching === true && w.msg.view.rack.length === 0 && w.msg.view.players.length === 2);
  assert.equal(h.applyAction(-1, { type: 'draw' }).ok, false);
  // A 승리 처리 후 다음 판
  const g = h.game; g.players[0].rack = []; g.phase = 'over'; g.winner = 0; g.players[0].wins = 1;
  assert.ok(h.rematch(seeded));
  assert.equal(h.seats.length, 3); assert.equal(h.seats[2].name, 'C'); assert.equal(h.watchers.length, 0);
  assert.equal(h.game.players[0].wins, 1); assert.equal(h.game.players[2].rack.length, 14);
  const vC = sent.filter(x => x.seat === 2 && x.msg.t === 'state').at(-1).msg.view;
  assert.equal(vC.watching, false); assert.equal(vC.players[0].wins, 1);
});
