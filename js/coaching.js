// coaching.js — PURE trend-analysis functions for the auto-coaching feature.
// No DOM, no localStorage. Imports ONLY pure helpers from progression.js/data.js
// so it stays unit-testable in node and reuses (never duplicates) existing math.

import {
  allSetsReachedUpperTarget,
  sessionLoadKg,
  loadIsConsistent,
  DEFAULT_WEIGHT_INCREMENT_KG,
  DEFAULT_REP_INCREMENT,
  REP_INCREMENT_MAX,
} from './progression.js';

// --- Named, documented constants --------------------------------------------

// Number of most-recent CONSECUTIVE sessions that must all reach the upper rep
// target (on a consistent load for weighted exercises) before we surface a
// "목표 상향 제안" (goal-up) proposal. ~3 sessions ≈ 3 weeks of training.
export const QUALIFYING_WINDOW = 3;

// Number of most-recent CONSECUTIVE sessions that must all FAIL to reach the
// upper rep target before we surface a "정체 감지" (plateau) deload suggestion.
export const PLATEAU_WINDOW = 3;

// Weighted deload reduces the working load to ~90% (a ~10% cut), then rounds to
// the nearest sensible 0.5kg step. Documented so the UI can explain the amount.
export const DELOAD_WEIGHT_FACTOR = 0.9;

// --- Korean guidance text used by the proposals ------------------------------
export const GOAL_UP_WEIGHT_TEXT =
  '최근 세 세션 연속 모든 세트가 목표 상한에 도달했습니다. 소폭 증량으로 다음 목표를 올려보세요.';
export const GOAL_UP_REPS_TEXT =
  '최근 세 세션 연속 모든 세트가 목표 상한에 도달했습니다. 반복 목표를 올려보세요.';
export const PLATEAU_WEIGHT_TEXT =
  '세 세션 연속 상한에 못 미쳤습니다. 무게를 약 10% 낮춰 디로드로 회복하세요.';
export const PLATEAU_SETS_TEXT =
  '세 세션 연속 상한에 못 미쳤습니다. 세트 수를 한 세트 줄여 디로드하세요.';

// --- Helpers -----------------------------------------------------------------

// Round a kg value to the nearest 0.5kg step (the app's smallest plate step).
function roundToHalfKg(kg) {
  return Math.round(kg * 2) / 2;
}

// Derive the load the user actually plateaued at, given the trailing stagnant
// sessions (each an array of {weightKg, reps} set entries, oldest->newest).
// Uses the most-recent session's per-session load (sessionLoadKg = MIN weight
// of that session) so the deload anchors on what was most recently lifted, and
// only when that load is consistent across the whole plateau slice — otherwise
// the load is drifting and there is no single "current weight" to cut from, so
// we return null and let the caller fall back to the routine default.
function observedPlateauLoad(plateauSlice) {
  if (!Array.isArray(plateauSlice) || plateauSlice.length === 0) return null;
  const latest = sessionLoadKg(plateauSlice[plateauSlice.length - 1]);
  if (latest === null) return null;
  if (!loadIsConsistent(plateauSlice)) return null;
  return latest;
}

