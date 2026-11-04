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
export function planCpuTurn({ table, rack, hasMelded }) {
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
  return played ? { action: 'play', table: newTable, rack: newRack } : { action: 'draw' };
}
