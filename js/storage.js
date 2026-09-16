// storage.js — localStorage persistence layer + routine/library state.
// Persists a single versioned JSON blob that holds logged sessions, the
// editable routine (splits, ordered split cycle, running defs) and an
// exercise library. Seeds the routine + library from data.js defaults on first
// run (or migrates existing v1 data in place, preserving all sessions).

import {
  getDefaultRoutine,
  getDefaultExerciseLibrary,
} from './data.js';
import { nextSplitId } from './progression.js';

export const STORAGE_KEY = 'htracker.v1';
export const SCHEMA_VERSION = 3;

// --- v3 rename/run-variant migration data ------------------------------------
// Rename-by-id table: only applied when the persisted `name` still equals the
// OLD value, so user-customized names are preserved and re-running is a no-op.
const V3_RENAMES = {
  pullup_12kg: { from: '12kg 풀업', to: '중량 풀업' },
  ringdips_12kg: { from: '12kg 링딥스', to: '중량 링딥스' },
  backsquat_40kg: { from: '40kg 백스쿼트', to: '백스쿼트' },
  ohp_40kg: { from: '40kg OHP', to: 'OHP' },
  lunge_40kg: { from: '40kg 런지', to: '런지' },
};

// The two running variants added in v3 (must mirror the data.js seed exactly).
const V3_ADDED_RUNS = {
  lsd: {
    id: 'run_lsd',
    name: 'LSD',
    type: 'lsd',
    distanceMinKm: 10,
    distanceMaxKm: 15,
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
    paceMinSecPerKm: 330,
    paceMaxSecPerKm: 350,
    note: '지속주 (템포)',
  },
};

// Idempotent v3 upgrade of the PERSISTED routine + exercise library.
// (a) Rename-by-id: only when the persisted name still matches the OLD value.
// (b) Add lsd/tempo run variants to the persisted running split when absent.
// Never touches blob.sessions or existing easy/interval runs.
function applyV3Upgrade(blob) {
  // (a) Rename-by-id across routine splits and the exercise library.
  const renameEntry = (entry) => {
    if (!entry || typeof entry.id !== 'string') return;
    const rename = V3_RENAMES[entry.id];
    if (rename && entry.name === rename.from) {
      entry.name = rename.to;
    }
  };
  const routine = blob.routine;
  if (routine && routine.splits && typeof routine.splits === 'object') {
    for (const splitId of Object.keys(routine.splits)) {
      const split = routine.splits[splitId];
      if (split && Array.isArray(split.exercises)) {
        split.exercises.forEach(renameEntry);
      }
    }
  }
  if (Array.isArray(blob.exerciseLibrary)) {
    blob.exerciseLibrary.forEach(renameEntry);
  }

  // (b) Add lsd/tempo to the persisted running split(s) when absent.
  if (routine && routine.splits && typeof routine.splits === 'object') {
    for (const splitId of Object.keys(routine.splits)) {
      const split = routine.splits[splitId];
      if (!split || split.type !== 'running' || !split.runs || typeof split.runs !== 'object') {
        continue;
      }
      for (const runKey of Object.keys(V3_ADDED_RUNS)) {
        if (!split.runs[runKey]) {
          split.runs[runKey] = { ...V3_ADDED_RUNS[runKey] };
        }
      }
    }
  }
}

// --- ID generation (mirrors the session id pattern) -------------------------
function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Blob read/write with in-place migration --------------------------------

// Attach a seeded routine + exercise library to a blob when absent, and set
// schemaVersion to 2. Idempotent: an existing routine/library is left as-is and
// the sessions array is never dropped. Mutates and returns the given blob.
export function migrateBlob(blob) {
  if (!blob || typeof blob !== 'object') {
    blob = { sessions: [] };
  }
  if (!Array.isArray(blob.sessions)) {
    blob.sessions = [];
  }
  if (!blob.routine || typeof blob.routine !== 'object' || !blob.routine.splits) {
    blob.routine = getDefaultRoutine();
  }
  if (!Array.isArray(blob.exerciseLibrary)) {
    blob.exerciseLibrary = getDefaultExerciseLibrary();
  }
  // v3 in-place upgrade of the persisted routine + library (idempotent).
  applyV3Upgrade(blob);
  blob.schemaVersion = SCHEMA_VERSION;
  return blob;
}

