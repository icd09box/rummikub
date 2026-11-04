import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, MIN_PLAYERS, MAX_PLAYERS, runCpuTurn } from './game.js';
import { analyzeSet, COLORS, canExtend } from './rules.js';
import { buildView } from './view.js';
import { HostSession, ClientSession, makeToken } from './net.js';

const $ = id => document.getElementById(id);
const screens = ['setup', 'lobby', 'handoff', 'game', 'over'];
function show(name) { for (const s of screens) $(s).classList.toggle('hidden', s !== name); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let mode = 'local';        // local | host | client
let session = null;        // HostSession | ClientSession
let game = null;           // local 모드 전용
let view = null;           // 현재 화면 상태
let selected = new Set();
let lastHumanShown = -1;
let sortMode = 'num';
let countdownTimer = null;
let lastMoved = new Set();   // 직전 조작으로 옮긴 타일 id (놓은 곳 강조용)
let lastMovedAt = 0;

// ========== 설정 화면 ==========
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('hidden', p.id !== btn.dataset.pane));
}));

function renderSetupRows() {
  const n = Number($('playerCount').value);
  const rows = $('playerRows'); rows.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div'); row.className = 'player-row';
    row.innerHTML = `<span>${i + 1}</span><input type="text" placeholder="플레이어 ${i + 1}" maxlength="10" data-name>
      <select data-type><option value="human">사람</option><option value="cpu">컴퓨터</option></select>`;
    rows.appendChild(row);
  }
}
$('playerCount').addEventListener('change', renderSetupRows);
$('startBtn').addEventListener('click', () => {
  const defs = [...$('playerRows').children].map((row, i) => ({
    name: row.querySelector('[data-name]').value.trim() || `플레이어 ${i + 1}`,
    type: row.querySelector('[data-type]').value,
  }));
  if (defs.length < MIN_PLAYERS || defs.length > MAX_PLAYERS) return;
  mode = 'local'; game = createGame(defs); selected.clear(); lastHumanShown = -1;
  localFlow();
});

$('hostBtn').addEventListener('click', () => {
  const name = $('hostName').value.trim() || '방장';
  mode = 'host'; selected.clear();
  $('lobbyCode').textContent = '연결 중…';
  show('lobby');
  try {
    session = new HostSession({
      name,
      onReady: code => { $('lobbyCode').textContent = code; $('lobbyLink').textContent = `${location.origin}${location.pathname}?room=${code}`; },
      onLobby: renderLobby,
      onState: onView,
      onError: msg => flash(msg),
    });
  } catch (e) { alert(e.message); show('setup'); }
  renderLobby(session.host.lobbyState());
});
$('joinBtn').addEventListener('click', () => {
  const code = $('joinCode').value.trim().toUpperCase();
  const name = $('joinName').value.trim() || '손님';
  if (code.length < 4) return;
  mode = 'client'; selected.clear();
  let token = null;
  try { token = sessionStorage.getItem('rummi-token-' + code); } catch {}
  if (!token) { token = makeToken(); try { sessionStorage.setItem('rummi-token-' + code, token); } catch {} }
  $('lobbyCode').textContent = code; $('lobbyLink').textContent = '';
  $('lobbyStatus').textContent = '방에 들어가는 중…';
  show('lobby');
  session = new ClientSession({
    code, name, token,
    onJoined: () => { $('lobbyStatus').textContent = '들어왔어요. 방장이 시작하길 기다리는 중…'; },
    onLobby: renderLobby,
    onState: onView,
    onError: msg => { $('lobbyStatus').textContent = msg; flash(msg); },
    onClosed: () => { flash('방장과 연결이 끊어졌어요.'); $('status').textContent = '연결 끊김'; },
  });
});
$('leaveBtn').addEventListener('click', () => { session && session.destroy(); session = null; show('setup'); });

// URL ?room=CODE 로 들어오면 참가 탭 자동 선택
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) { $('joinCode').value = roomParam.toUpperCase(); document.querySelector('[data-pane="paneJoin"]').click(); }

