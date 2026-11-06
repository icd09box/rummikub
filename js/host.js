// 방장(호스트) 로직: 자리 배정, 행동 검증·적용, 각 참가자 시점 view 전송. 네트워크 구현에 독립.
import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, undoMove, runCpuTurn } from './game.js';
import { buildView } from './view.js';

export const TURN_LIMITS = [0, 60, 120];
export const WATCHER = -2;   // addHuman 반환값: 구경꾼으로 들어감
export const EMOJIS = ['👍', '😂', '🔥', '⏰', '😱', '🙏'];

export class GameHost {
  /**
   * @param {(seat:number, msg:object)=>void} send   자리 번호에게 메시지 전송
   * @param {{ setTimeout?:Function, clearTimeout?:Function }} timers
   */
  constructor(send, timers = {}) {
    this.send = send;
    this.setTimeout = timers.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = timers.clearTimeout || (id => clearTimeout(id));
    this.seats = [];       // { name, type:'human'|'cpu', token, connected, level }
    this.watchers = [];    // 게임 중 들어온 구경꾼 { name, token } — 다음 판부터 자리를 받는다
    this.game = null;
    this.turnLimit = 0;    // 초, 0 = 없음
    this.deadline = null;
    this._timer = null;
    this.round = 0;        // 끝난 판 수
    this.onPersist = null; // 상태가 바뀔 때마다 호출(방장 새로고침 복구용)
  }

  // ---------- 저장·복구 ----------
  /** JSON으로 저장할 수 있는 전체 상태 */
  serialize() {
    return { seats: this.seats, watchers: this.watchers, game: this.game, turnLimit: this.turnLimit, round: this.round, savedAt: Date.now() };
  }
  /** serialize()한 상태로 되살림. 타이머·CPU 차례는 다시 돈다. */
  restore(data) {
    this.seats = data.seats.map(s => ({ ...s, connected: s.type === 'cpu' || s.token === 'host' }));
    this.turnLimit = data.turnLimit || 0; this.round = data.round || 0;
    this.watchers = [];   // 구경꾼은 다시 접속하면서 되살아난다
    this.game = data.game || null;
    if (this.game) this.game.players.forEach((p, i) => { p.connected = this.seats[i].connected; });
    if (this.game && this.game.phase === 'playing') this.afterChange(true); else if (this.game) this.broadcastState(); else this.broadcastLobby();
  }
  persist() { if (this.onPersist) this.onPersist(this.serialize()); }

  // ---------- 로비 ----------
  addHuman(name, token) {
    const existing = this.seats.findIndex(s => s.token === token);
    if (existing >= 0) {
      this.seats[existing].connected = true;
      if (this.game) { this.game.players[existing].connected = true; this.afterChange(); } else this.broadcastLobby();
      return existing;
    }
    if (this.game) {
      // 게임 중: 같은 이름으로 재접속 시 자리 복구, 아니면 구경꾼(다음 판부터 참가)
      const idx = this.seats.findIndex(s => s.type === 'human' && !s.connected && s.name === name);
      if (idx >= 0) {
        this.seats[idx].token = token; this.seats[idx].connected = true;
        this.game.players[idx].connected = true;
        this.afterChange();
        return idx;
      }
      if (!this.watchers.some(w => w.token === token)) this.watchers.push({ name, token });
      this.afterChange();
      return WATCHER;
    }
    if (this.seats.length >= 4) return -1;
    this.seats.push({ name, type: 'human', token, connected: true });
    this.broadcastLobby();
    return this.seats.length - 1;
  }
  addCpu(level = 'normal') {
    if (this.game || this.seats.length >= 4) return false;
    const n = this.seats.filter(s => s.type === 'cpu').length + 1;
    this.seats.push({ name: level === 'hard' ? `컴퓨터 ${n} (어려움)` : `컴퓨터 ${n}`, type: 'cpu', token: null, connected: true, level: level === 'hard' ? 'hard' : 'normal' });
    this.broadcastLobby(); return true;
  }
  removeWatcher(token) { const n = this.watchers.length; this.watchers = this.watchers.filter(w => w.token !== token); if (n !== this.watchers.length) { if (this.game) this.broadcastState(); else this.broadcastLobby(); } }
  removeSeat(idx) {
    if (this.game || idx === 0) return;
    this.seats.splice(idx, 1); this.broadcastLobby();
  }
  setTurnLimit(sec) { this.turnLimit = TURN_LIMITS.includes(sec) ? sec : 0; this.broadcastLobby(); }
  lobbyState() {
    return { t: 'lobby', players: this.seats.map(s => ({ name: s.name, type: s.type, connected: s.connected, level: s.level, wins: s.wins || 0 })), watchers: this.watchers.map(w => w.name), turnLimit: this.turnLimit };
  }
  broadcastLobby() { const l = this.lobbyState(); this.seats.forEach((s, i) => s.type === 'human' && this.send(i, l)); this.watchers.forEach(w => this.send(w.token, l)); this.persist(); }