// (1) qualifyingStreak(exercise, sessionEntriesList)
// sessionEntriesList: array of per-session setEntries arrays oldest->newest,
// each element being [{weightKg, reps}, ...] (the shape suggestProgression uses).
// Walks from the most recent session backwards and counts consecutive sessions
// where allSetsReachedUpperTarget is true. For weighted exercises the counted
// sessions must also share a consistent load (loadIsConsistent over the slice).
// Returns { streak, load } where load is the shared load, or null for
// bodyweight / no-load / inconsistent input. Robust to empty/short input.
export function qualifyingStreak(exercise, sessionEntriesList) {
  if (!exercise || !Array.isArray(sessionEntriesList) || sessionEntriesList.length === 0) {
    return { streak: 0, load: null };
  }

  const isBodyweight = (exercise.defaultWeightKg || 0) <= 0;

  // Count consecutive upper-target sessions from the most recent backwards.
  let streak = 0;
  for (let i = sessionEntriesList.length - 1; i >= 0; i -= 1) {
    if (allSetsReachedUpperTarget(exercise, sessionEntriesList[i])) {
      streak += 1;
    } else {
      break;
    }
  }

  if (streak === 0) return { streak: 0, load: null };

  const qualifyingSlice = sessionEntriesList.slice(sessionEntriesList.length - streak);

  if (isBodyweight) {
    // Bodyweight exercises have no meaningful load gate.
    return { streak, load: null };
  }

  // Weighted: require a consistent load across the counted sessions. When the
  // load drifts, only the trailing run at the most-recent load qualifies.
  if (loadIsConsistent(qualifyingSlice)) {
    return { streak, load: sessionLoadKg(qualifyingSlice[qualifyingSlice.length - 1]) };
  }

  // Shrink the window from the most recent backwards until the load is stable.
  let stable = 1;
  const latestLoad = sessionLoadKg(qualifyingSlice[qualifyingSlice.length - 1]);
  if (latestLoad === null) return { streak: 0, load: null };
  for (let i = qualifyingSlice.length - 2; i >= 0; i -= 1) {
    if (sessionLoadKg(qualifyingSlice[i]) === latestLoad) {
      stable += 1;
    } else {
      break;
    }
  }
  return { streak: stable, load: latestLoad };
}

// (2) proposeTargetChange(exercise, sessionEntriesList, options)
// When the qualifying streak reaches the window, returns a storage-ready
// proposal. Otherwise returns { qualified:false, streak, required } so the UI
// can render progress like "2/3". Weighted + consistent load -> weight bump;
// bodyweight or inconsistent load -> rep bump. patch keys are limited to
// defaultWeightKg / repMin / repMax / sets so storage.updateExercise accepts them.
export function proposeTargetChange(exercise, sessionEntriesList, options = {}) {
  const window = options.window || QUALIFYING_WINDOW;
  const { streak, load } = qualifyingStreak(exercise, sessionEntriesList);

  if (!exercise || streak < window) {
    return { qualified: false, streak: exercise ? streak : 0, required: window };
  }

  const isBodyweight = (exercise.defaultWeightKg || 0) <= 0;
  // A weight bump only makes sense off a known, stable load.
  const canBumpWeight = !isBodyweight && load !== null;

  const current = {
    defaultWeightKg: exercise.defaultWeightKg,
    repMin: exercise.repMin,
    repMax: exercise.repMax,
    sets: exercise.sets,
  };

  if (canBumpWeight) {
    const deltaKg = options.deltaKg || DEFAULT_WEIGHT_INCREMENT_KG;
    const nextWeight = exercise.defaultWeightKg + deltaKg;
    return {
      qualified: true,
      kind: 'weight',
      current,
      proposed: { ...current, defaultWeightKg: nextWeight },
      patch: { defaultWeightKg: nextWeight },
      reason: GOAL_UP_WEIGHT_TEXT,
    };
  }

  // Bodyweight or inconsistent/unknown load -> add reps instead.
  const delta = Math.min(options.deltaReps || DEFAULT_REP_INCREMENT, REP_INCREMENT_MAX);
  return {
    qualified: true,
    kind: 'reps',
    current,
    proposed: { ...current, repMin: exercise.repMin + delta, repMax: exercise.repMax + delta },
    patch: { repMin: exercise.repMin + delta, repMax: exercise.repMax + delta },
    reason: GOAL_UP_REPS_TEXT,
  };
}

