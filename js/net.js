// PeerJS 연결 층. 방장: 코드 발급 + 참가자 연결 수신. 참가자: 코드로 접속(끊기면 자동 재접속).
import { GameHost, WATCHER } from './host.js';
import { APP_VERSION } from './version.js';
export const IDLE_MS = 30 * 60 * 1000;

const PREFIX = 'rummikub-ko-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeCode(len = 5) {
  let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
export function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// STUN만으로는 LTE/5G·회사 와이파이 사이에 직결이 안 되는 경우가 있어 공개 TURN 중계를 함께 둔다.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
function newPeer(id) {
  if (typeof Peer === 'undefined') throw new Error('PeerJS 로드 실패 (네트워크 확인)');
  const opts = { debug: 1, config: { iceServers: ICE_SERVERS } };
  return id ? new Peer(id, opts) : new Peer(opts);
}

const SAVE_KEY = 'rummi-host-save';
/** 방장 새로고침 복구용 저장본 읽기(2시간 지난 건 버림) */
export function loadHostSave(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(SAVE_KEY); if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.code || !d.state || Date.now() - (d.state.savedAt || 0) > 2 * 3600 * 1000) return null;
    return d;
  } catch { return null; }
}
export function clearHostSave(storage = globalThis.localStorage) { try { storage && storage.removeItem(SAVE_KEY); } catch {} }

/** 방장: 호스트 자신도 자리 0을 차지한다. 연결은 자리 번호가 아니라 토큰으로 묶는다(자리가 당겨져도 안전). */
export class HostSession {
  /** restore: loadHostSave()가 돌려준 저장본을 넣으면 같은 코드·같은 판으로 되살린다 */
  constructor({ name, onLobby, onState, onError, onReady, onStatus, onIdle, restore = null, storage = globalThis.localStorage }) {
    this.code = restore ? restore.code : makeCode();
    this.restoring = !!restore;
    this.name = name;
    this.storage = storage;
    this.conns = new Map();   // token -> DataConnection
    this.onLobby = onLobby; this.onState = onState; this.onError = onError; this.onStatus = onStatus || (() => {});
    this.host = new GameHost((seat, msg) => this.deliver(seat, msg));
    this.host.onPersist = state => this.save(state);
    if (restore) { this.mySeat = 0; this.host.restore(restore.state); }
    else this.mySeat = this.host.addHuman(name, 'host');
    this.destroyed = false;
    this.onIdle = onIdle || (() => {});
    this.touch();
    this.openPeer(onReady);
  }
  /** 마지막 움직임 시각 갱신. 30분 조용하면 onIdle */
  touch() {
    this.lastActive = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.destroyed) this.onIdle(); }, IDLE_MS);
    if (this.idleTimer && this.idleTimer.unref) this.idleTimer.unref();   // 테스트(node)에서 프로세스를 붙잡지 않게
  }
  save(state) {
    if (this.destroyed || !this.storage) return;
    try {
      if (state.game && state.game.phase === 'playing') this.storage.setItem(SAVE_KEY, JSON.stringify({ code: this.code, name: this.name, state }));
      else this.storage.removeItem(SAVE_KEY);
    } catch {}
  }
  openPeer(onReady) {
    this.peer = newPeer(PREFIX + this.code);
    this.peer.on('open', () => { this.onStatus('ok'); onReady && onReady(this.code); });
    this.peer.on('error', e => {
      if (e.type === 'unavailable-id') {
        // 복구 중 옛 코드가 아직 서버에 남아 있으면 잠시 뒤 다시 시도(코드를 바꾸면 참가자가 못 찾는다)
        if (this.restoring) {
          this.retries = (this.retries || 0) + 1;
          if (this.retries > 3) { this.onError && this.onError('이 방 코드가 다른 탭이나 기기에서 이미 열려 있어요. 그쪽을 닫고 다시 시도하세요.'); return; }
          this.peer.destroy(); setTimeout(() => !this.destroyed && this.openPeer(onReady), 2000); return;
        }
        this.code = makeCode(); this.peer.destroy(); this.openPeer(onReady);
      }
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
        if (msg.v && msg.v !== APP_VERSION) conn.send({ t: 'version', host: APP_VERSION, mine: msg.v });
        const old = this.conns.get(token);
        if (old && old !== conn) { try { old.close(); } catch {} }
        const seat = this.host.addHuman(String(msg.name || '').slice(0, 10) || '손님', token);
        if (seat === -1) { conn.send({ t: 'error', msg: '방이 가득 찼어요 (최대 4명).' }); setTimeout(() => conn.close(), 300); token = null; return; }
        this.conns.set(token, conn);
        conn.send({ t: 'joined', seat: seat === WATCHER ? -1 : seat, token, watching: seat === WATCHER });
        if (this.host.game) this.host.afterChange(); else this.host.broadcastLobby();
      } else if (msg.t === 'action' && token) {
        this.touch();
        const seat = this.seatOf(token);
        if (seat < 0) return;
        const r = this.host.applyAction(seat, msg.action);
        if (!r.ok) conn.send({ t: 'error', msg: r.error });
      } else if (msg.t === 'ping' && token) {
        conn.send({ t: 'pong' });
      }
    });
    conn.on('close', () => {
      if (token && this.conns.get(token) === conn) { this.conns.delete(token); const seat = this.seatOf(token); if (seat >= 0) this.host.disconnect(seat); else this.host.removeWatcher(token); }
    });
    conn.on('error', () => {});
  }
  deliver(seat, msg) {
    if (seat === this.mySeat) { msg.t === 'lobby' ? this.onLobby(msg) : msg.t === 'state' && this.onState(msg.view); return; }
    const token = typeof seat === 'string' ? seat : (this.host.seats[seat] || {}).token;   // 구경꾼은 토큰으로 직접
    if (!token) return;
    const c = this.conns.get(token); if (c && c.open) { try { c.send(msg); } catch {} }
  }
  // 방장 조작
  addCpu(level) { this.host.addCpu(level); }
  removeSeat(i) { const s = this.host.seats[i]; const c = s && this.conns.get(s.token); if (c) c.close(); this.host.removeSeat(i); }
  setTurnLimit(s) { this.host.setTurnLimit(s); }
  start() { return this.host.start(); }
  rematch() { return this.host.rematch(); }
  dispatch(action) { this.touch(); const r = this.host.applyAction(this.mySeat, action); if (!r.ok) this.onError(r.error); return r; }
  destroy() { this.destroyed = true; clearTimeout(this.idleTimer); clearHostSave(this.storage); try { this.peer.destroy(); } catch {} }
}

/** 참가자: 연결이 끊기면 같은 토큰으로 자동 재접속(자리 복구) */
export class ClientSession {
  constructor({ code, name, token, onLobby, onState, onError, onJoined, onStatus, onVersion }) {
    this.onVersion = onVersion;
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
    conn.on('open', () => { conn.send({ t: 'join', name: this.name, token: this.token, v: APP_VERSION }); });
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'joined') { this.mySeat = msg.seat; this.watching = !!msg.watching; this.attempt = 1; this.onStatus('ok'); this.onJoined && this.onJoined(msg); }
      else if (msg.t === 'lobby') this.onLobby(msg);
      else if (msg.t === 'state') this.onState(msg.view);
      else if (msg.t === 'error') this.onError(msg.msg);
      else if (msg.t === 'version') this.onVersion && this.onVersion(msg);
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