// ========== 로비 ==========
function renderLobby(lobby) {
  const isHost = mode === 'host';
  $('lobbyPlayers').innerHTML = lobby.players.map((p, i) => `
    <div class="p">
      <span>${i + 1}. ${esc(p.name)}${p.type === 'cpu' ? ' <small>컴퓨터</small>' : ''}${p.connected ? '' : ' <small>(끊김)</small>'}</span>
      ${isHost && i > 0 ? `<button class="mini" data-remove="${i}">내보내기</button>` : ''}
    </div>`).join('');
  $('lobbyPlayers').querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => session.removeSeat(Number(b.dataset.remove))));
  $('hostControls').classList.toggle('hidden', !isHost);
  $('turnLimit').value = String(lobby.turnLimit);
  $('turnLimitView').textContent = lobby.turnLimit ? `턴 제한 ${lobby.turnLimit}초` : '턴 제한 없음';
  if (isHost) {
    const n = lobby.players.length;
    $('lobbyStart').disabled = n < 2;
    $('addCpuBtn').disabled = n >= 4;
    $('lobbyStatus').textContent = n < 2 ? '같이 할 사람을 기다리는 중 (2~4명)' : `${n}명 모였어요. 시작할 수 있어요`;
  }
}
$('addCpuBtn').addEventListener('click', () => session.addCpu());
$('turnLimit').addEventListener('change', () => session.setTurnLimit(Number($('turnLimit').value)));
$('lobbyStart').addEventListener('click', () => session.start());

// ========== 로컬(핫시트) 흐름 ==========
function localFlow() {
  if (game.phase === 'over') return onView(buildView(game, game.turn));
  const p = current(game);
  if (p.type === 'cpu') {
    onView(buildView(game, -1), true);
    $('status').textContent = `${p.name}(컴퓨터) 생각 중…`;
    setTimeout(() => { runCpuTurn(game); localFlow(); }, 700);
    return;
  }
  const humans = game.players.filter(x => x.type === 'human').length;
  if (humans > 1 && lastHumanShown !== p.id) { $('handoffName').textContent = p.name; show('handoff'); return; }
  onView(buildView(game, game.turn));
}
$('handoffBtn').addEventListener('click', () => { lastHumanShown = current(game).id; onView(buildView(game, game.turn)); });

function localDispatch(a) {
  switch (a.type) {
    case 'move': moveTiles(game, a.ids, a.to); break;
    case 'reset': resetTurn(game); break;
    case 'draw': drawTile(game); return localFlow();
    case 'end': { const r = endTurn(game); if (!r.ok) return flash(r.reason); return localFlow(); }
  }
  onView(buildView(game, game.turn));
}

function dispatch(a) {
  if (a.type === 'move' && a.to.kind !== 'rack') { lastMoved = new Set(a.ids); lastMovedAt = Date.now(); }
  else if (a.type !== 'move') lastMoved.clear();
  if (mode === 'local') return localDispatch(a);
  session.dispatch(a);
}

// ========== 화면 ==========
let helpChecked = false;
function onView(v, cpuView = false) {
  view = v;
  if (v.phase === 'over') return renderOver(v);
  show('game'); render(cpuView);
  if (!helpChecked && !cpuView) { helpChecked = true; maybeShowHelp(); }
}

function tileEl(t, opts = {}) {
  const el = document.createElement('div');
  el.className = `tile ${t.joker ? 'joker' : t.color}`;
  el.textContent = t.joker ? '☺' : t.num;
  if (selected.has(t.id)) el.classList.add('selected');
  if (opts.isNew) el.classList.add('new');
  if (opts.justMoved) el.classList.add('just-moved');
  if (opts.hidden) el.classList.add('cpu-hidden');
  el.dataset.id = t.id;
  if (opts.draggable) attachDrag(el, t.id);
  return el;
}

