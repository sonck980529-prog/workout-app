// progression.js — PURE functions only. No DOM, no localStorage.
// Implements the operating rules for the routine so they are unit-testable in node.

import { SPLIT_CYCLE, SPLIT_IDS } from './data.js';

// --- Named constants (thresholds & guidance text) ---------------------------
export const DEFAULT_WEIGHT_INCREMENT_KG = 2.5; // 소폭 증량 기본값
export const DEFAULT_REP_INCREMENT = 1; // +1회 (rule allows 1~2)
export const REP_INCREMENT_MAX = 2; // 최대 +2회
export const QUALIFYING_SESSIONS_REQUIRED = 2; // 2회 연속 상한 도달 필요

export const RIR_GUIDANCE_TEXT = '각 세트는 1~2회 여유(RIR 1~2)를 남기고 종료합니다. 기록이 없는 날은 목표를 강행하지 않습니다.';
export const EASY_RUN_FIRST_TEXT = '이지런은 속도보다 호흡·회복을 우선합니다.';

// Pace band classification results.
export const PACE_RESULT = {
  WITHIN: 'within',
  TOO_FAST: 'too_fast',
  TOO_SLOW: 'too_slow',
};

// Progression suggestion types.
export const SUGGESTION_TYPE = {
  INCREASE_WEIGHT: 'increase_weight',
  INCREASE_REPS: 'increase_reps',
  HOLD: 'hold',
};

// (a) Rotation: 등·가슴 -> 어깨·하체·복근 -> 러닝 -> 등·가슴
// PURE. The rotation cycle is passed in so a user-edited cycle can drive
// rotation; it defaults to the hardcoded SPLIT_CYCLE for backward compatibility.
export function nextSplitId(lastSplitId, cycle = SPLIT_CYCLE) {
  const order = Array.isArray(cycle) && cycle.length > 0 ? cycle : SPLIT_CYCLE;
  const idx = order.indexOf(lastSplitId);
  if (idx === -1) {
    // Unknown or no previous split → start at first split of the cycle.
    return order[0];
  }
  return order[(idx + 1) % order.length];
}

// (b) True only when every performed set reps >= repMax AND set count >= target sets.
export function allSetsReachedUpperTarget(exercise, setEntries) {
  if (!exercise || !Array.isArray(setEntries)) return false;
  if (setEntries.length < exercise.sets) return false;
  return setEntries.every(
    (entry) => entry && typeof entry.reps === 'number' && entry.reps >= exercise.repMax
  );
}

// The load (kg) a session was performed at: the minimum weight across its sets,
// so an exercise only "qualifies at a load" when EVERY set carried at least
// that weight. Returns null when no numeric weight is present.
export function sessionLoadKg(setEntries) {
  if (!Array.isArray(setEntries) || setEntries.length === 0) return null;
  const weights = setEntries
    .map((entry) => (entry && typeof entry.weightKg === 'number' ? entry.weightKg : null))
    .filter((w) => w !== null && Number.isFinite(w));
  if (weights.length === 0) return null;
  return Math.min(...weights);
}

// True when the two (or more) qualifying sessions were performed at a
// consistent load — i.e. the per-session minimum weight is the same across
// all of them. A weight increase should only be suggested off a stable base.
export function loadIsConsistent(sessionEntriesList) {
  if (!Array.isArray(sessionEntriesList) || sessionEntriesList.length < 2) return true;
  const loads = sessionEntriesList.map((entries) => sessionLoadKg(entries));
  const first = loads[0];
  if (first === null) return false;
  return loads.every((load) => load !== null && load === first);
}

