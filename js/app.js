import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, undoMove, MIN_PLAYERS, MAX_PLAYERS, runCpuTurn } from './game.js';
import { analyzeSet, COLORS, canExtend, offendingTiles } from './rules.js';
import { EMOJIS } from './host.js';
import { buildView } from './view.js';
import { planCpuTurn } from './cpu.js';
import { HostSession, ClientSession, makeToken, loadHostSave, clearHostSave } from './net.js';

const $ = id => document.getElementById(id);
const screens = ['setup', 'lobby', 'handoff', 'game', 'over'];
function show(name) { for (const s of screens) $(s).classList.toggle('hidden', s !== name); document.body.classList.toggle('in-game', name === 'game'); }
// 실제로 보이는 높이. 100dvh는 안드로이드 하단 내비게이션 바까지 포함하는 경우가 있다
function setAppH() { document.documentElement.style.setProperty('--app-h', Math.round(window.visualViewport ? visualViewport.height : innerHeight) + 'px'); }
setAppH(); addEventListener('resize', setAppH); window.visualViewport && visualViewport.addEventListener('resize', setAppH);
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let mode = 'local';        // local | host | client
let session = null;        // HostSession | ClientSession
let game = null;           // local 모드 전용
let view = null;           // 현재 화면 상태
let selected = new Set();
let lastHumanShown = -1;
let sortMode = 'num';        // num | color | free(내 맘대로)
let freeLayout = { groups: [], bottom: [] };   // 내 맘대로 정리 배치(타일 id). groups = 위 묶음 칸들
let pendingPlace = null;    // 바닥→내 타일로 가져올 때 놓을 자리
let rackZoned = false;      // 내 타일 칸이 위(묶음)·아래 두 구역으로 나뉘어 있는지
let lastTap = {};           // 두 번 클릭 판정용 { id, at }
let countdownTimer = null;
let suggestIds = new Set();  // 추천으로 깜빡일 타일
let lastMoved = new Set();   // 직전 조작으로 옮긴 타일 id (놓은 곳 강조용)
let lastMovedAt = 0;
let tidy = false;            // 바닥 묶음을 정렬해서 보기(내 화면만)
let wasMyTurn = false;       // 내 차례 알림용
let shownTurnNo = 0;         // 상대 수 애니메이션을 한 번만
let prefs = { symbols: false, alert: true, pinpoint: true, rows: 'one', local: false, light: false, zones: true };
let lastOneWarned = new Set();   // 마지막 한 장 경고를 사람마다 한 번만
let warned10 = false;             // 10초 경고음 한 번만
let rackCollapsed = false;
let lastReactionAt = 0;
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('rummi-prefs') || '{}') }; } catch {}
function savePrefs() { try { localStorage.setItem('rummi-prefs', JSON.stringify(prefs)); } catch {} }
document.body.classList.toggle('symbols', prefs.symbols);
document.body.classList.toggle('light', prefs.light);

