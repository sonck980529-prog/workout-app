// logic.test.mjs — dependency-free node test file for progression.js and data.js.
// Run with: NODE_OPTIONS= node tests/logic.test.mjs

import assert from 'node:assert/strict';

import {
  SPLIT_IDS,
  getSplitCycle,
  getSplit,
  getExercise,
  getRun,
  getDefaultRoutine,
  getDefaultExerciseLibrary,
  EXERCISE_LIBRARY_SEED,
} from '../js/data.js';

import {
  nextSplitId,
  allSetsReachedUpperTarget,
  suggestProgression,
  rirGuidance,
  evaluatePace,
  goalVsActual,
  sessionLoadKg,
  loadIsConsistent,
  SUGGESTION_TYPE,
  PACE_RESULT,
  DEFAULT_WEIGHT_INCREMENT_KG,
} from '../js/progression.js';

import {
  niceExtent,
  scaleLinear,
  trendDirection,
  lineChartSvg,
  barChartSvg,
  EMPTY_STATE_TEXT,
} from '../js/charts.js';

import { validateExerciseInput } from '../js/app.js';

import { isValidBackup } from '../js/storage.js';

import {
  QUALIFYING_WINDOW,
  PLATEAU_WINDOW,
  DELOAD_WEIGHT_FACTOR,
  qualifyingStreak,
  proposeTargetChange,
  detectPlateau,
  computeWeeklyReview,
  buildNextWeekHint,
} from '../js/coaching.js';

let passed = 0;
function ok(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    process.exit(1);
  }
}

console.log('data.js');

ok('split cycle order is 등·가슴 -> 어깨·하체·복근 -> 러닝', () => {
  assert.deepEqual(getSplitCycle(), [
    SPLIT_IDS.CHEST_BACK,
    SPLIT_IDS.SHOULDER_LEGS_ABS,
    SPLIT_IDS.RUNNING,
  ]);
});

ok('OHP is 4 sets (user correction)', () => {
  const ohp = getExercise('ohp_40kg');
  assert.equal(ohp.sets, 4);
  assert.equal(ohp.repMin, 8);
  assert.equal(ohp.repMax, 12);
});

ok('등·가슴 has the exact 4 exercises with correct set counts', () => {
  const split = getSplit(SPLIT_IDS.CHEST_BACK);
  assert.equal(split.exercises.length, 4);
  const byId = Object.fromEntries(split.exercises.map((e) => [e.id, e]));
  assert.equal(byId.pullup_12kg.sets, 4);
  assert.equal(byId.ringdips_12kg.sets, 4);
  assert.equal(byId.pullup_bw.sets, 3);
  assert.equal(byId.ringdips_bw.sets, 3);
  assert.equal(byId.pullup_12kg.defaultWeightKg, 12);
});

ok('런지 is per-leg', () => {
  assert.equal(getExercise('lunge_40kg').perLeg, true);
});

ok('running easy + interval paces stored as seconds/km', () => {
  const easy = getRun('easy');
  const interval = getRun('interval');
  assert.equal(easy.paceMinSecPerKm, 375); // 6:15/km
  assert.equal(easy.paceMaxSecPerKm, 400); // 6:40/km
  assert.equal(easy.distanceMinKm, 5);
  assert.equal(easy.distanceMaxKm, 7);
  assert.equal(interval.paceMinSecPerKm, 310); // 5:10/km
  assert.equal(interval.paceMaxSecPerKm, 320); // 5:20/km
  assert.equal(interval.distanceMinKm, 7);
  assert.equal(interval.distanceMaxKm, 8);
  assert.equal(interval.warmupKm, 1.5);
  assert.equal(interval.repCount, 4);
});

console.log('data.js — default routine & exercise library seed (FEAT-004)');

ok('getDefaultRoutine returns the default cycle + splits', () => {
  const routine = getDefaultRoutine();
  assert.deepEqual(routine.splitCycle, [
    SPLIT_IDS.CHEST_BACK,
    SPLIT_IDS.SHOULDER_LEGS_ABS,
    SPLIT_IDS.RUNNING,
  ]);
  assert.equal(routine.splits[SPLIT_IDS.CHEST_BACK].exercises.length, 4);
  assert.equal(routine.splits[SPLIT_IDS.RUNNING].runs.easy.paceMinSecPerKm, 375);
});

