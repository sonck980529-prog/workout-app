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

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0);
