import { createGame, current, moveTiles, endTurn, drawTile, resetTurn, checkTurn, runCpuTurn, MIN_PLAYERS, MAX_PLAYERS } from './game.js';
import { analyzeSet, COLORS } from './rules.js';

const $ = id => document.getElementById(id);
const screens = ['setup', 'handoff', 'game', 'over'];
function show(name) { for (const s of screens) $(s).classList.toggle('hidden', s !== name); }

let game = null;
let selected = new Set();   // 선택된 타일 id
let lastHumanShown = -1;    // 핫시트: 손패 공개된 플레이어
let sortMode = 'num';

// ---------- 설정 화면 ----------
function renderSetupRows() {
  const n = Number($('playerCount').value);
  const rows = $('playerRows');
  rows.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span>${i + 1}</span>
      <input type="text" placeholder="플레이어 ${i + 1}" maxlength="10" data-name>
      <select data-type><option value="human">사람</option><option value="cpu" ${i > 0 ? '' : ''}>CPU</option></select>`;
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
  game = createGame(defs);
  selected.clear(); lastHumanShown = -1;
  nextTurnFlow();
});
$('againBtn').addEventListener('click', () => show('setup'));

// ---------- 턴 흐름 ----------
function nextTurnFlow() {
  if (game.phase === 'over') return renderOver();
  const p = current(game);
  if (p.type === 'cpu') {
    show('game'); render(true);
    $('status').textContent = `${p.name}(CPU) 생각 중…`;
    setTimeout(() => { runCpuTurn(game); nextTurnFlow(); }, 700);
    return;
  }
  const humans = game.players.filter(x => x.type === 'human').length;
  if (humans > 1 && lastHumanShown !== p.id) {
    $('handoffName').textContent = p.name;
    show('handoff');
    return;
  }
  show('game'); render();
}
$('handoffBtn').addEventListener('click', () => { lastHumanShown = current(game).id; show('game'); render(); });

// ---------- 렌더링 ----------
function tileEl(t, opts = {}) {
  const el = document.createElement('div');
  el.className = `tile ${t.joker ? 'joker' : t.color}`;
  el.textContent = t.joker ? '☺' : t.num;
  if (selected.has(t.id)) el.classList.add('selected');
  if (opts.isNew) el.classList.add('new');
  if (opts.hidden) el.classList.add('cpu-hidden');
  el.dataset.id = t.id;
  return el;
}

function sortRack(rack) {
  const ci = t => (t.joker ? 99 : COLORS.indexOf(t.color));
  const r = rack.slice();
  if (sortMode === 'num') r.sort((a, b) => (a.joker - b.joker) || a.num - b.num || ci(a) - ci(b));
  else r.sort((a, b) => (a.joker - b.joker) || ci(a) - ci(b) || a.num - b.num);
  return r;
}

function render(cpuView = false) {
  const p = current(game);
  const snapRackIds = new Set(game.snapshot.rack.map(t => t.id));
  const snapSets = game.snapshot.table.map(s => s.map(t => t.id).sort().join(','));

  // 테이블
  const table = $('table');
  table.innerHTML = '';
  game.table.forEach((set, idx) => {
    const a = analyzeSet(set);
    const el = document.createElement('div');
    el.className = 'set' + (a.ok ? '' : ' invalid');
    if (!snapSets.includes(set.map(t => t.id).sort().join(','))) el.classList.add('changed');
    el.dataset.index = idx;
    (a.ok ? a.ordered : set).forEach(t => el.appendChild(tileEl(t, { isNew: snapRackIds.has(t.id) })));
    el.addEventListener('click', e => onSetClick(e, idx));
    table.appendChild(el);
  });

  // 손패
  const rack = $('rack');
  rack.innerHTML = '';
  for (const t of sortRack(p.rack)) {
    const el = tileEl(t, { hidden: cpuView });
    if (!cpuView) el.addEventListener('click', () => { toggle(t.id); render(); });
    rack.appendChild(el);
  }

  // 사이드
  $('players').innerHTML = game.players.map(x => `
    <div class="p ${x.id === p.id ? 'active' : ''}">
      <span>${esc(x.name)}${x.type === 'cpu' ? ' <small>CPU</small>' : ''}</span>
      <span class="meta">${x.rack.length}장${x.hasMelded ? '' : ' · 미등록'}</span>
    </div>`).join('');
  $('poolCount').textContent = game.pool.length;
  $('log').innerHTML = game.log.slice(-30).reverse().map(esc).join('<br>');
  $('status').textContent = cpuView ? '' : `${p.name}의 차례${p.hasMelded ? '' : ' (초기 등록 필요: 30점 이상)'}`;

  // 힌트
  const hint = $('hint');
  const changed = JSON.stringify(game.table.map(s => s.map(t => t.id))) !== JSON.stringify(game.snapshot.table.map(s => s.map(t => t.id)));
  if (!changed) { hint.textContent = '타일을 눌러 선택한 뒤 세트를 누르거나 "새 세트"를 누르세요.'; hint.className = 'hint'; }
  else {
    const r = checkTurn(game);
    hint.textContent = r.ok ? `턴 종료 가능 (${r.placed}장${r.meldValue != null ? `, 등록 ${r.meldValue}점` : ''})` : r.reason;
    hint.className = 'hint ' + (r.ok ? 'good' : 'bad');
  }
  const busy = cpuView;
  for (const id of ['newSetBtn', 'toRackBtn', 'resetBtn', 'drawBtn', 'endBtn', 'sortNumBtn', 'sortColorBtn']) $(id).disabled = busy;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toggle(id) { selected.has(id) ? selected.delete(id) : selected.add(id); }

// ---------- 조작 ----------
function onSetClick(e, idx) {
  const tileNode = e.target.closest('.tile');
  if (tileNode && selected.size === 0) { toggle(Number(tileNode.dataset.id)); return render(); }
  if (tileNode && selected.has(Number(tileNode.dataset.id))) { toggle(Number(tileNode.dataset.id)); return render(); }
  if (selected.size === 0) return;
  moveTiles(game, [...selected], { kind: 'set', index: idx });
  selected.clear(); render();
}
$('newSetBtn').addEventListener('click', () => {
  if (!selected.size) return;
  moveTiles(game, [...selected], { kind: 'new' }); selected.clear(); render();
});
$('toRackBtn').addEventListener('click', () => {
  if (!selected.size) return;
  const snapRackIds = new Set(game.snapshot.rack.map(t => t.id));
  const mine = [...selected].filter(id => snapRackIds.has(id));
  if (mine.length !== selected.size) { flash('이번 턴에 손패에서 꺼낸 타일만 되돌릴 수 있습니다.'); }
  if (mine.length) moveTiles(game, mine, { kind: 'rack' });
  selected.clear(); render();
});
$('resetBtn').addEventListener('click', () => { resetTurn(game); selected.clear(); render(); });
$('sortNumBtn').addEventListener('click', () => { sortMode = 'num'; render(); });
$('sortColorBtn').addEventListener('click', () => { sortMode = 'color'; render(); });
$('drawBtn').addEventListener('click', () => { selected.clear(); drawTile(game); nextTurnFlow(); });
$('endBtn').addEventListener('click', () => {
  const r = endTurn(game);
  if (!r.ok) return flash(r.reason);
  selected.clear(); nextTurnFlow();
});
function flash(msg) { const h = $('hint'); h.textContent = msg; h.className = 'hint bad'; }

// ---------- 종료 ----------
function renderOver() {
  const w = game.players[game.winner];
  $('winnerText').textContent = `🏆 ${w.name} 승리!`;
  $('scoreTable').innerHTML = '<tr><th>플레이어</th><th>남은 타일</th><th>점수</th></tr>' +
    game.players.map(p => `<tr><td>${esc(p.name)}</td><td>${p.rack.length}장</td><td>${p.score > 0 ? '+' : ''}${p.score}</td></tr>`).join('');
  show('over');
}

renderSetupRows();
show('setup');