// ========== 드래그 앤 드롭 (포인터 이벤트: 마우스·터치 공용) ==========
let drag = null;
function attachDrag(el, id) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { id, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pointerId: e.pointerId, source: el };
  });
}
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const ids = selected.has(drag.id) ? [...selected] : [drag.id];
    drag.ids = ids;
    const g = document.createElement('div'); g.className = 'drag-ghost';
    g.textContent = ids.length > 1 ? `${ids.length}장` : drag.source.textContent;
    g.classList.add(...[...drag.source.classList].filter(c => ['red','blue','black','orange','joker'].includes(c)));
    document.body.appendChild(g); drag.ghost = g;
    drag.source.classList.add('dragging');
    document.body.classList.add('is-dragging');
  }
  drag.ghost.style.transform = `translate(${e.clientX - 20}px, ${e.clientY - 28}px)`;
  autoScroll(e.clientY);
  highlightDropTarget(e.clientX, e.clientY);
}, { passive: true });
document.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
  if (!d.moved) return; // 클릭은 click 핸들러가 처리
  e.preventDefault();
  suppressNextClick();
  d.ghost && d.ghost.remove(); d.source.classList.remove('dragging');
  const target = dropTargetAt(e.clientX, e.clientY);
  if (!target) return render();
  if (target.kind === 'rack') {
    const newIds = new Set(view.newIds);
    const mine = d.ids.filter(id => newIds.has(id));
    if (mine.length !== d.ids.length) flash('이번 차례에 내가 낸 타일만 다시 가져올 수 있어요.');
    if (!mine.length) return render();
    selected.clear(); return dispatch({ type: 'move', ids: mine, to: { kind: 'rack' } });
  }
  selected.clear();
  dispatch({ type: 'move', ids: d.ids, to: target.kind === 'new' ? smartTarget(d.ids, e.clientX, e.clientY) : target });
});

/** 빈 곳에 놓았을 때: 붙을 수 있는 세트 중 가장 가까운 것, 없으면 새 세트 */
function smartTarget(ids, x, y) {
  const byId = new Map([...view.table.flat(), ...view.rack].map(t => [t.id, t]));
  const tiles = ids.map(id => byId.get(id)).filter(Boolean);
  const idSet = new Set(ids);
  let best = null, bestDist = Infinity;
  view.table.forEach((set, idx) => {
    const rest = set.filter(t => !idSet.has(t.id));
    if (rest.length === 0 || !canExtend(rest, tiles)) return;
    const el = $('table').children[idx]; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; best = idx; }
  });
  if (best === null || bestDist > 160) return { kind: 'new' };
  return { kind: 'set', index: best };
}
document.addEventListener('pointercancel', () => { if (drag) { drag.ghost && drag.ghost.remove(); drag.source.classList.remove('dragging'); drag = null; document.body.classList.remove('is-dragging'); } });

let suppressClick = false;
function suppressNextClick() { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
document.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
function autoScroll(y) {
  const t = $('table'); const r = t.getBoundingClientRect();
  if (y < r.top + 40) t.scrollTop -= 12; else if (y > r.bottom - 40) t.scrollTop += 12;
}
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const set = el.closest('.set');
  if (set && set.parentElement === $('table')) return { kind: 'set', index: [...$('table').children].indexOf(set) };
  if (el.closest('#table')) return { kind: 'new' };
  if (el.closest('#rack')) return { kind: 'rack' };
  return null;
}
function highlightDropTarget(x, y) {
  document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
  const t = dropTargetAt(x, y);
  if (!t) return;
  if (t.kind === 'set') $('table').children[t.index].classList.add('drop-hover');
  else if (t.kind === 'new') $('table').classList.add('drop-hover');
  else $('rack').classList.add('drop-hover');
}
function sortRack(rack) {
  const ci = t => (t.joker ? 99 : COLORS.indexOf(t.color));
  const r = rack.slice();
  if (sortMode === 'num') r.sort((a, b) => (a.joker - b.joker) || a.num - b.num || ci(a) - ci(b));
  else r.sort((a, b) => (a.joker - b.joker) || ci(a) - ci(b) || a.num - b.num);
  return r;
}