// (c) Suggest progression only when the SAME exercise reached the upper rep target
// in BOTH of the last two consecutive sessions.
// lastTwoSessionsEntries: array of the last (up to 2) sessions' setEntries arrays,
// where each element is an array of {weightKg, reps}. Any order is fine.
export function suggestProgression(exercise, lastTwoSessionsEntries, options = {}) {
  const hold = (reason) => ({ type: SUGGESTION_TYPE.HOLD, reason });

  if (!exercise) return hold('운동 정보가 없습니다.');
  if (!Array.isArray(lastTwoSessionsEntries)) {
    return hold('기록이 부족합니다.');
  }

  // Consider only the most recent QUALIFYING_SESSIONS_REQUIRED sessions.
  const recent = lastTwoSessionsEntries.slice(-QUALIFYING_SESSIONS_REQUIRED);

  if (recent.length < QUALIFYING_SESSIONS_REQUIRED) {
    return hold('2회 연속 기록이 아직 없습니다. RIR 1~2를 유지하세요.');
  }

  const bothQualified = recent.every((entries) =>
    allSetsReachedUpperTarget(exercise, entries)
  );

  if (!bothQualified) {
    return hold('아직 2회 연속 모든 세트가 상한에 도달하지 않았습니다. 현재 강도를 유지하세요.');
  }

  // Qualified on reps: decide between adding load vs adding reps.
  // Prefer reps for bodyweight exercises. For weighted exercises, only add load
  // when the two qualifying sessions were performed at a CONSISTENT weight — a
  // +kg suggestion off an inconsistent/reduced base would be misleading, so we
  // fall back to a rep suggestion and hold the load until it stabilizes.
  const isBodyweight = (exercise.defaultWeightKg || 0) <= 0;
  const loadConsistent = loadIsConsistent(recent);
  const preferReps = options.preferReps === true || isBodyweight || !loadConsistent;

  if (preferReps && !isBodyweight && !loadConsistent) {
    const deltaReps = Math.min(
      options.deltaReps || DEFAULT_REP_INCREMENT,
      REP_INCREMENT_MAX
    );
    return {
      type: SUGGESTION_TYPE.INCREASE_REPS,
      deltaReps,
      loadInconsistent: true,
      reason: `2회 연속 상한(${exercise.repMax}회)에 도달했지만 두 세션의 무게가 달라 증량 대신 세트당 +${deltaReps}회를 먼저 시도하세요. 같은 무게로 상한을 유지하면 다음에 증량을 제안합니다.`,
    };
  }

  if (preferReps) {
    const deltaReps = Math.min(
      options.deltaReps || DEFAULT_REP_INCREMENT,
      REP_INCREMENT_MAX
    );
    return {
      type: SUGGESTION_TYPE.INCREASE_REPS,
      deltaReps,
      reason: `2회 연속 모든 세트가 상한(${exercise.repMax}회)에 도달했습니다. 다음 회차에 세트당 +${deltaReps}회를 시도하세요.`,
    };
  }

  const deltaKg = options.deltaKg || DEFAULT_WEIGHT_INCREMENT_KG;
  return {
    type: SUGGESTION_TYPE.INCREASE_WEIGHT,
    deltaKg,
    reason: `2회 연속 모든 세트가 상한(${exercise.repMax}회)에 도달했습니다. 다음 회차에 +${deltaKg}kg 소폭 증량하세요.`,
  };
}

// (d) RIR 1~2 reminder text.
export function rirGuidance() {
  return RIR_GUIDANCE_TEXT;
}

// (e) Evaluate a running pace against a running definition (easy-run-first messaging).
// runDef must expose paceMinSecPerKm (fastest) and paceMaxSecPerKm (slowest).
export function evaluatePace(actualSecPerKm, runDef) {
  if (!runDef || typeof actualSecPerKm !== 'number') {
    return { result: null, message: '페이스 정보를 확인할 수 없습니다.' };
  }

  const fastest = runDef.paceMinSecPerKm; // smaller sec/km = faster
  const slowest = runDef.paceMaxSecPerKm; // larger sec/km = slower
  const isEasy = runDef.type === 'easy';

  let result;
  let message;

  if (actualSecPerKm < fastest) {
    result = PACE_RESULT.TOO_FAST;
    message = isEasy
      ? `목표보다 빠릅니다. ${EASY_RUN_FIRST_TEXT}`
      : '반복 구간 목표보다 빠릅니다.';
  } else if (actualSecPerKm > slowest) {
    result = PACE_RESULT.TOO_SLOW;
    message = isEasy
      ? `목표보다 느립니다. ${EASY_RUN_FIRST_TEXT}`
      : '반복 구간 목표보다 느립니다.';
  } else {
    result = PACE_RESULT.WITHIN;
    message = isEasy
      ? `목표 범위 안입니다. ${EASY_RUN_FIRST_TEXT}`
      : '반복 구간 목표 범위 안입니다.';
  }

  return { result, message, isEasy };
}

// (f) Compute target volume range vs actual total volume for a strength exercise.
// Volume = total reps across sets (weight-agnostic count). Returns target min/max
// (based on repMin/repMax * sets), actual total, and whether actual is within range.
export function goalVsActual(exercise, setEntries) {
  if (!exercise || !Array.isArray(setEntries)) {
    return null;
  }
  const targetMin = exercise.repMin * exercise.sets;
  const targetMax = exercise.repMax * exercise.sets;
  const actualTotal = setEntries.reduce(
    (sum, entry) => sum + (entry && typeof entry.reps === 'number' ? entry.reps : 0),
    0
  );

  let status;
  if (actualTotal < targetMin) status = 'below';
  else if (actualTotal > targetMax) status = 'above';
  else status = 'within';

  return {
    targetMinVolume: targetMin,
    targetMaxVolume: targetMax,
    actualVolume: actualTotal,
    status,
  };
}

// Convenience re-export so consumers can build UI without re-importing data ids.
export { SPLIT_CYCLE, SPLIT_IDS };
