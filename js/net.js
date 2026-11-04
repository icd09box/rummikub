// PeerJS 연결 층. 방장: 코드 발급 + 참가자 연결 수신. 참가자: 코드로 접속.
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

/** 방장: 호스트 자신도 자리 0을 차지한다. */
export class HostSession {
  constructor({ name, onLobby, onState, onError, onReady }) {
    this.code = makeCode();
    this.name = name;
    this.conns = new Map();   // seat -> DataConnection
    this.onLobby = onLobby; this.onState = onState; this.onError = onError;
    this.host = new GameHost((seat, msg) => this.deliver(seat, msg));
    this.mySeat = this.host.addHuman(name, 'host');
    this.peer = newPeer(PREFIX + this.code);
    this.peer.on('open', () => onReady && onReady(this.code));
    this.peer.on('error', e => {
      if (e.type === 'unavailable-id') { this.code = makeCode(); this.peer.destroy(); this.peer = newPeer(PREFIX + this.code); this.peer.on('open', () => onReady && onReady(this.code)); }
      else onError && onError(e.type || String(e));
    });
    this.peer.on('connection', conn => this.accept(conn));
  }
  accept(conn) {
    let seat = -1;
    conn.on('data', msg => {
      if (msg.t === 'join') {
        seat = this.host.addHuman(String(msg.name || '').slice(0, 10) || '손님', String(msg.token || ''));
        if (seat < 0) { conn.send({ t: 'error', msg: '방이 가득 찼거나 게임이 진행 중입니다.' }); setTimeout(() => conn.close(), 300); return; }
        this.conns.set(seat, conn);
        conn.send({ t: 'joined', seat, token: msg.token });
        if (this.host.game) this.host.afterChange(); else this.host.broadcastLobby();
      } else if (msg.t === 'action' && seat >= 0) {
        const r = this.host.applyAction(seat, msg.action);
        if (!r.ok) conn.send({ t: 'error', msg: r.error });
      }
    });
    conn.on('close', () => { if (seat >= 0 && this.conns.get(seat) === conn) { this.conns.delete(seat); this.host.disconnect(seat); } });
    conn.on('error', () => {});
  }
  deliver(seat, msg) {
    if (seat === this.mySeat) { msg.t === 'lobby' ? this.onLobby(msg) : msg.t === 'state' && this.onState(msg.view); return; }
    const c = this.conns.get(seat); if (c && c.open) c.send(msg);
  }
  // 방장 조작
  addCpu() { this.host.addCpu(); }
  removeSeat(i) { const c = this.conns.get(i); if (c) c.close(); this.host.removeSeat(i); }
  setTurnLimit(s) { this.host.setTurnLimit(s); }
  start() { return this.host.start(); }
  dispatch(action) { const r = this.host.applyAction(this.mySeat, action); if (!r.ok) this.onError(r.error); return r; }
  destroy() { try { this.peer.destroy(); } catch {} }
}

/** 참가자 */
export class ClientSession {
  constructor({ code, name, token, onLobby, onState, onError, onJoined, onClosed }) {
    this.code = code.toUpperCase().trim();
    this.token = token || makeToken();
    this.mySeat = -1;
    this.peer = newPeer();
    this.peer.on('open', () => {
      this.conn = this.peer.connect(PREFIX + this.code, { reliable: true });
      this.conn.on('open', () => this.conn.send({ t: 'join', name, token: this.token }));
      this.conn.on('data', msg => {
        if (msg.t === 'joined') { this.mySeat = msg.seat; onJoined && onJoined(msg); }
        else if (msg.t === 'lobby') onLobby(msg);
        else if (msg.t === 'state') onState(msg.view);
        else if (msg.t === 'error') onError(msg.msg);
      });
      this.conn.on('close', () => onClosed && onClosed());
      this.conn.on('error', e => onError(String(e)));
    });
    this.peer.on('error', e => onError(e.type === 'peer-unavailable' ? '해당 코드의 방을 찾을 수 없습니다.' : (e.type || String(e))));
  }
  dispatch(action) { if (this.conn && this.conn.open) this.conn.send({ t: 'action', action }); }
  destroy() { try { this.peer.destroy(); } catch {} }
}