function render(cpuView = false) {
  const v = view;
  const myTurn = !cpuView && v.seat === v.turn;
  const newIds = new Set(v.newIds);

  const table = $('table'); table.innerHTML = '';
  v.table.forEach((set, idx) => {
    const a = analyzeSet(set);
    const el = document.createElement('div');
    el.className = 'set' + (a.ok ? '' : ' invalid');
    if (!v.snapshotSetKeys.includes(set.map(t => t.id).sort().join(','))) el.classList.add('changed');
    const fresh = Date.now() - lastMovedAt < 1500;
    if (fresh && set.some(t => lastMoved.has(t.id))) el.classList.add('just-dropped');
    (a.ok ? a.ordered : set).forEach(t => el.appendChild(tileEl(t, { isNew: newIds.has(t.id), draggable: myTurn, justMoved: fresh && lastMoved.has(t.id) })));
    if (myTurn) el.addEventListener('click', e => onSetClick(e, idx));
    table.appendChild(el);
  });

  const rack = $('rack'); rack.innerHTML = '';
  for (const t of sortRack(v.rack)) {
    const el = tileEl(t, { hidden: cpuView, draggable: myTurn });
    if (myTurn) el.addEventListener('click', () => { toggle(t.id); render(); });
    rack.appendChild(el);
  }

  $('players').innerHTML = v.players.map((x, i) => `
    <div class="p ${i === v.turn ? 'active' : ''}">
      <span>${esc(x.name)}${x.type === 'cpu' ? ' <small>컴퓨터</small>' : ''}${i === v.seat ? ' <small>(나)</small>' : ''}${x.connected ? '' : ' <small>끊김</small>'}</span>
      <span class="meta">${x.count}장${x.hasMelded ? '' : ' · 30점 전'}</span>
    </div>`).join('');
  $('poolCount').textContent = v.pool;
  $('log').innerHTML = v.log.slice().reverse().map(esc).join('<br>');

  const me = v.players[v.seat];
  if (cpuView) $('status').textContent = '';
  else if (myTurn) $('status').textContent = `내 차례${me && !me.hasMelded ? ' · 처음엔 내 타일만으로 30점 이상 내야 해요' : ''}`;
  else $('status').textContent = `${v.currentName}의 차례예요. 기다려 주세요`;

  const hint = $('hint');
  const freshNote = Date.now() - lastMovedAt < 1500 && lastMoved.size ? describeMove(v) : '';
  if (freshNote) { hint.textContent = freshNote; hint.className = 'hint good'; }
  else if (!v.changed) { hint.textContent = myTurn ? '타일을 끌어서 바닥에 놓으세요. 맞는 묶음 옆에 놓으면 알아서 붙어요.' : ''; hint.className = 'hint'; }
  else if (v.check) {
    const r = v.check;
    hint.textContent = r.ok ? `좋아요! "내 차례 끝"을 누르세요 (${r.placed}장 냄${r.meldValue != null ? `, 처음 내기 ${r.meldValue}점` : ''})` : r.reason;
    hint.className = 'hint ' + (r.ok ? 'good' : 'bad');
  }
  for (const id of ['newSetBtn', 'toRackBtn', 'resetBtn', 'drawBtn', 'endBtn']) $(id).disabled = !myTurn;
  $('sortBtn').disabled = cpuView; $('sortBtn').textContent = sortMode === 'num' ? '숫자순' : '색깔순';
  $('newSetBtn').disabled = $('toRackBtn').disabled = $('autoBtn').disabled = !myTurn || selected.size === 0;
  if (!myTurn) selected.clear();
  startCountdown(v.deadline);
}

function startCountdown(deadline) {
  clearInterval(countdownTimer);
  const el = $('timer');
  if (!deadline) { el.textContent = ''; return; }
  const tick = () => {
    const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = `⏱ ${s}초`; el.classList.toggle('urgent', s <= 10);
    if (s <= 0) clearInterval(countdownTimer);
  };
  tick(); countdownTimer = setInterval(tick, 250);
}

const COLOR_KO = { red: '빨강', blue: '파랑', black: '검정', orange: '주황' };
function tileName(t) { return t.joker ? '조커' : `${COLOR_KO[t.color]} ${t.num}`; }
function describeMove(v) {
  const idx = v.table.findIndex(set => set.some(t => lastMoved.has(t.id)));
  if (idx < 0) return '';
  const set = v.table[idx];
  const moved = set.filter(t => lastMoved.has(t.id)).map(tileName).join(', ');
  const rest = set.filter(t => !lastMoved.has(t.id));
  if (rest.length === 0) return `${moved} → 따로 두었어요`;
  const a = analyzeSet(set);
  const label = a.ok ? (a.kind === 'group' ? `${rest[0].joker ? set.find(t=>!t.joker).num : rest[0].num} 묶음` : `${COLOR_KO[(rest.find(t=>!t.joker)||set.find(t=>!t.joker)).color]} 연속 묶음`) : `${rest.slice(0,3).map(tileName).join(', ')} 옆`;
  return `${moved} → ${label}에 붙였어요 (${set.length}장)`;
}
function toggle(id) { selected.has(id) ? selected.delete(id) : selected.add(id); }
function flash(msg) { const h = $('hint'); h.textContent = msg; h.className = 'hint bad'; }