ok('getDefaultRoutine is a deep clone (mutating it does not change SPLITS)', () => {
  const routine = getDefaultRoutine();
  routine.splits[SPLIT_IDS.CHEST_BACK].exercises[0].name = 'MUTATED';
  routine.splits[SPLIT_IDS.CHEST_BACK].exercises.push({ id: 'x', name: 'y' });
  routine.splitCycle.push('extra');
  // The pure helper still returns the pristine values.
  const fresh = getSplit(SPLIT_IDS.CHEST_BACK);
  assert.equal(fresh.exercises.length, 4);
  assert.notEqual(fresh.exercises[0].name, 'MUTATED');
  assert.deepEqual(getSplitCycle(), [
    SPLIT_IDS.CHEST_BACK,
    SPLIT_IDS.SHOULDER_LEGS_ABS,
    SPLIT_IDS.RUNNING,
  ]);
});

ok('seeded exercise library contains the default strength exercises', () => {
  const lib = getDefaultExerciseLibrary();
  const ids = new Set(lib.map((e) => e.id));
  // Default split exercises are present.
  assert.ok(ids.has('ohp_40kg'));
  assert.ok(ids.has('pullup_12kg'));
  assert.ok(ids.has('lunge_40kg'));
  // OHP retains its user-corrected 4 sets.
  assert.equal(lib.find((e) => e.id === 'ohp_40kg').sets, 4);
});

ok('seeded exercise library adds the common exercises', () => {
  const lib = getDefaultExerciseLibrary();
  const names = new Set(lib.map((e) => e.name));
  ['벤치프레스', '데드리프트', '바벨 로우', '덤벨 컬', '플랭크'].forEach((n) => {
    assert.ok(names.has(n), `expected library to contain ${n}`);
  });
  assert.equal(EXERCISE_LIBRARY_SEED.length, 5);
});

ok('getDefaultExerciseLibrary has no duplicate ids and is a deep clone', () => {
  const lib = getDefaultExerciseLibrary();
  const ids = lib.map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size);
  lib.find((e) => e.id === 'ohp_40kg').sets = 99;
  assert.equal(getExercise('ohp_40kg').sets, 4); // source unchanged
});

console.log('progression.js — rotation');

ok('rotation wraps 러닝 -> 등·가슴', () => {
  assert.equal(nextSplitId(SPLIT_IDS.CHEST_BACK), SPLIT_IDS.SHOULDER_LEGS_ABS);
  assert.equal(nextSplitId(SPLIT_IDS.SHOULDER_LEGS_ABS), SPLIT_IDS.RUNNING);
  assert.equal(nextSplitId(SPLIT_IDS.RUNNING), SPLIT_IDS.CHEST_BACK);
});

ok('rotation defaults to first split when no/unknown previous', () => {
  assert.equal(nextSplitId(null), SPLIT_IDS.CHEST_BACK);
  assert.equal(nextSplitId('nonsense'), SPLIT_IDS.CHEST_BACK);
});

ok('nextSplitId rotates using a custom cycle argument (FEAT-004)', () => {
  const cycle = ['a', 'b', 'c'];
  assert.equal(nextSplitId('a', cycle), 'b');
  assert.equal(nextSplitId('c', cycle), 'a'); // wraps
  assert.equal(nextSplitId('unknown', cycle), 'a'); // default to first
  assert.equal(nextSplitId(null, cycle), 'a');
  // A two-item edited cycle rotates within itself, not the default 3-split one.
  assert.equal(nextSplitId(SPLIT_IDS.CHEST_BACK, [SPLIT_IDS.CHEST_BACK, SPLIT_IDS.RUNNING]), SPLIT_IDS.RUNNING);
  assert.equal(nextSplitId(SPLIT_IDS.RUNNING, [SPLIT_IDS.CHEST_BACK, SPLIT_IDS.RUNNING]), SPLIT_IDS.CHEST_BACK);
  // Empty/invalid cycle falls back to the default SPLIT_CYCLE.
  assert.equal(nextSplitId(SPLIT_IDS.CHEST_BACK, []), SPLIT_IDS.SHOULDER_LEGS_ABS);
});