// ===== 상단 알림 띠 =====
let noticeTimer = null;
function showNotice(text, btn = null, onBtn = null, autoHideMs = 0) {
  $('noticeText').textContent = text;
  $('noticeBtn').classList.toggle('hidden', !btn); $('noticeBtn').textContent = btn || '';
  $('noticeBtn').onclick = () => { hideNotice(); onBtn && onBtn(); };
  $('notice').classList.remove('hidden');
  clearTimeout(noticeTimer);
  if (autoHideMs) noticeTimer = setTimeout(hideNotice, autoHideMs);
}
function hideNotice() { $('notice').classList.add('hidden'); clearTimeout(noticeTimer); }
$('noticeClose').addEventListener('click', hideNotice);

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
      <select data-type><option value="human">사람</option><option value="cpu">컴퓨터</option><option value="hard">컴퓨터(어려움)</option></select>`;
    rows.appendChild(row);
  }
}
$('playerCount').addEventListener('change', renderSetupRows);
$('startBtn').addEventListener('click', () => {
  const defs = [...$('playerRows').children].map((row, i) => ({
    name: row.querySelector('[data-name]').value.trim() || `플레이어 ${i + 1}`,
    type: row.querySelector('[data-type]').value === 'human' ? 'human' : 'cpu',
    level: row.querySelector('[data-type]').value === 'hard' ? 'hard' : 'normal',
  }));
  if (defs.length < MIN_PLAYERS || defs.length > MAX_PLAYERS) return;
  mode = 'local'; game = createGame(defs); selected.clear(); lastHumanShown = -1;
  localFlow();
});

function startHost(name, restore = null) {
  mode = 'host'; selected.clear();
  $('lobbyCode').textContent = '연결 중…'; $('qr').innerHTML = '';
  show('lobby');
  try {
    session = new HostSession({
      name, restore,
      onIdle: () => {
        showNotice('30분 동안 아무 움직임이 없어요. 2분 뒤에 방을 닫아요.', '계속하기', () => session && session.touch());
        setTimeout(() => { if (session && Date.now() - session.lastActive >= 30 * 60 * 1000) { session.destroy(); session = null; view = null; hideNotice(); show('setup'); checkResume(); } }, 2 * 60 * 1000);
      },
      onReady: code => {
        $('lobbyCode').textContent = code;
        const link = `${location.origin}${location.pathname}?room=${code}`;
        $('lobbyLink').textContent = link; renderQr(link);
      },
      onLobby: renderLobby,
      onState: onView,
      onError: msg => flash(msg),
      onStatus: st => setNetStatus(st),
    });
  } catch (e) { alert(e.message); show('setup'); return; }
  if (!restore) renderLobby(session.host.lobbyState());
}
// 다른 탭의 '이어하기' 물음에 답하기
if ('BroadcastChannel' in window) {
  const hostCh = new BroadcastChannel('rummi-host');
  hostCh.onmessage = e => { if (e.data && e.data.t === 'ask' && session && mode === 'host' && session.code === e.data.code) hostCh.postMessage({ t: 'have', code: session.code }); };
}
function renderQr(link) {
  const box = $('qr'); box.innerHTML = '';
  if (typeof QRCode === 'undefined') return;
  try { new QRCode(box, { text: link, width: 140, height: 140, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); } catch {}
}
// 방장 새로고침 복구: 저장된 판이 있으면 '이어하기' 상자
function checkResume() {
  const save = loadHostSave();
  $('resumeBox').classList.toggle('hidden', !save);
  if (!save) return;
  const st = save.state;
  $('resumeInfo').textContent = `방 ${save.code} · ${st.seats.map(x => x.name).join(', ')} · ${st.game ? st.game.round || 1 : 1}판째`;
  $('resumeBtn').onclick = () => {
    // 다른 탭에서 이미 같은 방을 열어 두었는지 먼저 확인
    if ('BroadcastChannel' in window) {
      const ch = new BroadcastChannel('rummi-host'); let taken = false;
      ch.onmessage = e => { if (e.data && e.data.t === 'have' && e.data.code === save.code) taken = true; };
      ch.postMessage({ t: 'ask', code: save.code });
      setTimeout(() => { ch.close(); if (taken) showNotice('이 방이 다른 탭에서 이미 열려 있어요. 그 탭에서 계속하세요.', null, null, 6000); else startHost(save.name || '방장', save); }, 300);
    } else startHost(save.name || '방장', save);
  };
  $('resumeDrop').onclick = () => { clearHostSave(); checkResume(); };
}

$('hostBtn').addEventListener('click', () => startHost($('hostName').value.trim() || '방장'));
$('joinBtn').addEventListener('click', () => {
  const code = $('joinCode').value.trim().toUpperCase();
  const name = $('joinName').value.trim() || '손님';
  if (code.length < 4) return;
  mode = 'client'; selected.clear();
  let token = null;
  try { token = sessionStorage.getItem('rummi-token-' + code); } catch {}
  if (!token) { token = makeToken(); try { sessionStorage.setItem('rummi-token-' + code, token); } catch {} }
  $('lobbyCode').textContent = code; $('lobbyLink').textContent = ''; $('qr').innerHTML = '';
  try { sessionStorage.setItem('rummi-last-join', JSON.stringify({ code, name })); } catch {}
  $('lobbyStatus').textContent = '방에 들어가는 중…';
  show('lobby');
  session = new ClientSession({
    code, name, token,
    onVersion: () => showNotice('방장과 앱 버전이 달라요. 새로고침하면 맞춰져요.', '새로고침', () => location.reload()),
    onJoined: j => { $('lobbyStatus').textContent = j.watching ? '게임이 진행 중이라 구경하다가 다음 판부터 같이 해요.' : '들어왔어요. 방장이 시작하길 기다리는 중…'; },
    onLobby: renderLobby,
    onState: onView,
    onError: msg => { $('lobbyStatus').textContent = msg; flash(msg); },
  });
});
$('leaveBtn').addEventListener('click', () => { forgetJoin(); session && session.destroy(); session = null; show('setup'); });
$('copyLinkBtn').addEventListener('click', async () => {
  const link = $('lobbyLink').textContent || `${location.origin}${location.pathname}?room=${$('lobbyCode').textContent}`;
  try { await navigator.clipboard.writeText(link); $('copyLinkBtn').textContent = '복사됨!'; } catch { $('copyLinkBtn').textContent = '길게 눌러 복사'; }
  setTimeout(() => { $('copyLinkBtn').textContent = '링크 복사'; }, 1500);
});
if (navigator.share) {
  $('shareBtn').classList.remove('hidden');
  $('shareBtn').addEventListener('click', () => {
    const link = $('lobbyLink').textContent || `${location.origin}${location.pathname}?room=${$('lobbyCode').textContent}`;
    navigator.share({ title: '루미큐브 같이 해요', text: `방 코드 ${$('lobbyCode').textContent}`, url: link }).catch(() => {});
  });
}

// URL ?room=CODE 로 들어오면 참가 탭 자동 선택
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) { $('joinCode').value = roomParam.toUpperCase(); document.querySelector('[data-pane="paneJoin"]').click(); }
else {
  // 참가자가 새로고침한 경우: 직전 방으로 자동 재입장(나가기를 누른 경우엔 기록이 지워져 있음)
  try { const j = JSON.parse(sessionStorage.getItem('rummi-last-join') || 'null'); if (j) { $('joinCode').value = j.code; $('joinName').value = j.name; document.querySelector('[data-pane="paneJoin"]').click(); setTimeout(() => $('joinBtn').click(), 50); } } catch {}
}
function forgetJoin() { try { sessionStorage.removeItem('rummi-last-join'); } catch {} }
// 게임 중 탭을 닫거나 새로고침하면 확인
window.addEventListener('beforeunload', e => { if (view && view.phase === 'playing') { e.preventDefault(); e.returnValue = ''; } });

// ========== 로비 ==========
function renderLobby(lobby) {
  const isHost = mode === 'host';
  $('lobbyPlayers').innerHTML = lobby.players.map((p, i) => `
    <div class="p">
      <span>${i + 1}. ${esc(p.name)}${p.type === 'cpu' ? ' <small>컴퓨터</small>' : ''}${p.wins ? ` <span class="wins">🏆${p.wins}</span>` : ''}${p.connected ? '' : ' <small>(끊김)</small>'}</span>
      ${isHost && i > 0 ? `<button class="mini" data-remove="${i}">내보내기</button>` : ''}
    </div>`).join('');
  $('lobbyPlayers').querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => session.removeSeat(Number(b.dataset.remove))));
  $('hostControls').classList.toggle('hidden', !isHost);
  const ws = lobby.watchers || [];
  $('lobbyWatchers').classList.toggle('hidden', !ws.length);
  $('lobbyWatchers').textContent = ws.length ? `구경 중(다음 판부터 참가): ${ws.join(', ')}` : '';
  $('turnLimit').value = String(lobby.turnLimit);
  $('turnLimitView').textContent = lobby.turnLimit ? `턴 제한 ${lobby.turnLimit}초` : '턴 제한 없음';
  if (isHost) {
    const n = lobby.players.length;
    $('lobbyStart').disabled = n < 2;
    $('addCpuBtn').disabled = n >= 4;
    $('lobbyStatus').textContent = n < 2 ? '같이 할 사람을 기다리는 중 (2~4명)' : `${n}명 모였어요. 시작할 수 있어요`;
  }
}
$('addCpuBtn').addEventListener('click', () => session.addCpu($('cpuLevel').value));
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
    case 'undo': if (!undoMove(game)) return flash('되돌릴 수가 없어요.'); break;
    case 'draw': drawTile(game); return localFlow();
    case 'end': { const r = endTurn(game); if (!r.ok) return flash(r.reason); return localFlow(); }
  }
  onView(buildView(game, game.turn));
}

function dispatch(a) {
  suggestIds.clear();
  if (a.type === 'move' && a.to.kind !== 'rack') { lastMoved = new Set(a.ids); lastMovedAt = Date.now(); }
  else if (a.type !== 'move') lastMoved.clear();
  if (mode === 'local') return localDispatch(a);
  session.dispatch(a);
}

// ========== 화면 ==========
let helpChecked = false;
function onView(v, cpuView = false) {
  view = v;
  if (!cpuView && v.phase === 'playing') { const k = layoutKey(); if (layoutLoadedFor !== k) { layoutLoadedFor = k; loadLayout(); } }
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
  if (opts.lastPlaced) el.classList.add('last-placed');
  if (suggestIds.has(t.id)) el.classList.add('suggest');
  if (opts.justMoved) el.classList.add('just-moved');
  if (opts.hidden) el.classList.add('cpu-hidden');
  if (opts.bad) el.classList.add('bad');
  el.dataset.id = t.id;
  if (opts.draggable) attachDrag(el, t.id);
  return el;
}

// ========== 드래그 앤 드롭 (포인터 이벤트: 마우스·터치 공용) ==========
let drag = null;
function attachDrag(el, id) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    const srcSet = el.closest('.set');
    const fromSet = srcSet ? Number(srcSet.dataset.idx) : -1;
    const inRack = !!el.closest('#rack');
    drag = { id, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, pointerId: e.pointerId, source: el, fromSet, inRack, scrolling: false, scrollStart: inRack ? $('rack').scrollLeft : 0 };
    try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch {}
  });
}
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  // 내 타일 칸에서 옆으로 미는 건 스크롤, 위로 들어 올리는 게 꺼내기
  if (drag.scrolling) { $('rack').scrollLeft = drag.scrollStart - dx; return; }
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    if (drag.inRack && !rackZoned && Math.abs(dx) > Math.abs(dy) * 1.2) { drag.scrolling = true; $('rack').scrollLeft = drag.scrollStart - dx; return; }
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
  if (d.scrolling) { if (Math.abs(e.clientX - d.startX) > 6) suppressNextClick(); return; }
  if (!d.moved) return; // 클릭은 click 핸들러가 처리
  e.preventDefault();
  suppressNextClick();
  d.ghost && d.ghost.remove(); d.source.classList.remove('dragging');
  const target = dropTargetAt(e.clientX, e.clientY);
  if (!target) return render();
  if (target.kind === 'set' && target.index === d.fromSet) return render();
  if (target.kind === 'rack' && rackZoned) {
    const place = rackPlacement(e.clientX, e.clientY, d.ids);
    if (d.inRack) { applyPlacement(d.ids, place); selected.clear(); return render(); }
    const mine = d.ids.filter(id => new Set(view.newIds).has(id));
    if (!mine.length) { flash('이번 차례에 내가 낸 타일만 다시 가져올 수 있어요.'); return render(); }
    pendingPlace = { ids: mine, ...place }; selected.clear();
    return dispatch({ type: 'move', ids: mine, to: { kind: 'rack' } });
  }
  if (target.kind === 'rack' && d.inRack) return render();
  if (!(view.seat === view.turn)) { flash('내 차례가 아니에요. 지금은 내 타일 정리만 할 수 있어요.'); return render(); }
  if (target.kind === 'rack') {
    const newIds = new Set(view.newIds);
    const mine = d.ids.filter(id => newIds.has(id));
    if (mine.length !== d.ids.length) flash('이번 차례에 내가 낸 타일만 다시 가져올 수 있어요.');
    if (!mine.length) return render();
    selected.clear(); return dispatch({ type: 'move', ids: mine, to: { kind: 'rack' } });
  }
  selected.clear();
  moveActions(d.ids, target.kind === 'new' ? smartTarget(d.ids, e.clientX, e.clientY, d.fromSet) : target).forEach(dispatch);
});

/** 고른 타일이 맞는 묶음 여러 개로 딱 나뉘면(4 5 6 + 9 9 9) 그 묶음들, 아니면 null */
function splitIntoSets(tiles) {
  if (tiles.length < 6 || tiles.length > 16) return null;
  const [first, ...rest] = tiles;
  for (let mask = 0; mask < 1 << rest.length; mask++) {
    const pick = [first, ...rest.filter((_, i) => mask & (1 << i))];
    const left = rest.filter((_, i) => !(mask & (1 << i)));
    if (pick.length < 3 || left.length < 3 || !analyzeSet(pick).ok) continue;
    const more = analyzeSet(left).ok ? [left] : splitIntoSets(left);
    if (more) return [pick, ...more];
  }
  return null;
}
/** 놓기 → 실제로 보낼 move 목록. 여러 묶음 한꺼번에 내기·긴 연속 묶음 가운데 끼워 나누기를 알아서 처리 */
function moveActions(ids, to) {
  if (to.kind === 'new') {
    const byId = new Map([...view.table.flat(), ...view.rack].map(t => [t.id, t]));
    const tiles = ids.map(id => byId.get(id)).filter(Boolean);
    const parts = !analyzeSet(tiles).ok && splitIntoSets(tiles);
    if (parts) return parts.map(p => ({ type: 'move', ids: p.map(t => t.id), to: { kind: 'new' } }));
  }
  return [moveAction(ids, to)];
}
/** 7 8 9 10 11에 같은 색 9를 놓으면 7 8 9 / 9 10 11로 알아서 나눈다(양쪽 다 3장 이상일 때만) */
function moveAction(ids, to) {
  const plain = { type: 'move', ids, to };
  if (to.kind !== 'set' || ids.length !== 1) return plain;
  const tile = [...view.table.flat(), ...view.rack].find(t => t.id === ids[0]);
  const set = view.table[to.index];
  if (!tile || tile.joker || !set) return plain;
  const a = analyzeSet(set);
  if (!a.ok || a.kind !== 'run') return plain;
  const real = a.ordered.filter(t => !t.joker);
  if (real[0].color !== tile.color) return plain;
  const start = real[0].num - a.ordered.indexOf(real[0]), end = start + a.ordered.length - 1;
  if (tile.num - start < 2 || end - tile.num < 2) return plain;
  const right = a.ordered.filter((t, i) => start + i > tile.num).map(t => t.id);
  return { type: 'move', ids: [tile.id, ...right], to: { kind: 'new' } };
}

/** 빈 곳에 놓았을 때: 붙을 수 있는 세트 중 가장 가까운 것, 없으면 새 세트 */
function smartTarget(ids, x, y, excludeIdx = -1) {
  const byId = new Map([...view.table.flat(), ...view.rack].map(t => [t.id, t]));
  const tiles = ids.map(id => byId.get(id)).filter(Boolean);
  const idSet = new Set(ids);
  let best = null, bestDist = Infinity;
  view.table.forEach((set, idx) => {
    if (idx === excludeIdx) return;
    const rest = set.filter(t => !idSet.has(t.id));
    if (rest.length === 0 || !canExtend(rest, tiles)) return;
    const el = setEl(idx); if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; best = idx; }
  });
  if (best === null || bestDist > 160) return { kind: 'new' };
  return { kind: 'set', index: best };
}
// 드래그 중엔 터치 스크롤·당겨서 새로고침을 원천 차단(passive:false 필수)
document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
document.addEventListener('pointercancel', () => { if (drag) { drag.ghost && drag.ghost.remove(); drag.source.classList.remove('dragging'); drag = null; document.body.classList.remove('is-dragging'); } });

let suppressClick = false;
function suppressNextClick() { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
document.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
function autoScroll(y) {
  const t = $('table'); const r = t.getBoundingClientRect();
  if (y < r.top + 40) t.scrollTop -= 12; else if (y > r.bottom - 40) t.scrollTop += 12;
}
function dropTargetAt(x, y) {
  const tr = $('table').getBoundingClientRect();
  if (y > tr.bottom) return { kind: 'rack' };          // 바닥 아래는 전부 '내 타일로'
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const set = el.closest('.set');
  if (set && set.parentElement === $('table')) return { kind: 'set', index: Number(set.dataset.idx) };
  if (el.closest('#table')) return { kind: 'new' };
  if (el.closest('#rack') || el.closest('#rackBar')) return { kind: 'rack' };
  return null;
}
function highlightDropTarget(x, y) {
  document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
  const t = dropTargetAt(x, y);
  if (!t) return;
  if (t.kind === 'set') { const el = setEl(t.index); el && el.classList.add('drop-hover'); }
  else if (t.kind === 'new') $('table').classList.add('drop-hover');
  else {
    $('rack').classList.add('drop-hover'); $('rackBar').classList.add('drop-hover');
    if (rackZoned) { const z = document.elementFromPoint(x, y); const zone = z && z.closest('.zone'); zone && zone.classList.add('drop-hover'); }
  }
}
function setEl(idx) { return $('table').querySelector(`.set[data-idx="${idx}"]`); }
/** 바닥 묶음 표시 순서: 정리 모드면 연속 묶음(색→시작 숫자) → 같은 숫자 묶음(숫자) → 아직 안 맞는 묶음 */
function displayOrder(table) {
  const idx = table.map((_, i) => i);
  if (!tidy) return idx;
  const keyOf = set => {
    const a = analyzeSet(set);
    if (!a.ok) return [2, 0, 0];
    const real = a.ordered.filter(t => !t.joker);
    if (a.kind === 'run') return [0, COLORS.indexOf(real[0].color), real[0].num - a.ordered.indexOf(real[0])];
    return [1, real[0].num, 0];
  };
  const keys = table.map(keyOf);
  return idx.sort((x, y) => keys[x][0] - keys[y][0] || keys[x][1] - keys[y][1] || keys[x][2] - keys[y][2] || x - y);
}
/** 내 맘대로 배치를 현재 손패에 맞춰 정리(없어진 id 제거, 새 id는 아래 줄 끝에) */
function layoutKey() { return 'rummi-layout-' + (session ? (session.code + '-' + view.seat) : 'local-' + view.seat); }
function saveLayout() { try { sessionStorage.setItem(layoutKey(), JSON.stringify({ mode: sortMode, layout: freeLayout })); } catch {} }
function loadLayout() { try { const d = JSON.parse(sessionStorage.getItem(layoutKey()) || 'null'); if (d && d.layout) { freeLayout = { groups: d.layout.groups || [], bottom: d.layout.bottom || [] }; sortMode = d.mode || 'free'; } } catch {} }
let layoutLoadedFor = null;
function freeOrder(rack) {
  const byId = new Map(rack.map(t => [t.id, t]));
  const has = new Set(rack.map(t => t.id));
  freeLayout.groups = freeLayout.groups.map(g => g.filter(id => has.has(id))).filter(g => g.length);
  freeLayout.bottom = freeLayout.bottom.filter(id => has.has(id));
  const placed = new Set([...freeLayout.groups.flat(), ...freeLayout.bottom]);
  const missing = rack.filter(t => !placed.has(t.id)).map(t => t.id);
  if (pendingPlace && missing.length) {
    const ids = missing.filter(id => pendingPlace.ids.includes(id));
    applyPlacement(ids, pendingPlace);
    missing.filter(id => !ids.includes(id)).forEach(id => freeLayout.bottom.push(id));
  } else freeLayout.bottom.push(...sortRack(rack.filter(t => missing.includes(t.id))).map(t => t.id));
  pendingPlace = null;
  saveLayout();
  return { groups: freeLayout.groups.map(g => g.map(id => byId.get(id))), bottom: freeLayout.bottom.map(id => byId.get(id)) };
}
/** zone: 'bottom' | 'g<번호>'(위 묶음 칸) | 'gnew'(새 칸 만들기) */
function applyPlacement(ids, { zone, index }) {
  const idSet = new Set(ids);
  const groups = freeLayout.groups.map(g => g.filter(id => !idSet.has(id)));
  freeLayout.bottom = freeLayout.bottom.filter(id => !idSet.has(id));
  if (zone === 'gnew') groups.push(ids.slice());
  else { const arr = zone === 'bottom' ? freeLayout.bottom : groups[Number(zone.slice(1))]; arr.splice(Math.min(index, arr.length), 0, ...ids); }
  freeLayout.groups = groups.filter(g => g.length);
}
/** 내 타일 칸 안의 좌표 → 어느 구역의 몇 번째 자리인지 */
function rackPlacement(x, y, movingIds) {
  const moving = new Set(movingIds);
  const zones = [...$('rack').querySelectorAll('.zone')];
  if (!zones.length) return { zone: 'bottom', index: 0 };
  const dist = z => { const r = z.getBoundingClientRect(); return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom)); };
  const zoneEl = zones.reduce((a, b) => (dist(b) < dist(a) ? b : a));   // 묶음 칸이 옆으로 나란히 있어서 x까지 본다
  const tiles = [...zoneEl.querySelectorAll('.tile')].filter(t => !moving.has(Number(t.dataset.id)));
  let index = 0;
  for (const t of tiles) {
    const r = t.getBoundingClientRect(); const cy = (r.top + r.bottom) / 2, cx = (r.left + r.right) / 2;
    if (cy + r.height / 2 < y) index++;                       // 윗줄에 있는 타일
    else if (Math.abs(cy - y) <= r.height / 2 + 3 && cx < x) index++;  // 같은 줄에서 왼쪽
  }
  return { zone: zoneEl.dataset.zone, index };
}
function sortRack(rack) {
  const ci = t => (t.joker ? 99 : COLORS.indexOf(t.color));
  const r = rack.slice();
  if (sortMode === 'num') r.sort((a, b) => (a.joker - b.joker) || a.num - b.num || ci(a) - ci(b));
  else r.sort((a, b) => (a.joker - b.joker) || ci(a) - ci(b) || a.num - b.num);
  return r;
}

function render(cpuView = false) {
  if (drag && drag.moved) return;   // 남의 차례에 들어온 화면 갱신이 끌던 타일을 지우지 않게. 놓을 때 다시 그린다
  const v = view;
  const myTurn = !cpuView && v.seat === v.turn;
  const newIds = new Set(v.newIds);
  const lastIds = new Set(v.lastTurn && v.lastTurn.seat !== v.seat ? v.lastTurn.placed.map(t => t.id) : []);
  const fly = v.lastTurn && v.lastTurn.seat !== v.seat && v.lastTurn.turnNo && v.lastTurn.turnNo !== shownTurnNo;   // 새로 들어온 상대 수
  if (v.lastTurn && v.lastTurn.turnNo) shownTurnNo = v.lastTurn.turnNo;
  let flyIdx = 0, flySet = null;

  const banner = $('lastTurn');
  const lt = v.lastTurn;
  if (lt && lt.seat !== v.seat) {
    if (lt.placed.length) {
      const names = lt.placed.map(tileName).join(', ');
      banner.innerHTML = `<b>${esc(lt.name)}</b>이(가) 방금 냄: <span class="lt-tiles">${esc(names)}</span> (${lt.placed.length}장)${lt.meldValue != null ? ` · 처음 30점 내기 ${lt.meldValue}점` : ''}${lt.rearranged ? ' · 바닥 묶음도 다시 짬' : ''}`;
    } else banner.innerHTML = `<b>${esc(lt.name)}</b>이(가) ${lt.drew ? '못 내서 한 장 뽑음' : '넘김'}`;
  } else banner.textContent = '다른 사람이 낸 수가 여기 보여요';   // 줄이 생겼다 없어지면 바닥·버튼 위치가 흔들려서 늘 켜 둔다
  banner.classList.toggle('empty', !(lt && lt.seat !== v.seat));
  banner.classList.remove('hidden');
  const table = $('table'); table.innerHTML = '';
  displayOrder(v.table).forEach(idx => {
    const set = v.table[idx];
    const a = analyzeSet(set);
    const el = document.createElement('div');
    el.className = 'set' + (a.ok ? '' : ' invalid');
    el.dataset.idx = idx;
    const setKey = set.map(t => t.id).sort().join(',');
    if (!v.snapshotSetKeys.includes(setKey)) el.classList.add('changed');
    if (v.lastTurn && v.lastTurn.seat !== v.seat && (v.lastTurn.changedSets || []).includes(setKey)) el.classList.add('rearranged');
    const fresh = Date.now() - lastMovedAt < 1500;
    if (fresh && set.some(t => lastMoved.has(t.id))) el.classList.add('just-dropped');
    const bad = new Set(!a.ok && prefs.pinpoint ? offendingTiles(set) : []);
    (a.ok ? a.ordered : set).forEach(t => {
      const te = tileEl(t, { isNew: newIds.has(t.id), lastPlaced: lastIds.has(t.id), draggable: myTurn, justMoved: fresh && lastMoved.has(t.id), bad: bad.has(t.id) });
      if (fly && lastIds.has(t.id)) { te.classList.add('fly-in'); te.style.animationDelay = `${Math.min(flyIdx++, 8) * 70}ms`; flySet ||= el; }
      el.appendChild(te);
    });
    if (myTurn) el.addEventListener('click', e => onSetClick(e, idx));
    table.appendChild(el);
  });

  if (flySet) setTimeout(() => { try { flySet.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {} }, 50);
  const rack = $('rack'); rack.innerHTML = '';
  if (v.watching) { const n = document.createElement('div'); n.className = 'watching-note'; n.textContent = '구경 중이에요. 이 판이 끝나면 다음 판부터 같이 해요.'; rack.appendChild(n); }
  rack.classList.toggle('two', prefs.rows === 'two');
  rack.classList.toggle('collapsed', rackCollapsed);
  $('rackBar').classList.toggle('collapsed', rackCollapsed);
  $('rackInfo').textContent = cpuView ? '' : v.watching ? '구경 중' : `내 타일 ${v.rack.length}장${rackCollapsed ? ' (접힘 — 여기로 끌어오면 돌아와요)' : ''}`;
  if (v.watchers && v.watchers.length && !v.watching) $('status').textContent += ` · 구경 ${v.watchers.length}명`;
  $('rackToggle').textContent = rackCollapsed ? '▲ 타일 칸 올리기' : '▼ 타일 칸 내리기';
  $('rowsBtn').classList.toggle('on', prefs.rows === 'two');
  $('emojiBtn').classList.toggle('hidden', mode === 'local');
  if (v.reaction && v.reaction.at !== lastReactionAt) { lastReactionAt = v.reaction.at; showReaction(v.reaction); }
  // 묶음 칸(위)은 기본으로 켜 둔다. 숫자순·색깔순에선 위 칸 묶음은 그대로, 아래 칸만 정렬
  const o = cpuView ? null : freeOrder(v.rack);
  const free = !cpuView && (prefs.zones || sortMode === 'free');
  rackZoned = free;
  rack.classList.toggle('free', free);
  const mkTile = t => {
    const el = tileEl(t, { hidden: cpuView, draggable: myTurn || free });   // 두 구역일 땐 남의 차례에도 정리 가능
    // dblclick은 첫 클릭의 render()로 타일이 새로 그려지면 안 와서, 같은 타일 연속 클릭으로 판단
    if (myTurn || free) el.addEventListener('click', () => {
      const now = Date.now();
      if (free && lastTap.id === t.id && now - lastTap.at < 400) {
        lastTap = {}; selected.delete(t.id);
        const inGroup = freeLayout.groups.some(g => g.includes(t.id));
        const n = freeLayout.groups.length;
        applyPlacement([t.id], { zone: inGroup ? 'bottom' : n ? 'g' + (n - 1) : 'gnew', index: Infinity });
        return render();
      }
      lastTap = { id: t.id, at: now };
      if (myTurn) { toggle(t.id); render(); }
    });
    return el;
  };
  if (free) {
    if (sortMode !== 'free') o.bottom = sortRack(o.bottom);
    const mkZone = (key, cls, tiles, parent) => {
      const z = document.createElement('div'); z.className = 'zone ' + cls; z.dataset.zone = key;
      tiles.forEach(t => z.appendChild(mkTile(t)));
      parent.appendChild(z);
    };
    const row = document.createElement('div'); row.className = 'zone-row';
    o.groups.forEach((g, i) => mkZone('g' + i, 'top', g, row));
    mkZone('gnew', 'top new' + (o.groups.length ? ' slim' : ''), [], row);   // 여기 놓으면 칸이 하나 더 생김
    rack.appendChild(row);
    mkZone('bottom', 'bottom', o.bottom, rack);
  } else for (const t of sortRack(v.rack)) rack.appendChild(mkTile(t));

  $('players').innerHTML = v.players.map((x, i) => `
    <div class="p ${i === v.turn ? 'active' : ''} ${x.count === 1 && v.phase === 'playing' ? 'last-one' : ''}">
      <span>${esc(x.name)}${x.type === 'cpu' && !/컴퓨터/.test(x.name) ? ' <small>컴퓨터</small>' : ''}${i === v.seat ? ' <small>(나)</small>' : ''}${x.wins ? ` <span class="wins">🏆${x.wins}</span>` : ''}${x.connected ? '' : ' <small>끊김</small>'}</span>
      <span class="meta">${x.count}장${x.hasMelded ? '' : ' · 30점 전'}</span>
    </div>`).join('');
  $('poolCount').textContent = v.pool;
  // 마지막 한 장 경고(사람마다 한 번)
  v.players.forEach((x, i) => {
    if (x.count === 1 && v.phase === 'playing' && !lastOneWarned.has(i) && i !== v.seat) {
      lastOneWarned.add(i); showNotice(`⚠ ${x.name}이(가) 한 장 남았어요!`, null, null, 4000);
      try { navigator.vibrate && navigator.vibrate([60, 40, 60, 40, 120]); } catch {}
    }
    if (x.count > 1) lastOneWarned.delete(i);
  });
  $('log').innerHTML = v.log.slice().reverse().map(esc).join('<br>');

  const me = v.players[v.seat];
  if (cpuView) $('status').textContent = '';
  else if (v.watching) $('status').textContent = '구경 중';
  else if (myTurn) $('status').textContent = '내 차례';
  else { const cur = v.players[v.turn]; $('status').textContent = cur && cur.type === 'cpu' ? `${cur.name.replace(/ \(어려움\)$/, '')} 생각 중…` : `${v.currentName} 차례`; }   // 좁은 상단바에 맞게 짧게

  renderSelectionBar(myTurn);
  const hint = $('hint');
  const freshNote = Date.now() - lastMovedAt < 1500 && lastMoved.size ? describeMove(v) : '';
  if (freshNote) { hint.textContent = freshNote; hint.className = 'hint good'; }
  else if (!v.changed) { hint.textContent = myTurn ? (me && !me.hasMelded ? '처음엔 내 타일만으로 30점 이상 내야 해요. 타일을 끌어서 바닥에 놓으세요.' : '타일을 끌어서 바닥에 놓으세요. 맞는 묶음 옆에 놓으면 알아서 붙어요.') : ''; hint.className = 'hint'; }
  else if (v.check) {
    const r = v.check;
    hint.textContent = r.ok ? `좋아요! "내 차례 끝"을 누르세요 (${r.placed}장 냄${r.meldValue != null ? `, 처음 내기 ${r.meldValue}점` : ''})` : r.reason;
    hint.className = 'hint ' + (r.ok ? 'good' : 'bad');
  }
  for (const id of ['resetBtn', 'drawBtn', 'endBtn']) $(id).disabled = !myTurn;
  $('undoBtn').disabled = !myTurn || !v.canUndo;
  $('tidyBtn').classList.toggle('on', tidy);
  // 내 차례가 새로 시작되면 알림(온라인만)
  if (myTurn && !wasMyTurn && mode !== 'local') notifyTurn();
  wasMyTurn = myTurn;
  document.title = myTurn && mode !== 'local' ? '● 내 차례 - 루미큐브' : '루미큐브';
  const allowSuggest = v.players.every((p, i) => i === v.seat || p.type === 'cpu');   // 나 빼고 전부 컴퓨터일 때만
  $('suggestBtn').classList.toggle('hidden', !allowSuggest);
  $('autoPlayBtn').classList.toggle('hidden', !allowSuggest);
  $('suggestBtn').disabled = $('autoPlayBtn').disabled = !myTurn;
  $('sortBtn').disabled = cpuView; $('sortBtn').textContent = { num: '숫자순', color: '색깔순', free: '내 맘대로' }[sortMode];
  $('rowsBtn').classList.toggle('hidden', free);   // 묶음 칸이 켜져 있으면 줄 수 설정은 의미 없음
  $('zonesBtn').textContent = free ? '묶음 칸 끄기' : '묶음 칸 켜기';
  $('zonesBtn').classList.toggle('hidden', cpuView);
  if (!myTurn) selected.clear();
  startCountdown(v.remaining != null ? Date.now() + v.remaining : (v.deadline || null));
}

let audioCtx = null;
document.addEventListener('pointerdown', () => { if (!audioCtx && prefs.alert && 'AudioContext' in window) { try { audioCtx = new AudioContext(); } catch {} } }, { once: false });
function beep(freq = 660, dur = 0.3, freq2 = null) {
  if (!prefs.alert || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq, audioCtx.currentTime); if (freq2) o.frequency.setValueAtTime(freq2, audioCtx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur + 0.02);
  } catch {}
}
function notifyTurn() {
  if (!prefs.alert) return;
  try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch {}
  beep(660, 0.3, 880);
}
function startCountdown(deadline) {
  clearInterval(countdownTimer);
  const el = $('timer');
  if (!deadline) { el.textContent = ''; return; }
  warned10 = false;
  const tick = () => {
    const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = `⏱ ${s}초`; el.classList.toggle('urgent', s <= 10);
    if (s <= 10 && !warned10 && view && view.seat === view.turn) { warned10 = true; beep(440, 0.25); try { navigator.vibrate && navigator.vibrate([80, 60, 80]); } catch {} }
    if (s <= 0) clearInterval(countdownTimer);
  };
  tick(); countdownTimer = setInterval(tick, 250);
}

function renderSelectionBar(myTurn) {
  const bar = $('selbar');
  if (!myTurn || selected.size === 0) { bar.classList.add('hidden'); return; }
  const byId = new Map([...view.table.flat(), ...view.rack].map(t => [t.id, t]));
  const ids = [...selected];
  const names = ids.slice(0, 3).map(id => tileName(byId.get(id))).join(', ') + (ids.length > 3 ? ` 외 ${ids.length - 3}장` : '');
  const onTable = new Set(view.table.flat().map(t => t.id));
  const fromTable = ids.some(id => onTable.has(id));
  bar.innerHTML = `<span class="sel-label">${esc(names)} 선택됨 — 끌어서 옮기세요. 더 누르면 같이 옮겨요.</span>
    ${fromTable ? '<button data-act="split">떼어서 따로 두기</button>' : ''}
    <button data-act="cancel" class="ghost">선택 해제</button>`;
  bar.classList.remove('hidden');
  if (fromTable) bar.querySelector('[data-act="split"]').addEventListener('click', () => { const move = [...selected]; selected.clear(); dispatch({ type: 'move', ids: move, to: { kind: 'new' } }); });
  bar.querySelector('[data-act="cancel"]').addEventListener('click', () => { selected.clear(); render(); });
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
function setNetStatus(st) {
  const el = $('netStatus');
  if (st === 'ok') { el.textContent = ''; el.className = 'net'; }
  else if (st === 'connecting') { el.textContent = '연결 중…'; el.className = 'net warn'; }
  else { el.textContent = '연결 끊김 · 다시 연결 중…'; el.className = 'net bad'; }
}
function flash(msg) { const h = $('hint'); h.textContent = msg; h.className = 'hint bad'; }

// ========== 조작 ==========
function onSetClick(e, idx) {
  const tileNode = e.target.closest('.tile');
  if (tileNode) {
    // 바닥 타일을 이미 골라 둔 상태면 다른 바닥 타일도 같이 고르기(여러 묶음에서 한꺼번에 떼기). 내 타일만 골랐으면 그 묶음에 붙이기
    const id = Number(tileNode.dataset.id);
    const onTable = new Set(view.table.flat().map(t => t.id));
    if (selected.size === 0 || selected.has(id) || [...selected].some(s => onTable.has(s))) { toggle(id); return render(); }
  }
  if (selected.size === 0) return;
  moveActions([...selected], { kind: 'set', index: idx }).forEach(dispatch); selected.clear();
}
function computePlan() {
  const v = view; const me = v.players[v.seat];
  return planCpuTurn({ table: v.table, rack: v.rack, hasMelded: me.hasMelded });
}
function noPlayMessage() {
  const me = view.players[view.seat];
  return me.hasMelded ? '지금 낼 수 있는 조합이 안 보여요. "못 내면 뽑기"를 누르세요.' : '내 타일만으로 30점을 못 만들어요. "못 내면 뽑기"를 누르세요.';
}
$('autoPlayBtn').addEventListener('click', () => {
  const plan = computePlan();
  const hint = $('hint');
  if (plan.action === 'draw') { suggestIds.clear(); render(); hint.textContent = noPlayMessage(); hint.className = 'hint'; return; }
  const rackIds = new Set(view.rack.map(t => t.id));
  // 기존 묶음 번호는 덧붙이기만 하므로 안 바뀌고, 새 묶음은 뒤에 붙으니 미리 다 계산해도 안전
  const steps = [];
  for (const set of plan.table) {
    const mine = set.filter(t => rackIds.has(t.id)).map(t => t.id);
    if (!mine.length) continue;
    const rest = set.filter(t => !rackIds.has(t.id)).map(t => t.id);
    let to = { kind: 'new' };
    if (rest.length) {
      const idx = view.table.findIndex(s => rest.every(id => s.some(t => t.id === id)));
      if (idx < 0) continue;
      to = { kind: 'set', index: idx };
    }
    steps.push({ ids: mine, to });
  }
  suggestIds.clear();
  for (const st of steps) dispatch({ type: 'move', ids: st.ids, to: st.to });
  const placed = steps.reduce((n, st) => n + st.ids.length, 0);
  lastMoved = new Set(steps.flatMap(st => st.ids)); lastMovedAt = Date.now();
  if (mode === 'local') {
    render();
    const r = view.check;
    hint.textContent = `추천대로 ${placed}장 내려놓았어요. ${r && r.ok ? '확인하고 "내 차례 끝"을 누르세요.' : (r ? r.reason : '')}`;
    hint.className = 'hint ' + (r && r.ok ? 'good' : 'bad');
  } else {
    hint.textContent = `추천대로 ${placed}장 내려놓는 중…`; hint.className = 'hint good';
  }
});
$('suggestBtn').addEventListener('click', () => {
  const v = view; const me = v.players[v.seat];
  const plan = computePlan();
  const hint = $('hint');
  if (plan.action === 'draw') {
    suggestIds.clear(); render();
    hint.textContent = noPlayMessage();
    hint.className = 'hint'; return;
  }
  const rackIds = new Set(v.rack.map(t => t.id));
  const beforeKeys = new Set(v.table.map(set => set.map(t => t.id).sort().join(',')));
  const parts = [];
  suggestIds = new Set();
  for (const set of plan.table) {
    const mine = set.filter(t => rackIds.has(t.id));
    if (!mine.length) continue;
    mine.forEach(t => suggestIds.add(t.id));
    const rest = set.filter(t => !rackIds.has(t.id));
    const names = mine.map(tileName).join(', ');
    if (rest.length === 0) parts.push(`${names} → 새 묶음`);
    else parts.push(`${names} → ${rest.slice(0, 2).map(tileName).join(', ')} 묶음에`);
  }
  render();
  hint.textContent = '추천: ' + parts.join(' / ') + ' (깜빡이는 타일을 끌어다 놓으세요)';
  hint.className = 'hint good';
});
$('resetBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'reset' }); });
$('undoBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'undo' }); });
$('tidyBtn').addEventListener('click', () => { tidy = !tidy; render(); });
$('rowsBtn').addEventListener('click', () => { prefs.rows = prefs.rows === 'two' ? 'one' : 'two'; savePrefs(); render(); });
$('rackToggle').addEventListener('click', () => { rackCollapsed = !rackCollapsed; render(); });
$('zonesBtn').addEventListener('click', () => {
  prefs.zones = !(prefs.zones || sortMode === 'free');
  if (!prefs.zones && sortMode === 'free') { sortMode = 'num'; saveLayout(); }
  savePrefs(); render();
});

// ========== 이모지 반응(온라인) ==========
$('emojiBar').innerHTML = EMOJIS.map(e => `<button data-emoji="${e}">${e}</button>`).join('');
$('emojiBtn').addEventListener('click', () => $('emojiBar').classList.toggle('hidden'));
$('emojiBar').querySelectorAll('[data-emoji]').forEach(b => b.addEventListener('click', () => {
  $('emojiBar').classList.add('hidden');
  if (session) session.dispatch({ type: 'react', emoji: b.dataset.emoji });
}));
document.addEventListener('click', e => { if (!e.target.closest('#emojiBar') && !e.target.closest('#emojiBtn')) $('emojiBar').classList.add('hidden'); });
function showReaction(r) {
  const el = document.createElement('div'); el.className = 'reaction';
  el.innerHTML = `<b>${esc(r.name)}</b><span class="e">${r.emoji}</span>`;
  $('reactions').appendChild(el);
  setTimeout(() => el.remove(), 2700);
  if (r.seat !== view.seat) { try { navigator.vibrate && navigator.vibrate(40); } catch {} }
}
$('sortBtn').addEventListener('click', () => {
  sortMode = { num: 'color', color: 'free', free: 'num' }[sortMode];
  if (sortMode === 'free' && !prefs.zones) { prefs.zones = true; savePrefs(); }
  saveLayout();
  if (sortMode === 'free') { flash('내 맘대로: 타일을 끌어서 순서를 바꾸고, 다 만든 묶음은 위 칸에 올려 두세요.'); $('hint').className = 'hint good'; }
  render();
});
$('drawBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'draw' }); });
$('endBtn').addEventListener('click', () => { selected.clear(); dispatch({ type: 'end' }); });

// ========== 종료 ==========
function renderOver(v) {
  clearInterval(countdownTimer);
  wasMyTurn = false; document.title = '루미큐브';
  const w = v.players[v.winner];
  const round = v.round || 1;
  $('roundInfo').textContent = `${round}판째 결과`;
  $('winnerText').textContent = `${w.name} 승리!`;
  const sign = n => (n > 0 ? '+' : '') + n;
  const multi = round > 1;
  $('scoreTable').innerHTML = `<tr><th>플레이어</th><th>남은 타일</th><th>이번 판</th>${multi ? '<th>누적</th><th>승</th>' : ''}</tr>` +
    v.players.map((p, i) => `<tr class="${i === v.winner ? 'winner' : ''}"><td>${esc(p.name)}</td><td>${p.count}장</td><td>${sign(p.score)}</td>${multi ? `<td class="total">${sign(p.total || 0)}</td><td>${p.wins || 0}</td>` : ''}</tr>`).join('');
  $('rematchWait').textContent = v.watching ? '다음 판부터 같이 해요. 방장이 시작하길 기다리는 중…' : '방장이 다음 판을 시작하길 기다리는 중…';
  const canRematch = mode !== 'client';
  $('rematchBtn').classList.toggle('hidden', !canRematch);
  $('rematchWait').classList.toggle('hidden', canRematch);
  show('over');
}
$('shareResultBtn').addEventListener('click', async () => {
  const v = view; if (!v) return;
  const c = document.createElement('canvas'); const W = 720, rowH = 64; const H = 200 + rowH * v.players.length + 60; c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#15201a'; x.fillRect(0, 0, W, H); x.fillStyle = '#8fdb24'; x.fillRect(0, 0, W, 14);
  x.fillStyle = '#eef3ea'; x.font = 'bold 40px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; x.textAlign = 'center';
  x.fillText(`🏆 ${v.players[v.winner].name} 승리!`, W / 2, 90);
  x.fillStyle = '#a9b8a5'; x.font = '22px -apple-system, "Apple SD Gothic Neo", sans-serif'; x.fillText(`루미큐브 · ${v.round || 1}판째 결과`, W / 2, 130);
  const multi = (v.round || 1) > 1;
  x.textAlign = 'left'; x.font = '24px -apple-system, "Apple SD Gothic Neo", sans-serif';
  const cols = multi ? [40, 330, 470, 600] : [40, 400, 560];
  x.fillStyle = '#a9b8a5'; ['플레이어', '남은 타일', '이번 판', '누적'].slice(0, cols.length).forEach((h, i) => x.fillText(h, cols[i], 180));
  v.players.forEach((p, i) => {
    const y = 180 + rowH * (i + 1);
    x.fillStyle = i === v.winner ? '#8fdb24' : '#eef3ea'; x.font = (i === v.winner ? 'bold ' : '') + '26px -apple-system, "Apple SD Gothic Neo", sans-serif';
    const vals = [p.name, `${p.count}장`, (p.score > 0 ? '+' : '') + p.score, multi ? (p.total > 0 ? '+' : '') + (p.total || 0) : null].filter(z => z !== null);
    vals.forEach((t, k) => x.fillText(String(t), cols[k], y));
  });
  x.fillStyle = '#5a6a5c'; x.font = '18px -apple-system, sans-serif'; x.fillText('icd09box.github.io/rummikub', 40, H - 24);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'rummikub-result.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: '루미큐브 결과' }); return; } catch {} }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rummikub-result.png'; a.click();
});
$('rematchBtn').addEventListener('click', () => {
  selected.clear(); lastMoved.clear();
  if (mode === 'local') {
    const v = view;
    game = createGame(v.players.map(p => ({ name: p.name, type: p.type, level: p.level, total: p.total || 0, wins: p.wins || 0 })), Math.random, { round: (v.round || 1) + 1 });
    lastHumanShown = -1; return localFlow();
  }
  if (mode === 'host') session.rematch();
});
$('againBtn').addEventListener('click', () => { forgetJoin(); session && session.destroy(); session = null; view = null; show('setup'); checkResume(); });

// 도움말
$('helpBtn').addEventListener('click', () => $('help').classList.remove('hidden'));
$('helpClose').addEventListener('click', () => { $('help').classList.add('hidden'); try { localStorage.setItem('rummi-help-seen', '1'); } catch {} });
$('help').addEventListener('click', e => { if (e.target === $('help')) $('helpClose').click(); });
$('symbolToggle').checked = prefs.symbols; $('alertToggle').checked = prefs.alert;
$('symbolToggle').addEventListener('change', () => { prefs.symbols = $('symbolToggle').checked; document.body.classList.toggle('symbols', prefs.symbols); savePrefs(); });
$('alertToggle').addEventListener('change', () => { prefs.alert = $('alertToggle').checked; savePrefs(); });
$('localToggle').checked = prefs.local;
$('tabLocal').classList.toggle('hidden', !prefs.local);
$('localToggle').addEventListener('change', () => {
  prefs.local = $('localToggle').checked; savePrefs();
  $('tabLocal').classList.toggle('hidden', !prefs.local);
  if (!prefs.local && $('tabLocal').classList.contains('active')) document.querySelector('[data-pane="paneHost"]').click();
});
$('lightToggle').checked = prefs.light;
$('lightToggle').addEventListener('change', () => { prefs.light = $('lightToggle').checked; document.body.classList.toggle('light', prefs.light); document.querySelector('meta[name="theme-color"]').content = prefs.light ? '#d9e6d3' : '#15201a'; savePrefs(); });
$('pinpointToggle').checked = prefs.pinpoint;
$('pinpointToggle').addEventListener('change', () => { prefs.pinpoint = $('pinpointToggle').checked; savePrefs(); if (view && view.phase === 'playing') render(); });
function maybeShowHelp() { let seen = false; try { seen = !!localStorage.getItem('rummi-help-seen'); } catch {} if (!seen) $('help').classList.remove('hidden'); }

renderSetupRows();
show('setup');
checkResume();
// 홈 화면 추가(PWA): 같은 기기 모드는 오프라인도 됨
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    // 새 버전이 설치되면 알림(게임 중엔 방해 안 되게 띠만)
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showNotice('새 버전이 있어요.', '새로고침', () => location.reload()); });
    });
  }).catch(() => {});
}
