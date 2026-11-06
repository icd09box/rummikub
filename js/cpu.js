// 단순 CPU: 손패만으로 만들 수 있는 세트를 탐욕적으로 찾고, 등록 후에는 테이블 세트에 한 장씩 덧붙인다.
import { COLORS, analyzeSet, isValidSet, INITIAL_MELD_MIN } from './rules.js';

/** 손패에서 가능한 세트 후보 전부 (조커 포함, 1장까지만 사용) */
function candidateSets(rack) {
  const jokers = rack.filter(t => t.joker);
  const real = rack.filter(t => !t.joker);
  const out = [];
  const push = tiles => { const a = analyzeSet(tiles); if (a.ok) out.push({ tiles, value: a.value }); };
  // 그룹
  for (let n = 1; n <= 13; n++) {
    const byColor = new Map();
    for (const t of real) if (t.num === n && !byColor.has(t.color)) byColor.set(t.color, t);
    const arr = [...byColor.values()];
    if (arr.length >= 3) push(arr);
    if (arr.length >= 2 && jokers.length) push([...arr, jokers[0]]);
    if (arr.length === 3 && jokers.length) push([...arr, jokers[0]]);
  }
  // 런: 색별로 연속 구간
  for (const c of COLORS) {
    const byNum = new Map();
    for (const t of real) if (t.color === c && !byNum.has(t.num)) byNum.set(t.num, t);
    for (let lo = 1; lo <= 13; lo++) {
      for (let hi = lo + 2; hi <= 13; hi++) {
        const tiles = []; let missing = 0;
        for (let n = lo; n <= hi; n++) { if (byNum.has(n)) tiles.push(byNum.get(n)); else missing++; }
        if (missing > 1 || (missing === 1 && !jokers.length)) { if (missing > 1) break; else continue; }
        if (missing === 1) tiles.push(jokers[0]);
        push(tiles);
      }
    }
  }
  return out.sort((a, b) => b.tiles.length - a.tiles.length || b.value - a.value);
}

/** 겹치지 않는 세트 조합을 탐욕적으로 고른다 */
function pickDisjoint(rack) {
  const used = new Set();
  const chosen = [];
  for (const cand of candidateSets(rack)) {
    if (cand.tiles.some(t => used.has(t.id))) continue;
    cand.tiles.forEach(t => used.add(t.id));
    chosen.push(cand);
  }
  return chosen;
}

/**
 * CPU 턴 계산. 테이블/손패를 변경하지 않고 결과만 돌려준다.
 * @returns {{ action:'play', table:Array<Array>, rack:Array } | { action:'draw' }}
 */
export function planCpuTurn({ table, rack, hasMelded, level = 'normal' }) {
  const sets = pickDisjoint(rack);
  const total = sets.reduce((s, x) => s + x.value, 0);
  let newTable = table.map(s => s.slice());
  let newRack = rack.slice();
  let played = false;

  if (!hasMelded) {
    if (total < INITIAL_MELD_MIN) return { action: 'draw' };
    for (const s of sets) { newTable.push(s.tiles); newRack = newRack.filter(t => !s.tiles.includes(t)); }
    return { action: 'play', table: newTable, rack: newRack };
  }
  for (const s of sets) { newTable.push(s.tiles); newRack = newRack.filter(t => !s.tiles.includes(t)); played = true; }
  // 남은 타일을 기존 세트에 덧붙이기 (조커는 아껴 둔다)
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of newRack.filter(x => !x.joker)) {
      for (const set of newTable) {
        if (isValidSet([...set, t])) { set.push(t); newRack = newRack.filter(x => x !== t); played = true; changed = true; break; }
      }
      if (changed) break;
    }
  }
  if (level === 'hard') {
    const r = rearrangePlays(newTable, newRack);
    if (r.played) { newTable = r.table; newRack = r.rack; played = true; }
    const j = finishWithJoker(newTable, newRack);
    if (j) { newTable = j.table; newRack = j.rack; played = true; }
  }
  return played ? { action: 'play', table: newTable, rack: newRack } : { action: 'draw' };
}