// Internal: read the full blob, guarding against parse errors / missing storage.
// Always returns a migrated (v2) shape so callers can rely on routine + library.
function readBlob() {
  let parsed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      parsed = { sessions: [] };
    } else {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
        parsed = { sessions: [] };
      }
    }
  } catch (err) {
    // Corrupt data or unavailable storage → start fresh in memory.
    parsed = { sessions: [] };
  }
  return migrateBlob(parsed);
}

// Internal: write the full blob.
function writeBlob(blob) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    return true;
  } catch (err) {
    return false;
  }
}

// Ensure the persisted blob has been migrated and written back at least once.
// Safe to call on app init so v1 data is upgraded in place.
export function ensureMigrated() {
  const blob = readBlob();
  writeBlob(blob);
  return blob;
}

// Save a logged session.
// session = {
//   date: 'YYYY-MM-DD',
//   splitId: string,
//   // strength: entriesByExercise = { [exerciseId]: [{weightKg, reps}, ...] }
//   entriesByExercise?: object,
//   // running: run = { distanceKm, paceSecPerKm, type: 'easy'|'interval' }
//   run?: object
// }
export function saveSession(session) {
  const blob = readBlob();
  const entriesByExercise = session.entriesByExercise || null;
  const record = {
    id: session.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: session.date || new Date().toISOString().slice(0, 10),
    splitId: session.splitId,
    entriesByExercise,
    // Snapshot the exercise display names at log time so history stays readable
    // even after the exercise is later renamed or deleted from the routine.
    // Prefer a caller-provided map; otherwise resolve names from the live
    // routine for the exercises this session logged.
    exerciseNames: entriesByExercise
      ? buildExerciseNameSnapshot(blob, entriesByExercise, session.exerciseNames)
      : null,
    run: session.run || null,
    createdAt: session.createdAt || new Date().toISOString(),
  };
  blob.sessions.push(record);
  writeBlob(blob);
  return record;
}

// Build a { [exerciseId]: displayName } snapshot for the exercises a session
// logged. Uses a caller-provided map first, then resolves any remaining ids
// against the routine held by the given blob. Ids that cannot be resolved are
// simply omitted (the fallback chain in the UI still degrades to the id).
function buildExerciseNameSnapshot(blob, entriesByExercise, provided) {
  const routine = blob.routine || {};
  const splits = routine.splits || {};
  const names = {};
  for (const exId of Object.keys(entriesByExercise)) {
    if (provided && typeof provided[exId] === 'string' && provided[exId]) {
      names[exId] = provided[exId];
      continue;
    }
    let resolved = null;
    for (const splitId of Object.keys(splits)) {
      const split = splits[splitId];
      if (!split || !Array.isArray(split.exercises)) continue;
      const found = split.exercises.find((ex) => ex.id === exId);
      if (found) {
        resolved = found.name;
        break;
      }
    }
    if (resolved) names[exId] = resolved;
  }
  return names;
}

// Read all sessions (chronological order as stored).
export function getAllSessions() {
  return readBlob().sessions;
}

// Delete a session by id. Returns true if a session was removed.
export function deleteSession(sessionId) {
  const blob = readBlob();
  const before = blob.sessions.length;
  blob.sessions = blob.sessions.filter((s) => s.id !== sessionId);
  if (blob.sessions.length === before) return false;
  writeBlob(blob);
  return true;
}

