// data.js — seed routine definitions for the 3-way-split home workout & running routine.
// Pure data + helpers. No DOM, no localStorage. Safe to import in node.

// --- Split identifiers (stable, language-neutral ids; Korean display names) ---
export const SPLIT_IDS = {
  CHEST_BACK: 'chest_back', // 등·가슴
  SHOULDER_LEGS_ABS: 'shoulder_legs_abs', // 어깨·하체·복근
  RUNNING: 'running', // 러닝
};

// Ordered rotation cycle: 등·가슴 -> 어깨·하체·복근 -> 러닝 (repeats)
export const SPLIT_CYCLE = [
  SPLIT_IDS.CHEST_BACK,
  SPLIT_IDS.SHOULDER_LEGS_ABS,
  SPLIT_IDS.RUNNING,
];

// --- Strength exercises ------------------------------------------------------
// Each exercise: id, name (Korean), defaultWeightKg, repMin, repMax, sets, perLeg
export const SPLITS = {
  [SPLIT_IDS.CHEST_BACK]: {
    id: SPLIT_IDS.CHEST_BACK,
    name: '등·가슴',
    type: 'strength',
    exercises: [
      { id: 'pullup_12kg', name: '12kg 풀업', defaultWeightKg: 12, repMin: 6, repMax: 10, sets: 4, perLeg: false },
      { id: 'ringdips_12kg', name: '12kg 링딥스', defaultWeightKg: 12, repMin: 6, repMax: 10, sets: 4, perLeg: false },
      { id: 'pullup_bw', name: '맨몸 풀업', defaultWeightKg: 0, repMin: 8, repMax: 12, sets: 3, perLeg: false },
      { id: 'ringdips_bw', name: '맨몸 링딥스', defaultWeightKg: 0, repMin: 8, repMax: 12, sets: 3, perLeg: false },
    ],
  },
  [SPLIT_IDS.SHOULDER_LEGS_ABS]: {
    id: SPLIT_IDS.SHOULDER_LEGS_ABS,
    name: '어깨·하체·복근',
    type: 'strength',
    exercises: [
      { id: 'backsquat_40kg', name: '40kg 백스쿼트', defaultWeightKg: 40, repMin: 10, repMax: 15, sets: 4, perLeg: false },
      // NOTE: user changed OHP from 3 to 4 sets.
      { id: 'ohp_40kg', name: '40kg OHP', defaultWeightKg: 40, repMin: 8, repMax: 12, sets: 4, perLeg: false },
      { id: 'lunge_40kg', name: '40kg 런지', defaultWeightKg: 40, repMin: 8, repMax: 12, sets: 3, perLeg: true },
      { id: 'lateral_raise', name: '사이드 레터럴 레이즈', defaultWeightKg: 0, repMin: 12, repMax: 15, sets: 3, perLeg: false },
      { id: 'hanging_leg_raise', name: '행잉 레그레이즈', defaultWeightKg: 0, repMin: 10, repMax: 15, sets: 3, perLeg: false },
    ],
  },
  [SPLIT_IDS.RUNNING]: {
    id: SPLIT_IDS.RUNNING,
    name: '러닝',
    type: 'running',
    // Two running variants. Paces stored as seconds/km (integer) for reliable math.
    runs: {
      easy: {
        id: 'run_easy',
        name: '이지런 (조깅)',
        type: 'easy',
        distanceMinKm: 5,
        distanceMaxKm: 7,
        // 6:15/km = 375s, 6:40/km = 400s
        paceMinSecPerKm: 375,
        paceMaxSecPerKm: 400,
        note: '대화 가능한 호흡',
      },
      interval: {
        id: 'run_interval',
        name: '인터벌',
        type: 'interval',
        // 총 7~8km (웜업 1.5km + 1km 반복 4회 + 회복 조깅 + 쿨다운)
        distanceMinKm: 7,
        distanceMaxKm: 8,
        warmupKm: 1.5,
        repDistanceKm: 1,
        repCount: 4,
        // 5:10/km = 310s, 5:20/km = 320s (반복 구간 페이스)
        // NOTE: this band grades the 1km REP SEGMENTS, not the whole-run average.
        // The whole run (warmup + reps + recovery + cooldown) is naturally slower,
        // so interval sessions capture a separate rep-segment pace to grade here.
        paceMinSecPerKm: 310,
        paceMaxSecPerKm: 320,
        // Marks that the pace band applies to the rep segment, not the whole run.
        paceAppliesTo: 'rep_segment',
        note: '반복 구간 페이스 (웜업 1.5km + 1km x4 + 회복 조깅 + 쿨다운)',
      },
    },
  },
};

// --- Helpers -----------------------------------------------------------------

// Return the ordered split cycle (array of split ids).
export function getSplitCycle() {
  return [...SPLIT_CYCLE];
}

// Return the ordered array of split definition objects.
export function getSplits() {
  return SPLIT_CYCLE.map((id) => SPLITS[id]);
}

// Look up a split definition by id.
export function getSplit(splitId) {
  return SPLITS[splitId] || null;
}

// Look up a single strength exercise by its id across all splits.
export function getExercise(exerciseId) {
  for (const splitId of SPLIT_CYCLE) {
    const split = SPLITS[splitId];
    if (!split.exercises) continue;
    const found = split.exercises.find((ex) => ex.id === exerciseId);
    if (found) return found;
  }
  return null;
}

// Return a running definition ('easy' | 'interval').
export function getRun(runType) {
  return SPLITS[SPLIT_IDS.RUNNING].runs[runType] || null;
}
