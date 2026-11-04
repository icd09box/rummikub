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
