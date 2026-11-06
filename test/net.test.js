// PeerJS를 메모리 내 가짜로 대체해 방장↔참가자 흐름을 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';

const peers = new Map();
class FakeConn {
  constructor() { this.h = {}; this.open = false; this.peerSide = null; }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.h[ev] || []).forEach(f => f(...a)); }
  send(msg) { const m = JSON.parse(JSON.stringify(msg)); queueMicrotask(() => this.peerSide.emit('data', m)); }
  close() { if (!this.open) return; this.open = false; this.peerSide.open = false; const o = this.peerSide; queueMicrotask(() => { this.emit('close'); o.emit('close'); }); }
}
class FakePeer {
  constructor(id) { this.id = id || 'anon' + Math.random(); this.h = {}; this.disconnected = false; peers.set(this.id, this); queueMicrotask(() => this.emit('open')); }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.h[ev] || []).forEach(f => f(...a)); }
  connect(id) {
    const a = new FakeConn(), b = new FakeConn(); a.peerSide = b; b.peerSide = a;
    queueMicrotask(() => { const host = peers.get(id); if (!host) { this.emit('error', { type: 'peer-unavailable' }); return; } a.open = b.open = true; host.emit('connection', b); a.emit('open'); });
    return a;
  }
  reconnect() { this.disconnected = false; }
  destroy() { peers.delete(this.id); }
}
globalThis.Peer = FakePeer;
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const tick = (n = 20) => new Promise(r => { let i = 0; const f = () => (++i >= n ? r() : queueMicrotask(f)); f(); });

const { HostSession, ClientSession } = await import('../js/net.js');

function mkClient(code, name, token) {
  const c = { views: [], lobbies: [], errors: [], seat: -1 };
  c.s = new ClientSession({ code, name, token, onLobby: l => c.lobbies.push(l), onState: v => c.views.push(v), onError: e => c.errors.push(e), onJoined: j => { c.seat = j.seat; } });
  return c;
}

test('로비에서 한 명 나간 뒤 들어온 4번째도 제자리에서 행동이 먹는다', async () => {
  const h = { views: [], errors: [] };
  const host = new HostSession({ name: '방장', onLobby() {}, onState: v => h.views.push(v), onError: e => h.errors.push(e) });
  await tick();
  const code = host.code;
  const a = mkClient(code, 'A', 'ta'), b = mkClient(code, 'B', 'tb');
  await tick(60);
  assert.equal(a.seat, 1); assert.equal(b.seat, 2);
  a.s.destroy(); a.s.conn.close(); await tick(60);          // A 퇴장 → B가 자리 1로 당겨짐
  assert.equal(host.host.seats.length, 2);
  const c = mkClient(code, 'C', 'tc'), d = mkClient(code, 'D', 'td');
  await tick(60);
  assert.equal(host.host.seats.map(s => s.name).join(','), '방장,B,C,D');
  host.start(); await tick(60);
  // 각자 받은 view.seat 이 실제 자리와 같아야 함
  assert.equal(b.views.at(-1).seat, 1); assert.equal(c.views.at(-1).seat, 2); assert.equal(d.views.at(-1).seat, 3);
  // 차례대로 뽑기: 방장 → B → C → D
  host.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 1);
  b.s.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 2, 'B의 뽑기가 자리 1로 처리돼야 함');
  c.s.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 3);
  d.s.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 0);
  assert.deepEqual([b, c, d].map(x => x.errors.length), [0, 0, 0]);
  [b, c, d].forEach(x => x.s.destroy()); host.destroy();
});

test('연결이 끊기면 같은 토큰으로 자동 재접속해 자리를 되찾고 행동이 다시 먹는다', async () => {
  const host = new HostSession({ name: '방장', onLobby() {}, onState() {}, onError() {} });
  await tick();
  const a = mkClient(host.code, 'A', 'ta');
  await tick(60);
  host.start(); await tick(40);
  host.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 1);
  // 끊김
  a.s.conn.close(); await tick(40);
  assert.equal(host.host.game.players[1].connected, false);
  // 재접속 타이머 대신 즉시
  a.s.reconnectNow(); await tick(80);
  assert.equal(host.host.game.players[1].connected, true);
  a.s.dispatch({ type: 'draw' }); await tick(40);
  assert.equal(host.host.game.turn, 0);
  a.s.destroy(); host.destroy();
});

