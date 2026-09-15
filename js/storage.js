// storage.js — localStorage persistence layer + split-rotation helper.
// Depends on data.js for the rotation. Uses a single versioned JSON blob.

import { SPLIT_CYCLE } from './data.js';
import { nextSplitId } from './progression.js';

export const STORAGE_KEY = 'htracker.v1';

// Internal: read the full blob, guarding against parse errors / missing storage.
function readBlob() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    return parsed;
  } catch (err) {
    // Corrupt data or unavailable storage → start fresh in memory.
    return { sessions: [] };
  }
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
  const record = {
    id: session.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: session.date || new Date().toISOString().slice(0, 10),
    splitId: session.splitId,
    entriesByExercise: session.entriesByExercise || null,
    run: session.run || null,
    createdAt: session.createdAt || new Date().toISOString(),
  };
  blob.sessions.push(record);
  writeBlob(blob);
  return record;
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

// Determine the next split in the rotation based on the last logged session.
// Defaults to the first split when there are no sessions.
export function getNextSplitId() {
  const sessions = readBlob().sessions;
  if (sessions.length === 0) return SPLIT_CYCLE[0];
  const last = sessions[sessions.length - 1];
  return nextSplitId(last.splitId);
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