console.log('progression.js — upper target detection');

const ohp = getExercise('ohp_40kg'); // repMax 12, sets 4
const W = 40; // ohp default load
const upperSets = [
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 13 },
  { weightKg: W, reps: 12 },
];
const notUpperSets = [
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 11 },
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 12 },
];
const tooFewSets = [
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 12 },
  { weightKg: W, reps: 12 },
];
// Same reps but at a reduced load (misses the consistent-load gate).
const upperSetsLowLoad = [
  { weightKg: W - 10, reps: 12 },
  { weightKg: W - 10, reps: 12 },
  { weightKg: W - 10, reps: 13 },
  { weightKg: W - 10, reps: 12 },
];

ok('allSetsReachedUpperTarget true when all sets >= repMax and set count met', () => {
  assert.equal(allSetsReachedUpperTarget(ohp, upperSets), true);
});

ok('allSetsReachedUpperTarget false when a set is below repMax', () => {
  assert.equal(allSetsReachedUpperTarget(ohp, notUpperSets), false);
});

ok('allSetsReachedUpperTarget false when too few sets', () => {
  assert.equal(allSetsReachedUpperTarget(ohp, tooFewSets), false);
});

console.log('progression.js — suggestProgression');

ok('hold when only one qualifying session', () => {
  const res = suggestProgression(ohp, [upperSets]);
  assert.equal(res.type, SUGGESTION_TYPE.HOLD);
});

ok('increase (weight) when two consecutive qualifying sessions for a weighted exercise', () => {
  const res = suggestProgression(ohp, [upperSets, upperSets]);
  assert.equal(res.type, SUGGESTION_TYPE.INCREASE_WEIGHT);
  assert.equal(res.deltaKg, DEFAULT_WEIGHT_INCREMENT_KG);
});

ok('hold when the second session did not reach upper target', () => {
  const res = suggestProgression(ohp, [upperSets, notUpperSets]);
  assert.equal(res.type, SUGGESTION_TYPE.HOLD);
});

ok('increase (reps) for a bodyweight exercise on two qualifying sessions', () => {
  const bw = getExercise('pullup_bw'); // defaultWeightKg 0, repMax 12, sets 3
  const bwUpper = [{ reps: 12 }, { reps: 12 }, { reps: 12 }];
  const res = suggestProgression(bw, [bwUpper, bwUpper]);
  assert.equal(res.type, SUGGESTION_TYPE.INCREASE_REPS);
  assert.ok(res.deltaReps >= 1 && res.deltaReps <= 2);
});

console.log('progression.js — load consistency gating');

ok('sessionLoadKg returns the per-session minimum load', () => {
  assert.equal(sessionLoadKg([{ weightKg: 40, reps: 12 }, { weightKg: 40, reps: 12 }]), 40);
  assert.equal(sessionLoadKg([{ weightKg: 40, reps: 12 }, { weightKg: 30, reps: 12 }]), 30);
  assert.equal(sessionLoadKg([{ reps: 12 }]), null); // no weight recorded
  assert.equal(sessionLoadKg([]), null);
});

ok('loadIsConsistent true only when every session shares the same load', () => {
  assert.equal(loadIsConsistent([upperSets, upperSets]), true); // both at 40kg
  assert.equal(loadIsConsistent([upperSets, upperSetsLowLoad]), false); // 40 vs 30
  assert.equal(loadIsConsistent([[{ reps: 12 }], [{ reps: 12 }]]), false); // unknown load
  assert.equal(loadIsConsistent([upperSets]), true); // single session is trivially consistent
});

ok('weight increase suggested when two qualifying sessions are at a consistent load', () => {
  const res = suggestProgression(ohp, [upperSets, upperSets]);
  assert.equal(res.type, SUGGESTION_TYPE.INCREASE_WEIGHT);
  assert.equal(res.deltaKg, DEFAULT_WEIGHT_INCREMENT_KG);
});

ok('reps (not weight) suggested when the two qualifying sessions are at different loads', () => {
  const res = suggestProgression(ohp, [upperSets, upperSetsLowLoad]);
  assert.equal(res.type, SUGGESTION_TYPE.INCREASE_REPS);
  assert.equal(res.loadInconsistent, true);
});

