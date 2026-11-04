// 게임 상태 머신. DOM 몰라도 되는 순수 로직.
import { createTiles, shuffle, validateTurn, rackPenalty, HAND_SIZE } from './rules.js';
import { planCpuTurn } from './cpu.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export function createGame(playerDefs, rng = Math.random) {
  if (playerDefs.length < MIN_PLAYERS || playerDefs.length > MAX_PLAYERS) {
    throw new Error(`플레이어는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`);
  }
  const pool = shuffle(createTiles(), rng);
  const players = playerDefs.map((d, i) => ({
    id: i,
    name: d.name || `플레이어 ${i + 1}`,
    type: d.type === 'cpu' ? 'cpu' : 'human',
    rack: pool.splice(0, HAND_SIZE),
    hasMelded: false,
    score: 0,
  }));
  const g = {
    players, pool, table: [], turn: 0,
    phase: 'playing', // playing | over
    winner: null,
    log: [],
    snapshot: null,
  };
  beginTurn(g);
  return g;
}

export function current(g) { return g.players[g.turn]; }

function beginTurn(g) {
  const p = current(g);
  g.snapshot = { table: g.table.map(s => s.slice()), rack: p.rack.slice() };
}

/** 턴 시작 상태로 되돌리기 */
export function resetTurn(g) {
  const p = current(g);
  g.table = g.snapshot.table.map(s => s.slice());
  p.rack = g.snapshot.rack.slice();
}

/** 타일 이동: from/to = {kind:'rack'} | {kind:'set', index} | {kind:'new'} */
export function moveTiles(g, tileIds, to) {
  const p = current(g);
  const ids = new Set(tileIds);
  const moving = [];
  p.rack = p.rack.filter(t => (ids.has(t.id) ? (moving.push(t), false) : true));
  g.table = g.table.map(s => s.filter(t => (ids.has(t.id) ? (moving.push(t), false) : true)));
  if (to.kind === 'rack') p.rack.push(...moving);
  else if (to.kind === 'new') g.table.push(moving);
  else g.table[to.index].push(...moving);
  g.table = g.table.filter(s => s.length > 0);
}

/** 현재 턴 검증 결과 (끝내기 전 미리보기용) */
export function checkTurn(g) {
  const p = current(g);
  return validateTurn({
    tableBefore: g.snapshot.table, tableAfter: g.table,
    rackBefore: g.snapshot.rack, rackAfter: p.rack, hasMelded: p.hasMelded,
  });
}

/** 턴 종료 시도. 반환 { ok, reason } */
export function endTurn(g) {
  const p = current(g);
  const r = checkTurn(g);
  if (!r.ok) return r;
  const placedIds = new Set(g.snapshot.rack.filter(t => !p.rack.includes(t)).map(t => t.id));
  const placed = g.table.flat().filter(t => placedIds.has(t.id));
  const names = placed.map(tileLabel).join(', ');
  g.lastTurn = { seat: p.id, name: p.name, placed, meldValue: p.hasMelded ? null : r.meldValue, rearranged: tableRearranged(g.snapshot.table, g.table, placedIds) };
  if (!p.hasMelded) { p.hasMelded = true; g.log.push(`${p.name} 처음 30점 내기 성공 (${r.meldValue}점): ${names}`); }
  else g.log.push(`${p.name} 냄: ${names}`);
  if (p.rack.length === 0) return finish(g, p);
  advance(g);
  return { ok: true };
}

/** 뽑기(=패스). 턴 중 변경은 되돌린다. */
export function drawTile(g) {
  const p = current(g);
  resetTurn(g);
  g.lastTurn = { seat: p.id, name: p.name, placed: [], drew: g.pool.length > 0 };
  if (g.pool.length > 0) { p.rack.push(g.pool.shift()); g.log.push(`${p.name} 한 장 뽑음`); }
  else g.log.push(`${p.name} 넘김 (남은 타일 없음)`);
  if (g.pool.length === 0 && g.players.every(x => x._passedEmpty)) return finishByPenalty(g);
  if (g.pool.length === 0) p._passedEmpty = true;
  advance(g);
  return { ok: true };
}

const COLOR_KO = { red: '빨강', blue: '파랑', black: '검정', orange: '주황' };
export function tileLabel(t) { return t.joker ? '조커' : `${COLOR_KO[t.color]} ${t.num}`; }
/** 기존 묶음을 다시 짰는지(새 타일만 더한 게 아닌지) */
function tableRearranged(before, after, placedIds) {
  const key = s => s.map(t => t.id).sort().join(',');
  const beforeKeys = new Set(before.map(key));
  return after.some(s => { const rest = s.filter(t => !placedIds.has(t.id)); return rest.length > 0 && !beforeKeys.has(key(rest)) && !beforeKeys.has(key(s)); });
}
function advance(g) {
  g.turn = (g.turn + 1) % g.players.length;
  beginTurn(g);
}

function finish(g, winner) {
  g.phase = 'over'; g.winner = winner.id;
  let total = 0;
  for (const p of g.players) if (p !== winner) { const pen = rackPenalty(p.rack); p.score = -pen; total += pen; }
  winner.score = total;
  g.log.push(`${winner.name} 승리!`);
  return { ok: true, over: true };
}

function finishByPenalty(g) {
  // 더미가 비고 모두 연속 패스: 손패 점수 최저가 승리
  const sorted = g.players.slice().sort((a, b) => rackPenalty(a.rack) - rackPenalty(b.rack));
  const winner = sorted[0];
  g.phase = 'over'; g.winner = winner.id;
  for (const p of g.players) p.score = -(rackPenalty(p.rack) - rackPenalty(winner.rack));
  winner.score = g.players.filter(p => p !== winner).reduce((s, p) => s - p.score, 0);
  g.log.push(`남은 타일 없음 — ${winner.name} 타일 점수가 가장 낮아 승리`);
  return { ok: true, over: true };
}

/** CPU 턴 실행 */
export function runCpuTurn(g) {
  const p = current(g);
  const plan = planCpuTurn({ table: g.table, rack: p.rack, hasMelded: p.hasMelded });
  if (plan.action === 'draw') return drawTile(g);
  g.table = plan.table; p.rack = plan.rack;
  const r = endTurn(g);
  if (!r.ok) { resetTurn(g); return drawTile(g); } // 안전망
  return r;
}