// Update a session by id with a shallow patch of allowed fields.
// Returns the updated record, or null when not found.
export function updateSession(sessionId, patch) {
  const blob = readBlob();
  const idx = blob.sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return null;
  const current = blob.sessions[idx];
  const updated = { ...current };
  if (patch && typeof patch === 'object') {
    if (typeof patch.date === 'string' && patch.date) updated.date = patch.date;
    if (patch.entriesByExercise && typeof patch.entriesByExercise === 'object') {
      updated.entriesByExercise = patch.entriesByExercise;
      // Refresh the name snapshot for the (possibly changed) exercise set,
      // preserving any names already snapshotted on the existing record.
      updated.exerciseNames = buildExerciseNameSnapshot(
        blob,
        patch.entriesByExercise,
        current.exerciseNames || {}
      );
    }
    if (patch.run && typeof patch.run === 'object') updated.run = patch.run;
  }
  blob.sessions[idx] = updated;
  writeBlob(blob);
  return updated;
}

// Read all set-entry arrays for a given exercise, newest last.
// Returns an array of { date, entries } where entries is [{weightKg, reps}, ...].
export function getSessionsForExercise(exerciseId) {
  return readBlob()
    .sessions.filter(
      (s) => s.entriesByExercise && Array.isArray(s.entriesByExercise[exerciseId])
    )
    .map((s) => ({ date: s.date, entries: s.entriesByExercise[exerciseId] }));
}

// =============================================================================
// Routine (persisted, editable) — accessors
// =============================================================================

// Return the whole persisted routine { splitCycle, splits }.
export function getRoutine() {
  return readBlob().routine;
}

// Return the persisted ordered split cycle (array of split ids).
export function getSplitCyclePersisted() {
  const routine = readBlob().routine;
  return Array.isArray(routine.splitCycle) ? [...routine.splitCycle] : [];
}

// Return the ordered array of persisted split definition objects, ordered by
// the persisted split cycle. Any split ids in the cycle without a definition
// are skipped; any splits not referenced by the cycle are appended after.
export function getSplitsPersisted() {
  const routine = readBlob().routine;
  const splits = routine.splits || {};
  const cycle = Array.isArray(routine.splitCycle) ? routine.splitCycle : [];
  const ordered = [];
  const used = new Set();
  for (const id of cycle) {
    if (splits[id]) {
      ordered.push(splits[id]);
      used.add(id);
    }
  }
  for (const id of Object.keys(splits)) {
    if (!used.has(id)) ordered.push(splits[id]);
  }
  return ordered;
}

// Look up a persisted split definition by id.
export function getSplitPersisted(splitId) {
  const routine = readBlob().routine;
  return (routine.splits && routine.splits[splitId]) || null;
}

// Look up a single strength exercise by id across all persisted strength splits.
export function getExercisePersisted(exerciseId) {
  const routine = readBlob().routine;
  const splits = routine.splits || {};
  const cycle = Array.isArray(routine.splitCycle) ? routine.splitCycle : Object.keys(splits);
  const ids = [...new Set([...cycle, ...Object.keys(splits)])];
  for (const splitId of ids) {
    const split = splits[splitId];
    if (!split || !Array.isArray(split.exercises)) continue;
    const found = split.exercises.find((ex) => ex.id === exerciseId);
    if (found) return found;
  }
  return null;
}

// Return a persisted running definition ('easy' | 'interval').
// When `splitId` is given, the run def is resolved from THAT split (so a
// routine with more than one running split grades against the split actually
// being trained). When it is omitted, or the given split has no matching run
// def, it falls back to scanning splits for the first running split that
// defines `runType` (preserves v1/single-running-split behavior and keeps a
// newly-added empty running split from silently losing its target lines when a
// usable definition exists elsewhere is NOT desired, so the scan is only a
// fallback for the no-splitId case).
export function getRunPersisted(runType, splitId) {
  const routine = readBlob().routine;
  const splits = routine.splits || {};

  // Preferred: resolve from the split in scope.
  if (splitId) {
    const split = splits[splitId];
    if (split && split.type === 'running' && split.runs && split.runs[runType]) {
      return split.runs[runType];
    }
    // A running split was named but has no def for this run type → no target.
    if (split && split.type === 'running') return null;
  }

  // Fallback (no split in scope): first running split defining runType.
  for (const id of Object.keys(splits)) {
    const split = splits[id];
    if (split && split.type === 'running' && split.runs && split.runs[runType]) {
      return split.runs[runType];
    }
  }
  return null;
}

