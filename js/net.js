// PeerJS 연결 층. 방장: 코드 발급 + 참가자 연결 수신. 참가자: 코드로 접속(끊기면 자동 재접속).
import { GameHost } from './host.js';

const PREFIX = 'rummikub-ko-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeCode(len = 5) {
  let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
export function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function newPeer(id) {
  if (typeof Peer === 'undefined') throw new Error('PeerJS 로드 실패 (네트워크 확인)');
  return id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
}

/** 방장: 호스트 자신도 자리 0을 차지한다. 연결은 자리 번호가 아니라 토큰으로 묶는다(자리가 당겨져도 안전). */
export class HostSession {
  constructor({ name, onLobby, onState, onError, onReady, onStatus }) {
    this.code = makeCode();
    this.name = name;
    this.conns = new Map();   // token -> DataConnection
    this.onLobby = onLobby; this.onState = onState; this.onError = onError; this.onStatus = onStatus || (() => {});
    this.host = new GameHost((seat, msg) => this.deliver(seat, msg));
    this.mySeat = this.host.addHuman(name, 'host');
    this.destroyed = false;
    this.openPeer(onReady);
  }
  openPeer(onReady) {
    this.peer = newPeer(PREFIX + this.code);
    this.peer.on('open', () => { this.onStatus('ok'); onReady && onReady(this.code); });
    this.peer.on('error', e => {
      if (e.type === 'unavailable-id') { this.code = makeCode(); this.peer.destroy(); this.openPeer(onReady); }
      else this.onError && this.onError(e.type || String(e));
    });
    this.peer.on('disconnected', () => { if (!this.destroyed) { this.onStatus('reconnecting'); setTimeout(() => !this.destroyed && this.peer.reconnect(), 1000); } });
    this.peer.on('connection', conn => this.accept(conn));
  }
  seatOf(token) { return this.host.seats.findIndex(s => s.token === token); }
  accept(conn) {
    let token = null;
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'join') {
        token = String(msg.token || '') || makeToken();
        const old = this.conns.get(token);
        if (old && old !== conn) { try { old.close(); } catch {} }
        const seat = this.host.addHuman(String(msg.name || '').slice(0, 10) || '손님', token);
        if (seat < 0) { conn.send({ t: 'error', msg: '방이 가득 찼거나 게임이 진행 중입니다.' }); setTimeout(() => conn.close(), 300); token = null; return; }
        this.conns.set(token, conn);
        conn.send({ t: 'joined', seat, token });
        if (this.host.game) this.host.afterChange(); else this.host.broadcastLobby();
      } else if (msg.t === 'action' && token) {
        const seat = this.seatOf(token);
        if (seat < 0) return;
        const r = this.host.applyAction(seat, msg.action);
        if (!r.ok) conn.send({ t: 'error', msg: r.error });
      } else if (msg.t === 'ping' && token) {
        conn.send({ t: 'pong' });
      }
    });
    conn.on('close', () => {
      if (token && this.conns.get(token) === conn) { this.conns.delete(token); const seat = this.seatOf(token); if (seat >= 0) this.host.disconnect(seat); }
    });
    conn.on('error', () => {});
  }
  deliver(seat, msg) {
    if (seat === this.mySeat) { msg.t === 'lobby' ? this.onLobby(msg) : msg.t === 'state' && this.onState(msg.view); return; }
    const s = this.host.seats[seat]; if (!s || !s.token) return;
    const c = this.conns.get(s.token); if (c && c.open) { try { c.send(msg); } catch {} }
  }
  // 방장 조작
  addCpu() { this.host.addCpu(); }
  removeSeat(i) { const s = this.host.seats[i]; const c = s && this.conns.get(s.token); if (c) c.close(); this.host.removeSeat(i); }
  setTurnLimit(s) { this.host.setTurnLimit(s); }
  start() { return this.host.start(); }
  dispatch(action) { const r = this.host.applyAction(this.mySeat, action); if (!r.ok) this.onError(r.error); return r; }
  destroy() { this.destroyed = true; try { this.peer.destroy(); } catch {} }
}

/** 참가자: 연결이 끊기면 같은 토큰으로 자동 재접속(자리 복구) */
export class ClientSession {
  constructor({ code, name, token, onLobby, onState, onError, onJoined, onStatus }) {
    this.code = code.toUpperCase().trim();
    this.name = name;
    this.token = token || makeToken();
    this.mySeat = -1;
    this.onLobby = onLobby; this.onState = onState; this.onError = onError; this.onJoined = onJoined; this.onStatus = onStatus || (() => {});
    this.destroyed = false;
    this.attempt = 0;
    this.peer = newPeer();
    this.peer.on('open', () => this.connect());
    this.peer.on('disconnected', () => { if (!this.destroyed) setTimeout(() => !this.destroyed && this.peer.reconnect(), 1000); });
    this.peer.on('error', e => {
      if (e.type === 'peer-unavailable') { this.onStatus('reconnecting'); this.onError(this.attempt === 0 ? '해당 코드의 방을 찾을 수 없어요.' : '방장을 다시 찾는 중…'); this.scheduleReconnect(); }
      else this.onError(e.type || String(e));
    });
    // 화면이 다시 켜지면 즉시 연결 점검
    this.onVisible = () => { if (document.visibilityState === 'visible' && !this.isOpen()) this.reconnectNow(); };
    document.addEventListener('visibilitychange', this.onVisible);
    this.pingTimer = setInterval(() => { if (this.isOpen()) { try { this.conn.send({ t: 'ping' }); } catch {} } }, 15000);
  }
  isOpen() { return !!(this.conn && this.conn.open); }
  connect() {
    if (this.destroyed) return;
    this.attempt++;
    this.onStatus(this.attempt > 1 ? 'reconnecting' : 'connecting');
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    conn.on('open', () => { conn.send({ t: 'join', name: this.name, token: this.token }); });
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'joined') { this.mySeat = msg.seat; this.attempt = 1; this.onStatus('ok'); this.onJoined && this.onJoined(msg); }
      else if (msg.t === 'lobby') this.onLobby(msg);
      else if (msg.t === 'state') this.onState(msg.view);
      else if (msg.t === 'error') this.onError(msg.msg);
    });
    conn.on('close', () => { if (this.conn === conn) this.scheduleReconnect(); });
    conn.on('error', () => { if (this.conn === conn) this.scheduleReconnect(); });
  }
  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.onStatus('reconnecting');
    const delay = Math.min(1500 * Math.max(1, this.attempt), 8000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.reconnectNow(); }, delay);
  }
  reconnectNow() {
    if (this.destroyed) return;
    if (this.peer.disconnected) { this.peer.reconnect(); setTimeout(() => this.connect(), 800); }
    else this.connect();
  }
  dispatch(action) {
    if (!this.isOpen()) { this.onError('연결이 끊겨 다시 연결하는 중이에요. 잠시 후 다시 눌러 주세요.'); this.reconnectNow(); return; }
    try { this.conn.send({ t: 'action', action }); } catch { this.onError('보내기에 실패했어요. 다시 눌러 주세요.'); this.scheduleReconnect(); }
  }
  destroy() {
    this.destroyed = true;
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    try { this.peer.destroy(); } catch {}
  }
}
