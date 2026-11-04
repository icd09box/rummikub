// 루미큐브 규칙 엔진 — 순수 함수만. UI/상태 없음.
export const COLORS = ['red', 'blue', 'black', 'orange'];
export const JOKER_VALUE = 30;
export const INITIAL_MELD_MIN = 30;
export const HAND_SIZE = 14;

/** 106장 생성: 1~13 × 4색 × 2 + 조커 2 */
export function createTiles() {
  const tiles = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of COLORS) {
      for (let num = 1; num <= 13; num++) {
        tiles.push({ id: id++, color, num, joker: false });
      }
    }
  }
  tiles.push({ id: id++, color: null, num: 0, joker: true });
  tiles.push({ id: id++, color: null, num: 0, joker: true });
  return tiles;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 그룹 판정: 같은 숫자, 서로 다른 색, 3~4장. 조커 허용.
 * 반환: { ok, value } (value = 초기 등록 점수용, 조커는 대체한 숫자 값)
 */
export function analyzeGroup(tiles) {
  if (tiles.length < 3 || tiles.length > 4) return { ok: false };
  const real = tiles.filter(t => !t.joker);
  if (real.length === 0) return { ok: false }; // 조커만으론 불가
  const num = real[0].num;
  if (!real.every(t => t.num === num)) return { ok: false };
  const colors = new Set(real.map(t => t.color));
  if (colors.size !== real.length) return { ok: false };
  return { ok: true, value: num * tiles.length };
}

/**
 * 런 판정: 같은 색, 연속 숫자, 3장 이상, 1~13 범위(순환 없음). 조커 허용.
 * 입력 순서는 무시하고 재배열 가능한지로 판정.
 * 반환: { ok, value, ordered } — ordered는 조커 위치가 정해진 순서(표시용)
 */
export function analyzeRun(tiles) {
  if (tiles.length < 3 || tiles.length > 13) return { ok: false };
  const real = tiles.filter(t => !t.joker);
  const jokers = tiles.filter(t => t.joker);
  if (real.length === 0) return { ok: false };
  const color = real[0].color;
  if (!real.every(t => t.color === color)) return { ok: false };
  const nums = real.map(t => t.num).sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) if (nums[i] === nums[i - 1]) return { ok: false };
  const lo = nums[0], hi = nums[nums.length - 1];
  const gaps = (hi - lo + 1) - nums.length;
  if (gaps > jokers.length) return { ok: false };
  let extra = jokers.length - gaps;
  // 남는 조커를 끝에 붙인다: 위쪽 먼저, 13 넘으면 아래쪽
  let top = hi, bottom = lo;
  while (extra > 0) {
    if (top < 13) top++;
    else if (bottom > 1) bottom--;
    else return { ok: false };
    extra--;
  }
  if (top - bottom + 1 !== tiles.length) return { ok: false };
  // 순서 구성
  const byNum = new Map(real.map(t => [t.num, t]));
  const jokerPool = jokers.slice();
  const ordered = [];
  let value = 0;
  for (let n = bottom; n <= top; n++) {
    const t = byNum.get(n) || jokerPool.pop();
    ordered.push(t);
    value += n;
  }
  return { ok: true, value, ordered };
}

/** 세트(그룹 또는 런) 유효성. 반환 { ok, kind, value, ordered } */
export function analyzeSet(tiles) {
  const g = analyzeGroup(tiles);
  if (g.ok) return { ok: true, kind: 'group', value: g.value, ordered: orderGroup(tiles) };
  const r = analyzeRun(tiles);
  if (r.ok) return { ok: true, kind: 'run', value: r.value, ordered: r.ordered };
  return { ok: false };
}

function orderGroup(tiles) {
  const idx = c => (c === null ? 99 : COLORS.indexOf(c));
  return tiles.slice().sort((a, b) => idx(a.color) - idx(b.color));
}

export function isValidSet(tiles) {
  return analyzeSet(tiles).ok;
}

/** 손패 점수(패배 시 감점): 조커 30 */
export function rackPenalty(tiles) {
  return tiles.reduce((s, t) => s + (t.joker ? JOKER_VALUE : t.num), 0);
}

const idSet = tiles => new Set(tiles.map(t => t.id));
const sameTiles = (a, b) => a.length === b.length && a.every(t => idSet(b).has(t.id));

/**
 * 턴 종료 검증.
 * @param {Object} p
 * @param {Array<Array>} p.tableBefore  턴 시작 시 테이블 세트들
 * @param {Array<Array>} p.tableAfter   턴 종료 시 테이블 세트들
 * @param {Array} p.rackBefore           턴 시작 시 손패
 * @param {Array} p.rackAfter            턴 종료 시 손패
 * @param {boolean} p.hasMelded          이미 초기 등록을 했는가
 * @returns {{ok:boolean, reason?:string, placed:number, meldValue?:number}}
 */