test('온라인: 추천대로 내기와 같은 순서의 move 묶음이 방장에서 정상 처리된다', async () => {
  const { planCpuTurn } = await import('../js/cpu.js');
  const host = new HostSession({ name: '방장', onLobby() {}, onState() {}, onError() {} });
  await tick();
  const a = mkClient(host.code, 'A', 'ta'); await tick(60);
  host.addCpu(); host.start(); await tick(40);
  // 방장 차례: 손패를 30점짜리로 교체
  const g = host.host.game; const p = g.players[0];
  const mk = (c, n, id) => ({ id, color: c, num: n, joker: false });
  p.rack = [mk('red', 10, 901), mk('blue', 10, 902), mk('black', 10, 903), mk('red', 1, 904)]; g.snapshot.rack = p.rack.slice();
  const plan = planCpuTurn({ table: g.table, rack: p.rack, hasMelded: false });
  assert.equal(plan.action, 'play');
  host.dispatch({ type: 'move', ids: [901, 902, 903], to: { kind: 'new' } });
  const r = host.dispatch({ type: 'end' });
  assert.ok(r.ok); assert.equal(g.players[0].hasMelded, true);
  a.s.destroy(); host.destroy();
});

test('방장 저장본: 게임 중엔 localStorage에 남고, 복구하면 같은 코드로 참가자가 돌아온다', async () => {
  const store = new Map();
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const { loadHostSave } = await import('../js/net.js');
  const host = new HostSession({ name: '방장', storage, onLobby() {}, onState() {}, onError() {} });
  await tick();
  const c = mkClient(host.code, 'B', 'tokB'); await tick();
  host.addCpu(); host.start(); await tick();
  const save = loadHostSave(storage);
  assert.ok(save && save.code === host.code && save.state.game.phase === 'playing');
  // 방장이 새로고침: 옛 peer 사라짐(저장본은 남아야 함)
  host.peer.destroy(); host.destroyed = true;
  assert.ok(loadHostSave(storage));
  const views = [];
  const host2 = new HostSession({ name: '방장', storage, restore: save, onLobby() {}, onState: v => views.push(v), onError() {} });
  await tick();
  assert.equal(host2.code, host.code);
  assert.equal(host2.host.seats[1].connected, false);
  // 참가자 재접속(같은 토큰) → 자리 1 복구, 상태 수신
  c.s.reconnectNow(); await tick(40);
  assert.equal(c.seat, 1);
  assert.equal(host2.host.seats[1].connected, true);
  assert.ok(c.views.at(-1).rack.length === 14);
  host2.destroy(); c.s.destroy();
  assert.equal(loadHostSave(storage), null);
});

test('구경꾼: 게임 중 참가하면 자리 -1로 들어와 상태를 받고, 나가면 목록에서 빠진다', async () => {
  const host = new HostSession({ name: '방장', onLobby() {}, onState() {}, onError() {} });
  await tick();
  const b = mkClient(host.code, 'B', 'tokB'); await tick();
  host.start(); await tick();
  const c = mkClient(host.code, 'C', 'tokC'); await tick(40);
  assert.equal(c.seat, -1); assert.ok(c.s.watching);
  assert.ok(c.views.at(-1).watching);
  assert.deepEqual(b.views.at(-1).watchers, ['C']);
  c.s.conn.close(); c.s.destroy(); await tick(40);   // 가짜 Peer는 destroy가 연결을 안 닫아 직접 닫음
  assert.deepEqual(b.views.at(-1).watchers, []);
  host.destroy(); b.s.destroy();
});
