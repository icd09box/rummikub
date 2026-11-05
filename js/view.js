// 플레이어 1명 시점의 화면 상태(view). JSON으로 전송 가능해야 한다.
import { current, checkTurn } from './game.js';

const key = table => JSON.stringify(table.map(s => s.map(t => t.id)));

export function buildView(g, seat, extra = {}) {
  const me = g.players[seat];
  const changed = key(g.table) !== key(g.snapshot.table);
  return {
    seat,
    turn: g.turn,
    phase: g.phase,
    winner: g.winner,
    pool: g.pool.length,
    table: g.table,
    rack: me ? me.rack : [],
    newIds: g.snapshot.rack.map(t => t.id),              // 이번 턴 손패에서 나온 타일 표시용
    snapshotSetKeys: g.snapshot.table.map(s => s.map(t => t.id).sort().join(',')),
    changed,
    canUndo: !!(g.history && g.history.length),
    round: g.round || 1,
    check: changed && g.phase === 'playing' ? checkTurn(g) : null,
    players: g.players.map(p => ({
      name: p.name, type: p.type, count: p.rack.length, hasMelded: p.hasMelded,
      connected: p.connected !== false, score: p.score, total: p.total || 0,
      rack: g.phase === 'over' ? p.rack : undefined,
    })),
    log: g.log.slice(-30),
    lastTurn: g.lastTurn || null,
    currentName: current(g).name,
    ...extra,
  };
}