ok('no weight increase when qualifying sessions have no recorded load', () => {
  const noLoad = [{ reps: 12 }, { reps: 12 }, { reps: 12 }, { reps: 12 }];
  const res = suggestProgression(ohp, [noLoad, noLoad]);
  assert.equal(res.type, SUGGESTION_TYPE.INCREASE_REPS);
  assert.equal(res.loadInconsistent, true);
});

console.log('progression.js — evaluatePace');

const easyRun = getRun('easy'); // 375..400 sec/km
ok('pace within band classified as within', () => {
  const res = evaluatePace(390, easyRun);
  assert.equal(res.result, PACE_RESULT.WITHIN);
});

ok('pace faster than band classified as too_fast', () => {
  const res = evaluatePace(360, easyRun);
  assert.equal(res.result, PACE_RESULT.TOO_FAST);
  assert.ok(res.message.includes('이지런'));
});

ok('pace slower than band classified as too_slow', () => {
  const res = evaluatePace(420, easyRun);
  assert.equal(res.result, PACE_RESULT.TOO_SLOW);
});

console.log('progression.js — goalVsActual & rirGuidance');

ok('goalVsActual math is correct for a sample', () => {
  // ohp: repMin 8, repMax 12, sets 4 → target 32..48
  const res = goalVsActual(ohp, [{ reps: 12 }, { reps: 10 }, { reps: 9 }, { reps: 8 }]);
  assert.equal(res.targetMinVolume, 32);
  assert.equal(res.targetMaxVolume, 48);
  assert.equal(res.actualVolume, 39);
  assert.equal(res.status, 'within');
});

ok('goalVsActual flags below-range volume', () => {
  const res = goalVsActual(ohp, [{ reps: 5 }, { reps: 5 }, { reps: 5 }, { reps: 5 }]);
  assert.equal(res.actualVolume, 20);
  assert.equal(res.status, 'below');
});

ok('rirGuidance returns the RIR 1~2 reminder', () => {
  assert.ok(rirGuidance().includes('RIR 1~2'));
});

console.log('charts.js — pure helpers');

ok('scaleLinear maps domain endpoints to range endpoints', () => {
  assert.equal(scaleLinear(0, 0, 10, 0, 100), 0);
  assert.equal(scaleLinear(10, 0, 10, 0, 100), 100);
  assert.equal(scaleLinear(5, 0, 10, 0, 100), 50);
});

ok('scaleLinear returns range midpoint for a degenerate domain', () => {
  assert.equal(scaleLinear(5, 5, 5, 0, 100), 50);
});

ok('niceExtent pads a normal range and never returns zero height', () => {
  const [lo, hi] = niceExtent(10, 20);
  assert.ok(lo < 10 && hi > 20);
  const [flo, fhi] = niceExtent(7, 7);
  assert.ok(fhi > flo);
});

ok('niceExtent includes a forced band min/max', () => {
  const [lo, hi] = niceExtent(300, 320, { includeMin: 310, includeMax: 400 });
  assert.ok(lo <= 300);
  assert.ok(hi >= 400);
});

ok('trendDirection detects up/down/flat vs previous', () => {
  assert.equal(trendDirection([1, 2, 3]), 'up');
  assert.equal(trendDirection([3, 2, 1]), 'down');
  assert.equal(trendDirection([5, 5]), 'flat');
  assert.equal(trendDirection([5]), 'flat');
});

ok('lineChartSvg returns empty-state markup with fewer than 2 points', () => {
  const out = lineChartSvg([{ date: '2024-01-01', value: 10 }]);
  assert.ok(out.includes(EMPTY_STATE_TEXT));
  assert.ok(!out.includes('<svg'));
});

ok('lineChartSvg returns an <svg> with polyline for 2+ points', () => {
  const out = lineChartSvg([
    { date: '2024-01-01', value: 10 },
    { date: '2024-01-08', value: 12 },
  ]);
  assert.ok(out.includes('<svg'));
  assert.ok(out.includes('<polyline'));
});

ok('lineChartSvg draws a shaded band when band opt provided', () => {
  const out = lineChartSvg(
    [
      { date: '2024-01-01', value: 390 },
      { date: '2024-01-08', value: 385 },
    ],
    { band: { min: 375, max: 400 } }
  );
  assert.ok(out.includes('chart-band'));
});