// (3) detectPlateau(exercise, sessionEntriesList, options)
// Counts the most-recent consecutive sessions that FAILED to reach the upper
// target. At/above the window, returns a deload suggestion. Weighted (>0kg) ->
// deload_weight (load * DELOAD_WEIGHT_FACTOR rounded to 0.5kg, never below 0).
// Bodyweight, or when sets>1, -> deload_sets (sets-1, min 1). Guards short input.
//
// The deload cut is based on the OBSERVED plateau load (the load the user
// actually ground the last consistent sessions at), mirroring the goal-up path
// which reasons about the observed session load — so the two paths agree on
// what "current weight" means. We fall back to exercise.defaultWeightKg only
// when the observed load can't be determined (no numeric weights logged, or the
// plateau sessions drift across loads). See `observedPlateauLoad` below.
export function detectPlateau(exercise, sessionEntriesList, options = {}) {
  const window = options.window || PLATEAU_WINDOW;
  if (!exercise || !Array.isArray(sessionEntriesList) || sessionEntriesList.length === 0) {
    return { plateaued: false, streak: 0 };
  }

  let streak = 0;
  for (let i = sessionEntriesList.length - 1; i >= 0; i -= 1) {
    if (!allSetsReachedUpperTarget(exercise, sessionEntriesList[i])) {
      streak += 1;
    } else {
      break;
    }
  }

  if (streak < window) {
    return { plateaued: false, streak };
  }

  const isWeighted = (exercise.defaultWeightKg || 0) > 0;

  if (isWeighted) {
    // Prefer the observed plateau load; fall back to the routine default when
    // it can't be derived. Keeps the goal-up and deload paths symmetric.
    const plateauSlice = sessionEntriesList.slice(sessionEntriesList.length - streak);
    const observed = observedPlateauLoad(plateauSlice);
    const basis = observed !== null ? observed : exercise.defaultWeightKg;
    // ~10% reduction rounded to a 0.5kg step; never below 0.
    const reduced = Math.max(0, roundToHalfKg(basis * DELOAD_WEIGHT_FACTOR));
    return {
      plateaued: true,
      streak,
      basisWeightKg: basis,
      suggestion: {
        kind: 'deload_weight',
        patch: { defaultWeightKg: reduced },
        reason: PLATEAU_WEIGHT_TEXT,
      },
    };
  }

  // Bodyweight (or otherwise) -> drop a set (min 1).
  const reducedSets = Math.max(1, exercise.sets - 1);
  return {
    plateaued: true,
    streak,
    suggestion: {
      kind: 'deload_sets',
      patch: { sets: reducedSets },
      reason: PLATEAU_SETS_TEXT,
    },
  };
}

// --- Weekly review helpers ---------------------------------------------------

// Parse a 'YYYY-MM-DD' date string into a UTC day-number (days since epoch).
// Pure and timezone-stable (no local Date parsing quirks).
function dayNumber(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(utcMs / 86400000);
}

// Total reps logged in a strength session (weight-agnostic volume count).
function sessionTotalReps(session) {
  if (!session || !session.entriesByExercise) return 0;
  let total = 0;
  for (const exId of Object.keys(session.entriesByExercise)) {
    const sets = session.entriesByExercise[exId];
    if (!Array.isArray(sets)) continue;
    for (const set of sets) {
      if (set && typeof set.reps === 'number') total += set.reps;
    }
  }
  return total;
}

// Best (fastest) running pace in a session, given a run type. Returns the
// smaller sec/km (faster) using repPaceSecPerKm for intervals when present.
function sessionRunPace(session, type) {
  if (!session || !session.run || session.run.type !== type) return null;
  const run = session.run;
  if (type === 'interval') {
    if (typeof run.repPaceSecPerKm === 'number') return run.repPaceSecPerKm;
    return typeof run.paceSecPerKm === 'number' ? run.paceSecPerKm : null;
  }
  return typeof run.paceSecPerKm === 'number' ? run.paceSecPerKm : null;
}