// =============================================================================
// Routine (persisted, editable) — mutations (used by FEAT-005)
// =============================================================================

// Add a new split (generates an id if absent) or replace an existing one by id.
// Appends the id to the split cycle when it is new. Returns the saved split.
export function saveSplit(split) {
  const blob = readBlob();
  const routine = blob.routine;
  if (!routine.splits) routine.splits = {};
  if (!Array.isArray(routine.splitCycle)) routine.splitCycle = [];
  const id = split.id || genId('sp');
  const saved = { ...split, id };
  routine.splits[id] = saved;
  if (!routine.splitCycle.includes(id)) routine.splitCycle.push(id);
  writeBlob(blob);
  return saved;
}

// Shallow-patch an existing split's top-level fields (e.g. name). Returns the
// updated split or null when not found.
export function updateSplit(splitId, patch) {
  const blob = readBlob();
  const routine = blob.routine;
  const split = routine.splits && routine.splits[splitId];
  if (!split) return null;
  const updated = { ...split, ...(patch || {}), id: splitId };
  routine.splits[splitId] = updated;
  writeBlob(blob);
  return updated;
}

// Delete a split by id and remove it from the cycle. Returns true if removed.
export function deleteSplit(splitId) {
  const blob = readBlob();
  const routine = blob.routine;
  if (!routine.splits || !routine.splits[splitId]) return false;
  delete routine.splits[splitId];
  if (Array.isArray(routine.splitCycle)) {
    routine.splitCycle = routine.splitCycle.filter((id) => id !== splitId);
  }
  writeBlob(blob);
  return true;
}

// Add an exercise (generates an id if absent) to a strength split.
// Returns the added exercise or null when the split is missing.
export function addExerciseToSplit(splitId, exercise) {
  const blob = readBlob();
  const routine = blob.routine;
  const split = routine.splits && routine.splits[splitId];
  if (!split) return null;
  if (!Array.isArray(split.exercises)) split.exercises = [];
  const added = { ...exercise, id: exercise.id || genId('ex') };
  split.exercises.push(added);
  writeBlob(blob);
  return added;
}

// Shallow-patch an exercise within a split. Returns the updated exercise or null.
export function updateExercise(splitId, exerciseId, patch) {
  const blob = readBlob();
  const routine = blob.routine;
  const split = routine.splits && routine.splits[splitId];
  if (!split || !Array.isArray(split.exercises)) return null;
  const idx = split.exercises.findIndex((ex) => ex.id === exerciseId);
  if (idx === -1) return null;
  const updated = { ...split.exercises[idx], ...(patch || {}), id: exerciseId };
  split.exercises[idx] = updated;
  writeBlob(blob);
  return updated;
}

// Delete an exercise from a split. Returns true if removed.
export function deleteExercise(splitId, exerciseId) {
  const blob = readBlob();
  const routine = blob.routine;
  const split = routine.splits && routine.splits[splitId];
  if (!split || !Array.isArray(split.exercises)) return false;
  const before = split.exercises.length;
  split.exercises = split.exercises.filter((ex) => ex.id !== exerciseId);
  if (split.exercises.length === before) return false;
  writeBlob(blob);
  return true;
}

// Reorder the split cycle. Keeps only ids that have a split definition; any
// existing splits missing from the given order are appended afterwards.
export function reorderSplitCycle(orderedIds) {
  const blob = readBlob();
  const routine = blob.routine;
  const splits = routine.splits || {};
  const valid = (Array.isArray(orderedIds) ? orderedIds : []).filter((id) => splits[id]);
  const seen = new Set(valid);
  for (const id of Object.keys(splits)) {
    if (!seen.has(id)) valid.push(id);
  }
  routine.splitCycle = valid;
  writeBlob(blob);
  return [...valid];
}

// =============================================================================
// Exercise library
// =============================================================================

// Return the persisted exercise library array.
export function getExerciseLibrary() {
  return readBlob().exerciseLibrary;
}