ok('barChartSvg returns an <svg> with bars for 2+ points, empty-state otherwise', () => {
  const empty = barChartSvg([{ date: '2024-01-01', value: 40 }]);
  assert.ok(empty.includes(EMPTY_STATE_TEXT));
  const out = barChartSvg([
    { date: '2024-01-01', value: 40 },
    { date: '2024-01-08', value: 44 },
  ]);
  assert.ok(out.includes('<svg'));
  assert.ok(out.includes('chart-bar'));
});

console.log('app.js — validateExerciseInput (FEAT-005, pure)');

ok('accepts a valid exercise and normalizes fields', () => {
  const res = validateExerciseInput({
    name: '  벤치프레스  ',
    defaultWeightKg: '40',
    repMin: '6',
    repMax: '10',
    sets: '4',
    perLeg: true,
  });
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.value.name, '벤치프레스'); // trimmed
  assert.equal(res.value.defaultWeightKg, 40);
  assert.equal(res.value.repMin, 6);
  assert.equal(res.value.repMax, 10);
  assert.equal(res.value.sets, 4);
  assert.equal(res.value.perLeg, true);
});

ok('rejects an empty name', () => {
  const res = validateExerciseInput({ name: '   ', repMin: '6', repMax: '10', sets: '4' });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('이름')));
});

ok('rejects non-positive / non-integer rep and set values', () => {
  assert.equal(validateExerciseInput({ name: 'x', repMin: '0', repMax: '10', sets: '4' }).valid, false);
  assert.equal(validateExerciseInput({ name: 'x', repMin: '6', repMax: '10', sets: '0' }).valid, false);
  assert.equal(validateExerciseInput({ name: 'x', repMin: '6.5', repMax: '10', sets: '4' }).valid, false);
  assert.equal(validateExerciseInput({ name: 'x', repMin: '-3', repMax: '10', sets: '4' }).valid, false);
});

ok('rejects repMin greater than repMax', () => {
  const res = validateExerciseInput({ name: 'x', repMin: '12', repMax: '8', sets: '4' });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('최대')));
});

ok('defaults defaultWeightKg to 0 when blank and treats perLeg as boolean', () => {
  const res = validateExerciseInput({ name: '플랭크', defaultWeightKg: '', repMin: '30', repMax: '60', sets: '3' });
  assert.equal(res.valid, true);
  assert.equal(res.value.defaultWeightKg, 0);
  assert.equal(res.value.perLeg, false);
});

console.log('storage.js — isValidBackup (FEAT-006, pure)');

// Build a well-formed backup object from the pure default helpers.
function validBackup() {
  return {
    schemaVersion: 2,
    sessions: [],
    routine: getDefaultRoutine(),
    exerciseLibrary: getDefaultExerciseLibrary(),
  };
}

ok('accepts a well-formed backup blob', () => {
  assert.equal(isValidBackup(validBackup()), true);
});

ok('accepts a backup with logged sessions', () => {
  const b = validBackup();
  b.sessions.push({ id: 's1', date: '2024-01-01', splitId: 'chest_back', entriesByExercise: {} });
  assert.equal(isValidBackup(b), true);
});

ok('rejects null / non-object / array input', () => {
  assert.equal(isValidBackup(null), false);
  assert.equal(isValidBackup(undefined), false);
  assert.equal(isValidBackup('{}'), false);
  assert.equal(isValidBackup(42), false);
  assert.equal(isValidBackup([]), false);
});

ok('rejects a blob missing the sessions array', () => {
  const b = validBackup();
  delete b.sessions;
  assert.equal(isValidBackup(b), false);
  b.sessions = {};
  assert.equal(isValidBackup(b), false);
});

ok('rejects a blob whose routine lacks splitCycle or splits', () => {
  const noRoutine = validBackup();
  delete noRoutine.routine;
  assert.equal(isValidBackup(noRoutine), false);

  const noCycle = validBackup();
  delete noCycle.routine.splitCycle;
  assert.equal(isValidBackup(noCycle), false);

  const noSplits = validBackup();
  delete noSplits.routine.splits;
  assert.equal(isValidBackup(noSplits), false);

  const badSplits = validBackup();
  badSplits.routine.splits = [];
  assert.equal(isValidBackup(badSplits), false);
});