// (4) computeWeeklyReview(sessions, options)
// PURE + deterministic. Window: a ROLLING 7-DAY window ending on the most-recent
// session date. thisWeek = dates in [maxDate-6d, maxDate]; prevWeek =
// [maxDate-13d, maxDate-7d]. The anchor can be overridden with options.now
// ('YYYY-MM-DD') but Date.now() is NEVER read here so tests stay stable.
export function computeWeeklyReview(sessions, options = {}) {
  const empty = {
    hasData: false,
    weekStart: null,
    weekEnd: null,
    sessionCount: 0,
    prs: [],
    totalVolumeThisWeek: 0,
    totalVolumePrevWeek: 0,
    volumeChangePct: null,
    runningPace: { easyDeltaSec: null, intervalDeltaSec: null },
    nextWeekHint: '',
  };

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return empty;
  }

  // Determine the anchor day (most-recent session date, or options.now).
  const dayNums = sessions
    .map((s) => dayNumber(s && s.date))
    .filter((d) => d !== null);
  if (dayNums.length === 0) return empty;

  const anchor = options.now != null ? dayNumber(options.now) : Math.max(...dayNums);
  if (anchor === null) return empty;

  const thisStart = anchor - 6;
  const prevStart = anchor - 13;
  const prevEnd = anchor - 7;

  const inWindow = (d, lo, hi) => d !== null && d >= lo && d <= hi;

  const thisWeek = [];
  const prevWeek = [];
  for (const s of sessions) {
    const d = dayNumber(s && s.date);
    if (inWindow(d, thisStart, anchor)) thisWeek.push(s);
    else if (inWindow(d, prevStart, prevEnd)) prevWeek.push(s);
  }

  const totalVolumeThisWeek = thisWeek.reduce((sum, s) => sum + sessionTotalReps(s), 0);
  const totalVolumePrevWeek = prevWeek.reduce((sum, s) => sum + sessionTotalReps(s), 0);

  const volumeChangePct =
    totalVolumePrevWeek > 0
      ? Math.round(((totalVolumeThisWeek - totalVolumePrevWeek) / totalVolumePrevWeek) * 100)
      : null;

  // PR detection: for each exercise, the max weight (and reps at that weight)
  // this week that exceeds every EARLIER (pre-this-week) session for that exId.
  const priorSessions = sessions.filter((s) => {
    const d = dayNumber(s && s.date);
    return d !== null && d < thisStart;
  });
  const priorMaxWeight = {};
  const priorMaxReps = {};
  for (const s of priorSessions) {
    if (!s.entriesByExercise) continue;
    for (const exId of Object.keys(s.entriesByExercise)) {
      const sets = s.entriesByExercise[exId];
      if (!Array.isArray(sets)) continue;
      for (const set of sets) {
        if (!set) continue;
        if (typeof set.weightKg === 'number') {
          if (priorMaxWeight[exId] === undefined || set.weightKg > priorMaxWeight[exId]) {
            priorMaxWeight[exId] = set.weightKg;
          }
        }
        if (typeof set.reps === 'number') {
          if (priorMaxReps[exId] === undefined || set.reps > priorMaxReps[exId]) {
            priorMaxReps[exId] = set.reps;
          }
        }
      }
    }
  }

  const thisMaxWeight = {};
  const thisMaxReps = {};
  const nameById = {};
  for (const s of thisWeek) {
    if (s.exerciseNames) Object.assign(nameById, s.exerciseNames);
    if (!s.entriesByExercise) continue;
    for (const exId of Object.keys(s.entriesByExercise)) {
      const sets = s.entriesByExercise[exId];
      if (!Array.isArray(sets)) continue;
      for (const set of sets) {
        if (!set) continue;
        if (typeof set.weightKg === 'number') {
          if (thisMaxWeight[exId] === undefined || set.weightKg > thisMaxWeight[exId]) {
            thisMaxWeight[exId] = set.weightKg;
          }
        }
        if (typeof set.reps === 'number') {
          if (thisMaxReps[exId] === undefined || set.reps > thisMaxReps[exId]) {
            thisMaxReps[exId] = set.reps;
          }
        }
      }
    }
  }

  const prs = [];
  for (const exId of Object.keys(thisMaxWeight)) {
    const name = nameById[exId] || exId;
    if (priorMaxWeight[exId] !== undefined && thisMaxWeight[exId] > priorMaxWeight[exId]) {
      prs.push({ exId, name, kind: 'weight', value: thisMaxWeight[exId] });
    }
  }
  for (const exId of Object.keys(thisMaxReps)) {
    const name = nameById[exId] || exId;
    // Rep PRs are intentionally WEIGHT-AGNOSTIC: `thisMaxReps`/`priorMaxReps`
    // are the max reps across all sets at ANY load, so a "new max reps" PR can
    // come from a lighter, higher-rep set. This matches the product's simple
    // "개인 최고 반복" definition (a rep count the user has never hit before is
    // still worth celebrating in the weekly review) and keeps sparse-data
    // handling trivial. We deliberately do NOT gate rep PRs to the working
    // load: rep and weight PRs are separate celebrations, and a rep PR is
    // suppressed anyway whenever a weight PR already fired for the same
    // exercise (see hasWeightPr) so the "heavier" signal wins when both occur.
    const hasWeightPr = prs.some((p) => p.exId === exId);
    if (
      !hasWeightPr &&
      priorMaxReps[exId] !== undefined &&
      thisMaxReps[exId] > priorMaxReps[exId]
    ) {
      prs.push({ exId, name, kind: 'reps', value: thisMaxReps[exId] });
    }
  }

  // Running pace deltas: this-week best vs prev-week best. Negative = faster.
  const bestPace = (list, type) => {
    const paces = list.map((s) => sessionRunPace(s, type)).filter((p) => p !== null);
    return paces.length ? Math.min(...paces) : null;
  };
  const easyThis = bestPace(thisWeek, 'easy');
  const easyPrev = bestPace(prevWeek, 'easy');
  const intervalThis = bestPace(thisWeek, 'interval');
  const intervalPrev = bestPace(prevWeek, 'interval');
  const runningPace = {
    easyDeltaSec: easyThis !== null && easyPrev !== null ? easyThis - easyPrev : null,
    intervalDeltaSec:
      intervalThis !== null && intervalPrev !== null ? intervalThis - intervalPrev : null,
  };

  // Compose the "다음 주 추천" hint from the review signals.
  const nextWeekHint = buildNextWeekHint({
    sessionCount: thisWeek.length,
    volumeChangePct,
    prs,
    runningPace,
  });

  return {
    hasData: true,
    weekStart: thisStart,
    weekEnd: anchor,
    sessionCount: thisWeek.length,
    prs,
    totalVolumeThisWeek,
    totalVolumePrevWeek,
    volumeChangePct,
    runningPace,
    nextWeekHint,
  };
}

// Pure helper: format the "다음 주 추천" line from weekly-review signals.
export function buildNextWeekHint(summary = {}) {
  const { sessionCount = 0, volumeChangePct = null, prs = [], runningPace = {} } = summary;
  if (sessionCount === 0) {
    return '다음 주에는 최소 한 번의 훈련을 기록해보세요.';
  }
  if (prs.length > 0) {
    return '개인기록을 갱신했습니다. 상향된 목표를 유지하며 회복을 챙기세요.';
  }
  if (volumeChangePct !== null && volumeChangePct < 0) {
    return '지난주보다 볼륨이 줄었습니다. 다음 주에는 세트 완수에 집중하세요.';
  }
  const easyDelta = runningPace.easyDeltaSec;
  if (easyDelta !== null && easyDelta !== undefined && easyDelta > 0) {
    return '이지런 페이스가 느려졌습니다. 회복 위주로 꾸준히 이어가세요.';
  }
  return '현재 강도를 유지하며 다음 주 훈련을 이어가세요.';
}
