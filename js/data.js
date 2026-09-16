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
      { id: 'pullup_12kg', name: '중량 풀업', defaultWeightKg: 12, repMin: 6, repMax: 10, sets: 4, perLeg: false },
      { id: 'ringdips_12kg', name: '중량 링딥스', defaultWeightKg: 12, repMin: 6, repMax: 10, sets: 4, perLeg: false },
      { id: 'pullup_bw', name: '맨몸 풀업', defaultWeightKg: 0, repMin: 8, repMax: 12, sets: 3, perLeg: false },
      { id: 'ringdips_bw', name: '맨몸 링딥스', defaultWeightKg: 0, repMin: 8, repMax: 12, sets: 3, perLeg: false },
    ],
  },
  [SPLIT_IDS.SHOULDER_LEGS_ABS]: {
    id: SPLIT_IDS.SHOULDER_LEGS_ABS,
    name: '어깨·하체·복근',
    type: 'strength',
    exercises: [
      { id: 'backsquat_40kg', name: '백스쿼트', defaultWeightKg: 40, repMin: 10, repMax: 15, sets: 4, perLeg: false },
      // NOTE: user changed OHP from 3 to 4 sets.
      { id: 'ohp_40kg', name: 'OHP', defaultWeightKg: 40, repMin: 8, repMax: 12, sets: 4, perLeg: false },
      { id: 'lunge_40kg', name: '런지', defaultWeightKg: 40, repMin: 8, repMax: 12, sets: 3, perLeg: true },
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
      lsd: {
        id: 'run_lsd',
        name: 'LSD',
        type: 'lsd',
        distanceMinKm: 10,
        distanceMaxKm: 15,
        // 6:40/km = 400s, 7:20/km = 440s
        paceMinSecPerKm: 400,
        paceMaxSecPerKm: 440,
        note: '천천히 오래 (LSD)',
      },
      tempo: {
        id: 'run_tempo',
        name: '템포런',
        type: 'tempo',
        distanceMinKm: 6,
        distanceMaxKm: 10,
        // 5:30/km = 330s, 5:50/km = 350s
        paceMinSecPerKm: 330,
        paceMaxSecPerKm: 350,
        note: '지속주 (템포)',
      },
    },
  },
};

// --- Exercise library seed ---------------------------------------------------
// Default library entries. Includes the default splits' strength exercises plus
// a handful of sensible common ones. Each entry mirrors the split-exercise shape
// (name, defaultWeightKg, repMin, repMax, sets, perLeg) plus an id.
export const EXERCISE_LIBRARY_SEED = [
  // --- Common additions ---
  { id: 'lib_bench_press', name: '벤치프레스', defaultWeightKg: 40, repMin: 6, repMax: 10, sets: 4, perLeg: false },
  { id: 'lib_deadlift', name: '데드리프트', defaultWeightKg: 60, repMin: 5, repMax: 8, sets: 3, perLeg: false },
  { id: 'lib_barbell_row', name: '바벨 로우', defaultWeightKg: 40, repMin: 8, repMax: 12, sets: 4, perLeg: false },
  { id: 'lib_dumbbell_curl', name: '덤벨 컬', defaultWeightKg: 10, repMin: 10, repMax: 15, sets: 3, perLeg: false },
  { id: 'lib_plank', name: '플랭크', defaultWeightKg: 0, repMin: 30, repMax: 60, sets: 3, perLeg: false },
];

// --- Deep clone helper (structuredClone with a JSON fallback) ----------------
function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// Return a FRESH deep-cloned default routine object suitable for seeding
// persisted state. Mutating the returned object never touches the module-level
// SPLIT_CYCLE / SPLITS constants.
export function getDefaultRoutine() {
  return {
    splitCycle: deepClone(SPLIT_CYCLE),
    splits: deepClone(SPLITS),
  };
}

// Return a FRESH deep-cloned default exercise library array for seeding.
// Includes the default splits' strength exercises plus the common additions.
export function getDefaultExerciseLibrary() {
  const seen = new Set();
  const library = [];
  // Strength exercises from the default splits first (preserve their ids).
  for (const splitId of SPLIT_CYCLE) {
    const split = SPLITS[splitId];
    if (!split || !split.exercises) continue;
    for (const ex of split.exercises) {
      if (seen.has(ex.id)) continue;
      seen.add(ex.id);
      library.push(deepClone(ex));
    }
  }
  // Then the common additions.
  for (const ex of EXERCISE_LIBRARY_SEED) {
    if (seen.has(ex.id)) continue;
    seen.add(ex.id);
    library.push(deepClone(ex));
  }
  return library;
}

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