/**
 * 어려운 컴퓨터: 바닥 묶음을 다시 짜서 손패를 더 낸다.
 *  ① 긴 연속 묶음을 쪼개 손패 타일을 끼우기 (3-8에 5가 있으면 3-4-5 / 5-6-7-8)
 *  ② 빌릴 수 있는 바닥 타일(4장 묶음의 한 장, 4장 이상 연속의 끝 장)과 손패 2장으로 새 묶음
 * 조커는 손패에 아껴 두고, 바닥 조커는 건드리지 않는다. 더 못 낼 때까지 반복.
 */
export function rearrangePlays(table, rack) {
  let t = table.map(s => s.slice()); let r = rack.slice(); let played = false;
  let progress = true; let guard = 0;
  while (progress && guard++ < 40) {
    progress = false;
    // ① 연속 묶음 쪼개 끼우기
    outer: for (const tile of r.filter(x => !x.joker)) {
      for (let i = 0; i < t.length; i++) {
        const a = analyzeSet(t[i]);
        if (!a.ok || a.kind !== 'run' || t[i].some(x => x.joker) || t[i].length < 6) continue;
        const ordered = a.ordered; const lo = ordered[0].num;
        if (ordered[0].color !== tile.color) continue;
        const k = tile.num - lo;                      // ordered[k].num === tile.num
        if (k < 2 || ordered.length - k < 3) continue; // 왼쪽 lo..n-1 (≥2장)+tile, 오른쪽 n..hi (≥3장)
        const left = [...ordered.slice(0, k), tile], right = ordered.slice(k);
        if (!isValidSet(left) || !isValidSet(right)) continue;
        t.splice(i, 1, left, right); r = r.filter(x => x !== tile); played = progress = true; break outer;
      }
    }
    if (progress) continue;
    // ② 빌린 한 장 + 손패 두 장
    const borrowable = [];
    t.forEach((set, i) => {
      if (set.some(x => x.joker)) return;
      set.forEach(tile => { const rest = set.filter(x => x !== tile); if (rest.length >= 3 && isValidSet(rest)) borrowable.push({ tile, i }); });
    });
    const real = r.filter(x => !x.joker);
    outer2: for (let a = 0; a < real.length; a++) for (let b = a + 1; b < real.length; b++) for (const bw of borrowable) {
      const cand = [real[a], real[b], bw.tile];
      if (!isValidSet(cand)) continue;
      t[bw.i] = t[bw.i].filter(x => x !== bw.tile); t.push(cand);
      r = r.filter(x => x !== real[a] && x !== real[b]); played = progress = true; break outer2;
    }
    if (progress) continue;
    // ③ 남은 손패를 묶음 끝에 덧붙이기(재배치 뒤 새로 가능해진 것)
    for (const tile of r.filter(x => !x.joker)) {
      const i = t.findIndex(set => isValidSet([...set, tile]));
      if (i >= 0) { t[i] = [...t[i], tile]; r = r.filter(x => x !== tile); played = progress = true; break; }
    }
  }
  return { table: t, rack: r, played };
}

/** 어려운 컴퓨터: 손패가 3장 이하이고 조커가 있으면, 조커를 써서 이번 차례에 다 내거나 1장만 남길 수 있을 때만 쓴다 */
export function finishWithJoker(table, rack) {
  const joker = rack.find(t => t.joker);
  if (!joker || rack.length > 3) return null;
  const others = rack.filter(t => t !== joker);
  // ① 조커 + 나머지 전부가 한 묶음 → 다 냄
  if (others.length >= 2 && isValidSet([...others, joker])) return { table: [...table, [...others, joker]], rack: [] };
  // ② 조커(+1장)를 바닥 묶음에 덧붙여 비우기
  const tryAppend = tiles => { const i = table.findIndex(set => isValidSet([...set, ...tiles])); return i < 0 ? null : table.map((set, k) => (k === i ? [...set, ...tiles] : set)); };
  if (others.length === 0) { const t = tryAppend([joker]); if (t) return { table: t, rack: [] }; }
  if (others.length === 1) {
    const t1 = tryAppend([joker, others[0]]); if (t1) return { table: t1, rack: [] };
    const t2 = tryAppend([joker]); if (t2) return { table: t2, rack: others };   // 1장만 남김
  }
  return null;
}