// ========== 조작 ==========
function onSetClick(e, idx) {
  const tileNode = e.target.closest('.tile');
  if (tileNode && (selected.size === 0 || selected.has(Number(tileNode.dataset.id)))) { toggle(Number(tileNode.dataset.id)); return render(); }
  if (selected.size === 0) return;
  dispatch({ type: 'move', ids: [...selected], to: { kind: 'set', index: idx } }); selected.clear();
}
$('newSetBtn').addEventListener('click', () => { if (!selected.size) return; dispatch({ type: 'move', ids: [...selected], to: { kind: 'new' } }); selected.clear(); });
$('autoBtn').addEventListener('click', () => {
  if (!selected.size) return;
  const ids = [...selected]; selected.clear();
  dispatch({ type: 'move', ids, to: smartTargetAny(ids) });
});
/** 거리 무시: 붙을 수 있는 세트 중 '이번 턴에 바뀐 세트' 우선, 없으면 새 세트 */
function smartTargetAny(ids) {
  const byId = new Map([...view.table.flat(), ...view.rack].map(t => [t.id, t]));
  const tiles = ids.map(id => byId.get(id)).filter(Boolean);
  const idSet = new Set(ids);
  let fallback = null;
  for (let idx = 0; idx < view.table.length; idx++) {
    const rest = view.table[idx].filter(t => !idSet.has(t.id));
    if (rest.length === 0 || !canExtend(rest, tiles)) continue;
    const changed = !view.snapshotSetKeys.includes(view.table[idx].map(t => t.id).sort().join(','));
    if (changed) return { kind: 'set', index: idx };
    if (fallback === null) fallback = idx;
  }
  return fallback === null ? { kind: 'new' } : { kind: 'set', index: fallback };
}
$('toRackBtn').addEventListener('click', () => {
  if (!selected.size) return;
  const newIds = new Set(view.newIds);
  const mine = [...selected].filter(id => newIds.has(id));
  if (mine.length !== selected.size) flash('이번 차례에 내가 낸 타일만 다시 가져올 수 있어요.');
  if (mine.length) dispatch({ type: 'move', ids: mine, to: { kind: 'rack' } });
  selected.clear(); if (!mine.length) render();
});
$('resetBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'reset' }); });
$('sortBtn').addEventListener('click', () => { sortMode = sortMode === 'num' ? 'color' : 'num'; render(); });
$('drawBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'draw' }); });
$('endBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'end' }); });

// ========== 종료 ==========
function renderOver(v) {
  clearInterval(countdownTimer);
  const w = v.players[v.winner];
  $('winnerText').textContent = `🏆 ${w.name} 승리!`;
  $('scoreTable').innerHTML = '<tr><th>플레이어</th><th>남은 타일</th><th>점수</th></tr>' +
    v.players.map(p => `<tr><td>${esc(p.name)}</td><td>${p.count}장</td><td>${p.score > 0 ? '+' : ''}${p.score}</td></tr>`).join('');
  show('over');
}
$('againBtn').addEventListener('click', () => { session && session.destroy(); session = null; show('setup'); });

// 도움말
$('helpBtn').addEventListener('click', () => $('help').classList.remove('hidden'));
$('helpClose').addEventListener('click', () => { $('help').classList.add('hidden'); try { localStorage.setItem('rummi-help-seen', '1'); } catch {} });
$('help').addEventListener('click', e => { if (e.target === $('help')) $('helpClose').click(); });
function maybeShowHelp() { let seen = false; try { seen = !!localStorage.getItem('rummi-help-seen'); } catch {} if (!seen) $('help').classList.remove('hidden'); }

renderSetupRows();
show('setup');