export function validateTurn({ tableBefore, tableAfter, rackBefore, rackAfter, hasMelded }) {
  // 1. 타일 보존: before(테이블+손패) == after(테이블+손패)
  const beforeIds = [...tableBefore.flat(), ...rackBefore].map(t => t.id).sort();
  const afterIds = [...tableAfter.flat(), ...rackAfter].map(t => t.id).sort();
  if (beforeIds.length !== afterIds.length || beforeIds.some((v, i) => v !== afterIds[i])) {
    return { ok: false, reason: '타일 개수가 맞지 않아요.', placed: 0 };
  }
  // 2. 테이블에서 손패로 되돌아간 타일 금지
  const tableBeforeIds = idSet(tableBefore.flat());
  if (rackAfter.some(t => tableBeforeIds.has(t.id))) {
    return { ok: false, reason: '바닥에 있던 타일은 내 쪽으로 가져올 수 없어요.', placed: 0 };
  }
  // 3. 최소 1장 내려놓기
  const rackAfterIds = idSet(rackAfter);
  const placedTiles = rackBefore.filter(t => !rackAfterIds.has(t.id));
  if (placedTiles.length === 0) {
    return { ok: false, reason: '타일을 한 장도 안 냈어요. 낼 게 없으면 "못 내면 뽑기"를 누르세요.', placed: 0 };
  }
  // 4. 모든 세트 유효
  for (const set of tableAfter) {
    if (set.length === 0) continue;
    if (!isValidSet(set)) {
      return { ok: false, reason: '빨간 테두리 묶음이 규칙에 안 맞아요. (같은 숫자·다른 색 3~4장, 또는 같은 색·이어지는 숫자 3장 이상)', placed: placedTiles.length };
    }
  }
  // 5. 초기 등록: 기존 세트는 그대로, 새 세트는 전부 내 손패 타일, 합계 ≥ 30
  if (!hasMelded) {
    const placedIds = idSet(placedTiles);
    let meldValue = 0;
    const afterNonEmpty = tableAfter.filter(s => s.length > 0);
    const untouchedBefore = [];
    for (const set of afterNonEmpty) {
      const allNew = set.every(t => placedIds.has(t.id));
      if (allNew) {
        meldValue += analyzeSet(set).value;
      } else {
        const matched = tableBefore.find(b => sameTiles(b, set));
        if (!matched) {
          return { ok: false, reason: '처음 30점을 내기 전에는 바닥 묶음을 건드릴 수 없어요. 내 타일만으로 내세요.', placed: placedTiles.length };
        }
        untouchedBefore.push(matched);
      }
    }
    if (untouchedBefore.length !== tableBefore.length) {
      return { ok: false, reason: '처음 30점을 내기 전에는 바닥 묶음을 건드릴 수 없어요. 내 타일만으로 내세요.', placed: placedTiles.length };
    }
    if (meldValue < INITIAL_MELD_MIN) {
      return { ok: false, reason: `처음 낼 때는 내 타일만으로 합계 ${INITIAL_MELD_MIN}점 이상이어야 해요. (지금 ${meldValue}점)`, placed: placedTiles.length, meldValue };
    }
    return { ok: true, placed: placedTiles.length, meldValue };
  }
  return { ok: true, placed: placedTiles.length };
}

/**
 * 세트에 타일들을 더했을 때 '앞으로 유효한 세트가 될 수 있는가' (자동 붙이기용).
 * 완성 여부가 아니라 호환성만 본다: 같은 숫자·다른 색(≤4) 또는 같은 색·다른 숫자·빈칸≤조커 수.
 */
export function canExtend(set, tiles) {
  const all = [...set, ...tiles];
  if (all.length > 13) return false;
  const real = all.filter(t => !t.joker);
  const jokers = all.length - real.length;
  if (real.length === 0) return true;
  // 그룹 가능성
  const nums = new Set(real.map(t => t.num));
  const colors = new Set(real.map(t => t.color));
  if (nums.size === 1 && colors.size === real.length && all.length <= 4) return true;
  // 런 가능성
  if (colors.size === 1 && nums.size === real.length) {
    const sorted = [...nums].sort((a, b) => a - b);
    const gaps = (sorted[sorted.length - 1] - sorted[0] + 1) - sorted.length;
    return gaps <= jokers;
  }
  return false;
}