// Add a library exercise (generates an id if absent). Returns the added entry.
export function addLibraryExercise(exercise) {
  const blob = readBlob();
  if (!Array.isArray(blob.exerciseLibrary)) blob.exerciseLibrary = [];
  const added = { ...exercise, id: exercise.id || genId('lib') };
  blob.exerciseLibrary.push(added);
  writeBlob(blob);
  return added;
}

// Shallow-patch a library exercise by id. Returns the updated entry or null.
export function updateLibraryExercise(id, patch) {
  const blob = readBlob();
  if (!Array.isArray(blob.exerciseLibrary)) return null;
  const idx = blob.exerciseLibrary.findIndex((ex) => ex.id === id);
  if (idx === -1) return null;
  const updated = { ...blob.exerciseLibrary[idx], ...(patch || {}), id };
  blob.exerciseLibrary[idx] = updated;
  writeBlob(blob);
  return updated;
}

// Delete a library exercise by id. Returns true if removed.
export function deleteLibraryExercise(id) {
  const blob = readBlob();
  if (!Array.isArray(blob.exerciseLibrary)) return false;
  const before = blob.exerciseLibrary.length;
  blob.exerciseLibrary = blob.exerciseLibrary.filter((ex) => ex.id !== id);
  if (blob.exerciseLibrary.length === before) return false;
  writeBlob(blob);
  return true;
}

// =============================================================================
// Backup / restore (used by FEAT-006)
// =============================================================================

// Pure validation of a parsed backup object. Returns true only when the object
// has the expected v2 backup shape AND is internally consistent enough to drive
// the 오늘 훈련 view: a sessions array, a routine object that carries a
// splitCycle array and a splits object, an exerciseLibrary array, and —
// crucially — a routine whose cycle/splits resolve to at least one usable
// split. Without the referential check a structurally-valid but self-
// inconsistent blob (cycle ids with no matching splits, or empty splits) would
// pass and, once imported, drive 오늘 훈련 into its error card.
// Kept pure (no localStorage) so it can be unit-tested in node and reused by the
// import UI to reject malformed files BEFORE overwriting existing data.
export function isValidBackup(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.sessions)) return false;
  const routine = obj.routine;
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) return false;
  if (!Array.isArray(routine.splitCycle)) return false;
  if (!routine.splits || typeof routine.splits !== 'object' || Array.isArray(routine.splits)) {
    return false;
  }
  if (!Array.isArray(obj.exerciseLibrary)) return false;

  // Referential integrity: there must be at least one real split definition,
  // and the cycle (when non-empty) must reference at least one existing split,
  // so getNextSplitId → getSplitPersisted resolves to a renderable split.
  const splitIds = Object.keys(routine.splits);
  if (splitIds.length === 0) return false;
  const cycle = routine.splitCycle;
  if (cycle.length > 0 && !cycle.some((id) => routine.splits[id])) return false;
  return true;
}

// Export the full persisted blob as a JSON string for backup.
export function exportData() {
  return JSON.stringify(readBlob(), null, 2);
}

// Import a previously exported backup, REPLACING the persisted blob. Accepts a
// JSON string or an already-parsed object. Validates the shape via
// isValidBackup BEFORE overwriting, so malformed input never corrupts existing
// data. Returns true on success, false on parse/validation/write failure.
export function importData(json) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!isValidBackup(parsed)) return false;
    return writeBlob(migrateBlob(parsed));
  } catch (err) {
    return false;
  }
}

// =============================================================================
// Rotation
// =============================================================================

// Determine the next split in the rotation based on the last logged session,
// using the PERSISTED (potentially edited) split cycle.
// Defaults to the first split of the persisted cycle when there are no sessions.
export function getNextSplitId() {
  const blob = readBlob();
  const cycle = Array.isArray(blob.routine.splitCycle) ? blob.routine.splitCycle : [];
  const sessions = blob.sessions;
  if (sessions.length === 0) return cycle[0];
  const last = sessions[sessions.length - 1];
  return nextSplitId(last.splitId, cycle);
}

// Clear all stored data (utility for reset).
export function clearAll() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (err) {
    return false;
  }
}
