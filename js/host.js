// 방장(호스트) 로직: 자리 배정, 행동 검증·적용, 각 참가자 시점 view 전송. 네트워크 구현에 독립.
import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, runCpuTurn } from './game.js';
import { buildView } from './view.js';

export const TURN_LIMITS = [0, 60, 120];

export class GameHost {
  /**
   * @param {(seat:number, msg:object)=>void} send   자리 번호에게 메시지 전송
   * @param {{ setTimeout?:Function, clearTimeout?:Function }} timers
   */
  constructor(send, timers = {}) {
    this.send = send;
    this.setTimeout = timers.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = timers.clearTimeout || (id => clearTimeout(id));
    this.seats = [];       // { name, type:'human'|'cpu', token, connected }
    this.game = null;
    this.turnLimit = 0;    // 초, 0 = 없음
    this.deadline = null;
    this._timer = null;
  }

  // ---------- 로비 ----------
  addHuman(name, token) {
    const existing = this.seats.findIndex(s => s.token === token);
    if (existing >= 0) {
      this.seats[existing].connected = true;
      if (this.game) { this.game.players[existing].connected = true; this.afterChange(); } else this.broadcastLobby();
      return existing;
    }
    if (this.game) {
      // 게임 중: 같은 이름으로 재접속 시 자리 복구
      const idx = this.seats.findIndex(s => s.type === 'human' && !s.connected && s.name === name);
      if (idx < 0) return -1;
      this.seats[idx].token = token; this.seats[idx].connected = true;
      this.game.players[idx].connected = true;
      this.afterChange();
      return idx;
    }
    if (this.seats.length >= 4) return -1;
    this.seats.push({ name, type: 'human', token, connected: true });
    this.broadcastLobby();
    return this.seats.length - 1;
  }
  addCpu() {
    if (this.game || this.seats.length >= 4) return false;
    this.seats.push({ name: `CPU ${this.seats.filter(s => s.type === 'cpu').length + 1}`, type: 'cpu', token: null, connected: true });
    this.broadcastLobby(); return true;
  }
  removeSeat(idx) {
    if (this.game || idx === 0) return;
    this.seats.splice(idx, 1); this.broadcastLobby();
  }
  setTurnLimit(sec) { this.turnLimit = TURN_LIMITS.includes(sec) ? sec : 0; this.broadcastLobby(); }
  lobbyState() {
    return { t: 'lobby', players: this.seats.map(s => ({ name: s.name, type: s.type, connected: s.connected })), turnLimit: this.turnLimit };
  }
  broadcastLobby() { this.seats.forEach((s, i) => s.type === 'human' && this.send(i, this.lobbyState())); }

  canStart() { return !this.game && this.seats.length >= 2 && this.seats.length <= 4; }
  start(rng) {
    if (!this.canStart()) return false;
    this.game = createGame(this.seats.map(s => ({ name: s.name, type: s.type })), rng);
    this.game.players.forEach((p, i) => { p.connected = this.seats[i].connected; });
    this.afterChange(true);
    return true;
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
      case 'draw': drawTile(g); turnEnded = true; break;
      case 'end': { const r = endTurn(g); if (!r.ok) return { ok: false, error: r.reason }; turnEnded = true; break; }
      default: return { ok: false, error: '알 수 없는 행동' };
    }
    this.afterChange(turnEnded);
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
    this.seats.forEach((s, i) => {
      if (s.type !== 'human') return;
      this.send(i, { t: 'state', view: buildView(this.game, i, { deadline: this.deadline }) });
    });
  }
}