  canStart() { return !this.game && this.seats.length >= 2 && this.seats.length <= 4; }
  start(rng) {
    if (!this.canStart()) return false;
    const totals = this._totals || [];
    this.game = createGame(this.seats.map((s, i) => ({ name: s.name, type: s.type, level: s.level, total: totals[i] || 0, wins: s.wins || 0 })), rng, { round: this.round + 1 });
    this.game.players.forEach((p, i) => { p.connected = this.seats[i].connected; });
    this.afterChange(true);
    return true;
  }
  /** 판이 끝난 뒤 같은 사람들로 다음 판. 누적 점수는 이어진다. */
  rematch(rng) {
    if (!this.game || this.game.phase !== 'over') return false;
    this._totals = this.game.players.map(p => p.total);
    this.game.players.forEach((p, i) => { this.seats[i].wins = p.wins || 0; });
    this.round += 1;
    this.game = null;
    // 구경하던 사람은 빈자리가 있으면 이번 판부터 참가
    while (this.watchers.length && this.seats.length < 4) {
      const w = this.watchers.shift();
      this.seats.push({ name: w.name, type: 'human', token: w.token, connected: true });
      this._totals.push(0);
    }
    return this.start(rng);
  }

  // ---------- 접속 ----------
  disconnect(seat) {
    const s = this.seats[seat]; if (!s) return;
    s.connected = false;
    if (!this.game) { this.seats.splice(seat, 1); this.broadcastLobby(); return; }
    this.game.players[seat].connected = false;
    if (this.game.phase === 'playing' && this.game.turn === seat) {
      this.setTimeout(() => {
        if (this.game.phase === 'playing' && this.game.turn === seat && !this.game.players[seat].connected) {
          drawTile(this.game); this.afterChange(true);
        }
      }, 3000);
    }
    this.afterChange();
  }

  // ---------- 행동 ----------
  /** @returns {{ok:boolean, error?:string}} */
  applyAction(seat, a) {
    const g = this.game;
    if (a && a.type === 'react') return this.react(seat, a.emoji);
    if (!g || g.phase !== 'playing') return { ok: false, error: '게임이 진행 중이 아닙니다.' };
    if (g.turn !== seat) return { ok: false, error: '내 차례가 아닙니다.' };
    let turnEnded = false;
    switch (a.type) {
      case 'move': {
        if (!Array.isArray(a.ids) || !a.to) return { ok: false, error: '잘못된 요청' };
        if (a.to.kind === 'rack') {
          const snap = new Set(g.snapshot.rack.map(t => t.id));
          if (!a.ids.every(id => snap.has(id))) return { ok: false, error: '이번 차례에 내가 낸 타일만 다시 가져올 수 있어요.' };
        }
        if (a.to.kind === 'set' && !(a.to.index >= 0 && a.to.index < g.table.length)) return { ok: false, error: '잘못된 세트' };
        moveTiles(g, a.ids, a.to); break;
      }
      case 'reset': resetTurn(g); break;
      case 'undo': if (!undoMove(g)) return { ok: false, error: '되돌릴 수가 없어요.' }; break;
      case 'draw': drawTile(g); turnEnded = true; break;
      case 'end': { const r = endTurn(g); if (!r.ok) return { ok: false, error: r.reason }; turnEnded = true; break; }
      default: return { ok: false, error: '알 수 없는 행동' };
    }
    this.afterChange(turnEnded);
    return { ok: true };
  }

  /** 이모지 반응: 차례와 무관, 자리마다 1.5초에 한 번 */
  react(seat, emoji) {
    const g = this.game; const s = this.seats[seat];
    if (!g || !s || !EMOJIS.includes(emoji)) return { ok: false, error: '보낼 수 없는 반응' };
    const now = Date.now();
    if (s.lastReact && now - s.lastReact < 1500) return { ok: true };
    s.lastReact = now;
    g.reaction = { seat, name: s.name, emoji, at: now };
    this.broadcastState();
    return { ok: true };
  }

  // ---------- 턴 진행 ----------
  afterChange(newTurn = false) {
    const g = this.game;
    if (newTurn) this.armTimer();
    this.broadcastState();
    if (g.phase !== 'playing') { this.clearTimer(); return; }
    const p = current(g);
    if (newTurn && p.type === 'cpu') {
      this.setTimeout(() => { if (g.phase === 'playing' && current(g) === p) { runCpuTurn(g); this.afterChange(true); } }, 800);
    } else if (newTurn && p.connected === false) {
      this.setTimeout(() => { if (g.phase === 'playing' && current(g) === p && p.connected === false) { drawTile(g); this.afterChange(true); } }, 3000);
    }
  }
  armTimer() {
    this.clearTimer();
    if (!this.turnLimit || current(this.game).type === 'cpu') { this.deadline = null; return; }
    this.deadline = Date.now() + this.turnLimit * 1000;
    const seat = this.game.turn;
    this._timer = this.setTimeout(() => {
      if (this.game.phase === 'playing' && this.game.turn === seat) {
        this.game.log.push(`${current(this.game).name} 시간이 지나 자동으로 한 장 뽑음`);
        drawTile(this.game); this.afterChange(true);
      }
    }, this.turnLimit * 1000);
  }
  clearTimer() { if (this._timer) this.clearTimeout(this._timer); this._timer = null; }
  broadcastState() {
    const extra = { deadline: this.deadline, watchers: this.watchers.map(w => w.name) };
    this.seats.forEach((s, i) => {
      if (s.type !== 'human') return;
      this.send(i, { t: 'state', view: buildView(this.game, i, extra) });
    });
    this.watchers.forEach(w => this.send(w.token, { t: 'state', view: buildView(this.game, -1, extra) }));
    this.persist();
  }
}