ok('rejects a blob missing the exerciseLibrary array', () => {
  const b = validBackup();
  delete b.exerciseLibrary;
  assert.equal(isValidBackup(b), false);
  b.exerciseLibrary = {};
  assert.equal(isValidBackup(b), false);
});

console.log('storage.js — isValidBackup referential integrity (review fix)');

ok('rejects a backup whose splits object is empty', () => {
  const b = validBackup();
  b.routine.splits = {};
  b.routine.splitCycle = [];
  assert.equal(isValidBackup(b), false);
});

ok('rejects a backup whose cycle references only non-existent splits', () => {
  // Structurally valid (splits object non-empty), but the cycle points at ids
  // with no matching split — after import getNextSplitId would return an id
  // that getSplitPersisted cannot resolve, breaking 오늘 훈련.
  const b = validBackup();
  b.routine.splits = { real_split: { id: 'real_split', name: 'x', type: 'strength', exercises: [] } };
  b.routine.splitCycle = ['gone'];
  assert.equal(isValidBackup(b), false);
});

ok('accepts a backup whose cycle references at least one existing split', () => {
  const b = validBackup();
  b.routine.splits = {
    real_split: { id: 'real_split', name: 'x', type: 'strength', exercises: [] },
  };
  b.routine.splitCycle = ['real_split', 'gone'];
  assert.equal(isValidBackup(b), true);
});

ok('accepts a backup with a non-empty splits object and an empty cycle', () => {
  // An empty cycle is tolerated (getNextSplitId → cycle[0] is undefined, but
  // getSplitsPersisted still appends the orphan split so 오늘 훈련 renders it).
  const b = validBackup();
  b.routine.splits = {
    real_split: { id: 'real_split', name: 'x', type: 'strength', exercises: [] },
  };
  b.routine.splitCycle = [];
  assert.equal(isValidBackup(b), true);
});

ok('the referentially-broken example from the review is rejected', () => {
  const broken = {
    sessions: [],
    routine: { splitCycle: ['gone'], splits: {} },
    exerciseLibrary: [],
  };
  assert.equal(isValidBackup(broken), false);
});

console.log('coaching.js — constants');

ok('exports the documented windows/constants', () => {
  assert.equal(QUALIFYING_WINDOW, 3);
  assert.equal(PLATEAU_WINDOW, 3);
  assert.equal(DELOAD_WEIGHT_FACTOR, 0.9);
});

console.log('coaching.js — qualifyingStreak');

// Reuse the weighted OHP fixtures (repMax 12, sets 4, 40kg) defined above.
ok('qualifyingStreak counts consecutive upper-target sessions on a consistent load', () => {
  const res = qualifyingStreak(ohp, [upperSets, upperSets, upperSets]);
  assert.equal(res.streak, 3);
  assert.equal(res.load, 40);
});

ok('qualifyingStreak stops at a non-qualifying session', () => {
  // Most recent (last) is qualifying, but the middle failed -> only trailing run counts.
  const res = qualifyingStreak(ohp, [upperSets, notUpperSets, upperSets]);
  assert.equal(res.streak, 1);
});

ok('qualifyingStreak stops when the load is inconsistent within the run', () => {
  // Three upper-target sessions but the earliest is at a lower load; only the
  // trailing consistent-load run (2) qualifies for a weight bump.
  const res = qualifyingStreak(ohp, [upperSetsLowLoad, upperSets, upperSets]);
  assert.equal(res.streak, 2);
  assert.equal(res.load, 40);
});

ok('qualifyingStreak is 0 for empty input', () => {
  assert.equal(qualifyingStreak(ohp, []).streak, 0);
  assert.equal(qualifyingStreak(ohp, null).streak, 0);
});

ok('qualifyingStreak counts bodyweight sessions with no load gate', () => {
  const bw = getExercise('pullup_bw'); // sets 3, repMax 12, defaultWeightKg 0
  const bwUpper = [{ reps: 12 }, { reps: 12 }, { reps: 12 }];
  const res = qualifyingStreak(bw, [bwUpper, bwUpper, bwUpper]);
  assert.equal(res.streak, 3);
  assert.equal(res.load, null);
});

console.log('coaching.js — proposeTargetChange');

ok('proposeTargetChange returns qualified:false with streak/required below the window', () => {
  const res = proposeTargetChange(ohp, [upperSets, upperSets]);
  assert.equal(res.qualified, false);
  assert.equal(res.streak, 2);
  assert.equal(res.required, 3);
});

ok('proposeTargetChange returns a weight proposal at/above the window (patch +2.5kg)', () => {
  const res = proposeTargetChange(ohp, [upperSets, upperSets, upperSets]);
  assert.equal(res.qualified, true);
  assert.equal(res.kind, 'weight');
  assert.equal(res.patch.defaultWeightKg, 40 + DEFAULT_WEIGHT_INCREMENT_KG); // 42.5
  assert.equal(res.current.defaultWeightKg, 40);
  assert.equal(res.proposed.defaultWeightKg, 42.5);
});

ok('proposeTargetChange returns a reps proposal for a bodyweight exercise', () => {
  const bw = getExercise('pullup_bw'); // repMin 8, repMax 12
  const bwUpper = [{ reps: 12 }, { reps: 12 }, { reps: 12 }];
  const res = proposeTargetChange(bw, [bwUpper, bwUpper, bwUpper]);
  assert.equal(res.qualified, true);
  assert.equal(res.kind, 'reps');
  assert.equal(res.patch.repMin, 9);
  assert.equal(res.patch.repMax, 13);
  assert.equal(res.proposed.repMax, 13);
});

console.log('coaching.js — detectPlateau');

ok('detectPlateau returns plateaued:false below PLATEAU_WINDOW', () => {
  const res = detectPlateau(ohp, [notUpperSets, notUpperSets]);
  assert.equal(res.plateaued, false);
  assert.equal(res.streak, 2);
});

ok('detectPlateau suggests a weight deload at/above the window (weighted)', () => {
  const res = detectPlateau(ohp, [notUpperSets, notUpperSets, notUpperSets]);
  assert.equal(res.plateaued, true);
  assert.equal(res.streak, 3);
  assert.equal(res.suggestion.kind, 'deload_weight');
  // notUpperSets is logged at W (40) == ohp.defaultWeightKg, so the observed
  // plateau load and the routine default coincide: 40 * 0.9 = 36 (0.5kg step).
  assert.equal(res.suggestion.patch.defaultWeightKg, 36);
  assert.equal(res.basisWeightKg, 40);
});

ok('detectPlateau deload is based on the OBSERVED plateau load, not defaultWeightKg', () => {
  // User plateaued grinding at 50kg even though the routine default is 40kg.
  const heavyNotUpper = [
    { weightKg: 50, reps: 12 },
    { weightKg: 50, reps: 11 },
    { weightKg: 50, reps: 12 },
    { weightKg: 50, reps: 12 },
  ];
  const res = detectPlateau(ohp, [heavyNotUpper, heavyNotUpper, heavyNotUpper]);
  assert.equal(res.plateaued, true);
  assert.equal(res.basisWeightKg, 50); // observed, not the 40kg default
  // 50 * 0.9 = 45 (0.5kg step) — anchored to what was actually lifted.
  assert.equal(res.suggestion.patch.defaultWeightKg, 45);
});

ok('detectPlateau falls back to defaultWeightKg when the plateau load drifts', () => {
  // Inconsistent loads across the stagnant sessions -> no single observed load.
  const s1 = [
    { weightKg: 47.5, reps: 12 },
    { weightKg: 47.5, reps: 11 },
    { weightKg: 47.5, reps: 12 },
    { weightKg: 47.5, reps: 12 },
  ];
  const s2 = [
    { weightKg: 50, reps: 12 },
    { weightKg: 50, reps: 11 },
    { weightKg: 50, reps: 12 },
    { weightKg: 50, reps: 12 },
  ];
  const res = detectPlateau(ohp, [s1, s2, s1]);
  assert.equal(res.plateaued, true);
  assert.equal(res.basisWeightKg, 40); // fell back to defaultWeightKg
  assert.equal(res.suggestion.patch.defaultWeightKg, 36);
});

ok('detectPlateau suggests a set deload for a bodyweight exercise', () => {
  const bw = getExercise('pullup_bw'); // sets 3, defaultWeightKg 0
  const bwLow = [{ reps: 8 }, { reps: 8 }, { reps: 8 }];
  const res = detectPlateau(bw, [bwLow, bwLow, bwLow]);
  assert.equal(res.plateaued, true);
  assert.equal(res.suggestion.kind, 'deload_sets');
  assert.equal(res.suggestion.patch.sets, 2);
});

console.log('coaching.js — computeWeeklyReview');

ok('computeWeeklyReview returns hasData:false for empty input', () => {
  const res = computeWeeklyReview([]);
  assert.equal(res.hasData, false);
  assert.equal(res.sessionCount, 0);
  assert.equal(res.volumeChangePct, null);
});

ok('computeWeeklyReview counts sessions in the rolling 7-day window', () => {
  const sessions = [
    { date: '2024-01-01', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }] } },
    { date: '2024-01-05', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }] } },
    { date: '2024-01-07', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }] } },
  ];
  // anchor = 2024-01-07; window = [2024-01-01, 2024-01-07] -> all 3.
  const res = computeWeeklyReview(sessions);
  assert.equal(res.hasData, true);
  assert.equal(res.sessionCount, 3);
});

ok('computeWeeklyReview computes volumeChangePct vs the previous week', () => {
  const sessions = [
    // previous week: [2024-01-01, 2024-01-07], anchor 2024-01-14.
    { date: '2024-01-05', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }, { reps: 10 }] } }, // 20 reps
    // this week: [2024-01-08, 2024-01-14].
    { date: '2024-01-14', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }, { reps: 10 }, { reps: 10 }] } }, // 30 reps
  ];
  const res = computeWeeklyReview(sessions);
  assert.equal(res.totalVolumeThisWeek, 30);
  assert.equal(res.totalVolumePrevWeek, 20);
  assert.equal(res.volumeChangePct, 50); // (30-20)/20*100
});

ok('computeWeeklyReview volumeChangePct is null when there is no previous week', () => {
  const sessions = [
    { date: '2024-02-01', splitId: 'chest_back', entriesByExercise: { a: [{ reps: 10 }] } },
  ];
  const res = computeWeeklyReview(sessions);
  assert.equal(res.volumeChangePct, null);
});

ok('computeWeeklyReview detects a weight PR vs earlier sessions', () => {
  const sessions = [
    // Earlier baseline (before this week's window): max 40kg.
    { date: '2024-01-01', splitId: 'shoulder_legs_abs', entriesByExercise: { ohp_40kg: [{ weightKg: 40, reps: 8 }] }, exerciseNames: { ohp_40kg: '40kg OHP' } },
    // This week (anchor 2024-01-14): new max 42.5kg.
    { date: '2024-01-14', splitId: 'shoulder_legs_abs', entriesByExercise: { ohp_40kg: [{ weightKg: 42.5, reps: 8 }] }, exerciseNames: { ohp_40kg: '40kg OHP' } },
  ];
  const res = computeWeeklyReview(sessions);
  assert.ok(res.prs.length >= 1);
  const pr = res.prs.find((p) => p.exId === 'ohp_40kg');
  assert.ok(pr);
  assert.equal(pr.kind, 'weight');
  assert.equal(pr.value, 42.5);
  assert.equal(pr.name, '40kg OHP');
});

ok('computeWeeklyReview computes a running pace delta (negative = faster)', () => {
  const sessions = [
    { date: '2024-01-05', splitId: 'running', entriesByExercise: null, run: { type: 'easy', distanceKm: 5, paceSecPerKm: 400 } },
    { date: '2024-01-14', splitId: 'running', entriesByExercise: null, run: { type: 'easy', distanceKm: 5, paceSecPerKm: 385 } },
  ];
  const res = computeWeeklyReview(sessions);
  assert.equal(res.runningPace.easyDeltaSec, -15); // faster by 15s/km
});

ok('buildNextWeekHint returns a non-empty Korean hint', () => {
  assert.ok(buildNextWeekHint({ sessionCount: 0 }).length > 0);
  assert.ok(buildNextWeekHint({ sessionCount: 2, prs: [{ exId: 'x' }] }).length > 0);
});

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
